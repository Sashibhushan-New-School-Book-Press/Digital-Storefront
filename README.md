# Digital Storefront: Shashibhushan's New School Book Press

An online shop and back office for the Press. It sells printed books and
e-books plus other educational, professional, digital and lifestyle
products, and offers e-book services and self-publishing.

- `apps/web` is the customer storefront: catalogue, cart, checkout, My
  Orders, My Library and the publishing pages.
- `apps/admin` is the staff back office: catalogue and website CMS, sales
  orders, purchasing and staff management.

They're two separate Next.js 16 apps in one npm workspaces + Turborepo
monorepo. They share code through `packages/*` and data through one Supabase
Postgres database, and are deployed separately. Business terms are defined
in [`CONTEXT.md`](CONTEXT.md). Guidance for contributors and agents is in
[`CLAUDE.md`](CLAUDE.md) and each app's own `CLAUDE.md`.

## Environments

| | dev | production |
|---|---|---|
| Branch | `dev` | `main` |
| Hosting | Vercel (Preview deployments) | Hostinger (two Node.js websites) |
| Supabase | `storefront-dev`, `admin-auth-dev` | `storefront-prod`, `admin-auth-prod` |
| Payments | Razorpay test mode | Razorpay live |

Work happens on `dev`. Merging `dev` into `main` is a release. Setup and
release steps are in
[`docs/setup/environments.md`](docs/setup/environments.md).

## Local setup

You need Node 22, npm and Git Bash (on Windows) for the setup wizards.

```bash
npm install
cp apps/web/.env.example apps/web/.env.local
cp apps/admin/.env.example apps/admin/.env.local
cp packages/database/.env.example packages/database/.env
npm run db:generate
```

Point the env files at the **dev** Supabase projects. The wizard
`bash docs/setup/environments.sh dev` collects every value. It writes
`.env.dev.web.local` and `.env.dev.admin.local` at the repo root, which you
can copy into the two `.env.local` files. Then:

```bash
npm run db:migrate                         # dev database only, never production
npm run seed --workspace=@repo/database    # CMS defaults + one sample service package
npm run dev                                # web → :3000, admin → :3001
```

A brand-new Supabase project also needs some one-off setup:
- Run `packages/database/prisma/sql/sync_user.sql` and `auto_enable_rls.sql`
  in the storefront project's SQL editor.
- Set up the staff auth project with `bash docs/setup/admin-auth-project.sh`.
- Run `npm run harden-buckets --workspace=@repo/storage` for the Storage
  buckets.

## What's built

**Storefront**
- Catalogue for Books (paperback / hardcover / e-book editions) and three
  more Educational Materials lines. It uses cursor paging, filters and
  sorting, and is tag-cached.
- Product pages, plus every homepage string, banner, FAQ, testimonial,
  menu and price rule read from the admin CMS.
- Sign-up and sign-in, saved addresses and wishlist. The cart is saved to
  the account.
- Checkout: cash on delivery, or Razorpay (UPI, net banking, cards) with
  server-side re-pricing, discount codes and the signature-verified
  webhook.
- My Orders, with shipment tracking, cancel order and return order.
- My Library: entitled e-book downloads with a per-customer allowance.
- Policy pages (privacy, terms, refund, shipping, contact), sitemap and
  robots.

**Back office**
- Owner-invited staff with roles (Support / Editor / Owner). There's no
  self sign-up, and the app uses a separate auth project.
- Product CMS for Books and the three simple Educational Materials lines,
  with cover upload and e-book PDF upload.
- Website CMS: site settings, navigation, banners, homepage text, FAQs,
  testimonials, pricing and delivery rules, discount codes, menu
  categories.
- Sales orders: accept or deny, ship (courier + tracking, email), deliver,
  COD collection, customer cancellations, returns, and recording manual
  refunds.
- Purchase orders and vendors: receiving adds stock.
- Every change is recorded in an audit log.

**Platform**
- Security:
  - Nonce CSP and security headers.
  - Data API locked down with RLS.
  - Rate limits.
  - Production boot checks for misconfiguration.
  - CI security scans.
- Data caching with tag invalidation (Redis on Hostinger).
- Tests: unit, contract, integration, migration, E2E, accessibility, visual
  and performance (`docs/testing.md`).

## Not built yet

**In launch scope:**
- **Self-publishing wizard.** Today it's a static step list. It needs the
  multi-step form plus the customer-upload pipeline: staging →
  `scanUpload()` (Cloudmersive) → promote. The pieces exist in
  `packages/storage`, but nothing calls them yet.
- **The remaining product lines.** Advocate's Diary, Naya Bandhu
  (Application), Digital Tracking System, Indoor Plants and Bulk Publishing
  are still `EmptyState` stubs in admin and static pages on the storefront.

**Cut from launch** (hidden or read-only at launch):
- Customer reviews and the moderation queue. `reviews` in admin is
  read-only.
- Submissions-queue actions and royalty calculation. `submissions` and
  `royalties` in admin are read-only.

**Known gaps:**
- No refund integration: staff refund from the Razorpay dashboard and
  record it.
- No job queue, by decision. Abandoned `PENDING` orders aren't expired.
- Staff 2FA was removed (deferred).

Open security items are tracked in
[`docs/security-roadmap.md`](docs/security-roadmap.md). The go-live
checklist is [`docs/production-launch.md`](docs/production-launch.md).
