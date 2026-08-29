module sluice::sluice_v2 {
    use std::option::{Self, Option};
    use std::vector;
    use sui::balance::{Self, Balance};
    use sui::bcs;
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::object::{Self, UID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};

    // Error codes
    const E_NOT_AUTHORIZED: u64 = 0;
    const E_INVALID_TIMELINE: u64 = 1;
    const E_NOTHING_TO_CLAIM: u64 = 2;
    const E_INVALID_STATE: u64 = 3;
    const E_INVALID_SIGNATURE: u64 = 4;
    const E_INVALID_ORACLE_POLICY: u64 = 5;
    const E_INVALID_OBSERVATION: u64 = 6;
    const E_OBSERVATION_REPLAY: u64 = 7;
    const E_TRIGGER_NOT_EXPIRED: u64 = 8;
    const E_INVALID_AMOUNT: u64 = 9;
    const E_INVALID_ADDRESS: u64 = 10;
    const E_INVALID_TRIGGER: u64 = 11;
    const E_TRIGGER_EXPIRED: u64 = 12;

    // Schedule states
    const STATUS_PENDING: u8 = 0;
    const STATUS_ACTIVE: u8 = 1;
    const STATUS_CANCELLED: u8 = 2;
    const STATUS_COMPLETED: u8 = 3;

    // Trigger kinds. Values are intentionally stable for indexers and relayers.
    const TRIGGER_TIME: u8 = 0;
    const TRIGGER_MARKET_CAP_USD: u8 = 1;
    const TRIGGER_FDV_USD: u8 = 2;
    const TRIGGER_PRICE_USD_E8: u8 = 3;
    const TRIGGER_LIQUIDITY_USD: u8 = 4;
    const TRIGGER_VOLUME_24H_USD: u8 = 5;
    const TRIGGER_HOLDER_COUNT: u8 = 6;
    const TRIGGER_CUSTOM: u8 = 255;

    const COMPARISON_GTE: u8 = 0;
    const COMPARISON_LTE: u8 = 1;

    const FALLBACK_REFUND_CREATOR: u8 = 0;
    const FALLBACK_ACTIVATE: u8 = 1;

    const OBSERVATION_DOMAIN: vector<u8> = b"alphacity.sluice.v2.observation";
    const CLAIM_DOMAIN: vector<u8> = b"alphacity.sluice.v2.claim";
    const MAX_ORACLES: u64 = 10;
    const MAX_CLIENT_REFERENCE_BYTES: u64 = 64;

    /// V2 keeps trigger sampling and lifecycle state on-chain. Off-chain relayers
    /// only submit signed observations; the contract determines continuity,
    /// activation, expiry fallback, claiming, and cancellation amounts.
    public struct VestingScheduleV2<phantom T> has key, store {
        id: UID,
        version: u8,
        creator: address,
        beneficiary: address,
        balance: Balance<T>,
        total_amount: u64,
        released_amount: u64,

        // Active timeline. For triggered schedules these values are finalized
        // when the validation window clears.
        start_time_ms: u64,
        end_time_ms: u64,
        vesting_duration_ms: u64,
        interval_ms: u64,
        not_before_ms: u64,
        status: u8,
        revocable: bool,

        // Trigger policy.
        trigger_kind: u8,
        comparison: u8,
        target_value: u64,
        trigger_config_hash: vector<u8>,
        min_liquidity_usd: u64,
        validation_window_ms: u64,
        max_sample_gap_ms: u64,
        max_observation_age_ms: u64,
        above_since_ms: Option<u64>,
        last_observed_at_ms: Option<u64>,
        last_observed_value: Option<u64>,
        oracle_pubkeys: vector<vector<u8>>,
        oracle_threshold: u8,
        trigger_deadline_ms: u64,
        fallback_policy: u8,

        // Client-generated reference used to find a just-created schedule
        // without depending on eventually indexed transaction events.
        client_reference: vector<u8>,
    }

    public struct ObservationMessage has copy, drop, store {
        domain: vector<u8>,
        schedule_id: address,
        trigger_config_hash: vector<u8>,
        trigger_kind: u8,
        comparison: u8,
        observed_value: u64,
        observed_at_ms: u64,
        valid_until_ms: u64,
    }

    public struct ClaimMessage has copy, drop, store {
        domain: vector<u8>,
        schedule_id: address,
        current_beneficiary: address,
        new_beneficiary: address,
        valid_until_ms: u64,
    }

    public struct ScheduleCreatedV2 has copy, drop {
        schedule_id: address,
        creator: address,
        beneficiary: address,
        total_amount: u64,
        trigger_kind: u8,
        target_value: u64,
        client_reference: vector<u8>,
    }

    public struct ObservationSubmitted has copy, drop {
        schedule_id: address,
        observed_value: u64,
        observed_at_ms: u64,
        condition_met: bool,
        above_since_ms: Option<u64>,
    }

    public struct VestingActivatedV2 has copy, drop {
        schedule_id: address,
        activated_at_ms: u64,
        start_time_ms: u64,
        end_time_ms: u64,
    }

    public struct TokensClaimedV2 has copy, drop {
        schedule_id: address,
        beneficiary: address,
        amount: u64,
    }

    public struct ScheduleCancelledV2 has copy, drop {
        schedule_id: address,
        vested_paid_to_beneficiary: u64,
        returned_to_creator: u64,
    }

    public struct TriggerExpiredV2 has copy, drop {
        schedule_id: address,
        fallback_policy: u8,
    }

    public struct BeneficiaryReassignedV2 has copy, drop {
        schedule_id: address,
        old_beneficiary: address,
        new_beneficiary: address,
    }

    public struct OraclePolicyRotatedV2 has copy, drop {
        schedule_id: address,
        oracle_threshold: u8,
        oracle_count: u64,
    }

    /// Creates a normal time-based schedule. The release interval must fit
    /// inside the duration; use interval == duration for an explicit cliff.
    public entry fun create_time_schedule<T>(
        coins: Coin<T>,
        beneficiary: address,
        start_time_ms: u64,
        end_time_ms: u64,
        interval_ms: u64,
        revocable: bool,
        client_reference: vector<u8>,
        ctx: &mut TxContext,
    ) {
        let duration = end_time_ms - start_time_ms;
        validate_common(&coins, beneficiary, duration, interval_ms, &client_reference);

        let total_amount = coin::value(&coins);
        let schedule = VestingScheduleV2 {
            id: object::new(ctx),
            version: 2,
            creator: tx_context::sender(ctx),
            beneficiary,
            balance: coin::into_balance(coins),
            total_amount,
            released_amount: 0,
            start_time_ms,
            end_time_ms,
            vesting_duration_ms: duration,
            interval_ms,
            not_before_ms: start_time_ms,
            status: STATUS_ACTIVE,
            revocable,
            trigger_kind: TRIGGER_TIME,
            comparison: COMPARISON_GTE,
            target_value: 0,
            trigger_config_hash: vector[],
            min_liquidity_usd: 0,
            validation_window_ms: 0,
            max_sample_gap_ms: 0,
            max_observation_age_ms: 0,
            above_since_ms: option::none(),
            last_observed_at_ms: option::none(),
            last_observed_value: option::none(),
            oracle_pubkeys: vector[],
            oracle_threshold: 0,
            trigger_deadline_ms: 0,
            fallback_policy: FALLBACK_REFUND_CREATOR,
            client_reference,
        };
        emit_created(&schedule);
        transfer::share_object(schedule);
    }

    /// Creates an oracle-triggered schedule. Trigger values are fixed-point
    /// integers defined by trigger_kind (for example PRICE_USD_E8 uses 8
    /// decimal places; USD capitalization/liquidity/volume values use dollars).
    public entry fun create_triggered_schedule<T>(
        coins: Coin<T>,
        beneficiary: address,
        not_before_ms: u64,
        vesting_duration_ms: u64,
        interval_ms: u64,
        trigger_kind: u8,
        comparison: u8,
        target_value: u64,
        trigger_config_hash: vector<u8>,
        min_liquidity_usd: u64,
        validation_window_ms: u64,
        max_sample_gap_ms: u64,
        max_observation_age_ms: u64,
        oracle_pubkeys: vector<vector<u8>>,
        oracle_threshold: u8,
        trigger_deadline_ms: u64,
        fallback_policy: u8,
        revocable: bool,
        client_reference: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        validate_common(
            &coins,
            beneficiary,
            vesting_duration_ms,
            interval_ms,
            &client_reference,
        );
        validate_trigger(
            trigger_kind,
            comparison,
            target_value,
            &trigger_config_hash,
            validation_window_ms,
            max_sample_gap_ms,
            max_observation_age_ms,
            &oracle_pubkeys,
            oracle_threshold,
            trigger_deadline_ms,
            fallback_policy,
            clock::timestamp_ms(clock),
        );

        let total_amount = coin::value(&coins);
        let schedule = VestingScheduleV2 {
            id: object::new(ctx),
            version: 2,
            creator: tx_context::sender(ctx),
            beneficiary,
            balance: coin::into_balance(coins),
            total_amount,
            released_amount: 0,
            start_time_ms: not_before_ms,
            end_time_ms: not_before_ms + vesting_duration_ms,
            vesting_duration_ms,
            interval_ms,
            not_before_ms,
            status: STATUS_PENDING,
            revocable,
            trigger_kind,
            comparison,
            target_value,
            trigger_config_hash,
            min_liquidity_usd,
            validation_window_ms,
            max_sample_gap_ms,
            max_observation_age_ms,
            above_since_ms: option::none(),
            last_observed_at_ms: option::none(),
            last_observed_value: option::none(),
            oracle_pubkeys,
            oracle_threshold,
            trigger_deadline_ms,
            fallback_policy,
            client_reference,
        };
        emit_created(&schedule);
        transfer::share_object(schedule);
    }

    /// Submits one authenticated observation. The contract resets the
    /// continuity window after a failed observation or an excessive sample gap
    /// and activates only after the full validation window is represented by
    /// fresh, monotonically increasing observations.
    public entry fun submit_observation<T>(
        schedule: &mut VestingScheduleV2<T>,
        observed_value: u64,
        observed_at_ms: u64,
        valid_until_ms: u64,
        signer_indices: vector<u8>,
        signatures: vector<vector<u8>>,
        clock: &Clock,
    ) {
        assert!(schedule.status == STATUS_PENDING, E_INVALID_STATE);

        let now = clock::timestamp_ms(clock);
        assert!(
            schedule.trigger_deadline_ms == 0 || now < schedule.trigger_deadline_ms,
            E_TRIGGER_EXPIRED,
        );
        assert!(observed_at_ms <= now, E_INVALID_OBSERVATION);
        assert!(now - observed_at_ms <= schedule.max_observation_age_ms, E_INVALID_OBSERVATION);
        assert!(valid_until_ms >= now, E_INVALID_OBSERVATION);

        if (option::is_some(&schedule.last_observed_at_ms)) {
            assert!(
                observed_at_ms > *option::borrow(&schedule.last_observed_at_ms),
                E_OBSERVATION_REPLAY,
            );
        };

        let message = observation_message_bytes(
            schedule,
            observed_value,
            observed_at_ms,
            valid_until_ms,
        );
        verify_oracle_threshold(
            &schedule.oracle_pubkeys,
            schedule.oracle_threshold,
            &signer_indices,
            &signatures,
            &message,
        );

        apply_observation(schedule, observed_value, observed_at_ms, now);
    }

    /// Test-only entry into the same continuity state machine used after
    /// production signature verification. This helper is stripped from the
    /// published bytecode.
    #[test_only]
    public fun submit_observation_for_testing<T>(
        schedule: &mut VestingScheduleV2<T>,
        observed_value: u64,
        observed_at_ms: u64,
        now_ms: u64,
    ) {
        assert!(schedule.status == STATUS_PENDING, E_INVALID_STATE);
        assert!(
            schedule.trigger_deadline_ms == 0 || now_ms < schedule.trigger_deadline_ms,
            E_TRIGGER_EXPIRED,
        );
        assert!(observed_at_ms <= now_ms, E_INVALID_OBSERVATION);
        assert!(now_ms - observed_at_ms <= schedule.max_observation_age_ms, E_INVALID_OBSERVATION);
        if (option::is_some(&schedule.last_observed_at_ms)) {
            assert!(
                observed_at_ms > *option::borrow(&schedule.last_observed_at_ms),
                E_OBSERVATION_REPLAY,
            );
        };
        apply_observation(schedule, observed_value, observed_at_ms, now_ms);
    }

    fun apply_observation<T>(
        schedule: &mut VestingScheduleV2<T>,
        observed_value: u64,
        observed_at_ms: u64,
        now_ms: u64,
    ) {

        let condition_met = condition_is_met(
            schedule.comparison,
            observed_value,
            schedule.target_value,
        );
        let gap_exceeded = if (option::is_some(&schedule.last_observed_at_ms)) {
            observed_at_ms - *option::borrow(&schedule.last_observed_at_ms)
                > schedule.max_sample_gap_ms
        } else {
            false
        };

        schedule.last_observed_at_ms = option::some(observed_at_ms);
        schedule.last_observed_value = option::some(observed_value);

        if (!condition_met) {
            schedule.above_since_ms = option::none();
        } else {
            if (gap_exceeded || !option::is_some(&schedule.above_since_ms)) {
                schedule.above_since_ms = option::some(observed_at_ms);
            };

            let above_since = *option::borrow(&schedule.above_since_ms);
            if (observed_at_ms - above_since >= schedule.validation_window_ms) {
                activate(schedule, now_ms);
            };
        };

        sui::event::emit(ObservationSubmitted {
            schedule_id: object::uid_to_address(&schedule.id),
            observed_value,
            observed_at_ms,
            condition_met,
            above_since_ms: schedule.above_since_ms,
        });
    }

    /// Resolves a pending schedule after its configured trigger deadline.
    /// The immutable fallback is either activation or a full creator refund.
    public entry fun resolve_expired_trigger<T>(
        schedule: &mut VestingScheduleV2<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(schedule.status == STATUS_PENDING, E_INVALID_STATE);
        assert!(schedule.trigger_deadline_ms > 0, E_TRIGGER_NOT_EXPIRED);
        let now = clock::timestamp_ms(clock);
        assert!(now >= schedule.trigger_deadline_ms, E_TRIGGER_NOT_EXPIRED);

        let policy = schedule.fallback_policy;
        if (policy == FALLBACK_ACTIVATE) {
            activate(schedule, now);
        } else {
            let returned = balance::value(&schedule.balance);
            transfer_all(&mut schedule.balance, schedule.creator, ctx);
            schedule.status = STATUS_CANCELLED;
            sui::event::emit(ScheduleCancelledV2 {
                schedule_id: object::uid_to_address(&schedule.id),
                vested_paid_to_beneficiary: 0,
                returned_to_creator: returned,
            });
        };

        sui::event::emit(TriggerExpiredV2 {
            schedule_id: object::uid_to_address(&schedule.id),
            fallback_policy: policy,
        });
    }

    /// Permissionless claim: tokens always transfer to the current beneficiary.
    public entry fun claim_vested<T>(
        schedule: &mut VestingScheduleV2<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(schedule.status == STATUS_ACTIVE, E_INVALID_STATE);
        let vested = calculate_vested_amount(
            schedule.total_amount,
            schedule.start_time_ms,
            schedule.end_time_ms,
            schedule.interval_ms,
            clock::timestamp_ms(clock),
        );
        let claimable = vested - schedule.released_amount;
        assert!(claimable > 0, E_NOTHING_TO_CLAIM);

        schedule.released_amount = schedule.released_amount + claimable;
        transfer_amount(&mut schedule.balance, claimable, schedule.beneficiary, ctx);
        if (balance::value(&schedule.balance) == 0) {
            schedule.status = STATUS_COMPLETED;
        };

        sui::event::emit(TokensClaimedV2 {
            schedule_id: object::uid_to_address(&schedule.id),
            beneficiary: schedule.beneficiary,
            amount: claimable,
        });
    }

    /// Revocation preserves the beneficiary's already vested entitlement and
    /// returns only the genuinely unvested remainder to the creator.
    public entry fun cancel_schedule<T>(
        schedule: &mut VestingScheduleV2<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == schedule.creator, E_NOT_AUTHORIZED);
        assert!(schedule.revocable, E_NOT_AUTHORIZED);
        assert!(
            schedule.status == STATUS_PENDING || schedule.status == STATUS_ACTIVE,
            E_INVALID_STATE,
        );

        let mut vested_paid = 0;
        if (schedule.status == STATUS_ACTIVE) {
            let vested = calculate_vested_amount(
                schedule.total_amount,
                schedule.start_time_ms,
                schedule.end_time_ms,
                schedule.interval_ms,
                clock::timestamp_ms(clock),
            );
            vested_paid = vested - schedule.released_amount;
            if (vested_paid > 0) {
                transfer_amount(
                    &mut schedule.balance,
                    vested_paid,
                    schedule.beneficiary,
                    ctx,
                );
                schedule.released_amount = schedule.released_amount + vested_paid;
            };
        };

        let returned = balance::value(&schedule.balance);
        transfer_all(&mut schedule.balance, schedule.creator, ctx);
        schedule.status = STATUS_CANCELLED;

        sui::event::emit(ScheduleCancelledV2 {
            schedule_id: object::uid_to_address(&schedule.id),
            vested_paid_to_beneficiary: vested_paid,
            returned_to_creator: returned,
        });
    }

    public entry fun reassign_beneficiary<T>(
        schedule: &mut VestingScheduleV2<T>,
        new_beneficiary: address,
        ctx: &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == schedule.beneficiary, E_NOT_AUTHORIZED);
        reassign(schedule, new_beneficiary);
    }

    /// Bearer-link claim path. The ephemeral beneficiary key signs a bounded,
    /// domain-separated reassignment message. Any wallet may sponsor gas.
    public entry fun reassign_beneficiary_by_signature<T>(
        schedule: &mut VestingScheduleV2<T>,
        pubkey: vector<u8>,
        signature: vector<u8>,
        new_beneficiary: address,
        valid_until_ms: u64,
        clock: &Clock,
    ) {
        assert!(vector::length(&pubkey) == 32, E_INVALID_SIGNATURE);
        assert!(vector::length(&signature) == 64, E_INVALID_SIGNATURE);
        assert!(valid_until_ms >= clock::timestamp_ms(clock), E_INVALID_SIGNATURE);

        let mut address_bytes = vector[0x00];
        vector::append(&mut address_bytes, pubkey);
        let derived = sui::address::from_bytes(sui::hash::blake2b256(&address_bytes));
        assert!(derived == schedule.beneficiary, E_NOT_AUTHORIZED);

        let message = claim_message_bytes(schedule, new_beneficiary, valid_until_ms);
        assert!(
            sui::ed25519::ed25519_verify(&signature, &pubkey, &message),
            E_INVALID_SIGNATURE,
        );
        reassign(schedule, new_beneficiary);
    }

    /// A creator may rotate a pending oracle policy only when the schedule is
    /// revocable. An irrevocable schedule's oracle trust policy is immutable.
    public entry fun rotate_oracle_policy<T>(
        schedule: &mut VestingScheduleV2<T>,
        oracle_pubkeys: vector<vector<u8>>,
        oracle_threshold: u8,
        ctx: &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == schedule.creator, E_NOT_AUTHORIZED);
        assert!(schedule.revocable, E_NOT_AUTHORIZED);
        assert!(schedule.status == STATUS_PENDING, E_INVALID_STATE);
        validate_oracle_policy(&oracle_pubkeys, oracle_threshold);

        schedule.oracle_pubkeys = oracle_pubkeys;
        schedule.oracle_threshold = oracle_threshold;
        schedule.above_since_ms = option::none();
        schedule.last_observed_at_ms = option::none();
        schedule.last_observed_value = option::none();

        sui::event::emit(OraclePolicyRotatedV2 {
            schedule_id: object::uid_to_address(&schedule.id),
            oracle_threshold,
            oracle_count: vector::length(&schedule.oracle_pubkeys),
        });
    }

    public fun observation_message_bytes<T>(
        schedule: &VestingScheduleV2<T>,
        observed_value: u64,
        observed_at_ms: u64,
        valid_until_ms: u64,
    ): vector<u8> {
        bcs::to_bytes(&ObservationMessage {
            domain: OBSERVATION_DOMAIN,
            schedule_id: object::uid_to_address(&schedule.id),
            trigger_config_hash: schedule.trigger_config_hash,
            trigger_kind: schedule.trigger_kind,
            comparison: schedule.comparison,
            observed_value,
            observed_at_ms,
            valid_until_ms,
        })
    }

    public fun claim_message_bytes<T>(
        schedule: &VestingScheduleV2<T>,
        new_beneficiary: address,
        valid_until_ms: u64,
    ): vector<u8> {
        bcs::to_bytes(&ClaimMessage {
            domain: CLAIM_DOMAIN,
            schedule_id: object::uid_to_address(&schedule.id),
            current_beneficiary: schedule.beneficiary,
            new_beneficiary,
            valid_until_ms,
        })
    }

    /// Linear vesting rounded down to the configured release interval.
    public fun calculate_vested_amount(
        total_amount: u64,
        start_time_ms: u64,
        end_time_ms: u64,
        interval_ms: u64,
        current_time_ms: u64,
    ): u64 {
        if (current_time_ms < start_time_ms) return 0;
        if (current_time_ms >= end_time_ms) return total_amount;

        let duration = end_time_ms - start_time_ms;
        let elapsed = current_time_ms - start_time_ms;
        let rounded = (elapsed / interval_ms) * interval_ms;
        ((((total_amount as u128) * (rounded as u128)) / (duration as u128)) as u64)
    }

    public fun status<T>(schedule: &VestingScheduleV2<T>): u8 { schedule.status }
    public fun balance_value<T>(schedule: &VestingScheduleV2<T>): u64 {
        balance::value(&schedule.balance)
    }
    public fun released_amount<T>(schedule: &VestingScheduleV2<T>): u64 {
        schedule.released_amount
    }
    public fun beneficiary<T>(schedule: &VestingScheduleV2<T>): address {
        schedule.beneficiary
    }
    public fun start_time_ms<T>(schedule: &VestingScheduleV2<T>): u64 {
        schedule.start_time_ms
    }
    public fun end_time_ms<T>(schedule: &VestingScheduleV2<T>): u64 {
        schedule.end_time_ms
    }

    fun validate_common<T>(
        coins: &Coin<T>,
        beneficiary: address,
        duration_ms: u64,
        interval_ms: u64,
        client_reference: &vector<u8>,
    ) {
        assert!(coin::value(coins) > 0, E_INVALID_AMOUNT);
        assert!(beneficiary != @0x0, E_INVALID_ADDRESS);
        assert!(duration_ms > 0, E_INVALID_TIMELINE);
        assert!(interval_ms > 0 && interval_ms <= duration_ms, E_INVALID_TIMELINE);
        assert!(
            vector::length(client_reference) > 0
                && vector::length(client_reference) <= MAX_CLIENT_REFERENCE_BYTES,
            E_INVALID_TRIGGER,
        );
    }

    fun validate_trigger(
        trigger_kind: u8,
        comparison: u8,
        target_value: u64,
        trigger_config_hash: &vector<u8>,
        validation_window_ms: u64,
        max_sample_gap_ms: u64,
        max_observation_age_ms: u64,
        oracle_pubkeys: &vector<vector<u8>>,
        oracle_threshold: u8,
        trigger_deadline_ms: u64,
        fallback_policy: u8,
        now_ms: u64,
    ) {
        assert!(trigger_kind != TRIGGER_TIME && valid_trigger_kind(trigger_kind), E_INVALID_TRIGGER);
        assert!(comparison == COMPARISON_GTE || comparison == COMPARISON_LTE, E_INVALID_TRIGGER);
        assert!(target_value > 0, E_INVALID_TRIGGER);
        assert!(vector::length(trigger_config_hash) == 32, E_INVALID_TRIGGER);
        assert!(max_sample_gap_ms > 0, E_INVALID_TRIGGER);
        assert!(max_observation_age_ms > 0, E_INVALID_TRIGGER);
        assert!(
            validation_window_ms == 0 || max_sample_gap_ms <= validation_window_ms,
            E_INVALID_TRIGGER,
        );
        assert!(
            fallback_policy == FALLBACK_REFUND_CREATOR
                || fallback_policy == FALLBACK_ACTIVATE,
            E_INVALID_TRIGGER,
        );
        assert!(
            trigger_deadline_ms == 0
                || (trigger_deadline_ms > now_ms
                    && trigger_deadline_ms - now_ms >= validation_window_ms),
            E_INVALID_TRIGGER,
        );
        validate_oracle_policy(oracle_pubkeys, oracle_threshold);
    }

    fun valid_trigger_kind(kind: u8): bool {
        kind == TRIGGER_MARKET_CAP_USD
            || kind == TRIGGER_FDV_USD
            || kind == TRIGGER_PRICE_USD_E8
            || kind == TRIGGER_LIQUIDITY_USD
            || kind == TRIGGER_VOLUME_24H_USD
            || kind == TRIGGER_HOLDER_COUNT
            || kind == TRIGGER_CUSTOM
    }

    fun validate_oracle_policy(pubkeys: &vector<vector<u8>>, threshold: u8) {
        let count = vector::length(pubkeys);
        assert!(count > 0 && count <= MAX_ORACLES, E_INVALID_ORACLE_POLICY);
        assert!((threshold as u64) > 0 && (threshold as u64) <= count, E_INVALID_ORACLE_POLICY);

        let mut i = 0;
        while (i < count) {
            assert!(vector::length(vector::borrow(pubkeys, i)) == 32, E_INVALID_ORACLE_POLICY);
            let mut j = i + 1;
            while (j < count) {
                assert!(
                    vector::borrow(pubkeys, i) != vector::borrow(pubkeys, j),
                    E_INVALID_ORACLE_POLICY,
                );
                j = j + 1;
            };
            i = i + 1;
        };
    }

    fun verify_oracle_threshold(
        pubkeys: &vector<vector<u8>>,
        threshold: u8,
        signer_indices: &vector<u8>,
        signatures: &vector<vector<u8>>,
        message: &vector<u8>,
    ) {
        let count = vector::length(signatures);
        assert!(count == vector::length(signer_indices), E_INVALID_SIGNATURE);
        assert!(count >= (threshold as u64), E_INVALID_SIGNATURE);

        let mut i = 0;
        let mut previous_index = 0;
        while (i < count) {
            let index = (*vector::borrow(signer_indices, i) as u64);
            assert!(index < vector::length(pubkeys), E_INVALID_SIGNATURE);
            if (i > 0) assert!(index > previous_index, E_INVALID_SIGNATURE);

            let signature = vector::borrow(signatures, i);
            let pubkey = vector::borrow(pubkeys, index);
            assert!(vector::length(signature) == 64, E_INVALID_SIGNATURE);
            assert!(
                sui::ed25519::ed25519_verify(signature, pubkey, message),
                E_INVALID_SIGNATURE,
            );
            previous_index = index;
            i = i + 1;
        };
    }

    fun condition_is_met(comparison: u8, observed: u64, target: u64): bool {
        if (comparison == COMPARISON_GTE) observed >= target else observed <= target
    }

    fun activate<T>(schedule: &mut VestingScheduleV2<T>, now_ms: u64) {
        let start = if (now_ms > schedule.not_before_ms) now_ms else schedule.not_before_ms;
        schedule.start_time_ms = start;
        schedule.end_time_ms = start + schedule.vesting_duration_ms;
        schedule.status = STATUS_ACTIVE;

        sui::event::emit(VestingActivatedV2 {
            schedule_id: object::uid_to_address(&schedule.id),
            activated_at_ms: now_ms,
            start_time_ms: schedule.start_time_ms,
            end_time_ms: schedule.end_time_ms,
        });
    }

    fun reassign<T>(schedule: &mut VestingScheduleV2<T>, new_beneficiary: address) {
        assert!(new_beneficiary != @0x0, E_INVALID_ADDRESS);
        assert!(
            schedule.status == STATUS_PENDING || schedule.status == STATUS_ACTIVE,
            E_INVALID_STATE,
        );
        let old_beneficiary = schedule.beneficiary;
        schedule.beneficiary = new_beneficiary;
        sui::event::emit(BeneficiaryReassignedV2 {
            schedule_id: object::uid_to_address(&schedule.id),
            old_beneficiary,
            new_beneficiary,
        });
    }

    fun emit_created<T>(schedule: &VestingScheduleV2<T>) {
        sui::event::emit(ScheduleCreatedV2 {
            schedule_id: object::uid_to_address(&schedule.id),
            creator: schedule.creator,
            beneficiary: schedule.beneficiary,
            total_amount: schedule.total_amount,
            trigger_kind: schedule.trigger_kind,
            target_value: schedule.target_value,
            client_reference: schedule.client_reference,
        });
    }

    fun transfer_amount<T>(
        source: &mut Balance<T>,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        let part = balance::split(source, amount);
        transfer::public_transfer(coin::from_balance(part, ctx), recipient);
    }

    fun transfer_all<T>(source: &mut Balance<T>, recipient: address, ctx: &mut TxContext) {
        let amount = balance::value(source);
        if (amount > 0) transfer_amount(source, amount, recipient, ctx);
    }
}
