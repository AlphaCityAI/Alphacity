(function (root) {
    'use strict';

    const MAX_EVENTS_PER_PAGE = 40;
    const MAX_PROPERTY_LENGTH = 48;
    const EVENT_PROPERTIES = Object.freeze({
        page_view: [],
        cta_click: ['action'],
        tool_open: ['tool', 'access'],
        wallet_dialog: ['action'],
        wallet_connect: ['status', 'provider'],
        gate_check: ['result', 'source'],
        transaction_sign: ['status'],
        client_error: ['area', 'code'],
    });

    const config = root.ALPHA_CITY_TELEMETRY_CONFIG || {};
    const endpoint = validEndpoint(config.endpoint);
    const siteId = safeToken(config.siteId || 'alphacity.tech') || 'alphacity.tech';
    const privacyOptOut = root.navigator?.globalPrivacyControl === true ||
        root.navigator?.doNotTrack === '1' ||
        root.doNotTrack === '1';
    let eventCount = 0;

    function validEndpoint(value) {
        if (!value || typeof value !== 'string') return '';
        try {
            const url = new URL(value);
            return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
        } catch (_) {
            return '';
        }
    }

    function safeToken(value) {
        if (value == null) return '';
        return String(value)
            .trim()
            .slice(0, MAX_PROPERTY_LENGTH)
            .replace(/[^a-zA-Z0-9_.:-]/g, '_');
    }

    function currentPage() {
        const pathname = root.location?.pathname || '/';
        return pathname.startsWith('/') ? pathname.slice(0, 120) : '/';
    }

    function safeProperties(eventName, properties) {
        const allowed = EVENT_PROPERTIES[eventName] || [];
        const output = {};
        for (const key of allowed) {
            const value = safeToken(properties?.[key]);
            if (value) output[key] = value;
        }
        return output;
    }

    function payloadFor(eventName, properties) {
        return {
            schema: 1,
            siteId,
            event: eventName,
            page: currentPage(),
            timestamp: Date.now(),
            properties: safeProperties(eventName, properties),
        };
    }

    function emitLocal(payload) {
        if (typeof root.dispatchEvent !== 'function' || typeof root.CustomEvent !== 'function') return;
        root.dispatchEvent(new root.CustomEvent('alphacity-telemetry-event', { detail: payload }));
    }

    function transmit(payload) {
        if (!endpoint || privacyOptOut || eventCount >= MAX_EVENTS_PER_PAGE) return false;
        eventCount += 1;
        const body = JSON.stringify(payload);
        if (typeof root.fetch === 'function') {
            root.fetch(endpoint, {
                method: 'POST',
                body,
                headers: { 'content-type': 'application/json' },
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                keepalive: true,
            }).catch(() => {});
            return true;
        }
        return false;
    }

    function track(eventName, properties = {}) {
        if (!Object.prototype.hasOwnProperty.call(EVENT_PROPERTIES, eventName)) return false;
        const payload = payloadFor(eventName, properties);
        emitLocal(payload);
        return transmit(payload);
    }

    function error(area, cause) {
        const code = safeToken(cause?.name || cause?.code || 'unknown_error') || 'unknown_error';
        return track('client_error', { area, code });
    }

    function handleTrackedClick(event) {
        const element = event.target?.closest?.('[data-telemetry-event]');
        if (!element) return;
        track(element.dataset.telemetryEvent, {
            action: element.dataset.telemetryAction,
            tool: element.dataset.telemetryTool,
            access: element.dataset.telemetryAccess,
        });
    }

    function start() {
        track('page_view');
        if (root.alphacityGate) {
            const gateResult = !root.alphacityGate.connected
                ? 'no_wallet'
                : (root.alphacityGate.isAllowed ? 'unlocked' : 'locked');
            track('gate_check', { result: gateResult, source: 'bootstrap' });
        }
        document.addEventListener('click', handleTrackedClick);
    }

    root.addEventListener?.('error', (event) => {
        if (event?.target && event.target !== root) {
            error('resource', { name: `load_${String(event.target.tagName || 'resource').toLowerCase()}` });
            return;
        }
        error('window', event?.error);
    }, true);
    root.addEventListener?.('unhandledrejection', (event) => error('promise', event?.reason));

    root.AlphaCityTelemetry = Object.freeze({
        enabled: Boolean(endpoint) && !privacyOptOut,
        privacy: Object.freeze({
            cookies: false,
            persistentIdentifiers: false,
            queryStrings: false,
            walletAddresses: false,
        }),
        track,
        error,
    });

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            start();
        }
    }
})(typeof window !== 'undefined' ? window : globalThis);
