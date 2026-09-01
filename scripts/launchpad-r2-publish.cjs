#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const core = require('../shared/launchpad-core.js');

const DEFAULT_PREFIX = 'collections';
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const CREDENTIAL_FLAG = /(?:api[-_]?token|access[-_]?key|secret|password|account[-_]?id)/i;
const VALUE_FLAGS = new Set(['bucket', 'public-base-url', 'prefix', 'out', 'project-dir', 'wrangler-js', 'wrangler', 'concurrency', 'timeout-ms']);
const BOOLEAN_FLAGS = new Set(['upload']);
const CONTENT_TYPES = Object.freeze({
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
});
const EXTENSION_TYPES = Object.freeze({ gif: 'gif', jpeg: 'jpeg', jpg: 'jpeg', png: 'png', webp: 'webp' });

function usage() {
    return [
        'AlphaCity immutable R2 media staging and publication',
        '',
        'Usage:',
        '  node scripts/launchpad-r2-publish.cjs <project-or-prepared-directory> --bucket <r2-bucket> --public-base-url <https://media.example> [options]',
        '',
        'Options:',
        '  --prefix <path>          R2 key prefix (default: collections)',
        '  --out <directory>        Staging directory (default: <project>/.alphacity-r2/<release-id>)',
        '  --project-dir <path>     Source project when the prepared directory is elsewhere',
        '  --wrangler-js <file>     Wrangler bin/wrangler.js path (never a .cmd/.bat wrapper)',
        '  --concurrency <1-8>      Concurrent remote operations (default: 4)',
        '  --timeout-ms <number>    Per-Wrangler-process timeout (default: 300000)',
        '  --upload                 Preflight and upload to remote R2 (default is a local dry run)',
        '',
        'Environment fallbacks:',
        '  ALPHACITY_R2_BUCKET, ALPHACITY_MEDIA_BASE_URL, ALPHACITY_R2_PREFIX, ALPHACITY_WRANGLER_JS,',
        '  ALPHACITY_R2_CONCURRENCY, ALPHACITY_R2_TIMEOUT_MS',
        '',
        'Cloudflare credentials are intentionally accepted only by Wrangler through its login or environment.',
        'This tool never creates a bucket, changes a public domain, publishes a contract, or signs a transaction.',
    ].join('\n');
}

function fail(message, code = 1) {
    process.stderr.write(`${message}\n`);
    process.exitCode = code;
}

