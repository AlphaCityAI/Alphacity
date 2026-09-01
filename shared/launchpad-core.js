(function launchpadCoreFactory(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AlphaCityLaunchpadCore = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLaunchpadCore() {
    'use strict';

    const MIST_PER_SUI = 1_000_000_000n;
    const U64_MAX = 18_446_744_073_709_551_615n;
    const MAX_FILE_BYTES = 50 * 1024 * 1024;
    const MAX_COLLECTION_NAME_LENGTH = 100;
    const MAX_COLLECTION_DESCRIPTION_LENGTH = 4_000;
    const MAX_ITEM_NAME_LENGTH = 200;
    const MAX_ITEM_DESCRIPTION_LENGTH = 4_000;
    const MAX_MEDIA_URL_LENGTH = 2_048;
    const MAX_TRAITS_PER_ITEM = 64;
    const MAX_TRAIT_KEY_LENGTH = 64;
    const MAX_TRAIT_VALUE_LENGTH = 512;
    const SUPPORTED_MEDIA_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif']);
    const ASSIGNMENT_POLICY = 'sequential-equivalent';
    const REQUIRED_COLUMNS = Object.freeze(['Name', 'Description', 'File Name', 'Reserve For Creator']);
    const DEFAULT_NETWORK = Object.freeze({
        name: 'Sui Mainnet',
        chain: 'sui:mainnet',
        rpcUrl: 'https://fullnode.mainnet.sui.io:443',
        coinType: '0x2::sui::SUI',
    });

    function clean(value) {
        return String(value == null ? '' : value).trim();
    }

    function slugify(value) {
        return clean(value)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 64);
    }

    function escapeCsv(value) {
        const text = String(value == null ? '' : value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }

    function parseCsv(text) {
        const input = String(text == null ? '' : text).replace(/^\uFEFF/, '');
        const rows = [];
        let row = [];
        let field = '';
        let quoted = false;

        for (let index = 0; index < input.length; index += 1) {
            const character = input[index];
            if (quoted) {
                if (character === '"' && input[index + 1] === '"') {
                    field += '"';
                    index += 1;
                } else if (character === '"') {
                    quoted = false;
                } else {
                    field += character;
                }
                continue;
            }
            if (character === '"') quoted = true;
            else if (character === ',') {
                row.push(field);
                field = '';
            } else if (character === '\n') {
                row.push(field.replace(/\r$/, ''));
                if (row.some((value) => value !== '')) rows.push(row);
                row = [];
                field = '';
            } else {
                field += character;
            }
        }
        if (quoted) throw new Error('CSV contains an unterminated quoted field.');
        row.push(field.replace(/\r$/, ''));
        if (row.some((value) => value !== '')) rows.push(row);
        if (!rows.length) return { headers: [], rows: [] };

        const headers = rows[0].map(clean);
        const records = rows.slice(1).map((values, rowIndex) => {
            const record = { __row: rowIndex + 2 };
            headers.forEach((header, columnIndex) => { record[header] = clean(values[columnIndex]); });
            return record;
        });
        return { headers, rows: records };
    }

    function reservedFlag(value, row, errors) {
        const token = clean(value).toLowerCase();
        if (!token || ['false', 'no', 'n', '0'].includes(token)) return false;
        if (['true', 'yes', 'y', '1'].includes(token)) return true;
        errors.push(`CSV row ${row}: Reserve For Creator must be true/false, yes/no, y/n, or 1/0; received “${clean(value)}”.`);
        return false;
    }

    function mediaExtension(fileName) {
        const match = clean(fileName).toLowerCase().match(/\.([a-z0-9]+)$/);
        return match ? match[1] : '';
    }

    function mediaBaseName(fileName) {
        return clean(fileName).replace(/^.*[\\/]/, '');
    }

    function bytesFrom(value) {
        if (value instanceof Uint8Array) return value;
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(value)) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (Array.isArray(value)) return Uint8Array.from(value);
        return new Uint8Array();
    }

    function mediaTypeFromBytes(value) {
        const bytes = bytesFrom(value);
        const matches = (...expected) => expected.every((byte, index) => bytes[index] === byte);
        if (bytes.length >= 8 && matches(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
        if (bytes.length >= 3 && matches(0xff, 0xd8, 0xff)) return 'jpeg';
        if (bytes.length >= 12
            && matches(0x52, 0x49, 0x46, 0x46)
            && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
        if (bytes.length >= 6) {
            const header = String.fromCharCode(...bytes.slice(0, 6));
            if (header === 'GIF87a' || header === 'GIF89a') return 'gif';
        }
        return '';
    }

    function validateMediaSignature(fileName, value) {
        const extension = mediaExtension(fileName);
        const detected = mediaTypeFromBytes(value);
        if (!SUPPORTED_MEDIA_EXTENSIONS.includes(extension)) {
            return { valid: false, detected, error: `${mediaBaseName(fileName)} uses an unsupported media format.` };
        }
        if (!detected) {
            return { valid: false, detected: '', error: `${mediaBaseName(fileName)} does not contain a recognized PNG, JPEG, WEBP, or GIF signature.` };
        }
        const expected = extension === 'jpg' ? 'jpeg' : extension;
        if (detected !== expected) {
            return { valid: false, detected, error: `${mediaBaseName(fileName)} has a ${detected.toUpperCase()} signature that does not match its .${extension} extension.` };
        }
        return { valid: true, detected, error: '' };
    }

    function validateMediaBaseUrl(value, options = {}) {
        const mediaBaseUrl = clean(value);
        let parsed;
        try { parsed = new URL(mediaBaseUrl); }
        catch (_) { return { valid: false, error: 'The media base URL must be a valid HTTPS URL.' }; }
        if (parsed.protocol !== 'https:') return { valid: false, error: 'The media base URL must use HTTPS.' };
        if (parsed.username || parsed.password) return { valid: false, error: 'The media base URL must not contain credentials.' };
        if (parsed.search || parsed.hash) return { valid: false, error: 'The media base URL must not contain a query string or fragment.' };
        if (/(?:^|\.)(?:google\.com|googleusercontent\.com|googleapis\.com|ggpht\.com)$/i.test(parsed.hostname)) {
            return { valid: false, error: 'Google-hosted URLs can be source backups, but are not supported as public NFT media hosts.' };
        }
        if (mediaBaseUrl.length > MAX_MEDIA_URL_LENGTH) return { valid: false, error: `The media base URL exceeds ${MAX_MEDIA_URL_LENGTH.toLocaleString()} characters.` };
        if (options.requireReleasePath) {
            const projectId = slugify(options.collectionId || '');
            const escapedId = projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const releasePath = new RegExp(`/${escapedId}/releases/[0-9a-f]{64}/media/?$`);
            if (!projectId || !releasePath.test(parsed.pathname)) {
                return { valid: false, error: 'The media base URL must be the content-hashed R2 release URL for this collection.' };
            }
        }
        return { valid: true, error: '', url: parsed.toString() };
    }

    function normalizeSuiAddress(value) {
        const address = clean(value).toLowerCase();
        if (!/^0x[0-9a-f]{1,64}$/.test(address)) return '';
        return `0x${address.slice(2).padStart(64, '0')}`;
    }

    function isValidSuiAddress(value) {
        return Boolean(normalizeSuiAddress(value));
    }

    function suiToMist(value) {
        const normalized = clean(value);
        if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(normalized)) {
            throw new Error('SUI amount must be a non-negative decimal with no more than 9 decimal places.');
        }
        const [whole, fractional = ''] = normalized.split('.');
        return BigInt(whole) * MIST_PER_SUI + BigInt(fractional.padEnd(9, '0'));
    }

    function mistToSui(value, trim = true) {
        const amount = BigInt(value || 0);
        const whole = amount / MIST_PER_SUI;
        const fraction = (amount % MIST_PER_SUI).toString().padStart(9, '0');
        const decimals = trim ? fraction.replace(/0+$/, '') : fraction;
        return decimals ? `${whole}.${decimals}` : whole.toString();
    }

    function parseTimestamp(value, label, errors) {
        if (value == null || value === '') return 0;
        const timestamp = typeof value === 'number' ? value : Date.parse(value);
        if (!Number.isFinite(timestamp) || timestamp < 0 || !Number.isSafeInteger(timestamp)) {
            errors.push(`${label} must be a valid date and time.`);
            return 0;
        }
        return timestamp;
    }

    function readNumber(value, label, errors, options = {}) {
        const number = Number(value);
        if (!Number.isFinite(number) || !Number.isSafeInteger(number)) {
            errors.push(`${label} must be a whole number.`);
            return options.fallback || 0;
        }
        if (number < (options.min == null ? 0 : options.min)) errors.push(`${label} is below the allowed minimum.`);
        if (options.max != null && number > options.max) errors.push(`${label} exceeds the allowed maximum.`);
        return number;
    }

    function normalizeStage(stage, index, errors) {
        const prefix = `Mint stage ${index + 1}`;
        const allowlistOnly = stage?.allowlistOnly === true;
        if (typeof stage?.allowlistOnly !== 'boolean') errors.push(`${prefix} access mode must be an explicit boolean allowlistOnly value.`);
        let priceMist = 0n;
        try { priceMist = suiToMist(stage?.priceSui == null ? '' : stage.priceSui); }
        catch (error) { errors.push(`${prefix}: ${error.message}`); }
        if (priceMist > U64_MAX) errors.push(`${prefix} price exceeds the Sui u64 amount limit.`);
        const startTimeMs = parseTimestamp(stage?.startTime ?? stage?.startTimeMs, `${prefix} start time`, errors);
        const endTimeMs = parseTimestamp(stage?.endTime ?? stage?.endTimeMs, `${prefix} end time`, errors);
        if (!startTimeMs) errors.push(`${prefix} start time is required.`);
        if (endTimeMs && startTimeMs && endTimeMs <= startTimeMs) errors.push(`${prefix} must end after it starts.`);
        if (endTimeMs && endTimeMs <= Date.now()) errors.push(`${prefix} has already ended and cannot provide reachable mint capacity.`);
        const walletLimit = readNumber(stage?.walletLimit ?? 1, `${prefix} wallet limit`, errors, { min: 1, max: 10_000 });
        const allocation = readNumber(stage?.allocation ?? 0, `${prefix} allocation`, errors, { min: 0 });
        const allowlist = Array.isArray(stage?.allowlist) ? stage.allowlist.map((entry, allowIndex) => {
            const rawAddress = typeof entry === 'string' ? entry : entry?.address;
            const address = normalizeSuiAddress(rawAddress);
            if (!address || /^0x0{64}$/.test(address)) errors.push(`${prefix} allowlist row ${allowIndex + 1} has an invalid or zero Sui address.`);
            const limit = readNumber(typeof entry === 'string' ? walletLimit : (entry?.limit ?? walletLimit), `${prefix} allowlist row ${allowIndex + 1} limit`, errors, { min: 1, max: 10_000 });
            return { address, limit };
        }) : [];
        const duplicateAllowlist = allowlist
            .map((entry) => entry.address)
            .filter((address, allowIndex, addresses) => address && addresses.indexOf(address) !== allowIndex);
        if (duplicateAllowlist.length) errors.push(`${prefix} contains duplicate allowlist addresses.`);
        if (allowlistOnly && !allowlist.length) errors.push(`${prefix} is allowlist-only but has no allowlist entries.`);
        if (!allowlistOnly && allowlist.length) errors.push(`${prefix} is public but contains allowlist entries that the contract would ignore.`);
        return {
            id: index,
            name: clean(stage?.name) || `Stage ${index + 1}`,
            priceSui: clean(stage?.priceSui),
            priceMist: priceMist.toString(),
            startTimeMs,
            endTimeMs,
            walletLimit,
            allocation,
            allowlistOnly,
            allowlist,
        };
    }

    function normalizeProject(project) {
        const input = project && typeof project === 'object' ? project : {};
        const errors = [];
        const warnings = [];
        const name = clean(input.name);
        const requestedId = clean(input.id);
        const id = slugify(requestedId);
        if (!name) errors.push('Collection name is required.');
        if (name.length > MAX_COLLECTION_NAME_LENGTH) errors.push(`Collection name exceeds ${MAX_COLLECTION_NAME_LENGTH} characters.`);
        if (!requestedId || !id) errors.push('Collection slug is required.');
        else if (requestedId !== id) errors.push(`Collection slug must already be normalized as “${id}”.`);
        const creatorAddress = normalizeSuiAddress(input.creatorAddress || input.creator?.address);
        if (!creatorAddress || /^0x0{64}$/.test(creatorAddress)) errors.push('A valid nonzero Sui creator payout address is required.');
        const intendedSupply = input.intendedSupply == null || input.intendedSupply === ''
            ? 0
            : readNumber(input.intendedSupply, 'Intended collection supply', errors, { min: 1 });
        const royaltyBps = readNumber(input.royaltyBps ?? 0, 'Royalty basis points', errors, { min: 0, max: 10_000 });
        const platformFeeBps = readNumber(input.platformFeeBps ?? 0, 'Platform fee basis points', errors, { min: 0, max: 2_500 });
        if (platformFeeBps !== 0) errors.push('AlphaCity first-party launches must use a 0% platform fee.');
        const maxPerTx = readNumber(input.maxPerTx ?? 5, 'Maximum per transaction', errors, { min: 1, max: 50 });
        const assignmentPolicy = clean(input.assignmentPolicy);
        if (assignmentPolicy !== ASSIGNMENT_POLICY) {
            errors.push('Assignment policy must explicitly confirm that sequentially assigned public items have equivalent mint value.');
        }
        const stagesInput = Array.isArray(input.stages) ? input.stages : [];
        if (!stagesInput.length) errors.push('At least one mint stage is required.');
        const stages = stagesInput.map((stage, index) => normalizeStage(stage, index, errors));
        stages.forEach((stage, index) => {
            if (BigInt(stage.priceMist || 0) * BigInt(Math.max(0, maxPerTx)) > U64_MAX) {
                errors.push(`Mint stage ${index + 1} price multiplied by the maximum per transaction exceeds the Sui u64 amount limit.`);
            }
        });
        const description = clean(input.description);
        if (!description) errors.push('Collection description is required.');
        if (description.length > MAX_COLLECTION_DESCRIPTION_LENGTH) errors.push(`Collection description exceeds ${MAX_COLLECTION_DESCRIPTION_LENGTH.toLocaleString()} characters.`);
        const duplicateStageNames = stages.map((stage) => stage.name.toLowerCase()).filter((value, index, values) => values.indexOf(value) !== index);
        if (duplicateStageNames.length) warnings.push('Mint stage names should be unique for clearer reporting.');
        for (let left = 0; left < stages.length; left += 1) {
            for (let right = left + 1; right < stages.length; right += 1) {
                const first = stages[left];
                const second = stages[right];
                const firstEnd = first.endTimeMs || Number.POSITIVE_INFINITY;
                const secondEnd = second.endTimeMs || Number.POSITIVE_INFINITY;
                if (first.startTimeMs < secondEnd && second.startTimeMs < firstEnd) {
                    errors.push(`Mint stages “${first.name}” and “${second.name}” overlap.`);
                }
            }
        }
        for (let index = 1; index < stages.length; index += 1) {
            if (stages[index].startTimeMs < stages[index - 1].startTimeMs) {
                errors.push('Mint stages must be ordered by start time.');
                break;
            }
        }
        const finalStage = stages[stages.length - 1];
        if (finalStage && (finalStage.allowlistOnly || finalStage.allocation !== 0 || finalStage.endTimeMs !== 0)) {
            errors.push('The final mint stage must be public, uncapped, and have no end time so unsold supply cannot become stranded.');
        }
        const heroFile = mediaBaseName(input.heroFile || '');
        const heroImage = clean(input.heroImage || '');
        if (!heroFile) errors.push('A hero image filename from the validated raster media folder is required.');
        if (heroImage) warnings.push('Hosted heroImage overrides are ignored; the public hero is derived from the locked R2 release.');
        const requestedRevealMode = clean(input.reveal?.mode || 'instant');
        if (!['instant', 'delayed'].includes(requestedRevealMode)) errors.push('Reveal mode must be explicitly “instant” or “delayed”.');
        const revealMode = requestedRevealMode === 'delayed' ? 'delayed' : 'instant';
        if (revealMode === 'delayed') warnings.push('Delayed reveal is recorded but not enabled in the managed MVP contract.');
        const website = clean(input.website || input.creator?.website);
        const twitter = clean(input.twitter || input.creator?.twitter);
        const discord = clean(input.discord || input.creator?.discord);
        [website, twitter, discord].filter(Boolean).forEach((url) => {
            if (url.length > MAX_MEDIA_URL_LENGTH) errors.push(`Project link exceeds ${MAX_MEDIA_URL_LENGTH.toLocaleString()} characters.`);
            try {
                const parsed = new URL(url);
                if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
            } catch (_) { errors.push(`Project link must be a valid HTTP(S) URL: ${url}`); }
        });
        return {
            value: {
                schemaVersion: 3,
                id,
                name,
                eyebrow: clean(input.eyebrow) || 'Alpha City Launchpad',
                headline: clean(input.headline) || name,
                tagline: clean(input.tagline),
                description,
                creatorName: clean(input.creatorName || input.creator?.name) || name,
                creatorAddress,
                intendedSupply,
                website,
                twitter,
                discord,
                heroFile,
                heroImage,
                mediaBaseUrl: clean(input.mediaBaseUrl),
                royaltyBps,
                platformFeeBps,
                maxPerTx,
                assignmentPolicy,
                mediaReleaseVerified: input.mediaReleaseVerified === true,
                stages,
                reveal: { mode: revealMode },
                contract: {
                    packageId: clean(input.contract?.packageId),
                    module: clean(input.contract?.module) || 'managed_drop',
                    dropId: clean(input.contract?.dropId),
                    adminCapId: clean(input.contract?.adminCapId),
                    adminAuthority: normalizeSuiAddress(input.contract?.adminAuthority || ''),
                    upgradePolicy: clean(input.contract?.upgradePolicy),
                    upgradeAuthority: normalizeSuiAddress(input.contract?.upgradeAuthority || ''),
                    displayAuthority: normalizeSuiAddress(input.contract?.displayAuthority || ''),
                },
            },
            errors,
            warnings,
        };
    }

    function normalizeFiles(files) {
        return Array.from(files || []).map((file) => ({
            name: mediaBaseName(file.name || file.webkitRelativePath || ''),
            size: Number(file.size || 0),
            type: clean(file.type),
            signatureBytes: bytesFrom(file.signatureBytes || file.bytes),
            source: file,
        }));
    }

    function validateSubmission(projectInput, csvText, files, options = {}) {
        const projectResult = normalizeProject(projectInput);
        const errors = [...projectResult.errors];
        const warnings = [...projectResult.warnings];
        let parsed;
        try { parsed = parseCsv(csvText); }
        catch (error) {
            return { valid: false, project: projectResult.value, items: [], files: normalizeFiles(files), errors: [...errors, error.message], warnings };
        }
        const blankHeaders = parsed.headers.map((header, index) => !header ? index + 1 : 0).filter(Boolean);
        if (blankHeaders.length) errors.push(`Metadata CSV contains a blank header in column${blankHeaders.length > 1 ? 's' : ''} ${blankHeaders.join(', ')}.`);
        const duplicateHeaders = parsed.headers.filter((header, index, headers) => header && headers.indexOf(header) !== index);
        if (duplicateHeaders.length) errors.push(`Metadata CSV contains duplicate header${duplicateHeaders.length > 1 ? 's' : ''}: ${[...new Set(duplicateHeaders)].join(', ')}.`);
        const missing = REQUIRED_COLUMNS.filter((column) => !parsed.headers.includes(column));
        if (missing.length) errors.push(`Metadata CSV is missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
        const attributeHeaders = parsed.headers.filter((header) => /^attributes\[[^\]]+\]$/.test(header));
        const normalizedTraitNames = attributeHeaders.map((header) => header.slice(11, -1).trim());
        if (normalizedTraitNames.some((trait) => !trait)) errors.push('Metadata CSV contains an empty normalized trait header.');
        const duplicateTraits = normalizedTraitNames.filter((trait, index, traits) => trait && traits.indexOf(trait) !== index);
        if (duplicateTraits.length) errors.push(`Metadata CSV contains duplicate normalized trait header${duplicateTraits.length > 1 ? 's' : ''}: ${[...new Set(duplicateTraits)].join(', ')}.`);
        const mediaFiles = normalizeFiles(files);
        const fileMap = new Map();
        const caseFoldedFiles = new Map();
        if (!mediaFiles.length) errors.push('A media folder with the collection images is required.');
        mediaFiles.forEach((file) => {
            const key = file.name;
            if (fileMap.has(key)) errors.push(`Duplicate media filename: ${file.name}.`);
            else fileMap.set(key, file);
            const foldedKey = key.toLowerCase();
            if (caseFoldedFiles.has(foldedKey) && caseFoldedFiles.get(foldedKey) !== key) {
                errors.push(`Media filenames “${caseFoldedFiles.get(foldedKey)}” and “${key}” differ only by case and are unsafe for R2 publication.`);
            } else caseFoldedFiles.set(foldedKey, key);
            const extension = mediaExtension(file.name);
            if (!SUPPORTED_MEDIA_EXTENSIONS.includes(extension)) errors.push(`${file.name} uses an unsupported media format.`);
            else if (options.requireMediaSignatures) {
                const signature = validateMediaSignature(file.name, file.signatureBytes);
                if (!signature.valid) errors.push(signature.error);
            }
            if (file.size <= 0) errors.push(`${file.name} is empty.`);
            if (file.size > MAX_FILE_BYTES) errors.push(`${file.name} exceeds the 50 MB per-file limit.`);
        });
        const seenNames = new Set();
        const referencedFiles = new Set();
        const items = parsed.rows.map((record, index) => {
            const row = record.__row || index + 2;
            const name = clean(record.Name);
            const description = clean(record.Description);
            const fileName = mediaBaseName(record['File Name']);
            const key = fileName;
            if (!name) errors.push(`CSV row ${row}: Name is required.`);
            if (name.length > MAX_ITEM_NAME_LENGTH) errors.push(`CSV row ${row}: Name exceeds ${MAX_ITEM_NAME_LENGTH} characters.`);
            if (!description) warnings.push(`CSV row ${row}: Description is empty.`);
            if (description.length > MAX_ITEM_DESCRIPTION_LENGTH) errors.push(`CSV row ${row}: Description exceeds ${MAX_ITEM_DESCRIPTION_LENGTH.toLocaleString()} characters.`);
            if (!fileName) errors.push(`CSV row ${row}: File Name is required.`);
            if (seenNames.has(name.toLowerCase())) warnings.push(`CSV row ${row}: duplicate item name “${name}”.`);
            seenNames.add(name.toLowerCase());
            if (key) referencedFiles.add(key);
            if (key && !fileMap.has(key)) {
                const caseMatch = caseFoldedFiles.get(key.toLowerCase());
                errors.push(caseMatch
                    ? `CSV row ${row}: media reference must use the exact filename casing on disk: media/${caseMatch}.`
                    : `CSV row ${row}: media file “${fileName}” was not supplied.`);
            }
            if (fileName && !SUPPORTED_MEDIA_EXTENSIONS.includes(mediaExtension(fileName))) errors.push(`CSV row ${row}: “${fileName}” uses an unsupported media format.`);
            const attributes = {};
            attributeHeaders.forEach((header) => {
                const trait = header.slice(11, -1).trim();
                const value = clean(record[header]);
                if (trait.length > MAX_TRAIT_KEY_LENGTH) errors.push(`CSV row ${row}: trait name “${trait.slice(0, 40)}…” exceeds ${MAX_TRAIT_KEY_LENGTH} characters.`);
                if (value.length > MAX_TRAIT_VALUE_LENGTH) errors.push(`CSV row ${row}: trait “${trait}” exceeds ${MAX_TRAIT_VALUE_LENGTH} characters.`);
                if (trait && value) attributes[trait] = value;
            });
            if (Object.keys(attributes).length > MAX_TRAITS_PER_ITEM) errors.push(`CSV row ${row}: item has more than ${MAX_TRAITS_PER_ITEM} populated traits.`);
            return {
                index,
                name,
                description,
                fileName,
                reserved: reservedFlag(record['Reserve For Creator'], row, errors),
                attributes,
            };
        });
        if (!items.length) errors.push('Metadata CSV must contain at least one item.');
        mediaFiles.forEach((file) => {
            if (!referencedFiles.has(file.name) && file.name !== projectResult.value.heroFile) {
                warnings.push(`Media file “${file.name}” is not referenced by the CSV.`);
            }
        });
        if (projectResult.value.heroFile && !fileMap.has(projectResult.value.heroFile)) {
            const caseMatch = caseFoldedFiles.get(projectResult.value.heroFile.toLowerCase());
            errors.push(caseMatch
                ? `Hero reference must use the exact filename casing on disk: media/${caseMatch}.`
                : `Hero file “${projectResult.value.heroFile}” was not supplied.`);
        }
        const publicSupply = items.filter((item) => !item.reserved).length;
        const reservedSupply = items.length - publicSupply;
        if (items.length && publicSupply === 0) errors.push('At least one NFT must be available for public minting.');
        if (projectResult.value.intendedSupply && projectResult.value.intendedSupply !== items.length) {
            errors.push(`Intended collection supply (${projectResult.value.intendedSupply}) does not match the ${items.length} metadata rows.`);
        }
        projectResult.value.stages.forEach((stage) => {
            if (stage.allocation > publicSupply) errors.push(`Mint stage “${stage.name}” allocation exceeds the public supply.`);
            if (stage.allowlistOnly && stage.allocation > 0) {
                const reachable = stage.allowlist.reduce((total, entry) => total + Math.min(stage.walletLimit, entry.limit), 0);
                if (reachable < stage.allocation) errors.push(`Mint stage “${stage.name}” allocates ${stage.allocation} allowlist mints but its wallet quotas can reach only ${reachable}.`);
            }
        });
        const hasUncappedStage = projectResult.value.stages.some((stage) => !stage.allowlistOnly && stage.allocation === 0);
        const finiteStageCapacity = projectResult.value.stages.reduce((total, stage) => {
            if (!stage.allowlistOnly) return total + stage.allocation;
            const allowlistCapacity = stage.allowlist.reduce((stageTotal, entry) => stageTotal + Math.min(stage.walletLimit, entry.limit), 0);
            return total + (stage.allocation === 0 ? allowlistCapacity : Math.min(stage.allocation, allowlistCapacity));
        }, 0);
        if (publicSupply > 0 && !hasUncappedStage && finiteStageCapacity < publicSupply) {
            errors.push(`Mint stages can reach only ${finiteStageCapacity} of ${publicSupply} public items after allowlist limits. Add enough reachable capacity or an uncapped public stage.`);
        }
        return {
            valid: errors.length === 0,
            project: projectResult.value,
            items,
            files: mediaFiles,
            supply: items.length,
            publicSupply,
            reservedSupply,
            errors,
            warnings,
        };
    }

    function joinUrl(base, fileName) {
        if (!base) return fileName;
        return `${base.replace(/\/$/, '')}/${encodeURIComponent(fileName).replace(/%2F/gi, '/')}`;
    }

    function prepareLaunch(validation, options = {}) {
        if (!validation?.valid) throw new Error('Cannot prepare a launch with validation errors.');
        const project = validation.project;
        if (project.reveal.mode !== 'instant') throw new Error('The current managed Drop reveals metadata instantly; delayed reveal projects cannot be prepared.');
        if (!project.mediaReleaseVerified) {
            throw new Error('Preparation requires confirmation that the content-hashed R2 manifest, public URLs, and bucket lock were verified.');
        }
        const mediaBaseUrl = clean(options.mediaBaseUrl || project.mediaBaseUrl);
        const mediaUrlValidation = validateMediaBaseUrl(mediaBaseUrl, { requireReleasePath: true, collectionId: project.id });
        if (!mediaUrlValidation.valid) throw new Error(mediaUrlValidation.error);
        const platformTreasury = normalizeSuiAddress(options.platformTreasury || '');
        if (!platformTreasury || /^0x0{64}$/.test(platformTreasury)) throw new Error('A valid nonzero AlphaCity platform treasury address is required.');
        const contract = options.contract || project.contract || {};
        const normalizedPackageId = normalizeSuiAddress(contract.packageId || '');
        const normalizedDropId = normalizeSuiAddress(contract.dropId || '');
        const live = Boolean(normalizedPackageId && normalizedDropId
            && !/^0x0{64}$/.test(normalizedPackageId)
            && !/^0x0{64}$/.test(normalizedDropId));
        const upgradePolicy = clean(contract.upgradePolicy);
        const upgradeAuthority = normalizeSuiAddress(contract.upgradeAuthority || '');
        const displayAuthority = normalizeSuiAddress(contract.displayAuthority || '');
        const adminAuthority = normalizeSuiAddress(contract.adminAuthority || '');
        if (live && !['immutable', 'multisig'].includes(upgradePolicy)) {
            throw new Error('A live collection must record an UpgradeCap release policy of “immutable” or “multisig”.');
        }
        if (live && upgradePolicy === 'multisig' && (!upgradeAuthority || /^0x0{64}$/.test(upgradeAuthority))) {
            throw new Error('A live collection using multisig upgrade custody must record its nonzero multisig address.');
        }
        if (live && (!displayAuthority || /^0x0{64}$/.test(displayAuthority))) {
            throw new Error('A live collection must record the nonzero multisig that secures its mutable DisplayCap.');
        }
        if (live && (!adminAuthority || /^0x0{64}$/.test(adminAuthority))) {
            throw new Error('A live collection must record the nonzero multisig that secures its AdminCap.');
        }
        const expectedStageCount = project.stages.length;
        const expectedAllowlistEntryCount = project.stages.reduce((total, stage) => total + stage.allowlist.length, 0);
        const deploymentManifest = {
            schemaVersion: 2,
            assignmentPolicy: project.assignmentPolicy,
            collectionName: project.name,
            collectionDescription: project.description,
            creatorAddress: project.creatorAddress,
            platformTreasury,
            platformFeeBps: project.platformFeeBps,
            royaltyBps: project.royaltyBps,
            totalSupply: validation.supply,
            publicSupply: validation.publicSupply,
            reservedSupply: validation.reservedSupply,
            maxPerTx: project.maxPerTx,
            expectedStageCount,
            expectedAllowlistEntryCount,
            stages: project.stages.map((stage) => ({
                id: stage.id,
                name: stage.name,
                priceMist: stage.priceMist,
                startTimeMs: stage.startTimeMs,
                endTimeMs: stage.endTimeMs,
                walletLimit: stage.walletLimit,
                allocation: stage.allocation,
                allowlistOnly: stage.allowlistOnly,
            })),
        };
        const items = validation.items.map((item) => ({
            ...item,
            mediaUrl: joinUrl(mediaBaseUrl, item.fileName),
            attributeKeys: Object.keys(item.attributes),
            attributeValues: Object.values(item.attributes),
            attributesJson: JSON.stringify(item.attributes),
        }));
        items.forEach((item) => {
            if (item.mediaUrl.length > MAX_MEDIA_URL_LENGTH) throw new Error(`${item.fileName} produces a media URL longer than ${MAX_MEDIA_URL_LENGTH.toLocaleString()} characters.`);
        });
        const firstStage = project.stages[0];
        const heroImage = joinUrl(mediaBaseUrl, project.heroFile);
        const publicItems = items.filter((item) => !item.reserved);
        return {
            generatedAt: new Date().toISOString(),
            initialization: {
                name: project.name,
                description: project.description,
                creatorAddress: project.creatorAddress,
                platformTreasury,
                platformFeeBps: project.platformFeeBps,
                royaltyBps: project.royaltyBps,
                maxPerTx: project.maxPerTx,
                expectedStageCount,
                expectedAllowlistEntryCount,
                assignmentPolicy: project.assignmentPolicy,
                deploymentManifest,
                publicSupply: validation.publicSupply,
                reservedSupply: validation.reservedSupply,
                stages: project.stages,
                publicItems,
                reservedItems: items.filter((item) => item.reserved),
            },
            collection: {
                id: project.id,
                name: project.name,
                creator: {
                    name: project.creatorName,
                    address: project.creatorAddress,
                    website: project.website,
                    twitter: project.twitter,
                    discord: project.discord,
                },
                eyebrow: project.eyebrow,
                headline: project.headline,
                tagline: project.tagline,
                description: project.description,
                supply: validation.supply,
                publicSupply: validation.publicSupply,
                reservedSupply: validation.reservedSupply,
                minted: 0,
                priceSui: Number(firstStage.priceSui || 0),
                maxPerTx: project.maxPerTx,
                assignmentPolicy: project.assignmentPolicy,
                royaltyBps: project.royaltyBps,
                platformFeeBps: project.platformFeeBps,
                network: { ...DEFAULT_NETWORK },
                status: live ? 'live' : 'coming-soon',
                statusLabel: live ? 'Minting Live' : 'Awaiting Publication',
                heroImage,
                gallery: publicItems.slice(0, 8).map((item) => ({ name: item.name, image: item.mediaUrl })),
                mintNote: live ? 'Mint directly from the collection contract on Sui.' : 'Assets are validated. Contract publication is the remaining step.',
                contract: live ? {
                    mode: 'managed-drop',
                    packageId: normalizedPackageId,
                    module: clean(contract.module) || 'managed_drop',
                    dropId: normalizedDropId,
                    deploymentManifest,
                    upgradePolicy,
                    upgradeAuthority,
                    displayAuthority,
                    adminAuthority,
                    ctaLabel: 'Mint now',
                } : {
                    mode: 'coming-soon',
                    deploymentManifest,
                    ctaLabel: 'Mint opens soon',
                    message: 'This collection has been prepared but is not published on-chain yet.',
                },
                phases: project.stages.map((stage, index) => ({
                    id: stage.id,
                    name: stage.name,
                    description: stage.allowlistOnly ? 'Limited to approved wallets.' : 'Open to all connected Sui wallets.',
                    priceMist: stage.priceMist,
                    priceSui: stage.priceSui,
                    startTimeMs: stage.startTimeMs,
                    endTimeMs: stage.endTimeMs,
                    walletLimit: stage.walletLimit,
                    allocation: stage.allocation,
                    allowlistOnly: stage.allowlistOnly,
                    state: index === 0 ? 'upcoming' : 'scheduled',
                })),
                details: [
                    { label: 'Network', value: DEFAULT_NETWORK.name },
                    { label: 'Collection Size', value: `${validation.supply.toLocaleString()} NFTs` },
                    { label: 'Creator', value: project.creatorName },
                    { label: 'Royalty metadata', value: `${project.royaltyBps / 100}%` },
                ],
            },
        };
    }

    function metadataExampleCsv() {
        return [
            REQUIRED_COLUMNS.concat(['attributes[Background]', 'attributes[Edition]']).map(escapeCsv).join(','),
            ['Example #1', 'First item', '001.png', 'false', 'Midnight', 'Genesis'].map(escapeCsv).join(','),
            ['Example #2', 'Reserved for the project', '002.png', 'true', 'Sunrise', 'Genesis'].map(escapeCsv).join(','),
        ].join('\n');
    }

    return Object.freeze({
        ASSIGNMENT_POLICY,
        DEFAULT_NETWORK,
        MAX_FILE_BYTES,
        MAX_COLLECTION_NAME_LENGTH,
        MAX_ITEM_DESCRIPTION_LENGTH,
        MAX_ITEM_NAME_LENGTH,
        MAX_MEDIA_URL_LENGTH,
        MAX_TRAITS_PER_ITEM,
        MAX_TRAIT_KEY_LENGTH,
        MAX_TRAIT_VALUE_LENGTH,
        MIST_PER_SUI,
        U64_MAX,
        REQUIRED_COLUMNS,
        SUPPORTED_MEDIA_EXTENSIONS,
        isValidSuiAddress,
        mediaBaseName,
        metadataExampleCsv,
        mediaTypeFromBytes,
        mistToSui,
        normalizeProject,
        normalizeSuiAddress,
        parseCsv,
        prepareLaunch,
        slugify,
        suiToMist,
        validateMediaSignature,
        validateMediaBaseUrl,
        validateSubmission,
    });
});
