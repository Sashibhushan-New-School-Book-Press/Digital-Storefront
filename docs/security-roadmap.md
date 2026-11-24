# Security status

This file tracks where security stands: what's in place, what's still
open, and the dashboard steps each environment needs.
- The rules every change must follow are in the root `CLAUDE.md`
  ("Rules every change must follow").
- The runbook for when something goes wrong is
  [security-incident-response.md](security-incident-response.md).
- The full audit from 2026-09-27, with its write-up of every finding, is
  in git history: `git show d282696:docs/security-roadmap.md`.

## Finding index

Code comments and migrations cite these ids. All of them are fixed unless
marked otherwise.

| Id | Finding | Id | Finding |
|---|---|---|---|
| C1 | Business tables readable and writable through the Supabase Data API | M5 | Raw provider error text shown to users |
| C2 | One payment's signature could mark other orders paid (replay) | M6 | E-book upload accepted any bytes |
| C3 | Unpublished or out-of-stock items purchasable; unchecked quantities | M7 | Malware scan was a stub |
| H1 | Open redirect after sign-in | M8 | Admin proxy matcher prefix bypass; no page guards |
| H2 | Admin auth fell back to the public storefront project | M9 | Inngest endpoint signing (n/a, Inngest removed) |
| H3 | Print purchase unlocked the e-book; download limit shared by all buyers | M10 | Secrets in apps that don't need them (per-app keys still open) |
| H4 | No security headers or CSP | M11 | Errors swallowed silently (Sentry still open) |
| H5 | Weak staff passwords, no MFA (MFA deferred, accepted risk) | M12 | Vulnerable dependencies (**open**) |
| M1 | Webhook signature compare could throw | L1–L7 | Email wildcard match, invite race, token in referrer, email subject injection, audit diff hygiene, `noopener`, `server-only` guards |
| M2 | No rate limiting | Phase 2.2 | Least-privilege `app_runtime` DB role |
| M3 | CMS links accepted `javascript:` | Phase 2.3 | CI security pipeline |
| M4 | Invite link built from the Host header | | |

## In place

| Area | What | Where |
|---|---|---|
| Data API | RLS on every table, `anon`/`authenticated` privileges revoked, locked default privileges, auto-RLS trigger, `check:data-api` script | migration `lock_down_data_api`, `prisma/sql/auto_enable_rls.sql` |
| Payments | Gateway order bound to our order, Razorpay payment fetched to check amount/currency/capture, `gatewayPaymentId @unique`, one idempotent `settleOrderPayment()` shared with the webhook | `apps/web/app/(checkout)/actions.ts`, `apps/web/lib/orders.ts` |
| Checkout input | zod, published/stock/format checks, amount bounds, coupons checked on the server only | same |
| Webhook | Length-safe HMAC, fails closed without a secret, size cap, amount cross-check | `packages/payments` |
| Redirects and links | `safeNextPath` on sign-in and in the proxy; `isSafeHref`/`isHttpsUrl` on every CMS link (admin schemas + render) | `packages/security` |
| Admin auth | Separate project; proxy 503 and boot refusal if it's missing; no cross-project key fallback; 12-character staff passwords; atomic single-use invites with `no-referrer` | `packages/auth/src/env.ts`, `apps/admin` |
| E-books | Entitlement only through `includesEbook`; per-customer `LibraryDownload` with an atomic claim; cancelled, returned and refunded lines lose access; private bucket with 5-minute signed URLs; `%PDF-` + path check on upload | `apps/web/lib/library.ts`, `packages/storage` |
| Headers | Enforced nonce CSP, HSTS (production), frame/referrer/permissions/COOP, `noindex` + `no-store` on admin and account pages | `packages/security/src/headers.ts`, both `proxy.ts` |
| Rate limits | Checkout, coupons, account writes, library, books API, webhook, invites, uploads, password check | `packages/security/src/rate-limit.ts` |
| Uploads | Images: role, 4 MB cap, magic bytes, no SVG. Customer files: real Cloudmersive scan that fails closed, private staging, quarantine | `apps/admin/app/api/uploads`, `packages/storage/src/scan.ts` |
| Admin pages | Anchored public paths; `requireStaffPage()` on every data-reading page | `apps/admin/proxy.ts`, `lib/guard.ts` |
| Secrets | Boot check rejects secrets in `NEXT_PUBLIC_*`; per-app env lists trimmed; `server-only` guards | both `instrumentation.ts` |
| Errors | Generic messages to users; `withFallback` logs | both apps |
| CI | typecheck, lint, Vitest, npm audit, gitleaks, CodeQL, Dependabot, ZAP baseline on dev deploys | `.github/workflows` |

## Open

- **Accepted risk: no staff 2FA.** It was built, then removed by decision,
  and is deferred.
- **Error tracking and log retention:** Sentry or a log drain, keeping
  logs 180 days (CERT-In).
- **DPDP self-service:** customer account deletion and data export.
- **Retention jobs:** purge abandoned `PENDING` orders and expired
  `staff_invites`. There's no job queue, so this needs a cron route.
- **Dependencies:** upgrade to Prisma 8 and `@react-email/components` 1.x.
  CI reports these without blocking.
- **Per-app Supabase secret keys** (`sb_secret_…`), replacing the shared
  `service_role` JWT.
- **Before launch:** a ZAP scan against dev, then a third-party penetration
  test focused on checkout, the library, admin and self-publishing uploads.
  Repeat it yearly.
- **Self-publishing uploads must not ship without** the staging → scan →
  promote path wired end to end.

## Dashboard steps per environment

Do these once for dev and once for production.
`docs/setup/environments.sh` and `docs/production-launch.md` walk them.

1. **Database:**
   - Apply migrations (Actions → `db-migrate`).
   - Run `auto_enable_rls.sql` and `app_runtime_role.sql`.
   - `check:data-api` must report every table `blocked`.
2. **Storage:** run `npm run harden-buckets --workspace=@repo/storage`.
3. **Admin-auth project:**
   - Sign-ups off (this covers OAuth too).
   - Minimum password length 12 and leaked-password protection.
   - Secure email and password change.
   - Exact Redirect URLs.
   - JWT expiry around 900 s.
4. **Storefront project:**
   - Custom SMTP.
   - Email confirmation.
   - Minimum password length 8 and leaked-password protection.
   - Exact Redirect URLs.
   - Review the rate limits.
5. **Hosting:**
   - `NEXT_PUBLIC_ADMIN_URL` and Upstash on both apps.
   - Secrets marked Sensitive (Vercel).
   - Deployment Protection on the dev Vercel projects.
   - Test Razorpay keys on dev only.
6. **GitHub:**
   - Secret scanning, push protection and Dependabot security updates.
   - Protect `main` so the `security` workflow must pass.

## Ongoing

- The Owner reviews the staff list monthly.
- Rotate keys quarterly, and immediately when someone with access leaves.
  The rotation table is in the incident runbook.
- When a table, action, endpoint or env var is added, check it against the
  root `CLAUDE.md` rules.