function parseArgs(argv, env = process.env) {
    if (argv.includes('--help') || argv.includes('-h')) return { help: true };
    const inputDirectory = argv[0];
    if (!inputDirectory || inputDirectory.startsWith('-')) throw new Error('A project or prepared directory is required.');

    const flags = {};
    for (let index = 1; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) throw new Error('Unexpected positional argument.');
        const rawName = token.slice(2).split('=', 1)[0];
        if (CREDENTIAL_FLAG.test(rawName)) {
            throw new Error('Credential flags are not accepted. Authenticate Wrangler through its login or environment.');
        }
        if (token.includes('=')) throw new Error(`Use a separate value for --${rawName}.`);
        if (BOOLEAN_FLAGS.has(rawName)) {
            if (flags[rawName]) throw new Error(`Duplicate --${rawName} flag.`);
            flags[rawName] = true;
            continue;
        }
        if (!VALUE_FLAGS.has(rawName)) throw new Error(`Unknown option: --${rawName}`);
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for --${rawName}.`);
        if (flags[rawName] != null) throw new Error(`Duplicate --${rawName} option.`);
        flags[rawName] = value;
        index += 1;
    }

    const legacyWrangler = flags.wrangler;
    const wranglerJs = flags['wrangler-js'] || legacyWrangler || env.ALPHACITY_WRANGLER_JS || '';
    if (/\.(?:cmd|bat)$/i.test(wranglerJs)) {
        throw new Error('Wrangler .cmd/.bat wrappers are not accepted. Provide the package bin/wrangler.js path so it can run through Node without a shell.');
    }
    const concurrency = readIntegerOption(flags.concurrency || env.ALPHACITY_R2_CONCURRENCY || DEFAULT_CONCURRENCY,
        'concurrency', { min: 1, max: 8 });
    const timeoutMs = readIntegerOption(flags['timeout-ms'] || env.ALPHACITY_R2_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
        'timeout-ms', { min: 1_000, max: 15 * 60 * 1000 });

    return {
        help: false,
        inputDirectory,
        projectDirectory: flags['project-dir'],
        bucket: flags.bucket || env.ALPHACITY_R2_BUCKET || '',
        publicBaseUrl: flags['public-base-url'] || env.ALPHACITY_MEDIA_BASE_URL || '',
        prefix: flags.prefix || env.ALPHACITY_R2_PREFIX || DEFAULT_PREFIX,
        outputDirectory: flags.out,
        upload: Boolean(flags.upload),
        wranglerJs,
        concurrency,
        timeoutMs,
    };
}

function readIntegerOption(value, label, { min, max }) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
        throw new Error(`--${label} must be a whole number from ${min} through ${max}.`);
    }
    return number;
}

function readJson(filePath, label) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`${label} is not valid JSON: ${error.message}`);
    }
}

function isDirectory(directory) {
    try { return fs.statSync(directory).isDirectory(); }
    catch (_) { return false; }
}

function looksLikeProject(directory) {
    return isDirectory(directory)
        && fs.existsSync(path.join(directory, 'project.json'))
        && fs.existsSync(path.join(directory, 'metadata.csv'))
        && isDirectory(path.join(directory, 'media'));
}

function resolveInput(inputDirectory, projectDirectory) {
    const input = path.resolve(inputDirectory);
    if (!isDirectory(input)) throw new Error('Input directory was not found.');

    const preparedPath = path.join(input, 'launch-bundle.json');
    const prepared = fs.existsSync(preparedPath) ? readJson(preparedPath, 'launch-bundle.json') : null;
    let project;
    if (projectDirectory) {
        project = path.resolve(projectDirectory);
    } else if (looksLikeProject(input)) {
        project = input;
    } else if (prepared && looksLikeProject(path.dirname(input))) {
        project = path.dirname(input);
    } else {
        throw new Error('Could not locate project.json, metadata.csv, and media/. Use --project-dir when staging an external prepared directory.');
    }
    if (!looksLikeProject(project)) throw new Error('The source project must contain project.json, metadata.csv, and media/.');
    return { input, project, prepared };
}

function readAndValidateProject(projectDirectory) {
    const projectPath = path.join(projectDirectory, 'project.json');
    const metadataPath = path.join(projectDirectory, 'metadata.csv');
    const mediaDirectory = path.join(projectDirectory, 'media');
    const project = readJson(projectPath, 'project.json');
    const csvText = fs.readFileSync(metadataPath, 'utf8');
    const files = fs.readdirSync(mediaDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
            const absolutePath = path.join(mediaDirectory, entry.name);
            const stat = fs.statSync(absolutePath);
            return { name: entry.name, size: stat.size, type: '', absolutePath };
        });
    const validation = core.validateSubmission(project, csvText, files);
    if (!validation.valid) {
        throw new Error(`Project validation failed:\n${validation.errors.map((error) => `- ${error}`).join('\n')}`);
    }
    return { project, validation, mediaDirectory };
}

function validatePreparedBundle(prepared, validation) {
    if (!prepared) return;
    const preparedId = core.slugify(prepared.collection?.id || '');
    if (!preparedId || preparedId !== validation.project.id) {
        throw new Error('The prepared launch bundle does not match the source project collection ID.');
    }
    if (Number(prepared.collection?.supply) !== validation.supply) {
        throw new Error('The prepared launch bundle supply does not match the validated source project.');
    }
    const preparedItems = [
        ...(Array.isArray(prepared.initialization?.publicItems) ? prepared.initialization.publicItems : []),
        ...(Array.isArray(prepared.initialization?.reservedItems) ? prepared.initialization.reservedItems : []),
    ];
    const canonicalItem = (item) => ({
        index: Number(item?.index),
        name: String(item?.name ?? ''),
        description: String(item?.description ?? ''),
        fileName: String(item?.fileName ?? ''),
        reserved: Boolean(item?.reserved),
        attributes: Object.fromEntries(Object.entries(item?.attributes || {}).sort(([left], [right]) => left.localeCompare(right))),
    });
    const sortByIndex = (left, right) => left.index - right.index;
    const expected = validation.items.map(canonicalItem).sort(sortByIndex);
    const actual = preparedItems.map(canonicalItem).sort(sortByIndex);
    if (actual.length !== expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error('The prepared launch bundle inventory does not exactly match the validated source project. Prepare a fresh bundle after staging media.');
    }
}

function validateBucket(bucket) {
    if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(String(bucket))) {
        throw new Error('R2 bucket names must be 3-63 lowercase letters, numbers, or hyphens and must start and end with a letter or number.');
    }
    return String(bucket);
}

function normalizePrefix(prefix) {
    const value = String(prefix || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, '');
    const segments = value.split('/');
    if (!segments.length || segments.some((segment) => !/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(segment))) {
        throw new Error('R2 prefix segments must use lowercase letters, numbers, and hyphens.');
    }
    return segments.join('/');
}

function normalizePublicBaseUrl(value) {
    let url;
    try { url = new URL(String(value)); }
    catch (_) { throw new Error('A valid HTTPS public media base URL is required.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('The public media base URL must be an HTTPS origin without credentials, a path, a query, or a fragment.');
    }
    const host = url.hostname.toLowerCase();
    if (host === 'drive.google.com'
        || host === 'docs.google.com'
        || host === 'googleusercontent.com'
        || host.endsWith('.googleusercontent.com')
        || host === 'usercontent.google.com'
        || host.endsWith('.usercontent.google.com')) {
        throw new Error('Google Drive links are supported only as a private source or backup, not as the public NFT media URL.');
    }
    if (url.pathname !== '/') {
        throw new Error('The public media base URL must be an HTTPS origin without credentials, a path, a query, or a fragment.');
    }
    return url.origin;
}

function assertSafeFileName(fileName) {
    if (!fileName || fileName === '.' || fileName === '..'
        || fileName !== path.basename(fileName)
        || /[\\/\u0000-\u001f\u007f]/.test(fileName)) {
        throw new Error('Media filenames cannot contain directory separators or control characters.');
    }
    return fileName;
}

function byteSort(left, right) {
    return Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8'));
}

function selectReferencedMedia(validation) {
    const available = new Map(validation.files.map((file) => [file.name.toLowerCase(), file.source]));
    const requested = new Map();
    function addReference(fileName, label) {
        const key = fileName.toLowerCase();
        const source = available.get(key);
        if (!source?.absolutePath) throw new Error(`Validated media source is unavailable for ${fileName}.`);
        if (source.name !== fileName) {
            throw new Error(`${label} must match the exact filename casing on disk: media/${source.name}.`);
        }
        const previous = requested.get(key);
        if (previous && previous !== fileName) {
            throw new Error(`Media references use inconsistent filename casing: ${previous} and ${fileName}.`);
        }
        requested.set(key, fileName);
    }
    for (const item of validation.items) addReference(item.fileName, `CSV media reference “${item.fileName}”`);
    if (validation.project.heroFile) addReference(validation.project.heroFile, `Hero file “${validation.project.heroFile}”`);

    return [...requested.entries()].map(([key, requestedName]) => {
        const source = available.get(key);
        return {
            name: assertSafeFileName(requestedName),
            sourcePath: source.absolutePath,
            bytes: source.size,
        };
    }).sort(byteSort);
}

function sha256Buffer(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function contentTypeFor(fileName) {
    const extension = path.extname(fileName).slice(1).toLowerCase();
    return CONTENT_TYPES[extension] || 'application/octet-stream';
}

function detectRasterType(header) {
    const bytes = Buffer.from(header || []);
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
    if (bytes.length >= 12
        && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
        && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return '';
}

function validateRasterFile(file) {
    const extension = path.extname(file.name).slice(1).toLowerCase();
    if (extension === 'svg') {
        throw new Error(`${file.name} is SVG. Active/vector formats are not permitted for public NFT media; use PNG, JPEG, WEBP, or GIF.`);
    }
    const expected = EXTENSION_TYPES[extension];
    if (!expected) throw new Error(`${file.name} uses an unsupported public media format. Use PNG, JPEG, WEBP, or GIF.`);
    const descriptor = fs.openSync(file.sourcePath, 'r');
    const header = Buffer.alloc(12);
    let bytesRead;
    try { bytesRead = fs.readSync(descriptor, header, 0, header.length, 0); }
    finally { fs.closeSync(descriptor); }
    const detected = detectRasterType(header.subarray(0, bytesRead));
    if (!detected) {
        throw new Error(`${file.name} does not contain a recognized PNG, JPEG, WEBP, or GIF file signature.`);
    }
    if (detected !== expected) {
        throw new Error(`${file.name} has a .${extension} extension but its file signature is ${detected.toUpperCase()}.`);
    }
    return detected;
}

function encodeKeyForUrl(key) {
    return key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function joinPublicUrl(baseUrl, key) {
    return `${baseUrl}/${encodeKeyForUrl(key)}`;
}

function jsonText(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

async function buildPublication(inputConfig) {
    const source = resolveInput(inputConfig.inputDirectory, inputConfig.projectDirectory);
    const { validation, mediaDirectory } = readAndValidateProject(source.project);
    validatePreparedBundle(source.prepared, validation);
    const bucket = validateBucket(inputConfig.bucket);
    const prefix = normalizePrefix(inputConfig.prefix);
    const publicBaseUrl = normalizePublicBaseUrl(inputConfig.publicBaseUrl);
    const selected = selectReferencedMedia(validation);
    const hashedFiles = [];
    for (const file of selected) {
        const before = fs.statSync(file.sourcePath);
        validateRasterFile(file);
        const sha256 = await sha256File(file.sourcePath);
        const after = fs.statSync(file.sourcePath);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
            throw new Error(`Media changed while it was being hashed: ${file.name}. Run the dry run again.`);
        }
        hashedFiles.push({
            ...file,
            bytes: after.size,
            sha256,
            contentType: contentTypeFor(file.name),
        });
    }

    const releaseSeed = {
        schemaVersion: 1,
        bucket,
        prefix,
        publicBaseUrl,
        collectionId: validation.project.id,
        collectionName: validation.project.name,
        heroFile: validation.project.heroFile,
        files: hashedFiles.map((file) => ({
            name: file.name,
            bytes: file.bytes,
            sha256: file.sha256,
            contentType: file.contentType,
        })),
    };
    const releaseId = sha256Buffer(Buffer.from(JSON.stringify(releaseSeed), 'utf8'));
    const releaseKeyPrefix = `${prefix}/${validation.project.id}/releases/${releaseId}`;
    const mediaKeyPrefix = `${releaseKeyPrefix}/media`;
    const manifestKey = `${releaseKeyPrefix}/manifest.json`;
    const mediaBaseUrl = joinPublicUrl(publicBaseUrl, mediaKeyPrefix);
    const files = hashedFiles.map((file) => {
        const key = `${mediaKeyPrefix}/${file.name}`;
        return {
            name: file.name,
            bytes: file.bytes,
            sha256: file.sha256,
            contentType: file.contentType,
            cacheControl: CACHE_CONTROL,
            key,
            url: joinPublicUrl(publicBaseUrl, key),
            sourcePath: file.sourcePath,
        };
    });
    const hero = files.find((file) => file.name.toLowerCase() === validation.project.heroFile.toLowerCase());
    const manifest = {
        schemaVersion: 1,
        provider: 'cloudflare-r2',
        collectionId: validation.project.id,
        collectionName: validation.project.name,
        releaseId,
        storage: { bucket, keyPrefix: releaseKeyPrefix },
        publicBaseUrl,
        mediaBaseUrl,
        manifestKey,
        manifestUrl: joinPublicUrl(publicBaseUrl, manifestKey),
        heroUrl: hero?.url || '',
        files: files.map(({ sourcePath, ...file }) => file),
    };
    const manifestText = jsonText(manifest);
    const manifestSha256 = sha256Buffer(Buffer.from(manifestText, 'utf8'));

    const outputDirectory = path.resolve(inputConfig.outputDirectory
        || path.join(source.project, '.alphacity-r2', releaseId));
    const relativeToMedia = path.relative(mediaDirectory, outputDirectory);
    if (!relativeToMedia || (!relativeToMedia.startsWith('..') && !path.isAbsolute(relativeToMedia))) {
        throw new Error('The staging directory cannot be inside the source media directory.');
    }

    const objects = files.map((file) => ({
        key: file.key,
        source: `objects/${file.key}`,
        bytes: file.bytes,
        sha256: file.sha256,
        contentType: file.contentType,
        cacheControl: file.cacheControl,
    }));
    objects.push({
        key: manifestKey,
        source: 'r2-media-manifest.json',
        bytes: Buffer.byteLength(manifestText),
        sha256: manifestSha256,
        contentType: 'application/json; charset=utf-8',
        cacheControl: CACHE_CONTROL,
    });
    const plan = {
        schemaVersion: 1,
        provider: 'cloudflare-r2',
        bucket,
        releaseId,
        stageDirectory: '.',
        remote: true,
        shell: false,
        overwritePolicy: 'preflight-and-refuse-different-content',
        objects,
    };

    return {
        source,
        validation,
        outputDirectory,
        manifest,
        manifestText,
        plan,
        planText: jsonText(plan),
        files,
    };
}

function resolveStagedSource(stageDirectory, relativeSource) {
    const candidate = path.resolve(stageDirectory, relativeSource.replaceAll('/', path.sep));
    const relative = path.relative(stageDirectory, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Upload plan contains an unsafe staged source path.');
    }
    return candidate;
}

async function verifyExistingStage(publication) {
    const manifestPath = path.join(publication.outputDirectory, 'r2-media-manifest.json');
    const planPath = path.join(publication.outputDirectory, 'r2-upload-plan.json');
    if (!fs.existsSync(manifestPath) || fs.readFileSync(manifestPath, 'utf8') !== publication.manifestText
        || !fs.existsSync(planPath) || fs.readFileSync(planPath, 'utf8') !== publication.planText) {
        throw new Error('The staging directory already exists with different content. Choose a new --out directory.');
    }
    for (const object of publication.plan.objects) {
        const sourcePath = resolveStagedSource(publication.outputDirectory, object.source);
        if (!fs.existsSync(sourcePath) || (await sha256File(sourcePath)) !== object.sha256) {
            throw new Error('The staging directory exists but one or more staged objects were changed. Choose a new --out directory.');
        }
    }
}

async function stagePublication(inputConfig) {
    const publication = await buildPublication(inputConfig);
    if (fs.existsSync(publication.outputDirectory)) {
        await verifyExistingStage(publication);
        return { ...publication, reused: true };
    }

    const parent = path.dirname(publication.outputDirectory);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = `${publication.outputDirectory}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
        fs.mkdirSync(temporary);
        for (const file of publication.files) {
            const relativeSource = `objects/${file.key}`;
            const destination = resolveStagedSource(temporary, relativeSource);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(file.sourcePath, destination, fs.constants.COPYFILE_EXCL);
            validateRasterFile({ name: file.name, sourcePath: destination });
            if ((await sha256File(destination)) !== file.sha256) {
                throw new Error(`Media changed while it was being staged: ${file.name}. Run the dry run again.`);
            }
        }
        fs.writeFileSync(path.join(temporary, 'r2-media-manifest.json'), publication.manifestText, { encoding: 'utf8', flag: 'wx' });
        fs.writeFileSync(path.join(temporary, 'r2-upload-plan.json'), publication.planText, { encoding: 'utf8', flag: 'wx' });
        fs.renameSync(temporary, publication.outputDirectory);
    } catch (error) {
        fs.rmSync(temporary, { recursive: true, force: true });
        throw error;
    }
    return { ...publication, reused: false };
}

