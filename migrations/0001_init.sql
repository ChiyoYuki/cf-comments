-- cf-comments v1 initial schema for Cloudflare D1 (SQLite)

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  parent_id TEXT REFERENCES comments(id),
  root_id TEXT REFERENCES comments(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('approved', 'pending', 'hidden', 'spam', 'deleted')),
  author_name TEXT,
  author_email TEXT,
  author_url TEXT,
  avatar_hue INTEGER NOT NULL DEFAULT 220,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  notify_on_reply INTEGER NOT NULL DEFAULT 0 CHECK (notify_on_reply IN (0, 1)),
  syntax TEXT NOT NULL DEFAULT 'gfm' CHECK (syntax IN ('gfm', 'mfm')),
  content_markdown TEXT,
  content_html TEXT,
  import_source TEXT,
  import_external_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Stable cursor pagination for root comments on a page
CREATE INDEX IF NOT EXISTS idx_comments_path_root_created
  ON comments(path, root_id, created_at DESC, id DESC);

-- Stable cursor pagination for replies within a root thread
CREATE INDEX IF NOT EXISTS idx_comments_root_created
  ON comments(root_id, created_at ASC, id ASC)
  WHERE root_id IS NOT NULL;

-- Lookup direct children when checking visibility or parent references
CREATE INDEX IF NOT EXISTS idx_comments_parent_id
  ON comments(parent_id)
  WHERE parent_id IS NOT NULL;

-- Admin moderation filtering by status and recency
CREATE INDEX IF NOT EXISTS idx_comments_status_created
  ON comments(status, created_at DESC, id DESC);

-- Idempotent imports from external comment systems (e.g. waline)
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_import_source_ext
  ON comments(import_source, import_external_id)
  WHERE import_source IS NOT NULL AND import_external_id IS NOT NULL;

-- Explicit legacy path aliases (e.g., old URL -> canonical path)
CREATE TABLE IF NOT EXISTS path_aliases (
  alias_path TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_path_aliases_canonical
  ON path_aliases(canonical_path);

-- Double opt-in visitor email subscriptions for reply notifications
CREATE TABLE IF NOT EXISTS email_subscriptions (
  email_normalized TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'unsubscribed')),
  verify_token_hash TEXT,
  unsubscribe_token_hash TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_subscriptions_verify_token
  ON email_subscriptions(verify_token_hash)
  WHERE verify_token_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_subscriptions_unsub_token
  ON email_subscriptions(unsubscribe_token_hash);

-- Transactional email outbox for reliable, deduplicated delivery with bounded retries
CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL
    CHECK (kind IN ('admin_new_comment', 'reply_approved', 'verify_email')),
  recipient_email TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_pending
  ON email_outbox(status, next_attempt_at ASC)
  WHERE status = 'pending';
