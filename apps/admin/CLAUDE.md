# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Scoped to `apps/admin`, the staff-only back office. The root `CLAUDE.md`
covers monorepo commands, shared packages and the rules every change must
follow. `CONTEXT.md` defines the business terms used here.

## Product principles

Two constraints shape every decision in this app. Both outrank "what's
fastest to build":

1. **The audience is the Owner plus a few trusted staff the Owner invites.**
   Never the public, never self-service.
   - Support handles orders and customers.
   - Editor adds products and edits the website.
   - Only the Owner manages staff and royalty rates.
2. **Every screen must work for someone with no technical background.**
   - No jargon, raw ids or enum values in copy.
   - No form that assumes the operator knows what a slug or a webhook is.
   - Pick the product type first and show only the fields that apply.
   - Generate the web address from the title.
   - Use a file picker with a preview, not a URL field.

Design new features against both before you build them.

## Commands

Run from `apps/admin`, or with `--workspace=admin` from the repo root.

```bash
npm run dev                # next dev --turbopack, port 3001
npm run build
npm run lint
npm run typecheck
npm run test               # Vitest: unit + contract
npm run test:integration   # Vitest against TEST_DATABASE_URL
npm run test:e2e           # Playwright (test:smoke, test:security, test:a11y, … for subsets)
```

Tests live in `testing/`; see `docs/testing.md`.

## Access and auth

- **The whole app is gated.**
  - `proxy.ts` locks every route, API routes included, to `ADMIN_ROLES`.
  - Only the anchored `PUBLIC_PATHS` skip auth: `/sign-in`,
    `/forgot-password`, `/reset-password`, `/unauthorized` and `/join/*`.
    The match is on exact segments, so `/joinx` is not public.
  - Every response gets the nonce CSP and the security headers.
- **Three checks, each required.**
  1. The proxy, which only redirects.
  2. `await requireStaffPage()` (`lib/guard.ts`) at the top of every page
     that reads data.
  3. `getCurrentStaff()` + `assertRole()` (or `requireStaff()`) at the top
     of every Server Action and Route Handler.

  A page or action that skips its own check is a bug.
- **Owner-only is enforced in the actions, not the routes.** For example,
  `settings/roles` is reachable by any staff role, and its actions call
  `assertRole(role, OWNER_ONLY_ROLES)`. Don't assume a page is restricted
  until you've seen that check.
- **Staff identities live in the admin-auth Supabase project.**
  - Read staff with `getCurrentStaff()` over Supabase REST, never
    `getCurrentUser()`.
  - Prisma still talks to the shared storefront database.
  - Setup: `docs/setup/admin-auth-project.sh` and
    `packages/database/prisma/sql/sync_staff.sql`.
- **Sign-in is email + password (or Google), with no second factor.** Staff
  2FA was removed on purpose and is deferred, so don't re-add it unasked.
  - The password minimum is `STAFF_PASSWORD_MIN` (12) in `lib/passwords.ts`.
  - Changing a password re-checks the current one on the server.
- **Production refuses to boot misconfigured.**
  - `instrumentation.ts` requires the admin-auth project, its service-role
    key and `NEXT_PUBLIC_ADMIN_URL`, and rejects secrets in `NEXT_PUBLIC_*`.
  - The proxy returns 503 without the auth project, so admin can never
    fall back to the storefront's.

**Staff management** (`app/settings/roles`) has every action
`OWNER_ONLY_ROLES` and `AuditLog`ged:
- **Add new Staff** (`inviteStaff`):
  - Creates a `StaffInvite`: a SHA-256 of a random token, valid one hour.
  - Emails the `/join/<token>` link with `sendStaffInvite()` (Resend).
    Supabase's own invite mail isn't used.
- **`/join/[token]`** is the only sign-up form; there is no `/sign-up`.
  `acceptStaffInvite` works like this:
  - It's rate-limited.
  - It claims the invite with a conditional update before calling
    `createStaffAuthUser()`, and releases the claim if that fails.
  - It's served with `Referrer-Policy: no-referrer`.
  - New accounts start as `READER`.
