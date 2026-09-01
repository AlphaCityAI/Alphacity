import { Transaction } from '@mysten/sui/transactions';

const core = window.AlphaCityLaunchpadCore;
const CLOCK_ID = '0x6';
const SUI_TYPE = '0x2::sui::SUI';
const REGISTRY_URL = '/launchpad/collections/index.json';
const REFRESH_INTERVAL_MS = 30_000;
const WalletMintKey = 'WalletMintKey';
const AllowlistKey = 'AllowlistKey';
const state = {
    registry: null,
    collection: null,
    collectionId: '',
    collectionUrl: '',
    wallet: null,
    walletConnector: null,
    quantity: 1,
    balanceMist: null,
    onchain: null,
    activeStage: null,
    eligibility: null,
    busy: false,
    refreshPromise: null,
    walletEpoch: 0,
    collectionEpoch: 0,
    onchainReadEpoch: 0,
};

const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const numberFormat = (value) => Number(value || 0).toLocaleString();
const rpc = (method, params) => {
    if (!window.AlphaCitySui?.rpc) throw new Error('The Sui data service is unavailable.');
    return window.AlphaCitySui.rpc(method, params);
};

function resolveUrl(path, base = state.collectionUrl || window.location.href) {
    return path ? new URL(path, base).toString() : '';
}

