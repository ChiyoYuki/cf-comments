# cf-comments

Lightweight, self-hosted, general-purpose comment system built on Cloudflare Workers and D1.

## Highlights

- **Single-instance Worker + D1**: Zero external database dependencies, deployed with Cloudflare `cf` CLI (`cloudflare.config.ts`) and unified local configuration (`cf-comments.config.json` + env overrides).
- **Threaded discussions**: Root threads with paginated nested replies ("楼中楼"), deterministic cursor pagination, and privacy-preserving placeholder nodes for hidden/deleted parent comments.
- **Official Dual-Syntax Markdown (`gfm` | `mfm`)**:
  - `gfm`: Pure official `unified` + `remark-gfm` + `rehype-sanitize` pipeline with remote `http(s)` image links (no image uploads).
  - `mfm`: Pure official `mfm-js` AST parser + `rehype-sanitize` with optional `MISSKEY_INSTANCE_URL` support (`@mention`, `#hashtag`, and zero-server-cache client-side `:emoji:` resolution).
- **Moderation & Anti-spam**: Pre-moderation by default, zero visitor account system, honeypot, rate limiting, optional Turnstile verification, same-origin `/admin/` moderation console, and server-granted admin badges.
- **Dual Email Notifications**: Independent providers for admin alerts (Cloudflare Email Routing `send_email` binding or HTTP API) and double-opt-in visitor reply notifications (Resend or generic HTTPS email endpoint), backed by a transactional D1 outbox.
- **Portable Data**: Canonical JSON import/export format with pluggable adapters (starting with Waline migration).
- **Native Material Design 3 Frontend**: Zero-framework native TypeScript + CSS Web Component following Material Design 3 tokens with dark mode and SPA (Swup) lifecycle support.

## Quick Configuration

1. Copy `cf-comments.config.example.json` to `cf-comments.config.json` and fill in your site/domain/D1/Misskey/email settings (ignored by Git).
2. Copy `.env.example` to `.dev.vars` for local secrets (ignored by Git).

## Browser Integration

Run `pnpm run build` before deploying; it bundles the widget and `/admin/` with the Worker. Use `pnpm run test:client` to test the browser-side request and thread logic.

```html
<script type="module" src="https://comments.example.com/assets/v1/comments.js"></script>
<cf-comments api-base="https://comments.example.com" path="/about/" lang="en"></cf-comments>
```

Set `ALLOWED_ORIGINS` to include the embedding site's exact origin. For SPAs, load the module once outside the replaceable container; each widget initializes on connection and aborts its requests on removal. Pass the canonical path explicitly. Use `reply-limit="0"` to load replies only on demand. The widget supports English and Chinese, follows the system color scheme by default, and accepts `--cc-color-scheme`, `--cc-accent`, `--cc-on-accent`, and `--cc-card` overrides on the host.

Open `/admin/` on the Worker origin and unlock it with `ADMIN_TOKEN`. The token is not persisted. The console blocks remote media until explicitly enabled for the current session. With a Misskey instance configured, the widget fetches emoji metadata directly from that instance; if the instance blocks cross-origin requests, the original emoji code remains visible.

## Contract & Specifications (v1)

- [Frozen v1 Specification](docs/spec.md)
- [OpenAPI 3.1 Contract](docs/openapi.yaml)
- [Standard Export JSON Schema](schemas/export.schema.json)
- [Initial D1 Migration](migrations/0001_init.sql)
- [Sanitized Response Fixtures](docs/fixtures/)