- **Role change** (`changeStaffRole` → `setStaffRole()`) and **Remove**
  (`removeStaff`) both refuse to leave zero Owners.
- **Cancel / Resend** a pending invite. Resend issues a fresh token.
- The flow needs `AUTH_SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`,
  `EMAIL_FROM` and `NEXT_PUBLIC_ADMIN_URL`.

## Route map (`app/`)

| Route | What |
|---|---|
| `/` | Dashboard: "needs attention" counts link to filtered Sales Orders |
| `educational-material/books` (+ `[id]`) | Books CMS, the full form: editions, genre, e-book PDF, SEO |
| `educational-material/{educational-charts,worksheets-activity-puzzles,teaching-learning-materials}` | The three simple lines, sharing `educational-material/_shared/` |
| `professional-materials/advocate-diary`, `lifestyle`, `publishing/{self-publishing,bulk-publishing}` | `EmptyState` stubs, still to build |
| `supply/sales-orders` | Order approval, shipping, COD, cancellations, returns, refunds (`orders` redirects here) |
| `supply/purchase-orders`, `supply/vendors` | Procurement; receiving adds stock |
| `submissions`, `royalties`, `reviews`, `analytics` | Read-only views with no actions yet |
| `settings/site`, `settings/navigation`, `settings/pricing` | Branding/SEO/contact, header/footer links, delivery/bundle/GST/class-set rules |
| `content/banners`, `content/homepage`, `content/faqs`, `content/testimonials` | Storefront homepage content |
| `discounts` | Coupon codes ("Discount" under Users and Staffs) |
| `settings/roles`, `join/[token]` | Staff management, invite redemption |
| `api/uploads`, `api/uploads/ebook` | Image upload, signed e-book upload URL |

## Catalogue CMS

- **Books** (`educational-material/books`).
  - The list query is `type IN (PHYSICAL_BOOK, EBOOK)` plus
    `productLine: "BOOK"`, so the other lines' `PHYSICAL_BOOK` rows stay out.
  - `product-form.tsx` is a Client Component so it can show only the fields
    that apply.
  - Editions: the form ticks formats and asks for a price per format (plus
    stock for the printed ones).
    - `createProduct`/`updateProduct` write one `BookEdition` per ticked
      format. Update drops unticked ones and upserts the rest, so an
      edition's id stays stable.
    - They also keep `Product.priceCents` equal to the cheapest edition.
- **The three simple lines** share `_shared/`, which holds the list, form,
  schema and actions.
  - Each route passes its `ProductLineConfig` from
    `_shared/product-line-config.ts`.
  - The actions take the route slug as a bound first argument, which
    resolves the `ProductLine` they write.
  - Rows are `PHYSICAL_BOOK` with no editions, priced and stocked on the
    `Product` itself.
- **Adding one of the stub lines** means another route folder plus a config
  entry like the simple lines, or its own form if it's as complex as Books.
  The line's label lives in `taxonomy.ts`, `FIXED_DEPARTMENTS`
  (`components/sidebar-nav.tsx`), the config file and web's nav. Keep them
  in step.
- **E-book PDFs** (`components/pdf-field.tsx` + `api/uploads/ebook`):
  - The field appears only when "E-book" is ticked, and is then required.
  - The browser `PUT`s the file to a signed URL in the private `ebooks`
    bucket, so there's no request-size limit.
  - Before attaching a new file, the actions check the path was minted by
    `createEbookUploadUrl` and the stored bytes start with `%PDF-`
    (`isStoredEbookPdf`).
  - `syncEbookFileAsset()` keeps one `FileAsset` per product (`EBOOK_FILE`,
    `CLEAN`, `maxDownloads 5`), and deletes the old object when the file is
    replaced or the format is turned off.
- **Images** (`api/uploads`):
  - The route checks the role, caps size at 4 MB and checks magic bytes.
    SVG is refused, because it can carry script.
  - `uploadImage()` writes to the public `images` bucket.
  - `isImageUploadConfigured()` falls back to "paste a URL" when Storage
    isn't set up.
  - Staff uploads skip the malware scan on purpose; that pipeline is for
    customer files.
