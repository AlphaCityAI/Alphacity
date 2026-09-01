# AlphaCity first-party launch workspace

The launchpad initially prepares AlphaCity's own NFT collection. It is a local owner workflow rather than a partner platform: the browser saves a draft, validates collection metadata and media, previews the mint, and exports a reproducible handoff. It does not contain a signing key or cloud credential.

## Components

- `/launchpad/` is the local owner collection builder. Draft fields persist in the browser and exports remain explicit.
- `/launchpad/operator/` is a compatibility route for the earlier operator workspace.
- `/mint/` is the public mint page. Collections in `coming-soon` mode remain non-transactional. Collections in `managed-drop` mode read their shared `Drop` object and build the Sui mint transaction through the universal wallet connector.
- Legacy `/launchpad/?collection=<slug>` public links redirect to `/mint/?collection=<slug>`. Add `mode=edit` only when the owner intentionally needs the builder with a collection query present.
- `shared/launchpad-core.js` is the common deterministic parser, validator, SUI/MIST converter, and bundle generator used by both browser and Node workflows.
- `scripts/launchpad-project.cjs` validates an intake directory and generates a project-specific Move package, public collection config, and ordered transaction plan.
- `scripts/launchpad-r2-publish.cjs` creates a deterministic, immutable R2 media release. Its default is a local dry run; `--upload` is a separate explicit action.
- `contracts/managed_drop_template/` is the fixed starting point for each unique collection package. It has not been established as independently audited.

The checked-in `citizens` registry entry is currently `coming-soon` and has no package or Drop object IDs. Its button must remain non-transactional until a reviewed deployment is recorded; its sample supply, price, and phase copy are not proof of approved launch terms.

## Intake directory

```text
project-directory/
├── project.json
├── metadata.csv
└── media/
    ├── hero.png
    ├── 001.png
    └── 002.png
```

The CSV requires `Name`, `Description`, `File Name`, and `Reserve For Creator`. Trait columns use `attributes[Trait name]`. Filenames must exactly match the case-sensitive R2 object keys. Intake accepts PNG, JPEG, WEBP, and GIF only, and the browser and CLI inspect file signatures instead of trusting extensions. Duplicate/blank headers, unknown reserve tokens, missing media, oversized metadata, invalid addresses or stage windows, u64 payment overflow, and supply/allocation mismatches fail validation.

The current contract assigns public items sequentially in CSV order. It does not randomize or conceal the next item. Every project must explicitly set `"assignmentPolicy": "sequential-equivalent"`, attesting that all public items have equivalent mint value. The browser clears this attestation whenever the CSV or media changes.

```powershell
npm run launchpad:validate -- C:\path\to\project
npm run launchpad:prepare -- C:\path\to\project --treasury 0x... --media-base-url https://permanent.example/collection
```

Preparation refuses to overwrite a non-empty output directory. It never reads a private key and never signs or publishes.

## R2 media workflow

Use [R2_PUBLISHING.md](./R2_PUBLISHING.md) for the complete procedure. The publisher validates the same intake directory and stages a content-hashed release locally by default:

```powershell
node scripts/launchpad-r2-publish.cjs C:\path\to\project `
  --bucket alphacity-media `
  --public-base-url https://media.alphacity.tech
```

Review `r2-media-manifest.json` and `r2-upload-plan.json`. Only then repeat the identical command with `--upload`. The upload preflights existing objects, refuses conflicting bytes, resumes byte-identical partial releases, and verifies uploaded bytes through Wrangler. It does not create the bucket or custom domain. Browser code never receives R2 credentials.

Copy the manifest's release-specific `mediaBaseUrl` into the builder/preparation command. The base URL must use HTTPS and cannot contain credentials, a query, or a fragment; Google-hosted URLs are rejected. Verify the manifest and representative raw image URLs from an unsigned browser session before any on-chain setup. The builder records this external release gate but cannot verify bucket controls. Google Drive/local storage remain independent source backups, not public NFT URLs.