function firstNumber(...values) {
    const found = values.find((value) => value !== undefined && value !== null && value !== '');
    const parsed = Number(found || 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

function chainFields(value) {
    if (!value || typeof value !== 'object') return {};
    return value.fields && typeof value.fields === 'object' ? value.fields : value;
}

function chainString(value) {
    if (typeof value === 'string') return value;
    const fields = chainFields(value);
    return fields.bytes || fields.value || '';
}

function contractMode() {
    return state.collection?.contract?.mode || 'coming-soon';
}

function isManagedDropMode() {
    return ['managed-drop', 'enabled'].includes(contractMode());
}

function configuredContract() {
    const contract = state.collection?.contract;
    const moduleName = String(contract?.module || 'managed_drop');
    const manifest = deploymentManifest(contract?.deploymentManifest);
    const upgradePolicy = String(contract?.upgradePolicy || '');
    if (!isManagedDropMode()
        || !nonzeroSuiAddress(contract?.packageId)
        || !nonzeroSuiAddress(contract?.dropId)
        || !manifest
        || !collectionMatchesDeploymentManifest(state.collection, manifest)
        || !['immutable', 'multisig'].includes(upgradePolicy)
        || (upgradePolicy === 'multisig' && !nonzeroSuiAddress(contract?.upgradeAuthority))
        || !nonzeroSuiAddress(contract?.displayAuthority)
        || !nonzeroSuiAddress(contract?.adminAuthority)
        || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleName)) return null;
    return {
        packageId: core.normalizeSuiAddress(contract.packageId),
        dropId: core.normalizeSuiAddress(contract.dropId),
        module: moduleName,
        manifest,
        upgradePolicy,
        upgradeAuthority: core.normalizeSuiAddress(contract.upgradeAuthority || ''),
        displayAuthority: core.normalizeSuiAddress(contract.displayAuthority || ''),
        adminAuthority: core.normalizeSuiAddress(contract.adminAuthority || ''),
    };
}

function nonzeroSuiAddress(value) {
    const address = core.normalizeSuiAddress(value || '');
    return Boolean(address && !/^0x0{64}$/.test(address));
}

function collectionMatchesDeploymentManifest(collection, manifest) {
    if (!collection || !manifest) return false;
    if (String(collection.name || '') !== manifest.collectionName
        || String(collection.description || '') !== manifest.collectionDescription
        || core.normalizeSuiAddress(collection.creator?.address || '') !== manifest.creatorAddress
        || Number(collection.supply) !== manifest.totalSupply
        || Number(collection.publicSupply) !== manifest.publicSupply
        || Number(collection.reservedSupply) !== manifest.reservedSupply
        || Number(collection.platformFeeBps) !== manifest.platformFeeBps
        || Number(collection.royaltyBps) !== manifest.royaltyBps
        || Number(collection.maxPerTx) !== manifest.maxPerTx
        || collection.network?.name !== 'Sui Mainnet'
        || collection.network?.chain !== 'sui:mainnet'
        || collection.network?.coinType !== SUI_TYPE
        || collection.assignmentPolicy !== manifest.assignmentPolicy) return false;
    const phases = Array.isArray(collection.phases) ? collection.phases : [];
    if (phases.length !== manifest.stages.length) return false;
    return phases.every((phase, index) => {
        const expected = manifest.stages[index];
        let priceMist;
        try { priceMist = String(phase.priceMist ?? core.suiToMist(String(phase.priceSui ?? '')).toString()); }
        catch (_) { return false; }
        return Number(phase.id) === expected.id
            && String(phase.name || '') === expected.name
            && priceMist === expected.priceMist
            && Number(phase.startTimeMs) === expected.startTimeMs
            && Number(phase.endTimeMs) === expected.endTimeMs
            && Number(phase.walletLimit) === expected.walletLimit
            && Number(phase.allocation) === expected.allocation
            && Boolean(phase.allowlistOnly) === expected.allowlistOnly;
    });
}

function deploymentManifest(value) {
    if (!value || typeof value !== 'object' || value.assignmentPolicy !== core.ASSIGNMENT_POLICY) return null;
    const creatorAddress = core.normalizeSuiAddress(value.creatorAddress || '');
    const platformTreasury = core.normalizeSuiAddress(value.platformTreasury || '');
    const collectionName = String(value.collectionName || '');
    const collectionDescription = String(value.collectionDescription || '');
    const numberFields = ['platformFeeBps', 'royaltyBps', 'totalSupply', 'publicSupply', 'reservedSupply', 'maxPerTx', 'expectedStageCount', 'expectedAllowlistEntryCount'];
    const numbers = Object.fromEntries(numberFields.map((field) => [field, Number(value[field])]));
    const stages = Array.isArray(value.stages) ? value.stages.map((stage) => {
        const priceMist = String(stage?.priceMist ?? '');
        const numeric = ['id', 'startTimeMs', 'endTimeMs', 'walletLimit', 'allocation']
            .reduce((result, field) => ({ ...result, [field]: Number(stage?.[field]) }), {});
        if (!stage || !String(stage.name || '') || !/^\d+$/.test(priceMist)
            || BigInt(priceMist) > core.U64_MAX
            || Object.values(numeric).some((entry) => !Number.isSafeInteger(entry) || entry < 0)
            || numeric.walletLimit < 1
            || typeof stage.allowlistOnly !== 'boolean') return null;
        return { ...numeric, name: String(stage.name), priceMist, allowlistOnly: stage.allowlistOnly };
    }) : [];
    if (!creatorAddress || !platformTreasury || !collectionName || !collectionDescription
        || numberFields.some((field) => !Number.isSafeInteger(numbers[field]) || numbers[field] < 0)
        || numbers.maxPerTx < 1 || numbers.maxPerTx > 50
        || numbers.publicSupply < 1 || numbers.totalSupply !== numbers.publicSupply + numbers.reservedSupply
        || numbers.expectedStageCount < 1 || stages.length !== numbers.expectedStageCount
        || stages.some((stage) => !stage)) return null;
    return {
        ...numbers,
        creatorAddress,
        platformTreasury,
        collectionName,
        collectionDescription,
        stages,
        assignmentPolicy: value.assignmentPolicy,
    };
}

function isManagedDrop() {
    return Boolean(configuredContract());
}

function isManagedDropMisconfigured() {
    return isManagedDropMode() && !configuredContract();
}

function currentSupply() {
    return firstNumber(state.onchain?.publicSupply, state.onchain?.totalSupply, state.collection?.publicSupply, state.collection?.supply);
}

function currentMinted() {
    return firstNumber(state.onchain?.mintedPublic, state.collection?.minted);
}

function currentPriceMist() {
    if (state.activeStage?.priceMist != null) return BigInt(state.activeStage.priceMist);
    return core.suiToMist(String(state.collection?.priceSui || '0'));
}

function currentEligibility() {
    if (!state.wallet?.address || !state.activeStage || !state.eligibility) return null;
    if (String(state.eligibility.wallet).toLowerCase() !== String(state.wallet.address).toLowerCase()) return null;
    return Number(state.eligibility.stageId) === Number(state.activeStage.id) ? state.eligibility : null;
}

function maxQuantityFor(onchain, stage, eligibility, collection) {
    const transactionLimit = Math.max(1, firstNumber(onchain?.maxPerTx, collection?.maxPerTx, 1));
    const walletLimit = Math.max(1, firstNumber(stage?.walletLimit, transactionLimit));
    const supply = firstNumber(onchain?.publicSupply, onchain?.totalSupply, collection?.publicSupply, collection?.supply);
    const minted = firstNumber(onchain?.mintedPublic, collection?.minted);
    const supplyRemaining = Math.max(0, supply - minted);
    const stageRemaining = stage?.allocation
        ? Math.max(0, stage.allocation - stage.minted)
        : Number.POSITIVE_INFINITY;
    const walletRemaining = eligibility?.status === 'eligible' ? eligibility.remaining : walletLimit;
    if (eligibility?.status === 'ineligible') return 0;
    return Math.max(0, Math.min(transactionLimit, walletLimit, walletRemaining, supplyRemaining, stageRemaining));
}

function maxQuantity() {
    return maxQuantityFor(state.onchain, state.activeStage, currentEligibility(), state.collection);
}

function formatSui(mist) {
    if (mist == null) return '—';
    const [whole, fraction = ''] = core.mistToSui(mist).split('.');
    const grouped = BigInt(whole).toLocaleString();
    return `${grouped}${fraction ? `.${fraction}` : ''} SUI`;
}

function formatDate(timestamp) {
    if (!timestamp) return 'No end time';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

function shortAddress(address) {
    return window.AlphaCityWalletConnector?.shortAddress(address) || address;
}

function safeExternalUrl(value) {
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
    } catch (_) { return ''; }
}

function explorerUrl(digest) {
    return `https://suivision.xyz/txblock/${encodeURIComponent(digest)}`;
}

function transactionFailure(result) {
    const failed = result?.FailedTransaction;
    if (failed) return failed.error?.message || failed.error || 'The transaction failed on-chain.';
    const status = result?.effects?.status || result?.Transaction?.effects?.status;
    const value = status?.status || status?.success;
    if (value === false || String(value || '').toLowerCase() === 'failure') return status?.error || 'The transaction failed on-chain.';
    return '';
}

function showStatus(message, type = 'info', link) {
    const element = byId('mint-status');
    const styles = {
        info: 'border-blue-500/30 bg-blue-500/10 text-blue-100',
        success: 'border-green-500/30 bg-green-500/10 text-green-100',
        error: 'border-red-500/30 bg-red-500/10 text-red-100',
    };
    element.className = `mt-4 rounded-2xl border px-4 py-3 text-sm ${styles[type] || styles.info}`;
    element.replaceChildren(document.createTextNode(message));
    if (link) {
        const anchor = document.createElement('a');
        anchor.href = link;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.className = 'ml-2 font-semibold underline';
        anchor.textContent = 'View transaction';
        element.append(anchor);
    }
    element.classList.remove('hidden');
}

function hideStatus() {
    byId('mint-status').classList.add('hidden');
}

async function fetchJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load ${url} (${response.status}).`);
    return response.json();
}

function parseChainStage(stageValue, index) {
    const stage = chainFields(stageValue);
    return {
        id: firstNumber(stage.id, index),
        name: chainString(stage.name) || `Stage ${index + 1}`,
        priceMist: String(stage.price_mist ?? stage.priceMist ?? '0'),
        startTimeMs: firstNumber(stage.start_time_ms, stage.startTimeMs),
        endTimeMs: firstNumber(stage.end_time_ms, stage.endTimeMs),
        walletLimit: firstNumber(stage.wallet_limit, stage.walletLimit),
        allocation: firstNumber(stage.allocation),
        minted: firstNumber(stage.minted),
        allowlistOnly: Boolean(stage.allowlist_only ?? stage.allowlistOnly),
    };
}

function selectActiveStage(stages, now = Date.now()) {
    const current = stages.find((stage) => stage.startTimeMs <= now && (!stage.endTimeMs || stage.endTimeMs > now) && (!stage.allocation || stage.minted < stage.allocation));
    if (current) return current;
    return stages.filter((stage) => stage.startTimeMs > now).sort((a, b) => a.startTimeMs - b.startTimeMs)[0] || null;
}

function isMissingDynamicField(error) {
    return /not found|does not exist|could not find|unknown object/i.test(String(error?.message || error || ''));
}

function decodeBcsBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (Array.isArray(value)) return Uint8Array.from(value);
    const text = String(value || '').trim();
    if (/^0x[0-9a-f]+$/i.test(text)) {
        const hex = text.slice(2).padStart(Math.ceil((text.length - 2) / 2) * 2, '0');
        return Uint8Array.from(hex.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) || []);
    }
    const decoded = atob(text);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function parseBcsU64(value) {
    const bytes = decodeBcsBytes(value);
    if (bytes.length < 8) throw new Error('The stage allowance response is malformed.');
    let result = 0n;
    for (let index = 7; index >= 0; index -= 1) result = (result << 8n) | BigInt(bytes[index]);
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The stage allowance is too large to display safely.');
    return Number(result);
}

function serializeMintKey(stageId, wallet) {
    let remaining = BigInt(stageId);
    if (remaining < 0n || remaining > 0xffffffffffffffffn) throw new Error('The mint stage ID is invalid.');
    const bytes = new Uint8Array(40);
    for (let index = 0; index < 8; index += 1) {
        bytes[index] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }
    const address = core.normalizeSuiAddress(wallet).slice(2);
    for (let index = 0; index < 32; index += 1) bytes[index + 8] = Number.parseInt(address.slice(index * 2, index * 2 + 2), 16);
    return bytes;
}

async function readDynamicFieldU64(contract, nameType, nameBcs) {
    const client = window.AlphaCitySui?.grpcClient;
    if (!contract || typeof client?.getDynamicField !== 'function') {
        throw new Error('Wallet eligibility checks are temporarily unavailable.');
    }
    try {
        const response = await client.getDynamicField({
            parentId: contract.dropId,
            name: { type: nameType, bcs: nameBcs },
        });
        return parseBcsU64(response.dynamicField.value.bcs);
    } catch (error) {
        if (isMissingDynamicField(error)) return null;
        throw error;
    }
}

function walletSnapshot() {
    const address = core.normalizeSuiAddress(state.wallet?.address || '');
    return address ? { address, epoch: state.walletEpoch, collectionId: state.collectionId } : null;
}

function isCurrentWalletSnapshot(snapshot) {
    return Boolean(snapshot
        && snapshot.epoch === state.walletEpoch
        && snapshot.collectionId === state.collectionId
        && snapshot.address === core.normalizeSuiAddress(state.wallet?.address || ''));
}

function assertCurrentWalletSnapshot(snapshot) {
    if (!isCurrentWalletSnapshot(snapshot)) throw new Error('The connected wallet or collection changed. Review the latest mint state and try again.');
}

function mintSnapshot() {
    const wallet = walletSnapshot();
    const contract = configuredContract();
    return wallet && contract ? {
        ...wallet,
        quantity: state.quantity,
        collectionEpoch: state.collectionEpoch,
        connector: state.walletConnector,
        session: state.wallet,
        contract,
    } : null;
}

function assertCurrentMintSnapshot(snapshot) {
    assertCurrentWalletSnapshot(snapshot);
    if (snapshot.collectionEpoch !== state.collectionEpoch
        || snapshot.quantity !== state.quantity
        || snapshot.connector !== state.walletConnector
        || snapshot.session !== state.wallet) {
        throw new Error('The collection or mint quantity changed. Review the latest mint state and try again.');
    }
}

async function refreshEligibility(snapshot = walletSnapshot()) {
    const contract = configuredContract();
    const wallet = snapshot?.address;
    const stage = state.activeStage;
    if (!contract || !wallet || !stage || !isCurrentWalletSnapshot(snapshot)) {
        state.eligibility = null;
        return;
    }
    const normalizedWallet = core.normalizeSuiAddress(wallet);
    const stageId = Number(stage.id);
    const fingerprint = `${snapshot.epoch}:${snapshot.collectionId}:${normalizedWallet}:${stageId}`;
    state.eligibility = { status: 'loading', wallet, stageId };
    const keyBcs = serializeMintKey(stageId, normalizedWallet);
    try {
        const prior = await readDynamicFieldU64(
            contract,
            `${contract.packageId}::${contract.module}::WalletMintKey`,
            keyBcs,
        );
        let allowlistLimit = null;
        if (stage.allowlistOnly) {
            allowlistLimit = await readDynamicFieldU64(
                contract,
                `${contract.packageId}::${contract.module}::AllowlistKey`,
                keyBcs,
            );
        }
        const currentFingerprint = `${state.walletEpoch}:${state.collectionId}:${core.normalizeSuiAddress(state.wallet?.address || '')}:${Number(state.activeStage?.id)}`;
        if (currentFingerprint !== fingerprint) return;
        const minted = prior || 0;
        const stageLimit = Math.max(0, firstNumber(stage.walletLimit));
        if (stage.allowlistOnly && allowlistLimit == null) {
            state.eligibility = { status: 'ineligible', wallet, stageId, minted, remaining: 0 };
            return;
        }
        const effectiveLimit = stage.allowlistOnly ? Math.min(stageLimit, allowlistLimit) : stageLimit;
        state.eligibility = {
            status: 'eligible',
            wallet,
            stageId,
            minted,
            limit: effectiveLimit,
            remaining: Math.max(0, effectiveLimit - minted),
        };
    } catch (error) {
        console.warn('[mint] Could not precheck wallet eligibility:', error);
        const currentFingerprint = `${state.walletEpoch}:${state.collectionId}:${core.normalizeSuiAddress(state.wallet?.address || '')}:${Number(state.activeStage?.id)}`;
        if (currentFingerprint === fingerprint) state.eligibility = { status: 'unknown', wallet, stageId };
    }
}

function assertDropMatchesManifest(fields, stages, manifest) {
    const mismatches = [];
    const compareNumber = (field, expected, label) => {
        if (!Number.isSafeInteger(Number(fields[field])) || Number(fields[field]) !== expected) mismatches.push(label);
    };
    const compareAddress = (field, expected, label) => {
        if (core.normalizeSuiAddress(String(fields[field] || '')) !== expected) mismatches.push(label);
    };
    if (chainString(fields.name) !== manifest.collectionName) mismatches.push('collection name');
    if (chainString(fields.description) !== manifest.collectionDescription) mismatches.push('collection description');
    compareAddress('creator', manifest.creatorAddress, 'creator payout');
    compareAddress('platform_treasury', manifest.platformTreasury, 'platform treasury');
    compareNumber('platform_fee_bps', manifest.platformFeeBps, 'platform fee');
    compareNumber('royalty_bps', manifest.royaltyBps, 'royalty');
    compareNumber('total_supply', manifest.totalSupply, 'total supply');
    compareNumber('public_supply', manifest.publicSupply, 'public supply');
    compareNumber('reserved_supply', manifest.reservedSupply, 'reserved supply');
    compareNumber('max_per_tx', manifest.maxPerTx, 'transaction limit');
    compareNumber('expected_stage_count', manifest.expectedStageCount, 'expected stage count');
    compareNumber('expected_allowlist_entry_count', manifest.expectedAllowlistEntryCount, 'expected allowlist count');
    if (stages.length !== manifest.expectedStageCount) mismatches.push('loaded stage count');
    stages.forEach((stage, index) => {
        const expected = manifest.stages[index];
        if (!expected) return;
        if (stage.id !== expected.id
            || stage.name !== expected.name
            || String(stage.priceMist) !== expected.priceMist
            || stage.startTimeMs !== expected.startTimeMs
            || stage.endTimeMs !== expected.endTimeMs
            || stage.walletLimit !== expected.walletLimit
            || stage.allocation !== expected.allocation
            || stage.allowlistOnly !== expected.allowlistOnly) mismatches.push(`stage ${index + 1} rules`);
    });
    if (Boolean(fields.published) && Number(fields.allowlist_entries_loaded) !== manifest.expectedAllowlistEntryCount) mismatches.push('loaded allowlist count');
    if (mismatches.length) throw new Error(`The configured Drop does not match its deployment manifest (${mismatches.join(', ')}). Minting is disabled.`);
}

async function refreshOnchain() {
    const requestEpoch = ++state.onchainReadEpoch;
    const collectionEpoch = state.collectionEpoch;
    const collectionId = state.collectionId;
    if (!isManagedDrop()) {
        state.onchain = null;
        state.activeStage = selectActiveStage((state.collection?.phases || []).map((stage, index) => ({
            id: stage.id ?? index,
            name: stage.name,
            priceMist: stage.priceMist || core.suiToMist(String(stage.priceSui ?? state.collection?.priceSui ?? 0)).toString(),
            startTimeMs: firstNumber(stage.startTimeMs),
            endTimeMs: firstNumber(stage.endTimeMs),
            walletLimit: firstNumber(stage.walletLimit, state.collection?.maxPerTx),
            allocation: firstNumber(stage.allocation),
            minted: firstNumber(stage.minted),
            allowlistOnly: Boolean(stage.allowlistOnly),
        })));
        return true;
    }
    const contract = configuredContract();
    const isCurrentRequest = () => requestEpoch === state.onchainReadEpoch
        && collectionEpoch === state.collectionEpoch
        && collectionId === state.collectionId
        && configuredContract()?.dropId === contract.dropId;
    const response = await rpc('sui_getObject', [contract.dropId, { showContent: true, showType: true }]);
    if (!isCurrentRequest()) return false;
    if (response?.error) throw new Error(response.error.message || 'The launch contract was not found.');
    const [objectPackage, objectModule, objectName] = String(response?.data?.type || '').split('::');
    if (!core.isValidSuiAddress(objectPackage)
        || core.normalizeSuiAddress(objectPackage) !== contract.packageId
        || objectModule !== contract.module
        || objectName !== 'Drop') {
        throw new Error('The configured drop object does not match this collection contract.');
    }
    const fields = response?.data?.content?.fields || {};
    const stages = Array.isArray(fields.stages) ? fields.stages.map(parseChainStage) : [];
    assertDropMatchesManifest(fields, stages, contract.manifest);
    if (!isCurrentRequest()) return false;
    state.onchain = {
        paused: Boolean(fields.paused),
        published: Boolean(fields.published),
        totalSupply: firstNumber(fields.total_supply),
        publicSupply: firstNumber(fields.public_supply),
        reservedSupply: firstNumber(fields.reserved_supply),
        mintedPublic: firstNumber(fields.minted_public),
        creator: String(fields.creator || ''),
        platformTreasury: String(fields.platform_treasury || ''),
        platformFeeBps: firstNumber(fields.platform_fee_bps),
        royaltyBps: firstNumber(fields.royalty_bps),
        maxPerTx: firstNumber(fields.max_per_tx),
        expectedStageCount: firstNumber(fields.expected_stage_count),
        expectedAllowlistEntryCount: firstNumber(fields.expected_allowlist_entry_count),
        allowlistEntriesLoaded: firstNumber(fields.allowlist_entries_loaded),
        stages,
    };
    state.activeStage = selectActiveStage(stages);
    return true;
}

async function refreshBalance(snapshot = walletSnapshot()) {
    if (!snapshot || !isCurrentWalletSnapshot(snapshot)) {
        state.balanceMist = null;
        renderBalance();
        return;
    }
    try {
        const response = await rpc('suix_getBalance', [snapshot.address, SUI_TYPE]);
        if (!isCurrentWalletSnapshot(snapshot)) return;
        state.balanceMist = BigInt(response?.totalBalance || 0);
    } catch (error) {
        console.warn('[mint] Could not load SUI balance:', error);
        if (!isCurrentWalletSnapshot(snapshot)) return;
        state.balanceMist = null;
    }
    renderBalance();
}

async function loadGallery(collection) {
    if (Array.isArray(collection.gallery) && collection.gallery.length) {
        return collection.gallery.map((item) => ({ name: item.name || collection.name, image: resolveUrl(item.image) }));
    }
    if (!collection.csv) return [];
    try {
        const csvUrl = resolveUrl(collection.csv);
        const response = await fetch(csvUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Gallery CSV returned ${response.status}`);
        const parsed = core.parseCsv(await response.text());
        return parsed.rows.slice(0, Number(collection.galleryLimit || 8)).map((row, index) => ({
            name: row.name || row.Name || `${collection.name} #${index + 1}`,
            image: resolveUrl(row.image || row['File Name'], csvUrl),
        })).filter((item) => item.image);
    } catch (error) {
        console.warn('[mint] Gallery could not be loaded:', error);
        return [];
    }
}

