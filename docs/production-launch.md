# Production launch

The go-live checklist for the production environment: **Hostinger**, built
from `main`. The dev environment (Vercel Preview of `dev`) is the rehearsal
ground. Work through the phases in order.

- **[code]** marks work the code base still needs. Everything else is setup
  in a dashboard or a terminal.
- `bash docs/setup/environments.sh production` walks Phases 2–6 and
  captures every value. The layout of both environments and the env-var
  table are in [`setup/environments.md`](setup/environments.md); this file
  doesn't repeat them.

```
  customers ─► www.<domain>   Hostinger Node.js site "web"   (main, build:web)
                                   │  Prisma (pooled, app_runtime role)
                                   ▼
                         Supabase storefront-prod  — Postgres, customer auth,
                                   ▲                 Storage: images, ebooks
                                   │  Prisma (same DB)
  staff ─────► admin.<domain> Hostinger Node.js site "admin" (main, build:admin)
                                   │  auth only
                                   ▼
                         Supabase admin-auth-prod  — staff identities only
```

---

## Phase 0: Is the code ready?

**Features in launch scope [code]**
- [ ] **Self-publishing wizard**: the multi-step form, plus customer upload →
      `scanUpload()` → promote (pieces in `packages/storage`). Staff also
      need a way to see and move new submissions. The `submissions` page is
      read-only today.
- [ ] **Remaining product lines**: Advocate's Diary, Naya Bandhu
      (Application), Digital Tracking System, Indoor Plants and Bulk
      Publishing. Each needs an admin CMS and a storefront listing that
      reads `Product`.

**Cut from launch.** Hide these, or keep them read-only:
- [ ] Customer reviews: hide review entry and display, or confirm nothing
      shows unmoderated reviews.
- [ ] Royalty calculation: the `royalties` page stays a read-only view.

**Pages the law and Razorpay require.** These are built: privacy, terms,
refund, shipping and contact, all linked from the footer. Before launch:
- [ ] Fill in admin → *Homepage text* → "Policies and contact page": the
      registered business name, GSTIN, Grievance Officer name + email, and
      the courts with jurisdiction.
- [ ] Check that Site Settings' contact email, phone and address are the
      real ones.
- [ ] Have a lawyer or CA review all five pages against how the business
      actually runs: return window, dispatch time, manual refunds.

**Quality gate**
- [ ] `npm run typecheck`, `lint`, `test` and `build` pass from a clean
      clone.
- [ ] `ci.yml` and `security.yml` are green on `dev`.

---

## Phase 1: Accounts and plans

Create these under a **business** email you'll keep, with 2FA on every one.

| Service | Production plan | Why not free |
|---|---|---|
| **Hostinger** | Business or Cloud web hosting | Single and Premium can't run Node.js. |
| **Supabase** × 2 | Pro for `storefront-prod`; `admin-auth-prod` can stay Free | Free projects pause after a week idle and have no daily backups. |
| **Razorpay** | Standard (KYC) | Live keys need business KYC and a website review (2–7 working days). |
| **Resend** | Free to start | The domain must be verified. |
| **Upstash Redis** | Free / pay-as-you-go | It holds the rate limits and the storefront's data cache. |
| **Cloudmersive** | Needed, since self-publishing uploads launch | Without the key, uploads stay `PENDING` (fails closed). |
| **Vercel** | Hobby or Pro | Hosts **dev only**. Hobby is limited to non-commercial use, so check that it still fits. |

Use one region: Supabase **ap-south-1 (Mumbai)**, Upstash **Mumbai**, and
Hostinger's India data centre if hPanel offers a choice.

---

## Phase 2: Production database (`storefront-prod`)

1. Create the project in Mumbai, and save the DB password in a password
   manager.
2. Add the `postgres`-role `DIRECT_URL` (port 5432) as a secret on the
   GitHub Environment `production`, which has required reviewers.
3. **Apply migrations** with Actions → `db-migrate`, branch `dev`,
   environment `production`. Never run `db:migrate` (`migrate dev`) against
   production: it can reset data.
4. In the SQL editor, run these in order:
   1. `prisma/sql/sync_user.sql`: the `auth.users` → `public.users`
      trigger.
   2. `prisma/sql/auto_enable_rls.sql`: RLS on any future table.
   3. `prisma/sql/app_runtime_role.sql`: the least-privilege `app_runtime`
      login. Build both apps' runtime `DATABASE_URL` from it (pooled port
      6543, `?pgbouncer=true`).
