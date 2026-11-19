# Deploy cf-comments

English · [简体中文](deployment.zh-CN.md)

## First deploy

From the repository root, install dependencies with `pnpm install --frozen-lockfile` and sign in with `cf auth login` or configure Cloudflare API credentials. For a new instance:

1. Create a D1 database with `cf d1 create --name cf-comments`. Set its name and UUID as `d1DatabaseName` and `d1DatabaseId` in `cf-comments.config.json`.
2. Set `workerName`, `siteUrl`, `allowedOrigins`, and `commentsDomain` for your site. Configure any email or avatar options you need; see the [configuration matrix](spec.md#9-configuration-matrix-public-vs-bindings-vs-secrets).
3. Initialize the **new** database using `cf d1 migrations apply <database-uuid> --dir migrations` (in non-interactive CI/scripts, pass `CI=true ... < /dev/null`). For an existing database, check its schema first (`cf d1 migrations list <database-uuid> --dir migrations`) and apply only the required forward migrations. Do not recreate a database that already holds comments.
4. Build with `pnpm run build`. Check the output with `cf deploy --prebuilt --dry-run`, then deploy the first version using `cf deploy --prebuilt --secrets-file <private-secrets-file>`. Use the [secrets template](../.env.example) as a starting point; provide the required secrets and those for enabled providers. Keep the file outside Git.
5. Verify `/v1/config` on the Worker domain and unlock `/admin/` with the configured admin token. Ordinary widget updates are published with the Worker and do not require rebuilding the embedding site.

## GitHub Actions

Pull requests to `main` run lint, type checks, tests, and a build. Pushes to `main` also deploy after the checks pass when the repository variable `CF_DEPLOY_ENABLED` is `true`. An older queued run skips deployment if its commit is no longer the tip of `main`. The workflow uses Node 24, a frozen pnpm lockfile, and `cf@0.15.0`.

### One-time setup

1. Deploy the Worker and apply its D1 schema separately if not already done. The workflow is for an **existing Worker with one custom domain**; it refuses to create a replacement or switch databases or domains.
2. In GitHub **Settings → Environments**, create `production` and allow deployments only from the `main` branch. Store an account-scoped Cloudflare deployment API token as the environment secret `CLOUDFLARE_API_TOKEN` with minimal permissions:
   - **Account** (scoped to the target account): `Workers Scripts: Edit`, `Account Settings: Read`, `D1: Read` (no D1 Edit needed because pushes do not run migrations).
   - **Zone** (scoped to the custom domain's zone): `Zone: Read`, `Workers Routes: Edit`, `DNS: Edit` (used by Custom Domains reconciliation).
   - **Secret inheritance**: `cf@0.15.0` automatically inherits all existing declared secrets on Cloudflare (`ADMIN_TOKEN`, `TOKEN_SIGNING_SECRET`, optional `RESEND_API_KEY` / `TURNSTILE_SECRET_KEY`) when deploying without `--secrets-file`; never upload `.dev.vars.prod` or business secrets to GitHub. When enabling a brand-new secret for the first time (e.g. Turnstile), upload that secret once to Cloudflare before pushing the config change.
3. Set the following **environment variables** from the existing production configuration. Do not copy the example values into production.

| Purpose | Variables |
| --- | --- |
| Account and resource bindings | `CLOUDFLARE_ACCOUNT_ID`, `CF_WORKER_NAME`, `CF_COMMENTS_DOMAIN`, `CF_D1_DATABASE_NAME`, `CF_D1_DATABASE_ID` |
| Blog origin and comments | `CF_SITE_URL`, `CF_ALLOWED_ORIGINS`, `CF_MODERATION_MODE`, `CF_MAX_CONTENT_LENGTH`, `CF_GRAVATAR_ENABLED` |
| Optional integrations | `CF_MISSKEY_INSTANCE_URL`, `CF_TURNSTILE_SITE_KEY` |
| Email | `CF_ADMIN_EMAIL_PROVIDER`, `CF_REPLY_EMAIL_PROVIDER`; set `CF_EMAIL_FROM` for enabled providers, `CF_ADMIN_NOTIFY_EMAIL` for Email Routing, and `CF_EMAIL_HTTP_ENDPOINT` for an HTTP provider |

Use exact HTTPS origins without trailing slashes; separate multiple entries in `CF_ALLOWED_ORIGINS` with commas. Keep the blog origin in that list. Set the email providers to `none` explicitly when disabled. The workflow verifies the live D1 and custom domain bindings before building with production values.

4. After the first checks pass, set `CF_DEPLOY_ENABLED=true` as a **repository-level** Actions variable, then dispatch **Check and deploy comments** from `main`. Future pushes to `main` deploy automatically. Set the variable to `false` to pause deployment without pausing CI.

The workflow does not run D1 migrations, backfills, or data imports. Apply schema changes explicitly before publishing any code that depends on them. Keep private configuration, secrets and comment exports out of Git history.
