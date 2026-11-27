# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Digital storefront for Shashibhushan's New School Book Press. It covers
physical and digital book sales, e-book creation services and a
self-publishing portal. The repo is an npm workspaces + Turborepo monorepo
with two Next.js 16 apps that are deployed separately:

- `apps/web` is the public storefront and customer account area.
- `apps/admin` is the staff-only back office.

They share code through `packages/*` and data through one Supabase Postgres
database, and never call each other at runtime. The one exception is
admin's cache-expiry ping to web's `/api/revalidate`.

Read these when working in an area:
- `apps/web/CLAUDE.md` and `apps/admin/CLAUDE.md`: each app's routes, flows
  and gotchas.
- `CONTEXT.md`: the glossary. Use its terms in code, copy, issues and tests.
- `docs/adr/`: decisions that are settled. Flag any change that contradicts
  one.
- `README.md`: what's built and what isn't yet.

`docs/Digital_Storefront_Technical_Design_Document_v1.1.docx` is the
original plan from July 2026. It's **historical**: many decisions have
changed since (separate admin auth project, no job queue, Supabase Storage,
Hostinger production). Where it disagrees with the code, the code and the
ADRs win.

## Workflow

There are two long-lived branches, one per environment
(`docs/setup/environments.md`):
- `dev` deploys to the dev environment (Vercel Preview).
- `main` is production (Hostinger). A push to `main` goes live.

- Work on `dev`. Don't create feature branches or git worktrees, and
  never commit to `main` directly. If `dev` doesn't exist yet, ask the
  user: they create it.
- **Every commit needs the user's go-ahead, on `dev` and `main` alike.**
  Finish the change, leave it uncommitted, and ask. One go-ahead covers
  one commit, not the ones after it.
- Merge `dev` into `main` only when the user explicitly asks for a release.
- A release that carries a migration needs production migrated **first**:
  Actions → `db-migrate`, run from `dev`, environment `production`. Keep
  migrations additive, because they're never rolled back.

## Commands

Run from the repo root. This repo uses **npm workspaces**, not pnpm/yarn.

```bash
npm install            # installs and links all workspace packages
npm run dev            # both apps (web :3000, admin :3001); dev:web / dev:admin for one
npm run build          # build:web / build:admin for one
npm run lint
npm run typecheck
npm run test           # Vitest unit + contract tests everywhere
npm run db:generate    # regenerate the Prisma client (run after any schema.prisma change)
npm run db:migrate     # prisma migrate dev (never against production)
npm run seed --workspace=@repo/database   # CMS defaults + one sample service package
```

- Run a script in one workspace with `--workspace=<name>`. The apps are
  `web` and `admin`; the packages are `@repo/database`, `@repo/auth`, and so
  on.
- Testing is covered in `docs/testing.md`. In short:
  - `test:integration` and `test:migrations` need a throwaway local Postgres
    in `TEST_DATABASE_URL` (`npm run db:test:start`).
  - `test:e2e` runs Playwright and starts the dev server. `test:smoke`,
    `test:security` and friends run subsets of it.
  - Tests live in each app's `testing/` folder, which has its own tsconfig,
    so a test can't break `next build`.
- Env files:
  - Each app needs its own `.env.local`, copied from its own
    `.env.example`. The two lists are deliberately different: only web gets
    `NEXT_PUBLIC_RAZORPAY_KEY_ID`, only admin gets the admin-auth variables.
  - The Prisma CLI reads `packages/database/.env`, copied from its
    `.env.example`.

## Architecture

**Packages.**

| Package | Holds |
|---|---|
| `database` | Prisma schema and client singleton (`src/client.ts`), plus the pure-data modules below. |
| `auth` | Supabase Auth: server helpers, browser helpers, the proxy middleware factory, roles. |
| `payments` | Razorpay orders, payment and webhook signature checks. |
| `storage` | Supabase Storage buckets for admin images and e-books; Vercel Blob staging and the malware scan for customer uploads. |
| `email` | Resend + React Email templates. |
| `cache` | `cachedQuery()`, cache tags, TTL policy, the Redis tag ledger. |
| `security` | CSP and headers, safe redirects and links, `rateLimit`, `securityEvent` logs. |
| `ui` | Behavioural primitives (Button, Sheet, DropdownMenu, Accordion, `cn()`). |
| `config` | tsconfig, ESLint flat config, the single set of Tailwind v4 tokens (`tailwind-preset.css`). |

**`packages/database` is the source of truth for the data model.**
`prisma/schema.prisma` has the business entities and the CMS tables admin
writes and web reads. Besides the client, it has small pure-data modules.
They import no Prisma, so Client Components can use them through
`@repo/database/<name>`:

| Module | Holds |
|---|---|
| `content.ts` | Every editable storefront string, with its default copy. |
| `pricing.ts` | Pricing rules and their defaults. |
| `taxonomy.ts` | Departments and product lines. |
| `book-formats.ts` | Edition line ids. |
| `shipment.ts` | Shipment steps and labels. |
| `returns.ts` | Cancel and return rules. |
| `discounts.ts` | Coupon maths. |
| `stock.ts` | `takeStock` / `returnStock`. |

`getContent()` and `getPricingConfig()` swallow database errors and fall
back to the shipped defaults on purpose: showing last-known-good copy beats
a 500.

**Catalogue shape.** The business terms are in `CONTEXT.md`.
- `Product.productLine` says *what* a product is: one of the 8 product
  lines in 5 departments. `Product.type` (`PHYSICAL_BOOK` / `EBOOK` /
  `SERVICE_PACKAGE`) only says how it's fulfilled. So filter listings by
  `productLine`, not `type`.
