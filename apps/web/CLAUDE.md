# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Scoped to `apps/web`, the public storefront and customer account area. The
root `CLAUDE.md` covers monorepo commands, shared packages and the rules
every change must follow. `CONTEXT.md` defines the business terms used here.

## Commands

Run from `apps/web`, or with `--workspace=web` from the repo root.

```bash
npm run dev                # next dev --turbopack, port 3000
npm run build
npm run lint
npm run typecheck
npm run test               # Vitest: unit + contract
npm run test:integration   # Vitest against TEST_DATABASE_URL
npm run test:e2e           # Playwright (test:smoke, test:security, test:a11y, … for subsets)
npm run test:perf          # Lighthouse budgets (builds, serves on :3100)
npm run test:load          # autocannon: a local build or the dev environment, never production
```

Tests live in `testing/`; see `docs/testing.md`.

## Access and security

- **The app is mostly public.**
  - `proxy.ts` sets a per-request nonce CSP on every page.
  - It requires sign-in only on `/account/**` and
    `/self-publishing/wizard/**` (`PROTECTED_PATHS`), with no role check.
  - `app/(account)/layout.tsx` re-checks the user. `account/publishing`
    also requires `SELF_PUB_AUTHOR`.
- **Every inline `<script>` must carry the nonce** (the root layout passes
  `x-nonce` to next-themes). Any new third-party script, iframe or API
  origin must be added to the CSP in `proxy.ts`.
- **Auth uses the storefront Supabase project.** This app never sets
  `NEXT_PUBLIC_AUTH_SUPABASE_*`, so customer accounts can't reach admin.
- **Account pages read real data only.** Nothing under `app/(account)`
  uses sample data or `withFallback`.

## Layout

**Route groups:**
- `app/(storefront)/` is public: catalogue, product and service pages,
  policy pages, the publishing landing pages.
  - `educational-material/books` is the books listing and detail.
  - The other three Educational Materials lines share `_shared/` and
    `lib/product-lines.ts`.
  - The Advocate's Diary, Naya Bandhu, Digital Tracking System, Indoor
    Plants and Bulk Publishing pages are static and not backed by
    products yet.
- `app/(account)/` holds orders, library, wishlist, addresses and
  publishing.
- `app/(checkout)/` holds `cart`, then `payment`. `checkout` only redirects
  to `cart`.