function phaseState(stage, now) {
    if (stage.startTimeMs > now) return 'upcoming';
    if (stage.endTimeMs && stage.endTimeMs <= now) return 'ended';
    if (stage.allocation && stage.minted >= stage.allocation) return 'filled';
    return 'active';
}

function renderPhases() {
    const now = Date.now();
    const phases = state.onchain?.stages || state.collection?.phases || [];
    const container = byId('phase-list');
    if (!phases.length) {
        container.innerHTML = '<div class="rounded-2xl border border-white/5 bg-dark-bg/55 p-4 text-sm text-dark-text-secondary">Mint stages will appear after the project schedule is finalized.</div>';
        return;
    }
    container.innerHTML = phases.map((raw, index) => {
        const phase = raw.priceMist != null ? raw : {
            ...raw,
            id: raw.id ?? index,
            startTimeMs: firstNumber(raw.startTimeMs),
            endTimeMs: firstNumber(raw.endTimeMs),
            priceMist: raw.priceMist || core.suiToMist(String(raw.priceSui ?? state.collection.priceSui ?? 0)).toString(),
            walletLimit: firstNumber(raw.walletLimit, state.collection.maxPerTx),
            minted: firstNumber(raw.minted), allocation: firstNumber(raw.allocation),
        };
        const status = raw.state && !isManagedDrop() ? raw.state : phaseState(phase, now);
        const active = isManagedDrop() && state.onchain?.published && state.activeStage && Number(state.activeStage.id) === Number(phase.id) && status === 'active';
        const badge = active ? 'Live' : status === 'ended' ? 'Ended' : status === 'filled' ? 'Filled' : status === 'upcoming' ? 'Upcoming' : status === 'active' ? 'Planned' : status;
        const schedule = phase.startTimeMs ? `${formatDate(phase.startTimeMs)}${phase.endTimeMs ? ` – ${formatDate(phase.endTimeMs)}` : ''}` : (raw.description || 'Schedule to be announced');
        return `<article class="rounded-2xl border ${active ? 'border-blue-400/35 bg-blue-400/10' : 'border-white/5 bg-dark-bg/55'} p-4">
            <div class="flex flex-wrap items-start justify-between gap-3"><div><div class="flex flex-wrap items-center gap-2"><h3 class="font-bold text-white">${escapeHtml(phase.name)}</h3>${phase.allowlistOnly ? '<span class="rounded-full bg-violet-400/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-violet-200">Allowlist</span>' : ''}</div><p class="mt-1 text-sm text-dark-text-secondary">${escapeHtml(schedule)}</p></div><span class="rounded-full px-2.5 py-1 text-xs font-semibold ${active ? 'bg-green-400/15 text-green-300' : 'bg-gray-700 text-gray-300'}">${escapeHtml(badge)}</span></div>
            <div class="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-gray-300"><span>${formatSui(phase.priceMist)}</span><span>${phase.walletLimit || '—'} per wallet</span>${phase.allocation ? `<span>${numberFormat(phase.minted)} / ${numberFormat(phase.allocation)} stage mints</span>` : ''}</div>
        </article>`;
    }).join('');
}

