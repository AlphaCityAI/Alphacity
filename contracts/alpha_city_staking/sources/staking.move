module alpha_city_staking::staking {
    use sui::balance::{Self, Balance};
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::event;
    use sui::object::{Self, UID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};

    const E_NOT_ADMIN: u64 = 1;
    const E_PAUSED: u64 = 2;
    const E_INVALID_LOCK: u64 = 3;
    const E_NOT_OWNER: u64 = 4;
    const E_LOCK_ACTIVE: u64 = 5;

    const LOCK_7_DAYS: u64 = 604800;
    const LOCK_30_DAYS: u64 = 2592000;
    const LOCK_90_DAYS: u64 = 7776000;

    /// 1.0x
    const MULTIPLIER_7D_BPS: u64 = 10000;
    /// 1.5x
    const MULTIPLIER_30D_BPS: u64 = 15000;
    /// 2.0x
    const MULTIPLIER_90D_BPS: u64 = 20000;

    /// Seconds in one day.
    const SECONDS_PER_DAY: u64 = 86400;
    const BPS_DENOMINATOR: u64 = 10000;

    /// Shared staking pool for a specific token `T`.
    /// `daily_reward_rate_bps` means: daily rewards as basis points of principal.
    /// Example: 20 = 0.20% daily base APR (before lock multiplier).
    public struct StakingPool<phantom T> has key {
        id: UID,
        admin: address,
        paused: bool,
        daily_reward_rate_bps: u64,
        total_staked: u64,
        staked_vault: Balance<T>,
        reward_vault: Balance<T>,
    }

    /// NFT-like position object owned by the staker.
    public struct StakePosition<phantom T> has key, store {
        id: UID,
        owner: address,
        principal: u64,
        lock_seconds: u64,
        lock_start_ms: u64,
        last_claim_ms: u64,
        multiplier_bps: u64,
    }

    public struct PoolCreated has copy, drop {
        pool_id: object::ID,
        admin: address,
        daily_reward_rate_bps: u64,
    }

    public struct Staked has copy, drop {
        pool_id: object::ID,
        position_id: object::ID,
        staker: address,
        principal: u64,
        lock_seconds: u64,
        multiplier_bps: u64,
    }

    public struct Claimed has copy, drop {
        pool_id: object::ID,
        position_id: object::ID,
        staker: address,
        reward_amount: u64,
    }

    public struct Unstaked has copy, drop {
        pool_id: object::ID,
        position_id: object::ID,
        staker: address,
        principal: u64,
        reward_amount: u64,
    }

    public entry fun init_pool<T>(daily_reward_rate_bps: u64, ctx: &mut TxContext) {
        let pool = StakingPool<T> {
            id: object::new(ctx),
            admin: tx_context::sender(ctx),
            paused: false,
            daily_reward_rate_bps,
            total_staked: 0,
            staked_vault: balance::zero<T>(),
            reward_vault: balance::zero<T>(),
        };

        event::emit(PoolCreated {
            pool_id: object::id(&pool),
            admin: pool.admin,
            daily_reward_rate_bps,
        });

        transfer::share_object(pool);
    }

    public entry fun deposit_rewards<T>(pool: &mut StakingPool<T>, reward_coin: Coin<T>, ctx: &TxContext) {
        assert_admin(pool, ctx);
        balance::join(&mut pool.reward_vault, coin::into_balance(reward_coin));
    }

    public entry fun set_daily_reward_rate_bps<T>(pool: &mut StakingPool<T>, daily_reward_rate_bps: u64, ctx: &TxContext) {
        assert_admin(pool, ctx);
        pool.daily_reward_rate_bps = daily_reward_rate_bps;
    }

    public entry fun set_paused<T>(pool: &mut StakingPool<T>, paused: bool, ctx: &TxContext) {
        assert_admin(pool, ctx);
        pool.paused = paused;
    }

    public entry fun stake<T>(
        pool: &mut StakingPool<T>,
        stake_coin: Coin<T>,
        lock_seconds: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(!pool.paused, E_PAUSED);

        let sender = tx_context::sender(ctx);
        let principal = coin::value(&stake_coin);
        let multiplier_bps = lock_multiplier_bps(lock_seconds);
        let now_ms = clock::timestamp_ms(clock);

        pool.total_staked = pool.total_staked + principal;
        balance::join(&mut pool.staked_vault, coin::into_balance(stake_coin));

        let position = StakePosition<T> {
            id: object::new(ctx),
            owner: sender,
            principal,
            lock_seconds,
            lock_start_ms: now_ms,
            last_claim_ms: now_ms,
            multiplier_bps,
        };

        event::emit(Staked {
            pool_id: object::id(pool),
            position_id: object::id(&position),
            staker: sender,
            principal,
            lock_seconds,
            multiplier_bps,
        });

        transfer::public_transfer(position, sender);
    }

    public entry fun claim<T>(pool: &mut StakingPool<T>, position: &mut StakePosition<T>, clock: &Clock, ctx: &mut TxContext) {
        assert!(!pool.paused, E_PAUSED);
        let sender = tx_context::sender(ctx);
        assert!(position.owner == sender, E_NOT_OWNER);

        let now_ms = clock::timestamp_ms(clock);
        let reward = pending_rewards(pool, position, now_ms);
        position.last_claim_ms = now_ms;

        if (reward > 0) {
            let available = balance::value(&pool.reward_vault);
            let payout = if (reward > available) available else reward;
            if (payout > 0) {
                let reward_coin = coin::from_balance(balance::split(&mut pool.reward_vault, payout), ctx);
                transfer::public_transfer(reward_coin, sender);
            };

            event::emit(Claimed {
                pool_id: object::id(pool),
                position_id: object::id(position),
                staker: sender,
                reward_amount: payout,
            });
        };
    }

    public entry fun unstake<T>(pool: &mut StakingPool<T>, position: StakePosition<T>, clock: &Clock, ctx: &mut TxContext) {
        assert!(!pool.paused, E_PAUSED);
        let sender = tx_context::sender(ctx);

        let StakePosition {
            id,
            owner,
            principal,
            lock_seconds,
            lock_start_ms,
            last_claim_ms,
            multiplier_bps,
        } = position;

        assert!(owner == sender, E_NOT_OWNER);
        let now_ms = clock::timestamp_ms(clock);
        let unlocked_at_ms = lock_start_ms + (lock_seconds * 1000);
        assert!(now_ms >= unlocked_at_ms, E_LOCK_ACTIVE);

        let reward = pending_rewards_raw(principal, pool.daily_reward_rate_bps, multiplier_bps, last_claim_ms, now_ms);
        let available = balance::value(&pool.reward_vault);
        let payout = if (reward > available) available else reward;

        pool.total_staked = pool.total_staked - principal;

        let principal_coin = coin::from_balance(balance::split(&mut pool.staked_vault, principal), ctx);
        transfer::public_transfer(principal_coin, sender);

        if (payout > 0) {
            let reward_coin = coin::from_balance(balance::split(&mut pool.reward_vault, payout), ctx);
            transfer::public_transfer(reward_coin, sender);
        };

        event::emit(Unstaked {
            pool_id: object::id(pool),
            position_id: object::uid_to_inner(&id),
            staker: sender,
            principal,
            reward_amount: payout,
        });

        object::delete(id);
    }

    public fun pending_rewards<T>(pool: &StakingPool<T>, position: &StakePosition<T>, now_ms: u64): u64 {
        pending_rewards_raw(
            position.principal,
            pool.daily_reward_rate_bps,
            position.multiplier_bps,
            position.last_claim_ms,
            now_ms,
        )
    }

    fun pending_rewards_raw(
        principal: u64,
        daily_reward_rate_bps: u64,
        multiplier_bps: u64,
        last_claim_ms: u64,
        now_ms: u64,
    ): u64 {
        if (now_ms <= last_claim_ms) {
            return 0
        };

        let elapsed_seconds = (now_ms - last_claim_ms) / 1000;
        if (elapsed_seconds == 0) {
            return 0
        };

        let numerator =
            (principal as u128)
            * (elapsed_seconds as u128)
            * (daily_reward_rate_bps as u128)
            * (multiplier_bps as u128);
        let denominator =
            (SECONDS_PER_DAY as u128)
            * (BPS_DENOMINATOR as u128)
            * (BPS_DENOMINATOR as u128);

        ((numerator / denominator) as u64)
    }

    fun lock_multiplier_bps(lock_seconds: u64): u64 {
        if (lock_seconds == LOCK_7_DAYS) {
            MULTIPLIER_7D_BPS
        } else if (lock_seconds == LOCK_30_DAYS) {
            MULTIPLIER_30D_BPS
        } else if (lock_seconds == LOCK_90_DAYS) {
            MULTIPLIER_90D_BPS
        } else {
            abort E_INVALID_LOCK
        }
    }

    fun assert_admin<T>(pool: &StakingPool<T>, ctx: &TxContext) {
        assert!(pool.admin == tx_context::sender(ctx), E_NOT_ADMIN);
    }
}