- `app/api/` holds `webhooks/razorpay` (the payment source of truth),
  `library/[assetId]` (entitlement-checked download), `books`
  (catalogue paging) and `revalidate` (admin's cache-expiry ping).

**Components are grouped by role:**
- `layout/`: the chrome. The department bar comes from
  `lib/navigation.ts`'s `buildDepartments()`, a hand-kept copy of the
  taxonomy (see root `CLAUDE.md`).
- `commerce/`: anything that sells.
- `marketing/`: repeating content blocks.
- `account/`: the signed-in area.
- `primitives/`: this storefront's presentational pieces. These are
  separate from `@repo/ui`, which holds the behavioural primitives shared
  with admin.

**Design tokens** live in `packages/config/tailwind-preset.css`, the only
set:
- Geometry follows Vistaprint's "Swan" system: 16px tile / 8px button /
  pill radii, 700-weight display type at −0.03em, a 12px/700/+0.083em caps
  style.
- Colour is sampled from `public/logo*.svg`: `#007ACC` brand, `#1D1C5E`
  ink, `#F4F7FB` page.
- The legacy semantic names (`background`, `card`, `border`, …) map onto
  that palette.

## Content and caching

- **No homepage string is hardcoded.**
  - The layout, header and footer read `SiteSettings` and `NavLink`.
  - `app/page.tsx` reads `Banner` (the first active one is the hero),
    `Testimonial`, `Faq`, `getPricingConfig()` and `getContent()`.
  - Everything else is edited from admin.
  - `getContent()` never returns a blank: it merges overrides onto the
    defaults in `content.ts`, and its keys are a typed union.
  - Components that show this copy (`Hero`, `TrustBand`, `Newsletter`,
    `PlanBand`) take it as props.
- **CMS reads** go through a `lib/cms.ts` reader, never Prisma directly.
  - Each reader is tagged `cms` plus its section.
  - Rows are returned without timestamps, because the cache round-trips
    JSON.
  - Content and pricing load with the throwing `loadContent` /
    `loadPricingConfig` inside the cache, so an error is never cached.
- **Catalogue reads** go through `lib/products-cache.ts`. That covers
  listings (`lib/books-data.ts`), detail pages, related rows, homepage rows,
  `/services` and cart covers.
  - Listings carry `catalogue:<line>`, and a single product also carries
    `product:<slug>`.
  - Products Menu `[slug]` pages use `cms:menu`.
- **Expiry.**
  - Admin expires what it saved via `api/revalidate` (bearer
    `STOREFRONT_REVALIDATE_SECRET`), and writes Redis directly when
    `CACHE_STORE=redis`.
  - Checkout expires only the product pages whose stock moved
    (`lib/stock.ts`). It re-lists a title only when its tile changes: low
    stock, sold out, or no longer same-day.
  - The 5-minute TTL is a backstop.
- **`CACHE_STORE=redis` at build time** makes `next.config.ts` swap in
  `cache-handler.mjs`, which keeps the data cache in Upstash.
  - The handler is plain JS that can't import workspace code.
  - `testing/unit/cache-handler.test.ts` keeps its key scheme in step with
    `@repo/cache/keys`.
- **Never price a charge from cached data.** Checkout and the cart call
  `getPricingConfig()` live and re-read each `Product`.
- **HTTP and browser caching.**
  - `/api/books`: 60 s shared, 240 s stale, with an ETag.
  - `public/` images: one hour.
  - TanStack Query (`components/layout/query-provider.tsx`) keeps the
    catalogue scroll pages and cart covers. Cart stock is never treated as
    fresh.
  - Covers go through `/_next/image`.
  - Each process logs `cache.stats` once a minute; `CACHE_DEBUG=1` logs
    every miss.
- **SEO.** Per-product fields (`metaTitle`, `metaDescription`,
  `ogImageUrl`) render through `generateMetadata` on the product detail
  pages. `app/sitemap.ts` and `app/robots.ts` index only the production
  deployment (`DEPLOY_ENV`/`VERCEL_ENV`).

## Cart, pricing, checkout

- **Cart** is `lib/cart-store.ts`, a Zustand store in `localStorage`
  stamped with its owner's id.
  - `components/commerce/cart-sync.tsx` saves a signed-in customer's cart
    to the `carts` table (`lib/actions/cart.ts`), so it's the same on every
    device.
  - A guest cart is merged in on sign-in.
  - The browser copy is cleared on sign-out or when another account signs
    in.
  - Saved lines are display state only; checkout re-prices everything.
- **`lib/pricing.ts`** is the pricing arithmetic: class-set tiers, the
  print + e-book bundle, per-line GST (printed books are nil-rated) and
  delivery.
  - The numbers come from `getPricingConfig()`, passed in as an argument,
    so Client Components never import Prisma.
  - A new rule gets its number in `packages/database/src/pricing.ts` (with
    a default equal to today's behaviour) and its maths here.
- **Cart page.** The billing details come first: a saved-address picker,
  address, State · District · City (`lib/india-address.ts`), PIN and an
  optional GSTIN. Then the delivery address, with a "same as billing" box
  that's unticked by default.
  - Both addresses are snapshotted onto the `Order`.
  - "Proceed to payment" stores them in `lib/checkout-store.ts`
    (sessionStorage).
- **`app/(checkout)/actions.ts`.** Both payment paths share `prepareOrder`.
  - It validates with zod: at most 50 lines, quantity 1–100, a known state.
  - It refuses unpublished, out-of-stock and wrong-format lines.
  - It re-derives every price from the database and sets
    `OrderItem.includesEbook`.
  - It re-checks the discount code (`lib/discounts.ts`) and records
    `discountCents`/`discountCode`.
  - Delivery is always standard.
- **`placeCodOrder`** (cash on delivery):
  - It's the only method when Razorpay isn't configured.
  - It creates the order as `PROCESSING` with shipment `AWAITING_APPROVAL`
    and a `COD` payment.
  - It emails from `after()`.
  - It refuses e-book and service lines, because `PROCESSING` grants an
    entitlement.
- **`startCheckout` → Razorpay Checkout → `confirmCheckout`** (UPI, net
  banking, cards):
  - `startCheckout` requires sign-in and is rate-limited.
  - `confirmCheckout` verifies the signature **and** that the Razorpay order
    id is the one stored on this order's `Payment`. It then fetches the
    payment to check the amount, currency and capture.
  - It settles through `settleOrderPayment()`, the same function the
    webhook uses. That function is idempotent: a conditional `PENDING →
    PAID` update, so the email fires once.
  - The webhook stays authoritative and also checks the amount.
- **Discount codes** never reach the browser.
  - `checkCoupon` returns only a code's terms.
  - Client Components import the maths from `@repo/database/discounts`,
    never the package root.
- **Sign-in is required** for "Buy now", the cart's "Proceed to payment",
  and `/payment` itself.

## After the order

- **Library and downloads.**
  - `entitledAssetsWhere()` / `ownsEbook()` (`lib/library.ts`) define
    entitlement. Cancelled lines and lines in an open return are excluded.
  - `api/library/[assetId]` checks entitlement and claims one download in
    `LibraryDownload` (per customer, per file), in one transaction that
    first locks the customer's orders for that e-book. `cancelOrder` and
    `requestReturn` lock the same order row before they look for a
    download, so a download can't slip past a cancellation or return.
  - It then redirects to a ~5-minute signed URL from
    `createEbookDownloadUrl()`. A legacy `https` `blobPath` is redirected
    as-is, and any other scheme is refused.
  - Downloads need `SUPABASE_SERVICE_ROLE_KEY` and the private `ebooks`
    bucket.
- **My Orders.** `account/orders/page.tsx` works out on the server what each
  order allows. It uses `@repo/database/returns` against the order, the
  customer's downloads and the admin-set return window.
  - `components/account/order-changes.tsx` holds the Cancel and Return
    forms, which replace the dialog body.
  - `cancelOrder` and `requestReturn` (`account/orders/actions.ts`) re-check
    everything against the live order. They're owner-only, rate-limited and
    zod-validated.
  - Each write is conditional on the status that was read, and downloads
    are re-checked inside the transaction.
  - Cancelling returns stock (`expireReturnedStock`). Both actions email
    from `after()`.
- **Order tracking** on My Orders uses `lib/order-tracking.ts`. There's no
  status-history table, so it rebuilds the timeline from the current
  status, `updatedAt`, the payment, and the carrier and tracking number
  staff entered.

## Sample data

`lib/sample-data/` (`books`, `services`, `cms`, `account`, `shared`,
re-exported from `index.ts`) is the fallback that `withFallback()` uses
when the database can't be reached. Import it from `@/lib/sample-data`. It
must never back account pages.
