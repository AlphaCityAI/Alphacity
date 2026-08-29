import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import core from '../shared/sluice-core.cjs';

const {
    TRIGGERS,
    COMPARISONS,
    STATUSES,
    normalizeAddress,
    normalizeCoinType,
    parseDecimalToBigInt,
    formatUnits,
    parseScheduleObject,
    calculateClaimable,
    triggerMetricName,
    selectPrimaryPair,
    observationFromPairs,
    canonicalTriggerConfig,
    encodeClaimMessage,
    encodeClaimFragment,
    decodeClaimFragment,
    hexToBytes,
} = core;

const CLOCK_ID = '0x6';
const SUI_TYPE = normalizeCoinType('0x2::sui::SUI');
const CITY_TYPE = normalizeCoinType('0x308fa16c7aead43e3a49a4ff2e76205ba2a12697234f4fe80a2da66515284060::city::CITY');
const CITY_STAKING_TYPE = `${normalizeAddress('0x008856d5d6d60a088f6153dbe6f7697d19f81d1d0403695c9e9fbaecdc8b29a9')}::city_staking::UserStake<${CITY_TYPE}>`;
const CREATION_GATE = 1_000_000n * 1_000_000_000n;
const DEFAULT_CONFIG = {
    network: 'mainnet',
    v2PackageAddress: '',
    legacyPackageAddress: '0x7c7ca3da6bad849a02d9f888b2f8cab40d507b2c01bbcab3f2d816334c17aa07',
    oraclePublicKeys: [],
    oracleThreshold: 1,
};
const CONFIG = { ...DEFAULT_CONFIG, ...(window.SLUICE_CONFIG || {}) };

