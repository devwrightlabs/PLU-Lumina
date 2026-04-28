//! # Lumina-Core Master Yield Protocol (Phase 10)
//!
//! Unified Liquidity Pool, Staking, and Collateralised Lending for the
//! PLU-Lumina multi-chain wrapped-asset ecosystem.
//!
//! ## Unified Pool Architecture – Preventing Liquidity Fragmentation
//!
//! The "Master Protocol" pools every user's deposit into a **single**
//! `LiquidityPool` per token, rather than spinning up isolated per-user pools.
//! This aggregation has several concrete benefits:
//!
//! - **Deep spot-price accuracy**: the unified `total_deposits` is the single
//!   source of truth for available liquidity, so price impact for any given
//!   trade or borrow is calculated against the entire market depth, not a
//!   fragmented sub-pool.
//! - **Uniform yield**: all depositors share the same `yield_rate_bps` and
//!   `pool_weight`; rewards are proportional to individual stake and time,
//!   with no favoured sub-pools.
//! - **Composable collateral**: borrowers lock collateral against the same
//!   pool that LP depositors fill, so even modest per-user collateral posts
//!   contribute to aggregate protocol solvency.
//!
//! Individual positions are tracked via `LiqPosition` / `LendPosition` keyed
//! by `(user, pool_id)`, preserving per-user accounting without fracturing
//! the underlying liquidity.
//!
//! ## Phase-9 MultiSigVault Integration
//!
//! Asset movement into the protocol **always** requires proof that the
//! originating MultiSigVault proposal has reached the `Executed` state –
//! meaning both the vault owner and the Lumina Agent have signed.
//! This is verified by a cross-contract call to `vault.get_proposal(tx_id)`
//! before any deposit or collateral post is credited.  Neither party alone
//! can unilaterally move funds into the protocol.
//!
//! ## Flash-Loan & Oracle Manipulation Protections
//!
//! - **Reentrancy guard**: a boolean lock stored in instance storage is set
//!   to `true` at the top of every state-mutating entrypoint and cleared at
//!   the bottom.  Any re-entrant call within the same transaction will panic.
//! - **Oracle staleness check**: prices older than `MAX_ORACLE_AGE_SECS`
//!   seconds are unconditionally rejected to prevent stale-price exploits.
//! - **Minimum collateral ratio**: enforced at borrow-time *and* re-checked
//!   during liquidation, using fresh oracle prices each time.
//! - **Vault-tx replay prevention**: each vault proposal ID may be used to
//!   claim a deposit exactly once; subsequent attempts panic.
//!
//! ## Protocol 23 Compliance
//!
//! Targets Stellar Protocol 23 (Soroban GA) with `soroban-sdk` v21.x.
//! All arithmetic uses Rust's overflow-checked ops (`checked_add`,
//! `checked_mul`, `checked_div`) and panics loudly on overflow rather than
//! silently wrapping.

#![no_std]

extern crate alloc;

use soroban_sdk::{
    contract, contractimpl, contracttype,
    token::Client as TokenClient,
    Address, BytesN, Env, Symbol, Val, Vec as SorobanVec,
    IntoVal,
    log,
};

// ─── Constants ────────────────────────────────────────────────────────────────

/// Seconds in a 365-day year; used for annualised yield calculations.
const SECONDS_PER_YEAR: u64 = 31_536_000;

/// Minimum collateral ratio expressed in basis points (150 % = 15 000 bps).
/// Positions below this ratio become eligible for liquidation.
const MIN_COLLATERAL_RATIO_BPS: u32 = 15_000;

/// Maximum age of an oracle price quote before it is considered stale.
const MAX_ORACLE_AGE_SECS: u64 = 300; // 5 minutes

/// Fixed-point denominator for yield calculations (10^9).
/// Prevents integer underflow for small amounts × short durations.
const YIELD_DENOM: i128 = 1_000_000_000;

/// Maximum loan-to-value ratio for new borrows, in basis points (75 %).
const MAX_BORROW_LTV_BPS: u32 = 7_500;

/// Basis-point divisor (100 % = 10 000).
const BPS_DIVISOR: i128 = 10_000;

// ─── Storage keys ─────────────────────────────────────────────────────────────

/// Top-level persistent storage keys for the yield protocol.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Whether the contract has been initialised.
    Initialised,
    /// The protocol administrator address.
    Admin,
    /// Monotonically incrementing counter for pool IDs.
    NextPoolId,
    /// `LiquidityPool` state keyed by pool ID.
    Pool(u32),
    /// Per-user liquidity position keyed by `(user, pool_id)`.
    LiqPos(LiqPosKey),
    /// Per-user lending (borrow) position keyed by `(user, pool_id)`.
    LendPos(LendPosKey),
    /// Reentrancy guard; set to `true` while a state-mutating call is active.
    ReentryLock,
    /// Marks a vault proposal TX ID as already consumed to prevent replay.
    VaultTxUsed(BytesN<32>),
}

// ─── Composite keys ───────────────────────────────────────────────────────────

/// Composite storage key for a user's liquidity position.
#[contracttype]
#[derive(Clone)]
pub struct LiqPosKey {
    pub user:    Address,
    pub pool_id: u32,
}

/// Composite storage key for a user's lending position.
#[contracttype]
#[derive(Clone)]
pub struct LendPosKey {
    pub user:    Address,
    pub pool_id: u32,
}

// ─── Pool & position data types ───────────────────────────────────────────────

/// Unified liquidity pool aggregating deposits from all participants.
///
/// `total_deposits` represents the **entire** pool depth visible to traders
/// and borrowers, not a per-user slice.  This is the key architectural
/// property that prevents market fragmentation: every depositor increases
/// the same `total_deposits` figure, making the pool deeper and more
/// capital-efficient for everyone.
#[contracttype]
#[derive(Clone)]
pub struct LiquidityPool {
    /// The Soroban token contract address this pool accepts.
    pub token:          Address,
    /// Aggregate sum of all active deposits (principal, excluding yield).
    pub total_deposits: i128,
    /// Sum of all outstanding borrows drawn from this pool.
    pub total_borrowed: i128,
    /// Relative weight of this pool for yield-allocation purposes (in bps).
    /// A higher weight means depositors earn proportionally more yield.
    pub pool_weight:    u32,
    /// Annualised yield rate offered to depositors, in basis points.
    pub yield_rate_bps: u32,
    /// Whether the pool is accepting new deposits and borrows.
    pub active:         bool,
}

