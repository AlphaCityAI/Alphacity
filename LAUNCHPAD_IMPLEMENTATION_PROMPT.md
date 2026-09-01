# Reusable implementation prompt — AlphaCity first-party mint

Use this prompt for the next implementation milestone after reviewing `LAUNCHPAD_OVERHAUL_PLAN.md` and `launchpad/R2_PUBLISHING.md`. It is an engineering brief. It does not authorize paid provisioning, DNS changes, mainnet publication, or blockchain transactions.

---

Continue the AlphaCity NFT mint implementation as a lean, owner-only workflow for AlphaCity's own collection. The supplied third-party screenshots are UX references only. Do not copy their artwork, legal terms, sample values, fees, royalty claims, or claims that published stages remain editable.

Preserve these route roles:

- `alphacity.tech/launchpad/` is the local owner collection builder. It is not a hosted partner dashboard and does not claim authentication.
- `alphacity.tech/mint/` is the public buyer page; `?collection=<slug>` is the stable collection URL.
- Legacy `/launchpad/?collection=<slug>` public links redirect to `/mint/?collection=<slug>`. `mode=edit` marks an intentional builder URL.
- `/launchpad/operator/` remains a compatibility route for the earlier intake workspace.
- `/launchpad/collections/` remains the static public registry/config source until a reviewed migration replaces it.

The checked-in Citizens collection is `coming-soon` and has no deployed package or Drop IDs. Preserve that state. Its mint button must remain non-transactional, and unknown collection slugs must show an explicit error rather than silently selecting Citizens. Do not treat the sample Citizens supply, price, phases, or copy as approved mainnet terms.

The six-step `/launchpad/` builder covers Collection, Items, Mint phases, Payouts and royalties, Review, and Prepare. Keep its phase-1 boundary explicit:

1. Save structured draft fields and allowlists in IndexedDB with a file-free localStorage fallback. Show saving, saved, and error state. Local CSV/media file contents must not be stored in localStorage; ask the owner to reselect them after a reload.
2. Validate intended supply, required CSV columns, exact media filename matching, duplicate/missing/unsupported files, reserves, trait rows, file limits, nonzero Sui payout addresses, exact integer MIST/basis-point values, non-overlapping phases, allocations, and normalized/deduplicated allowlists through `window.AlphaCityLaunchpadCore`.
3. Keep the first-party platform fee fixed at 0%. Treat royalty percentage as advisory metadata unless a separate reviewed Kiosk/transfer-policy design is implemented. Do not imply universal royalty enforcement.
4. Use exact UTC timestamps in the exported schema while showing local date/time in the editor. Clearly distinguish per-transaction limits from the contract's per-phase wallet limits.
5. Render a non-transactional public mint preview from the draft. The preview cannot connect a wallet, sign, or broadcast.
6. Export an editable project and a validated prepared handoff. The builder does not upload to R2, publish a Move package, hold credentials, or perform a mainnet action.

Use the low-cost media path already documented and implemented by `scripts/launchpad-r2-publish.cjs`:

- Google Drive and local storage are source backups, not NFT media URLs.
- The browser selects and validates files but never receives an R2 token.
- The local publisher computes SHA-256 hashes, derives an immutable release directory, and writes `r2-media-manifest.json` plus `r2-upload-plan.json`.
- Dry run is the default. Review the stage before repeating the same command with `--upload`.
- The upload must preflight remote objects, skip byte-identical objects, stop on conflicting bytes or ambiguous errors, and verify bytes after each upload. Do not add a force-overwrite path or run multiple publisher processes for one release; keep any within-process concurrency bounded.
- Copy the manifest's release-specific `mediaBaseUrl` into launch preparation. Verify the public manifest and representative raw media responses and hashes before on-chain setup.
- R2, its custom media domain, and the independent backup must remain available for as long as the NFTs should render.

The public `/mint/` client must use the static registry for presentation and the chain as authority whenever a collection is deployed. Reuse the shared wallet connector and supported Sui gRPC/GraphQL compatibility layer. Start with public Sui endpoints, conservative visible-page refresh, and pre-sign rechecks. Keep runtime endpoint selection replaceable so a paid provider remains an optional response to measured rate limits or reliability problems; do not add a dedicated RPC merely because one might be useful later.

For a `coming-soon` collection, render its information and schedule copy but do not construct a transaction. For a reviewed `managed-drop` collection, verify the configured network, package, canonical Drop, and current on-chain state before enabling mint. Show confirmed supply/rules, current phase and countdown, wallet eligibility and remaining allowance, quantity, exact SUI total, gas estimate, and receipt links. Handle wrong network, insufficient balance, sold out, paused, phase changes, stale reads, wallet cancellation, failed execution, and another buyer minting first. Never report success before chain confirmation.

Use `scripts/launchpad-project.cjs` and the fixed managed-drop template for reproducible preparation. Pin dependencies and reject arbitrary build commands. The preparation and R2 tools never accept private keys. Package publication, Drop creation, inventory/stage loading, `publish_drop`, pause/resume, and reserved distribution remain explicit hardware-wallet or multisig review-and-sign operations outside the builder.

Before production, independently review the exact Move release and its deployment evidence. The current template consumes a one-time LaunchCap, enforces collection-specific transaction caps, and checks stage/item/allowlist counts and reachability. It does not yet store a canonical on-chain digest of every allowlist entry and item/media field, and the public client does not independently prove UpgradeCap deletion or live UpgradeCap/AdminCap/DisplayCap ownership. For the first-party release, reconcile the generated plan against every confirmed setup receipt, record capability object IDs and the release digest, verify custody on-chain, and keep the registry entry `coming-soon` until that gate is reviewed. Add the canonical setup commitment and automated capability proof before partner operators are supported. Benchmark realistic inventory and allowlists: the current 50-item batching model implies roughly 200 inventory transactions for 10,000 items before other setup. Do not claim one-click publication, random allocation, editable published stages, enforceable royalties, or supported scale without implementing and measuring those properties.

Work in reviewable milestones:

1. Finish and test the local owner builder, route migration, and public preview.
2. Exercise the R2 publisher's dry-run, explicit upload, resume, conflict, and verification behavior against a staging bucket/custom domain.
3. Rehearse the fixed package and all setup/mint/admin transactions on Sui testnet using public endpoints; capture gas, transaction count, object IDs, capability custody, and failure recovery.
4. Run concurrent buyer, wallet, mobile, stale-state, and endpoint-failure tests, including a documented RPC fallback switch.
5. Obtain independent contract review/remediation, stage the hosting migration, and present exact costs, addresses, immutable terms, and remaining risks for approval before any mainnet or DNS action.
6. Add partner onboarding only as a later version. At that point introduce organizations, server-verified wallet challenges, roles, ownership checks, cloud drafts/uploads, quotas, moderation, billing, and audit history. Do not retrofit those claims onto the local first-party builder.

Preserve unrelated repository work and existing deployments. Add meaningful behavioral and integration tests rather than relying only on source-text assertions. Never request, log, export, or store a seed phrase or private key. Report changed files, verification, limitations, and the next concrete gate.
