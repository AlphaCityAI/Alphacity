'use strict';

const crypto = require('node:crypto');
const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519');
const { SuiGrpcClient } = require('@mysten/sui/grpc');
const { Transaction } = require('@mysten/sui/transactions');
const {
    TRIGGERS,
    normalizeAddress,
    normalizeCoinType,
    parseScheduleObject,
    canonicalTriggerConfig,
    triggerMetricName,
    selectPrimaryPair,
    metricValue,
    observationFromPairs,
    encodeObservationMessage,
} = require('../shared/sluice-core.cjs');

const CLOCK_ID = '0x6';
const DEFAULT_GRAPHQL = 'https://graphql.mainnet.sui.io/graphql';
const DEFAULT_GRPC = 'https://fullnode.mainnet.sui.io:443';
const OBSERVATION_CLOCK_SKEW_MS = 30_000n;
const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (controller.signal.aborted) throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function requiredEnvironment(name) {
    const value = String(process.env[name] || '').trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function keypairFromSecret(value) {
    const secret = String(value || '').trim();
    if (secret.startsWith('suiprivkey')) return Ed25519Keypair.fromSecretKey(secret);
    const clean = secret.replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/i.test(clean)) {
        throw new Error('Sluice private keys must be suiprivkey bech32 values or 32-byte hex seeds');
    }
    return Ed25519Keypair.fromSecretKey(Uint8Array.from(clean.match(/../g), byte => parseInt(byte, 16)));
}

function rawPublicKeyHex(keypair) {
    return Buffer.from(keypair.getPublicKey().toRawBytes()).toString('hex');
}

function byteVector(value) {
    if (Array.isArray(value)) return value.map(Number);
    if (value?.fields) return byteVector(value.fields);
    if (typeof value === 'string' && /^0x[0-9a-f]*$/i.test(value)) {
        return (value.slice(2).match(/../g) || []).map(byte => parseInt(byte, 16));
    }
    if (typeof value === 'string') {
        const encoded = value.trim();
        if (encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
            return Array.from(Buffer.from(encoded, 'base64'));
        }
    }
    return [];
}

function nestedByteVectors(value) {
    const source = value?.fields || value;
    return Array.isArray(source) ? source.map(byteVector) : [];
}

async function querySchedules(graphqlUrl, packageId, fetchImpl = fetch) {
    const query = `
        query SluiceV2Schedules($type: String!, $after: String) {
            objects(first: 50, after: $after, filter: { type: $type }) {
                pageInfo { hasNextPage endCursor }
                nodes {
                    address
                    version
                    digest
                    asMoveObject { contents { type { repr } json } }
                }
            }
        }`;
    const output = [];
    let after = null;
    do {
        const response = await fetchWithTimeout(fetchImpl, graphqlUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                query,
                variables: { type: `${packageId}::sluice_v2::VestingScheduleV2`, after },
            }),
        });
        if (!response.ok) throw new Error(`Sui GraphQL HTTP ${response.status}`);
        const payload = await response.json();
        if (payload.errors?.length) throw new Error(payload.errors.map(error => error.message).join('; '));
        const connection = payload.data?.objects;
        for (const node of (connection?.nodes || [])) {
            const move = node.asMoveObject;
            output.push({ data: {
                objectId: node.address,
                version: String(node.version || ''),
                digest: node.digest || '',
                content: {
                    dataType: 'moveObject',
                    type: move?.contents?.type?.repr || '',
                    fields: move?.contents?.json || {},
                },
            }});
        }
        after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);
    return output;
}

async function fetchDexPairs(coinType, fetchImpl = fetch) {
    const response = await fetchWithTimeout(fetchImpl, `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(coinType)}`, {
        headers: { accept: 'application/json', 'user-agent': 'AlphaCity-Sluice-V2/1.0' },
    });
    if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
    const payload = await response.json();
    return payload.pairs || [];
}

async function fetchObservation(schedule, fetchImpl = fetch, pairCache = null) {
    const cacheKey = normalizeCoinType(schedule.coinType);
    let pairsPromise = pairCache?.get(cacheKey);
    if (!pairsPromise) {
        pairsPromise = fetchDexPairs(cacheKey, fetchImpl);
        if (pairCache) pairCache.set(cacheKey, pairsPromise);
    }
    return observationFromPairs(schedule, await pairsPromise);
}