function renderGallery() {
    const gallery = state.collection?.galleryResolved || [];
    const section = byId('gallery-section');
    if (!gallery.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    byId('gallery-grid').innerHTML = gallery.map((item) => `<figure class="overflow-hidden rounded-2xl border border-white/5 bg-dark-bg/55"><img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" class="aspect-square w-full object-cover" loading="lazy"><figcaption class="px-4 py-3 text-sm font-semibold text-white">${escapeHtml(item.name)}</figcaption></figure>`).join('');
}

function renderDetails() {
    const collection = state.collection;
    const details = Array.isArray(collection.details) ? [...collection.details] : [];
    if (collection.creator?.address) details.push({ label: 'Creator payout', value: shortAddress(collection.creator.address) });
    if (collection.platformFeeBps != null) details.push({ label: 'Primary fee', value: `${Number(collection.platformFeeBps) / 100}%` });
    byId('detail-grid').innerHTML = details.map((detail) => `<div class="rounded-2xl border border-white/5 bg-dark-bg/55 p-4"><p class="text-xs uppercase tracking-[.18em] text-dark-text-secondary">${escapeHtml(detail.label)}</p><p class="mt-2 break-words font-semibold text-white">${escapeHtml(detail.value)}</p></div>`).join('');
    byId('about-copy').textContent = collection.description || collection.tagline || 'Collection details will be published before minting opens.';
    const links = [
        safeExternalUrl(collection.creator?.website) && { label: 'Website', href: safeExternalUrl(collection.creator.website) },
        safeExternalUrl(collection.creator?.twitter) && { label: 'X / Twitter', href: safeExternalUrl(collection.creator.twitter) },
        safeExternalUrl(collection.creator?.discord) && { label: 'Discord', href: safeExternalUrl(collection.creator.discord) },
    ].filter(Boolean);
    byId('creator-links').innerHTML = links.map((link) => `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer" class="rounded-xl border border-gray-700 px-3 py-2 text-sm text-gray-200 hover:border-blue-400 hover:text-white">${escapeHtml(link.label)}</a>`).join('');
}

function renderBalance() {
    byId('sui-balance').textContent = state.balanceMist == null ? '—' : formatSui(state.balanceMist);
}

function renderMintButton() {
    const button = byId('mint-btn');
    const caption = byId('mint-caption');
    const disabled = 'mt-6 w-full cursor-not-allowed rounded-2xl bg-gray-700 px-5 py-4 text-lg font-bold text-gray-300 shadow-lg';
    const enabled = 'mt-6 w-full rounded-2xl bg-brand-secondary px-5 py-4 text-lg font-bold text-gray-900 shadow-lg shadow-yellow-500/20 transition hover:-translate-y-0.5 hover:bg-yellow-300 disabled:cursor-wait disabled:opacity-70';
    byId('qty-minus').disabled = state.busy;
    byId('qty-plus').disabled = state.busy;
    byId('collection-switcher').disabled = state.busy;
    if (!state.collection) { button.disabled = true; button.className = disabled; button.textContent = 'Loading mint…'; caption.textContent = ''; return; }
    if (isManagedDropMisconfigured()) { button.disabled = true; button.className = disabled; button.textContent = 'Mint configuration incomplete'; caption.textContent = 'Minting stays disabled until the published package and drop object are configured.'; return; }
    if (!isManagedDrop()) { button.disabled = true; button.className = disabled; button.textContent = state.collection.contract?.ctaLabel || 'Mint opens soon'; caption.textContent = state.collection.contract?.message || 'Publication details are being finalized.'; return; }
    if (state.onchain?.paused) { button.disabled = true; button.className = disabled; button.textContent = 'Mint paused'; caption.textContent = 'The project team has temporarily paused this mint.'; return; }
    if (state.onchain && !state.onchain.published) { button.disabled = true; button.className = disabled; button.textContent = 'Finalizing collection'; caption.textContent = 'The contract exists, but its inventory is not yet locked for public minting.'; return; }
    if (currentMinted() >= currentSupply() && currentSupply()) { button.disabled = true; button.className = disabled; button.textContent = 'Sold out'; caption.textContent = 'All public inventory has been minted.'; return; }
    if (!state.activeStage || phaseState(state.activeStage, Date.now()) !== 'active') {
        button.disabled = true; button.className = disabled;
        button.textContent = state.activeStage?.startTimeMs > Date.now() ? 'Mint not started' : 'No active mint stage';
        caption.textContent = state.activeStage?.startTimeMs ? `Next stage starts ${formatDate(state.activeStage.startTimeMs)}.` : 'Check the schedule for the next stage.';
        return;
    }
    if (!state.wallet?.address) { button.disabled = true; button.className = disabled; button.textContent = 'Connect wallet to mint'; caption.textContent = 'Connect any supported Sui wallet using the button above.'; return; }
    const eligibility = currentEligibility();
    if (eligibility?.status === 'loading') { button.disabled = true; button.className = disabled; button.textContent = 'Checking wallet eligibility…'; caption.textContent = 'Reading this stage’s wallet limits from Sui.'; return; }
    if (!eligibility || eligibility.status === 'unknown') { button.disabled = true; button.className = disabled; button.textContent = 'Allowance unavailable'; caption.textContent = 'The on-chain wallet allowance must be verified before minting. Try again when Sui reads recover.'; return; }
    if (eligibility?.status === 'ineligible') { button.disabled = true; button.className = disabled; button.textContent = 'Wallet not allowlisted'; caption.textContent = 'This wallet is not included in the active stage allowlist.'; return; }
    if (eligibility?.status === 'eligible' && eligibility.remaining <= 0) { button.disabled = true; button.className = disabled; button.textContent = 'Wallet limit reached'; caption.textContent = `This wallet has used its ${eligibility.limit} mint allowance for this stage.`; return; }
    if (maxQuantity() <= 0) { button.disabled = true; button.className = disabled; button.textContent = 'No mints remaining'; caption.textContent = 'The collection or active stage has no remaining inventory.'; return; }
    const total = currentPriceMist() * BigInt(state.quantity);
    if (state.balanceMist != null && state.balanceMist <= total) { button.disabled = true; button.className = disabled; button.textContent = 'Insufficient SUI balance'; caption.textContent = 'Add enough SUI for the mint price and network gas, then try again.'; return; }
    button.disabled = state.busy;
    button.className = enabled;
    button.textContent = state.busy ? 'Checking latest mint state…' : `Mint ${state.quantity} for ${formatSui(total)}`;
    caption.textContent = eligibility?.status === 'unknown'
        ? 'The wallet-limit precheck is unavailable; the collection contract will still enforce the public stage limit.'
        : state.activeStage.allowlistOnly
            ? 'This wallet is eligible for the active on-chain allowlist stage.'
            : 'The collection contract enforces payment, inventory, and wallet limits on Sui.';
}

function renderCollection() {
    const collection = state.collection;
    if (!collection) return;
    const supply = currentSupply();
    const minted = currentMinted();
    const progress = supply ? Math.min(100, (minted / supply) * 100) : 0;
    const liveStage = isManagedDrop() && state.onchain?.published && state.activeStage && phaseState(state.activeStage, Date.now()) === 'active';
    const status = state.onchain?.paused
        ? 'Paused'
        : isManagedDrop() && state.onchain && !state.onchain.published
            ? 'Finalizing collection'
            : supply > 0 && minted >= supply
                ? 'Sold out'
        : liveStage
            ? 'Minting Live'
            : isManagedDrop() && state.activeStage?.startTimeMs > Date.now()
                ? 'Upcoming'
                : collection.statusLabel || 'Coming Soon';
    byId('hero-image').src = collection.heroImageResolved || '';
    byId('hero-image').alt = `${collection.name || 'Collection'} artwork`;
    byId('eyebrow').textContent = collection.eyebrow || 'Official Alpha City Mint';
    byId('headline').textContent = collection.headline || collection.name || 'Alpha City collection';
    byId('tagline').textContent = collection.tagline || collection.description || '';
    byId('collection-name').textContent = collection.name || 'Collection';
    byId('status-label').textContent = status;
    byId('stat-supply').textContent = numberFormat(supply);
    byId('stat-price').textContent = formatSui(currentPriceMist());
    byId('stat-limit').textContent = String(maxQuantity());
    byId('stat-network').textContent = collection.network?.name || 'Sui';
    byId('minted-count').textContent = numberFormat(minted);
    byId('supply-count').textContent = numberFormat(supply);
    byId('progress-bar').style.width = `${progress}%`;
    byId('mint-note').textContent = collection.mintNote || 'Connect your wallet to get ready.';
    const eligibility = currentEligibility();
    const maximum = maxQuantity();
    state.quantity = Math.max(1, Math.min(state.quantity, maximum || 1));
    byId('quantity').textContent = String(state.quantity);
    byId('qty-caption').textContent = eligibility?.status === 'eligible'
        ? `${eligibility.remaining} remaining for this wallet in this stage`
        : eligibility?.status === 'ineligible'
            ? 'This wallet is not eligible for the active stage'
            : `Up to ${maximum} per transaction`;
    renderPhases();
    renderGallery();
    renderDetails();
    renderBalance();
    renderMintButton();
}

function renderSwitcher() {
    const collections = state.registry?.collections || [];
    const select = byId('collection-switcher');
    const wrap = byId('collection-switcher-wrap');
    wrap.classList.toggle('hidden', collections.length <= 1);
    select.innerHTML = collections.map((collection) => `<option value="${escapeHtml(collection.id)}" ${collection.id === state.collectionId ? 'selected' : ''}>${escapeHtml(collection.label || collection.id)}</option>`).join('');
}

async function loadCollection(id) {
    const entry = id
        ? state.registry.collections.find((collection) => collection.id === id)
        : state.registry.collections[0];
    if (!entry) {
        if (id) throw new Error(`Collection “${id}” is not listed for minting.`);
        throw new Error('No launchpad collections are configured.');
    }
    const epoch = ++state.collectionEpoch;
    state.collectionId = entry.id;
    state.collectionUrl = resolveUrl(entry.config, `${window.location.origin}${REGISTRY_URL}`);
    state.collection = null;
    state.onchain = null;
    state.activeStage = null;
    state.eligibility = null;
    renderMintButton();
    const collectionUrl = state.collectionUrl;
    const collection = await fetchJson(collectionUrl);
    if (epoch !== state.collectionEpoch) return;
    collection.heroImageResolved = resolveUrl(collection.heroImage, collectionUrl);
    collection.galleryResolved = await loadGallery(collection);
    if (epoch !== state.collectionEpoch) return;
    state.collection = collection;
    state.quantity = 1;
    state.onchain = null;
    state.activeStage = null;
    state.eligibility = null;
    hideStatus();
    await refreshOnchain();
    if (epoch !== state.collectionEpoch) return;
    if (state.wallet) await Promise.all([refreshEligibility(), refreshBalance()]);
    if (epoch !== state.collectionEpoch) return;
    renderSwitcher();
    renderCollection();
    const url = new URL(window.location.href);
    url.searchParams.set('collection', entry.id);
    history.replaceState(null, '', url);
}

async function mint() {
    if (state.busy || !state.wallet?.address || !state.activeStage || !configuredContract()) return;
    const snapshot = mintSnapshot();
    if (!snapshot) return;
    const quantity = snapshot.quantity;
    let submittedDigest = '';
    state.busy = true;
    hideStatus();
    renderMintButton();
    try {
        await refreshOnchain();
        assertCurrentMintSnapshot(snapshot);
        await Promise.all([refreshEligibility(snapshot), refreshBalance(snapshot)]);
        assertCurrentMintSnapshot(snapshot);
        const contract = snapshot.contract;
        const onchain = state.onchain ? { ...state.onchain } : null;
        const stage = state.activeStage ? { ...state.activeStage } : null;
        const eligibility = currentEligibility() ? { ...currentEligibility() } : null;
        const balanceMist = state.balanceMist;
        const connector = snapshot.connector;
        if (!contract) throw new Error('Minting is not configured for this collection.');
        if (onchain?.paused) throw new Error('This mint is currently paused.');
        if (!onchain?.published) throw new Error('This collection is not published for minting yet.');
        if (!stage || phaseState(stage, Date.now()) !== 'active') throw new Error('There is no active mint stage right now.');
        if (eligibility?.status !== 'eligible') throw new Error('The on-chain wallet allowance could not be verified. No transaction was submitted.');
        if (eligibility?.status === 'ineligible') throw new Error('This wallet is not included in the active stage allowlist.');
        if (eligibility?.status === 'eligible' && eligibility.remaining < quantity) throw new Error('This quantity exceeds the wallet’s remaining stage allowance.');
        if (quantity > maxQuantityFor(onchain, stage, eligibility, null)) throw new Error('This quantity exceeds the remaining mint allowance or inventory.');
        const totalMist = BigInt(stage.priceMist) * BigInt(quantity);
        if (balanceMist != null && balanceMist <= totalMist) throw new Error('Your wallet does not have enough SUI for the mint price plus gas.');
        const transaction = new Transaction();
        assertCurrentMintSnapshot(snapshot);
        transaction.setSender(snapshot.address);
        const [payment] = transaction.splitCoins(transaction.gas, [transaction.pure.u64(totalMist)]);
        transaction.moveCall({
            target: `${contract.packageId}::${contract.module}::mint`,
            arguments: [
                transaction.object(contract.dropId),
                transaction.object(CLOCK_ID),
                payment,
                transaction.pure.u64(stage.id),
                transaction.pure.u64(quantity),
            ],
        });
        assertCurrentMintSnapshot(snapshot);
        const result = await connector.signAndExecuteTransaction(transaction);
        submittedDigest = result?.digest || result?.Transaction?.digest || result?.effects?.transactionDigest || '';
        const immediateFailure = transactionFailure(result);
        if (immediateFailure) {
            if (submittedDigest) {
                showStatus(`Transaction failed on-chain: ${immediateFailure}`, 'error', explorerUrl(submittedDigest));
                return;
            }
            throw new Error(immediateFailure);
        }
        if (!submittedDigest) throw new Error('The wallet did not return a transaction receipt. Check wallet activity before trying again.');
        if (typeof window.AlphaCitySui?.grpcClient?.waitForTransaction !== 'function') {
            showStatus('Mint submitted. Confirmation is not available in this session; check the receipt before taking another action.', 'info', explorerUrl(submittedDigest));
            return;
        }
        let confirmed;
        try {
            confirmed = await window.AlphaCitySui.grpcClient.waitForTransaction({ digest: submittedDigest, include: { effects: true, events: true, objectChanges: true } });
        } catch (error) {
            console.warn('[mint] Transaction was submitted but confirmation could not be loaded:', error);
            showStatus('Mint submitted, but confirmation is uncertain. Check the receipt before trying again.', 'info', explorerUrl(submittedDigest));
            return;
        }
        const confirmedFailure = transactionFailure(confirmed);
        if (confirmedFailure) {
            showStatus(`Transaction failed on-chain: ${confirmedFailure}`, 'error', explorerUrl(submittedDigest));
            return;
        }
        showStatus(`Mint confirmed: ${submittedDigest.slice(0, 10)}…`, 'success', explorerUrl(submittedDigest));
        try {
            await refreshOnchain();
            await Promise.all([refreshEligibility(), refreshBalance()]);
            renderCollection();
        } catch (error) {
            console.warn('[mint] Mint confirmed, but the refreshed collection state could not be loaded:', error);
        }
    } catch (error) {
        if (submittedDigest) {
            console.warn('[mint] Transaction was submitted but its final state is uncertain:', error);
            showStatus('Mint submitted, but confirmation is uncertain. Check the receipt before trying again.', 'info', explorerUrl(submittedDigest));
        } else {
            console.error('[mint] Mint failed before submission:', error);
            showStatus(error?.message || 'The mint could not be submitted.', 'error');
        }
    } finally {
        state.busy = false;
        if (state.collection) renderCollection();
        else renderMintButton();
    }
}

function initializeWallet() {
    if (!window.AlphaCityWalletConnector) throw new Error('The universal wallet connector did not load.');
    state.walletConnector = window.AlphaCityWalletConnector.create({
        button: byId('connect-wallet-btn'),
        onChange(session) {
            state.walletEpoch += 1;
            state.wallet = session;
            state.balanceMist = null;
            state.eligibility = null;
            const snapshot = walletSnapshot();
            Promise.all([refreshBalance(snapshot), refreshEligibility(snapshot)]).finally(renderCollection);
        },
    });
}

async function refreshLiveState() {
    if (!state.collection || state.refreshPromise || state.busy) return state.refreshPromise;
    const collectionId = state.collectionId;
    state.refreshPromise = (async () => {
        await refreshOnchain();
        if (state.collectionId !== collectionId) return;
        await Promise.all([refreshEligibility(), state.wallet ? refreshBalance() : Promise.resolve()]);
        if (state.collectionId === collectionId) renderCollection();
    })().catch((error) => {
        console.warn('[mint] Could not refresh live mint state:', error);
    }).finally(() => {
        state.refreshPromise = null;
    });
    return state.refreshPromise;
}

async function initialize() {
    byId('current-year').textContent = String(new Date().getFullYear());
    initializeWallet();
    state.registry = await fetchJson(REGISTRY_URL);
    const requested = new URLSearchParams(window.location.search).get('collection');
    await loadCollection(requested || state.registry.defaultCollection);
    window.setInterval(() => {
        if (document.visibilityState !== 'hidden') refreshLiveState();
    }, REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshLiveState();
    });
}

byId('qty-minus').addEventListener('click', () => { if (state.busy) return; state.quantity = Math.max(1, state.quantity - 1); renderCollection(); });
byId('qty-plus').addEventListener('click', () => { if (state.busy) return; state.quantity = Math.min(maxQuantity(), state.quantity + 1); renderCollection(); });
byId('mint-btn').addEventListener('click', mint);
byId('collection-switcher').addEventListener('change', (event) => {
    if (state.busy) { event.target.value = state.collectionId; return; }
    loadCollection(event.target.value).catch((error) => showStatus(error.message, 'error'));
});

initialize().catch((error) => {
    console.error('[mint] Initialization failed:', error);
    showStatus(error?.message || 'The mint page could not be loaded.', 'error');
    byId('mint-btn').textContent = 'Mint unavailable';
});
