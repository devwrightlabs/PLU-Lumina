//! # Lumina-Core MultiSigVault
//!
//! A Soroban smart contract implementing a 2-of-2 multi-signature vault for
//! the Lumina Sub-Wallet liquidity handshake protocol.
//!
//! ## Vault Lifecycle
//!
//! ```text
//! initialize(owner, agent)
//!        │
//!        ▼
//! token.transfer(owner, vault_address, amount)   ← owner funds the vault
//!        │
//!        ▼
//! propose_release(tx_id, recipient, amount)      ← owner initiates a release
//!        │
//!        ▼
//! sign_release(tx_id)                            ← lumina agent co-signs
//!        │
//!        ▼
//! execute_release(tx_id)                         ← funds transferred, event emitted
//! ```
//!
//! Deposits are made by sending tokens directly to this contract's address via
//! the token contract's `transfer` entrypoint; this vault does not expose a
//! separate `deposit` method.
//!
//! All state-mutating functions require the caller to be the authorised
//! signer for that step.  Neither party alone can move funds.
//!
//! ## Protocol 23 Compliance
//!
//! This contract targets Stellar Protocol 23 (Soroban GA) using
//! `soroban-sdk` v21, with the `alloc` feature for heap allocations and
//! structured events for every state transition.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype,
    token::Client as TokenClient,
    Address, BytesN, Env, Symbol,
    log,
};

// ─── Storage keys ─────────────────────────────────────────────────────────────

/// Top-level storage keys for the contract's persistent ledger state.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The vault owner's Stellar address.
    Owner,
    /// The Lumina Agent's Stellar address (second required signer).
    Agent,
    /// Whether the vault has been initialised.
    Initialised,
    /// Indexed by transaction proposal ID.
    Proposal(BytesN<32>),
}

// ─── Data types ───────────────────────────────────────────────────────────────

/// Status of a multi-sig release proposal.
#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum ProposalStatus {
    /// Created by the owner; awaiting the agent's countersignature.
    Pending,
    /// Both parties have signed; ready for execution.
    Approved,
    /// Funds have been transferred on-chain.
    Executed,
    /// Cancelled by the owner before approval.
    Cancelled,
}

/// A pending release proposal stored on-chain.
#[contracttype]
#[derive(Clone)]
pub struct ReleaseProposal {
    pub tx_id:          BytesN<32>,
    pub recipient:      Address,
    pub amount:         i128,
    pub token:          Address,
    pub owner_signed:   bool,
    pub agent_signed:   bool,
    pub status:         ProposalStatus,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct MultiSigVault;

#[contractimpl]
impl MultiSigVault {
    // ── Initialisation ────────────────────────────────────────────────────────

    /// Initialise the vault with the owner and Lumina Agent addresses.
    ///
    /// Can only be called once.  Both `owner` and `agent` must authorise
    /// the initialisation to prevent front-running attacks.
    pub fn initialize(env: Env, owner: Address, agent: Address) {
        let storage = env.storage().persistent();

        if storage.has(&DataKey::Initialised) {
            panic!("vault already initialised");
        }

        owner.require_auth();
        agent.require_auth();

        storage.set(&DataKey::Owner, &owner);
        storage.set(&DataKey::Agent, &agent);
        storage.set(&DataKey::Initialised, &true);

        env.events().publish(
            (Symbol::new(&env, "vault_init"), owner.clone()),
            (agent.clone(),),
        );

        log!(&env, "MultiSigVault initialised: owner={}, agent={}", owner, agent);
    }

    // ── Proposal management ───────────────────────────────────────────────────

