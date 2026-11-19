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
  2. Reject query strings (`?`), hash fragments (`#`), control characters, backslashes, `..` traversal segments, and double slashes (`//`).
  3. **Preserve case sensitivity**.
  4. **Enforce trailing slash** (`/` remains `/`; `/about` normalizes to `/about/`).
  5. Maximum length: 512 bytes.
- Explicit legacy URL redirects/migrations are stored in `path_aliases(alias_path, canonical_path)`. Public read/write endpoints resolve `alias_path -> canonical_path` before querying or inserting.

### Waline Historical Data Reconciliation (Dry-run Summary)

Reconciled against `src/content/posts/` and `src/pages/` (zero PII included):
- Total comments: **21** (`20 approved`, `1 spam`).
- Tree integrity: **0 orphan `pid`/`rid`**, **0 cross-URL replies**.
- Path alignment:
  - `/about/` (7 comments) -> matches `src/pages/about.astro` (previously passed `path="/about"`, now normalized to `/about/`).
  - 8 post paths (`/posts/2025110313/`, `/posts/2025110415/`, `/posts/2025111000/`, `/posts/2025122116/`, `/posts/2026/03/1710/`, `/posts/2026/04/0815/`, `/posts/2026/10/2522/`, `/posts/2026/11/1201/`) -> all 8 match existing posts under `src/content/posts/`.
  - `/` (3 legacy test comments) -> homepage no longer embeds comments; import CLI supports `--skip-paths=/` or `--hide-paths=/` (default decision to confirm with site owner before production import).
- Media in historical comments: 3 comments contain `<img class="wl-emoji" src="//unpkg.com/@waline/emojis@..." alt="...">` (converted by Waline adapter into standard Markdown remote image `![alt](https://unpkg.com/...)`); 1 comment uses standard Markdown remote image `![](https://...)`.

---

## 3. Threading, Moderation & Placeholder Rules

