# Publishing AlphaCity collection media to Cloudflare R2

This workflow is for AlphaCity's own collection. It keeps the initial launch inexpensive: the public site can use Cloudflare's shared services and Sui's public fullnode endpoint, while R2 stores the collection media. It does not require a paid Sui RPC, a partner account system, or a hosted launchpad database.

Google Drive remains useful as an offline backup or as the local synced folder from which files are copied. Do not put Google Drive sharing links in NFT metadata. Their permissions and response behavior can change, and many clients receive a viewer page rather than the image bytes. The publisher rejects Drive and Google-hosted sharing URLs as the public media base URL.

## What the tool does

`scripts/launchpad-r2-publish.cjs` validates the same `project.json`, `metadata.csv`, and `media/` inputs used by the launch preparer. It publishes only media referenced by the CSV plus the configured hero image. Unused files stay local.

Public media is limited to PNG, JPEG (`.jpg` or `.jpeg`), WEBP, and GIF. Before hashing or staging, the publisher reads each referenced file's magic bytes and verifies that they match its extension. Renaming another file type to `.png` therefore fails. SVG and other active/vector formats are rejected even though an earlier shared intake may recognize their extension; use a raster export instead. This gate reduces content-type confusion and keeps executable SVG content off the public NFT media origin.

The tool computes SHA-256 for every selected file and derives a deterministic release ID from:

- the bucket, key prefix, and public base URL;
- the normalized collection ID, collection name, and selected hero; and
- every filename, size, content type, and content hash.

Objects use this layout:

```text
collections/<collection-id>/releases/<64-character-release-id>/
├── manifest.json
└── media/
    ├── hero.png
    ├── 001.png
    └── ...
```

The original filenames stay below one content-addressed release directory. This matters because `launchpad-project.cjs` builds each NFT URL by appending its CSV filename to one `--media-base-url`. The publisher requires references to match the exact filename casing on disk because R2 keys are case-sensitive.

By default, the command is a local dry run. It creates:

```text
<staging-directory>/
├── r2-media-manifest.json
├── r2-upload-plan.json
└── objects/<exact R2 object keys...>
```

It does not provision Cloudflare resources, make a network request, publish a Move package, use a private key, or sign a Sui transaction.

## One-time Cloudflare setup

Create an R2 bucket in the Cloudflare dashboard and attach a public custom domain such as `media.alphacity.tech`. The script intentionally does not make either infrastructure change. Keep the bucket name and public base URL separate: the bucket might be `alphacity-media`, while its public URL is `https://media.alphacity.tech`. For a direct R2 custom-domain mapping, the public base must be the HTTPS origin with no path, query, fragment, or credentials.

Install Wrangler 4. The npm package exposes `bin/wrangler.js`; the publisher launches that file through the current Node binary with `shell: false`. It deliberately rejects Windows `.cmd` and `.bat` wrappers so collection filenames never pass through command-shell parsing.

On Windows PowerShell, record and test the JavaScript entrypoint:

```powershell
npm install --global wrangler@4
$wranglerPackageRoot = npm root --global
$env:ALPHACITY_WRANGLER_JS = Join-Path $wranglerPackageRoot 'wrangler\bin\wrangler.js'
node $env:ALPHACITY_WRANGLER_JS --version
node $env:ALPHACITY_WRANGLER_JS login
```

On macOS or Linux:

```bash
npm install --global wrangler@4
export ALPHACITY_WRANGLER_JS="$(npm root --global)/wrangler/bin/wrangler.js"
node "$ALPHACITY_WRANGLER_JS" --version
node "$ALPHACITY_WRANGLER_JS" login
```

Wrangler can instead use a narrowly scoped Cloudflare API token through its documented environment variable. Never pass an API token, access key, secret, password, or account ID as a publisher flag. The tool rejects credential-looking flags and suppresses Wrangler output on failures. See Cloudflare's [Wrangler package](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/package.json) and [R2 Wrangler command reference](https://developers.cloudflare.com/workers/wrangler/commands/r2/).

R2 storage and request usage are the only additional runtime costs in this flow. A collection of ordinary images will often remain within Cloudflare's included allowance; confirm the current allowance and rates in the Cloudflare dashboard before launch. Public Sui fullnode access remains the default, so this workflow adds no paid RPC requirement.

## Stage a release

The source directory must already have the launchpad intake shape:

```text
my-collection/
├── project.json
├── metadata.csv
└── media/
```

Run a dry run first:

```powershell
$env:ALPHACITY_R2_BUCKET = 'alphacity-media'
$env:ALPHACITY_MEDIA_BASE_URL = 'https://media.alphacity.tech'
node scripts/launchpad-r2-publish.cjs C:\path\to\my-collection
```

The equivalent explicit command is:

```powershell
node scripts/launchpad-r2-publish.cjs C:\path\to\my-collection `
  --bucket alphacity-media `
  --public-base-url https://media.alphacity.tech `
  --prefix collections `
  --out C:\path\to\r2-staging
```

A prepared directory can also be used. When it is the project's usual `prepared/` child, the tool locates the parent source automatically. If preparation output is elsewhere, point back to the source explicitly:

```powershell
node scripts/launchpad-r2-publish.cjs C:\path\to\prepared-output `
  --project-dir C:\path\to\my-collection `
  --bucket alphacity-media `
  --public-base-url https://media.alphacity.tech