function resolveWranglerJs(configuredPath = '') {
    if (/\.(?:cmd|bat)$/i.test(configuredPath)) {
        throw new Error('Wrangler .cmd/.bat wrappers are not accepted. Provide the package bin/wrangler.js path.');
    }
    const candidates = [];
    if (configuredPath) candidates.push(path.resolve(configuredPath));
    else {
        try {
            const packageJson = require.resolve('wrangler/package.json', { paths: [path.resolve(__dirname, '..')] });
            candidates.push(path.join(path.dirname(packageJson), 'bin', 'wrangler.js'));
        } catch (_) { /* Wrangler is optional for a dry run. */ }
        candidates.push(path.resolve(__dirname, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js'));
        if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js'));
        if (process.env.npm_config_prefix) {
            candidates.push(path.join(process.env.npm_config_prefix, 'node_modules', 'wrangler', 'bin', 'wrangler.js'));
            candidates.push(path.join(process.env.npm_config_prefix, 'lib', 'node_modules', 'wrangler', 'bin', 'wrangler.js'));
        }
    }
    for (const candidate of candidates) {
        if (!/\.js$/i.test(candidate) || /[\u0000\r\n]/.test(candidate)) continue;
        try {
            if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
        } catch (_) { /* Try the next known installation location. */ }
    }
    if (configuredPath) throw new Error('The configured Wrangler JavaScript entrypoint was not found or is not a .js file.');
    throw new Error('Wrangler bin/wrangler.js was not found. Install Wrangler 4 and set ALPHACITY_WRANGLER_JS to its bin/wrangler.js path.');
}

function defaultWranglerRunner(program, args, options = {}) {
    return new Promise((resolve) => {
        let child;
        let stdout = '';
        let stderr = '';
        let capturedBytes = 0;
        let outputExceeded = false;
        let timedOut = false;
        let settled = false;
        let timer;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, outputExceeded, timedOut, ...result });
        };
        try {
            child = spawn(program, args, {
                cwd: options.cwd,
                env: process.env,
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            resolve({ status: null, stdout, stderr, error, outputExceeded, timedOut });
            return;
        }
        const capture = (target, chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            capturedBytes += buffer.length;
            if (capturedBytes > MAX_CAPTURE_BYTES) {
                outputExceeded = true;
                child.kill();
                return;
            }
            if (target === 'stdout') stdout += buffer.toString('utf8');
            else stderr += buffer.toString('utf8');
        };
        child.stdout.on('data', (chunk) => capture('stdout', chunk));
        child.stderr.on('data', (chunk) => capture('stderr', chunk));
        child.on('error', (error) => finish({ status: null, error }));
        child.on('close', (code, signal) => finish({ status: code, signal }));
        const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
        timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);
        timer.unref?.();
    });
}

