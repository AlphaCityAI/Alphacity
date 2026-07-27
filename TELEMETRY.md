# Alpha City telemetry

Alpha City ships a small, vendor-neutral event client in `shared/telemetry.js`.
It is disabled unless a collector URL is configured during the production
build.

## Privacy contract

The client:

- uses no cookies, local storage, session storage, or persistent identifier;
- respects Global Privacy Control and Do Not Track;
- never sends wallet addresses, transaction digests, balances, referrers,
  query strings, user-agent strings, or free-form error messages;
- sends only allowlisted event names and short, sanitized properties;
- omits credentials and referrer information from collector requests; and
- limits collection to 40 events per page load.

The collector should aggregate events, avoid retaining source IP addresses, and
apply a short retention period. It must accept credential-free CORS `POST`
requests with a JSON body from `https://alphacity.tech`.

## Deployment configuration

Set these GitHub Actions repository variables:

- `ALPHACITY_TELEMETRY_ENDPOINT`: an HTTPS JSON event collector URL.
- `ALPHACITY_TELEMETRY_SITE_ID`: optional site identifier; defaults to
  `alphacity.tech`.

The normal production build runs `scripts/build-telemetry-config.js` and writes
the public, secret-free runtime configuration to
`shared/telemetry-config.js`. If the endpoint variable is absent, the tracker
remains disabled and the site continues normally.

## Collector payload

```json
{
  "schema": 1,
  "siteId": "alphacity.tech",
  "event": "tool_open",
  "page": "/tools/",
  "timestamp": 1785052800000,
  "properties": {
    "tool": "alchemy",
    "access": "free"
  }
}
```

Supported events cover page views, primary calls to action, tool launches,
wallet connection states, CITY gate results, transaction-signing outcomes, and
sanitized client errors.

Sluice intentionally does not load the collector client because its page uses a
strict, explicit `connect-src` Content Security Policy. Telemetry must not
weaken that security boundary; Sluice can be added later only when the collector
origin is fixed and explicitly approved in the policy.
