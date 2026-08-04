(function () {
    'use strict';

    const catalog = window.AlphaCityMerchCatalog || { products: [], status: 'preview', shopUrl: '' };
    const grid = document.getElementById('product-grid');
    const count = document.getElementById('product-count');
    const filters = [...document.querySelectorAll('[data-filter]')];
    let activeFilter = 'all';
    let walletConnector = null;

    function track(eventName, properties) {
        try { window.AlphaCityTelemetry?.track(eventName, properties); } catch (_) {}
    }

    function safeText(value) {
        return String(value == null ? '' : value);
    }

    function formatIndex(index) {
        return `AC-${String(index + 1).padStart(3, '0')}`;
    }

    function filteredProducts() {
        const products = Array.isArray(catalog.products) ? catalog.products : [];
        if (activeFilter === 'all') return products;
        return products.filter((product) => product.category === activeFilter);
    }

    function buildProductCard(product, index) {
        const article = document.createElement('article');
        article.className = 'product-card';
        article.style.animationDelay = `${Math.min(index * 45, 220)}ms`;

        const visual = document.createElement('div');
        visual.className = 'product-visual';
        visual.style.setProperty('--product-bg', product.background || '#dce6ee');

        const badge = document.createElement('span');
        badge.className = 'product-badge';
        badge.textContent = safeText(product.badge || (product.url ? 'Available now' : 'Coming soon'));
        visual.append(badge);

        if (product.image) {
            const image = document.createElement('img');
            image.src = product.image;
            image.alt = safeText(product.name);
            image.loading = 'lazy';
            image.decoding = 'async';
            visual.append(image);
        } else {
            const mock = document.createElement('div');
            mock.className = `product-mock mock-${safeText(product.mock || 'tee')}`;
            mock.setAttribute('aria-hidden', 'true');
            visual.append(mock);
        }

        const itemIndex = document.createElement('span');
        itemIndex.className = 'product-index';
        itemIndex.textContent = formatIndex(index);
        visual.append(itemIndex);

        const meta = document.createElement('div');
        meta.className = 'product-meta';

        const copy = document.createElement('div');
        const type = document.createElement('p');
        type.className = 'product-type';
        type.textContent = safeText(product.type);
        const title = document.createElement('h3');
        title.textContent = safeText(product.name);
        const description = document.createElement('p');
        description.className = 'description';
        description.textContent = safeText(product.description);
        copy.append(type, title, description);

        const price = document.createElement('p');
        price.className = 'product-price';
        price.textContent = safeText(product.price || 'TBA');
        meta.append(copy, price);

        const action = document.createElement(product.url ? 'a' : 'span');
        action.className = 'product-action';
        const actionLabel = document.createElement('span');
        actionLabel.textContent = product.url ? 'View product' : 'In development';
        const arrow = document.createElement('span');
        arrow.textContent = product.url ? '↗' : '—';
        arrow.setAttribute('aria-hidden', 'true');
        action.append(actionLabel, arrow);

        if (product.url) {
            action.href = product.url;
            action.target = '_blank';
            action.rel = 'noopener noreferrer';
            action.setAttribute('aria-label', `View ${safeText(product.name)} in the Alpha City shop`);
            action.addEventListener('click', () => track('merch_product_click', {
                product_id: safeText(product.id),
                platform: safeText(catalog.platform),
            }));
        } else {
            action.setAttribute('aria-disabled', 'true');
        }

        meta.append(action);
        article.append(visual, meta);
        return article;
    }

    function renderProducts() {
        const products = filteredProducts();
        grid.replaceChildren();

        if (!products.length) {
            const empty = document.createElement('div');
            empty.className = 'empty-catalog';
            const heading = document.createElement('strong');
            heading.textContent = 'No products in this sector yet.';
            const copy = document.createElement('p');
            copy.textContent = 'Try another category or check back when the next issue is published.';
            empty.append(heading, copy);
            grid.append(empty);
        } else {
            products.forEach((product, index) => grid.append(buildProductCard(product, index)));
        }

        count.textContent = `${products.length} ${products.length === 1 ? 'item' : 'items'} / ${activeFilter === 'all' ? 'full preview' : activeFilter}`;
    }

    function setFilter(filter) {
        activeFilter = filter;
        filters.forEach((button) => {
            const selected = button.dataset.filter === filter;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
        renderProducts();
        track('merch_filter', { category: filter });
    }

    function setupShopLinks() {
        if (!catalog.shopUrl) return;
        [
            document.getElementById('shop-all-hero'),
            document.getElementById('shop-all-collection'),
        ].forEach((link) => {
            if (!link) return;
            link.href = catalog.shopUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.addEventListener('click', () => track('merch_shop_click', { placement: link.id }));
        });
        document.getElementById('shop-all-hero').textContent = 'Shop the full drop';
        document.getElementById('shop-all-collection').innerHTML = 'Shop all products <span>↗</span>';
    }

    function setupMobileMenu() {
        const button = document.getElementById('mobile-menu-button');
        const menu = document.getElementById('mobile-menu');
        const close = () => {
            button.setAttribute('aria-expanded', 'false');
            button.setAttribute('aria-label', 'Open menu');
            menu.hidden = true;
        };
        button.addEventListener('click', () => {
            const open = button.getAttribute('aria-expanded') === 'true';
            button.setAttribute('aria-expanded', String(!open));
            button.setAttribute('aria-label', open ? 'Open menu' : 'Close menu');
            menu.hidden = open;
        });
        menu.querySelectorAll('a').forEach((link) => link.addEventListener('click', close));
        window.addEventListener('resize', () => { if (window.innerWidth > 960) close(); });
    }

    function setupWallet() {
        if (!window.AlphaCityWalletConnector) {
            console.warn('[merch] The shared wallet connector did not load.');
            return;
        }
        walletConnector = window.AlphaCityWalletConnector.create({
            button: document.getElementById('connect-wallet-btn'),
            onChange(session) {
                track('merch_wallet_state', { connected: Boolean(session?.address) });
            },
        });
    }

    function initialize() {
        document.getElementById('current-year').textContent = String(new Date().getFullYear());
        filters.forEach((button) => button.addEventListener('click', () => setFilter(button.dataset.filter)));
        setupMobileMenu();
        setupShopLinks();
        setupWallet();
        renderProducts();
    }

    document.addEventListener('DOMContentLoaded', initialize);
    window.addEventListener('pagehide', () => {
        try { walletConnector?.destroy?.(); } catch (_) {}
    }, { once: true });
})();