function getArguments(bucket, key, destination) {
    return ['r2', 'object', 'get', `${bucket}/${key}`, '--file', destination, '--remote'];
}

function putArguments(bucket, object, sourcePath) {
    return [
        'r2', 'object', 'put', `${bucket}/${object.key}`,
        '--file', sourcePath,
        '--content-type', object.contentType,
        '--cache-control', object.cacheControl,
        '--remote',
    ];
}

function resultOutput(result) {
    return `${result?.stdout || ''}\n${result?.stderr || ''}`;
}

function isMissingObjectResult(result) {
    const output = resultOutput(result);
    return result?.status !== 0 && (/(?:^|\W)NoSuchKey(?:\W|$)/.test(output)
        || /The specified key does not exist\.(?:\s|$)/i.test(output));
}

function assertWranglerResult(result) {
    if (result?.timedOut) throw new Error('Wrangler timed out. Its output was suppressed; check authentication and connectivity.');
    if (result?.outputExceeded) throw new Error('Wrangler produced excessive output and was stopped. Its output was suppressed.');
    if (result?.error?.code === 'ENOENT') {
        throw new Error('Node could not start the Wrangler JavaScript entrypoint.');
    }
    if (result?.error) throw new Error('Wrangler could not be started. Its output was suppressed.');
}

