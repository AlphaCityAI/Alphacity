# Alpha City merchandise integration

The storefront at `/merch/` is launch-ready in preview mode. It uses Alpha City's shared wallet session, visual language, and telemetry while keeping merchandise checkout separate from on-chain actions.

## Selected platform: Fourthwall

Fourthwall is the recommended fulfillment partner because:

- Physical merchandise has no upfront cost, monthly subscription, or contract.
- Catalog product cost is deducted after a sale; Alpha City controls the retail price and keeps the remaining margin.
- Fourthwall handles production, checkout, applicable sales tax, shipping, and customer support.
- Direct product links work immediately, and the free Storefront API is available if Alpha City later wants a fully dynamic catalog and cart.
- The service works with manufacturing and fulfillment partners across multiple regions.

Official references:

- [Fourthwall print-on-demand pricing and fulfillment](https://fourthwall.com/print-on-demand)
- [Embedding Fourthwall on an external website](https://help.fourthwall.com/manage-my-shop/shop-settings/embedding-your-store-on-an-external-website/)

## Publish products

1. Create the Alpha City shop in Fourthwall and complete payout/tax onboarding.
2. Design each product, order samples, confirm sizing/print quality, and publish it.
3. Open `/merch/catalog.js`.
4. Set `shopUrl` to the public Fourthwall shop URL.
5. For each product, set `price`, `url`, and `image`. A product becomes clickable as soon as `url` is present.
6. Change `status` from `preview` to `live`.
7. Confirm every product link, price, return policy, and shipping estimate before deployment.

Product URLs are intentionally configured in one file so the page layout does not need to be edited when the catalog is ready.

## Optional live catalog upgrade

Fourthwall's Storefront API can later replace the static catalog while preserving this frontend. It exposes published collections and products and hands checkout back to Fourthwall. A Storefront Token is required; never commit private account credentials. See Fourthwall's [Storefront API guide](https://docs.fourthwall.com/storefront/overview).
