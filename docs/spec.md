# cf-comments v1 Frozen Specification

## 1. Scope & Architecture

- **Single-instance deployment**: One Worker + one D1 database serves one site (no multi-tenancy in v1).
- **Standalone repository**: Lives in `workers/comments/` as an independent Git repository with its own `package.json`, lockfile, `tsconfig.json`, `biome.json`, `cloudflare.config.ts`, migrations, and tests.
- **Configuration source**: `cloudflare.config.ts` (for Cloudflare `cf` CLI `v0.15.0+`). Local verification uses `--local`; staging uses a dedicated D1 database before production deployment to `comments.chiyo.uk` via Worker Custom Domain.
- **Explicit non-goals in v1**: No `pageview` counter; no ActivityPub; no image upload or image proxy.

---

## 2. Path Normalization & Aliases

- Thread key is an explicit site-relative `path` (e.g. `/about/`, `/friends/`, `/posts/2026/11/1201/`).
- Normalization rules:
  1. Must start with `/`.
  2. Reject query strings (`?`), hash fragments (`#`), control characters, backslashes, `..` / `.` traversal segments, and consecutive slashes (`//`).
  3. **Preserve case sensitivity**.
  4. **Enforce trailing slash** (`/` remains `/`; `/about` normalizes to `/about/`). Canonical pattern: `^/(?:[^/?#]+/)*$`.
  5. Maximum length: 512 bytes.
- Explicit legacy URL redirects/migrations are stored in `path_aliases(alias_path, canonical_path)`. Public read/write endpoints resolve `alias_path -> canonical_path` before querying or inserting.

### Waline Historical Data Reconciliation (Dry-run Summary)

Reconciled against `src/content/posts/` and `src/pages/` (zero PII included):
- Total comments in export: **21** (`20 approved`, `1 spam`).
- Tree integrity: **0 orphan `pid`/`rid`**, **0 cross-URL replies**.
- Path alignment:
  - `/about/` (7 comments) -> matches `src/pages/about.astro` (previously passed `path="/about"`, now normalized to `/about/`).
  - 8 post paths (`/posts/2025110313/`, `/posts/2025110415/`, `/posts/2025111000/`, `/posts/2025122116/`, `/posts/2026/03/1710/`, `/posts/2026/04/0815/`, `/posts/2026/10/2522/`, `/posts/2026/11/1201/`) -> all 8 match existing posts under `src/content/posts/`.
  - `/` (3 legacy test comments) -> **confirmed skipped during import** (`--skip-paths=/`). Effective imported set: **18 comments** (`17 approved`, `1 spam`).
- Media in historical comments: 3 comments contain `<img class="wl-emoji" src="//unpkg.com/@waline/emojis@..." alt="...">` (converted by Waline adapter into standard Markdown remote image `![alt](https://unpkg.com/...)`); 1 comment uses standard Markdown remote image `![](https://...)`.

---

## 3. Threading, Moderation & Placeholder Rules