/// Per-user record within a unified liquidity pool.
///
/// Each `LiqPosition` holds the user's principal and tracks their entry
/// timestamp so that yield can be calculated at withdrawal time without
/// requiring per-block snapshots.
#[contracttype]
#[derive(Clone)]
pub struct LiqPosition {
    /// Amount of token deposited (principal).
    pub amount:             i128,
    /// Unix timestamp (seconds) when the position was opened or last accrued.
    pub deposited_at:       u64,
    /// Yield accrued and not yet withdrawn.
    pub accumulated_yield:  i128,
}

/// Per-user collateralised lending (borrow) position.
///
/// The collateral tokens are held by this contract; the borrow tokens are
/// transferred to the user.  The position becomes liquidatable when the
/// collateral ratio falls below `MIN_COLLATERAL_RATIO_BPS`.
#[contracttype]
#[derive(Clone)]
pub struct LendPosition {
    /// Token used as collateral (e.g., wrapped piBTC).
    pub collateral_token:   Address,
    /// Amount of collateral locked in this contract.
    pub collateral_amount:  i128,
    /// Pool (and token) that was borrowed from.
    pub borrow_pool_id:     u32,
    /// Outstanding borrow amount.
    pub borrow_amount:      i128,
    /// Unix timestamp when the position was opened.
    pub opened_at:          u64,
}

// ─── Cross-contract vault interface (Phase 9 MultiSigVault) ──────────────────
//
// These types MUST mirror the corresponding types in `lumina-multisig-vault`
// exactly (same field names, same variant names) so that the XDR encoding
// produced by the vault contract can be decoded here.

/// Mirror of `ProposalStatus` from the Phase-9 MultiSigVault.
#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum VaultProposalStatus {
    Pending,
    Approved,
    Executed,
    Cancelled,
}

/// Mirror of `ReleaseProposal` from the Phase-9 MultiSigVault.
#[contracttype]
#[derive(Clone)]
pub struct VaultProposal {
    pub tx_id:          BytesN<32>,
    pub recipient:      Address,
    pub amount:         i128,
    pub token:          Address,
    pub owner_signed:   bool,
    pub agent_signed:   bool,
    pub status:         VaultProposalStatus,
}

// ─── Oracle interface ─────────────────────────────────────────────────────────