const state = {
    address: null,
    schedules: [],
    metadata: new Map(),
    filter: 'all',
    claim: null,
    gate: null,
};
let walletConnector = null;
let schedulesRequest = null;
let tokenPreviewSequence = 0;

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bytesToHex = bytes => `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
const shortAddress = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—';
const sameAddress = (a, b) => {
    try { return normalizeAddress(a) === normalizeAddress(b); } catch (_) { return false; }
};

function configuredAddress(value) {
    try { return normalizeAddress(value); } catch (_) { return null; }
}

function v2Package() { return configuredAddress(CONFIG.v2PackageAddress); }
function legacyPackage() { return configuredAddress(CONFIG.legacyPackageAddress); }

function showStatus(message, kind = 'info') {
    const banner = $('status-banner');
    banner.dataset.kind = kind;
    banner.textContent = message;
    banner.hidden = false;
}

function clearStatus() { $('status-banner').hidden = true; }

function rpc(method, params) {
    if (!window.AlphaCitySui?.rpc) throw new Error('The Sui data client did not load');
    return window.AlphaCitySui.rpc(method, params);
}

function handleWalletChange(session) {
    state.address = session?.address ? normalizeAddress(session.address) : null;
    state.gate = null;
    renderSchedules();
    renderGate();
    renderClaimPanel();
    if (!state.address) return;
    Promise.all([refreshSchedules(), refreshGate()])
        .then(renderClaimPanel)
        .catch(error => showStatus(error.message, 'error'));
}

async function signAndExecute(tx, expectedAddress = state.address) {
    const session = walletConnector?.getSession?.();
    if (!expectedAddress || !sameAddress(state.address, expectedAddress)
        || !sameAddress(session?.address, expectedAddress)) {
        throw new Error('The connected wallet changed. Review the transaction again with the active account.');
    }
    tx.setSender(expectedAddress);
    const result = await walletConnector.signAndExecuteTransaction(tx);
    const status = result?.effects?.status?.status || result?.effects?.status;
    if (String(status || '').toLowerCase() === 'failure') {
        throw new Error(result.effects?.status?.error || 'The transaction failed on-chain');
    }
    return result;
}

async function queryAllSchedules(packageId, moduleName, structName) {
    if (!packageId) return [];
    const output = [];
    let cursor = null;
    do {
        const page = await rpc('suix_queryObjects', [{
            filter: { StructType: `${packageId}::${moduleName}::${structName}` },
            options: { showContent: true, showType: true },
        }, cursor, 50]);
        for (const object of (page.data || [])) {
            try { output.push(parseScheduleObject(object)); }
            catch (error) { console.warn('Skipping malformed Sluice schedule:', error, object); }
        }
        cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);
    return output;
}

async function loadSchedules() {
    $('refresh-schedules').disabled = true;
    try {
        const [v2, v1] = await Promise.all([
            queryAllSchedules(v2Package(), 'sluice_v2', 'VestingScheduleV2'),
            queryAllSchedules(legacyPackage(), 'sluice', 'VestingSchedule'),
        ]);
        state.schedules = [...v2, ...v1].sort((a, b) => Number(b.startTimeMs - a.startTimeMs));
        await hydrateMetadata(state.schedules);
        renderSchedules();
        await resolveClaimSchedule();
    } catch (error) {
        showStatus(`Could not refresh schedules: ${error.message}`, 'error');
    } finally {
        $('refresh-schedules').disabled = false;
    }
}

function refreshSchedules() {
    if (!schedulesRequest) {
        schedulesRequest = loadSchedules().finally(() => { schedulesRequest = null; });
    }
    return schedulesRequest;
}

async function getMetadata(coinType) {
    const cached = state.metadata.get(coinType);
    if (cached && !cached.unavailable) return cached;
    const metadata = await rpc('suix_getCoinMetadata', [coinType]);
    if (!metadata || !Number.isInteger(metadata.decimals)) {
        throw new Error(`Coin metadata is unavailable for ${coinType}; refusing to guess decimals`);
    }
    state.metadata.set(coinType, metadata);
    return metadata;
}

async function hydrateMetadata(schedules) {
    const types = [...new Set(schedules.map(schedule => schedule.coinType))];
    await Promise.all(types.map(type => getMetadata(type).catch(error => {
        console.warn(error.message);
        state.metadata.set(type, { decimals: 0, symbol: type.split('::').at(-1), unavailable: true });
    })));
}

async function refreshGate(requestedAddress = state.address) {
    if (!requestedAddress) {
        state.gate = null;
        renderGate();
        return;
    }
    const address = normalizeAddress(requestedAddress);
    try {
        const liquidResult = await rpc('suix_getBalance', [address, CITY_TYPE]);
        const liquid = BigInt(liquidResult?.totalBalance || 0);
        let staked = 0n;
        let cursor = null;
        do {
            const page = await rpc('suix_getOwnedObjects', [address, {
                filter: { StructType: CITY_STAKING_TYPE },
                options: { showContent: true },
            }, cursor, 50]);
            for (const item of (page.data || [])) {
                const value = item?.data?.content?.fields?.staked_amount;
                if (value != null) staked += BigInt(value?.fields?.value ?? value);
            }
            cursor = page.hasNextPage ? page.nextCursor : null;
        } while (cursor);
        if (!sameAddress(state.address, address)) return;
        state.gate = { liquid, staked, total: liquid + staked, allowed: liquid + staked >= CREATION_GATE };
    } catch (error) {
        if (!sameAddress(state.address, address)) return;
        state.gate = { error: error.message, allowed: false };
    }
    renderGate();
}

function renderGate() {
    const value = $('gate-status');
    const submit = $('create-submit');
    if (!state.address) {
        value.textContent = 'Connect a wallet to check creation access. Viewing and claiming remain public.';
    } else if (state.gate?.error) {
        value.textContent = `Creation access could not be verified: ${state.gate.error}`;
    } else if (state.gate) {
        value.textContent = state.gate.allowed
            ? `Creation unlocked · ${formatUnits(state.gate.total, 9, 2)} CITY liquid + staked`
            : `Creation requires 1,000,000 CITY · current liquid + staked: ${formatUnits(state.gate.total, 9, 2)}`;
    } else {
        value.textContent = 'Checking CITY balance…';
    }
    const unavailable = !v2Package();
    submit.disabled = unavailable || !state.gate?.allowed;
    $('deployment-status').hidden = !unavailable;
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function statusLabel(schedule) {
    if (schedule.balance === 0n && schedule.version === 1) return 'Completed / empty';
    if (schedule.version === 1) return ({ 0: 'Active', 1: 'Locked (legacy)', 2: 'Verifying (legacy)' })[schedule.legacyMilestoneStatus] || 'Legacy';
    return ({ 0: 'Pending trigger', 1: 'Active', 2: 'Cancelled', 3: 'Completed' })[schedule.status] || 'Unknown';
}

function metricLabel(kind) {
    return ({
        0: 'Time-based', 1: 'Market cap', 2: 'Fully diluted valuation',
        3: 'Token price', 4: 'Liquidity', 5: '24h volume',
        6: 'Holder count', 255: 'Custom oracle',
    })[kind] || 'Unknown trigger';
}

function formatTarget(schedule) {
    if (!schedule.triggerKind) return 'No market trigger';
    const sign = schedule.comparison === COMPARISONS.LTE ? '≤' : '≥';
    if (schedule.triggerKind === TRIGGERS.PRICE_USD_E8) return `${sign} $${formatUnits(schedule.targetValue, 8, 8)}`;
    if ([1, 2, 4, 5].includes(schedule.triggerKind)) return `${sign} $${schedule.targetValue.toLocaleString()}`;
    return `${sign} ${schedule.targetValue.toLocaleString()}`;
}

function addAction(container, label, handler, kind = '') {
    const button = element('button', `small-button ${kind}`, label);
    button.type = 'button';
    button.addEventListener('click', async () => {
        button.disabled = true;
        try { await handler(); } catch (error) { showStatus(error.message, 'error'); }
        finally { button.disabled = false; }
    });
    container.append(button);
}

function renderSchedules() {
    const container = $('schedule-list');
    container.replaceChildren();
    const filtered = state.schedules.filter(schedule => {
        if (state.filter === 'created') return state.address && sameAddress(schedule.creator, state.address);
        if (state.filter === 'beneficiary') return state.address && sameAddress(schedule.beneficiary, state.address);
        if (state.filter === 'active') return schedule.status === STATUSES.ACTIVE && schedule.balance > 0n;
        return true;
    });
    $('schedule-count').textContent = `${filtered.length} schedule${filtered.length === 1 ? '' : 's'}`;
    if (!filtered.length) {
        container.append(element('p', 'empty-state', 'No schedules match this view. Public discovery is paginated across all V1 and V2 objects.'));
        return;
    }

    for (const schedule of filtered) {
        const metadata = state.metadata.get(schedule.coinType) || { decimals: 0, symbol: schedule.coinType.split('::').at(-1) };
        const claimable = calculateClaimable(schedule, BigInt(Date.now()));
        const card = element('article', 'schedule-card');
        const head = element('div', 'schedule-head');
        const title = element('div');
        title.append(element('strong', '', `${formatUnits(schedule.totalAmount, metadata.decimals, 6)} ${metadata.symbol || 'TOKEN'}`));
        title.append(element('span', 'schedule-id', `${shortAddress(schedule.id)} · V${schedule.version}`));
        head.append(title, element('span', `status status-${schedule.status}`, statusLabel(schedule)));
        card.append(head);

        const grid = element('dl', 'schedule-grid');
        const rows = [
            ['Creator', shortAddress(schedule.creator)],
            ['Beneficiary', shortAddress(schedule.beneficiary)],
            ['Released', `${formatUnits(schedule.releasedAmount, metadata.decimals, 6)} ${metadata.symbol}`],
            ['Claimable now', `${formatUnits(claimable, metadata.decimals, 6)} ${metadata.symbol}`],
            ['Trigger', metricLabel(schedule.triggerKind)],
            ['Target', formatTarget(schedule)],
            ['Starts', schedule.startTimeMs ? new Date(Number(schedule.startTimeMs)).toLocaleString() : 'On activation'],
            ['Ends', schedule.endTimeMs ? new Date(Number(schedule.endTimeMs)).toLocaleString() : 'On activation'],
        ];
        rows.forEach(([label, value]) => {
            grid.append(element('dt', '', label), element('dd', '', value));
        });
        card.append(grid);

        if (schedule.version === 2 && schedule.status === STATUSES.PENDING && schedule.triggerKind) {
            const observation = schedule.lastObservedAtMs
                ? `Last observation: ${formatTarget({ ...schedule, targetValue: schedule.lastObservedValue })} at ${new Date(Number(schedule.lastObservedAtMs)).toLocaleString()}. Validation: ${Number(schedule.validationWindowMs / 60_000n)} minutes.`
                : `Waiting for the first signed observation. Validation: ${Number(schedule.validationWindowMs / 60_000n)} minutes; maximum sample gap: ${Number(schedule.maxSampleGapMs / 60_000n)} minutes.`;
            card.append(element('p', 'observation-note', observation));
        }
        if (schedule.version === 1) {
            card.append(element('p', 'legacy-note', 'Legacy V1 schedule. Claims remain available, but unsafe V1 cancellation and manual market activation are intentionally disabled here.'));
        }

        const actions = element('div', 'schedule-actions');
        if (schedule.status === STATUSES.ACTIVE && claimable > 0n) {
            addAction(actions, 'Claim vested', () => claimSchedule(schedule), 'primary');
        }
        if (schedule.version === 2 && schedule.revocable && state.address && sameAddress(schedule.creator, state.address)
            && [STATUSES.PENDING, STATUSES.ACTIVE].includes(schedule.status)) {
            addAction(actions, 'Cancel safely', () => cancelSchedule(schedule), 'danger');
        }
        if (schedule.version === 2 && state.address && sameAddress(schedule.beneficiary, state.address)
            && [STATUSES.PENDING, STATUSES.ACTIVE].includes(schedule.status)) {
            addAction(actions, 'Change beneficiary', () => reassignSchedule(schedule));
        }
        if (schedule.version === 2 && schedule.status === STATUSES.PENDING
            && schedule.triggerDeadlineMs > 0n && BigInt(Date.now()) >= schedule.triggerDeadlineMs) {
            addAction(actions, 'Resolve expired trigger', () => resolveExpired(schedule));
        }
        const explorer = element('a', 'small-button', 'View on SuiVision');
        explorer.href = `https://suivision.xyz/object/${schedule.id}`;
        explorer.target = '_blank';
        explorer.rel = 'noopener noreferrer';
        actions.append(explorer);
        card.append(actions);
        container.append(card);
    }
}

