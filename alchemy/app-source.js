import { Aftermath } from 'aftermath-ts-sdk';
import { Transaction } from '@mysten/sui/transactions';

const core = window.AlphaCityAlchemyCore;
if (!core) throw new Error('The Alchemy core module did not load');

const MAX_QUOTED_TYPES = 40;
const SCAN_QUOTE_CONCURRENCY = 3;
const PREPARE_QUOTE_CONCURRENCY = 5;
const EXPLORER_TX_URL = 'https://suiscan.xyz/mainnet/tx/';

const state = {
    address: '',
    walletConnector: null,
    routerPromise: null,
    holdings: [],
    selected: new Set(),
    slippage: 1,
    scanNonce: 0,
    scanning: false,
    preparing: false,
    executing: false,
    prepared: null,
    preparedExpiryTimer: null,
};

const $ = id => document.getElementById(id);

function rpc(method, params) {
    if (!window.AlphaCitySui?.rpc) throw new Error('The Sui data client did not load');
    return window.AlphaCitySui.rpc(method, params);
}

function errorMessage(error) {
    const message = error?.message || String(error || 'Unknown error');
    return message.replace(/^Error:\s*/i, '').slice(0, 260);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function shortType(coinType) {
    const value = String(coinType || '');
    if (value.length <= 46) return value;
    return `${value.slice(0, 18)}…${value.slice(-24)}`;
}

function symbolFor(holding) {
    return holding.metadata?.symbol || String(holding.coinType || '').split('::').pop()?.slice(0, 12) || 'COIN';
}

function badgeLetter(holding) {
    return symbolFor(holding).replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
}

function setStatus(message, kind = 'info') {
    const element = $('alchemy-status');
    if (!message) {
        element.hidden = true;
        element.textContent = '';
        return;
    }
    const classes = {
        info: 'border-blue-500/30 bg-blue-500/10 text-blue-200',
        success: 'border-green-500/30 bg-green-500/10 text-green-200',
        warning: 'border-amber-500/30 bg-amber-500/10 text-amber-100',
        error: 'border-red-500/30 bg-red-500/10 text-red-200',
    };
    element.className = `mt-4 rounded-xl border px-4 py-3 text-sm ${classes[kind] || classes.info}`;
    element.textContent = message;
    element.hidden = false;
}

function setBusyButton(button, busy, busyLabel, normalLabel) {
    button.disabled = busy;
    button.innerHTML = busy
        ? `<span class="spinner" aria-hidden="true"></span><span>${escapeHtml(busyLabel)}</span>`
        : escapeHtml(normalLabel);
}

function getRouter() {
    if (!state.routerPromise) {
        state.routerPromise = Aftermath.create({ network: 'MAINNET' })
            .then(aftermath => aftermath.Router())
            .catch(error => {
                state.routerPromise = null;
                throw error;
            });
    }
    return state.routerPromise;
}

async function mapLimit(items, limit, worker, progress) {
    const output = new Array(items.length);
    let nextIndex = 0;
    let completed = 0;
    async function run() {
        for (;;) {
            const index = nextIndex++;
            if (index >= items.length) return;
            try {
                output[index] = await worker(items[index], index);
            } catch (error) {
                output[index] = error;
            }
            completed += 1;
            if (progress) progress(completed, items.length);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return output;
}

async function fetchMetadata(coinType) {
    try {
        const metadata = await rpc('suix_getCoinMetadata', [coinType]);
        if (!metadata || core.clampDecimals(metadata.decimals) === null) return null;
        return {
            decimals: Number(metadata.decimals),
            name: metadata.name || '',
            symbol: metadata.symbol || '',
            iconUrl: metadata.iconUrl || '',
        };
    } catch (_) {
        return null;
    }
}

async function fetchRoute(router, coinInType, coinOutType, coinInAmount) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const route = await router.getCompleteTradeRouteGivenAmountIn({
            coinInType,
            coinOutType,
            coinInAmount: core.safeBigInt(coinInAmount),
        }, controller.signal);
        if (core.routeOutputAmount(route) <= 0n) throw new Error('Router returned no output');
        return route;
    } finally {
        clearTimeout(timeout);
    }
}

async function quoteHolding(holding, router) {
    const quoted = {
        ...holding,
        usdMicros: null,
        usdRoute: null,
        cityRoute: null,
        quoteError: '',
        routeError: '',
        quotedAt: 0,
    };
    if (!holding.metadata) {
        quoted.quoteError = 'Coin metadata is unavailable';
        return quoted;
    }

    try {
        if (core.sameCoinType(holding.coinType, core.USDC_TYPE)) {
            quoted.usdMicros = core.safeBigInt(holding.totalBalance);
        } else {
            quoted.usdRoute = await fetchRoute(router, holding.coinType, core.USDC_TYPE, holding.totalBalance);
            quoted.usdMicros = core.routeOutputAmount(quoted.usdRoute);
        }
    } catch (error) {
        quoted.quoteError = errorMessage(error) || 'No executable USDC valuation route';
        return quoted;
    }

    if (quoted.usdMicros >= core.USD_MICROS_PER_DOLLAR) {
        quoted.quotedAt = Date.now();
        return quoted;
    }

    try {
        quoted.cityRoute = await fetchRoute(router, holding.coinType, core.CITY_TYPE, holding.totalBalance);
    } catch (error) {
        quoted.routeError = errorMessage(error) || 'No executable CITY route';
    }
    quoted.quotedAt = Date.now();
    return quoted;
}

async function quoteSelectedHolding(holding, router) {
    const quoted = {
        ...holding,
        usdMicros: null,
        usdRoute: null,
        cityRoute: null,
        quoteError: '',
        routeError: '',
        quotedAt: 0,
    };
    if (!holding.metadata) {
        quoted.quoteError = 'Coin metadata is unavailable';
        return quoted;
    }

    const usdQuote = core.sameCoinType(holding.coinType, core.USDC_TYPE)
        ? Promise.resolve({ route: null, amount: core.safeBigInt(holding.totalBalance) })
        : fetchRoute(router, holding.coinType, core.USDC_TYPE, holding.totalBalance)
            .then(route => ({ route, amount: core.routeOutputAmount(route) }));
    const cityQuote = fetchRoute(router, holding.coinType, core.CITY_TYPE, holding.totalBalance);
    const [usdResult, cityResult] = await Promise.allSettled([usdQuote, cityQuote]);

    if (usdResult.status === 'fulfilled') {
        quoted.usdRoute = usdResult.value.route;
        quoted.usdMicros = usdResult.value.amount;
    } else {
        quoted.quoteError = errorMessage(usdResult.reason) || 'No executable USDC valuation route';
    }
    if (cityResult.status === 'fulfilled') {
        quoted.cityRoute = cityResult.value;
    } else {
        quoted.routeError = errorMessage(cityResult.reason) || 'No executable CITY route';
    }
    quoted.quotedAt = Date.now();
    return quoted;
}

function classificationClasses(code) {
    if (code === 'eligible') return 'border-green-500/30 bg-green-500/10 text-green-300';
    if (code === 'above-threshold') return 'border-purple-500/30 bg-purple-500/10 text-purple-300';
    if (code === 'no-city-route') return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    return 'border-gray-600 bg-gray-800 text-gray-400';
}

function holdingRow(holding) {
    const classification = core.classifyHolding(holding);
    const normalizedType = core.normalizeCoinType(holding.coinType);
    const checked = state.selected.has(normalizedType);
    const decimals = holding.metadata?.decimals;
    const balance = decimals === undefined
        ? core.safeBigInt(holding.totalBalance).toString()
        : core.formatUnits(holding.totalBalance, decimals, 6);
    const cityAmount = core.routeOutputAmount(holding.cityRoute);
    const detail = classification.eligible
        ? `${core.formatUsdMicros(holding.usdMicros)} liquidation value · ≈ ${core.formatUnits(cityAmount, core.CITY_DECIMALS, 4)} CITY`
        : classification.code === 'above-threshold'
            ? `${core.formatUsdMicros(holding.usdMicros)} quoted liquidation value`
            : classification.reason;
    return `
        <label class="holding-row ${classification.eligible ? 'holding-row-selectable' : ''}">
            <input
                class="holding-checkbox mt-1 h-4 w-4 shrink-0 rounded border-gray-600 bg-dark-bg text-brand-primary focus:ring-brand-primary"
                type="checkbox"
                data-coin-type="${escapeHtml(normalizedType)}"
                ${checked ? 'checked' : ''}
                ${classification.eligible ? '' : 'disabled'}
            >
            <span class="token-badge">${escapeHtml(badgeLetter(holding))}</span>
            <span class="min-w-0 flex-1">
                <span class="flex flex-wrap items-center gap-2">
                    <span class="font-semibold text-white">${escapeHtml(symbolFor(holding))}</span>
                    <span class="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${classificationClasses(classification.code)}">${escapeHtml(classification.label)}</span>
                </span>
                <span class="mt-1 block text-sm text-gray-300">${escapeHtml(balance)} ${escapeHtml(symbolFor(holding))}</span>
                <span class="mt-1 block truncate font-mono text-[10px] text-gray-500" title="${escapeHtml(holding.coinType)}">${escapeHtml(shortType(holding.coinType))}</span>
                <span class="mt-2 block text-xs text-dark-text-secondary">${escapeHtml(detail)}</span>
            </span>
        </label>`;
}

function renderHoldings() {
    const list = $('holdings-list');
    if (!state.address) {
        list.innerHTML = '<div class="empty-state">Connect a Sui wallet to scan its fungible token balances.</div>';
        return;
    }
    if (state.scanning && !state.holdings.length) {
        list.innerHTML = '<div class="empty-state"><span class="spinner text-brand-secondary"></span><span>Scanning balances and checking routes…</span></div>';
        return;
    }
    if (!state.holdings.length) {
        list.innerHTML = '<div class="empty-state">No non-SUI, non-CITY fungible balances were found.</div>';
        return;
    }
    list.innerHTML = state.holdings.map(holdingRow).join('');
    list.querySelectorAll('.holding-checkbox').forEach(input => {
        input.addEventListener('change', handleSelectionChange);
    });
}

function selectionTotals() {
    return core.selectionTotals(state.holdings, [...state.selected], state.slippage);
}

function renderSummary() {
    const totals = selectionTotals();
    $('selected-count').textContent = String(totals.count);
    $('selected-value').textContent = core.formatUsdMicros(totals.usdMicros);
    $('expected-city').textContent = core.formatUnits(totals.cityAmount, core.CITY_DECIMALS, 4);
    $('minimum-city').textContent = core.formatUnits(totals.minimumCityAmount, core.CITY_DECIMALS, 4);

    const prepare = $('prepare-button');
    const eligibleCount = state.holdings.filter(holding => core.classifyHolding(holding).eligible).length;
    if (!state.address) {
        prepare.textContent = 'Connect Wallet to Scan';
        prepare.disabled = true;
    } else if (state.scanning) {
        prepare.textContent = 'Scan in progress…';
        prepare.disabled = true;
    } else if (!totals.count) {
        prepare.textContent = eligibleCount ? 'Select Tokens to Alchemize' : 'No Eligible Tokens';
        prepare.disabled = true;
    } else {
        prepare.textContent = `Prepare ${totals.count} Token${totals.count === 1 ? '' : 's'} → CITY`;
        prepare.disabled = state.preparing || state.executing;
    }

    const overflow = Math.max(0, eligibleCount - core.DEFAULT_BATCH_LIMIT);
    $('batch-note').textContent = overflow
        ? `${eligibleCount} eligible holdings found. Alchemy prepares up to ${core.DEFAULT_BATCH_LIMIT} per transaction; ${overflow} remain unselected for another pass.`
        : `Safety limit: up to ${core.DEFAULT_BATCH_LIMIT} token types in one atomic transaction.`;
}

function render() {
    renderHoldings();
    renderSummary();
    $('rescan-button').disabled = !state.address || state.scanning || state.preparing || state.executing;
}

function invalidatePrepared() {
    if (state.preparedExpiryTimer) clearTimeout(state.preparedExpiryTimer);
    state.preparedExpiryTimer = null;
    state.prepared = null;
    $('preflight-panel').hidden = true;
    $('confirm-button').disabled = true;
}

function preparedIsFresh(prepared, now = Date.now()) {
    return core.quoteIsFresh(prepared?.preparedAt, now, core.DEFAULT_PREPARED_MAX_AGE_MS);
}

function schedulePreparedExpiry(prepared) {
    if (state.preparedExpiryTimer) clearTimeout(state.preparedExpiryTimer);
    const delay = Math.max(0, core.DEFAULT_PREPARED_MAX_AGE_MS - (Date.now() - prepared.preparedAt));
    state.preparedExpiryTimer = setTimeout(() => {
        state.preparedExpiryTimer = null;
        if (state.prepared !== prepared || state.executing) return;
        invalidatePrepared();
        setStatus('The simulated transaction expired. Prepare again for fresh balances, routes, and preflight results.', 'warning');
        renderSummary();
    }, delay + 50);
}

function handleSelectionChange(event) {
    const coinType = core.normalizeCoinType(event.currentTarget.dataset.coinType);
    if (event.currentTarget.checked) {
        if (state.selected.size >= core.DEFAULT_BATCH_LIMIT) {
            event.currentTarget.checked = false;
            setStatus(`Alchemy supports ${core.DEFAULT_BATCH_LIMIT} token types per transaction.`, 'warning');
            return;
        }
        state.selected.add(coinType);
    } else {
        state.selected.delete(coinType);
    }
    invalidatePrepared();
    renderSummary();
}

function resetForWallet() {
    state.scanNonce += 1;
    state.holdings = [];
    state.selected.clear();
    state.scanning = false;
    state.preparing = false;
    state.executing = false;
    invalidatePrepared();
    $('success-panel').hidden = true;
    setStatus('');
    render();
}

async function scanWallet() {
    if (!state.address) return;
    const nonce = ++state.scanNonce;
    state.scanning = true;
    state.holdings = [];
    state.selected.clear();
    invalidatePrepared();
    setStatus('Reading fungible balances from Sui…', 'info');
    render();

    try {
        const balances = await rpc('suix_getAllBalances', [state.address]);
        if (nonce !== state.scanNonce) return;
        const candidates = (balances || [])
            .filter(balance => core.safeBigInt(balance.totalBalance) > 0n)
            .filter(balance => !core.exclusionReason(balance.coinType))
            .map(balance => ({
                coinType: balance.coinType,
                totalBalance: String(balance.totalBalance),
                coinBalance: String(balance.coinBalance || '0'),
                addressBalance: String(balance.addressBalance || '0'),
                metadata: null,
                usdMicros: null,
                usdRoute: null,
                cityRoute: null,
                quoteError: '',
                routeError: '',
                quotedAt: 0,
            }));

        setStatus(`Loading metadata for ${candidates.length} token type${candidates.length === 1 ? '' : 's'}…`, 'info');
        const withMetadata = await mapLimit(candidates, 6, async holding => ({
            ...holding,
            metadata: await fetchMetadata(holding.coinType),
        }));
        if (nonce !== state.scanNonce) return;

        const quotable = withMetadata.slice(0, MAX_QUOTED_TYPES);
        const overflow = withMetadata.slice(MAX_QUOTED_TYPES).map(holding => ({
            ...holding,
            quoteError: `Initial scan limit of ${MAX_QUOTED_TYPES} token types reached`,
        }));
        if (!quotable.length) {
            state.holdings = overflow;
            setStatus('Scan complete. No non-SUI, non-CITY fungible balances were found.', 'success');
            return;
        }

        setStatus(`Initializing the Aftermath router for ${quotable.length} valuation check${quotable.length === 1 ? '' : 's'}…`, 'info');
        const router = await getRouter();
        if (nonce !== state.scanNonce) return;
        const quoted = await mapLimit(
            quotable,
            SCAN_QUOTE_CONCURRENCY,
            holding => quoteHolding(holding, router),
            (complete, total) => setStatus(`Checking executable USDC values and CITY routes… ${complete}/${total}`, 'info'),
        );
        if (nonce !== state.scanNonce) return;
        state.holdings = [...quoted.map((result, index) => {
            if (!(result instanceof Error)) return result;
            return { ...quotable[index], quoteError: errorMessage(result) };
        }), ...overflow];
        state.holdings.sort((left, right) => {
            const a = core.classifyHolding(left);
            const b = core.classifyHolding(right);
            if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
            const aUsd = core.safeBigInt(left.usdMicros, -1n);
            const bUsd = core.safeBigInt(right.usdMicros, -1n);
            return aUsd === bUsd ? symbolFor(left).localeCompare(symbolFor(right)) : (aUsd > bUsd ? -1 : 1);
        });
        state.selected = new Set(core.selectInitialHoldings(state.holdings));
        const eligible = state.holdings.filter(holding => core.classifyHolding(holding).eligible).length;
        const unverified = state.holdings.length - eligible;
        setStatus(
            eligible
                ? `Scan complete: ${eligible} holding${eligible === 1 ? '' : 's'} verified below $1 with a CITY route. ${unverified} other holding${unverified === 1 ? '' : 's'} left untouched.`
                : `Scan complete. No holdings met both the under-$1 valuation and executable CITY-route requirements.`,
            eligible ? 'success' : 'warning',
        );
    } catch (error) {
        if (nonce !== state.scanNonce) return;
        setStatus(`Wallet scan failed: ${errorMessage(error)}`, 'error');
    } finally {
        if (nonce === state.scanNonce) {
            state.scanning = false;
            render();
        }
    }
}

function replaceHolding(updated) {
    const coinType = core.normalizeCoinType(updated.coinType);
    const index = state.holdings.findIndex(holding => core.normalizeCoinType(holding.coinType) === coinType);
    if (index >= 0) state.holdings[index] = updated;
}

async function refreshSelectedQuotes(selected) {
    if (selected.length > core.DEFAULT_BATCH_LIMIT) {
        throw new Error(`Alchemy supports up to ${core.DEFAULT_BATCH_LIMIT} token types per transaction`);
    }
    const balances = await rpc('suix_getAllBalances', [state.address]);
    const byType = new Map((balances || []).map(balance => [core.normalizeCoinType(balance.coinType), balance]));
    const router = await getRouter();
    return mapLimit(selected, PREPARE_QUOTE_CONCURRENCY, async holding => {
        const balance = byType.get(core.normalizeCoinType(holding.coinType));
        if (!balance || core.safeBigInt(balance.totalBalance) <= 0n) {
            throw new Error(`${symbolFor(holding)} no longer has a spendable balance`);
        }
        const refreshed = await quoteSelectedHolding({ ...holding, totalBalance: String(balance.totalBalance) }, router);
        const classification = core.classifyHolding(refreshed);
        if (!classification.eligible) throw new Error(`${symbolFor(holding)} is no longer eligible: ${classification.reason}`);
        return refreshed;
    });
}

function simulationTransaction(result) {
    if (result?.FailedTransaction) return { failure: result.FailedTransaction };
    if (result?.$kind === 'FailedTransaction') return { failure: result.FailedTransaction || result[result.$kind] };
    return { transaction: result?.Transaction || (result?.$kind === 'Transaction' ? result.Transaction : null) };
}

function failureMessage(failure) {
    return failure?.status?.error?.message
        || failure?.status?.error
        || failure?.effects?.status?.error?.message
        || failure?.effects?.status?.error
        || 'Transaction simulation failed';
}

async function prepareAlchemy() {
    if (!state.address || state.preparing || state.executing) return;
    const selected = state.holdings.filter(holding => state.selected.has(core.normalizeCoinType(holding.coinType)));
    if (!selected.length) return;
    state.preparing = true;
    invalidatePrepared();
    setBusyButton($('prepare-button'), true, 'Refreshing quotes…', 'Prepare Alchemy');
    setStatus('Refreshing balances, values, and CITY routes before building…', 'info');

    try {
        const address = state.address;
        const refreshedResults = await refreshSelectedQuotes(selected);
        const refreshed = refreshedResults.map((result, index) => {
            if (result instanceof Error) throw result;
            replaceHolding(result);
            return result;
        });
        if (address !== state.address) throw new Error('The connected wallet changed during preparation');

        const router = await getRouter();
        let tx = new Transaction();
        const cityCoins = [];
        setStatus('Composing the atomic multi-route transaction…', 'info');
        for (const holding of refreshed) {
            const added = await router.addTransactionForCompleteTradeRoute({
                tx,
                completeRoute: holding.cityRoute,
                slippage: state.slippage / 100,
                walletAddress: address,
            });
            tx = added.tx;
            if (!added.coinOutId) throw new Error(`Aftermath did not return a CITY output for ${symbolFor(holding)}`);
            cityCoins.push(added.coinOutId);
        }
        if (cityCoins.length > 1) tx.mergeCoins(cityCoins[0], cityCoins.slice(1));
        tx.transferObjects([cityCoins[0]], address);
        tx.setSender(address);

        setStatus('Simulating gas and on-chain execution…', 'info');
        const client = window.AlphaCitySui?.grpcClient;
        if (!client?.simulateTransaction) throw new Error('The Sui simulation client is unavailable');
        const simulation = await client.simulateTransaction({
            transaction: tx,
            include: { effects: true, balanceChanges: true, commandResults: true },
        });
        const parsed = simulationTransaction(simulation);
        if (parsed.failure) throw new Error(failureMessage(parsed.failure));
        if (!parsed.transaction?.effects) throw new Error('Simulation returned no transaction effects');
        const effects = parsed.transaction.effects;
        if (effects.status?.success === false) throw new Error(failureMessage(parsed.transaction));

        const totals = core.selectionTotals(refreshed, refreshed.map(row => row.coinType), state.slippage);
        const gasMist = core.gasUsedNet(effects.gasUsed);
        state.prepared = {
            tx,
            rows: refreshed,
            address,
            totals,
            gasMist,
            quotedAt: Math.min(...refreshed.map(row => Number(row.quotedAt) || 0)),
            preparedAt: Date.now(),
        };
        schedulePreparedExpiry(state.prepared);
        $('preflight-token-count').textContent = String(totals.count);
        $('preflight-min-city').textContent = core.formatUnits(totals.minimumCityAmount, core.CITY_DECIMALS, 4);
        $('preflight-gas').textContent = `${core.formatUnits(gasMist, 9, 6)} SUI`;
        $('preflight-panel').hidden = false;
        $('confirm-button').disabled = false;
        $('confirm-button').textContent = 'Confirm Alchemy in Wallet';
        setStatus('Simulation passed. Review the preflight summary, then confirm in your wallet.', 'success');
        renderHoldings();
        renderSummary();
        $('preflight-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
        invalidatePrepared();
        setStatus(`Could not prepare Alchemy: ${errorMessage(error)}`, 'error');
    } finally {
        state.preparing = false;
        renderSummary();
    }
}

function transactionFailure(result) {
    if (result?.FailedTransaction) return failureMessage(result.FailedTransaction);
    const status = result?.effects?.status;
    const normalized = typeof status === 'string' ? status : status?.status;
    if (String(normalized || '').toLowerCase() === 'failure') {
        return status?.error?.message || status?.error || 'Transaction failed on-chain';
    }
    return '';
}

function transactionDigest(result) {
    return result?.digest
        || result?.Transaction?.digest
        || result?.certificate?.transactionDigest
        || result?.effects?.transactionDigest
        || '';
}

async function executeAlchemy() {
    if (!state.prepared || state.executing) return;
    if (state.prepared.address !== state.address) {
        invalidatePrepared();
        setStatus('The connected wallet changed. Prepare the transaction again.', 'warning');
        return;
    }
    if (!preparedIsFresh(state.prepared)) {
        invalidatePrepared();
        setStatus('The simulated transaction expired. Prepare again to refresh balances, routes, and preflight results.', 'warning');
        return;
    }

    state.executing = true;
    if (state.preparedExpiryTimer) clearTimeout(state.preparedExpiryTimer);
    state.preparedExpiryTimer = null;
    const button = $('confirm-button');
    setBusyButton(button, true, 'Confirm in wallet…', 'Confirm Alchemy in Wallet');
    setStatus('Your wallet will show the complete atomic transaction for approval.', 'info');
    try {
        const result = await state.walletConnector.signAndExecuteTransaction(state.prepared.tx);
        const failure = transactionFailure(result);
        if (failure) throw new Error(failure);
        const digest = transactionDigest(result);
        if (digest && window.AlphaCitySui?.grpcClient?.waitForTransaction) {
            try { await window.AlphaCitySui.grpcClient.waitForTransaction({ digest }); } catch (_) {}
        }
        $('success-digest').textContent = digest ? `${digest.slice(0, 16)}…${digest.slice(-8)}` : 'Submitted';
        $('success-link').href = digest ? `${EXPLORER_TX_URL}${encodeURIComponent(digest)}` : '#';
        $('success-link').hidden = !digest;
        $('success-panel').hidden = false;
        setStatus('Alchemy complete. The wallet will be rescanned for remaining eligible balances.', 'success');
        invalidatePrepared();
        await scanWallet();
    } catch (error) {
        setStatus(`Alchemy was not executed: ${errorMessage(error)}`, 'error');
    } finally {
        state.executing = false;
        setBusyButton(button, false, '', 'Confirm Alchemy in Wallet');
        if (state.prepared) {
            if (preparedIsFresh(state.prepared)) schedulePreparedExpiry(state.prepared);
            else invalidatePrepared();
        }
        button.disabled = !state.prepared;
        renderSummary();
    }
}

function handleWalletChange(session) {
    const nextAddress = session?.address ? core.normalizeAddress(session.address) : '';
    if (nextAddress === state.address) return;
    state.address = nextAddress;
    resetForWallet();
    if (state.address) scanWallet();
}

function bindSlippage() {
    document.querySelectorAll('.slippage-button').forEach(button => {
        button.addEventListener('click', () => {
            state.slippage = Number(button.dataset.slippage);
            document.querySelectorAll('.slippage-button').forEach(candidate => {
                const selected = candidate === button;
                candidate.classList.toggle('border-brand-primary', selected);
                candidate.classList.toggle('text-brand-primary', selected);
                candidate.classList.toggle('bg-brand-primary/10', selected);
                candidate.classList.toggle('border-gray-700', !selected);
                candidate.classList.toggle('text-dark-text-secondary', !selected);
            });
            invalidatePrepared();
            renderSummary();
        });
    });
}

function init() {
    $('current-year').textContent = new Date().getFullYear();
    if (!window.AlphaCityWalletConnector) throw new Error('The universal wallet connector did not load');
    state.walletConnector = window.AlphaCityWalletConnector.create({
        button: $('connect-wallet-btn'),
        onChange: handleWalletChange,
    });
    $('rescan-button').addEventListener('click', () => scanWallet());
    $('prepare-button').addEventListener('click', () => prepareAlchemy());
    $('confirm-button').addEventListener('click', () => executeAlchemy());
    bindSlippage();
    render();
}

document.addEventListener('DOMContentLoaded', () => {
    try {
        init();
    } catch (error) {
        console.error('[alchemy] initialization failed', error);
        setStatus(`Alchemy could not start: ${errorMessage(error)}`, 'error');
    }
});
