# Backups and Waline migration

## Back up or restore cf-comments

Open `/admin/` on your Worker and unlock it with the admin token. Download a [canonical JSON backup](../schemas/export.schema.json) from the import/export section. The default backup omits email addresses but can contain unpublished comments: keep it private. Include email addresses only when needed for a private transfer. Imports do not opt anyone into reply notifications.

Use **试跑导入** (dry-run import) first. Review how many records would be inserted, skipped, or rejected before applying. The [API contract](openapi.yaml) documents `/v1/admin/export` and `/v1/admin/import` for automation.

## Import from Waline

1. Keep the raw Waline export outside Git. It may contain visitor emails, IP addresses, or account data. Check that the resulting paths match the widget's `path` values.
2. Convert and reconcile locally. The first command only reports results; choose a private destination for the second:

   ```sh
   pnpm run import:waline -- --input /path/to/waline.json --dry-run
   pnpm run import:waline -- --input /path/to/waline.json --out /path/to/canonical.json
   ```

   Use `--skip-paths=/` only if you intend to exclude home-page comments. The converter preserves reply relationships and normalizes legacy Waline emoji images. Visitor email addresses are omitted unless `--include-private` is set.
3. Dry-run the converted JSON in `/admin/`, then import it. Repeated imports skip already-imported records by their stable source identifiers. Disable writes on the old comment service before running a final delta dry-run/import so transitional comments are not missed; keep the old database and raw backup until verified.

### Optional historical Gravatar backfill

For migrated comments whose email addresses were omitted, `pnpm run backfill:waline-avatars -- --input /path/to/waline.json` reports local counts. For a remote dry run, supply `--api-base` with the Worker URL and set `ADMIN_TOKEN` locally (or pass `--token-file` pointing to a private file). Use the same `--skip-paths` options as the import. Emails are hashed to SHA-256 strictly in local memory and are never transmitted to the Worker; the server endpoint (`POST /v1/admin/avatars/backfill?dry_run=true|false`) only updates `approved` comments whose `avatar_hash` is currently `NULL`. Only add `--apply` after reviewing the report and deciding that historical avatar hashes may be made public. Backfill does not restore raw email addresses or enable reply subscriptions.