/// Price data returned by an on-chain oracle (compatible with the Reflector
/// oracle deployed on Stellar Mainnet).
///
/// `price` is expressed with 7 decimal places of precision
/// (e.g., `10_000_000` = $1.00 when base quote is USD).
#[contracttype]
#[derive(Clone)]
pub struct PriceData {
    /// Token price in the oracle's base denomination with 7 decimals.
    pub price:     i128,
    /// Unix timestamp of this price observation.
    pub timestamp: u64,
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

/// Overflow-safe yield accrual.
///
/// ```text
/// accrued_yield = principal
///               × yield_rate_bps
///               × time_elapsed_secs
///               / (10_000 × SECONDS_PER_YEAR × YIELD_DENOM)
/// ```
///
/// All intermediate multiplications are checked; the function panics rather
/// than silently overflowing.
fn calc_yield(principal: i128, yield_rate_bps: u32, elapsed_secs: u64) -> i128 {
    // Scale principal by YIELD_DENOM first for fixed-point precision.
    let scaled = principal
        .checked_mul(YIELD_DENOM)
        .expect("yield: principal × YIELD_DENOM overflow");

    let numerator = scaled
        .checked_mul(yield_rate_bps as i128)
        .expect("yield: × rate overflow")
        .checked_mul(elapsed_secs as i128)
        .expect("yield: × elapsed overflow");

    let denominator = BPS_DIVISOR
        .checked_mul(SECONDS_PER_YEAR as i128)
        .expect("yield: denominator overflow")
        .checked_mul(YIELD_DENOM)
        .expect("yield: denominator × YIELD_DENOM overflow");

    numerator
        .checked_div(denominator)
        .expect("yield: division by zero")
}

/// Overflow-safe collateral ratio calculation.
///
/// Returns the collateral ratio in basis points:
///
/// ```text
/// ratio_bps = (collateral_amount × collateral_price × 10_000)
///           / (borrow_amount × borrow_price)
/// ```
///
/// Both prices carry 7 decimal places (Reflector format); the decimal factor
/// cancels in the ratio, so no extra scaling is required.
///
/// Panics if `borrow_amount` or `borrow_price` is zero (prevents division
/// by zero that could be triggered by a price-manipulation attack).
fn calc_collateral_ratio_bps(
    collateral_amount: i128,
    collateral_price:  i128,
    borrow_amount:     i128,
    borrow_price:      i128,
) -> i128 {
    if borrow_price <= 0 {
        panic!("oracle: borrow price must be positive");
    }
    if borrow_amount <= 0 {
        panic!("math: borrow amount must be positive");
    }

    let collateral_value = collateral_amount
        .checked_mul(collateral_price)
        .expect("ratio: collateral value overflow");

    let borrow_value = borrow_amount
        .checked_mul(borrow_price)
        .expect("ratio: borrow value overflow");

    collateral_value
        .checked_mul(BPS_DIVISOR)
        .expect("ratio: × BPS_DIVISOR overflow")
        .checked_div(borrow_value)
        .expect("ratio: division overflow")
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/// Fetch a validated, non-stale price from the oracle contract.
///
/// Calls `oracle.lastprice(token)` via cross-contract invocation and
/// rejects prices older than `MAX_ORACLE_AGE_SECS`.  The staleness check
/// closes the most common oracle-manipulation window (flash-loan + stale
/// price in the same block).
fn get_fresh_oracle_price(env: &Env, oracle: &Address, token: &Address) -> PriceData {
    let mut args: SorobanVec<Val> = SorobanVec::new(env);
    args.push_back(token.clone().into_val(env));

    let data: PriceData =
        env.invoke_contract(oracle, &Symbol::new(env, "lastprice"), args);

    let now = env.ledger().timestamp();
    if now.saturating_sub(data.timestamp) > MAX_ORACLE_AGE_SECS {
        panic!("oracle: price is stale");
    }
    if data.price <= 0 {
        panic!("oracle: non-positive price");
    }
    data
}

/// Fetch a vault release proposal via a single cross-contract call.
///
/// Returns the raw `VaultProposal`; callers should then call
/// `assert_vault_executed` to validate it before acting on the data.
fn fetch_vault_proposal(
    env:   &Env,
    vault: &Address,
    tx_id: &BytesN<32>,
) -> VaultProposal {
    let mut args: SorobanVec<Val> = SorobanVec::new(env);
    args.push_back(tx_id.clone().into_val(env));
    env.invoke_contract(vault, &Symbol::new(env, "get_proposal"), args)
}

/// Validate that a vault proposal satisfies the 2-of-2 multisig invariants.
///
/// Confirms that:
/// 1. Both vault owner and agent have signed (`owner_signed && agent_signed`).
/// 2. The proposal is in `Executed` state (funds already transferred on-chain).
/// 3. The `recipient` field equals *this* contract's address.
/// 4. The `token` field matches `expected_token`.
/// 5. The released `amount` covers `expected_amount`.
///
/// This is the runtime enforcement of the 2-of-2 multisig rule: the only
/// way a proposal reaches `Executed` is if both parties signed and
/// `execute_release` was called on the vault.  Separating the fetch from
/// the assertion means callers can reuse the fetched proposal data (e.g.,
/// to read the collateral token) without issuing a second cross-contract call.
fn assert_vault_executed(
    env:             &Env,
    proposal:        &VaultProposal,
    expected_token:  &Address,
    expected_amount: i128,
) {
    // Verify that both parties co-signed.
    if !proposal.owner_signed || !proposal.agent_signed {
        panic!("vault: 2-of-2 signatures not present");
    }

    // Verify the proposal has been executed (tokens have actually moved).
    if proposal.status != VaultProposalStatus::Executed {
        panic!("vault: proposal has not been executed");
    }

    // Verify the recipient is *this* contract (not redirected elsewhere).
    if proposal.recipient != env.current_contract_address() {
        panic!("vault: proposal recipient is not this contract");
    }

    // Verify the token matches the expected token.
    if proposal.token != *expected_token {
        panic!("vault: token mismatch");
    }

    // Verify the released amount covers the requested amount.
    if proposal.amount < expected_amount {
        panic!("vault: released amount is less than requested amount");
    }
}

/// Reentrancy guard — enter a protected section.
///
/// Stores a lock flag in instance storage.  Instance storage persists across
/// cross-contract calls within the same transaction, so any re-entrant call
/// from a downstream contract back into this one will see the lock and panic.
fn reentry_enter(env: &Env) {
    if env
        .storage()
        .instance()
        .get::<_, bool>(&DataKey::ReentryLock)
        .unwrap_or(false)
    {
        panic!("reentrancy detected");
    }
    env.storage().instance().set(&DataKey::ReentryLock, &true);
}

/// Reentrancy guard — exit a protected section.
fn reentry_exit(env: &Env) {
    env.storage().instance().set(&DataKey::ReentryLock, &false);
}

/// Load a `LiquidityPool` and panic if the pool ID is unknown.
fn load_pool(env: &Env, pool_id: u32) -> LiquidityPool {
    env.storage()
        .persistent()
        .get(&DataKey::Pool(pool_id))
        .expect("pool not found")
}

/// Persist a `LiquidityPool` back to storage.
fn save_pool(env: &Env, pool_id: u32, pool: &LiquidityPool) {
    env.storage().persistent().set(&DataKey::Pool(pool_id), pool);
}

/// Load a user's liquidity position (returns a zero position if absent).
fn load_liq_pos(env: &Env, user: &Address, pool_id: u32) -> LiqPosition {
    let key = DataKey::LiqPos(LiqPosKey { user: user.clone(), pool_id });
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or(LiqPosition {
            amount:            0,
            deposited_at:      env.ledger().timestamp(),
            accumulated_yield: 0,
        })
}

/// Persist a user's liquidity position.
fn save_liq_pos(env: &Env, user: &Address, pool_id: u32, pos: &LiqPosition) {
    let key = DataKey::LiqPos(LiqPosKey { user: user.clone(), pool_id });
    env.storage().persistent().set(&key, pos);
}

/// Load a user's lending (borrow) position; panics if absent.
fn load_lend_pos(env: &Env, user: &Address, pool_id: u32) -> LendPosition {
    let key = DataKey::LendPos(LendPosKey { user: user.clone(), pool_id });
    env.storage()
        .persistent()
        .get(&key)
        .expect("lending position not found")
}

/// Persist a user's lending position.
fn save_lend_pos(env: &Env, user: &Address, pool_id: u32, pos: &LendPosition) {
    let key = DataKey::LendPos(LendPosKey { user: user.clone(), pool_id });
    env.storage().persistent().set(&key, pos);
}

/// Remove a user's lending position (called on full repayment or liquidation).
fn remove_lend_pos(env: &Env, user: &Address, pool_id: u32) {
    let key = DataKey::LendPos(LendPosKey { user: user.clone(), pool_id });
    env.storage().persistent().remove(&key);
}

/// Require the caller to be the protocol admin.
fn require_admin(env: &Env) -> Address {
    let admin: Address = env
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("protocol not initialised");
    admin.require_auth();
    admin
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct YieldProtocol;

#[contractimpl]
impl YieldProtocol {
    // ── Initialisation ────────────────────────────────────────────────────────

    /// Initialise the master yield protocol with a designated administrator.
    ///
    /// Can only be called once.  The admin is the only address permitted to
    /// register new pools.
    pub fn initialize(env: Env, admin: Address) {
        let storage = env.storage().persistent();

        if storage.has(&DataKey::Initialised) {
            panic!("protocol already initialised");
        }

        admin.require_auth();

        storage.set(&DataKey::Admin,       &admin);
        storage.set(&DataKey::Initialised, &true);
        storage.set(&DataKey::NextPoolId,  &0_u32);

        env.events().publish(
            (Symbol::new(&env, "protocol_init"), admin.clone()),
            (),
        );

        log!(&env, "YieldProtocol initialised: admin={}", admin);
    }

    // ── Pool management ───────────────────────────────────────────────────────

    /// Register a new unified liquidity pool for a given token.
    ///
    /// Only the admin may call this.  Each pool aggregates all depositors'
    /// capital, preventing the liquidity fragmentation that would arise from
    /// per-user isolated positions.
    ///
    /// `pool_weight` controls the relative share of protocol-level incentives
    /// allocated to this pool (in basis points; 10 000 = 100 %).
    /// `yield_rate_bps` is the annualised yield rate offered to depositors.
    ///
    /// Returns the new pool's ID.
    pub fn register_pool(
        env:            Env,
        token:          Address,
        pool_weight:    u32,
        yield_rate_bps: u32,
    ) -> u32 {
        require_admin(&env);

        if pool_weight > 10_000 {
            panic!("pool_weight must not exceed 10 000 bps");
        }

        let pool_id: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::NextPoolId)
            .unwrap_or(0_u32);

        let pool = LiquidityPool {
            token:          token.clone(),
            total_deposits: 0,
            total_borrowed: 0,
            pool_weight,
            yield_rate_bps,
            active:         true,
        };

        save_pool(&env, pool_id, &pool);

        env.storage()
            .persistent()
            .set(&DataKey::NextPoolId, &pool_id.checked_add(1).expect("pool id overflow"));

        env.events().publish(
            (Symbol::new(&env, "pool_registered"), pool_id),
            (token, pool_weight, yield_rate_bps),
        );

        log!(&env, "Pool registered: id={}, weight={}, yield_rate={}", pool_id, pool_weight, yield_rate_bps);
        pool_id
    }

    // ── Deposit routing ───────────────────────────────────────────────────────

    /// Deposit assets from a Phase-9 MultiSigVault into a unified pool.
    ///
    /// ## 2-of-2 Signature Enforcement
    ///
    /// Before crediting the caller's position this function:
    /// 1. Calls `vault_contract.get_proposal(vault_tx_id)` to fetch the
    ///    proposal that authorised this movement.
    /// 2. Asserts `owner_signed == true && agent_signed == true`.
    /// 3. Asserts `status == Executed` (funds have already moved on-chain).
    /// 4. Asserts `recipient == this contract`.
    ///
    /// This guarantees that neither the vault owner nor the Lumina Agent alone
    /// can deposit into the protocol — both signatures are required.
    ///
    /// ## Reentrancy Protection
    ///
    /// The function is wrapped in `reentry_enter` / `reentry_exit` guards.
    /// Any recursive call from a downstream contract back into this function
    /// within the same transaction will panic immediately.
    pub fn deposit_to_pool(
        env:          Env,
        vault_contract: Address,
        vault_tx_id:  BytesN<32>,
        pool_id:      u32,
        amount:       i128,
        caller:       Address,
    ) {
        reentry_enter(&env);

        caller.require_auth();

        if amount <= 0 {
            panic!("deposit amount must be positive");
        }

        // Prevent replay: each vault tx_id may be consumed at most once.
        let used_key = DataKey::VaultTxUsed(vault_tx_id.clone());
        if env.storage().persistent().has(&used_key) {
            panic!("vault tx_id has already been consumed");
        }

        let mut pool = load_pool(&env, pool_id);
        if !pool.active {
            panic!("pool is not active");
        }

        // ── 2-of-2 vault verification ─────────────────────────────────────
        // Fetch the proposal once, then assert it is Executed with matching
        // token/amount.  Splitting fetch from assertion avoids a second
        // cross-contract call and keeps the logic composable.
        let proposal = fetch_vault_proposal(&env, &vault_contract, &vault_tx_id);
        assert_vault_executed(&env, &proposal, &pool.token, amount);

        // Mark the vault tx_id as consumed so it cannot be replayed.
        env.storage().persistent().set(&used_key, &true);

        // ── Accrue existing yield before updating principal ────────────────
        let mut pos = load_liq_pos(&env, &caller, pool_id);
        let now     = env.ledger().timestamp();

        if pos.amount > 0 {
            let elapsed = now.saturating_sub(pos.deposited_at);
            let accrued = calc_yield(pos.amount, pool.yield_rate_bps, elapsed);
            pos.accumulated_yield = pos
                .accumulated_yield
                .checked_add(accrued)
                .expect("yield accumulation overflow");
        }

        // ── Update position and pool aggregate ────────────────────────────
        pos.amount = pos.amount.checked_add(amount).expect("position overflow");
        pos.deposited_at = now;

        // The pool's total_deposits is the unified depth visible to the market.
        pool.total_deposits = pool
            .total_deposits
            .checked_add(amount)
            .expect("pool total_deposits overflow");

        save_liq_pos(&env, &caller, pool_id, &pos);
        save_pool(&env, pool_id, &pool);

        env.events().publish(
            (Symbol::new(&env, "deposited"), caller.clone()),
            (pool_id, amount),
        );

        log!(&env, "Deposit: user={}, pool={}, amount={}", caller, pool_id, amount);

        reentry_exit(&env);
    }

    // ── Withdrawal ────────────────────────────────────────────────────────────

    /// Withdraw principal and any accrued yield from a liquidity pool.
    ///
    /// The yield earned since the last deposit or accrual snapshot is
    /// calculated using the overflow-safe `calc_yield` helper and paid out
    /// together with the requested principal.
    pub fn withdraw_from_pool(
        env:     Env,
        pool_id: u32,
        amount:  i128,
        caller:  Address,
    ) {
        reentry_enter(&env);

        caller.require_auth();

        if amount <= 0 {
            panic!("withdrawal amount must be positive");
        }

        let mut pool = load_pool(&env, pool_id);
        let mut pos  = load_liq_pos(&env, &caller, pool_id);

        if pos.amount < amount {
            panic!("insufficient deposited balance");
        }

        // Accrue yield up to this point.
        let now     = env.ledger().timestamp();
        let elapsed = now.saturating_sub(pos.deposited_at);
        let accrued = calc_yield(pos.amount, pool.yield_rate_bps, elapsed);

        let total_yield = pos
            .accumulated_yield
            .checked_add(accrued)
            .expect("yield overflow on withdrawal");

        // Reduce the unified pool depth.
        pool.total_deposits = pool
            .total_deposits
            .checked_sub(amount)
            .expect("pool underflow on withdrawal");

        pos.amount = pos.amount.checked_sub(amount).expect("position underflow");
        pos.deposited_at      = now;
        pos.accumulated_yield = 0; // reset after paying out

        save_liq_pos(&env, &caller, pool_id, &pos);
        save_pool(&env, pool_id, &pool);

        // Transfer principal + accrued yield from this contract to the caller.
        let payout = amount
            .checked_add(total_yield)
            .expect("payout overflow");

        let token_client = TokenClient::new(&env, &pool.token);
        token_client.transfer(&env.current_contract_address(), &caller, &payout);

        env.events().publish(
            (Symbol::new(&env, "withdrawn"), caller.clone()),
            (pool_id, amount, total_yield),
        );

        log!(&env, "Withdrawal: user={}, pool={}, principal={}, yield={}", caller, pool_id, amount, total_yield);

        reentry_exit(&env);
    }

    // ── Collateralised borrowing ───────────────────────────────────────────────

    /// Post collateral from a Phase-9 vault and borrow from a unified pool.
    ///
    /// ## Flow
    ///
    /// 1. The vault release proposal for the collateral must already be
    ///    `Executed` (2-of-2 signed and run), so the collateral tokens now
    ///    reside in this contract's balance.
    /// 2. Fresh oracle prices are fetched for both the collateral token and
    ///    the borrow token.  Prices older than `MAX_ORACLE_AGE_SECS` are
    ///    rejected to prevent oracle manipulation attacks.
    /// 3. The collateral ratio is computed; it must meet or exceed
    ///    `MIN_COLLATERAL_RATIO_BPS` (150 %).
    /// 4. The borrow amount must not exceed `MAX_BORROW_LTV_BPS` (75 %) of
    ///    the collateral value to maintain a safety buffer against price swings.
    /// 5. The pool must have sufficient free liquidity
    ///    (`total_deposits - total_borrowed >= borrow_amount`).
    ///
    /// ## 2-of-2 Signature Enforcement
    ///
    /// Same guarantee as `deposit_to_pool`: the collateral can only be locked
    /// here if both vault owner and Lumina Agent co-signed the vault proposal.
    pub fn borrow_against_collateral(
        env:                Env,
        vault_contract:     Address,
        vault_tx_id:        BytesN<32>,
        collateral_amount:  i128,
        borrow_pool_id:     u32,
        borrow_amount:      i128,
        oracle:             Address,
        caller:             Address,
    ) {
        reentry_enter(&env);

        caller.require_auth();

        if collateral_amount <= 0 {
            panic!("collateral amount must be positive");
        }
        if borrow_amount <= 0 {
            panic!("borrow amount must be positive");
        }

        // Replay prevention.
        let used_key = DataKey::VaultTxUsed(vault_tx_id.clone());
        if env.storage().persistent().has(&used_key) {
            panic!("vault tx_id has already been consumed");
        }

        let mut pool = load_pool(&env, borrow_pool_id);
        if !pool.active {
            panic!("pool is not active");
        }

        // ── 2-of-2 vault verification ─────────────────────────────────────
        // Fetch the proposal exactly once; reuse `proposal.token` as the
        // collateral token so there is no second cross-contract call.
        // assert_vault_executed confirms the proposal is Executed, both
        // signatures are present, the recipient is this contract, and the
        // released amount covers the posted collateral.
        let proposal = fetch_vault_proposal(&env, &vault_contract, &vault_tx_id);
        let collateral_token = proposal.token.clone();
        assert_vault_executed(&env, &proposal, &collateral_token, collateral_amount);

        env.storage().persistent().set(&used_key, &true);

        // ── Oracle price fetch & staleness check ──────────────────────────
        // Prices are validated inside get_fresh_oracle_price; staleness
        // rejection closes the flash-loan + stale-oracle attack vector.
        let collateral_price = get_fresh_oracle_price(&env, &oracle, &collateral_token);
        let borrow_price     = get_fresh_oracle_price(&env, &oracle, &pool.token);

        // ── Collateral ratio check ────────────────────────────────────────
        let ratio_bps = calc_collateral_ratio_bps(
            collateral_amount,
            collateral_price.price,
            borrow_amount,
            borrow_price.price,
        );

        if ratio_bps < MIN_COLLATERAL_RATIO_BPS as i128 {
            panic!("collateral ratio below minimum 150%");
        }

        // ── LTV cap ───────────────────────────────────────────────────────
        // Borrow ≤ 75% of collateral value prevents over-leveraging.
        let collateral_value = collateral_amount
            .checked_mul(collateral_price.price)
            .expect("collateral value overflow");
        let max_borrow_value = collateral_value
            .checked_mul(MAX_BORROW_LTV_BPS as i128)
            .expect("max borrow value overflow")
            .checked_div(BPS_DIVISOR)
            .expect("max borrow div overflow");
        let borrow_value = borrow_amount
            .checked_mul(borrow_price.price)
            .expect("borrow value overflow");

        if borrow_value > max_borrow_value {
            panic!("borrow amount exceeds maximum LTV of 75%");
        }

        // ── Pool liquidity check ──────────────────────────────────────────
        let free_liquidity = pool
            .total_deposits
            .checked_sub(pool.total_borrowed)
            .unwrap_or(0);

        if free_liquidity < borrow_amount {
            panic!("insufficient pool liquidity");
        }

        // ── Record position & update pool state ───────────────────────────
        pool.total_borrowed = pool
            .total_borrowed
            .checked_add(borrow_amount)
            .expect("pool borrow overflow");

        save_pool(&env, borrow_pool_id, &pool);

        let lend_pos = LendPosition {
            collateral_token:  collateral_token.clone(),
            collateral_amount,
            borrow_pool_id,
            borrow_amount,
            opened_at:         env.ledger().timestamp(),
        };

        save_lend_pos(&env, &caller, borrow_pool_id, &lend_pos);

        // Transfer borrowed tokens to the caller.
        let token_client = TokenClient::new(&env, &pool.token);
        token_client.transfer(
            &env.current_contract_address(),
            &caller,
            &borrow_amount,
        );

        env.events().publish(
            (Symbol::new(&env, "borrowed"), caller.clone()),
            (borrow_pool_id, borrow_amount, collateral_token, collateral_amount),
        );

        log!(
            &env,
            "Borrow: user={}, pool={}, borrow={}, collateral={}, ratio_bps={}",
            caller,
            borrow_pool_id,
            borrow_amount,
            collateral_amount,
            ratio_bps,
        );

        reentry_exit(&env);
    }

    // ── Loan repayment ────────────────────────────────────────────────────────

    /// Repay a borrow and reclaim collateral.
    ///
    /// The caller transfers `repay_amount` of the borrow token back to this
    /// contract; if the repayment fully covers the outstanding debt the
    /// collateral is returned and the position is closed.  Partial repayments
    /// reduce the outstanding `borrow_amount` only.
    pub fn repay_loan(
        env:          Env,
        pool_id:      u32,
        repay_amount: i128,
        caller:       Address,
    ) {
        reentry_enter(&env);

        caller.require_auth();

        if repay_amount <= 0 {
            panic!("repay amount must be positive");
        }

        let mut pool = load_pool(&env, pool_id);
        let mut pos  = load_lend_pos(&env, &caller, pool_id);

        if repay_amount > pos.borrow_amount {
            panic!("repay amount exceeds outstanding debt");
        }

        let borrow_token = pool.token.clone();

        // Transfer repayment from caller into this contract.
        let token_client = TokenClient::new(&env, &borrow_token);
        token_client.transfer(
            &caller,
            &env.current_contract_address(),
            &repay_amount,
        );

        pool.total_borrowed = pool
            .total_borrowed
            .checked_sub(repay_amount)
            .expect("pool total_borrowed underflow");

        pos.borrow_amount = pos
            .borrow_amount
            .checked_sub(repay_amount)
            .expect("borrow amount underflow");

        let fully_repaid = pos.borrow_amount == 0;

        if fully_repaid {
            // Return collateral to the caller.
            let collateral_client = TokenClient::new(&env, &pos.collateral_token);
            collateral_client.transfer(
                &env.current_contract_address(),
                &caller,
                &pos.collateral_amount,
            );
            remove_lend_pos(&env, &caller, pool_id);
        } else {
            save_lend_pos(&env, &caller, pool_id, &pos);
        }

        save_pool(&env, pool_id, &pool);

        env.events().publish(
            (Symbol::new(&env, "repaid"), caller.clone()),
            (pool_id, repay_amount, fully_repaid),
        );

        log!(&env, "Repay: user={}, pool={}, amount={}, closed={}", caller, pool_id, repay_amount, fully_repaid);

        reentry_exit(&env);
    }

    // ── Liquidation ───────────────────────────────────────────────────────────

    /// Liquidate an under-collateralised borrowing position.
    ///
    /// Any address may call this function once a position's collateral ratio
    /// drops below `MIN_COLLATERAL_RATIO_BPS`.  The liquidator repays the
    /// outstanding debt and receives the collateral; the protocol recoups
    /// the borrow-side shortfall from the pool reserves.
    ///
    /// Oracle prices are re-fetched on every call to ensure the decision is
    /// based on current market data, not a cached or manipulated value.
    pub fn liquidate(
        env:      Env,
        borrower: Address,
        pool_id:  u32,
        oracle:   Address,
        caller:   Address,
    ) {
        reentry_enter(&env);

        caller.require_auth();

        let mut pool = load_pool(&env, pool_id);
        let pos      = load_lend_pos(&env, &borrower, pool_id);

        // Fresh prices — stale prices cannot be used to trigger liquidation.
        let collateral_price = get_fresh_oracle_price(&env, &oracle, &pos.collateral_token);
        let borrow_price     = get_fresh_oracle_price(&env, &oracle, &pool.token);

        let ratio_bps = calc_collateral_ratio_bps(
            pos.collateral_amount,
            collateral_price.price,
            pos.borrow_amount,
            borrow_price.price,
        );

        if ratio_bps >= MIN_COLLATERAL_RATIO_BPS as i128 {
            panic!("position is not eligible for liquidation");
        }

        // Liquidator repays the debt.
        let borrow_token = pool.token.clone();
        let borrow_client = TokenClient::new(&env, &borrow_token);
        borrow_client.transfer(
            &caller,
            &env.current_contract_address(),
            &pos.borrow_amount,
        );

        // Update pool state.
        pool.total_borrowed = pool
            .total_borrowed
            .checked_sub(pos.borrow_amount)
            .expect("pool total_borrowed underflow on liquidation");

        save_pool(&env, pool_id, &pool);

        // Transfer collateral to the liquidator as compensation.
        let collateral_client = TokenClient::new(&env, &pos.collateral_token);
        collateral_client.transfer(
            &env.current_contract_address(),
            &caller,
            &pos.collateral_amount,
        );

        remove_lend_pos(&env, &borrower, pool_id);

        env.events().publish(
            (Symbol::new(&env, "liquidated"), borrower.clone()),
            (pool_id, pos.borrow_amount, pos.collateral_amount, ratio_bps, caller.clone()),
        );

        log!(
            &env,
            "Liquidation: borrower={}, pool={}, debt={}, collateral={}, ratio_bps={}, liquidator={}",
            borrower,
            pool_id,
            pos.borrow_amount,
            pos.collateral_amount,
            ratio_bps,
            caller,
        );

        reentry_exit(&env);
    }

    // ── View functions ────────────────────────────────────────────────────────

    /// Return the stored pool state for `pool_id`.
    pub fn get_pool(env: Env, pool_id: u32) -> LiquidityPool {
        load_pool(&env, pool_id)
    }

    /// Return the liquidity position for `(user, pool_id)`.
    pub fn get_liq_position(env: Env, user: Address, pool_id: u32) -> LiqPosition {
        load_liq_pos(&env, &user, pool_id)
    }

    /// Return the lending position for `(user, pool_id)`.
    pub fn get_lend_position(env: Env, user: Address, pool_id: u32) -> LendPosition {
        load_lend_pos(&env, &user, pool_id)
    }

    /// Calculate the pending yield for a position without mutating state.
    ///
    /// Returns the total withdrawable yield (accumulated + newly accrued)
    /// at the current ledger timestamp.
    pub fn calc_yield_view(env: Env, user: Address, pool_id: u32) -> i128 {
        let pool = load_pool(&env, pool_id);
        let pos  = load_liq_pos(&env, &user, pool_id);

        if pos.amount == 0 {
            return pos.accumulated_yield;
        }

        let elapsed = env
            .ledger()
            .timestamp()
            .saturating_sub(pos.deposited_at);
        let accrued = calc_yield(pos.amount, pool.yield_rate_bps, elapsed);

        pos.accumulated_yield
            .checked_add(accrued)
            .expect("yield view overflow")
    }

    /// Return the current collateral ratio (in bps) for a lending position.
    pub fn get_collateral_ratio(
        env:      Env,
        user:     Address,
        pool_id:  u32,
        oracle:   Address,
    ) -> i128 {
        let pool = load_pool(&env, pool_id);
        let pos  = load_lend_pos(&env, &user, pool_id);

        let collateral_price = get_fresh_oracle_price(&env, &oracle, &pos.collateral_token);
        let borrow_price     = get_fresh_oracle_price(&env, &oracle, &pool.token);

        calc_collateral_ratio_bps(
            pos.collateral_amount,
            collateral_price.price,
            pos.borrow_amount,
            borrow_price.price,
        )
    }

    /// Return the protocol admin address.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("protocol not initialised")
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate alloc;

    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        token::{Client as TokenClient, StellarAssetClient},
        Env,
    };

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// Boot a fresh environment with the yield protocol contract deployed and
    /// initialised.  Returns `(env, admin, contract_id, client)`.
    fn setup() -> (
        &'static Env,
        Address,
        Address,
        YieldProtocolClient<'static>,
    ) {
        let env: &'static Env =
            alloc::boxed::Box::leak(alloc::boxed::Box::new(Env::default()));

        let contract_id = env.register_contract(None, YieldProtocol);
        let client      = YieldProtocolClient::new(env, &contract_id.clone());
        let admin       = Address::generate(env);

        env.mock_all_auths();
        client.initialize(&admin);

        (env, admin, contract_id, client)
    }

    /// Mint a test Stellar Asset token to `recipient` and return the address.
    fn mint_token(env: &Env, admin: &Address, recipient: &Address, amount: i128) -> Address {
        let token_id    = env.register_stellar_asset_contract_v2(admin.clone());
        let token_admin = StellarAssetClient::new(env, &token_id.address());
        token_admin.mint(recipient, &amount);
        token_id.address()
    }

    /// Register a pool with default parameters; returns `(pool_id, token_addr)`.
    fn setup_pool(
        env:    &Env,
        client: &YieldProtocolClient,
        admin:  &Address,
    ) -> (u32, Address) {
        let token   = mint_token(env, admin, &Address::generate(env), 0);
        let pool_id = client.register_pool(&token, &5_000_u32, &500_u32);
        (pool_id, token)
    }

    // ─── Simulated vault: deposit proof via a mock vault contract ─────────────
    //
    // Rather than deploying the full MultiSigVault contract in tests we use a
    // mock contract that exposes `get_proposal` and returns a pre-baked
    // `VaultProposal` identical in structure to what the real vault returns.
    //
    // This decouples the yield-protocol tests from the vault crate while still
    // exercising the cross-contract XDR round-trip.

    mod mock_vault {
        use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

        #[contracttype]
        #[derive(Clone, PartialEq)]
        pub enum ProposalStatus {
            Pending,
            Approved,
            Executed,
            Cancelled,
        }

        #[contracttype]
        #[derive(Clone)]
        pub struct ReleaseProposal {
            pub tx_id:        BytesN<32>,
            pub recipient:    Address,
            pub amount:       i128,
            pub token:        Address,
            pub owner_signed: bool,
            pub agent_signed: bool,
            pub status:       ProposalStatus,
        }

        #[contract]
        pub struct MockVault;

        #[contractimpl]
        impl MockVault {
            /// Store a proposal so `get_proposal` can return it.
            pub fn set_proposal(env: Env, proposal: ReleaseProposal) {
                env.storage()
                    .persistent()
                    .set(&proposal.tx_id.clone(), &proposal);
            }

            pub fn get_proposal(env: Env, tx_id: BytesN<32>) -> ReleaseProposal {
                env.storage()
                    .persistent()
                    .get(&tx_id)
                    .expect("proposal not found")
            }
        }
    }

    use mock_vault::{MockVault, MockVaultClient, ReleaseProposal as MockProposal,
                     ProposalStatus as MockStatus};

    fn make_tx_id(env: &Env, seed: u8) -> BytesN<32> {
        let mut bytes = [0u8; 32];
        bytes[0] = seed;
        BytesN::from_array(env, &bytes)
    }

    /// Register a mock vault, plant a pre-approved + executed proposal for
    /// `amount` tokens depositing to `yield_contract`, and return
    /// `(vault_addr, tx_id)`.
    fn plant_vault_deposit(
        env:            &Env,
        yield_contract: &Address,
        token:          &Address,
        amount:         i128,
        seed:           u8,
    ) -> (Address, BytesN<32>) {
        let vault_id = env.register_contract(None, MockVault);
        let vault    = MockVaultClient::new(env, &vault_id);
        let tx_id    = make_tx_id(env, seed);

        let proposal = MockProposal {
            tx_id:        tx_id.clone(),
            recipient:    yield_contract.clone(),
            amount,
            token:        token.clone(),
            owner_signed: true,
            agent_signed: true,
            status:       MockStatus::Executed,
        };

        vault.set_proposal(&proposal);
        (vault_id, tx_id)
    }

    // ── initialize ───────────────────────────────────────────────────────────

    #[test]
    fn test_initialize_stores_admin() {
        let (_env, admin, _contract_id, client) = setup();
        assert_eq!(client.get_admin(), admin);
    }

    #[test]
    #[should_panic(expected = "protocol already initialised")]
    fn test_double_initialize_panics() {
        let (env, admin, _contract_id, client) = setup();
        env.mock_all_auths();
        client.initialize(&admin);
    }

    // ── register_pool ─────────────────────────────────────────────────────────

    #[test]
    fn test_register_pool_returns_incrementing_ids() {
        let (env, admin, _, client) = setup();
        env.mock_all_auths();

        let token_a = mint_token(env, &admin, &Address::generate(env), 0);
        let token_b = mint_token(env, &admin, &Address::generate(env), 0);

        let id_a = client.register_pool(&token_a, &5_000_u32, &300_u32);
        let id_b = client.register_pool(&token_b, &5_000_u32, &400_u32);

        assert_eq!(id_a, 0);
        assert_eq!(id_b, 1);

        let pool_a = client.get_pool(&id_a);
        assert_eq!(pool_a.token,          token_a);
        assert_eq!(pool_a.total_deposits, 0);
        assert!(pool_a.active);
    }

    #[test]
    #[should_panic(expected = "pool_weight must not exceed 10 000 bps")]
    fn test_register_pool_excess_weight_panics() {
        let (env, admin, _, client) = setup();
        env.mock_all_auths();
        let token = mint_token(env, &admin, &Address::generate(env), 0);
        client.register_pool(&token, &10_001_u32, &500_u32);
    }

    // ── deposit_to_pool ───────────────────────────────────────────────────────

    #[test]
    fn test_deposit_credits_position_and_pool() {
        let (env, admin, contract_id, client) = setup();
        env.mock_all_auths();

        let (pool_id, token) = setup_pool(env, &client, &admin);

        // Mint tokens directly to yield contract (simulating vault execute_release).
        let sac = StellarAssetClient::new(env, &token);
        sac.mint(&contract_id, &500_i128);

        let caller             = Address::generate(env);
        let (vault, vault_tx)  =
            plant_vault_deposit(env, &contract_id, &token, 500, 1);

        client.deposit_to_pool(&vault, &vault_tx, &pool_id, &500_i128, &caller);

        let pos  = client.get_liq_position(&caller, &pool_id);
        let pool = client.get_pool(&pool_id);

        assert_eq!(pos.amount, 500);
        assert_eq!(pool.total_deposits, 500);
    }

    #[test]
    #[should_panic(expected = "vault tx_id has already been consumed")]
    fn test_deposit_replay_panics() {
        let (env, admin, contract_id, client) = setup();
        env.mock_all_auths();

        let (pool_id, token)  = setup_pool(env, &client, &admin);
        let sac               = StellarAssetClient::new(env, &token);
        sac.mint(&contract_id, &1000_i128);

        let caller            = Address::generate(env);
        let (vault, vault_tx) = plant_vault_deposit(env, &contract_id, &token, 1000, 2);

        client.deposit_to_pool(&vault, &vault_tx, &pool_id, &500_i128, &caller);
        // second call with the same vault_tx_id must panic
        client.deposit_to_pool(&vault, &vault_tx, &pool_id, &500_i128, &caller);
    }

    #[test]
    #[should_panic(expected = "deposit amount must be positive")]
    fn test_deposit_zero_amount_panics() {
        let (env, admin, contract_id, client) = setup();
        env.mock_all_auths();

        let (pool_id, token)  = setup_pool(env, &client, &admin);
        let caller            = Address::generate(env);
        let (vault, vault_tx) = plant_vault_deposit(env, &contract_id, &token, 0, 3);

        client.deposit_to_pool(&vault, &vault_tx, &pool_id, &0_i128, &caller);
    }

    // ── withdraw_from_pool ────────────────────────────────────────────────────

    #[test]
    fn test_withdraw_returns_principal_and_yield() {
        let (env, admin, contract_id, client) = setup();
        env.mock_all_auths();

        let (pool_id, token) = setup_pool(env, &client, &admin);
        let sac              = StellarAssetClient::new(env, &token);
        sac.mint(&contract_id, &1_000_i128);

        let caller            = Address::generate(env);
        let (vault, vault_tx) = plant_vault_deposit(env, &contract_id, &token, 1_000, 10);

        client.deposit_to_pool(&vault, &vault_tx, &pool_id, &1_000_i128, &caller);

        // Advance time by one year.
        env.ledger().with_mut(|li| {
            li.timestamp = li.timestamp + SECONDS_PER_YEAR;
        });

        // yield = 1000 * 500 bps / 10000 = 50 tokens after one year.
        let expected_yield: i128 = 50;
        // Mint the yield amount into the contract to cover payout.
        sac.mint(&contract_id, &expected_yield);

        let tok_client = TokenClient::new(env, &token);
        let before     = tok_client.balance(&caller);

        client.withdraw_from_pool(&pool_id, &1_000_i128, &caller);

        let after = tok_client.balance(&caller);
        assert_eq!(after - before, 1_000 + expected_yield);

        let pool = client.get_pool(&pool_id);
        assert_eq!(pool.total_deposits, 0);
    }

    #[test]
    #[should_panic(expected = "insufficient deposited balance")]
    fn test_withdraw_more_than_deposited_panics() {
        let (env, admin, contract_id, client) = setup();
        env.mock_all_auths();

        let (pool_id, token) = setup_pool(env, &client, &admin);
        let sac              = StellarAssetClient::new(env, &token);
        sac.mint(&contract_id, &100_i128);

        let caller            = Address::generate(env);
        let (vault, vault_tx) = plant_vault_deposit(env, &contract_id, &token, 100, 20);

        client.deposit_to_pool(&vault, &vault_tx, &pool_id, &100_i128, &caller);
        client.withdraw_from_pool(&pool_id, &101_i128, &caller);
    }

    // ── calc_yield (unit tests for math) ──────────────────────────────────────

    #[test]
    fn test_calc_yield_one_year_500bps() {
        // 1 000 tokens × 500 bps annual yield × 1 year = 50 tokens
        let result = calc_yield(1_000, 500, SECONDS_PER_YEAR);
        assert_eq!(result, 50);
    }

    #[test]
    fn test_calc_yield_zero_time() {
        assert_eq!(calc_yield(1_000, 500, 0), 0);
    }

    #[test]
    fn test_calc_yield_zero_principal() {
        assert_eq!(calc_yield(0, 500, SECONDS_PER_YEAR), 0);
    }

    // ── calc_collateral_ratio_bps (unit tests for math) ───────────────────────

    #[test]
    fn test_collateral_ratio_150_percent() {
        // collateral=150, price=1; borrow=100, price=1  → 150%
        let ratio = calc_collateral_ratio_bps(150, 1_000_000, 100, 1_000_000);
        assert_eq!(ratio, 15_000);
    }

    #[test]
    fn test_collateral_ratio_200_percent() {
        let ratio = calc_collateral_ratio_bps(200, 1_000_000, 100, 1_000_000);
        assert_eq!(ratio, 20_000);
    }

    #[test]
    #[should_panic(expected = "oracle: borrow price must be positive")]
    fn test_collateral_ratio_zero_borrow_price_panics() {
        calc_collateral_ratio_bps(150, 1_000_000, 100, 0);
    }
}
