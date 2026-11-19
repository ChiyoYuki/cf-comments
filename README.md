# cf-comments

Lightweight, self-hosted, general-purpose comment system built on Cloudflare Workers and D1.

Supports threaded discussions, GFM/MFM, moderation, reply notifications, and JSON import/export. The native Web Component follows Material Design 3 and supports light/dark themes and SPA navigation.

## Quick Configuration

1. Copy `cf-comments.config.example.json` to `cf-comments.config.json` and fill in your site/domain/D1/Misskey/email settings (ignored by Git).
2. Copy `.env.example` to `.dev.vars` for local secrets (ignored by Git).
3. Run `pnpm install`, `pnpm run test`, and `pnpm run build`. Deployment requirements and configuration are listed in the [v1 specification](docs/spec.md).

For GitHub Actions, see [Production deployment](docs/deployment.md).

## Browser Integration

```html
<script type="module" src="https://comments.example.com/assets/v1/comments.js"></script>
<cf-comments api-base="https://comments.example.com" path="/about/" lang="en"></cf-comments>
```

Include the embedding site's exact origin in `allowedOrigins` and pass the canonical page path. In an SPA, load the module once outside the replaceable container. Set `reply-limit="0"` to load replies on demand. The widget supports English and Chinese and accepts `--cc-color-scheme`, `--cc-accent`, `--cc-on-accent`, `--cc-card`, `--cc-surface`, and `--cc-page` on the host.

Open `/admin/` on the Worker origin and unlock it with `ADMIN_TOKEN`; the token stays in memory.

## Repository Layout

- `src/client/`, `src/admin/`: reader widget and moderation console; common styling lives in `src/styles/`.
- `src/worker/`, `src/markdown/`, `src/email/`: API, shared rendering pipeline, and notifications.
- `src/config/`, `src/importers/`, `src/shared/`: configuration, migration adapters, and common utilities.
- `scripts/`, `migrations/`, `tests/`: build/import tools, D1 schema, and regression tests with local fixtures.

## Contract & Specifications (v1)

- [v1 Specification](docs/spec.md)
- [OpenAPI 3.1 Contract](docs/openapi.yaml)
- [Standard Export JSON Schema](schemas/export.schema.json)
- [Initial D1 Migration](migrations/0001_init.sql)
- [Work Log](docs/agent-worklog/README.md)