- **Data model**: Each comment stores `parent_id` (direct parent, nullable) and `root_id` (top-level thread ID; `NULL` for root comments, equal to root's `id` for all replies in that thread).
- **Server-side enforcement**:
  - `root_id` is ALWAYS derived server-side from `parent_id` (client cannot supply `root_id`).
  - `parent_id` MUST exist, belong to the same canonical `path`, and MUST NOT be in `spam` or `deleted` status when replying (replies to `hidden`/`pending` parents are also rejected with `PARENT_NOT_FOUND` so non-public comment IDs cannot be probed).
- **Pagination**:
  - `GET /v1/comments?path=...&limit=20&cursor=...&sort=desc&reply_limit=5`: paginates root threads by `(created_at DESC, id DESC)` (or `ASC` if `sort=asc`). Each root thread includes up to `reply_limit` (default `5`, max `20`) initial replies plus `reply_count` and `replies_next_cursor`.
  - `GET /v1/comments/:id/replies?limit=20&cursor=...`: paginates replies within root thread `:id` chronologically by `(created_at ASC, id ASC)`.
  - Cursors are opaque base64url-encoded `{ "t": "<iso>", "id": "<id>" }`.
- **Visibility & Placeholder Rules**:
  - Public endpoints ONLY return content of `approved` comments.
  - A `pending` comment is never returned publicly (neither as root nor as placeholder).
  - A `hidden`, `spam`, or `deleted` comment is returned publicly **ONLY IF** it has at least one `approved` descendant (i.e. it is needed to preserve thread structure). When returned as a placeholder:
    - `is_placeholder: true`
    - `placeholder_reason`: `"deleted"` if status is `deleted`, else `"hidden"` (never leak `"spam"` publicly)
    - `author_name: null`, `author_url: null`, `avatar_hue: null`, `is_admin: false`, `content_html: null`
  - If a `hidden` / `spam` / `deleted` comment has **no** `approved` descendants, it is completely omitted from public responses.
  - **Reversibility**:
    - `hidden` / `spam` <-> `approved` is fully reversible (original `content_markdown`, `content_html`, and author fields remain intact in D1).
    - `deleted` permanently clears `content_markdown`, `content_html`, `author_name`, `author_email`, `author_url`, and sets `notify_on_reply = 0`, while preserving `id`, `path`, `parent_id`, `root_id`, `created_at` so child replies stay connected (hard-delete is permitted only on leaf comments with no children if explicitly requested by admin).

---

## 4. GFM + MFM Markdown Contract & Sanitization

- Database stores raw `content_markdown`; `content_html` is generated by the shared renderer and cached on write (and re-renderable on upgrade). `POST /v1/preview` calls the **exact same renderer**.
- **Pipeline**:
  1. Dedicated `marked` instance with `gfm: true`, `breaks: true`.
  2. Raw HTML tokens are escaped/stripped (never passed through).
  3. Custom MFM inline tokenizer runs at inline level after code spans/blocks (so fenced code blocks and inline `` `code` `` are NEVER parsed as MFM).
  4. Final output passes through a strict **HTML allowlist sanitizer** (defense in depth).
- **Allowed HTML tags & attributes after sanitization**:
  - Block/inline GFM: `p`, `br`, `h1`-`h6` (remapped or styled safely within comment card), `blockquote`, `ul`, `ol`, `li`, `input[type=checkbox][disabled][checked]` (task lists only), `pre`, `code`, `strong`, `em`, `del`, `hr`, `table`, `thead`, `tbody`, `tr`, `th`, `td`.
  - Links: `<a href="http(s)://..." target="_blank" rel="noopener noreferrer ugc nofollow">`.
  - Remote images: `<img src="http(s)://..." alt="..." loading="lazy" decoding="async" referrerpolicy="no-referrer" class="cc-img">`. No `data:`, `javascript:`, `vbscript:`, or relative URLs.
  - MFM wrappers: `span`, `div`, `small`, `ruby`, `rt` with ONLY allowlisted `class` names (`mfm-*`) and validated inline CSS custom properties / safe style properties.
- **Supported MFM Functions (Allowlist)**:
  - Max nesting depth: **4** (beyond depth 4, inner `$[...]` renders as literal text).
  - Unknown function names or malformed syntax render as **literal text**.
  - Explicitly excluded: `@mention`, `#hashtag`, `:custom_emoji:`, `$[search]`, `$[position]`, `$[x3]`, `$[x4]`.
  - Included functions & clamped parameter ranges:

| Function | Params & Clamping | Rendered Class / Safe Style |
| :--- | :--- | :--- |
| `blur` | none | `<span class="mfm-blur">` (hover/click reveal) |
| `fg` | `color`: `/^[0-9a-fA-F]{3,6}$/` | `<span class="mfm-fg" style="color:#...">` |
| `bg` | `color`: `/^[0-9a-fA-F]{3,6}$/` | `<span class="mfm-bg" style="background-color:#...">` |
| `font` | `serif` \| `monospace` \| `cursive` \| `fantasy` | `<span class="mfm-font-...">` |
| `x2` | none (capped at 1.5x–2x in CSS) | `<span class="mfm-x2">` |
| `flip` | `h` \| `v` \| `h,v` (default `h`) | `<span class="mfm-flip-h\|v\|hv">` |
| `rotate` | `deg`: `-360..360` (default `90`) | `<span class="mfm-rotate" style="--mfm-deg:...deg">` |
| `scale` | `x`, `y`: `0.5..2.0` (default `1`) | `<span class="mfm-scale" style="--mfm-sx:...;--mfm-sy:...">` |
| `border` | `style`: `solid\|dashed\|dotted\|double`, `width`: `1..4`, `radius`: `0..16`, `color`: hex, `noclip`: ignored (always clip/contain) | `<span class="mfm-border" style="...">` |
| `ruby` | `$[ruby base text]` (first space splits base & rt) | `<ruby class="mfm-ruby">base<rt>text</rt></ruby>` |
| `tada`, `jelly`, `shake`, `spin`, `jump`, `bounce`, `twitch`, `rainbow`, `sparkle` | `speed`: `0.4..10` (s), `delay`: `0..5` (s); `spin` accepts `left`\|`alternate`\|`x`\|`y` | `<span class="mfm-anim mfm-<fn>" style="--mfm-speed:...s;--mfm-delay:...s">` |
| `<small>...</small>` / `<center>...</center>` | MFM convenience wrappers (parsed by tokenizer, NOT raw HTML passthrough) | `<small class="mfm-small">` / `<div class="mfm-center">` |

- Admin UI MUST NOT auto-load remote `<img>` tags by default (render image placeholder/URL with explicit "Load remote images" toggle).
- Frontend CSS MUST honor `@media (prefers-reduced-motion: reduce)` to pause all `.mfm-anim` animations.

---

## 5. Anonymous Comments, Anti-Spam, Security & Auth

- **Moderation default**: `MODERATION_MODE = "pre"` (new non-admin comments start as `pending` and return HTTP `202`). Configurable to `"post"` (`approved`, HTTP `201`).
- **Anonymous support**: `author_name`, `author_email`, `author_url` are all optional. When `author_name` is empty, `author_name` is `null` (frontend renders localized `"匿名"` / `"Anonymous"`).
- **Avatar privacy**: No Gravatar/email hashes exposed publicly. Server computes a deterministic `avatar_hue` (`0..359`, derived from author name or random per anonymous comment); frontend renders Material Design 3 monogram avatars locally.
- **Anti-spam controls**:
  - Request body size limit (e.g. `32 KiB`), `content` max `10,000` chars (default `4,000` configurable), `author_name` max `80`, `author_url` max `512`.
  - Honeypot field (`website_hp` / `honeypot`): non-empty returns `400 SPAM_DETECTED` (or silent drop policy).
  - Cloudflare Workers Rate Limiting binding (`RATE_LIMIT_SUBMIT`, `RATE_LIMIT_PREVIEW`) keyed by ephemeral hash of `CF-Connecting-IP` + route (approximate per-colo; raw IP is NEVER persisted to D1).
  - Optional Cloudflare Turnstile: if `TURNSTILE_SITE_KEY` & `TURNSTILE_SECRET_KEY` are configured, `POST /v1/comments` requires server-side siteverify check.
- **CORS & Admin Auth**:
  - Public `/v1/*` APIs enforce exact `ALLOWED_ORIGINS` whitelist (never `*` with credentials; CORS is not auth).
  - `/admin/` is served same-origin from the Worker (`comments.chiyo.uk/admin/`).
  - Admin APIs (`/v1/admin/*`) require `Authorization: Bearer <ADMIN_TOKEN>` (constant-time comparison). Admin UI keeps the token strictly in JS memory (never URL query params, `localStorage`, or `sessionStorage`).
  - `is_admin: true` is granted ONLY when authenticated via admin endpoint (`POST /v1/admin/comments`) or explicitly marked during migration/admin action — NEVER inferred from nickname or email.

---

## 6. Email Notifications & Double Opt-In

Two independent notification triggers, independently configurable and simultaneously usable:

1. **`adminNewComment`**:
   - Triggered on non-admin, non-imported comment creation (`POST /v1/comments`).
   - Supported providers:
     - `cf_email_routing`: Cloudflare Workers `send_email` binding (fixed to verified `ADMIN_NOTIFY_EMAIL`, zero third-party dependency).
     - `resend`: Resend HTTPS API (`POST https://api.resend.com/emails`).
     - `http`: Generic administrator-configured HTTPS email endpoint (`POST <EMAIL_HTTP_ENDPOINT>`, Bearer/custom header auth, JSON body `{ from, to, subject, text, html, meta }`).
     - `none`: Disabled.
2. **`replyApproved`**:
   - Supported providers: `resend` | `http` | `none` (Cloudflare `send_email` cannot deliver to arbitrary visitor addresses).
   - **Strict eligibility rules** — a visitor reply email is enqueued ONLY WHEN **all** conditions hold:
     1. `REPLY_EMAIL_PROVIDER` is configured (`resend` or `http`).
     2. The reply transitions into `approved` status (either immediately on `POST` in `post` mode, via `POST /v1/admin/comments`, or on `PATCH /v1/admin/comments/:id` approving a `pending` reply).
     3. The direct parent comment has `notify_on_reply = 1` and a valid `author_email`.
     4. That email has `status = 'verified'` in `email_subscriptions` (double opt-in completed via `GET /v1/subscriptions/verify?token=...`, not subsequently unsubscribed).
     5. Reply author's normalized email differs from parent author's normalized email (no self-notification).
     6. Reply is NOT from historical import (`import_source IS NULL`).
3. **Transactional Outbox (`email_outbox`)**:
   - Status mutation + outbox insertion run in a single `env.DB.batch([...])` transaction.
   - Unique `dedupe_key` (`admin_new:<id>`, `reply:<reply_id>`, `verify:<email_hash>:<day_bucket>`) prevents duplicate sends.
   - Immediate best-effort drain via `ctx.waitUntil(...)`, plus Cloudflare Cron Trigger retries up to `max_attempts = 5` with exponential backoff.

---

## 7. Frontend Design & Material Design 3 Integration (B-Side Alignment)

- Frontend widget and `/admin/` UI follow **Material Design 3** (`https://m3.material.io/`).
- Worker serves versioned embeddable assets:
  - `GET /assets/v1/comments.js`
  - `GET /assets/v1/comments.css`
  - `GET /admin/` (same-origin console)
- Rendered comment HTML uses semantic `.cc-md` / `.mfm-*` classes without hardcoded light/dark backgrounds, so the M3 frontend controls typography, surfaces, elevation, and color tokens (`--md-sys-color-*`), and `Comments.astro` only passes `apiBase`, `path`, and Fuwari theme CSS variables (`--primary`, `html.dark` sync).

---

## 8. Configuration Matrix (Public vs Bindings vs Secrets)

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
