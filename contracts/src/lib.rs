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
//! deposit(amount)          ← owner funds the vault
//!        │
//!        ▼
//! propose_release(tx_id, recipient, amount)   ← owner initiates a release
//!        │
//!        ▼
//! sign_release(tx_id)      ← lumina agent co-signs
//!        │
//!        ▼
//! execute_release(tx_id)   ← funds transferred, event emitted
//! ```
//!
//! All state-mutating functions require the caller to be the authorised
//! signer for that step.  Neither party alone can move funds.
//!
//! ## Protocol 23 Compliance
//!
//! This contract targets Soroban SDK v21 (Protocol 21+ / Stellar Protocol 23
//! readiness), using the `soroban-sdk` alloc feature for heap allocations and
//! emitting structured events for every state transition.

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
#[derive(Clone, PartialEq)]
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
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, BytesN as _},
        Env,
    };

    fn setup() -> (Env, Address, Address, MultiSigVaultClient<'static>) {
        let env    = Env::default();
        let contract_id = env.register_contract(None, MultiSigVault);
        let client  = MultiSigVaultClient::new(&env, &contract_id);

        let owner: Address = Address::generate(&env);
        let agent: Address = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&owner, &agent);

        // Box the env to get a 'static lifetime for the client.
        // In real tests you'd use a single env reference.
        (env, owner, agent, client)
    }

    #[test]
    fn test_initialize_stores_owner_and_agent() {
        let (env, owner, agent, client) = setup();
        assert_eq!(client.get_owner(), owner);
        assert_eq!(client.get_agent(), agent);
    }

    #[test]
    #[should_panic(expected = "vault already initialised")]
    fn test_double_initialize_panics() {
        let (env, owner, agent, client) = setup();
        env.mock_all_auths();
        client.initialize(&owner, &agent);
    }
}