- **Buckets.** Run `npm run harden-buckets --workspace=@repo/storage` once
  per environment to set each bucket's MIME types and size limit.

## Storefront CMS

- **Every CMS and catalogue action does the same five things.** It
  validates with zod, calls `assertRole()`, writes an `AuditLog`, calls
  `revalidatePath()` for its own page, and calls
  **`revalidateStorefront(tags, productIds)`** (`lib/storefront-cache.ts`).
  - The roles are `CATALOGUE_WRITE_ROLES` for catalogue and pricing, and
    `CONTENT_WRITE_ROLES` for the rest.
  - CMS sections pass `cmsChangedTags("<section>")`.
  - Product saves pass `productChangedTags(before, after)` plus the id.
  - Receiving stock and denying an order pass `stockReturnedTags`.
- **What `revalidateStorefront()` does.** It can never fail a save.
  1. Expires the tags in this app's cache.
  2. With `CACHE_STORE=redis`, writes them into the storefront's Redis tag
     ledger.
  3. POSTs them to the storefront's `/api/revalidate` from `after()`, using
     `STOREFRONT_REVALIDATE_SECRET`. The payload is pinned by
     `testing/contracts/storefront-revalidate.contract.json`.
- **Discount saves don't revalidate**, because codes are never cached.
- **This app's own cache** is `lib/admin-cache.ts`, on Next's built-in
  cache.
  - It holds the chrome's site name and menu, plus the dashboard and
    Analytics aggregates (`admin:order-stats`, one minute).
  - The session, the order queues and the "needs attention" counts are
    never cached.
- **Homepage text** renders from `CONTENT_GROUPS` in `content.ts`.
  - The save deletes any row equal to the default, so clearing a box
    restores the default.
  - A new editable string is a one-line registry change, with no migration.
- **The shared form kit:**
  - `components/ui.tsx`: page furniture, labelled fields, tables, empty
    states.
  - `components/form-controls.tsx`: pending-state submit buttons,
    confirm-before-delete.
  - `components/image-field.tsx` and `components/sidebar-nav.tsx`.
  - Rules: plain-English labels with help text, long forms split into
    titled sections, colours only from the tokens in `tailwind-preset.css`.

## Sales orders (`supply/sales-orders`)

The page lists every placed order: paid online, or COD. Unpaid checkouts
aren't shown. Each order shows its delivery type: Online, Offline or both.

- **Moving the parcel.** `moveSalesOrder` (`ORDER_WRITE_ROLES`, so Support
  can use it) goes Accept → Processing → Shipping → Out for delivery →
  Delivered, or Deny → Cancelled.
  - Each move is a conditional update on the status the operator saw, so a
    double click can't skip a step.
  - Shipping requires the courier and tracking number (`Order.carrier`,
    `trackingNumber`). It then emails the customer with `sendOrderShipped`,
    best-effort.
  - Delivered stamps `Order.deliveredAt`, which starts the return window.
- **Deny** returns the printed copies to stock. It cancels the whole order
  only if nothing was delivered online, so a mixed order keeps its e-book.
  Lines the customer already cancelled are left alone. Step order and
  labels: `@repo/database/shipment`.
- **COD.** "Mark cash collected" (`markCashCollected`, rule in `cod.ts`)
  sets the Payment to CAPTURED, once, after the parcel has gone out. Nothing
  here marks an online order paid.
- **Customer cancellations** arrive already done. They show as "Cancelled
  by customer", with stock already returned.
- **Returns.** A request shows in Current Status and under the "Return
  requests" filter. Staff decide it in the order pop-up with `decideReturn`
  (`return-actions.ts`):
  - Approve, with an optional message (for example pickup arrangements).
  - Mark as received, which returns the stock.
  - Or Reject, with a message the customer sees.

  A return of only an undownloaded e-book completes on approval. Every move
  is conditional, `AuditLog`ged and emailed to the customer.
- **Refunds.** "Refunds to send" sums what's owed.
  - Staff refund by hand and record it with `markRefundSent`.
  - A wholly cancelled order that's fully refunded becomes REFUNDED, along
    with its payment.
  - Filters: `?filter=approval|returns|refunds` (`filters.ts`).