async function preparePayment(tx, coinType, amount, owner = state.address) {
    if (amount <= 0n) throw new Error('Token amount must be greater than zero');
    if (coinType === SUI_TYPE) {
        const balance = await rpc('suix_getBalance', [owner, coinType]);
        if (BigInt(balance?.totalBalance || 0) <= amount) throw new Error('Keep additional SUI available for gas');
        return tx.splitCoins(tx.gas, [tx.pure.u64(amount)])[0];
    }
    const selected = [];
    let total = 0n;
    let cursor = null;
    do {
        const page = await rpc('suix_getCoins', [owner, coinType, cursor, 50]);
        for (const coin of (page.data || [])) {
            selected.push(coin);
            total += BigInt(coin.balance);
            if (total >= amount) break;
        }
        if (total >= amount) break;
        cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);
    if (total < amount) throw new Error('Insufficient token balance');
    const primary = tx.object(selected[0].coinObjectId);
    if (selected.length > 1) tx.mergeCoins(primary, selected.slice(1).map(coin => tx.object(coin.coinObjectId)));
    return tx.splitCoins(primary, [tx.pure.u64(amount)])[0];
}

function parseDate(id) {
    const value = new Date($(id).value).getTime();
    if (!Number.isFinite(value)) throw new Error(`Enter a valid ${id.includes('start') ? 'start' : 'end'} date`);
    return BigInt(value);
}

