# cf-comments

Lightweight, self-hosted, general-purpose comment system built on Cloudflare Workers and D1.

## Highlights

- **Single-instance Worker + D1**: Zero external database dependencies, deployed with Cloudflare `cf` CLI (`cloudflare.config.ts`).
- **Threaded discussions**: Root threads with paginated nested replies ("楼中楼"), deterministic cursor pagination, and privacy-preserving placeholder nodes for hidden/deleted parent comments.
- **GFM + MFM Markdown**: Full GitHub Flavored Markdown plus safe, instance-independent Misskey Flavored Markdown enhancements (`$[blur]`, `$[fg]`, `$[flip]`, etc.) with strict HTML allowlist sanitization, remote `http(s)` images only, and no file uploads.
- **Moderation & Anti-spam**: Pre-moderation by default, honeypot, rate limiting, optional Turnstile verification, same-origin `/admin/` moderation console, and server-granted admin badges.
- **Dual Email Notifications**: Independent providers for admin alerts (Cloudflare Email Routing `send_email` binding or HTTP API) and double-opt-in visitor reply notifications (Resend or generic HTTPS email endpoint), backed by a transactional D1 outbox.
- **Portable Data**: Canonical JSON import/export format with pluggable adapters (starting with Waline migration).
- **Material Design 3 Frontend**: Embeddable, framework-agnostic widget following Material Design 3 tokens with dark mode and SPA (Swup) lifecycle support.

## Contract & Specifications (v1)

- [Frozen v1 Specification](docs/spec.md)
- [OpenAPI 3.1 Contract](docs/openapi.yaml)
- [Standard Export JSON Schema](schemas/export.schema.json)
- [Initial D1 Migration](migrations/0001_init.sql)
- [Sanitized Response Fixtures](docs/fixtures/)
