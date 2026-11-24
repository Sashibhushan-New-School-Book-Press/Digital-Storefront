# Environments: dev and production

Two environments, completely separate: nothing in dev can read or write
production data, take real money or email real customers. Set each one up
with the wizard (Git Bash on Windows):

```bash
bash docs/setup/environments.sh dev          # do this first
bash docs/setup/environments.sh production
```

It walks every dashboard below, captures the values into git-ignored files
at the repo root, and writes ready-to-import env files per app. Re-running
it keeps the values already captured (Enter keeps the current one).

| | dev | production |
|---|---|---|
| Git branch | `dev` | `main` |
| Hosting | **Vercel**: projects `web` + `admin`, Preview deployments of `dev` | **Hostinger**: two Node.js websites built from `main` |
| Addresses | Vercel's branch URL, or `dev.<domain>` / `admin-dev.<domain>` | `www.<domain>` / `admin.<domain>` |
| Supabase (storefront: Postgres, customer auth, storage) | `storefront-dev` | `storefront-prod` (Pro plan) |
| Supabase (staff auth only) | `admin-auth-dev` | `admin-auth-prod` |
| GitHub Environment (for `db-migrate`) | `dev` | `production`, with required reviewers |
| Razorpay | Test mode keys + test webhook | Live keys (after KYC) + live webhook |
| Resend | its own API key | its own API key (one verified domain serves both) |
| Upstash Redis | its own database | its own database |

**Why dev uses Vercel *Preview*, not Vercel Production.** The apps treat a
deployment as the live site when `DEPLOY_ENV` (or, on Vercel, `VERCEL_ENV`)
is `production`: robots.txt allows indexing and the storefront refuses to
boot with Razorpay test keys. `post-deploy.yml` also expects a Vercel
"Production" deployment to be indexable. Deploying `dev` as a Preview keeps
`VERCEL_ENV=preview`, so dev is never indexed, runs on test keys, and the
post-deploy checks pass. The Vercel projects' Production environment stays
empty and their Ignored Build Step skips `main`, which Hostinger builds.

## Creating the `dev` branch (once)

Start from an up-to-date `main`. Uncommitted work comes along with
`switch -c`, so it lands on `dev`, not on production.

```bash
git switch main && git pull
git switch -c dev
git add -A && git commit -m "…"   # only if there's uncommitted work to keep
git push -u origin dev
```

Then:
- **GitHub:** keep `main` as the default branch and protect it (require the
  `security` workflow; no direct pushes). Optionally protect `dev` against
  force-pushes.
- **Vercel:** every push to `dev` now builds a Preview deployment in both
  projects. Optionally assign a stable branch domain to `dev`
  (`dev.<domain>` / `admin-dev.<domain>`) under Domains → Git branch.
- **From then on:** work and commit on `dev`. A release is
  `git switch main && git merge dev && git push`, after migrating
  production first (see "Shipping a change").

## Values per environment

`✓` = set it on that app. Secrets are marked **secret**; tick "Sensitive" on
Vercel. Anything not listed stays unset.

| Variable | web | admin | dev | production |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `_PUBLISHABLE_KEY` | ✓ | ✓ | storefront-dev | storefront-prod |
| `SUPABASE_SERVICE_ROLE_KEY` **secret** | ✓ | ✓ | storefront-dev | storefront-prod |
| `DATABASE_URL` **secret** | ✓ | ✓ | storefront-dev, `app_runtime`, pooled :6543 | storefront-prod, same shape |
| `NEXT_PUBLIC_AUTH_SUPABASE_URL` / `_PUBLISHABLE_KEY` | | ✓ | admin-auth-dev | admin-auth-prod |
| `AUTH_SUPABASE_SERVICE_ROLE_KEY` **secret** | | ✓ | admin-auth-dev | admin-auth-prod |
| `RAZORPAY_KEY_ID`, `NEXT_PUBLIC_RAZORPAY_KEY_ID` | ✓ | | `rzp_test_…` | `rzp_live_…` (unset = cash on delivery only) |
| `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` **secret** | ✓ | | test | live |
| `RESEND_API_KEY` **secret**, `EMAIL_FROM` | ✓ | ✓ | dev key | production key |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` **secret** | ✓ | ✓ | dev database | production database |
| `CACHE_STORE` / `CACHE_NAMESPACE` | ✓ | ✓ | unset (Vercel) | `redis` / `prod` |
| `DEPLOY_ENV` | ✓ | | unset (Vercel sets `VERCEL_ENV`) | `production` |
| `STOREFRONT_REVALIDATE_SECRET` **secret** | ✓ | ✓ | one value, both apps | a different value, both apps |
| `NEXT_PUBLIC_STOREFRONT_URL` | ✓ | ✓ | dev storefront URL | `https://www.<domain>` |
| `NEXT_PUBLIC_ADMIN_URL` | | ✓ | dev admin URL | `https://admin.<domain>` |
| `WHATSAPP_NUMBER` | ✓ | | optional | optional |

GitHub (repository settings):

| Secret | Where | Value |
|---|---|---|
| `DIRECT_URL` | Environment `dev` | storefront-dev, `postgres` role, port 5432 |
| `DIRECT_URL` | Environment `production` | storefront-prod, `postgres` role, port 5432 |
| `WEB_ENV_FILE` / `ADMIN_ENV_FILE` | Repository | the **dev** env files (CI's E2E job) — never production |
| `VERCEL_AUTOMATION_BYPASS_SECRET_WEB` / `_ADMIN` | Repository | each dev Vercel project's bypass token (`post-deploy.yml`) |

## Shipping a change

1. Work on `dev`, push. Vercel deploys it; `post-deploy.yml` checks it.
2. A new migration: Actions → **db-migrate** → `dev`, then test on dev.
3. Before production: Actions → **db-migrate** → branch `dev` →
   `production` (needs a reviewer's approval). Run it from `dev`, the
   branch you're about to merge: Hostinger starts building as soon as
   `main` moves, so the schema has to be there first. Migrations are never
   rolled back — keep them additive.
4. Merge `dev` into `main` and push. Hostinger rebuilds both sites.
5. Run the smoke checks against the live URLs (`docs/testing.md`,
   `E2E_WEB_URL` / `E2E_ADMIN_URL`).

Production on Hostinger has no preview and no instant rollback: roll back
by redeploying an earlier commit. See `docs/production-launch.md` for the
full launch checklist this setup is part of.