- **Data model**: Each comment stores `parent_id` (direct parent, nullable) and `root_id` (top-level thread ID; `NULL` for root comments, equal to root's `id` for all replies in that thread).
- **Server-side enforcement**:
  - `root_id` is ALWAYS derived server-side from `parent_id` (client cannot supply `root_id`).
  - `parent_id` MUST exist, belong to the same canonical `path`, and be publicly replyable (`approved` and not under a `pending` ancestor). Replying to a non-existent, `pending`, `hidden`, `spam`, or `deleted` comment returns `404 PARENT_NOT_FOUND` (so non-public IDs cannot be probed).
- **Visibility & Placeholder Rules**:
  - Public endpoints ONLY return content of `approved` comments that are **not blocked by a `pending` ancestor**.
  - **Pending subtrees are hidden as a whole**: If any node is `pending`, neither it nor any of its descendants are returned publicly, and `total_approved` / `reply_count` MUST NOT count descendants blocked by a `pending` ancestor.
  - A `hidden`, `spam`, or `deleted` comment (not under a `pending` ancestor) is returned publicly **ONLY IF** it has at least one publicly visible (`approved` and unblocked) descendant. When returned as a placeholder:
    - `is_placeholder: true`
    - `placeholder_reason`: `"deleted"` if status is `deleted`, else `"hidden"` (never leak `"spam"` publicly)
    - `author_name: null`, `author_url: null`, `avatar_hue: null`, `is_admin: false`, `content_html: null`
  - If a `hidden` / `spam` / `deleted` comment has **no** publicly visible descendants, it is completely omitted from public responses.
  - **Placeholder roots remain paginated**: If a root thread is returned as a visible placeholder (`is_placeholder: true`), `GET /v1/comments/{id}/replies` MUST still return its visible replies (and intermediate placeholders if needed).
- **Pagination**:
  - `GET /v1/comments?path=...&limit=20&cursor=...&sort=desc&reply_limit=5`: paginates visible root threads by `(created_at DESC, id DESC)` (or `ASC` if `sort=asc`). Each root thread includes up to `reply_limit` (`0..20`, default `5`) initial replies (which may include intermediate placeholders) plus `reply_count` (count of visible `approved` replies, excluding placeholders) and `replies_next_cursor`.
  - When `reply_limit=0`, `replies` is `[]`, and `replies_next_cursor` is `""`? No: `replies_next_cursor` is omitted/null or explicit? Better: when `reply_limit=0` and the thread has visible replies, frontend fetches the first page via `GET /v1/comments/{id}/replies` **without a `cursor` parameter** (and `replies_next_cursor` is `null` since no slice cursor was issued; frontend checks `reply_count > 0 && replies.length === 0` only for initial lazy-load when using `reply_limit=0`, and for all paginated fetches uses `next_cursor !== null` — NEVER comparing `replies.length` against `reply_count`, because placeholders can make returned items exceed `reply_count`!).
  - `GET /v1/comments/{id}/replies?limit=20&cursor=...`: paginates visible replies (including connecting placeholders) within root thread `{id}` chronologically by `(created_at ASC, id ASC)`. Without `cursor`, returns the first page.
  - Cursors are opaque base64url-encoded `{ "t": "<iso>", "id": "<id>" }`.
- **Reversibility & Deletion (`PATCH /v1/admin/comments/{id}`)**:
  - Request MUST explicitly provide `status`.
  - `hidden` / `spam` / `pending` <-> `approved` transitions are reversible (original `content_markdown`, `content_html`, and author fields remain intact).
  - `deleted` is **irreversible**: attempting to transition a `deleted` comment to any other status returns `409 INVALID_STATE_TRANSITION`.
  - Soft delete (`{ "status": "deleted" }`): permanently clears `content_markdown`, `content_html`, `author_name`, `author_email`, `author_url`, sets `notify_on_reply = 0`, preserves tree skeleton (`id`, `path`, `parent_id`, `root_id`, `created_at`), and returns `200 { comment }`.
  - Hard delete (`{ "status": "deleted", "hard_delete": true }`):
    - If the comment has **zero children**: permanently deletes the row from D1 and returns **`204 No Content`**.
    - If the comment **has any children**: rejects with **`409 Conflict`** (`error.code = "HAS_CHILD_COMMENTS"`).

---

## 4. GFM + MFM Markdown Contract & Sanitization

- Database stores raw `content_markdown`; `content_html` is generated by the shared renderer and cached on write. `POST /v1/preview` calls the **exact same renderer**.
- **Fragment contract**: A-side returns clean inner HTML fragments **without** an outer `.cc-md` wrapper; B-side wraps rendered HTML in `.cc-md`.
- **Pipeline**:
  1. Dedicated `marked` instance with `gfm: true`, `breaks: true`.
  2. Raw HTML tokens are escaped/stripped (never passed through).
  3. Custom MFM inline tokenizer runs at inline level after code spans/blocks (so fenced code blocks and inline `` `code` `` are NEVER parsed as MFM).
  4. Final output passes through a strict **HTML allowlist sanitizer** (defense in depth).
- **Allowed HTML tags & attributes after sanitization**:
  - Block/inline GFM: `p`, `br`, `h1`-`h6`, `blockquote`, `ul`, `ol`, `li`, `input[type=checkbox][disabled][checked]` (task lists only), `pre`, `code`, `strong`, `em`, `del`, `hr`, `table`, `thead`, `tbody`, `tr`, `th`, `td`.
  - Links: `<a href="http(s)://..." target="_blank" rel="noopener noreferrer ugc nofollow">`.
  - Remote images: `<img src="http(s)://..." alt="..." loading="lazy" decoding="async" referrerpolicy="no-referrer" class="cc-img">`. Only `http://` and `https://` URLs are allowed.
  - MFM wrappers: `span`, `div`, `small`, `ruby`, `rt` with ONLY allowlisted `class` names (`mfm-*`) and validated inline styles / CSS custom properties.
- **Supported MFM Functions (Allowlist)**:
  - Max nesting depth: **4** (beyond depth 4, inner `$[...]` renders as literal text).
  - Unknown function names or malformed syntax render as **literal text**.
  - Explicitly excluded: `@mention`, `#hashtag`, `:custom_emoji:`, `$[search]`, `$[position]`, `$[x3]`, `$[x4]`.
  - Exact class names and CSS variables:

| Function | Params & Clamping | Rendered Class / Safe Style |
| :--- | :--- | :--- |
| `blur` | none | `<span class="mfm-blur">` |
| `fg` | `color`: `/^[0-9a-fA-F]{3,6}$/` | `<span class="mfm-fg" style="color:#...">` |
| `bg` | `color`: `/^[0-9a-fA-F]{3,6}$/` | `<span class="mfm-bg" style="background-color:#...">` |
| `font` | `serif` \| `monospace` \| `cursive` \| `fantasy` | `<span class="mfm-font-serif\|monospace\|cursive\|fantasy">` |
| `x2` | none (CSS capped at `1.5em`–`2em`) | `<span class="mfm-x2">` |
| `flip` | `h` \| `v` \| `h,v` (default `h`) | `<span class="mfm-flip-h\|mfm-flip-v\|mfm-flip-hv">` |
| `rotate` | `deg`: `-360..360` (default `90`) | `<span class="mfm-rotate" style="--mfm-deg:<n>deg">` |
| `scale` | `x`, `y`: `0.5..2.0` (default `1`) | `<span class="mfm-scale" style="--mfm-sx:<x>;--mfm-sy:<y>">` |
| `border` | `style`: `solid\|dashed\|dotted\|double` (default `solid`), `width`: `1..4` (px, default `1`), `radius`: `0..16` (px, default `0`), `color`: hex (optional, defaults to `currentColor`), `noclip`: ignored | `<span class="mfm-border" style="--mfm-border-style:<s>;--mfm-border-width:<w>px;--mfm-border-radius:<r>px;--mfm-border-color:<c>">` |
| `ruby` | `$[ruby base text]` (first space splits base & rt) | `<ruby class="mfm-ruby">base<rt>text</rt></ruby>` |
| `spin` | `speed`: `0.4..10` (s, default `1.5`), `delay`: `0..5` (s, default `0`), axis flag `x` \| `y` (mutually exclusive, default Z-axis), direction `left` (reverse) \| `alternate` (ping-pong) | `<span class="mfm-anim mfm-spin [mfm-spin-x\|mfm-spin-y] [mfm-spin-left] [mfm-spin-alternate]" style="--mfm-speed:<s>s;--mfm-delay:<d>s">` |
| `tada`, `jelly`, `shake`, `jump`, `bounce`, `twitch`, `rainbow`, `sparkle` | `speed`: `0.4..10` (s), `delay`: `0..5` (s) | `<span class="mfm-anim mfm-<fn>" style="--mfm-speed:<s>s;--mfm-delay:<d>s">` |
| `<small>...</small>` / `<center>...</center>` | MFM convenience wrappers (parsed by tokenizer, NOT raw HTML passthrough) | `<small class="mfm-small">` / `<div class="mfm-center">` |

- Admin UI MUST NOT auto-load remote `<img>` tags by default.
- Frontend CSS MUST honor `@media (prefers-reduced-motion: reduce)` to pause all `.mfm-anim` animations.

---

## 5. Anonymous Comments, Anti-Spam, Security & Auth

- **Moderation default**: `MODERATION_MODE = "pre"` (new non-admin comments start as `pending` and return HTTP `202` with `comment: null`). Configurable to `"post"` (`approved`, HTTP `201`).
- **Anonymous support**: `author_name`, `author_email`, `author_url` are all optional. Empty `author_name` is stored/returned as `null` (frontend renders localized `"匿名"` / `"Anonymous"`).
- **Avatar privacy**: No Gravatar/email hashes exposed publicly. Server computes `avatar_hue` (`0..359`); frontend renders Material Design 3 monogram avatars locally.
- **Anti-spam controls**:
  - Request body size limit (`32 KiB`), `content` max `10,000` chars (default `4,000` configurable), `author_name` max `80`, `author_url` max `512`.
  - Honeypot field (`honeypot`): non-empty returns `400 SPAM_DETECTED`.
  - Cloudflare Workers Rate Limiting bindings (`RATE_LIMIT_SUBMIT`, `RATE_LIMIT_PREVIEW`) keyed by ephemeral HMAC of `CF-Connecting-IP` + route (approximate per-colo; raw IP is NEVER persisted to D1).
  - Optional Cloudflare Turnstile: server-side `siteverify` when `TURNSTILE_SITE_KEY` & `TURNSTILE_SECRET_KEY` are configured.
- **CORS & Admin Auth**:
  - Public `/v1/*` APIs enforce exact `ALLOWED_ORIGINS` whitelist (CORS is never treated as auth).
  - `/admin/` is served same-origin from the Worker (`comments.chiyo.uk/admin/`).
  - Admin APIs (`/v1/admin/*`) require `Authorization: Bearer <ADMIN_TOKEN>` (constant-time comparison). Admin UI keeps the token strictly in JS memory (never URL query params, `localStorage`, or `sessionStorage`).
  - `is_admin: true` is granted ONLY via authenticated `POST /v1/admin/comments` or explicit migration metadata — NEVER inferred from nickname or email.

---

## 6. Email Notifications, Safe Confirmation & Outbox

Two independent notification triggers, independently configurable and simultaneously usable:

1. **`adminNewComment`**:
   - Triggered on non-admin, non-imported comment creation (`POST /v1/comments`).
   - Providers: `cf_email_routing` (Cloudflare `send_email` binding fixed to verified `ADMIN_NOTIFY_EMAIL`) | `resend` | `http` (generic HTTPS endpoint) | `none`.
2. **`replyApproved`**:
   - Providers: `resend` | `http` | `none`.
   - **Strict eligibility rules** — enqueued ONLY when all hold:
     1. `REPLY_EMAIL_PROVIDER` is `resend` or `http`.
     2. Reply transitions into `approved` status (immediate on `POST` in `post` mode, via `POST /v1/admin/comments`, or on `PATCH /v1/admin/comments/:id` approving a `pending` reply).
     3. Direct parent has `notify_on_reply = 1` and valid `author_email`.
     4. Parent email has `status = 'verified'` in `email_subscriptions` (not unsubscribed).
     5. Reply author's normalized email differs from parent's normalized email.
     6. Reply is NOT from historical import (`import_source IS NULL`).
3. **Safe Double-Opt-In & Unsubscribe (RFC 9110)**:
   - `GET /v1/subscriptions/verify?token=...` and `GET /v1/subscriptions/unsubscribe?token=...` are **read-only**: they render minimal HTML confirmation pages containing a `<form method="POST">` submit button (protecting against email client link prefetchers / security scanners).
   - `POST /v1/subscriptions/verify` and `POST /v1/subscriptions/unsubscribe` consume the token and mutate `email_subscriptions`.
   - Both pages and endpoints are served by A-side Worker with `Cache-Control: no-store`.
   - `POST /v1/comments` returns `verification_queued: true|false` (never claims the email was delivered).
4. **Transactional Outbox (`email_outbox`)**:
   - Status change + outbox enqueue happen atomically in `env.DB.batch([...])`.
   - Unique `dedupe_key` (`admin_new:<id>`, `reply:<reply_id>`, `verify:<email_hash>:<day_bucket>`).
   - Immediate best-effort drain via `ctx.waitUntil(...)`, plus Cron Trigger retries (`max_attempts = 5`, exponential backoff).

---

## 7. Static Assets, Material Design 3 & Caching Contract

- Frontend widget and `/admin/` follow **Material Design 3** (`https://m3.material.io/`).
- **Build handoff**:
  - B-side builds static deliverables into `dist/static/`:
    - `dist/static/assets/v1/comments.js`
    - `dist/static/assets/v1/comments.css`
    - `dist/static/admin/index.html`
    - `dist/static/admin/admin.js`
    - `dist/static/admin/admin.css`
    - `dist/static/_headers`
  - A-side wires `dist/static/` into Cloudflare Build Output (`assets/`) during `cf build` / build script, and configures `cloudflare.config.ts` with:
    - `assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "none", runWorkerFirst: ["/v1/*"] }`
    - Static routes (`/assets/v1/*`, `/admin/`) are served directly by Cloudflare Static Assets (no `ASSETS` binding needed; no SPA fallback).
- **Cache & Header Ownership**:
  - B-side `_headers` sets static CORS headers and ETag revalidation (no `immutable`) for `/assets/v1/*`, and security headers (CSP / `X-Frame-Options` / `Referrer-Policy`) for `/admin/`.
  - A-side Worker sets `Cache-Control: no-store` on all `/v1/admin/*`, `/v1/subscriptions/*`, and export responses.

---

## 8. Export / Import Portability

- Standard JSON format is defined by `schemas/export.schema.json`:
  - `include_private: false` (default): **admin backup omitting visitor emails** (still contains non-public comment bodies such as `pending`/`hidden`/`spam`, so it MUST NOT be treated as public data). Schema forbids `author_email` when `include_private: false`.
  - `include_private: true`: explicit private backup/migration including `author_email` (imported emails are NEVER auto-subscribed to notifications).
  - Non-deleted comments MUST have non-empty `content_markdown`; `deleted` comments MUST have `content_markdown: null`.
  - Never exports/imports raw IPs, password hashes, or account credentials.

---

## 9. Configuration Matrix (Public vs Bindings vs Secrets)

| Category | Variable / Binding | Purpose | Exposed to Frontend? |
| :--- | :--- | :--- | :--- |
| Public var | `SITE_URL` | Canonical blog origin (e.g. `https://blog.chiyo.uk`) | Yes (`/v1/config`) |
| Public var | `ALLOWED_ORIGINS` | Comma-separated exact CORS origins | No |
| Public var | `MODERATION_MODE` | `pre` (default) \| `post` | Yes (`/v1/config`) |
| Public var | `MAX_CONTENT_LENGTH` | Max Markdown length (default `4000`) | Yes (`/v1/config`) |
| Public var | `TURNSTILE_SITE_KEY` | Optional Turnstile public site key | Yes (`/v1/config`) |
| Public var | `ADMIN_EMAIL_PROVIDER` | `cf_email_routing` \| `resend` \| `http` \| `none` | No |
| Public var | `REPLY_EMAIL_PROVIDER` | `resend` \| `http` \| `none` | Boolean only (`reply_notify_enabled`) |
| Public var | `EMAIL_FROM` | Sender address (e.g. `comments@chiyo.uk`) | No |
| Public var | `ADMIN_NOTIFY_EMAIL` | Verified admin inbox address | No |
| Public var | `EMAIL_HTTP_ENDPOINT` | Generic HTTPS email API URL (when provider=`http`) | No |
| Binding | `DB` | Cloudflare D1 database | No |
| Binding | `SEND_EMAIL` | Optional Cloudflare Email Routing `send_email` binding | No |
| Binding | `RATE_LIMIT_SUBMIT` / `RATE_LIMIT_PREVIEW` | Optional Cloudflare Rate Limiting bindings | No |
| Secret | `ADMIN_TOKEN` | Admin Bearer token | **NEVER** |
| Secret | `TOKEN_SIGNING_SECRET` | HMAC/hashing pepper for subscription tokens & ephemeral rate keys | **NEVER** |
| Secret | `TURNSTILE_SECRET_KEY` | Optional Turnstile secret | **NEVER** |
| Secret | `RESEND_API_KEY` | Optional Resend API key | **NEVER** |
| Secret | `EMAIL_HTTP_TOKEN` | Optional Bearer token for generic HTTPS email endpoint | **NEVER** |