- A book's formats are `BookEdition` rows: one each for Paperback,
  Hardcover and E-book, each with its own price and stock.
  - `Product.priceCents` on a book is a copy of its cheapest edition.
  - `Product.stockQty` is null on a book.
  - Cart line ids are `<productId>:paperback|hardcover|ebook`
    (`book-formats.ts`).
- `taxonomy.ts` holds the canonical labels. The admin sidebar
  (`FIXED_DEPARTMENTS`), web's `buildDepartments()` and both apps'
  product-line configs still keep their own copies by hand, so change all
  of them together.

**Auth: two Supabase projects.**
- Customers sign up on the storefront project.
- Staff accounts live in a separate admin-auth project
  (`NEXT_PUBLIC_AUTH_SUPABASE_*`, resolved in `packages/auth/src/env.ts`).
  Staff can only be invited by the Owner, never sign up.
- Only admin's *auth* moves: its `DATABASE_URL` and Storage still point at
  the storefront project.
- Each project keeps `public.users` in sync with `auth.users` through a
  trigger run by hand: `prisma/sql/sync_user.sql` and `sync_staff.sql`. New
  rows start as `READER`.
- Web reads the customer with Prisma (`getCurrentUser()`). Admin reads
  staff over Supabase REST (`getCurrentStaff()`), because its Prisma client
  can't see that project.
- Sessions are checked with `getClaims()` (a local JWKS check), and both
  lookups are React-`cache()`d per request.
- `AuditLog.actorId` is a bare UUID, not a foreign key, because staff have
  no storefront `users` row. `actorEmail` is stored next to it.

**Rules every change must follow.**
- **Authorization runs twice.**
  - The proxy (`createAuthMiddleware()`) is only a UX redirect.
  - Every Server Action and Route Handler re-checks the user itself with
    `assertRole()` / `requireStaff()` and validates its input with zod.
  - Public or expensive endpoints also get a `rateLimit`.
- **Payments.** An order becomes `PAID` only through `settleOrderPayment()`
  (`apps/web/lib/orders.ts`). The two callers are the signature-verified
  Razorpay webhook and `confirmCheckout`. Never trust the client redirect.
- **No job queue.** Inngest was removed on purpose; don't bring it back.
  - Emails go out directly through `@repo/email`, inside `after()` when the
    caller shouldn't wait.
  - Sending is best-effort: log a failure, never throw, never retry.
  - Anything that needs retries or a schedule gets a cron route, decided
    when that need comes up.
- **Caching** (`docs/adr/0001-caching-strategy.md`; read it before changing
  anything cached):
  - Pages always render on request, because the nonce CSP rules out ISR
    and PPR. What's cached is the data.
  - Every cached read goes through `cachedQuery()` with tags from
    `@repo/cache/tags`.
  - Every write expires exactly what it changed, using the event builders:
    `revalidateStorefront()` in admin, `revalidateTag(tag, { expire: 0 })`
    in web.
  - Never cached: checkout pricing and stock checks, discount codes,
    per-user data, the session and the staff role.
- **Database access.**
  - Every `public` table is locked to the Supabase Data API (the
    `lock_down_data_api` migration and `prisma/sql/auto_enable_rls.sql`).
  - Never grant `anon` or `authenticated` access: both apps use Prisma.
    `npm run check:data-api --workspace=@repo/database` verifies this.
- **Secrets.**
  - Never put a secret in a `NEXT_PUBLIC_*` variable. Both apps'
    `instrumentation.ts` refuse to boot in production if one appears.
  - `server-only` guards `@repo/auth/server`, `@repo/storage`,
    `@repo/payments` and `@repo/email`. Keep them out of Client Components.
- **Links and redirects.**
  - Every CMS link or image URL is validated with
    `isSafeHref`/`isHttpsUrl` in admin and re-checked at render.
  - Post-sign-in redirects go through `safeNextPath`.
- **Uploads.**
  - Staff uploads (covers, banners, e-book PDFs) go straight to Supabase
    Storage after role and magic-byte checks.
  - Customer uploads must go staging → `scanUpload()` (Cloudmersive, fails
    closed) → promote. That pipeline isn't wired up yet.
- **Migrations are additive.** Production is migrated before `main` moves.

## Docs map

| File | What it's for |
|---|---|
| `CONTEXT.md` | Glossary of business terms |
| `docs/adr/` | Settled decisions (caching) |
| `docs/testing.md` | Every kind of test, the test database, CI workflows |
| `docs/setup/environments.md` (+ `.sh` wizard) | dev and production: hosts, projects, env vars, release steps |
| `docs/setup/admin-auth-project.sh` | Wizard for the staff auth Supabase project |
| `docs/production-launch.md` | Go-live checklist |
| `docs/security-roadmap.md` | Security status, open items, manual hardening steps |
| `docs/security-incident-response.md` | Runbook for when something goes wrong |
| `docs/books-listing-scaling.md` | How the books listing stays fast, and what's left for a large catalogue |
| `docs/agents/` | How agent skills use the issue tracker and domain docs |

Keep this set small. Update the doc that owns a fact instead of adding a
new file, and delete a plan once it's built or abandoned.

## Agent skills

- **Issue tracker:** GitHub Issues
  (`Sashibhushan-New-School-Book-Press/Digital-Storefront`), through the
  `gh` CLI. See `docs/agents/issue-tracker.md`.
- **Domain docs:** single context, with one `CONTEXT.md` plus `docs/adr/`
  at the repo root. See `docs/agents/domain.md`.
