'use strict';

const TRIGGERS = Object.freeze({
    TIME: 0,
    MARKET_CAP_USD: 1,
    FDV_USD: 2,
    PRICE_USD_E8: 3,
    LIQUIDITY_USD: 4,
    VOLUME_24H_USD: 5,
    HOLDER_COUNT: 6,
    CUSTOM: 255,
});

const COMPARISONS = Object.freeze({ GTE: 0, LTE: 1 });
const STATUSES = Object.freeze({ PENDING: 0, ACTIVE: 1, CANCELLED: 2, COMPLETED: 3 });
const OBSERVATION_DOMAIN = 'alphacity.sluice.v2.observation';
const CLAIM_DOMAIN = 'alphacity.sluice.v2.claim';

function normalizeAddress(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{1,64}$/.test(raw)) throw new Error('Expected a valid Sui address');
    return `0x${raw.slice(2).padStart(64, '0')}`;
}

function normalizeCoinType(value) {
    const raw = String(value || '').trim();
    const parts = raw.split('::');
    if (parts.length < 3 || parts.slice(1).some(part => !part)) {
        throw new Error('Expected a fully qualified Sui coin type');
    }
    return [normalizeAddress(parts[0]), ...parts.slice(1)].join('::');
}

function parseDecimalToBigInt(value, decimals) {
    const text = String(value ?? '').trim();
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
        throw new Error('Invalid decimal precision');
    }
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
        throw new Error('Enter a positive decimal amount without separators or exponent notation');
    }
    const [whole, fraction = ''] = text.split('.');
    if (fraction.length > decimals) {
        throw new Error(`Amount supports at most ${decimals} decimal places`);
    }
    const units = BigInt(whole) * (10n ** BigInt(decimals))
        + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
    return units;
}

function decimalToScaledBigInt(value, decimals) {
    const text = String(value ?? '').trim().toLowerCase();
    const match = text.match(/^\+?(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/);
    if (!match) throw new Error(`Invalid non-negative decimal value: ${value}`);
    const fraction = match[2] || '';
    const exponent = Number(match[3] || 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) throw new Error('Decimal exponent is out of range');
    const digits = `${match[1]}${fraction}`.replace(/^0+(?=\d)/, '');
    const shift = exponent - fraction.length + decimals;
    if (shift >= 0) return BigInt(digits || '0') * (10n ** BigInt(shift));
    const keep = digits.length + shift;
    return keep > 0 ? BigInt(digits.slice(0, keep)) : 0n;
}

function formatUnits(value, decimals, maxFraction = 6) {
    const units = BigInt(value || 0);
    const negative = units < 0n;
    const absolute = negative ? -units : units;
    const divisor = 10n ** BigInt(decimals);
    const whole = absolute / divisor;
    let fraction = (absolute % divisor).toString().padStart(decimals, '0');
    fraction = fraction.slice(0, Math.max(0, maxFraction)).replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function readU64(value, fallback = 0n) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') {
        if ('value' in value) return readU64(value.value, fallback);
        if (value.fields && 'value' in value.fields) return readU64(value.fields.value, fallback);
    }
    try { return BigInt(value); } catch (_) { return fallback; }
}

function readId(value) {
    if (typeof value === 'string') return normalizeAddress(value);
    const candidate = value?.id || value?.fields?.id || value?.fields?.value || value?.value;
    return normalizeAddress(candidate);
}

function extractCoinType(objectType) {
    const text = String(objectType || '');
    const start = text.indexOf('<');
    const end = text.lastIndexOf('>');
    if (start < 0 || end <= start) throw new Error('Schedule object is missing its coin type');
    return normalizeCoinType(text.slice(start + 1, end));
}

function readBytes(value) {
    if (value == null) return [];
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') {
        if (/^0x[0-9a-f]*$/i.test(value)) {
            return (value.slice(2).match(/.{1,2}/g) || []).map(byte => parseInt(byte, 16));
        }
        try {
            if (typeof atob === 'function') return Array.from(atob(value), char => char.charCodeAt(0));
            return Array.from(Buffer.from(value, 'base64'));
        } catch (_) { return []; }
    }
    if (value.fields) return readBytes(value.fields);
    return [];
}

function optionValue(value) {
    if (value == null) return null;
    if (Array.isArray(value)) return value.length ? value[0] : null;
    if (value.vec && Array.isArray(value.vec)) return value.vec.length ? value.vec[0] : null;
    if (value.fields?.vec && Array.isArray(value.fields.vec)) return value.fields.vec.length ? value.fields.vec[0] : null;
    return value;
}

