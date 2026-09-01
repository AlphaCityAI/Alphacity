# AlphaCity managed drop template

Each curated project receives a fresh publication of this package, producing a unique NFT type. Package initialization issues a one-time `LaunchCap`; `create_drop` consumes it so only one canonical Drop can issue that type. The separate `Publisher` remains available for Sui Object Display V2 setup.

The Drop records the prepared stage count, unique allowlist-entry count, inventory counts, and project transaction limit. `publish_drop` reads the Sui Clock, rejects already-ended schedules, requires exact setup counts, counts allowlist reachability when proving enough capacity for public supply, and requires the final stage to be public, uncapped, and have no end time. Pause the Drop through its AdminCap when the intended sale is over. Public minting enforces both the per-wallet stage allowance and project `max_per_tx` on-chain.

The package is intentionally non-custodial for primary proceeds: every mint transaction transfers the creator share directly to the configured creator address and the platform share directly to the configured AlphaCity treasury.

`royalty_bps` is embedded as collection/NFT metadata for marketplaces to read. This template does not claim to enforce royalties on unrestricted peer-to-peer transfers.

Use `node scripts/launchpad-project.cjs prepare <project-directory> --treasury <address>` to validate assets and generate a project-specific package plus initialization plan. Publishing remains an explicit multisig or hardware-wallet operation. Before `publish_drop`, either consume the package UpgradeCap with `0x2::package::make_immutable` or transfer it to the reviewed production multisig. Always transfer the mutable DisplayCap and AdminCap to reviewed multisigs and record those authorities in the public configuration; package immutability does not freeze Display metadata or secure pause/reserved-mint authority.

Public item assignment is sequential in uploaded order. Preparation is permitted only for projects that explicitly attest every public item has equivalent mint value; this template does not claim random assignment.

The contract stores exact setup counts and immutable stage/economic fields, but it does not store one canonical digest of every allowlist entry and `ItemData` field. For this first-party release, reconcile the generated transaction plan and confirmed receipts entry by entry before publication. Add an on-chain canonical setup commitment before partner operators are supported.