function intervalMilliseconds(value) {
    return BigInt(({ hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000, monthly: 2_592_000_000, cliff: 0 })[value] ?? 1_000);
}

async function sha256Bytes(text) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function fetchJson(url, options = {}, timeoutMs = 12_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        if (controller.signal.aborted) throw new Error('DexScreener did not respond in time');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchDexPairs(coinType) {
    const payload = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(coinType)}`, {
        headers: { accept: 'application/json' },
    });
    return payload.pairs || [];
}

async function validateTriggerFeed({ coinType, triggerKind, minLiquidityUsd }) {
    const pairs = await fetchDexPairs(coinType);
    return observationFromPairs({ coinType, triggerKind, minLiquidityUsd }, pairs);
}

function oracleKeys() {
    const keys = (CONFIG.oraclePublicKeys || []).map(value => {
        const clean = String(value).replace(/^0x/, '');
        if (!/^[0-9a-f]{64}$/i.test(clean)) throw new Error('Runtime oracle public keys must be 32-byte hex values');
        return Array.from(clean.match(/../g), byte => parseInt(byte, 16));
    });
    return keys;
}

async function createSchedule(event) {
    event.preventDefault();
    clearStatus();
    const packageId = v2Package();
    if (!packageId) throw new Error('Sluice V2 is not deployed/configured yet');
    if (!state.address) throw new Error('Connect a wallet first');
    const creatorAddress = state.address;
    await refreshGate(creatorAddress);
    if (!sameAddress(state.address, creatorAddress)) throw new Error('The connected wallet changed; review the schedule again');
    if (!state.gate?.allowed) throw new Error('Creation requires 1,000,000 CITY, including supported staked CITY');

    const coinType = normalizeCoinType($('coin-type').value);
    const metadata = await getMetadata(coinType);
    if (metadata.unavailable) throw new Error('Token decimals could not be verified');
    const amount = parseDecimalToBigInt($('token-amount').value, metadata.decimals);
    if (amount <= 0n) throw new Error('Token amount must be greater than zero');
    const start = parseDate('start-date');
    const end = parseDate('end-date');
    if (end <= start) throw new Error('End date must be after start date');
    const duration = end - start;
    let interval = intervalMilliseconds($('unlock-frequency').value);
    if ($('unlock-frequency').value === 'cliff') interval = duration;
    if (interval > duration) throw new Error('Unlock interval cannot exceed schedule duration');

    const recipientMode = document.querySelector('input[name="recipient-mode"]:checked').value;
    let beneficiary;
    let claimKeypair = null;
    const recipient = $('beneficiary').value.trim();
    if (recipientMode === 'link') {
        if (!recipient) throw new Error('Enter the email or phone number used to share the claim link');
        claimKeypair = new Ed25519Keypair();
        beneficiary = normalizeAddress(claimKeypair.getPublicKey().toSuiAddress());
    } else {
        beneficiary = normalizeAddress(recipient);
    }

    const clientReference = crypto.getRandomValues(new Uint8Array(16));
    const triggerKind = Number($('trigger-kind').value);
    const tx = new Transaction();
    const payment = await preparePayment(tx, coinType, amount, creatorAddress);
    if (triggerKind === TRIGGERS.TIME) {
        tx.moveCall({
            target: `${packageId}::sluice_v2::create_time_schedule`,
            typeArguments: [coinType],
            arguments: [
                payment,
                tx.pure.address(beneficiary),
                tx.pure.u64(start),
                tx.pure.u64(end),
                tx.pure.u64(interval),
                tx.pure.bool($('revocable').checked),
                tx.pure.vector('u8', clientReference),
            ],
        });
    } else {
        const keys = oracleKeys();
        const threshold = Number(CONFIG.oracleThreshold || 1);
        if (!keys.length || threshold < 1 || threshold > keys.length) {
            throw new Error('Triggered creation is disabled until a valid public oracle policy is configured');
        }
        const comparison = Number($('trigger-comparison').value);
        const targetDecimals = triggerKind === TRIGGERS.PRICE_USD_E8 ? 8 : 0;
        const target = parseDecimalToBigInt($('trigger-target').value, targetDecimals);
        if (target <= 0n) throw new Error('Trigger target must be greater than zero');
        const minLiquidity = parseDecimalToBigInt($('minimum-liquidity').value || '0', 0);
        const validationWindow = BigInt($('validation-minutes').value) * 60_000n;
        const maxGap = BigInt($('sample-gap-minutes').value) * 60_000n;
        if (maxGap <= 0n || (validationWindow > 0n && maxGap > validationWindow)) {
            throw new Error('Maximum sample gap must be positive and no longer than the validation window');
        }
        const deadlineText = $('trigger-deadline').value;
        const deadlineMs = deadlineText ? new Date(deadlineText).getTime() : 0;
        if (!Number.isFinite(deadlineMs)) throw new Error('Enter a valid trigger deadline');
        const deadline = BigInt(deadlineMs);
        const now = BigInt(Date.now());
        if (deadline && deadline <= now) throw new Error('Trigger deadline must be in the future');
        if (deadline && deadline - now < validationWindow) {
            throw new Error('Trigger deadline must leave enough time for the full validation window');
        }
        showStatus('Checking the exact DexScreener feed before funds are committed…', 'info');
        const feed = await validateTriggerFeed({ coinType, triggerKind, minLiquidityUsd: minLiquidity });
        showStatus(`Feed verified at $${feed.liquidity.toLocaleString()} liquidity. Confirm the V2 schedule transaction in your wallet…`, 'info');
        const canonical = canonicalTriggerConfig({ coinType, triggerKind, minLiquidityUsd: minLiquidity });
        const configHash = await sha256Bytes(canonical);
        tx.moveCall({
            target: `${packageId}::sluice_v2::create_triggered_schedule`,
            typeArguments: [coinType],
            arguments: [
                payment,
                tx.pure.address(beneficiary),
                tx.pure.u64(start),
                tx.pure.u64(duration),
                tx.pure.u64(interval),
                tx.pure.u8(triggerKind),
                tx.pure.u8(comparison),
                tx.pure.u64(target),
                tx.pure.vector('u8', configHash),
                tx.pure.u64(minLiquidity),
                tx.pure.u64(validationWindow),
                tx.pure.u64(maxGap),
                tx.pure.u64(10n * 60_000n),
                tx.pure.vector('vector<u8>', keys),
                tx.pure.u8(threshold),
                tx.pure.u64(deadline),
                tx.pure.u8(Number($('fallback-policy').value)),
                tx.pure.bool($('revocable').checked),
                tx.pure.vector('u8', clientReference),
                tx.object(CLOCK_ID),
            ],
        });
    }

    if (triggerKind === TRIGGERS.TIME) showStatus('Confirm the V2 schedule transaction in your wallet…', 'info');
    const result = await signAndExecute(tx, creatorAddress);
    showStatus('Schedule created on-chain. Waiting for indexer confirmation…', 'success');
    let scheduleId = createdScheduleId(result);
    for (let attempt = 0; !scheduleId && attempt < 8; attempt += 1) {
        await sleep(1_500);
        const schedules = await queryAllSchedules(packageId, 'sluice_v2', 'VestingScheduleV2');
        const match = schedules.find(schedule => sameAddress(schedule.creator, creatorAddress)
            && bytesToHex(schedule.clientReference) === bytesToHex(clientReference));
        if (match) scheduleId = match.id;
    }

    if (claimKeypair) {
        showClaimLink({
            v: 2,
            scheduleId,
            clientReference: bytesToHex(clientReference),
            coinType,
            secretKey: claimKeypair.getSecretKey(),
        }, recipient, amount, metadata.symbol);
    }
    event.target.reset();
    $('token-preview').removeAttribute('data-kind');
    $('token-preview').textContent = 'Token metadata is verified before any amount is converted. Sluice never guesses decimals.';
    setDefaultDates();
    toggleTriggerFields();
    await refreshSchedules();
}

function createdScheduleId(result) {
    const event = (result?.events || []).find(item => String(item.type || '').endsWith('::ScheduleCreatedV2'));
    const fromEvent = event?.parsedJson?.schedule_id;
    if (fromEvent) return normalizeAddress(fromEvent);
    const change = (result?.objectChanges || []).find(item => item.type === 'created'
        && String(item.objectType || '').includes('::sluice_v2::VestingScheduleV2<'));
    return change?.objectId ? normalizeAddress(change.objectId) : null;
}

async function claimSchedule(schedule) {
    if (!state.address) throw new Error('Connect a wallet to sponsor the claim transaction');
    const tx = new Transaction();
    tx.moveCall({
        target: schedule.version === 2
            ? `${v2Package()}::sluice_v2::claim_vested`
            : `${legacyPackage()}::sluice::claim_vested`,
        typeArguments: [schedule.coinType],
        arguments: [tx.object(schedule.id), tx.object(CLOCK_ID)],
    });
    showStatus('Confirm the vested-token claim in your wallet…', 'info');
    await signAndExecute(tx);
    showStatus('Vested tokens were sent directly to the beneficiary.', 'success');
    await sleep(1_000);
    await refreshSchedules();
}

async function cancelSchedule(schedule) {
    if (!confirm('Cancel this V2 schedule? Already vested tokens will be paid to the beneficiary and only unvested tokens will return to you.')) return;
    const tx = new Transaction();
    tx.moveCall({
        target: `${v2Package()}::sluice_v2::cancel_schedule`,
        typeArguments: [schedule.coinType],
        arguments: [tx.object(schedule.id), tx.object(CLOCK_ID)],
    });
    showStatus('Confirm safe cancellation in your wallet…', 'info');
    await signAndExecute(tx);
    showStatus('Schedule cancelled: vested entitlement paid, unvested remainder refunded.', 'success');
    await sleep(1_000);
    await refreshSchedules();
}

async function reassignSchedule(schedule) {
    const value = prompt('New beneficiary Sui address:');
    if (!value) return;
    const beneficiary = normalizeAddress(value);
    const tx = new Transaction();
    tx.moveCall({
        target: `${v2Package()}::sluice_v2::reassign_beneficiary`,
        typeArguments: [schedule.coinType],
        arguments: [tx.object(schedule.id), tx.pure.address(beneficiary)],
    });
    await signAndExecute(tx);
    showStatus('Beneficiary changed on-chain.', 'success');
    await refreshSchedules();
}

async function resolveExpired(schedule) {
    const tx = new Transaction();
    tx.moveCall({
        target: `${v2Package()}::sluice_v2::resolve_expired_trigger`,
        typeArguments: [schedule.coinType],
        arguments: [tx.object(schedule.id), tx.object(CLOCK_ID)],
    });
    await signAndExecute(tx);
    showStatus(schedule.fallbackPolicy === 1 ? 'Expired trigger activated by its fallback.' : 'Expired trigger refunded to its creator.', 'success');
    await refreshSchedules();
}

function showClaimLink(payload, contact, amount, symbol) {
    const encoded = encodeClaimFragment(payload);
    const url = `${location.origin}${location.pathname}#claim=${encoded}`;
    $('claim-url').value = url;
    $('claim-modal-summary').textContent = `A bearer claim link for ${formatUnits(amount, state.metadata.get(payload.coinType)?.decimals || 0, 6)} ${symbol}. Anyone with this link controls reassignment until it is claimed.`;
    const subject = encodeURIComponent('A Sluice vesting schedule is ready for you');
    const body = encodeURIComponent(`A token vesting schedule was created for you on Sluice. Connect a Sui wallet and claim ownership using this private link:\n\n${url}\n\nDo not forward the link.`);
    $('email-claim-link').href = contact.includes('@') ? `mailto:${encodeURIComponent(contact)}?subject=${subject}&body=${body}` : '#';
    $('email-claim-link').hidden = !contact.includes('@');
    $('claim-modal').showModal();
}

