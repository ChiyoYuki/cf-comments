import { drainEmailOutbox, prepareEnqueueOutbox } from "../../email/outbox.ts";
import {
  exportCanonicalFromDb,
  importCanonicalToDb,
} from "../../importers/canonical.ts";
import { renderCommentContent } from "../../markdown/index.ts";
import { decodeCursor, encodeCursor } from "../../shared/cursor.ts";
import { AppError, jsonResponse } from "../../shared/errors.ts";
import {
  AVATAR_HASH_RE,
  computeAvatarHue,
  generateId,
  sha256Hex,
} from "../../shared/id.ts";
import {
  normalizeEmail,
  normalizeHttpUrl,
  normalizePath,
} from "../../shared/path.ts";
import type {
  AdminAvatarBackfillReport,
  AdminAvatarBackfillRequest,
  AdminCommentCounts,
  AdminCommentPage,
  AdminCreateCommentRequest,
  AdminUpdateCommentRequest,
  CommentRow,
  CommentStatus,
} from "../../shared/types.ts";
import { readJsonBody, requireAdminAuth } from "../auth.ts";
import type { RuntimeConfig, WorkerEnv } from "../env.ts";
import { toAdminComment } from "../tree.ts";
import {
  deriveUnsubscribeToken,
  parseCommentSyntax,
  resolveCanonicalPath,
} from "./public.ts";

