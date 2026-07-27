'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'shared', 'telemetry.js'), 'utf8');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function loadTelemetry({ gpc = false, dnt = '0' } = {}) {
    const requests = [];
    const localEvents = [];
    const windowListeners = new Map();
    const documentListeners = new Map();
    class TestCustomEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        }
    }
    const document = {
        readyState: 'complete',
        addEventListener(type, callback) {
            documentListeners.set(type, callback);
        },
    };
    const window = {
        ALPHA_CITY_TELEMETRY_CONFIG: {
            endpoint: 'https://telemetry.example.test/events',
            siteId: 'alphacity.tech',
        },
        location: {
            pathname: '/tools/',
            search: '?wallet=0xprivate',
            hash: '#secret',
        },
        navigator: {
            globalPrivacyControl: gpc,
            doNotTrack: dnt,
        },
        fetch(endpoint, options) {
            requests.push({ endpoint, options });
            return Promise.resolve({ ok: true });
        },
        CustomEvent: TestCustomEvent,
        addEventListener(type, callback) {
            windowListeners.set(type, callback);
        },
        dispatchEvent(event) {
            localEvents.push(event);
            return true;
        },
    };
    const context = vm.createContext({
        Blob,
        URL,
        console,
        document,
        globalThis: window,
        window,
    });
    vm.runInContext(source, context);
    return { documentListeners, localEvents, requests, window, windowListeners };
}

test('telemetry sends only allowlisted, sanitized, non-identifying fields', async () => {
    const runtime = loadTelemetry();
    runtime.window.AlphaCityTelemetry.track('tool_open', {
        tool: 'Alchemy Wallet',
        access: 'free',
        address: '0xprivate',
        transactionDigest: 'secret-digest',
    });
    assert.equal(runtime.window.AlphaCityTelemetry.enabled, true);
    assert.equal(runtime.requests.length, 2, 'page view and tool event should be emitted');
    const payload = JSON.parse(runtime.requests[1].options.body);
    assert.deepEqual(payload.properties, { tool: 'Alchemy_Wallet', access: 'free' });
    assert.equal(payload.page, '/tools/');
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /0xprivate|secret-digest|\?|#secret|referrer|userAgent/);
    assert.equal(runtime.requests[1].options.credentials, 'omit');
    assert.equal(runtime.requests[1].options.referrerPolicy, 'no-referrer');
    assert.deepEqual(JSON.parse(JSON.stringify(runtime.window.AlphaCityTelemetry.privacy)), {
        cookies: false,
        persistentIdentifiers: false,
        queryStrings: false,
        walletAddresses: false,
    });
});

test('telemetry respects browser privacy signals and ignores unknown events', () => {
    const runtime = loadTelemetry({ gpc: true });
    assert.equal(runtime.window.AlphaCityTelemetry.enabled, false);
    assert.equal(runtime.requests.length, 0);
    assert.equal(runtime.window.AlphaCityTelemetry.track('not_allowed', { value: 'x' }), false);
    assert.equal(runtime.requests.length, 0);
});

test('shared funnel hooks avoid addresses, balances, digests, and free-form messages', () => {
    const connector = read('shared/wallet-connector.js');
    const gate = read('shared/tools-gate.js');
    assert.match(connector, /track\('wallet_connect'/);
    assert.match(connector, /track\('transaction_sign'/);
    assert.match(gate, /track\('gate_check'/);
    assert.doesNotMatch(connector, /track\([^\r\n]*\baddress\s*:/);
    assert.doesNotMatch(gate, /track\([^\r\n]*\b(?:address|liquid|staked|total)\s*:/);
});

test('public pages load telemetry before application scripts without weakening Sluice CSP', () => {
    const pages = [
        'tools/index.html',
        'staking/index.html',
        'districts/index.html',
        'swap/index.html',
        'alchemy/index.html',
        'intel/index.html',
        'airdrop/index.html',
        'pay/index.html',
        'pay/request/index.html',
        'launchpad/index.html',
        'mint/index.html',
        'secrets/index.html',
        'construct/index.html',
        'venture/index.html',
        'verify/index.html',
        'predict/index.html',
    ];
    for (const relative of pages) {
        const page = read(relative);
        const configIndex = page.indexOf('/shared/telemetry-config.js');
        const clientIndex = page.indexOf('/shared/telemetry.js');
        assert.ok(configIndex >= 0, `${relative} should load telemetry config`);
        assert.ok(clientIndex > configIndex, `${relative} should load telemetry after its config`);
    }
    const sluice = read('sluice/index.html');
    assert.doesNotMatch(sluice, /\/shared\/telemetry\.js/);
    assert.match(sluice, /connect-src 'self' https:\/\/fullnode\.mainnet\.sui\.io/);
});

test('deployment generates telemetry config from optional repository variables', () => {
    const workflow = read('.github/workflows/deploy.yml');
    const buildScript = read('scripts/build-telemetry-config.js');
    assert.match(workflow, /ALPHACITY_TELEMETRY_ENDPOINT: \$\{\{ vars\.ALPHACITY_TELEMETRY_ENDPOINT \}\}/);
    assert.match(workflow, /ALPHACITY_TELEMETRY_SITE_ID: \$\{\{ vars\.ALPHACITY_TELEMETRY_SITE_ID \}\}/);
    assert.match(buildScript, /protocol !== 'https:'/);
    assert.match(buildScript, /parsed\.username \|\| parsed\.password/);
});