function loadClaimPayload() {
    try {
        const fragment = new URLSearchParams(location.hash.slice(1)).get('claim');
        const query = new URLSearchParams(location.search);
        if (fragment) {
            state.claim = decodeClaimFragment(fragment);
            sessionStorage.setItem('sluice_active_claim', JSON.stringify(state.claim));
            history.replaceState({}, document.title, location.pathname);
        } else if (query.get('claimKey')) {
            state.claim = { v: 1, secretKey: query.get('claimKey') };
            sessionStorage.setItem('sluice_active_claim', JSON.stringify(state.claim));
            history.replaceState({}, document.title, location.pathname);
        } else {
            const stored = sessionStorage.getItem('sluice_active_claim');
            if (stored) state.claim = JSON.parse(stored);
        }
    } catch (error) {
        sessionStorage.removeItem('sluice_active_claim');
        showStatus(`This claim link is invalid: ${error.message}`, 'error');
    }
    renderClaimPanel();
}

async function resolveClaimSchedule() {
    if (!state.claim) return;
    let match = state.claim.scheduleId
        ? state.schedules.find(schedule => sameAddress(schedule.id, state.claim.scheduleId))
        : null;
    if (!match) {
        try {
            const keypair = Ed25519Keypair.fromSecretKey(state.claim.secretKey);
            const escrowAddress = normalizeAddress(keypair.getPublicKey().toSuiAddress());
            match = state.schedules.find(schedule => sameAddress(schedule.beneficiary, escrowAddress)
                && (!state.claim.clientReference
                    || bytesToHex(schedule.clientReference) === state.claim.clientReference));
        } catch (_) {}
    }
    state.claimSchedule = match || null;
    renderClaimPanel();
}

