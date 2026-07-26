const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'pay', 'index.html'), 'utf8');
const requestPage = fs.readFileSync(path.join(root, 'pay', 'request', 'index.html'), 'utf8');
const walletConnector = fs.readFileSync(path.join(root, 'shared', 'wallet-connector.js'), 'utf8');
const portal = fs.readFileSync(path.join(root, 'tools', 'index.html'), 'utf8');
const clientSource = fs.readFileSync(path.join(root, 'shared', 'paylink-client-source.js'), 'utf8');
const clientBundle = fs.readFileSync(path.join(root, 'shared', 'paylink-client.js'), 'utf8');
const requestSource = fs.readFileSync(path.join(root, 'shared', 'paylink-request-source.js'), 'utf8');
const requestBundle = fs.existsSync(path.join(root, 'shared', 'paylink-request.js'))
    ? fs.readFileSync(path.join(root, 'shared', 'paylink-request.js'), 'utf8')
    : '';
const configSource = fs.readFileSync(path.join(root, 'shared', 'paylink-config.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the creator dashboard loads wallet sync, Sui client, and gate before Paylink code', () => {
    const wallet = page.indexOf('/shared/wallet-sync.js');
    const connector = page.indexOf('/shared/wallet-connector.js');
    const sui = page.indexOf('/shared/sui-client.js');
    const gate = page.indexOf('/shared/tools-gate.js');
    const config = page.indexOf('/shared/paylink-config.js');
    const core = page.indexOf('/shared/paylink-core.js');
    const client = page.indexOf('/shared/paylink-client.js');
    assert.ok(wallet > 0 && wallet < connector && connector < sui);
    assert.ok(sui < gate);
    assert.ok(gate < config);
    assert.ok(config < core && core < client);
});

test('generated links use a public payer context page while only creation is CITY-gated', () => {
    assert.match(page, /Creator access requires 1M CITY/i);
    assert.match(page, /payer does not need CITY/i);
    assert.match(configSource, /https:\/\/my\.slush\.app\/pay/);
    assert.match(configSource, /https:\/\/alphacity\.tech\/pay\/request\//);
    assert.match(clientSource, /createSlushUniversalUrl/);
    assert.match(clientSource, /createPayerRequestUrl/);
    assert.match(clientSource, /uri\.slice\(question \+ 1\)/);
    assert.match(clientSource, /searchParams\.set\('uri', uri\)/);
});

test('Slush links include direct mobile fields and the complete URI required by Slush web', async () => {
    const context = { window: {}, URL };
    vm.runInNewContext(clientBundle, context, { filename: 'shared/paylink-client.js' });
    const Client = context.window.AlphaCityPaylinkClient;
    const registryId = `0x${'b'.repeat(64)}`;
    const paymentUri = `sui:pay?receiver=0x${'a'.repeat(64)}&amount=1250000&coinType=0x2%3A%3Asui%3A%3ASUI&nonce=integration-test-nonce&registry=${registryId}&label=Test+invoice`;
    const universalUrl = new URL(Client.createSlushUniversalUrl(paymentUri));

    assert.equal(universalUrl.origin, 'https://my.slush.app');
    assert.equal(universalUrl.pathname, '/pay');
    assert.equal(universalUrl.searchParams.get('receiver'), `0x${'a'.repeat(64)}`);
    assert.equal(universalUrl.searchParams.get('amount'), '1250000');
    assert.equal(universalUrl.searchParams.get('coinType'), '0x2::sui::SUI');
    assert.equal(universalUrl.searchParams.get('nonce'), 'integration-test-nonce');
    assert.equal(universalUrl.searchParams.get('registry'), registryId);
    assert.equal(universalUrl.searchParams.get('uri'), paymentUri);

    const { parsePaymentTransactionUri } = await import('@mysten/payment-kit');
    const mobileParsed = parsePaymentTransactionUri(`sui:pay?${universalUrl.searchParams}`);
    assert.equal(mobileParsed.receiverAddress, `0x${'a'.repeat(64)}`);
    assert.equal(mobileParsed.registryId, registryId);

    const payerUrl = new URL(Client.createPayerRequestUrl({
        paymentUri,
        symbol: 'SUI',
        decimals: 9,
    }));
    assert.equal(payerUrl.origin, 'https://alphacity.tech');
    assert.equal(payerUrl.pathname, '/pay/request/');
    assert.equal(payerUrl.searchParams.get('request'), paymentUri);
    assert.equal(payerUrl.searchParams.has('symbol'), false);
    assert.equal(payerUrl.searchParams.has('decimals'), false);
});

test('stored invoices are upgraded to payer and Slush URLs without changing payment identity', () => {
    assert.match(page, /function upgradePaylinkUrls\(items\)/);
    assert.match(page, /Client\.createSlushUniversalUrl\(invoice\.paymentUri, Config\.slushPaymentBaseUrl\)/);
    assert.match(page, /Client\.createPayerRequestUrl\(invoice, Config\.payerRequestBaseUrl\)/);
    assert.match(page, /return \{ \.\.\.invoice, slushUrl, payerUrl, universalUrl: payerUrl \}/);
    assert.match(page, /if \(upgraded\.changed\) persistInvoices\(\)/);
});

test('the public payer page shows label and memo before continuing to Slush', () => {
    assert.match(requestPage, /id="request-title"/);
    assert.match(requestPage, /id="request-memo"/);
    assert.match(requestPage, /Continue in Slush/i);
    assert.match(requestPage, /parsePaymentRequest\(window\.location\.search, Config\)/);
    assert.match(requestPage, /request\.label/);
    assert.match(requestPage, /request\.message/);
    assert.match(requestPage, /createSlushUrl\(request\.paymentUri/);
    assert.doesNotMatch(requestPage, /tools-gate\.js/);
});

test('the public payer page fails closed and rechecks before opening Slush', () => {
    assert.match(requestPage, /id="continue-slush"[^>]+disabled/);
    assert.match(requestPage, /This invoice is already paid/i);
    assert.match(requestPage, /reviewPaymentRequest\(request, Config\)/);
    assert.match(requestPage, /verify\(\{ navigate: true \}\)/);
    assert.match(requestPage, /window\.location\.assign\(slushUrl\)/);
    assert.match(requestPage, /Verification required/);
});

test('Paylink mirrors the standard wallet button and wallet-management menu', () => {
    assert.match(page, /id="connect-wallet-btn"/);
    assert.match(page, /AlphaCityWalletConnector/);
    assert.match(walletConnector, /Switch Account/);
    assert.match(walletConnector, /Switch Wallet Provider/);
    assert.match(walletConnector, /Disconnect/);
    assert.match(walletConnector, /wallet-standard:app-ready/);
    assert.match(walletConnector, /standard:disconnect/);
    assert.match(walletConnector, /standard:events/);
    assert.match(walletConnector, /accountsChanged/);
    assert.match(walletConnector, /event\.key === 'Escape'/);
    assert.match(walletConnector, /event\.key !== 'Tab'/);
    assert.doesNotMatch(walletConnector, /\balert\(/);
});

test('wallet reconnection retries late providers without dropping persistence and provider switching is rollback-safe', () => {
    assert.match(walletConnector, /automatic && preferredName/);
    assert.match(walletConnector, /const delays = \[0, 600, 1500, 3500, 7000\]/);
    assert.match(walletConnector, /scheduleReconnect\(persisted, true\)/);
    assert.match(walletConnector, /registryListeners\.add\(handleRegistryChange\)/);
    assert.doesNotMatch(walletConnector, /preferredSession: persisted \}\)\.catch\(\(\) => update\(null, ''\)\)/);
    const updateIndex = walletConnector.indexOf('update(nextAdapter, chosenAddress);');
    const oldDisconnectIndex = walletConnector.indexOf('await switchingFrom.disconnect()', updateIndex);
    assert.ok(updateIndex > 0 && oldDisconnectIndex > updateIndex);
    assert.match(walletConnector, /walletKey\(switchingFrom\.name\) !== walletKey\(nextAdapter\.name\)/);
});

test('payment requests use the registry composite identity and exact bigint values', () => {
    assert.match(clientSource, /amount: BigInt\(invoice\.amountAtomic\)/);
    assert.match(clientSource, /nonce: invoice\.nonce/);
    assert.match(clientSource, /receiver: invoice\.receiverAddress/);
    assert.match(clientSource, /suiClient\.core\.getDynamicField/);
    assert.match(clientSource, /PaymentKey<\$\{coinType\}>/);
    assert.match(clientSource, /previousTransaction/);
    assert.match(configSource, /default-payment-registry/);
    assert.match(configSource, /0481b22fd3c73f3176db4c20419e1d09c6a3074aeed65acdc776f7359285ffd2/);
    assert.match(configSource, /bc126f1535fba7d641cb9150ad9eae93b104972586ba20f3c60bfe0e53b69bc6/);
});

test('the UI exposes safety disclosures, full receiver review, receipts, and local-only history', () => {
    assert.match(page, /Funds go directly to this address/i);
    assert.match(page, /does not custody, route, or recover funds/i);
    assert.match(page, /Verify the full destination/i);
    assert.match(page, /stores this invoice only in your current browser/i);
    assert.match(page, /Open in Slush/i);
    assert.match(page, /Export CSV/i);
    assert.match(page, /Receipt/);
    assert.doesNotMatch(page, /\.innerHTML\s*=/);
    assert.doesNotMatch(page, /signAndExecute|signTransaction|executeTransaction/);
});

test('the ecosystem dashboard links to the new gated Paylink creator', () => {
    assert.match(portal, /Alpha City Paylink/);
    assert.match(portal, /href="\/pay\/"/);
    assert.match(portal, /Open Paylink/);
});

test('Paylink dependencies are exact and included in the normal production build', () => {
    assert.equal(packageJson.dependencies['@mysten/payment-kit'], '0.2.5');
    assert.equal(packageJson.dependencies.qrcode, '1.5.4');
    assert.match(packageJson.scripts['build:paylink'], /paylink-client-source\.js/);
    assert.match(packageJson.scripts['build:paylink-request'], /paylink-request-source\.js/);
    assert.match(packageJson.scripts['build:paylink-css'], /pay\/tailwind\.css/);
    assert.match(packageJson.scripts.build, /build:paylink/);
    assert.match(packageJson.scripts.build, /build:paylink-css/);
    assert.match(page, /href="\/pay\/tailwind\.css"/);
    assert.doesNotMatch(page, /cdn\.tailwindcss\.com/);
    assert.match(page, /id="tools-gate-style"/);
    for (const script of page.matchAll(/<script src="\/shared\/[^"]+"([^>]*)>/g)) assert.match(script[1], /\bdefer\b/);
});

test('the inline Paylink controller parses as JavaScript', () => {
    const scripts = [...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length >= 2);
    const controller = scripts.at(-1)[1];
    assert.doesNotThrow(() => new vm.Script(controller, { filename: 'pay/index.html:inline-controller.js' }));
});

test('the inline public request controller parses as JavaScript', () => {
    const scripts = [...requestPage.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length >= 3);
    assert.doesNotThrow(() => new vm.Script(scripts.at(-1)[1], { filename: 'pay/request/index.html:inline-controller.js' }));
});

test('Payment Kit creates and parses the exact registry-backed request URI', async () => {
    const { createPaymentTransactionUri, parsePaymentTransactionUri } = await import('@mysten/payment-kit');
    const receiverAddress = `0x${'a'.repeat(64)}`;
    const registryId = `0x${'b'.repeat(64)}`;
    const uri = createPaymentTransactionUri({
        receiverAddress,
        amount: 1_250_000n,
        coinType: '0x2::sui::SUI',
        nonce: 'integration-test-nonce',
        label: 'Test invoice',
        message: 'Paylink round trip',
        registryId,
    });
    const parsed = parsePaymentTransactionUri(uri);
    assert.equal(parsed.receiverAddress, receiverAddress);
    assert.equal(parsed.amount, 1_250_000n);
    assert.equal(parsed.coinType, '0x2::sui::SUI');
    assert.equal(parsed.nonce, 'integration-test-nonce');
    assert.equal(parsed.registryId, registryId);
});

function loadRequestClient() {
    assert.ok(requestBundle, 'paylink request bundle must be built');
    const context = {
        window: {},
        URL,
        URLSearchParams,
        TextEncoder,
        Uint8Array,
        AbortController,
        setTimeout,
        clearTimeout,
        btoa,
        fetch,
    };
    context.globalThis = context;
    vm.runInNewContext(requestBundle, context, { filename: 'shared/paylink-request.js' });
    return context.window.AlphaCityPaylinkRequest;
}

test('public request parsing ignores display overrides and rejects ambiguous payment identity', () => {
    const RequestClient = loadRequestClient();
    const registryId = `0x${'b'.repeat(64)}`;
    const base = `sui:pay?receiver=0x${'a'.repeat(64)}&amount=500000000000&coinType=0x2%3A%3Asui%3A%3ASUI&nonce=invoice-1&registry=${registryId}&label=Invoice&message=Memo`;
    const parsed = RequestClient.parsePaymentRequest(`?request=${encodeURIComponent(base)}&symbol=FAKE&decimals=18`, { registryId });
    assert.equal(parsed.amountAtomic, 500000000000n);
    assert.equal(parsed.coinType, `0x${'0'.repeat(63)}2::sui::SUI`);
    assert.equal(parsed.label, 'Invoice');

    const duplicate = `${base}&amount=1`;
    assert.throws(() => RequestClient.parsePaymentRequest(`?request=${encodeURIComponent(duplicate)}`, { registryId }), /amount field/);
    assert.throws(() => RequestClient.parsePaymentRequest(`?request=${encodeURIComponent(base)}&request=${encodeURIComponent(base)}`, { registryId }), /ambiguous/);
    assert.throws(() => RequestClient.parsePaymentRequest(`?request=${encodeURIComponent(base.replace(registryId, `0x${'c'.repeat(64)}`))}`, { registryId }), /Alpha City payment registry/);
});

test('public payment record keys match the Payment Kit BCS identity', async () => {
    const RequestClient = loadRequestClient();
    const { bcs } = await import('@mysten/sui/bcs');
    const receiverAddress = `0x${'a'.repeat(64)}`;
    const actual = RequestClient.serializePaymentKey({ nonce: 'invoice-1', amountAtomic: 500000000000n, receiverAddress });
    const expected = bcs.struct('PaymentKey', {
        nonce: bcs.string(),
        payment_amount: bcs.u64(),
        receiver: bcs.Address,
    }).serialize({ nonce: 'invoice-1', payment_amount: 500000000000n, receiver: receiverAddress }).toBytes();
    assert.deepEqual([...actual], [...expected]);
});

test('public review uses verified metadata and detects an existing payment record', async () => {
    const RequestClient = loadRequestClient();
    const registryId = `0x${'b'.repeat(64)}`;
    const request = {
        coinType: `0x${'0'.repeat(63)}2::sui::SUI`,
        registryId,
        nonce: 'invoice-1',
        amountAtomic: 500000000000n,
        receiverAddress: `0x${'a'.repeat(64)}`,
    };
    let posted;
    const review = await RequestClient.reviewPaymentRequest(request, {
        registryId,
        paymentKitPackageId: `0x${'c'.repeat(64)}`,
        graphqlUrls: ['https://example.test/graphql'],
    }, {
        fetch: async (_url, options) => {
            posted = JSON.parse(options.body);
            return {
                ok: true,
                async json() {
                    return { data: {
                        coinMetadata: { decimals: 9, symbol: 'SUI', name: 'Sui' },
                        address: { dynamicField: { address: `0x${'d'.repeat(64)}`, previousTransaction: { digest: 'paid-digest' } } },
                    } };
                },
            };
        },
    });
    assert.equal(review.metadata.symbol, 'SUI');
    assert.equal(review.metadata.decimals, 9);
    assert.equal(review.metadata.trustedPreset, false);
    assert.equal(review.paid, true);
    assert.equal(review.transactionDigest, 'paid-digest');
    assert.match(posted.variables.paymentKey.type, /payment_kit::PaymentKey</);
    assert.ok(posted.variables.paymentKey.bcs.length > 20);
});

test('trusted token presets must match verified on-chain metadata', async () => {
    const RequestClient = loadRequestClient();
    const coinType = `0x${'0'.repeat(63)}2::sui::SUI`;
    await assert.rejects(() => RequestClient.reviewPaymentRequest({
        coinType,
        registryId: `0x${'b'.repeat(64)}`,
        nonce: 'invoice-1',
        amountAtomic: 1n,
        receiverAddress: `0x${'a'.repeat(64)}`,
    }, {
        paymentKitPackageId: `0x${'c'.repeat(64)}`,
        tokenPresets: [{ coinType: '0x2::sui::SUI', decimals: 9, symbol: 'SUI' }],
        graphqlUrls: ['https://example.test/graphql'],
    }, {
        fetch: async () => ({
            ok: true,
            async json() {
                return { data: {
                    coinMetadata: { decimals: 18, symbol: 'SUI', name: 'Fake Sui' },
                    address: { dynamicField: null },
                } };
            },
        }),
    }), /does not match the trusted Alpha City preset/);
});

test('public review fails closed when the registry cannot be verified', async () => {
    const RequestClient = loadRequestClient();
    await assert.rejects(() => RequestClient.reviewPaymentRequest({
        coinType: `0x${'0'.repeat(63)}2::sui::SUI`,
        registryId: `0x${'b'.repeat(64)}`,
        nonce: 'invoice-1',
        amountAtomic: 1n,
        receiverAddress: `0x${'a'.repeat(64)}`,
    }, {
        paymentKitPackageId: `0x${'c'.repeat(64)}`,
        graphqlUrls: ['https://example.test/graphql'],
    }, {
        fetch: async () => ({
            ok: true,
            async json() {
                return { data: {
                    coinMetadata: { decimals: 9, symbol: 'SUI', name: 'Sui' },
                    address: null,
                } };
            },
        }),
    }), /registry could not be verified/);
});
