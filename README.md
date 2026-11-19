# cf-comments

English · [简体中文](README.zh-CN.md)

A lightweight, self-hosted comment system for blogs and static sites. One Cloudflare Worker and one D1 database serve the API, an embeddable Web Component, and a moderation console. Your site stays on its existing host.

- Anonymous comments, nested replies, cursor pagination, and moderation.
- GitHub Flavored Markdown (GFM) or Misskey Markup Language (MFM), with live preview rendered in the browser. GFM can embed remote images; image uploads are not supported.
- Framework-free Material 3 widget with light/dark themes, SPA support, and optional Gravatar avatars and Misskey custom emoji.
- Site-owner alerts, verified email notifications for direct replies, JSON backups, and Waline migration.

## Quick start

Use Node.js 24, pnpm (see `package.json`), and Cloudflare `cf` CLI 0.15.0. Follow the [deployment guide](docs/deployment.md) to set up a new D1 database or connect an existing Worker to GitHub Actions. Copy the [site settings template](cf-comments.config.example.json) to `cf-comments.config.json` and the [secrets template](.env.example) to `.dev.vars`. Keep both local files out of Git.

## Embed comments

```html
<script type="module" src="https://comments.example.com/assets/v1/comments.js"></script>
<cf-comments api-base="https://comments.example.com" path="/about/" lang="en"></cf-comments>
```

Add the embedding site's exact origin to `allowedOrigins`. Use a stable, site-relative `path` with a trailing slash to identify the discussion. In an SPA, load the module once outside the replaceable container. Set `reply-limit="0"` to defer loading replies. The widget supports English and Simplified Chinese and exposes theme tokens such as `--cc-accent`, `--cc-surface`, and `--cc-page` on the host.

## Moderation and privacy

Open `/admin/` on the Worker domain and unlock it with `ADMIN_TOKEN`, which stays in memory. The console does not load remote media by default. Gravatar is off by default; when enabled, public avatar URLs contain a deterministic email hash that can be matched across sites. If an avatar is missing or unavailable, the widget shows the first character of the nickname instead.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
```

- `src/client/`, `src/admin/`, `src/styles/`: reader widget, moderation console, and shared styles.
- `src/worker/`, `src/markdown/`, `src/email/`: API, shared rendering pipeline, and notifications.
- `src/config/`, `src/importers/`, `src/shared/`: configuration, migration adapters, and shared utilities.
- `scripts/`, `migrations/`, `tests/`: build and import tools, D1 schema, and regression tests.

## Documentation

- [Deployment and GitHub Actions](docs/deployment.md)
- [Backups and Waline migration](docs/migration.md)
- [Runtime behavior and configuration](docs/spec.md) · [OpenAPI 3.1](docs/openapi.yaml) · [Export JSON Schema](schemas/export.schema.json)
- [Maintainer handoff (中文)](docs/agent-handoff.md)