function renderClaimPanel() {
    const panel = $('claim-panel');
    panel.hidden = !state.claim;
    if (!state.claim) return;
    $('claim-description').textContent = state.claimSchedule
        ? `Private claim link found for schedule ${shortAddress(state.claimSchedule.id)}. Connect the wallet that should become beneficiary.`
        : 'Private claim link found. Schedule discovery is still indexing; refresh or connect a wallet to retry.';
    $('accept-claim').disabled = !state.address || !state.claimSchedule;
    $('accept-claim').textContent = state.address ? `Assign to ${shortAddress(state.address)}` : 'Connect wallet to accept';
}

async function acceptClaim() {
    if (!state.address || !state.claimSchedule || !state.claim) throw new Error('Connect a wallet and wait for schedule discovery');
    const schedule = state.claimSchedule;
    if (sameAddress(schedule.beneficiary, state.address)) {
        sessionStorage.removeItem('sluice_active_claim');
        state.claim = null;
        state.claimSchedule = null;
        renderClaimPanel();
        showStatus('This wallet is already the schedule beneficiary.', 'success');
        return;
    }
    const keypair = Ed25519Keypair.fromSecretKey(state.claim.secretKey);
    const pubkey = keypair.getPublicKey().toRawBytes();
    const tx = new Transaction();
    if (schedule.version === 2) {
        const validUntil = BigInt(Date.now() + 10 * 60_000);
        const message = encodeClaimMessage({
            scheduleId: schedule.id,
            currentBeneficiary: schedule.beneficiary,
            newBeneficiary: state.address,
            validUntilMs: validUntil,
        });
        const signature = await keypair.sign(message);
        tx.moveCall({
            target: `${v2Package()}::sluice_v2::reassign_beneficiary_by_signature`,
            typeArguments: [schedule.coinType],
            arguments: [
                tx.object(schedule.id),
                tx.pure.vector('u8', pubkey),
                tx.pure.vector('u8', signature),
                tx.pure.address(state.address),
                tx.pure.u64(validUntil),
                tx.object(CLOCK_ID),
            ],
        });
    } else {
        const message = Uint8Array.from([...hexToBytes(schedule.id), ...hexToBytes(state.address)]);
        const signature = await keypair.sign(message);
        tx.moveCall({
            target: `${legacyPackage()}::sluice::reassign_beneficiary`,
            typeArguments: [schedule.coinType],
            arguments: [
                tx.object(schedule.id),
                tx.pure.vector('u8', pubkey),
                tx.pure.vector('u8', signature),
                tx.pure.address(state.address),
            ],
        });
    }
    showStatus('Confirm beneficiary reassignment in your wallet…', 'info');
    await signAndExecute(tx);
    sessionStorage.removeItem('sluice_active_claim');
    state.claim = null;
    state.claimSchedule = null;
    renderClaimPanel();
    showStatus('Claim accepted. Your wallet is now the on-chain beneficiary.', 'success');
    await refreshSchedules();
}