    /// Propose a release of `amount` tokens to `recipient`.
    ///
    /// Only the vault owner may create a proposal.  The owner's signature is
    /// recorded immediately; the agent must then call `sign_release`.
    pub fn propose_release(
        env:       Env,
        tx_id:     BytesN<32>,
        recipient: Address,
        amount:    i128,
        token:     Address,
    ) {
        let owner = Self::require_owner(&env);

        if amount <= 0 {
            panic!("release amount must be positive");
        }

        let key = DataKey::Proposal(tx_id.clone());
        if env.storage().persistent().has(&key) {
            panic!("proposal with this tx_id already exists");
        }

        let proposal = ReleaseProposal {
            tx_id:        tx_id.clone(),
            recipient:    recipient.clone(),
            amount,
            token:        token.clone(),
            owner_signed: true,  // owner creates → implicitly co-signs
            agent_signed: false,
            status:       ProposalStatus::Pending,
        };

        env.storage().persistent().set(&key, &proposal);

        env.events().publish(
            (Symbol::new(&env, "release_proposed"), tx_id.clone()),
            (owner, recipient, amount, token),
        );
    }

    /// The Lumina Agent countersigns an existing pending proposal.
    ///
    /// Once both parties have signed, the proposal transitions to `Approved`.
    pub fn sign_release(env: Env, tx_id: BytesN<32>) {
        let agent = Self::require_agent(&env);
        let key   = DataKey::Proposal(tx_id.clone());

        let mut proposal: ReleaseProposal = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");

        if proposal.status != ProposalStatus::Pending {
            panic!("proposal is not in Pending state");
        }

        proposal.agent_signed = true;
        proposal.status       = ProposalStatus::Approved;

        env.storage().persistent().set(&key, &proposal);

        env.events().publish(
            (Symbol::new(&env, "release_signed"), tx_id.clone()),
            (agent,),
        );
    }

    /// Execute an approved proposal, transferring tokens to the recipient.
    ///
    /// Either the owner or the agent may call `execute_release` once the
    /// proposal is in `Approved` state.
    pub fn execute_release(env: Env, tx_id: BytesN<32>, caller: Address) {
        caller.require_auth();
        Self::require_initialised(&env);

        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Owner)
            .expect("owner not set");
        let agent: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Agent)
            .expect("agent not set");

        if caller != owner && caller != agent {
            panic!("caller is not authorised to execute release");
        }
        let key = DataKey::Proposal(tx_id.clone());
        let mut proposal: ReleaseProposal = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");

        if proposal.status != ProposalStatus::Approved {
            panic!("proposal is not Approved; both signatures required");
        }

        // Atomically transfer tokens from this contract to the recipient.
        let token_client = TokenClient::new(&env, &proposal.token);
        token_client.transfer(
            &env.current_contract_address(),
            &proposal.recipient,
            &proposal.amount,
        );

        proposal.status = ProposalStatus::Executed;
        env.storage().persistent().set(&key, &proposal);

        env.events().publish(
            (Symbol::new(&env, "release_executed"), tx_id.clone()),
            (proposal.recipient.clone(), proposal.amount),
        );