async function mapConcurrent(items, concurrency, callback) {
    const results = new Array(items.length);
    let cursor = 0;
    let firstError = null;
    async function worker() {
        while (!firstError) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) return;
            try { results[index] = await callback(items[index], index); }
            catch (error) { firstError ||= error; }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    if (firstError) throw firstError;
    return results;
}

async function uploadPublication(publication, options = {}) {
    const runner = options.runner || defaultWranglerRunner;
    if (/\.(?:cmd|bat)$/i.test(options.wranglerJs || '')) {
        throw new Error('Wrangler .cmd/.bat wrappers are not accepted. Provide the package bin/wrangler.js path.');
    }
    const wranglerJs = options.runner ? (options.wranglerJs || 'wrangler.js') : resolveWranglerJs(options.wranglerJs);
    const concurrency = readIntegerOption(options.concurrency || DEFAULT_CONCURRENCY, 'concurrency', { min: 1, max: 8 });
    const timeoutMs = readIntegerOption(options.timeoutMs || DEFAULT_TIMEOUT_MS, 'timeout-ms', { min: 1_000, max: 15 * 60 * 1000 });
    await verifyExistingStage(publication);

    const preflightDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'alphacity-r2-preflight-'));
    try {
        const run = (argumentsList) => Promise.resolve(runner(process.execPath, [wranglerJs, ...argumentsList], {
            cwd: publication.outputDirectory,
            timeoutMs,
        }));
        const actions = await mapConcurrent(publication.plan.objects, concurrency, async (object, index) => {
            const remoteCopy = path.join(preflightDirectory, `${index}.object`);
            const result = await run(getArguments(publication.plan.bucket, object.key, remoteCopy));
            assertWranglerResult(result);
            if (result?.status === 0) {
                const remoteHash = fs.existsSync(remoteCopy) ? await sha256File(remoteCopy) : '';
                if (remoteHash !== object.sha256) {
                    throw new Error(`Remote object already exists with different content: ${object.key}. Nothing was uploaded.`);
                }
                return { object, action: 'skip' };
            } else if (isMissingObjectResult(result)) {
                return { object, action: 'upload' };
            } else {
                throw new Error(`R2 preflight failed for ${object.key}. Wrangler output was suppressed; check authentication and connectivity. Nothing was uploaded.`);
            }
        });

        const pending = actions.filter(({ action }) => action === 'upload');
        await mapConcurrent(pending, concurrency, async ({ object }, index) => {
            const sourcePath = resolveStagedSource(publication.outputDirectory, object.source);
            if ((await sha256File(sourcePath)) !== object.sha256) {
                throw new Error(`Staged object changed before upload: ${object.key}.`);
            }
            const put = await run(putArguments(publication.plan.bucket, object, sourcePath));
            assertWranglerResult(put);
            if (put?.status !== 0) {
                throw new Error(`R2 upload failed for ${object.key}. Wrangler output was suppressed; check authentication and connectivity.`);
            }

            const remoteCopy = path.join(preflightDirectory, `verify-${index}.object`);
            const get = await run(getArguments(publication.plan.bucket, object.key, remoteCopy));
            assertWranglerResult(get);
            const remoteHash = get?.status === 0 && fs.existsSync(remoteCopy) ? await sha256File(remoteCopy) : '';
            if (remoteHash !== object.sha256) {
                throw new Error(`R2 verification failed for ${object.key}. Wrangler output was suppressed.`);
            }
        });
        return { uploaded: pending.length, skipped: actions.length - pending.length, total: actions.length };
    } finally {
        fs.rmSync(preflightDirectory, { recursive: true, force: true });
    }
}

