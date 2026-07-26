/**
 * Alpha City – Wallet Connection Sync
 *
 * This script standardizes wallet persistence across all pages.
 * It ensures that connecting a wallet on any page (staking, swap, airdrop, etc.)
 * is reflected on all other pages without requiring the user to reconnect.
 *
 * Canonical key: "alphacity_wallet" → JSON { walletName, address }
 *
 * Legacy / page-specific keys that are kept in sync:
 *   - ac_staking_provider / ac_staking_account  (staking page bundle)
 *   - ac_secrets_provider / ac_secrets_account  (secrets page)
 *   - alphacity_airdrop_wallet                  (legacy airdrop key)
 */
(function () {
    'use strict';

    var CANONICAL_KEY = 'alphacity_wallet';

    // All known alternative key sets used by individual pages
    var ALT_PAIRS = [
        { provider: 'ac_staking_provider', account: 'ac_staking_account' },
        { provider: 'ac_secrets_provider', account: 'ac_secrets_account' },
        { provider: 'ac_analyze_provider', account: 'ac_analyze_account' },
        { provider: 'ac_sluice_provider', account: 'ac_sluice_account' }
    ];
    var LEGACY_JSON_KEYS = ['alphacity_airdrop_wallet'];

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    function canonicalWalletName(value) {
        var name = String(value || '').replace(/\s+/g, ' ').trim();
        return /^phantom\s*\(\s*sui\s*\)$/i.test(name) ? 'Phantom' : name;
    }

    function notify(session) {
        try {
            window.dispatchEvent(new CustomEvent('alphacity-wallet-change', { detail: session || null }));
        } catch (_) {}
    }

    function readCanonical() {
        try {
            var raw = localStorage.getItem(CANONICAL_KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (parsed && parsed.walletName && parsed.address) {
                return { walletName: canonicalWalletName(parsed.walletName), address: parsed.address };
            }
        } catch (_) {}
        return null;
    }

    function writeCanonical(walletName, address) {
        if (!walletName || !address) return;
        walletName = canonicalWalletName(walletName);
        try {
            localStorage.setItem(CANONICAL_KEY, JSON.stringify({ walletName: walletName, address: address }));
        } catch (_) {}
        notify({ walletName: walletName, address: address });
    }

    function clearAll() {
        try { localStorage.removeItem(CANONICAL_KEY); } catch (_) {}
        ALT_PAIRS.forEach(function (pair) {
            try { localStorage.removeItem(pair.provider); } catch (_) {}
            try { localStorage.removeItem(pair.account); } catch (_) {}
        });
        LEGACY_JSON_KEYS.forEach(function (key) {
            try { localStorage.removeItem(key); } catch (_) {}
        });
        notify(null);
    }

    function syncFromCanonical(walletName, address) {
        walletName = canonicalWalletName(walletName);
        ALT_PAIRS.forEach(function (pair) {
            try {
                localStorage.setItem(pair.provider, walletName);
                localStorage.setItem(pair.account, address);
            } catch (_) {}
        });
        LEGACY_JSON_KEYS.forEach(function (key) {
            try {
                localStorage.setItem(key, JSON.stringify({ walletName: walletName, address: address }));
            } catch (_) {}
        });
    }

    // ---------------------------------------------------------------
    // On load: resolve the current wallet state from any known source
    // ---------------------------------------------------------------

    function resolveOnLoad() {
        var canonical = readCanonical();
        if (canonical) {
            writeCanonical(canonical.walletName, canonical.address);
            syncFromCanonical(canonical.walletName, canonical.address);
            return;
        }

        // Try alternative pair keys
        for (var i = 0; i < ALT_PAIRS.length; i++) {
            var pair = ALT_PAIRS[i];
            try {
                var prov = localStorage.getItem(pair.provider);
                var acct = localStorage.getItem(pair.account);
                if (prov && acct) {
                    writeCanonical(prov, acct);
                    syncFromCanonical(prov, acct);
                    return;
                }
            } catch (_) {}
        }

        // Try legacy JSON keys
        for (var j = 0; j < LEGACY_JSON_KEYS.length; j++) {
            try {
                var raw = localStorage.getItem(LEGACY_JSON_KEYS[j]);
                if (!raw) continue;
                var parsed = JSON.parse(raw);
                if (parsed && parsed.walletName && parsed.address) {
                    writeCanonical(parsed.walletName, parsed.address);
                    syncFromCanonical(parsed.walletName, parsed.address);
                    return;
                }
            } catch (_) {}
        }
    }

    resolveOnLoad();

    // ---------------------------------------------------------------
    // Intercept localStorage writes to keep everything in sync
    // ---------------------------------------------------------------

    var origSetItem = localStorage.setItem.bind(localStorage);
    var origRemoveItem = localStorage.removeItem.bind(localStorage);

    localStorage.setItem = function (key, value) {
        origSetItem(key, value);

        // If canonical key was written, sync outward
        if (key === CANONICAL_KEY) {
            try {
                var parsed = JSON.parse(value);
                if (parsed && parsed.walletName && parsed.address) {
                    var canonicalName = canonicalWalletName(parsed.walletName);
                    if (canonicalName !== parsed.walletName) {
                        origSetItem(CANONICAL_KEY, JSON.stringify({ walletName: canonicalName, address: parsed.address }));
                    }
                    syncFromCanonicalViaOrig(canonicalName, parsed.address);
                    notify({ walletName: canonicalName, address: parsed.address });
                }
            } catch (_) {}
            return;
        }

        // If a legacy JSON key was written, sync to canonical
        if (LEGACY_JSON_KEYS.indexOf(key) !== -1) {
            try {
                var parsed2 = JSON.parse(value);
                if (parsed2 && parsed2.walletName && parsed2.address) {
                    var canonicalName2 = canonicalWalletName(parsed2.walletName);
                    origSetItem(CANONICAL_KEY, JSON.stringify({ walletName: canonicalName2, address: parsed2.address }));
                    syncFromCanonicalViaOrig(canonicalName2, parsed2.address, key);
                    notify({ walletName: canonicalName2, address: parsed2.address });
                }
            } catch (_) {}
            return;
        }

        // If an alt-pair provider key was written, wait for account key and sync
        for (var i = 0; i < ALT_PAIRS.length; i++) {
            var pair = ALT_PAIRS[i];
            if (key === pair.provider || key === pair.account) {
                try {
                    var prov = localStorage.getItem(pair.provider);
                    var acct = localStorage.getItem(pair.account);
                    if (prov && acct) {
                        var canonicalProvider = canonicalWalletName(prov);
                        origSetItem(CANONICAL_KEY, JSON.stringify({ walletName: canonicalProvider, address: acct }));
                        syncFromCanonicalViaOrig(canonicalProvider, acct, pair.provider, pair.account);
                        notify({ walletName: canonicalProvider, address: acct });
                    }
                } catch (_) {}
                return;
            }
        }
    };

    localStorage.removeItem = function (key) {
        origRemoveItem(key);

        // If canonical was removed, clear all
        if (key === CANONICAL_KEY) {
            clearAllViaOrig();
            notify(null);
            return;
        }

        // If a legacy key was removed, clear canonical
        if (LEGACY_JSON_KEYS.indexOf(key) !== -1) {
            clearAllViaOrig();
            notify(null);
            return;
        }

        // If an alt-pair key was removed, clear canonical
        for (var i = 0; i < ALT_PAIRS.length; i++) {
            var pair = ALT_PAIRS[i];
            if (key === pair.provider || key === pair.account) {
                clearAllViaOrig();
                notify(null);
                return;
            }
        }
    };

    // Sync helpers that use origSetItem to avoid infinite recursion
    function syncFromCanonicalViaOrig(walletName, address, skipKey1, skipKey2) {
        walletName = canonicalWalletName(walletName);
        ALT_PAIRS.forEach(function (pair) {
            if (pair.provider !== skipKey1 && pair.provider !== skipKey2) {
                try { origSetItem(pair.provider, walletName); } catch (_) {}
            }
            if (pair.account !== skipKey1 && pair.account !== skipKey2) {
                try { origSetItem(pair.account, address); } catch (_) {}
            }
        });
        LEGACY_JSON_KEYS.forEach(function (key) {
            if (key !== skipKey1 && key !== skipKey2) {
                try { origSetItem(key, JSON.stringify({ walletName: walletName, address: address })); } catch (_) {}
            }
        });
    }

    function clearAllViaOrig() {
        try { origRemoveItem(CANONICAL_KEY); } catch (_) {}
        ALT_PAIRS.forEach(function (pair) {
            try { origRemoveItem(pair.provider); } catch (_) {}
            try { origRemoveItem(pair.account); } catch (_) {}
        });
        LEGACY_JSON_KEYS.forEach(function (key) {
            try { origRemoveItem(key); } catch (_) {}
        });
    }

    // ---------------------------------------------------------------
    // Listen for storage events from other tabs/windows
    // ---------------------------------------------------------------

    window.addEventListener('storage', function (e) {
        if (e.key === CANONICAL_KEY) {
            if (e.newValue) {
                try {
                    var parsed = JSON.parse(e.newValue);
                    if (parsed && parsed.walletName && parsed.address) {
                        var canonicalName = canonicalWalletName(parsed.walletName);
                        syncFromCanonicalViaOrig(canonicalName, parsed.address);
                        notify({ walletName: canonicalName, address: parsed.address });
                    }
                } catch (_) {}
            } else {
                clearAllViaOrig();
                notify(null);
            }
        }
    });
})();