async function previewToken() {
    const output = $('token-preview');
    const sequence = ++tokenPreviewSequence;
    output.dataset.kind = 'loading';
    output.textContent = 'Checking token metadata and the exact DexScreener base-token feed…';
    try {
        const coinType = normalizeCoinType($('coin-type').value);
        const metadata = await getMetadata(coinType);
        const pairs = await fetchDexPairs(coinType);
        const pair = selectPrimaryPair(pairs, coinType);
        if (!pair) throw new Error(`${metadata.symbol} has no exact-base-token DexScreener pair; market triggers cannot be serviced`);
        const summary = `${metadata.symbol} · ${metadata.decimals} decimals · ${pair.dexId || 'unknown'} ${pair.baseToken?.symbol || 'TOKEN'}/${pair.quoteToken?.symbol || 'PAIR'} · liquidity $${Number(pair.liquidity?.usd || 0).toLocaleString()} · market cap ${pair.marketCap == null ? 'unavailable' : `$${Number(pair.marketCap).toLocaleString()}`} · FDV ${pair.fdv == null ? 'unavailable' : `$${Number(pair.fdv).toLocaleString()}`}`;
        const triggerKind = Number($('trigger-kind').value);
        if (triggerKind === TRIGGERS.TIME) {
            if (sequence !== tokenPreviewSequence) return;
            output.dataset.kind = 'ok';
            output.textContent = summary;
            return;
        }
        const minLiquidityUsd = parseDecimalToBigInt($('minimum-liquidity').value || '0', 0);
        const observation = observationFromPairs({ coinType, triggerKind, minLiquidityUsd }, pairs);
        if (sequence !== tokenPreviewSequence) return;
        output.dataset.kind = 'ok';
        output.textContent = `${summary} · selected ${triggerMetricName(triggerKind)} feed is serviceable now (${observation.observedValue.toLocaleString()}).`;
    } catch (error) {
        if (sequence !== tokenPreviewSequence) return;
        output.dataset.kind = 'error';
        output.textContent = error.message;
    }
}

