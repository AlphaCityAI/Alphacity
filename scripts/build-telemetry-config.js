'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outputPath = path.join(root, 'shared', 'telemetry-config.js');
const endpoint = String(process.env.ALPHACITY_TELEMETRY_ENDPOINT || '').trim();
const siteId = String(process.env.ALPHACITY_TELEMETRY_SITE_ID || 'alphacity.tech').trim();

if (endpoint) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new Error('ALPHACITY_TELEMETRY_ENDPOINT must be an HTTPS URL without embedded credentials.');
    }
}
if (!/^[a-zA-Z0-9.-]{1,80}$/.test(siteId)) {
    throw new Error('ALPHACITY_TELEMETRY_SITE_ID must contain only letters, digits, dots, or hyphens.');
}

const contents = `(function (root) {
    'use strict';

    root.ALPHA_CITY_TELEMETRY_CONFIG = Object.freeze({
        endpoint: ${JSON.stringify(endpoint)},
        siteId: ${JSON.stringify(siteId)},
    });
})(typeof window !== 'undefined' ? window : globalThis);
`;

fs.writeFileSync(outputPath, contents, 'utf8');
console.log(endpoint
    ? `Telemetry collector configured for ${siteId}.`
    : 'Telemetry collection disabled: ALPHACITY_TELEMETRY_ENDPOINT is not configured.');
