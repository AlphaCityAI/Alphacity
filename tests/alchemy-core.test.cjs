const assert = require('node:assert/strict');
const test = require('node:test');

const core = require('../shared/alchemy-core.js');

function holding(overrides = {}) {
    return {
        coinType: '0xabc::dust::DUST',
        totalBalance: '123000000',
        metadata: { decimals: 9, symbol: 'DUST', name: 'Dust' },
        usdMicros: 750_000n,
        cityRoute: { coinOut: { amount: 25_000_000_000n } },
        ...overrides,
    };
}

test('normalizes equivalent Sui coin type addresses', () => {
    assert.equal(
        core.normalizeCoinType('0x0002::sui::SUI'),
        core.normalizeCoinType('0x2::sui::SUI'),
    );
    assert.equal(core.exclusionReason('0x0002::sui::SUI'), 'Gas coin');
});

test('excludes CITY and structured holdings', () => {
    assert.equal(core.exclusionReason(core.CITY_TYPE), 'Already CITY');
    assert.match(core.exclusionReason('0xabc::af_lp::AF_LP'), /LP/);
    assert.match(core.exclusionReason('0xabc::vault::Receipt'), /vault/);
});

test('formats integer balances without floating point loss', () => {
    assert.equal(core.formatUnits('123456789012345678', 9, 4), '123456789.0123');
    assert.equal(core.formatUsdMicros(999_999n), '$0.9999');
});

test('applies the strict under-one-dollar eligibility boundary', () => {
    assert.equal(core.classifyHolding(holding({ usdMicros: 999_999n })).eligible, true);
    const boundary = core.classifyHolding(holding({ usdMicros: 1_000_000n }));
    assert.equal(boundary.eligible, false);
    assert.equal(boundary.code, 'above-threshold');
});

test('requires metadata, a valuation, and a CITY route', () => {
    assert.equal(core.classifyHolding(holding({ metadata: null })).code, 'unverified');
    assert.equal(core.classifyHolding(holding({ usdMicros: null })).code, 'unverified');
    assert.equal(core.classifyHolding(holding({ cityRoute: null })).code, 'no-city-route');
});

test('selects only the highest-value eligible holdings up to the batch cap', () => {
    const rows = [
        holding({ coinType: '0x1::a::A', usdMicros: 100_000n }),
        holding({ coinType: '0x2::b::B', usdMicros: 900_000n }),
        holding({ coinType: '0x3::c::C', usdMicros: 500_000n }),
        holding({ coinType: '0x4::d::D', usdMicros: 1_500_000n }),
    ];
    assert.deepEqual(core.selectInitialHoldings(rows, 2), ['0x2::b::B', '0x3::c::C']);
    assert.equal(core.DEFAULT_BATCH_LIMIT, 10);
});

test('computes aggregate minimum output using BigInt', () => {
    const rows = [
        holding({ coinType: '0x1::a::A', usdMicros: 100_000n, cityRoute: { coinOut: { amount: 1000n } } }),
        holding({ coinType: '0x2::b::B', usdMicros: 200_000n, cityRoute: { coinOut: { amount: 2000n } } }),
    ];
    const totals = core.selectionTotals(rows, rows.map(row => row.coinType), 1);
    assert.equal(totals.count, 2);
    assert.equal(totals.usdMicros, 300_000n);
    assert.equal(totals.cityAmount, 3000n);
    assert.equal(totals.minimumCityAmount, 2970n);
});

test('recognizes fresh quotes and calculates net gas', () => {
    assert.equal(core.quoteIsFresh(10_000, 39_999, 30_000), true);
    assert.equal(core.quoteIsFresh(10_000, 40_001, 30_000), false);
    assert.equal(core.DEFAULT_PREPARED_MAX_AGE_MS, 90_000);
    assert.equal(core.gasUsedNet({
        computationCost: '100',
        storageCost: '50',
        storageRebate: '20',
        nonRefundableStorageFee: '5',
    }), 135n);
});
