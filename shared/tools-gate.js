(function () {
    'use strict';

    const CITY_TYPE = '0x308fa16c7aead43e3a49a4ff2e76205ba2a12697234f4fe80a2da66515284060::city::CITY';
    const CITY_STAKING_TYPE = '0x008856d5d6d60a088f6153dbe6f7697d19f81d1d0403695c9e9fbaecdc8b29a9::city_staking::UserStake<0x308fa16c7aead43e3a49a4ff2e76205ba2a12697234f4fe80a2da66515284060::city::CITY>';
    const GATE_THRESHOLD = 1000000n * (10n ** 9n); // 1M CITY (9 decimals)

    const isToolsPage = window.location.pathname.includes('/tools');
    const isAnalyzeLocalPreview = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname) &&
        window.location.pathname.startsWith('/intel') &&
        new URLSearchParams(window.location.search).get('preview') === '1';

    // Local-only preview keeps the production gate intact while allowing visual QA.
    if (isAnalyzeLocalPreview) {
        document.getElementById('tools-gate-style')?.remove();
        return;
    }

    // Immediately hide body for gated pages on page load
    let styleEl = null;
    if (!isToolsPage) {
        styleEl = document.getElementById('tools-gate-style');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'tools-gate-style';
            styleEl.textContent = 'body { display: none !important; }';
            document.head.appendChild(styleEl);
        }
    }

    async function rpc(method, params) {
        if (!window.AlphaCitySui?.rpc) throw new Error('SUI data client failed to load');
        return window.AlphaCitySui.rpc(method, params);
    }

    async function fetchBalances(address) {
        try {
            // Fetch liquid balance
            const balanceData = await rpc('suix_getBalance', [address, CITY_TYPE]);
            const liquid = BigInt(balanceData?.totalBalance || '0');

            // Fetch staked balance
            const stakedData = await rpc('suix_getOwnedObjects', [
                address,
                { filter: { StructType: CITY_STAKING_TYPE }, options: { showContent: true } },
                null,
                50
            ]);
            let staked = 0n;
            if (stakedData && stakedData.data) {
                for (const obj of stakedData.data) {
                    const amt = obj?.data?.content?.fields?.staked_amount;
                    if (amt) staked += BigInt(amt);
                }
            }

            return { liquid, staked, total: liquid + staked };
        } catch (e) {
            console.error('Failed to fetch balance from SUI data service:', e);
            throw e;
        }
    }

    async function verifyAccess(address) {
        // Check session storage cache
        const cachedAddress = sessionStorage.getItem('alphacity_gate_address');
        const cachedStatus = sessionStorage.getItem('alphacity_gate_status');
        const cachedLiquid = sessionStorage.getItem('alphacity_gate_liquid');
        const cachedStaked = sessionStorage.getItem('alphacity_gate_staked');
        const cachedThreshold = sessionStorage.getItem('alphacity_gate_threshold');

        if (cachedAddress === address && cachedStatus && cachedThreshold === GATE_THRESHOLD.toString()) {
            handleResult(
                cachedStatus === 'unlocked',
                BigInt(cachedLiquid || '0'),
                BigInt(cachedStaked || '0'),
                false
            );
            return;
        }

        try {
            const { liquid, staked, total } = await fetchBalances(address);
            const isAllowed = total >= GATE_THRESHOLD;

            sessionStorage.setItem('alphacity_gate_address', address);
            sessionStorage.setItem('alphacity_gate_status', isAllowed ? 'unlocked' : 'locked');
            sessionStorage.setItem('alphacity_gate_liquid', liquid.toString());
            sessionStorage.setItem('alphacity_gate_staked', staked.toString());
            sessionStorage.setItem('alphacity_gate_threshold', GATE_THRESHOLD.toString());

            handleResult(isAllowed, liquid, staked, true);
        } catch (e) {
            console.error('Verify access error:', e);
            if (isToolsPage) {
                const event = new CustomEvent('alphacity-gate-error', { detail: e.message });
                window.dispatchEvent(event);
            } else {
                window.location.href = `/tools/?redirect=${encodeURIComponent(window.location.pathname)}&reason=rpc_error&error=${encodeURIComponent(e.message)}`;
            }
        }
    }

    function handleResult(isAllowed, liquid, staked, fromRpc) {
        window.alphacityGate = {
            connected: true,
            address: currentAddress,
            liquid: liquid.toString(),
            staked: staked.toString(),
            total: (liquid + staked).toString(),
            isAllowed: isAllowed,
            fromRpc: fromRpc
        };

        if (isToolsPage) {
            const event = new CustomEvent('alphacity-gate-update', {
                detail: window.alphacityGate
            });
            window.dispatchEvent(event);
        }

        if (isAllowed) {
            if (styleEl) {
                styleEl.remove();
                styleEl = null;
            }
        } else {
            if (!isToolsPage) {
                window.location.href = `/tools/?redirect=${encodeURIComponent(window.location.pathname)}&locked=true`;
            }
        }
    }

    let currentAddress = undefined;

    function checkWalletSession() {
        const raw = localStorage.getItem('alphacity_wallet');
        let addr = null;
        if (raw) {
            try {
                addr = JSON.parse(raw).address;
            } catch (_) {}
        }

        if (addr !== currentAddress) {
            currentAddress = addr;
            if (!addr) {
                sessionStorage.removeItem('alphacity_gate_address');
                sessionStorage.removeItem('alphacity_gate_status');
                sessionStorage.removeItem('alphacity_gate_liquid');
                sessionStorage.removeItem('alphacity_gate_staked');
                sessionStorage.removeItem('alphacity_gate_threshold');

                window.alphacityGate = { connected: false };

                if (isToolsPage) {
                    window.dispatchEvent(new CustomEvent('alphacity-gate-update', {
                        detail: window.alphacityGate
                    }));
                } else {
                    window.location.href = `/tools/?redirect=${encodeURIComponent(window.location.pathname)}&reason=no_wallet`;
                }
            } else {
                verifyAccess(addr);
            }
        }
    }

    // Run immediately, then poll only while the page is visible. Storage events
    // keep wallet changes responsive without waking a hidden dashboard.
    let sessionPollTimer = null;
    function scheduleWalletCheck() {
        clearTimeout(sessionPollTimer);
        if (document.hidden) return;
        sessionPollTimer = setTimeout(() => {
            checkWalletSession();
            scheduleWalletCheck();
        }, 1500);
    }
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) clearTimeout(sessionPollTimer);
        else {
            checkWalletSession();
            scheduleWalletCheck();
        }
    });
    window.addEventListener('storage', event => {
        if (event.key === 'alphacity_wallet') checkWalletSession();
    });
    window.addEventListener('alphacity-wallet-change', checkWalletSession);
    checkWalletSession();
    scheduleWalletCheck();
})();