function verifyScheduleConfig(schedule) {
    if (schedule.triggerConfigHash.length !== 32) throw new Error('Schedule trigger config hash is not 32 bytes');
    const canonical = canonicalTriggerConfig({
        coinType: schedule.coinType,
        triggerKind: schedule.triggerKind,
        minLiquidityUsd: schedule.minLiquidityUsd,
    });
    const expected = crypto.createHash('sha256').update(canonical).digest();
    const actual = Buffer.from(schedule.triggerConfigHash);
    if (!crypto.timingSafeEqual(expected, actual)) {
        throw new Error('Schedule trigger configuration is not supported by this relayer');
    }
}

function matchOracleSigners(schedulePublicKeys, threshold, keypairs) {
    const owned = new Map(keypairs.map(keypair => [rawPublicKeyHex(keypair), keypair]));
    const matches = [];
    schedulePublicKeys.forEach((publicKey, index) => {
        const keypair = owned.get(Buffer.from(publicKey).toString('hex'));
        if (keypair) matches.push({ index, keypair });
    });
    if (matches.length < threshold) {
        throw new Error(`Relayer controls ${matches.length} of ${threshold} required oracle keys`);
    }
    return matches.slice(0, threshold);
}

function effectSucceeded(result) {
    if (result?.$kind === 'FailedTransaction') return false;
    const transaction = result?.Transaction || result?.FailedTransaction || result;
    const status = transaction?.status || transaction?.effects?.status;
    if (typeof status?.success === 'boolean') return status.success;
    if (typeof status === 'string') return status.toLowerCase() === 'success';
    if (typeof status?.status === 'string') return status.status.toLowerCase() === 'success';
    return false;
}

function transactionDigest(result) {
    return result?.Transaction?.digest || result?.FailedTransaction?.digest || result?.digest || '';
}

async function waitForFinality(client, result) {
    const digest = transactionDigest(result);
    if (!digest) throw new Error('Successful transaction returned no digest');
    if (typeof client?.waitForTransaction === 'function') {
        await client.waitForTransaction({ digest });
    } else if (typeof client?.core?.waitForTransaction === 'function') {
        await client.core.waitForTransaction({ digest });
    } else {
        throw new Error('Sui client cannot wait for transaction finality');
    }
    return digest;
}

function safeObservationTimestamp(localNowMs = BigInt(Date.now())) {
    const timestamp = BigInt(localNowMs);
    return timestamp > OBSERVATION_CLOCK_SKEW_MS ? timestamp - OBSERVATION_CLOCK_SKEW_MS : 0n;
}

async function submitObservation({ client, gasKeypair, packageId, schedule, schedulePublicKeys, threshold, oracleKeypairs, observedValue, nowMs }) {
    const validUntilMs = nowMs + 5n * 60_000n;
    const signers = matchOracleSigners(schedulePublicKeys, threshold, oracleKeypairs);
    const message = encodeObservationMessage({
        scheduleId: schedule.id,
        triggerConfigHash: schedule.triggerConfigHash,
        triggerKind: schedule.triggerKind,
        comparison: schedule.comparison,
        observedValue,
        observedAtMs: nowMs,
        validUntilMs,
    });
    const signatures = [];
    for (const signer of signers) signatures.push(Array.from(await signer.keypair.sign(message)));

    const tx = new Transaction();
    tx.moveCall({
        target: `${packageId}::sluice_v2::submit_observation`,
        typeArguments: [schedule.coinType],
        arguments: [
            tx.object(schedule.id),
            tx.pure.u64(observedValue),
            tx.pure.u64(nowMs),
            tx.pure.u64(validUntilMs),
            tx.pure.vector('u8', signers.map(signer => signer.index)),
            tx.pure.vector('vector<u8>', signatures),
            tx.object(CLOCK_ID),
        ],
    });
    const result = await gasKeypair.signAndExecuteTransaction({ transaction: tx, client, include: { effects: true } });
    if (!effectSucceeded(result)) {
        const transaction = result?.Transaction || result?.FailedTransaction || result;
        throw new Error(`Observation transaction failed: ${JSON.stringify(transaction?.status || transaction?.effects?.status || {})}`);
    }
    return waitForFinality(client, result);
}

async function resolveExpired({ client, gasKeypair, packageId, schedule }) {
    const tx = new Transaction();
    tx.moveCall({
        target: `${packageId}::sluice_v2::resolve_expired_trigger`,
        typeArguments: [schedule.coinType],
        arguments: [tx.object(schedule.id), tx.object(CLOCK_ID)],
    });
    const result = await gasKeypair.signAndExecuteTransaction({ transaction: tx, client, include: { effects: true } });
    if (!effectSucceeded(result)) {
        const transaction = result?.Transaction || result?.FailedTransaction || result;
        throw new Error(`Expiry transaction failed: ${JSON.stringify(transaction?.status || transaction?.effects?.status || {})}`);
    }
    return waitForFinality(client, result);
}