async function main() {
    let options;
    try { options = parseArgs(process.argv.slice(2)); }
    catch (error) { fail(`ERROR: ${error.message}\n\n${usage()}`); return; }
    if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return;
    }
    try {
        const publication = await stagePublication(options);
        process.stdout.write(`VALIDATED: ${publication.validation.supply} collection items\n`);
        publication.validation.warnings.forEach((warning) => process.stdout.write(`WARNING: ${warning}\n`));
        process.stdout.write(`${publication.reused ? 'REUSED' : 'STAGED'}: ${publication.outputDirectory}\n`);
        process.stdout.write(`RELEASE: ${publication.manifest.releaseId}\n`);
        process.stdout.write(`MEDIA BASE URL: ${publication.manifest.mediaBaseUrl}\n`);
        process.stdout.write(`MANIFEST URL: ${publication.manifest.manifestUrl}\n`);
        if (!options.upload) {
            process.stdout.write(`DRY RUN: ${publication.plan.objects.length} objects prepared; no network request was made.\n`);
            process.stdout.write('Review r2-media-manifest.json and r2-upload-plan.json, then rerun with --upload.\n');
            return;
        }
        const result = await uploadPublication(publication, {
            wranglerJs: options.wranglerJs,
            concurrency: options.concurrency,
            timeoutMs: options.timeoutMs,
        });
        process.stdout.write(`UPLOADED: ${result.uploaded}; VERIFIED EXISTING: ${result.skipped}; TOTAL: ${result.total}\n`);
    } catch (error) {
        fail(`ERROR: ${error.message}`);
    }
}

if (require.main === module) main();

module.exports = {
    CACHE_CONTROL,
    buildPublication,
    detectRasterType,
    defaultWranglerRunner,
    getArguments,
    isMissingObjectResult,
    normalizePrefix,
    normalizePublicBaseUrl,
    parseArgs,
    putArguments,
    resolveWranglerJs,
    resolveInput,
    sha256File,
    stagePublication,
    uploadPublication,
    validateBucket,
    validateRasterFile,
};