        log!(&env, "Release executed: tx_id={:?}, amount={}", tx_id, proposal.amount);
    }

    /// Cancel a pending proposal.  Only the owner may cancel.
    pub fn cancel_proposal(env: Env, tx_id: BytesN<32>) {
        Self::require_owner(&env);
        let key = DataKey::Proposal(tx_id.clone());

        let mut proposal: ReleaseProposal = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");

        if proposal.status != ProposalStatus::Pending {
            panic!("only Pending proposals can be cancelled");
        }

        proposal.status = ProposalStatus::Cancelled;
        env.storage().persistent().set(&key, &proposal);

        env.events().publish(
            (Symbol::new(&env, "proposal_cancelled"), tx_id),
            (),
        );
    }

    // ── View functions ────────────────────────────────────────────────────────

    /// Return the stored owner address.
    pub fn get_owner(env: Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Owner)
            .expect("vault not initialised")
    }

    /// Return the stored agent address.
    pub fn get_agent(env: Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Agent)
            .expect("vault not initialised")
    }

    /// Retrieve a proposal by its transaction ID.
    pub fn get_proposal(env: Env, tx_id: BytesN<32>) -> ReleaseProposal {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(tx_id))
            .expect("proposal not found")
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fn require_initialised(env: &Env) {
        if !env
            .storage()
            .persistent()
            .get::<DataKey, bool>(&DataKey::Initialised)
            .unwrap_or(false)
        {
            panic!("vault not initialised");
        }
    }

    /// Assert the caller is the owner and return their address.
    fn require_owner(env: &Env) -> Address {
        Self::require_initialised(env);
        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Owner)
            .expect("vault not initialised");
        owner.require_auth();
        owner
    }

    /// Assert the caller is the Lumina Agent and return their address.
    fn require_agent(env: &Env) -> Address {
        Self::require_initialised(env);
        let agent: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Agent)
            .expect("vault not initialised");
        agent.require_auth();
        agent
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate alloc;

    use super::*;
    use soroban_sdk::{
        testutils::{Address as _},
        token::{Client as TokenClient, StellarAssetClient},
        Env,
    };

    // ── Helpers ──────────────────────────────────────────────────────────────

    fn setup() -> (&'static Env, Address, Address, Address, MultiSigVaultClient<'static>) {
        let env: &'static Env = alloc::boxed::Box::leak(alloc::boxed::Box::new(Env::default()));
        let contract_id       = env.register_contract(None, MultiSigVault);
        let client            = MultiSigVaultClient::new(env, &contract_id.clone());

        let owner: Address = Address::generate(env);
        let agent: Address = Address::generate(env);

        env.mock_all_auths();
        client.initialize(&owner, &agent);

        (env, owner, agent, contract_id, client)
    }

    /// Deploy a test Stellar Asset token, mint `amount` to `recipient`, and
    /// return the token's contract address.
    fn setup_token(env: &Env, admin: &Address, recipient: &Address, amount: i128) -> Address {
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let token_admin = StellarAssetClient::new(env, &token_id.address());
        token_admin.mint(recipient, &amount);
        token_id.address()
    }

    fn make_tx_id(env: &Env, seed: u8) -> BytesN<32> {
        let mut bytes = [0u8; 32];
        bytes[0] = seed;
        BytesN::from_array(env, &bytes)
    }

    // ── Initialisation ───────────────────────────────────────────────────────

    #[test]
    fn test_initialize_stores_owner_and_agent() {
        let (_env, owner, agent, _vault_addr, client) = setup();
        assert_eq!(client.get_owner(), owner);
        assert_eq!(client.get_agent(), agent);
    }

    #[test]
    #[should_panic(expected = "vault already initialised")]
    fn test_double_initialize_panics() {
        let (env, owner, agent, _vault_addr, client) = setup();
        env.mock_all_auths();
        client.initialize(&owner, &agent);
    }

    // ── propose_release ───────────────────────────────────────────────────────

    #[test]
    fn test_propose_release_creates_pending_proposal() {
        let (env, owner, _agent, vault_addr, client) = setup();
        env.mock_all_auths();

        let token     = setup_token(&env, &owner, &vault_addr, 1_000);
        let tx_id     = make_tx_id(&env, 1);
        let recipient = Address::generate(&env);

        client.propose_release(&tx_id, &recipient, &500, &token);

        let proposal = client.get_proposal(&tx_id);
        assert_eq!(proposal.status, ProposalStatus::Pending);
        assert!(proposal.owner_signed);
        assert!(!proposal.agent_signed);
        assert_eq!(proposal.amount, 500);
    }

    #[test]
    #[should_panic(expected = "release amount must be positive")]
    fn test_propose_release_zero_amount_panics() {
        let (env, owner, _agent, vault_addr, client) = setup();
        env.mock_all_auths();

        let token     = setup_token(&env, &owner, &vault_addr, 0);
        let tx_id     = make_tx_id(&env, 2);
        let recipient = Address::generate(&env);

        client.propose_release(&tx_id, &recipient, &0, &token);
    }

    #[test]
    #[should_panic(expected = "proposal with this tx_id already exists")]
    fn test_duplicate_tx_id_panics() {
        let (env, owner, _agent, vault_addr, client) = setup();
        env.mock_all_auths();

        let token     = setup_token(&env, &owner, &vault_addr, 1_000);
        let tx_id     = make_tx_id(&env, 3);
        let recipient = Address::generate(&env);

        client.propose_release(&tx_id, &recipient, &100, &token);
        client.propose_release(&tx_id, &recipient, &100, &token);
    }

    // ── sign_release ──────────────────────────────────────────────────────────

    #[test]
    fn test_agent_sign_transitions_to_approved() {
        let (env, owner, _agent, vault_addr, client) = setup();
        env.mock_all_auths();

        let token     = setup_token(&env, &owner, &vault_addr, 1_000);
        let tx_id     = make_tx_id(&env, 4);
        let recipient = Address::generate(&env);

        client.propose_release(&tx_id, &recipient, &200, &token);
        client.sign_release(&tx_id);

        let proposal = client.get_proposal(&tx_id);
        assert_eq!(proposal.status, ProposalStatus::Approved);
        assert!(proposal.owner_signed);
        assert!(proposal.agent_signed);
    }

    #[test]
    #[should_panic(expected = "proposal is not in Pending state")]
    fn test_sign_already_approved_panics() {
        let (env, owner, _agent, vault_addr, client) = setup();
        env.mock_all_auths();

        let token     = setup_token(&env, &owner, &vault_addr, 1_000);
        let tx_id     = make_tx_id(&env, 5);
        let recipient = Address::generate(&env);

        client.propose_release(&tx_id, &recipient, &200, &token);
        client.sign_release(&tx_id);
        client.sign_release(&tx_id); // second sign should panic
    }

    // ── execute_release ───────────────────────────────────────────────────────

    #[test]
    fn test_execute_release_transfers_tokens() {
        let (env, owner, _agent, vault_addr, client) = setup();
        env.mock_all_auths();

        let token     = setup_token(&env, &owner, &vault_addr, 1_000);
        let recipient = Address::generate(&env);
        let tx_id     = make_tx_id(&env, 6);

        client.propose_release(&tx_id, &recipient, &300, &token);
        client.sign_release(&tx_id);
        client.execute_release(&tx_id, &owner);

        let proposal = client.get_proposal(&tx_id);
        assert_eq!(proposal.status, ProposalStatus::Executed);

        let tok = TokenClient::new(&env, &token);
        assert_eq!(tok.balance(&recipient), 300);
    }

    #[test]
    #[should_panic(expected = "proposal is not Approved")]
    fn test_execute_unapproved_panics() {
        let (env, owner, _agent, vault_addr, client) = setup();
        env.mock_all_auths();

        let token     = setup_token(&env, &owner, &vault_addr, 1_000);
        let tx_id     = make_tx_id(&env, 7);
        let recipient = Address::generate(&env);

        // Proposed but NOT signed by agent → still Pending
        client.propose_release(&tx_id, &recipient, &100, &token);
        client.execute_release(&tx_id, &owner);
    }

    // ── cancel_proposal ───────────────────────────────────────────────────────

    #[test]
    fn test_cancel_pending_proposal() {
        let (env, owner, _agent, vault_addr, client) = setup();
        env.mock_all_auths();

        let token     = setup_token(&env, &owner, &vault_addr, 1_000);
        let tx_id     = make_tx_id(&env, 8);
        let recipient = Address::generate(&env);

        client.propose_release(&tx_id, &recipient, &50, &token);
        client.cancel_proposal(&tx_id);

        let proposal = client.get_proposal(&tx_id);
        assert_eq!(proposal.status, ProposalStatus::Cancelled);
    }

    #[test]
    #[should_panic(expected = "only Pending proposals can be cancelled")]
    fn test_cancel_approved_panics() {
        let (env, owner, _agent, vault_addr, client) = setup();
        env.mock_all_auths();

        let token     = setup_token(&env, &owner, &vault_addr, 1_000);
        let tx_id     = make_tx_id(&env, 9);
        let recipient = Address::generate(&env);

        client.propose_release(&tx_id, &recipient, &50, &token);
        client.sign_release(&tx_id); // now Approved
        client.cancel_proposal(&tx_id); // should panic
    }
}
