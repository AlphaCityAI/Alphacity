(function launchpadOperator() {
    'use strict';
    const core = window.AlphaCityLaunchpadCore;
    if (!core) throw new Error('Launchpad validation tools did not load.');

    const state = { csvText: '', csvName: '', mediaFiles: [], imported: null, validation: null, wallet: null };
    const byId = (id) => document.getElementById(id);
    const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
    const value = (id) => byId(id).value.trim();
    const intValue = (id, fallback) => Number.parseInt(value(id), 10) || fallback;

    function localDateTime(timestamp) {
        const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
        return date.toISOString().slice(0, 16);
    }

    function formProject() {
        const importedAllowlist = state.imported?.stages?.[0]?.allowlist || [];
        return {
            schemaVersion: 3,
            id: value('slug'),
            name: value('name'),
            creatorName: value('creator-name'),
            creatorAddress: value('creator-address'),
            headline: value('headline'),
            description: value('description'),
            website: value('website'),
            twitter: value('twitter'),
            heroFile: value('hero-file'),
            mediaBaseUrl: value('media-base-url'),
            royaltyBps: intValue('royalty-bps', 0),
            platformFeeBps: intValue('platform-fee-bps', 0),
            maxPerTx: intValue('max-per-tx', 5),
            assignmentPolicy: byId('assignment-policy-equivalent').checked ? core.ASSIGNMENT_POLICY : '',
            reveal: { mode: 'instant' },
            stages: [{
                name: value('stage-name'),
                priceSui: value('price-sui'),
                startTime: value('start-time'),
                endTime: value('end-time'),
                walletLimit: intValue('wallet-limit', 1),
                allocation: state.imported?.stages?.[0]?.allocation || 0,
                allowlistOnly: byId('allowlist-only').checked,
                allowlist: importedAllowlist,
            }, ...(state.imported?.stages || []).slice(1)],
            contract: {
                packageId: value('package-id'),
                dropId: value('drop-id'),
                module: state.imported?.contract?.module || 'managed_drop',
                upgradePolicy: value('upgrade-policy'),
                upgradeAuthority: value('upgrade-authority'),
                displayAuthority: value('display-authority'),
                adminAuthority: value('admin-authority'),
            },
        };
    }

    function setValue(id, next) { if (next != null) byId(id).value = next; }

    function populate(project) {
        state.imported = project;
        setValue('name', project.name);
        setValue('slug', project.id);
        setValue('creator-name', project.creatorName || project.creator?.name);
        setValue('creator-address', project.creatorAddress || project.creator?.address);
        setValue('headline', project.headline);
        setValue('description', project.description);
        setValue('website', project.website || project.creator?.website);
        setValue('twitter', project.twitter || project.creator?.twitter);
        setValue('hero-file', project.heroFile);
        setValue('media-base-url', project.mediaBaseUrl);
        setValue('royalty-bps', project.royaltyBps);
        setValue('platform-fee-bps', project.platformFeeBps);
        setValue('max-per-tx', project.maxPerTx);
        byId('assignment-policy-equivalent').checked = project.assignmentPolicy === core.ASSIGNMENT_POLICY;
        const stage = project.stages?.[0] || {};
        setValue('stage-name', stage.name);
        setValue('price-sui', stage.priceSui);
        if (stage.startTime) setValue('start-time', localDateTime(Date.parse(stage.startTime)));
        if (stage.endTime) setValue('end-time', localDateTime(Date.parse(stage.endTime)));
        setValue('wallet-limit', stage.walletLimit);
        byId('allowlist-only').checked = Boolean(stage.allowlistOnly);
        setValue('package-id', project.contract?.packageId);
        setValue('drop-id', project.contract?.dropId);
        setValue('upgrade-policy', project.contract?.upgradePolicy || '');
        setValue('upgrade-authority', project.contract?.upgradeAuthority);
        setValue('display-authority', project.contract?.displayAuthority);
        setValue('admin-authority', project.contract?.adminAuthority);
        validate(false);
    }

    function download(name, contents, type) {
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(new Blob([contents], { type }));
        anchor.download = name;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
    }

    function renderMessages(result) {
        const container = byId('validation-messages');
        const messages = [
            ...result.errors.map((message) => ({ type: 'error', message })),
            ...result.warnings.map((message) => ({ type: 'warning', message })),
        ];
        container.classList.toggle('hidden', !messages.length);
        container.innerHTML = messages.map(({ type, message }) => `<div class="rounded-xl border px-4 py-3 text-sm ${type === 'error' ? 'border-red-400/25 bg-red-400/10 text-red-100' : 'border-yellow-400/20 bg-yellow-400/10 text-yellow-100'}">${escapeHtml(message)}</div>`).join('');
    }

    function renderItems(result) {
        const body = byId('item-table');
        if (!result.items.length) {
            body.innerHTML = '<tr><td colspan="5" class="px-4 py-10 text-center text-dark-text-secondary">No item rows found.</td></tr>';
            return;
        }
        body.innerHTML = result.items.map((item) => `<tr class="bg-dark-bg/35"><td class="px-4 py-3 text-dark-text-secondary">${item.index + 1}</td><td class="px-4 py-3 font-semibold text-white">${escapeHtml(item.name || 'Missing name')}</td><td class="px-4 py-3 font-mono text-xs text-gray-300">${escapeHtml(item.fileName || 'Missing file')}</td><td class="px-4 py-3 text-dark-text-secondary">${Object.keys(item.attributes).length}</td><td class="px-4 py-3"><span class="rounded-full px-2.5 py-1 text-xs font-semibold ${item.reserved ? 'bg-yellow-400/10 text-yellow-200' : 'bg-blue-400/10 text-blue-200'}">${item.reserved ? 'Reserved' : 'Public'}</span></td></tr>`).join('');
    }

    function readinessRow(done, label, detail) {
        return `<div class="flex gap-3"><span class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${done ? 'bg-green-400/15 text-green-300' : 'bg-gray-700 text-gray-400'}">${done ? '✓' : '·'}</span><div><p class="text-sm font-semibold ${done ? 'text-white' : 'text-gray-400'}">${escapeHtml(label)}</p><p class="mt-0.5 text-xs leading-5 text-dark-text-secondary">${escapeHtml(detail)}</p></div></div>`;
    }

    function renderReadiness(result) {
        const project = result?.project || core.normalizeProject(formProject()).value;
        const connected = Boolean(state.wallet);
        const hasContract = core.isValidSuiAddress(value('package-id')) && core.isValidSuiAddress(value('drop-id'));
        byId('readiness-list').innerHTML = [
            readinessRow(Boolean(project.name && project.creatorAddress), 'Preferences complete', 'Collection identity and payout destination'),
            readinessRow(Boolean(state.csvText), 'Metadata loaded', state.csvName || 'CSV required'),
            readinessRow(state.mediaFiles.length > 0, 'Media loaded', `${state.mediaFiles.length} file${state.mediaFiles.length === 1 ? '' : 's'} selected`),
            readinessRow(/^https:\/\//i.test(value('media-base-url')), 'Hosted media recorded', value('media-base-url') || 'HTTPS base URL required for export'),
            readinessRow(Boolean(result?.valid), 'Package validated', result ? `${result.errors.length} errors · ${result.warnings.length} warnings` : 'Run validation'),
            readinessRow(connected, 'Operator wallet connected', connected ? state.wallet.address : 'Required only for on-chain publication'),
            readinessRow(hasContract, 'Contract published', hasContract ? 'Package and drop IDs recorded' : 'Complete after multisig publication'),
        ].join('');
    }

    function updateExportButton() {
        const button = byId('export-bundle');
        const ready = Boolean(state.validation?.valid && core.isValidSuiAddress(value('platform-treasury')) && /^https:\/\//i.test(value('media-base-url')));
        button.disabled = !ready;
        button.className = ready
            ? 'rounded-xl bg-brand-secondary px-5 py-3 font-bold text-gray-900 shadow-lg shadow-yellow-500/20 hover:bg-yellow-300'
            : 'rounded-xl bg-gray-700 px-5 py-3 font-bold text-gray-400';
    }

    function validate(showEmptyErrors = true) {
        const result = core.validateSubmission(formProject(), state.csvText, state.mediaFiles);
        state.validation = result;
        const badge = byId('validation-badge');
        if (!state.csvText && !showEmptyErrors) {
            badge.className = 'rounded-full border border-gray-600 bg-gray-700/50 px-3 py-1 text-xs font-semibold text-gray-300';
            badge.textContent = 'Not validated';
        } else if (result.valid) {
            badge.className = 'rounded-full border border-green-400/25 bg-green-400/10 px-3 py-1 text-xs font-semibold text-green-300';
            badge.textContent = `${result.supply} items ready`;
        } else {
            badge.className = 'rounded-full border border-red-400/25 bg-red-400/10 px-3 py-1 text-xs font-semibold text-red-200';
            badge.textContent = `${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`;
        }
        renderMessages(showEmptyErrors || state.csvText ? result : { errors: [], warnings: result.warnings });
        renderItems(result);
        renderReadiness(result);
        updateExportButton();
        return result;
    }

    byId('manifest-file').addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try { populate(JSON.parse(await file.text())); }
        catch (error) { alert(`Could not import project JSON: ${error.message}`); }
        event.target.value = '';
    });

    byId('metadata-file').addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        state.csvText = await file.text();
        state.csvName = file.name;
        byId('csv-file-label').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
        validate();
    });

    byId('media-files').addEventListener('change', (event) => {
        state.mediaFiles = Array.from(event.target.files || []);
        const bytes = state.mediaFiles.reduce((total, file) => total + file.size, 0);
        byId('media-file-label').textContent = `${state.mediaFiles.length} files · ${(bytes / 1024 / 1024).toFixed(1)} MB`;
        validate();
    });

    byId('download-csv').addEventListener('click', () => download('alphacity-metadata-template.csv', core.metadataExampleCsv(), 'text/csv;charset=utf-8'));
    byId('validate-btn').addEventListener('click', () => validate());
    byId('export-project').addEventListener('click', () => {
        const project = formProject();
        const id = core.slugify(project.id || project.name) || 'launch';
        download(`${id}-project.json`, `${JSON.stringify(project, null, 2)}\n`, 'application/json');
    });
    byId('export-bundle').addEventListener('click', () => {
        const result = validate();
        if (!result.valid) return;
        try {
            const bundle = core.prepareLaunch(result, {
                platformTreasury: value('platform-treasury'),
                mediaBaseUrl: value('media-base-url'),
                contract: {
                    packageId: value('package-id'),
                    dropId: value('drop-id'),
                    module: 'managed_drop',
                    upgradePolicy: value('upgrade-policy'),
                    upgradeAuthority: value('upgrade-authority'),
                    displayAuthority: value('display-authority'),
                    adminAuthority: value('admin-authority'),
                },
            });
            download(`${result.project.id}-launch-bundle.json`, `${JSON.stringify(bundle, null, 2)}\n`, 'application/json');
        } catch (error) { alert(error.message); }
    });

    document.querySelectorAll('input, textarea').forEach((input) => {
        if (['file', 'checkbox'].includes(input.type)) return;
        input.addEventListener('change', () => validate(false));
    });
    byId('allowlist-only').addEventListener('change', () => validate(false));
    byId('assignment-policy-equivalent').addEventListener('change', () => validate(false));
    ['media-base-url', 'platform-treasury', 'package-id', 'drop-id', 'upgrade-authority', 'display-authority', 'admin-authority'].forEach((id) => byId(id).addEventListener('input', () => { renderReadiness(state.validation); updateExportButton(); }));
    byId('upgrade-policy').addEventListener('change', () => { renderReadiness(state.validation); updateExportButton(); });
    byId('name').addEventListener('input', () => {
        if (!byId('slug').dataset.touched) byId('slug').value = core.slugify(value('name'));
    });
    byId('slug').addEventListener('input', () => { byId('slug').dataset.touched = 'true'; });

    const start = Date.now() + 24 * 60 * 60 * 1000;
    byId('start-time').value = localDateTime(start);
    if (window.AlphaCityWalletConnector) {
        window.AlphaCityWalletConnector.create({
            button: byId('connect-wallet-btn'),
            onChange(session) { state.wallet = session; renderReadiness(state.validation); },
        });
    }
    renderReadiness(null);
})();
