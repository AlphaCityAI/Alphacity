#[test_only]
module sluice::sluice_v2_tests {
    use sluice::sluice_v2;
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::test_scenario;

    const CREATOR: address = @0xCAFE;
    const BENEFICIARY: address = @0xBEEF;
    const KEEPER: address = @0xD00D;

    #[test]
    fun interval_vesting_rounds_down_and_completes() {
        assert!(sluice_v2::calculate_vested_amount(100_000, 1_000, 11_000, 1_000, 500) == 0, 0);
        assert!(sluice_v2::calculate_vested_amount(100_000, 1_000, 11_000, 1_000, 6_500) == 50_000, 1);
        assert!(sluice_v2::calculate_vested_amount(100_000, 1_000, 11_000, 1_000, 11_000) == 100_000, 2);
    }

    #[test]
    fun cancellation_pays_vested_tokens_and_refunds_only_unvested_tokens() {
        let mut scenario = test_scenario::begin(CREATOR);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let clock = clock::create_for_testing(ctx);
            let tokens = coin::mint_for_testing<SUI>(100_000, ctx);
            sluice_v2::create_time_schedule(
                tokens,
                BENEFICIARY,
                0,
                10_000,
                1_000,
                true,
                b"cancel-safety",
                ctx,
            );
            clock::share_for_testing(clock);
        };

        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let mut schedule = test_scenario::take_shared<sluice_v2::VestingScheduleV2<SUI>>(&scenario);
            let mut clock = test_scenario::take_shared<Clock>(&scenario);
            clock::increment_for_testing(&mut clock, 5_000);
            sluice_v2::cancel_schedule(
                &mut schedule,
                &clock,
                test_scenario::ctx(&mut scenario),
            );
            assert!(sluice_v2::status(&schedule) == 2, 0);
            assert!(sluice_v2::released_amount(&schedule) == 50_000, 1);
            assert!(sluice_v2::balance_value(&schedule) == 0, 2);
            test_scenario::return_shared(schedule);
            test_scenario::return_shared(clock);
        };

        test_scenario::next_tx(&mut scenario, BENEFICIARY);
        {
            let vested = test_scenario::take_from_sender<Coin<SUI>>(&scenario);
            assert!(coin::burn_for_testing(vested) == 50_000, 3);
        };

        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let refund = test_scenario::take_from_sender<Coin<SUI>>(&scenario);
            assert!(coin::burn_for_testing(refund) == 50_000, 4);
        };
        test_scenario::end(scenario);
    }

    #[test]
    fun permissionless_claim_always_pays_the_beneficiary() {
        let mut scenario = test_scenario::begin(CREATOR);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let clock = clock::create_for_testing(ctx);
            let tokens = coin::mint_for_testing<SUI>(100_000, ctx);
            sluice_v2::create_time_schedule(
                tokens,
                BENEFICIARY,
                0,
                1_000,
                100,
                false,
                b"keeper-claim",
                ctx,
            );
            clock::share_for_testing(clock);
        };

        test_scenario::next_tx(&mut scenario, KEEPER);
        {
            let mut schedule = test_scenario::take_shared<sluice_v2::VestingScheduleV2<SUI>>(&scenario);
            let mut clock = test_scenario::take_shared<Clock>(&scenario);
            clock::increment_for_testing(&mut clock, 1_000);
            sluice_v2::claim_vested(
                &mut schedule,
                &clock,
                test_scenario::ctx(&mut scenario),
            );
            assert!(sluice_v2::status(&schedule) == 3, 0);
            assert!(sluice_v2::released_amount(&schedule) == 100_000, 1);
            assert!(sluice_v2::balance_value(&schedule) == 0, 2);
            test_scenario::return_shared(schedule);
            test_scenario::return_shared(clock);
        };

        test_scenario::next_tx(&mut scenario, BENEFICIARY);
        {
            let claimed = test_scenario::take_from_sender<Coin<SUI>>(&scenario);
            assert!(coin::burn_for_testing(claimed) == 100_000, 3);
        };
        test_scenario::end(scenario);
    }

    #[test]
    fun trigger_requires_continuity_and_resets_after_sample_gap() {
        let mut scenario = test_scenario::begin(CREATOR);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let clock = clock::create_for_testing(ctx);
            let tokens = coin::mint_for_testing<SUI>(100_000, ctx);
            sluice_v2::create_triggered_schedule(
                tokens,
                BENEFICIARY,
                0,
                10_000,
                1_000,
                1,
                0,
                1_000_000,
                bytes(32, 7),
                25_000,
                1_000,
                600,
                600,
                vector[bytes(32, 9)],
                1,
                20_000,
                0,
                true,
                b"continuity",
                &clock,
                ctx,
            );
            clock::share_for_testing(clock);
        };

        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let mut schedule = test_scenario::take_shared<sluice_v2::VestingScheduleV2<SUI>>(&scenario);

            sluice_v2::submit_observation_for_testing(&mut schedule, 1_100_000, 100, 100);
            assert!(sluice_v2::status(&schedule) == 0, 0);

            // The 700ms gap exceeds max_sample_gap_ms and restarts validation.
            sluice_v2::submit_observation_for_testing(&mut schedule, 1_100_000, 800, 800);
            sluice_v2::submit_observation_for_testing(&mut schedule, 1_100_000, 1_300, 1_300);
            assert!(sluice_v2::status(&schedule) == 0, 1);

            // Two fresh, in-gap samples now span the full 1,000ms window.
            sluice_v2::submit_observation_for_testing(&mut schedule, 1_100_000, 1_800, 1_800);
            assert!(sluice_v2::status(&schedule) == 1, 2);
            assert!(sluice_v2::start_time_ms(&schedule) == 1_800, 3);
            assert!(sluice_v2::end_time_ms(&schedule) == 11_800, 4);
            test_scenario::return_shared(schedule);
        };
        test_scenario::end(scenario);
    }

    #[test]
    fun expired_trigger_refunds_creator_when_configured() {
        let mut scenario = test_scenario::begin(CREATOR);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let clock = clock::create_for_testing(ctx);
            let tokens = coin::mint_for_testing<SUI>(42_000, ctx);
            sluice_v2::create_triggered_schedule(
                tokens,
                BENEFICIARY,
                0,
                10_000,
                1_000,
                1,
                0,
                1_000_000,
                bytes(32, 7),
                25_000,
                1_000,
                600,
                600,
                vector[bytes(32, 9)],
                1,
                5_000,
                0,
                true,
                b"expiry-refund",
                &clock,
                ctx,
            );
            clock::share_for_testing(clock);
        };

        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let mut schedule = test_scenario::take_shared<sluice_v2::VestingScheduleV2<SUI>>(&scenario);
            let mut clock = test_scenario::take_shared<Clock>(&scenario);
            clock::increment_for_testing(&mut clock, 5_000);
            sluice_v2::resolve_expired_trigger(
                &mut schedule,
                &clock,
                test_scenario::ctx(&mut scenario),
            );
            assert!(sluice_v2::status(&schedule) == 2, 0);
            assert!(sluice_v2::balance_value(&schedule) == 0, 1);
            test_scenario::return_shared(schedule);
            test_scenario::return_shared(clock);
        };

        test_scenario::next_tx(&mut scenario, CREATOR);
        {
            let refund = test_scenario::take_from_sender<Coin<SUI>>(&scenario);
            assert!(coin::burn_for_testing(refund) == 42_000, 2);
        };
        test_scenario::end(scenario);
    }

    #[test]
    fun failed_lte_observation_resets_the_continuity_window() {
        let mut scenario = test_scenario::begin(CREATOR);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let clock = clock::create_for_testing(ctx);
            let tokens = coin::mint_for_testing<SUI>(10_000, ctx);
            sluice_v2::create_triggered_schedule(
                tokens,
                BENEFICIARY,
                0,
                10_000,
                1_000,
                3,
                1,
                100,
                bytes(32, 7),
                0,
                1_000,
                600,
                600,
                vector[bytes(32, 9)],
                1,
                20_000,
                0,
                false,
                b"lte-reset",
                &clock,
                ctx,
            );
            clock::share_for_testing(clock);
        };

        test_scenario::next_tx(&mut scenario, KEEPER);
        {
            let mut schedule = test_scenario::take_shared<sluice_v2::VestingScheduleV2<SUI>>(&scenario);
            sluice_v2::submit_observation_for_testing(&mut schedule, 90, 100, 100);
            // 110 fails an at-or-below-100 condition and clears continuity.
            sluice_v2::submit_observation_for_testing(&mut schedule, 110, 500, 500);
            sluice_v2::submit_observation_for_testing(&mut schedule, 90, 600, 600);
            sluice_v2::submit_observation_for_testing(&mut schedule, 90, 1_200, 1_200);
            assert!(sluice_v2::status(&schedule) == 0, 0);
            sluice_v2::submit_observation_for_testing(&mut schedule, 90, 1_600, 1_600);
            assert!(sluice_v2::status(&schedule) == 1, 1);
            test_scenario::return_shared(schedule);
        };
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 12)]
    fun observations_cannot_activate_after_the_trigger_deadline() {
        let mut scenario = test_scenario::begin(CREATOR);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let clock = clock::create_for_testing(ctx);
            let tokens = coin::mint_for_testing<SUI>(10_000, ctx);
            sluice_v2::create_triggered_schedule(
                tokens,
                BENEFICIARY,
                0,
                10_000,
                1_000,
                1,
                0,
                1,
                bytes(32, 7),
                0,
                0,
                600,
                600,
                vector[bytes(32, 9)],
                1,
                1_000,
                0,
                false,
                b"deadline-finality",
                &clock,
                ctx,
            );
            clock::share_for_testing(clock);
        };

        test_scenario::next_tx(&mut scenario, KEEPER);
        {
            let mut schedule = test_scenario::take_shared<sluice_v2::VestingScheduleV2<SUI>>(&scenario);
            sluice_v2::submit_observation_for_testing(&mut schedule, 2, 1_000, 1_000);
            test_scenario::return_shared(schedule);
        };
        test_scenario::end(scenario);
    }

    fun bytes(length: u64, value: u8): vector<u8> {
        let mut result = vector[];
        let mut i = 0;
        while (i < length) {
            vector::push_back(&mut result, value);
            i = i + 1;
        };
        result
    }
}