## Publication checklist

1. Review project rights, payout address, disclosures, hosted assets, and metadata.
2. Run the R2 publisher in its default dry-run mode, review the immutable release manifest, explicitly upload, and verify every generated URL and representative hash.
3. Build and test the generated Move package using the repository-pinned Sui framework.
4. Publish with an AlphaCity multisig or hardware wallet. Do not paste a private key into the site, CLI arguments, source tree, or support chat.
5. Create Object Display V2 metadata, then consume the package's one-time `LaunchCap` to create its single canonical shared Drop. Add stages, allowlists, and inventory using the generated transaction plan.
6. Reconcile every ordered item/media URL and every allowlist wallet/limit against the generated transaction plan and confirmed receipts, then reconcile the Drop's loaded stage, unique allowlist, public-item, and reserved-item counts against the deployment manifest. The contract rejects publication unless counts are exact, no stage has already ended, reachable public/allowlist capacity covers supply, and the final stage is a permanent uncapped public fallback. Move does not yet store one canonical content hash for the item and allowlist payloads, so same-count substitutions require this operator review to catch.
7. Dry-run representative public and allowlist mints. Verify direct creator proceeds, the configured 0% first-party platform fee, on-chain transaction/wallet limits, reserved minting, pause behavior, and explorer display.
8. Complete the capability release gate before public minting: consume the UpgradeCap with `0x2::package::make_immutable`, or transfer it to the reviewed production multisig. Always transfer both the mutable DisplayCap and AdminCap to reviewed multisigs. Record their object IDs and the release transaction digest, verify current ownership on-chain, and disclose those authorities in the live config. Package immutability alone does not freeze Display metadata or secure pause/reserved-mint authority. The current client trusts this reviewed config; it does not independently prove capability deletion or ownership, so keep the registry entry `coming-soon` until the evidence is reviewed.
9. Run `publish_drop` only after the release gate and final review; it permanently locks stages and inventory.
10. Put the package and Drop IDs, deployment manifest, and upgrade policy into `collection.json`, add it to `collections/index.json`, and run the full build and test suite.

## Contract boundaries

- Primary mint proceeds are non-custodial: the contract applies the configured split directly in the mint transaction. The first-party builder fixes the AlphaCity platform fee at 0%, so the owner payout receives the sale proceeds apart from gas paid by the buyer.
- Package initialization issues one `LaunchCap`; `create_drop` consumes it, so the package cannot create a second collection shell. The `Publisher` remains separate for Object Display setup.
- The AdminCap is bound to the canonical Drop and controls setup, pause state, and reserved mints. Hold it in a multisig for production.
- Item metadata and mint rules lock at `publish_drop`, while package code remains upgradeable until the UpgradeCap gate is completed. Display metadata remains mutable through the separate DisplayCap, which must be secured in the production multisig.
- The public client compares the Drop's immutable creator, treasury, fee, royalty, supply, transaction limit, and expected setup counts with the checked-in deployment manifest. A mismatch disables minting. Allowlist reads fail closed, and a returned transaction digest is shown as submitted until confirmation succeeds.
- The contract commits stage/economic fields and exact setup counts, but it does not commit all item/media and allowlist payloads as one on-chain digest. The first-party release therefore requires artifact-to-receipt reconciliation. Add a canonical BCS content commitment before partner operators are supported.
- The last configured stage must be public, uncapped, and have no end time. Use the AdminCap pause control to close the sale operationally after the intended window.
- `royalty_bps` is NFT metadata. This template does not claim to enforce royalties on unrestricted peer-to-peer transfers.
- Delayed reveal, gas sponsorship, escrowed proceeds, arbitrary payment coins, and permissionless creator publishing are intentionally outside this first draft.

The buyer client starts with supported public Sui gRPC/GraphQL endpoints. Keep endpoint selection configurable, poll conservatively, and rehearse expected load. A paid RPC is a contingency for observed reliability or rate-limit problems, not a phase-1 requirement.
