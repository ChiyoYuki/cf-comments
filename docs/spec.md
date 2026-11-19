# cf-comments v1 Frozen Specification

## 1. Scope & Architecture

- **Single-instance deployment**: One Worker + one D1 database serves one site (no multi-tenancy in v1).
- **Standalone repository**: Lives in `workers/comments/` as an independent Git repository with its own `package.json`, lockfile, `tsconfig.json`, `biome.json`, `cloudflare.config.ts`, migrations, and tests. Zero personal domains or credentials are hardcoded in tracked files.
- **Unified configuration**: Non-sensitive site settings live in gitignored `cf-comments.config.json` (template: `cf-comments.config.example.json`) with `CF_*` environment variable overrides for CI/CD, consumed uniformly by `cloudflare.config.ts`, `scripts/build-worker.mjs`, and `scripts/import-waline.ts`. Secrets live strictly in `.dev.vars` (local) and Cloudflare Secrets (staging/production).
- **Tooling**: Cloudflare `cf` CLI `v0.15.0+` + `cloudflare.config.ts`. Local verification uses `--local`; staging uses a dedicated D1 database before production deployment via Worker Custom Domain.
- **Explicit non-goals in v1**: No `pageview` counter; no ActivityPub; no KaTeX formula rendering; no image upload or image proxy; no visitor account system and no visitor self-edit/self-delete.

---

## 2. Path Normalization & Aliases

- Thread key is an explicit site-relative `path` (e.g. `/about/`, `/friends/`, `/posts/2026/11/example/`).
- Normalization rules:
  1. Must start with `/`.
  2. Reject query strings (`?`), hash fragments (`#`), control characters, backslashes, `..` / `.` traversal segments, and consecutive slashes (`//`).
  3. **Preserve case sensitivity**.
  4. **Enforce trailing slash** (`/` remains `/`; `/about` normalizes to `/about/`). Canonical pattern: `^/(?:[^/?#]+/)*$`.
  5. Maximum length: 512 bytes.
- Explicit legacy URL redirects/migrations are stored in `path_aliases(alias_path, canonical_path)`. Public read/write endpoints resolve `alias_path -> canonical_path` before querying or inserting.

---

## 3. Threading, Moderation & Placeholder Rules