5. Seed the CMS defaults: `npm run seed --workspace=@repo/database`, with
   `packages/database/.env` pointed at prod. Check the project ref first.
6. `npm run check:data-api --workspace=@repo/database`: every table must
   report `blocked`. Optionally, remove `public` from Settings → API →
   Exposed schemas.
7. Storage: create `images` (public) and `ebooks` (private), then run
   `npm run harden-buckets --workspace=@repo/storage`.
8. Backups: confirm daily backups are on. Consider PITR once orders flow.

## Phase 3: Staff auth project (`admin-auth-prod`)

Run `bash docs/setup/admin-auth-project.sh` against the new project. It runs
`sync_staff.sql` and creates the Owner. Then, under Authentication:

- [ ] "Allow new users to sign up" **off**. This also blocks OAuth
      sign-ups.
- [ ] Google provider: configure it for this project, or disable it.
- [ ] Minimum password length 12, leaked-password protection on.
- [ ] Secure email change and secure password change on.
- [ ] JWT expiry shortened (for example 900 s).
- [ ] Site URL `https://admin.<domain>`, and Redirect URLs exactly
      `https://admin.<domain>/**`.

Staff 2FA is deferred (an accepted risk), so make sure the Owner uses a
long unique password.

## Phase 4: Customer auth (`storefront-prod` → Authentication)

- [ ] **Custom SMTP (mandatory).** Supabase's built-in mailer only reaches
      your team. Use Resend SMTP (`smtp.resend.com:465`, user `resend`,
      password = a Resend API key) with a From address on your domain.
- [ ] Customise the confirm, reset and magic-link templates with the Press's
      name.
- [ ] Email confirmation on, minimum password length 8, leaked-password
      protection on.
- [ ] Site URL `https://www.<domain>`, and Redirect URLs exactly
      `https://www.<domain>/**`.
- [ ] Review the Auth rate limits. Give any OAuth provider a production
      client.

## Phase 5: Third-party services

- **Resend:**
  - Verify `<domain>` by adding its SPF and DKIM records (plus MX for
    bounces) in hPanel → DNS.
  - Add DMARC (`p=none` to start).
  - Create the production key and set `EMAIL_FROM`.
- **Razorpay:**
  - Complete KYC; it needs the Phase 0 policy pages live.
  - Generate **live** keys.
  - Add a webhook at `https://www.<domain>/api/webhooks/razorpay` for event
    `payment.captured`, with a strong secret. The app won't boot in
    production without it.
  - Confirm auto-capture is on.
  - Keep the separate test-mode webhook pointing at dev.
  - Until the live keys arrive, leave all `RAZORPAY_*` unset, so only cash
    on delivery is offered. Production refuses to boot with test keys.
- **Upstash:** a production database in Mumbai. Set `CACHE_STORE=redis` and
  `CACHE_NAMESPACE=prod` on both sites (`docs/adr/0001-caching-strategy.md`).
- **Cloudmersive:** `CLOUDMERSIVE_API_KEY` on web.
- **Shared secret:** `STOREFRONT_REVALIDATE_SECRET`, a different value from
  dev's, on both apps.

## Phase 6: Hostinger sites

The setup is still unproven on a real deploy: the npm-workspaces install,
the standalone start from a monorepo, the `admin.` subdomain and the data
centre. **Do a trial deploy of `web` on a throwaway subdomain first.**

Before you start:
- Delete any starter website hPanel created on the domain.
- Install the Hostinger GitHub App on the repo.

Create two Node.js websites (hPanel → Websites → Add website → Node.js app →
import from GitHub):

| Setting | web | admin |
|---|---|---|
| Domain | `www.<domain>` | `admin.<domain>` |
| Framework / Node | Next.js / 22 | Next.js / 22 |
| Branch | `main` | `main` |
| Root directory | `/` (repo root) | `/` (repo root) |
| Package manager | npm | npm |
| Build script | `build:web` | `build:admin` |
| Output directory | `apps/web/.next` | `apps/admin/.next` |

- **Why the repo root.** The root directory must be the repo root, because
  the apps import `packages/*` through workspaces. Both `next.config.ts`
  files set `output: "standalone"` with tracing from the root, so Prisma
  and `sharp` are copied into the build.