async function run(options = {}) {
    const packageId = normalizeAddress(options.packageId || requiredEnvironment('SLUICE_V2_PACKAGE_ADDRESS'));
    const graphqlUrl = options.graphqlUrl || process.env.SUI_GRAPHQL_URL || DEFAULT_GRAPHQL;
    const grpcUrl = options.grpcUrl || process.env.SUI_GRPC_URL || DEFAULT_GRPC;
    const oracleSecrets = options.oracleSecrets || requiredEnvironment('SLUICE_ORACLE_PRIVATE_KEYS').split(/[\s,]+/).filter(Boolean);
    const gasSecret = options.gasSecret || requiredEnvironment('SLUICE_RELAYER_PRIVATE_KEY');
    const oracleKeypairs = oracleSecrets.map(keypairFromSecret);
    const gasKeypair = keypairFromSecret(gasSecret);
    const client = options.client || new SuiGrpcClient({ network: 'mainnet', baseUrl: grpcUrl });
    const fetchImpl = options.fetchImpl || fetch;
    const dryRun = options.dryRun ?? process.env.SLUICE_RELAYER_DRY_RUN === 'true';

    console.log(`Sluice V2 relayer ${dryRun ? 'dry run' : 'scan'} for ${packageId}`);
    console.log(`Gas sponsor: ${gasKeypair.toSuiAddress()} · oracle keys: ${oracleKeypairs.length}`);
    const objects = await querySchedules(graphqlUrl, packageId, fetchImpl);
    console.log(`Indexed ${objects.length} V2 schedules.`);
    let pending = 0;
    let submitted = 0;
    let failed = 0;
    const pairCache = new Map();

    for (const object of objects) {
        const fields = object.data.content.fields;
        const schedule = parseScheduleObject(object);
        if (schedule.status !== 0 || schedule.triggerKind === TRIGGERS.TIME) continue;
        pending += 1;
        try {
            const currentTimeMs = BigInt(Date.now());
            if (schedule.triggerDeadlineMs > 0n && currentTimeMs >= schedule.triggerDeadlineMs) {
                if (dryRun) console.log(`[dry-run] ${schedule.id} would resolve its expired fallback`);
                else {
                    const digest = await resolveExpired({ client, gasKeypair, packageId, schedule });
                    console.log(`${schedule.id} expired fallback submitted: ${digest}`);
                    submitted += 1;
                }
                continue;
            }
            verifyScheduleConfig(schedule);
            const publicKeys = nestedByteVectors(fields.oracle_pubkeys);
            const threshold = Number(fields.oracle_threshold || 0);
            matchOracleSigners(publicKeys, threshold, oracleKeypairs);
            const observation = await fetchObservation(schedule, fetchImpl, pairCache);
            const nowMs = safeObservationTimestamp(currentTimeMs);
            if (dryRun) {
                console.log(`[dry-run] ${schedule.id} ${triggerMetricName(schedule.triggerKind)}=${observation.observedValue} via ${observation.pair}`);
            } else {
                const digest = await submitObservation({
                    client, gasKeypair, packageId, schedule,
                    schedulePublicKeys: publicKeys,
                    threshold,
                    oracleKeypairs,
                    observedValue: observation.observedValue,
                    nowMs,
                });
                console.log(`${schedule.id} observation ${observation.observedValue} submitted: ${digest}`);
                submitted += 1;
            }
        } catch (error) {
            failed += 1;
            console.error(`${schedule.id} skipped: ${error.message}`);
        }
    }
    console.log(`Relayer complete: ${pending} pending, ${submitted} submitted, ${failed} failed.`);
    if (failed) throw new Error(`${failed} pending schedule(s) could not be serviced`);
    return { indexed: objects.length, pending, submitted, failed };
}

// Deliberately fail closed. A green workflow means required configuration was
// present and every pending schedule was either serviced or absent.
if (require.main === module) {
    run().catch(error => {
        console.error(`Sluice relayer failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    keypairFromSecret,
    nestedByteVectors,
    fetchWithTimeout,
    querySchedules,
    selectPrimaryPair,
    metricValue,
    observationFromPairs,
    fetchDexPairs,
    fetchObservation,
    verifyScheduleConfig,
    matchOracleSigners,
    effectSucceeded,
    waitForFinality,
    safeObservationTimestamp,
    submitObservation,
    run,
};