function parseScheduleObject(object) {
    const data = object?.data || object;
    const content = data?.content || {};
    const fields = content.fields || {};
    const objectType = content.type || data?.type || '';
    const isV2 = objectType.includes('::sluice_v2::VestingScheduleV2<');
    const id = normalizeAddress(data?.objectId || readId(fields.id));
    const legacyMilestoneStatus = isV2 ? null : Number(fields.milestone_status ?? 0);
    const status = isV2
        ? Number(fields.status ?? 0)
        : (legacyMilestoneStatus === 0 ? STATUSES.ACTIVE : STATUSES.PENDING);
    const balance = readU64(fields.balance);
    const totalAmount = readU64(fields.total_amount);
    const releasedAmount = readU64(fields.released_amount);
    const targetOption = optionValue(fields.target_marketcap);
    const parsed = {
        id,
        version: isV2 ? 2 : 1,
        objectType,
        coinType: extractCoinType(objectType),
        creator: normalizeAddress(fields.creator),
        beneficiary: normalizeAddress(fields.beneficiary),
        balance,
        totalAmount,
        releasedAmount,
        startTimeMs: readU64(fields.start_time_ms),
        endTimeMs: readU64(fields.end_time_ms),
        intervalMs: readU64(fields.interval_ms, 1n),
        status,
        legacyMilestoneStatus,
        revocable: Boolean(fields.revocable),
        triggerKind: isV2 ? Number(fields.trigger_kind ?? 0) : (targetOption == null ? 0 : 1),
        comparison: isV2 ? Number(fields.comparison ?? 0) : 0,
        targetValue: isV2 ? readU64(fields.target_value) : readU64(targetOption),
        minLiquidityUsd: isV2 ? readU64(fields.min_liquidity_usd) : 0n,
        validationWindowMs: isV2 ? readU64(fields.validation_window_ms) : 1_800_000n,
        maxSampleGapMs: isV2 ? readU64(fields.max_sample_gap_ms) : 0n,
        lastObservedAtMs: isV2 ? readU64(optionValue(fields.last_observed_at_ms)) : 0n,
        lastObservedValue: isV2 ? readU64(optionValue(fields.last_observed_value)) : 0n,
        aboveSinceMs: isV2 ? readU64(optionValue(fields.above_since_ms)) : 0n,
        triggerDeadlineMs: isV2 ? readU64(fields.trigger_deadline_ms) : 0n,
        fallbackPolicy: isV2 ? Number(fields.fallback_policy ?? 0) : 0,
        clientReference: isV2 ? readBytes(fields.client_reference) : [],
        triggerConfigHash: isV2 ? readBytes(fields.trigger_config_hash) : [],
    };
    parsed.claimable = calculateClaimable(parsed, BigInt(Date.now()));
    return parsed;
}

function calculateVested(schedule, nowMs) {
    if (schedule.status !== STATUSES.ACTIVE) return schedule.releasedAmount;
    const now = BigInt(nowMs);
    if (now < schedule.startTimeMs) return 0n;
    if (now >= schedule.endTimeMs) return schedule.totalAmount;
    const duration = schedule.endTimeMs - schedule.startTimeMs;
    if (duration <= 0n || schedule.intervalMs <= 0n) return 0n;
    const elapsed = now - schedule.startTimeMs;
    const rounded = (elapsed / schedule.intervalMs) * schedule.intervalMs;
    return schedule.totalAmount * rounded / duration;
}

function calculateClaimable(schedule, nowMs) {
    const vested = calculateVested(schedule, nowMs);
    const entitlement = vested > schedule.releasedAmount ? vested - schedule.releasedAmount : 0n;
    return entitlement < schedule.balance ? entitlement : schedule.balance;
}

function triggerMetricName(kind) {
    return ({
        [TRIGGERS.MARKET_CAP_USD]: 'marketCap',
        [TRIGGERS.FDV_USD]: 'fdv',
        [TRIGGERS.PRICE_USD_E8]: 'priceUsdE8',
        [TRIGGERS.LIQUIDITY_USD]: 'liquidityUsd',
        [TRIGGERS.VOLUME_24H_USD]: 'volume24hUsd',
        [TRIGGERS.HOLDER_COUNT]: 'holderCount',
        [TRIGGERS.CUSTOM]: 'custom',
    })[kind] || 'time';
}

function selectPrimaryPair(pairs, coinType) {
    const normalizedCoinType = normalizeCoinType(coinType);
    let selected = null;
    let selectedLiquidity = -1n;
    for (const pair of (pairs || [])) {
        try {
            if (normalizeCoinType(pair.baseToken?.address) !== normalizedCoinType) continue;
            const liquidity = decimalToScaledBigInt(pair.liquidity?.usd || 0, 0);
            if (liquidity > selectedLiquidity) {
                selected = pair;
                selectedLiquidity = liquidity;
            }
        } catch (_) {}
    }
    return selected;
}

function metricValue(pair, triggerKind) {
    let raw;
    let decimals = 0;
    switch (Number(triggerKind)) {
        case TRIGGERS.MARKET_CAP_USD: raw = pair.marketCap; break;
        case TRIGGERS.FDV_USD: raw = pair.fdv; break;
        case TRIGGERS.PRICE_USD_E8: raw = pair.priceUsd; decimals = 8; break;
        case TRIGGERS.LIQUIDITY_USD: raw = pair.liquidity?.usd; break;
        case TRIGGERS.VOLUME_24H_USD: raw = pair.volume?.h24; break;
        default: throw new Error(`Default relayer does not support trigger kind ${triggerKind}`);
    }
    if (raw === null || raw === undefined || raw === '') {
        throw new Error(`${Number(triggerKind) === TRIGGERS.MARKET_CAP_USD ? 'marketCap' : 'requested metric'} is unavailable; no fallback will be substituted`);
    }
    const value = decimalToScaledBigInt(raw, decimals);
    if (value > 18_446_744_073_709_551_615n) throw new Error('Observed value exceeds u64');
    return value;
}

