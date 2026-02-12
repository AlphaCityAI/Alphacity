# Alpha City Staking (Sui Move)

This package implements a staking pool for `Coin<T>` (for Alpha City, use `T = CITY`).

## Features
- Shared `StakingPool<T>` object with admin controls.
- User-owned `StakePosition<T>` objects (one per stake action).
- Fixed lock periods enforced on-chain:
  - 7 days (1.0x)
  - 30 days (1.5x)
  - 90 days (2.0x)
- Reward accrual based on:
  - principal
  - elapsed time
  - `daily_reward_rate_bps`
  - lock multiplier
- Entry points:
  - `init_pool<T>`
  - `deposit_rewards<T>`
  - `set_daily_reward_rate_bps<T>`
  - `set_paused<T>`
  - `stake<T>`
  - `claim<T>`
  - `unstake<T>`

## Formula
Rewards are computed as:

`principal * elapsed_seconds * daily_rate_bps * multiplier_bps / (86400 * 10000 * 10000)`

All amounts are in the token's smallest unit.

## Build
From this folder:

```bash
sui move build
```

## Deploy (example)

```bash
sui client publish --gas-budget 200000000
```

Save from publish output:
- `PACKAGE_ID`
- shared `StakingPool<CITY>` object id (created by calling `init_pool<CITY>`)

## Initialize pool for CITY
After publish, call:

```bash
sui client call \
  --package <PACKAGE_ID> \
  --module staking \
  --function init_pool \
  --type-args 0x308fa16c7aead43e3a49a4ff2e76205ba2a12697234f4fe80a2da66515284060::city::CITY \
  --args 20 \
  --gas-budget 50000000
```

`20` means `0.20%` daily base reward before multiplier.

## Fund rewards
Admin deposits CITY rewards via `deposit_rewards<CITY>`.

## Frontend wiring
Set these constants in `staking.html`:
- `STAKING_PACKAGE_ID`
- `STAKING_POOL_ID`

The frontend now calls:
- `<PACKAGE_ID>::staking::stake<CITY>(pool, coin, lock_seconds, clock)`

instead of transferring CITY directly to a wallet vault.