```

The prepared collection ID, supply, and complete item inventory must exactly match the newly validated source. Media files are always read from the source project's `media/` folder. Prepare a fresh handoff after publishing media so it records the final release URL.

Review `r2-media-manifest.json` and `r2-upload-plan.json`. The manifest contains the exact public URL, content hash, byte count, and MIME type for every object. The plan contains only relative staging paths; it does not record local absolute paths or credentials.

## Lock the release prefix

Content-addressed keys prevent accidental name reuse inside this tool, but they do not stop a Cloudflare dashboard user or another API client from replacing or deleting an R2 object. A release-prefix bucket lock is required before upload and before any on-chain publication. Cloudflare documents that bucket locks prevent both overwriting and deletion for the selected retention period.

Read the exact bucket and release prefix from the reviewed manifest, add an indefinite rule, and list the rules again:

```powershell
$manifest = Get-Content -Raw C:\path\to\r2-staging\r2-media-manifest.json | ConvertFrom-Json
$releasePrefix = "$($manifest.storage.keyPrefix)/"
$lockName = "alphacity-$($manifest.releaseId.Substring(0, 12))"
node $env:ALPHACITY_WRANGLER_JS r2 bucket lock add $manifest.storage.bucket $lockName $releasePrefix --retention-indefinite
node $env:ALPHACITY_WRANGLER_JS r2 bucket lock list $manifest.storage.bucket
```

Do not add `--force`; review Wrangler's confirmation. In the list output or Cloudflare dashboard, verify that the rule is enabled, uses the exact release prefix including its trailing slash, and has indefinite retention. Stop if any field differs. The publisher does not create or verify this infrastructure rule because changing retention is an account-level operation. Refer to Cloudflare's [bucket-lock guide](https://developers.cloudflare.com/r2/buckets/bucket-locks/) and current [`r2 bucket lock` syntax](https://developers.cloudflare.com/workers/wrangler/commands/r2/#r2-bucket-lock-add).

## Upload and verify

After reviewing the stage, repeat the same command with `--upload`:

```powershell
node scripts/launchpad-r2-publish.cjs C:\path\to\my-collection `
  --bucket alphacity-media `
  --public-base-url https://media.alphacity.tech `
  --wrangler-js $env:ALPHACITY_WRANGLER_JS `
  --upload
```

The uploader starts Node with the Wrangler JavaScript entrypoint and a separate argument array. It uses `shell: false`, four concurrent remote operations by default, and a five-minute timeout for each Wrangler process. `--concurrency` accepts 1 through 8 and `--timeout-ms` accepts 1000 through 900000. For each planned object it performs the equivalent of:

```powershell
node $env:ALPHACITY_WRANGLER_JS r2 object get "alphacity-media/<object-key>" --file "<temporary-file>" --remote
node $env:ALPHACITY_WRANGLER_JS r2 object put "alphacity-media/<object-key>" --file "<staged-file>" --content-type "<mime-type>" --cache-control "public, max-age=31536000, immutable" --remote
node $env:ALPHACITY_WRANGLER_JS r2 object get "alphacity-media/<object-key>" --file "<verification-file>" --remote
```

The first `get` is a remote preflight. The script handles its result as follows:

- Missing object: schedule it for upload.
- Existing object with the expected SHA-256: skip it, which makes a partially completed upload resumable.
- Existing object with different bytes: stop before any new object is uploaded.
- Authentication, network, or ambiguous error: stop before any new object is uploaded.

After each `put`, the final `get` verifies the remote bytes. Wrangler output is not echoed, which prevents an unexpected diagnostic from exposing credentials in CI logs.

Wrangler's object command does not expose an atomic "create only" condition. Do not run two upload commands for the same release concurrently. The required bucket lock closes the overwrite window once an object exists, and the full release hash binds the key to the expected deployment and bytes, but the publisher still treats ambiguous preflight results as fatal.

There is deliberately no `--force` option. If the local stage was edited, the script refuses to reuse it. Create a new stage and release ID instead.

## Connect the uploaded media to the launch

Copy `mediaBaseUrl` from `r2-media-manifest.json`, then prepare or re-prepare the launch with that exact URL:

```powershell
node scripts/launchpad-project.cjs prepare C:\path\to\my-collection `
  --treasury 0xYOUR_TREASURY_ADDRESS `
  --media-base-url https://media.alphacity.tech/collections/our-collection/releases/RELEASE_ID/media `
  --out C:\path\to\fresh-prepared-output
```

Before publishing the contract:

1. Open the manifest URL and several media URLs in an unsigned browser session.
2. Confirm each response is the raw image with the expected content type.
3. Compare at least a sample of downloaded SHA-256 hashes with the manifest.
4. Re-list the bucket locks and confirm the exact release prefix remains locked indefinitely.
5. Confirm the launch bundle uses the same immutable `mediaBaseUrl`.
6. Keep the original media and manifest locally and in Google Drive as a separate backup.

The custom domain and bucket must remain available for as long as the NFTs should render. R2 URLs are durable only while AlphaCity retains the account, bucket, objects, and domain mapping. IPFS pinning can be added later as a second copy without changing this first-party launch workflow.