const VALID_STATUSES = new Set<CommentStatus>([
  "approved",
  "pending",
  "hidden",
  "spam",
  "deleted",
]);

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function handleAdminListComments(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  requireAdminAuth(request, env);

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  if (statusParam && !VALID_STATUSES.has(statusParam as CommentStatus)) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid status filter.");
  }

  const pathParam = url.searchParams.get("path");
  const normalizedPath = pathParam ? normalizePath(pathParam) : null;

  const qParam = url.searchParams.get("q")?.trim() || null;
  if (qParam && qParam.length > 120) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Search query exceeds 120 chars.",
    );
  }

  const limitRaw = url.searchParams.get("limit");
  let limit = 30;
  if (limitRaw !== null && limitRaw !== "") {
    if (!/^\d+$/.test(limitRaw)) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid limit.");
    }
    limit = Number.parseInt(limitRaw, 10);
    if (limit < 1 || limit > 100) {
      throw new AppError(400, "VALIDATION_ERROR", "limit must be 1..100.");
    }
  }

  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;

  const whereClauses: string[] = [];
  const binds: unknown[] = [];

  if (statusParam) {
    whereClauses.push("status = ?");
    binds.push(statusParam);
  }
  if (normalizedPath) {
    whereClauses.push("path = ?");
    binds.push(normalizedPath);
  }
  if (qParam) {
    const likePattern = `%${qParam}%`;
    whereClauses.push(
      "(author_name LIKE ? OR content_markdown LIKE ? OR path LIKE ?)",
    );
    binds.push(likePattern, likePattern, likePattern);
  }
  if (cursor) {
    whereClauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
    binds.push(cursor.t, cursor.t, cursor.id);
  }

  const whereSql =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM comments ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ?`;
  binds.push(limit + 1);

  const { results: rows } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<CommentRow>();

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows[pageRows.length - 1];

  const { results: countRows } = await env.DB.prepare(
    "SELECT status, COUNT(*) AS cnt FROM comments GROUP BY status",
  ).all<{ status: CommentStatus; cnt: number }>();

  const counts: AdminCommentCounts = {
    approved: 0,
    pending: 0,
    hidden: 0,
    spam: 0,
    deleted: 0,
  };
  for (const row of countRows) {
    if (row.status in counts) {
      counts[row.status] = Number(row.cnt);
    }
  }

  const page: AdminCommentPage = {
    items: pageRows.map(toAdminComment),
    counts,
    next_cursor:
      hasMore && lastRow
        ? encodeCursor({ t: lastRow.created_at, id: lastRow.id })
        : null,
  };

  return jsonResponse(page, { headers: NO_STORE_HEADERS });
}

export async function handleAdminCreateComment(
  request: Request,
  env: WorkerEnv,
  cfg: RuntimeConfig,
  ctx: ExecutionContext,
): Promise<Response> {
  requireAdminAuth(request, env);

  const body = await readJsonBody<AdminCreateCommentRequest>(request);
  if (typeof body.path !== "string") {
    throw new AppError(400, "INVALID_PATH", "Field 'path' is required.");
  }
  const canonicalPath = await resolveCanonicalPath(env.DB, body.path);

  if (typeof body.content !== "string" || !body.content.trim()) {
    throw new AppError(400, "VALIDATION_ERROR", "Comment content is required.");
  }
  const contentMarkdown = body.content.trim();
  if (contentMarkdown.length > 10000) {
    throw new AppError(400, "VALIDATION_ERROR", "Content exceeds 10000 chars.");
  }

  const authorName =
    typeof body.author_name === "string" && body.author_name.trim()
      ? body.author_name.trim().slice(0, 80)
      : "Admin";
  const authorUrl = normalizeHttpUrl(body.author_url);

  let parentId: string | null = null;
  let rootId: string | null = null;
  let parentRow: CommentRow | null = null;

  if (body.parent_id) {
    parentId = body.parent_id.trim();
    parentRow = await env.DB.prepare("SELECT * FROM comments WHERE id = ?")
      .bind(parentId)
      .first<CommentRow>();
    if (!parentRow) {
      throw new AppError(404, "PARENT_NOT_FOUND", "Parent comment not found.");
    }
    if (parentRow.path !== canonicalPath) {
      throw new AppError(
        400,
        "PARENT_PATH_MISMATCH",
        "Parent comment belongs to a different page path.",
      );
    }
    rootId = parentRow.root_id ?? parentRow.id;
  }

  const id = generateId();
  const now = new Date().toISOString();
  const syntax = parseCommentSyntax(body.syntax);
  const contentHtml = renderCommentContent(contentMarkdown, syntax, {
    misskeyInstanceUrl: cfg.misskeyInstanceUrl,
  });
  const avatarHue = computeAvatarHue(authorName);
  const adminEmail = normalizeEmail(cfg.adminNotifyEmail);
  const avatarHash = adminEmail ? await sha256Hex(adminEmail) : null;
  const origin = new URL(request.url).origin;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO comments
       (id, path, parent_id, root_id, status, author_name, author_email, author_url,
        avatar_hue, avatar_hash, is_admin, notify_on_reply, syntax, content_markdown, content_html,
        import_source, import_external_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).bind(
      id,
      canonicalPath,
      parentId,
      rootId,
      authorName,
      adminEmail,
      authorUrl,
      avatarHue,
      avatarHash,
      syntax,
      contentMarkdown,
      contentHtml,
      now,
      now,
    ),
  ];

  if (
    parentRow &&
    parentRow.notify_on_reply === 1 &&
    parentRow.author_email &&
    parentRow.author_email !== cfg.adminNotifyEmail &&
    cfg.replyEmailProvider !== "none"
  ) {
    const parentSub = await env.DB.prepare(
      "SELECT status FROM email_subscriptions WHERE email_normalized = ?",
    )
      .bind(parentRow.author_email)
      .first<{ status: string }>();

    if (parentSub?.status === "verified") {
      const { rawToken: unsubToken } = await deriveUnsubscribeToken(
        cfg.tokenSigningSecret,
        parentRow.author_email,
      );
      statements.push(
        prepareEnqueueOutbox(env.DB, {
          dedupeKey: `reply:${id}`,
          kind: "reply_approved",
          recipientEmail: parentRow.author_email,
          payload: {
            reply_id: id,
            parent_id: parentRow.id,
            path: canonicalPath,
            reply_author_name: authorName,
            reply_content_markdown: contentMarkdown,
            site_url: cfg.siteUrl,
            unsubscribe_url: `${origin}/v1/subscriptions/unsubscribe?token=${encodeURIComponent(unsubToken)}`,
          },
          nowIso: now,
        }),
      );
    }
  }

  await env.DB.batch(statements);
  if (statements.length > 1) {
    ctx.waitUntil(drainEmailOutbox(env).catch(() => undefined));
  }

  const created = await env.DB.prepare("SELECT * FROM comments WHERE id = ?")
    .bind(id)
    .first<CommentRow>();
  if (!created) {
    throw new AppError(
      500,
      "INTERNAL_ERROR",
      "Failed to read created comment.",
    );
  }

  return jsonResponse(
    { comment: toAdminComment(created) },
    { status: 201, headers: NO_STORE_HEADERS },
  );
}

export async function handleAdminUpdateComment(
  request: Request,
  env: WorkerEnv,
  cfg: RuntimeConfig,
  ctx: ExecutionContext,
  id: string,
): Promise<Response> {
  requireAdminAuth(request, env);

  const body = await readJsonBody<AdminUpdateCommentRequest>(request);
  if (
    typeof body !== "object" ||
    body === null ||
    typeof body.status !== "string" ||
    !VALID_STATUSES.has(body.status)
  ) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Field 'status' is required and must be a valid comment status.",
    );
  }

  const existing = await env.DB.prepare("SELECT * FROM comments WHERE id = ?")
    .bind(id)
    .first<CommentRow>();

  if (!existing) {
    throw new AppError(404, "COMMENT_NOT_FOUND", "Comment not found.");
  }

  // `deleted` is irreversible
  if (existing.status === "deleted" && body.status !== "deleted") {
    throw new AppError(
      409,
      "INVALID_STATE_TRANSITION",
      "Deleted comments cannot be restored to another status.",
    );
  }

  if (body.hard_delete === true) {
    if (body.status !== "deleted") {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "hard_delete is only allowed when status is 'deleted'.",
      );
    }
    const childCount = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM comments WHERE parent_id = ?",
    )
      .bind(id)
      .first<{ cnt: number }>();

    if ((childCount?.cnt ?? 0) > 0) {
      throw new AppError(
        409,
        "HAS_CHILD_COMMENTS",
        "Cannot hard-delete a comment that has child replies; use soft delete instead.",
      );
    }

    await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
    return new Response(null, { status: 204, headers: NO_STORE_HEADERS });
  }

  const now = new Date().toISOString();

  if (body.status === "deleted") {
    await env.DB.prepare(
      `UPDATE comments
       SET status = 'deleted',
           author_name = NULL,
           author_email = NULL,
           author_url = NULL,
           avatar_hash = NULL,
           is_admin = 0,
           notify_on_reply = 0,
           content_markdown = NULL,
           content_html = NULL,
           updated_at = ?
       WHERE id = ?`,
    )
      .bind(now, id)
      .run();
  } else {
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        "UPDATE comments SET status = ?, updated_at = ? WHERE id = ?",
      ).bind(body.status, now, id),
    ];

    // Enqueue reply notification atomically if transitioning into `approved`
    if (
      body.status === "approved" &&
      existing.status !== "approved" &&
      existing.parent_id &&
      existing.import_source === null &&
      cfg.replyEmailProvider !== "none"
    ) {
      const parentRow = await env.DB.prepare(
        "SELECT * FROM comments WHERE id = ?",
      )
        .bind(existing.parent_id)
        .first<CommentRow>();

      if (
        parentRow &&
        parentRow.notify_on_reply === 1 &&
        parentRow.author_email &&
        parentRow.author_email !== existing.author_email
      ) {
        const parentSub = await env.DB.prepare(
          "SELECT status FROM email_subscriptions WHERE email_normalized = ?",
        )
          .bind(parentRow.author_email)
          .first<{ status: string }>();

        if (parentSub?.status === "verified") {
          const origin = new URL(request.url).origin;
          const { rawToken: unsubToken } = await deriveUnsubscribeToken(
            cfg.tokenSigningSecret,
            parentRow.author_email,
          );
          statements.push(
            prepareEnqueueOutbox(env.DB, {
              dedupeKey: `reply:${existing.id}`,
              kind: "reply_approved",
              recipientEmail: parentRow.author_email,
              payload: {
                reply_id: existing.id,
                parent_id: parentRow.id,
                path: existing.path,
                reply_author_name: existing.author_name,
                reply_content_markdown: existing.content_markdown ?? "",
                site_url: cfg.siteUrl,
                unsubscribe_url: `${origin}/v1/subscriptions/unsubscribe?token=${encodeURIComponent(unsubToken)}`,
              },
              nowIso: now,
            }),
          );
        }
      }
    }

    await env.DB.batch(statements);
    if (statements.length > 1) {
      ctx.waitUntil(drainEmailOutbox(env).catch(() => undefined));
    }
  }

  const updated = await env.DB.prepare("SELECT * FROM comments WHERE id = ?")
    .bind(id)
    .first<CommentRow>();
  if (!updated) {
    throw new AppError(404, "COMMENT_NOT_FOUND", "Comment not found.");
  }

  return jsonResponse(
    { comment: toAdminComment(updated) },
    { headers: NO_STORE_HEADERS },
  );
}

export async function handleAdminExport(
  request: Request,
  env: WorkerEnv,
  cfg: RuntimeConfig,
): Promise<Response> {
  requireAdminAuth(request, env);
  const url = new URL(request.url);
  const includePrivate = url.searchParams.get("include_private") === "true";

  const payload = await exportCanonicalFromDb(env.DB, {
    includePrivate,
    siteUrl: cfg.siteUrl,
  });

  return jsonResponse(payload, { headers: NO_STORE_HEADERS });
}

export async function handleAdminImport(
  request: Request,
  env: WorkerEnv,
  cfg: RuntimeConfig,
): Promise<Response> {
  requireAdminAuth(request, env);
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry_run") === "true";
  const body = await readJsonBody<unknown>(request, 5 * 1024 * 1024);

  const report = await importCanonicalToDb(env.DB, body, {
    dryRun,
    misskeyInstanceUrl: cfg.misskeyInstanceUrl,
  });
  return jsonResponse(report, { headers: NO_STORE_HEADERS });
}

export async function handleAdminBackfillAvatars(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  requireAdminAuth(request, env);
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry_run") === "true";
  const body = await readJsonBody<AdminAvatarBackfillRequest>(
    request,
    2 * 1024 * 1024,
  );

  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray(body.items) ||
    body.items.length > 5000
  ) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Field 'items' must be an array of at most 5000 backfill entries.",
    );
  }

  const normalizedItems: Array<{
    key: string;
    avatarHash: string;
  }> = [];
  const seenKeys = new Set<string>();

  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i] as unknown;
    if (typeof item !== "object" || item === null) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `items[${i}] must be an object.`,
      );
    }
    const entry = item as Record<string, unknown>;
    const source =
      typeof entry.import_source === "string" ? entry.import_source.trim() : "";
    const externalId =
      typeof entry.import_external_id === "string"
        ? entry.import_external_id.trim()
        : "";
    const avatarHash =
      typeof entry.avatar_hash === "string" ? entry.avatar_hash.trim() : "";

    if (!source || !externalId || !AVATAR_HASH_RE.test(avatarHash)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `items[${i}] must provide import_source, import_external_id, and a 64-char lowercase hex SHA-256 avatar_hash.`,
      );
    }
    const key = `${source}:${externalId}`;
    if (seenKeys.has(key)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Duplicate backfill key in request: ${key}.`,
      );
    }
    seenKeys.add(key);
    normalizedItems.push({ key, avatarHash });
  }

  const { results: rows } = await env.DB.prepare(
    `SELECT id, status, avatar_hash, import_source, import_external_id
     FROM comments
     WHERE import_source IS NOT NULL AND import_external_id IS NOT NULL`,
  ).all<{
    id: string;
    status: CommentStatus;
    avatar_hash: string | null;
    import_source: string;
    import_external_id: string;
  }>();

  const rowBySourceKey = new Map<
    string,
    { id: string; status: CommentStatus; avatar_hash: string | null }
  >();
  for (const row of rows) {
    rowBySourceKey.set(`${row.import_source}:${row.import_external_id}`, {
      id: row.id,
      status: row.status,
      avatar_hash: row.avatar_hash,
    });
  }

  let updated = 0;
  let skippedAlreadySet = 0;
  let skippedNonPublic = 0;
  let unmatched = 0;
  const statements: D1PreparedStatement[] = [];

  for (const item of normalizedItems) {
    const target = rowBySourceKey.get(item.key);
    if (!target) {
      unmatched++;
      continue;
    }
    if (target.status !== "approved") {
      skippedNonPublic++;
      continue;
    }
    if (target.avatar_hash) {
      skippedAlreadySet++;
      continue;
    }
    updated++;
    statements.push(
      env.DB.prepare(
        `UPDATE comments
         SET avatar_hash = ?
         WHERE id = ? AND status = 'approved' AND avatar_hash IS NULL`,
      ).bind(item.avatarHash, target.id),
    );
  }

  if (!dryRun && statements.length > 0) {
    await env.DB.batch(statements);
  }

  const report: AdminAvatarBackfillReport = {
    dry_run: dryRun,
    total: normalizedItems.length,
    updated,
    skipped_already_set: skippedAlreadySet,
    skipped_non_public: skippedNonPublic,
    unmatched,
  };
  return jsonResponse(report, { headers: NO_STORE_HEADERS });
}