function observationFromPairs(schedule, pairs) {
    const pair = selectPrimaryPair(pairs, schedule.coinType);
    if (!pair) throw new Error('No DexScreener pair has the schedule coin as its exact base token');
    const liquidity = decimalToScaledBigInt(pair.liquidity?.usd || 0, 0);
    const minimumLiquidity = BigInt(schedule.minLiquidityUsd || 0);
    if (liquidity < minimumLiquidity) {
        throw new Error(`Primary pair liquidity $${liquidity} is below required $${minimumLiquidity}`);
    }
    return {
        observedValue: metricValue(pair, schedule.triggerKind),
        pair: `${pair.dexId || 'unknown'}:${pair.pairAddress || 'unknown'}`,
        liquidity,
    };
}

function canonicalTriggerConfig({ coinType, triggerKind, minLiquidityUsd = 0 }) {
    return JSON.stringify({
        coinType: normalizeCoinType(coinType),
        dataSource: 'dexscreener',
        metric: triggerMetricName(Number(triggerKind)),
        pairSelection: 'highest-liquidity-matching-base',
        minLiquidityUsd: String(minLiquidityUsd),
        version: 1,
    });
}

function encodeUleb(value) {
    let remaining = Number(value);
    const output = [];
    do {
        let byte = remaining & 0x7f;
        remaining >>>= 7;
        if (remaining) byte |= 0x80;
        output.push(byte);
    } while (remaining);
    return output;
}

function encodeU64(value) {
    let remaining = BigInt(value);
    const output = [];
    for (let i = 0; i < 8; i += 1) {
        output.push(Number(remaining & 0xffn));
        remaining >>= 8n;
    }
    if (remaining !== 0n) throw new Error('u64 value is out of range');
    return output;
}

function hexToBytes(value) {
    const address = normalizeAddress(value).slice(2);
    return Array.from(address.match(/.{2}/g), byte => parseInt(byte, 16));
}

function vectorBytes(value) {
    const bytes = typeof value === 'string' ? Array.from(new TextEncoder().encode(value)) : Array.from(value);
    return [...encodeUleb(bytes.length), ...bytes];
}

function encodeObservationMessage(input) {
    return Uint8Array.from([
        ...vectorBytes(OBSERVATION_DOMAIN),
        ...hexToBytes(input.scheduleId),
        ...vectorBytes(input.triggerConfigHash),
        Number(input.triggerKind),
        Number(input.comparison),
        ...encodeU64(input.observedValue),
        ...encodeU64(input.observedAtMs),
        ...encodeU64(input.validUntilMs),
    ]);
}

function encodeClaimMessage(input) {
    return Uint8Array.from([
        ...vectorBytes(CLAIM_DOMAIN),
        ...hexToBytes(input.scheduleId),
        ...hexToBytes(input.currentBeneficiary),
        ...hexToBytes(input.newBeneficiary),
        ...encodeU64(input.validUntilMs),
    ]);
}

function encodeClaimFragment(payload) {
    const json = JSON.stringify(payload);
    if (typeof btoa === 'function') {
        const binary = Array.from(new TextEncoder().encode(json), byte => String.fromCharCode(byte)).join('');
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return Buffer.from(json, 'utf8').toString('base64url');
}

function decodeClaimFragment(value) {
    const encoded = String(value || '');
    let json;
    if (typeof atob === 'function') {
        const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4);
        const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0));
        json = new TextDecoder().decode(bytes);
    } else {
        json = Buffer.from(encoded, 'base64url').toString('utf8');
    }
    const payload = JSON.parse(json);
    if (![1, 2].includes(Number(payload.v))) throw new Error('Unsupported claim-link version');
    if (!payload.secretKey) throw new Error('Claim link is missing its key');
    if (payload.scheduleId) payload.scheduleId = normalizeAddress(payload.scheduleId);
    if (payload.coinType) payload.coinType = normalizeCoinType(payload.coinType);
    return payload;
}

module.exports = {
    TRIGGERS,
    COMPARISONS,
    STATUSES,
    OBSERVATION_DOMAIN,
    CLAIM_DOMAIN,
    normalizeAddress,
    normalizeCoinType,
    parseDecimalToBigInt,
    decimalToScaledBigInt,
    formatUnits,
    readU64,
    parseScheduleObject,
    calculateVested,
    calculateClaimable,
    triggerMetricName,
    selectPrimaryPair,
    metricValue,
    observationFromPairs,
    canonicalTriggerConfig,
    encodeObservationMessage,
    encodeClaimMessage,
    encodeClaimFragment,
    decodeClaimFragment,
    hexToBytes,
};