- **Environment variables.**
  - Use "Import .env" with the wizard's `.env.production.web.local` /
    `.env.production.admin.local`.
  - Set everything **before the first build**, because `NEXT_PUBLIC_*` and
    robots.txt are fixed at build time.
  - Web needs `DEPLOY_ENV=production`.
- **To reproduce Hostinger's run locally:**
  ```bash
  npm run build:web
  cp -r apps/web/public apps/web/.next/standalone/apps/web/public
  cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
  PORT=3200 node --env-file=apps/web/.env.local apps/web/.next/standalone/apps/web/server.js
  ```
- **DNS** goes in hPanel → Domains → DNS.
  - Make `www` canonical and redirect the bare domain to it. Hostinger runs
    them as separate processes, which count against the plan.
  - Check that SSL is active on `www.` and `admin.`. Once HTTPS works, the
    apps' HSTS header takes effect, so never point these hosts back at
    plain HTTP.
- **Final pass.** Re-check every URL (Supabase Site/Redirect URLs, the
  Razorpay webhook, `NEXT_PUBLIC_*_URL`) against the final hostnames, then
  redeploy both sites.

**Platform limits that matter**
- An idle site is stopped and cold-starts on the next request. Razorpay
  retries failed webhooks, so no payment is lost.
- Requests stop after 120 s. There are no background workers; the app has
  none, and Hostinger cron is there if one is ever needed.
- CPU, RAM and the process count are shared across the plan.
- There are no previews and no instant rollback. Roll back by redeploying
  an earlier commit; migrations are never rolled back.
- Hostinger reports no deployments to GitHub, so `post-deploy.yml` doesn't
  run for production. Run the checks by hand (Phase 7).

---

## Phase 7: Rehearse on dev, then check production

Run the full list on **dev** (Razorpay test mode) first, then the short list
on production.

**Storefront**
- [ ] Sign up → the confirmation email arrives from your domain → sign in →
      password reset works.
- [ ] Add paperback, hardcover and e-book lines, apply a discount code, and
      pay with Razorpay. The order shows **Paid**, and the webhook delivery
      log shows 200.
- [ ] The e-book appears in My Library, downloads, and the link expires.
- [ ] A COD order is created unpaid and shows on Sales Orders as awaiting
      approval.
- [ ] Cancel an order, and return a delivered one, from My Orders.
- [ ] The self-publishing wizard accepts a manuscript, and the scan marks
      it `CLEAN`.

**Admin**
- [ ] The Owner signs in at `admin.<domain>`; a random account can't.
- [ ] Invite a staff member → the email arrives → `/join/<token>` works →
      promote them.
- [ ] Create a book with a cover and an e-book PDF, then publish it. It
      appears on the storefront within seconds.
- [ ] Edit site settings or homepage text, and the storefront updates.
- [ ] Take an order through Accept → Shipping (tracking email) → Delivered.

**Security and quality**
- [ ] `check:data-api` → all `blocked`.
- [ ] securityheaders.com on both hosts shows CSP, HSTS, frame and referrer
      headers. There are no CSP violations in the console.
- [ ] Run the smoke, sanity and security suites against the live URLs
      (`E2E_WEB_URL` / `E2E_ADMIN_URL`, see `docs/testing.md`).
- [ ] Lighthouse on home, catalogue, a book page and the cart (mobile).

**Go-live day on production**
- [ ] One real low-value purchase → paid → e-book delivered → refund it
      from the Razorpay dashboard and record the refund in admin.
- [ ] Sign up with a real address, and sign in to admin.

## Phase 8: Go live

1. Migrate production first (Actions → `db-migrate` → `dev` →
   `production`).
2. Merge `dev` into `main` and push. Hostinger builds both sites. Tag the
   release (`git tag v1.0.0 && git push --tags`).
3. Run the go-live checks above.
4. Submit `https://www.<domain>/sitemap.xml` in Google Search Console and
   Bing Webmaster Tools (verify ownership with a DNS TXT record).

## Phase 9: After launch

- [ ] Error tracking (Sentry or a log drain) **[code]**, keeping security
      logs for 180 days (CERT-In).
- [ ] Uptime checks on `www.` and `admin.`, alerting to phone or email.
- [ ] Razorpay webhook-failure alerts; Supabase usage alerts.
- [ ] GitHub:
  - protect `main` (require the `security` workflow);
  - turn on secret scanning, push protection and Dependabot security
    updates.
- [ ] Open security items: [`security-roadmap.md`](security-roadmap.md).
      Incident handling:
      [`security-incident-response.md`](security-incident-response.md).