- **Data model**: Each comment stores `parent_id` (direct parent, nullable) and `root_id` (top-level thread ID; `NULL` for root comments, equal to root's `id` for all replies in that thread).
- **Server-side enforcement**:
  - `root_id` is ALWAYS derived server-side from `parent_id` (client cannot supply `root_id`).
  - `parent_id` MUST exist, belong to the same canonical `path`, and be publicly replyable (`approved` and not under a `pending` ancestor). Replying to a non-existent, `pending`, `hidden`, `spam`, or `deleted` comment returns `404 PARENT_NOT_FOUND`.
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
  - `GET /v1/comments?path=...&limit=20&cursor=...&sort=desc&reply_limit=5`: paginates visible root threads by `(created_at DESC, id DESC)` (or `ASC` if `sort=asc`). Each root thread includes up to `reply_limit` (`0..20`, default `5`) initial replies plus `reply_count` (count of visible `approved` replies, excluding placeholders) and `replies_next_cursor`.
  - When `reply_limit=0`, `replies` is `[]` and `replies_next_cursor` is `null`; frontend fetches the first page via `GET /v1/comments/{id}/replies` **without `cursor`**, and always uses `next_cursor !== null` (never `replies.length < reply_count`) to check for more pages.
  - `GET /v1/comments/{id}/replies?limit=20&cursor=...`: paginates visible replies (including connecting placeholders) chronologically by `(created_at ASC, id ASC)`.
  - Cursors are opaque base64url-encoded `{ "t": "<iso>", "id": "<id>" }`.
- **Reversibility & Deletion (`PATCH /v1/admin/comments/{id}`)**:
  - Request MUST explicitly provide `status`.
  - `hidden` / `spam` / `pending` <-> `approved` transitions are reversible.
  - `deleted` is **irreversible**: attempting to transition a `deleted` comment to any other status returns `409 INVALID_STATE_TRANSITION`.
  - Soft delete (`{ "status": "deleted" }`): permanently clears `content_markdown`, `content_html`, `author_name`, `author_email`, `author_url`, sets `notify_on_reply = 0`, preserves tree skeleton, and returns `200 { comment }`.
  - Hard delete (`{ "status": "deleted", "hard_delete": true }`):
    - Zero children: permanently removes row and returns **`204 No Content`**.
    - Has children: rejects with **`409 Conflict`** (`error.code = "HAS_CHILD_COMMENTS"`).

---

## 4. Dual-Syntax Markdown Contract (`gfm` | `mfm`) & Upstream Reuse

- **Per-comment explicit syntax**: Every comment explicitly chooses `syntax: "gfm" | "mfm"` (default `"gfm"`). Historical imports (e.g. Waline) default to `"gfm"`.
- **Orthogonal official upstream pipelines** (zero cross-grammar conflict glue):
  1. **`gfm` mode**: `unified` + `remark-parse` + `remark-gfm` + `remark-breaks` + `remark-rehype({ allowDangerousHtml: false })` + `rehype-sanitize` (GitHub `defaultSchema`) + HAST hardening (`http(s)`-only `<a>`/`<img>`) + `rehype-stringify`. Supports remote `http(s)` images `![alt](url)` with `loading="lazy" decoding="async" referrerpolicy="no-referrer" class="cc-img"`. No image uploads.
  2. **`mfm` mode**: Direct official **`mfm-js`** (`mfm.parse`) -> HAST mapper -> official `rehype-sanitize` (MFM HAST schema) + HAST hardening -> `rehype-stringify`. Pure `mfm-js` syntax (no `![alt](url)` image hack; users select `gfm` to embed remote images).
- **Fragment contract**: A-side returns clean inner HTML fragments **without** `.cc-md`; B-side wraps rendered HTML in `.cc-md` with mandatory `overflow: hidden; position: relative;` (so `$[position]` cannot escape the comment card).
- **MFM Behavior Rules**:
  - **Misskey instance context (`MISSKEY_INSTANCE_URL`, optional)**:
    - When configured (e.g. `https://misskey.example.com`):
      - `@user` / `@user@host` -> external link `<a class="mfm-mention" href="${origin}/@...">`
      - `#tag` -> external link `<a class="mfm-hashtag" href="${origin}/tags/...">`
      - `:emoji:` -> emits `<span class="mfm-emoji" data-emoji="name">:name:</span>` (**NO server-side emoji fetch or D1 cache**). The browser widget lazily resolves unique emoji names directly via `POST ${misskey_instance_url}/api/emoji` (`{ name }`) in session memory, falling back gracefully to `:name:` on 404/network/CORS failure.
    - When NOT configured: `@mention`, `#hashtag`, and `:emoji:` render as plain text.
  - **No KaTeX**: `mathInline` / `mathBlock` render as `<code class="mfm-math-inline">` / `<pre class="mfm-math-block"><code>` showing raw formula text.
  - **No search forms**: `search` nodes render their original text (`node.props.content`) as plain text.
  - **Size scaling (`x2`, `x3`, `x4`)**: All three are allowed without upper cap, **but nested magnification is prevented** at both AST level (inner `x2/x3/x4` ignored while inside an outer `.mfm-size`) and CSS level (`.mfm-size .mfm-size { font-size: 1em; }`).
  - **Position (`$[position.x=...,y=...]`)**: Allowed (`--mfm-px`, `--mfm-py` clamped to `-10..10` em), safely clipped by `.cc-md { overflow: hidden; position: relative; }`.
  - **Exact MFM classes & CSS custom properties**:

| Function / Node | Params & Clamping | Rendered Class / Safe Style |
| :--- | :--- | :--- |
| `blur` | none | `<span class="mfm-blur">` |
| `fg` / `bg` | `color`: `/^[0-9a-fA-F]{3,6}$/` | `<span class="mfm-fg" style="color:#...">` / `<span class="mfm-bg" style="background-color:#...">` |
| `font` | `serif` \| `monospace` \| `cursive` \| `fantasy` | `<span class="mfm-font-<family>">` |
| `x2`, `x3`, `x4` | non-compounding (nested magnification disabled) | `<span class="mfm-size mfm-x2\|mfm-x3\|mfm-x4">` |
| `position` | `x`, `y`: `-10..10` (em, default `0`) | `<span class="mfm-position" style="--mfm-px:<x>em;--mfm-py:<y>em">` |
| `flip` | `h` \| `v` \| `h,v` (default `h`) | `<span class="mfm-flip-h\|mfm-flip-v\|mfm-flip-hv">` |
| `rotate` | `deg`: `-360..360` (default `90`) | `<span class="mfm-rotate" style="--mfm-deg:<n>deg">` |
| `scale` | `x`, `y`: `0.5..2.0` (default `1`) | `<span class="mfm-scale" style="--mfm-sx:<x>;--mfm-sy:<y>">` |
| `border` | `style`: `solid\|dashed\|dotted\|double`, `width`: `1..4`px, `radius`: `0..16`px, `color`: hex or `currentColor` | `<span class="mfm-border" style="--mfm-border-style:...;--mfm-border-width:...px;--mfm-border-radius:...px;--mfm-border-color:...">` |
| `ruby` | `$[ruby base text]` | `<ruby class="mfm-ruby">base<rt>text</rt></ruby>` |
| `unixtime` | epoch seconds | `<time class="mfm-unixtime" datetime="..." data-unixtime="...">UTC</time>` (frontend localizes via `Intl.DateTimeFormat`) |
| `spin` | `speed`: `0.4..10`s (default `1.5`), `delay`: `0..5`s, axis `x`\|`y`, direction `left`, `alternate` | `<span class="mfm-anim mfm-spin [mfm-spin-x\|mfm-spin-y] [mfm-spin-left] [mfm-spin-alternate]" style="--mfm-speed:<s>s;--mfm-delay:<d>s">` |
| `tada`, `jelly`, `shake`, `jump`, `bounce`, `twitch`, `rainbow`, `sparkle` | `speed`: `0.4..10`s, `delay`: `0..5`s (max anim nesting depth `4`) | `<span class="mfm-anim mfm-<fn>" style="--mfm-speed:<s>s;--mfm-delay:<d>s">` |
| `<small>` / `<center>` | parsed natively by `mfm-js` | `<small class="mfm-small">` / `<div class="mfm-center">` |
| `:emoji:` (when `MISSKEY_INSTANCE_URL` set) | `[a-zA-Z0-9_+-]+` | `<span class="mfm-emoji" data-emoji="name">:name:</span>` |
| `\(math\)` / `\[math\]` | raw formula text (no KaTeX) | `<code class="mfm-math-inline">` / `<pre class="mfm-math-block"><code>` |

- Admin UI MUST NOT auto-load remote `<img>` or remote Misskey emojis by default.
- Frontend CSS MUST honor `@media (prefers-reduced-motion: reduce)` to pause all `.mfm-anim` animations.

---

## 5. Anonymous Comments, Anti-Spam, Security & Auth

- **No visitor account system and no visitor self-edit/self-delete in v1**.
- **Moderation default**: `MODERATION_MODE = "pre"` (`pending`, HTTP `202`, `comment: null`). Configurable to `"post"` (`approved`, HTTP `201`).
- **Anonymous support**: `author_name`, `author_email`, `author_url` are all optional. Empty `author_name` is stored/returned as `null`.
- **Avatar privacy**: No Gravatar/email hashes exposed publicly. Server computes `avatar_hue` (`0..359`); frontend renders Material Design 3 monogram avatars locally.
- **Anti-spam controls**: `32 KiB` body limit, honeypot (`SPAM_DETECTED`), Cloudflare Workers Rate Limiting bindings keyed by ephemeral HMAC of `CF-Connecting-IP` (raw IP never persisted), optional Turnstile server-side verification.
- **CORS & Admin Auth**: Exact `ALLOWED_ORIGINS` whitelist on public `/v1/*`; `/admin/` same-origin; `/v1/admin/*` requires `Authorization: Bearer <ADMIN_TOKEN>` kept strictly in JS memory. `is_admin: true` is server-granted only.

---

## 6. Email Notifications, Safe Confirmation & Outbox

- **`adminNewComment`**: `cf_email_routing` (`send_email` binding fixed to verified admin address) | `resend` | `http` | `none`.
- **`replyApproved`**: `resend` | `http` | `none`. Enqueued ONLY when reply transitions to `approved`, parent opted in (`notify_on_reply = 1`), parent email is `verified` via double opt-in (and not unsubscribed), reply author email differs from parent, and reply is not a historical import.
- **RFC 9110 safe two-step verification & unsubscribe**: `GET /v1/subscriptions/{verify,unsubscribe}` renders read-only HTML confirmation page (`Cache-Control: no-store`); `POST` consumes token and mutates state. `POST /v1/comments` returns `verification_queued`.
- **Transactional D1 `email_outbox`**: Atomic with status mutations via `DB.batch([...])`, deduplicated by `dedupe_key`, drained via `ctx.waitUntil` + Cron retries (`max_attempts = 5`, exponential backoff).

---

## 7. Frontend Architecture, Static Assets & Caching Contract

- **Frontend tech stack**: **100% Native TypeScript + CSS** (zero frontend framework runtime), following **Material Design 3** (`https://m3.material.io/`), packaged as a Web Component for effortless Swup SPA mounting/cleanup.
- **Build handoff**:
  - B-side outputs static deliverables into `dist/static/`:
    - `dist/static/assets/v1/comments.js`
    - `dist/static/assets/v1/comments.css`
    - `dist/static/admin/index.html`
    - `dist/static/admin/admin.js`
    - `dist/static/admin/admin.css`
    - `dist/static/_headers`
  - A-side `scripts/build-worker.mjs` bundles `dist/static/` into `.cloudflare/output/v0/` via `writeAssets`, with `cloudflare.config.ts` setting `assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "none", runWorkerFirst: ["/v1/*"] }`.
- **Cache & Header Ownership**:
  - B-side `_headers`: static CORS + ETag revalidation (no `immutable`) for `/assets/v1/*`, security headers for `/admin/`.
  - A-side Worker: `Cache-Control: no-store` on `/v1/admin/*`, `/v1/subscriptions/*`, and export responses.

---

## 8. Export / Import Portability

- Standard JSON format is defined by `schemas/export.schema.json`:
  - `include_private: false` (default): admin backup omitting visitor emails (still contains non-public statuses; NOT public-safe). Schema forbids `author_email` when `include_private: false`.
  - `include_private: true`: explicit private backup/migration including `author_email` (imported emails are never auto-subscribed).
  - Preserves per-comment `syntax` (`gfm` | `mfm`, default `gfm`).
  - Non-deleted comments MUST have non-empty `content_markdown`; `deleted` comments MUST have `content_markdown: null`.
  - Never exports/imports raw IPs, password hashes, or account credentials.

---

## 9. Configuration Matrix (Public vs Bindings vs Secrets)

| Category | Variable / Binding | Purpose | Exposed to Frontend? |
| :--- | :--- | :--- | :--- |
| Public var | `SITE_URL` | Canonical site origin | Yes (`/v1/config`) |
| Public var | `ALLOWED_ORIGINS` | Comma-separated exact CORS origins | No |
| Public var | `MODERATION_MODE` | `pre` (default) \| `post` | Yes (`/v1/config`) |
| Public var | `MAX_CONTENT_LENGTH` | Max comment length (default `4000`) | Yes (`/v1/config`) |
| Public var | `MISSKEY_INSTANCE_URL` | Optional Misskey origin for MFM context & client-side `:emoji:` fetch | Yes (`/v1/config`) |
| Public var | `TURNSTILE_SITE_KEY` | Optional Turnstile public site key | Yes (`/v1/config`) |
| Public var | `ADMIN_EMAIL_PROVIDER` | `cf_email_routing` \| `resend` \| `http` \| `none` | No |
| Public var | `REPLY_EMAIL_PROVIDER` | `resend` \| `http` \| `none` | Boolean only (`reply_notify_enabled`) |
| Public var | `EMAIL_FROM` | Sender address | No |
| Public var | `ADMIN_NOTIFY_EMAIL` | Verified admin inbox address | No |
| Public var | `EMAIL_HTTP_ENDPOINT` | Generic HTTPS email API URL | No |
| Binding | `DB` | Cloudflare D1 database | No |
| Binding | `SEND_EMAIL` | Optional Cloudflare Email Routing `send_email` binding | No |
| Binding | `RATE_LIMIT_SUBMIT` / `RATE_LIMIT_PREVIEW` | Optional Cloudflare Rate Limiting bindings | No |
| Secret | `ADMIN_TOKEN` | Admin Bearer token | **NEVER** |
| Secret | `TOKEN_SIGNING_SECRET` | HMAC pepper for subscription tokens & ephemeral rate keys | **NEVER** |
| Secret | `TURNSTILE_SECRET_KEY` | Optional Turnstile secret | **NEVER** |
| Secret | `RESEND_API_KEY` | Optional Resend API key | **NEVER** |
| Secret | `EMAIL_HTTP_TOKEN` | Optional Bearer token for generic HTTPS email endpoint | **NEVER** |