function toggleTriggerFields() {
    const kind = Number($('trigger-kind').value);
    $('trigger-fields').hidden = kind === TRIGGERS.TIME;
    $('trigger-target').required = kind !== TRIGGERS.TIME;
    $('target-units').textContent = kind === TRIGGERS.PRICE_USD_E8
        ? 'USD per token (up to 8 decimals)'
        : [1, 2, 4, 5].includes(kind) ? 'whole USD' : 'integer units';
    if ($('coin-type').value.trim()) previewToken();
}

function toggleRecipient() {
    const link = document.querySelector('input[name="recipient-mode"]:checked').value === 'link';
    $('beneficiary-label').textContent = link ? 'Recipient email or phone (not stored on-chain)' : 'Beneficiary Sui address';
    $('beneficiary').placeholder = link ? 'name@example.com or +1…' : '0x…';
}

function setDefaultDates() {
    const start = new Date(Date.now() + 5 * 60_000);
    const end = new Date(start.getTime() + 30 * 86_400_000);
    const deadline = new Date(Date.now() + 90 * 86_400_000);
    const local = date => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    $('start-date').value = local(start);
    $('end-date').value = local(end);
    $('trigger-deadline').value = local(deadline);
}

async function init() {
    setDefaultDates();
    toggleTriggerFields();
    toggleRecipient();
    loadClaimPayload();
    renderGate();
    if (!window.AlphaCityWalletConnector) throw new Error('The shared wallet connector did not load');
    walletConnector = window.AlphaCityWalletConnector.create({
        button: $('connect-wallet'),
        onChange: handleWalletChange,
    });
    $('create-form').addEventListener('submit', event => createSchedule(event).catch(error => showStatus(error.message, 'error')));
    $('refresh-schedules').addEventListener('click', refreshSchedules);
    $('schedule-filter').addEventListener('change', event => { state.filter = event.target.value; renderSchedules(); });
    $('trigger-kind').addEventListener('change', toggleTriggerFields);
    document.querySelectorAll('input[name="recipient-mode"]').forEach(input => input.addEventListener('change', toggleRecipient));
    $('coin-type').addEventListener('blur', previewToken);
    $('minimum-liquidity').addEventListener('blur', () => {
        if ($('coin-type').value.trim() && Number($('trigger-kind').value) !== TRIGGERS.TIME) previewToken();
    });
    $('accept-claim').addEventListener('click', () => acceptClaim().catch(error => showStatus(error.message, 'error')));
    $('dismiss-claim').addEventListener('click', () => {
        sessionStorage.removeItem('sluice_active_claim');
        state.claim = null;
        state.claimSchedule = null;
        renderClaimPanel();
    });
    $('copy-claim-link').addEventListener('click', async () => {
        await navigator.clipboard.writeText($('claim-url').value);
        $('copy-claim-link').textContent = 'Copied';
    });
    $('close-claim-modal').addEventListener('click', () => $('claim-modal').close());
    await refreshSchedules();
}

document.addEventListener('DOMContentLoaded', () => init().catch(error => showStatus(error.message, 'error')));
