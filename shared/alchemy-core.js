(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.AlphaCityAlchemyCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const SUI_TYPE = '0x2::sui::SUI';
    const CITY_TYPE = '0x308fa16c7aead43e3a49a4ff2e76205ba2a12697234f4fe80a2da66515284060::city::CITY';
    const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
    const USD_MICROS_PER_DOLLAR = 1_000_000n;
    const CITY_DECIMALS = 9;
    const DEFAULT_BATCH_LIMIT = 10;
    const DEFAULT_QUOTE_MAX_AGE_MS = 30_000;
    const DEFAULT_PREPARED_MAX_AGE_MS = 90_000;

    function normalizeAddress(address) {
        const value = String(address || '').trim().toLowerCase().replace(/^0x/, '');
        if (!/^[0-9a-f]+$/.test(value)) return String(address || '').trim().toLowerCase();
        return `0x${value.replace(/^0+/, '') || '0'}`;
    }

    function normalizeCoinType(coinType) {
        return String(coinType || '')
            .replace(/\s+/g, '')
            .replace(/0x[0-9a-fA-F]+(?=::)/g, normalizeAddress);
    }

    function sameCoinType(left, right) {
        return normalizeCoinType(left) === normalizeCoinType(right);
    }

    function isStructuredHolding(coinType) {
        const type = normalizeCoinType(coinType).toLowerCase();
        return [
            '::lp::',
            '::af_lp::',
            '::lpt::',
            'lptoken',
            '::pool::pool',
            '::vault::',
            '::receipt::',
            '::staking::',
        ].some(pattern => type.includes(pattern));
    }

    function exclusionReason(coinType) {
        if (sameCoinType(coinType, SUI_TYPE)) return 'Gas coin';
        if (sameCoinType(coinType, CITY_TYPE)) return 'Already CITY';
        if (isStructuredHolding(coinType)) return 'LP, vault, receipt, or staking token';
        return '';
    }

    function safeBigInt(value, fallback = 0n) {
        try { return BigInt(value); } catch (_) { return fallback; }
    }

    function clampDecimals(value) {
        const number = Number(value);
        return Number.isInteger(number) && number >= 0 && number <= 30 ? number : null;
    }

    function formatUnits(value, decimals, maximumFractionDigits = 6) {
        const raw = safeBigInt(value);
        const places = clampDecimals(decimals);
        if (places === null) return raw.toString();
        const negative = raw < 0n;
        const absolute = negative ? -raw : raw;
        const unit = 10n ** BigInt(places);
        const whole = absolute / unit;
        if (places === 0 || maximumFractionDigits === 0) return `${negative ? '-' : ''}${whole}`;
        const fraction = (absolute % unit)
            .toString()
            .padStart(places, '0')
            .slice(0, maximumFractionDigits)
            .replace(/0+$/, '');
        return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
    }

    function formatUsdMicros(value, maximumFractionDigits = 4) {
        return `$${formatUnits(value, 6, maximumFractionDigits)}`;
    }

    function routeOutputAmount(route) {
        return safeBigInt(route?.coinOut?.amount, 0n);
    }

    function minimumOutput(amount, slippagePercent) {
        const raw = safeBigInt(amount);
        const basisPoints = Math.max(0, Math.min(5_000, Math.round(Number(slippagePercent || 0) * 100)));
        return raw * BigInt(10_000 - basisPoints) / 10_000n;
    }

    function quoteIsFresh(quotedAt, now = Date.now(), maxAgeMs = DEFAULT_QUOTE_MAX_AGE_MS) {
        const timestamp = Number(quotedAt);
        return Number.isFinite(timestamp) && timestamp > 0 && now >= timestamp && now - timestamp <= maxAgeMs;
    }

    function classifyHolding(holding) {
        const totalBalance = safeBigInt(holding?.totalBalance);
        const excluded = exclusionReason(holding?.coinType);
        if (excluded) return { code: 'excluded', label: 'Excluded', reason: excluded, eligible: false };
        if (totalBalance <= 0n) return { code: 'empty', label: 'Empty', reason: 'Zero balance', eligible: false };
        if (!holding?.metadata || clampDecimals(holding.metadata.decimals) === null) {
            return { code: 'unverified', label: 'Unverified', reason: 'Coin metadata is unavailable', eligible: false };
        }
        if (holding.usdMicros === null || holding.usdMicros === undefined) {
            return { code: 'unverified', label: 'Unverified', reason: holding.quoteError || 'No executable USDC valuation route', eligible: false };
        }
        const usdMicros = safeBigInt(holding.usdMicros, -1n);
        if (usdMicros < 0n) {
            return { code: 'unverified', label: 'Unverified', reason: 'Invalid valuation result', eligible: false };
        }
        if (usdMicros >= USD_MICROS_PER_DOLLAR) {
            return { code: 'above-threshold', label: '$1 or more', reason: 'Holding is not below the $1 threshold', eligible: false };
        }
        if (!holding.cityRoute || routeOutputAmount(holding.cityRoute) <= 0n) {
            return { code: 'no-city-route', label: 'No CITY route', reason: holding.routeError || 'No executable route to CITY', eligible: false };
        }
        return { code: 'eligible', label: 'Eligible', reason: 'Executable value is below $1', eligible: true };
    }

    function selectInitialHoldings(holdings, limit = DEFAULT_BATCH_LIMIT) {
        return (holdings || [])
            .filter(holding => classifyHolding(holding).eligible)
            .sort((left, right) => {
                const a = safeBigInt(left.usdMicros);
                const b = safeBigInt(right.usdMicros);
                return a === b ? normalizeCoinType(left.coinType).localeCompare(normalizeCoinType(right.coinType)) : (a > b ? -1 : 1);
            })
            .slice(0, Math.max(0, Number(limit) || 0))
            .map(holding => normalizeCoinType(holding.coinType));
    }

    function selectionTotals(holdings, selectedTypes, slippagePercent) {
        const selected = new Set((selectedTypes || []).map(normalizeCoinType));
        let usdMicros = 0n;
        let cityAmount = 0n;
        let count = 0;
        for (const holding of holdings || []) {
            if (!selected.has(normalizeCoinType(holding.coinType))) continue;
            if (!classifyHolding(holding).eligible) continue;
            usdMicros += safeBigInt(holding.usdMicros);
            cityAmount += routeOutputAmount(holding.cityRoute);
            count += 1;
        }
        return {
            count,
            usdMicros,
            cityAmount,
            minimumCityAmount: minimumOutput(cityAmount, slippagePercent),
        };
    }

    function gasUsedNet(gasUsed) {
        if (!gasUsed) return 0n;
        return safeBigInt(gasUsed.computationCost)
            + safeBigInt(gasUsed.storageCost)
            + safeBigInt(gasUsed.nonRefundableStorageFee)
            - safeBigInt(gasUsed.storageRebate);
    }

    return Object.freeze({
        SUI_TYPE,
        CITY_TYPE,
        USDC_TYPE,
        USD_MICROS_PER_DOLLAR,
        CITY_DECIMALS,
        DEFAULT_BATCH_LIMIT,
        DEFAULT_QUOTE_MAX_AGE_MS,
        DEFAULT_PREPARED_MAX_AGE_MS,
        normalizeAddress,
        normalizeCoinType,
        sameCoinType,
        isStructuredHolding,
        exclusionReason,
        safeBigInt,
        clampDecimals,
        formatUnits,
        formatUsdMicros,
        routeOutputAmount,
        minimumOutput,
        quoteIsFresh,
        classifyHolding,
        selectInitialHoldings,
        selectionTotals,
        gasUsedNet,
    });
});
