/*
 * Alpha City merch catalog
 *
 * Launch checklist:
 * 1. Set shopUrl to the public Fourthwall shop URL.
 * 2. For each product, replace the preview name/copy as needed and set:
 *      price: "$32.00"
 *      url: "https://YOUR-SHOP.fourthwall.com/products/PRODUCT"
 *      image: "https://..." (or a local /merch/images/... path)
 * 3. Set status to "live". Cards with a URL automatically become shoppable.
 *
 * Categories recognized by the UI: apparel, accessories, home.
 */
(function (root) {
    'use strict';

    root.AlphaCityMerchCatalog = Object.freeze({
        platform: 'Fourthwall',
        status: 'preview',
        shopUrl: '',
        currency: 'USD',
        products: [
            {
                id: 'city-standard-tee',
                name: 'City Standard Tee',
                type: 'Core issue / Tee',
                category: 'apparel',
                description: 'A heavyweight daily uniform with the Alpha City mark.',
                price: '',
                url: '',
                image: '',
                mock: 'tee',
                background: '#d9e5ee',
                badge: 'Design preview',
            },
            {
                id: 'night-shift-hoodie',
                name: 'Night Shift Hoodie',
                type: 'Outer layer / Hoodie',
                category: 'apparel',
                description: 'A structured layer made for late builds and long blocks.',
                price: '',
                url: '',
                image: '',
                mock: 'hoodie',
                background: '#c7d5e5',
                badge: 'Design preview',
            },
            {
                id: 'district-field-cap',
                name: 'District Field Cap',
                type: 'Headwear / Cap',
                category: 'accessories',
                description: 'Low-profile city identification for any sector.',
                price: '',
                url: '',
                image: '',
                mock: 'hat',
                background: '#e7dfcb',
                badge: 'Design preview',
            },
            {
                id: 'builder-mug',
                name: 'Builder Mug',
                type: 'Home + desk / Ceramic',
                category: 'home',
                description: 'A desk-side essential for the people shipping the future.',
                price: '',
                url: '',
                image: '',
                mock: 'mug',
                background: '#d5d8dc',
                badge: 'Design preview',
            },
            {
                id: 'signal-tote',
                name: 'Signal Utility Tote',
                type: 'Carry / Canvas',
                category: 'accessories',
                description: 'A durable carryall for hardware, notebooks, and city runs.',
                price: '',
                url: '',
                image: '',
                mock: 'tote',
                background: '#d8c7aa',
                badge: 'Design preview',
            },
            {
                id: 'citizen-mark-pack',
                name: 'Citizen Mark Pack',
                type: 'Field marks / Stickers',
                category: 'accessories',
                description: 'City marks for laptops, cases, and off-chain surfaces.',
                price: '',
                url: '',
                image: '',
                mock: 'sticker',
                background: '#cbd9cc',
                badge: 'Design preview',
            },
        ],
    });
})(typeof window !== 'undefined' ? window : globalThis);
