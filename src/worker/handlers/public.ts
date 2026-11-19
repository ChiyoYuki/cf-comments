import { drainEmailOutbox, prepareEnqueueOutbox } from "../../email/outbox.ts";
import {
  ALLOWED_MFM_FUNCTIONS,
  MFM_MAX_NESTING_DEPTH,
  renderCommentContent,
} from "../../markdown/index.ts";
import { decodeCursor } from "../../shared/cursor.ts";
import { AppError, jsonResponse } from "../../shared/errors.ts";
import {
  computeAvatarHue,
  generateId,
  generateRandomToken,
  hmacSha256Hex,
} from "../../shared/id.ts";
import {
  normalizeEmail,
  normalizeHttpUrl,
  normalizePath,
} from "../../shared/path.ts";
import type {
  CommentRow,
  CommentSyntax,
  CreateCommentRequest,
  CreateCommentResponse,
  PublicConfig,
} from "../../shared/types.ts";
import {
  enforceRateLimit,
  readJsonBody,
  verifyTurnstileIfEnabled,
} from "../auth.ts";
import type { RuntimeConfig, WorkerEnv } from "../env.ts";
import {
  buildCommentThreadPage,
  buildReplyPage,
  buildVisibilityIndex,
  toPublicComment,
} from "../tree.ts";

export async function resolveCanonicalPath(
  db: D1Database,
  rawPath: string,
): Promise<string> {
  const normalized = normalizePath(rawPath);
  const alias = await db
    .prepare("SELECT canonical_path FROM path_aliases WHERE alias_path = ?")
    .bind(normalized)
    .first<{ canonical_path: string }>();
  return alias?.canonical_path ?? normalized;
}

export async function deriveUnsubscribeToken(
  secret: string,
  normalizedEmail: string,
): Promise<{ rawToken: string; tokenHash: string }> {
  const rawToken = await hmacSha256Hex(secret, `unsub-seed:${normalizedEmail}`);
  const tokenHash = await hmacSha256Hex(secret, `unsub:${rawToken}`);
  return { rawToken, tokenHash };
}

export function parseCommentSyntax(raw: unknown): CommentSyntax {
  if (raw === undefined || raw === null || raw === "") {
    return "gfm";
  }
  if (raw === "gfm" || raw === "mfm") {
    return raw;
  }
  throw new AppError(
    400,
    "VALIDATION_ERROR",
    "Field 'syntax' must be 'gfm' or 'mfm'.",
  );
}

export function handleGetConfig(cfg: RuntimeConfig): Response {
  const body: PublicConfig = {
    version: "1",
    site_url: cfg.siteUrl,
    moderation_mode: cfg.moderationMode,
    max_content_length: cfg.maxContentLength,
    allow_anonymous: true,
    allow_remote_images: true,
    allow_image_upload: false,
    reply_notify_enabled: cfg.replyEmailProvider !== "none",
    misskey_instance_url: cfg.misskeyInstanceUrl,
    markdown: {
      syntax_modes: ["gfm", "mfm"],
      default_syntax: "gfm",
      gfm: true,
      mfm: true,
      mfm_functions: ALLOWED_MFM_FUNCTIONS,
      max_nesting_depth: MFM_MAX_NESTING_DEPTH,
    },
    turnstile_site_key: cfg.turnstileSiteKey,
  };
  return jsonResponse(body, {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}

function parseIntParam(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Invalid integer parameter: ${name}.`,
    );
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Parameter ${name} must be between ${min} and ${max}.`,
    );
  }
  return value;
}

export async function handleListComments(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) {
    throw new AppError(
      400,
      "INVALID_PATH",
      "Query parameter 'path' is required.",
    );
  }

  const canonicalPath = await resolveCanonicalPath(env.DB, rawPath);
  const limit = parseIntParam(
    url.searchParams.get("limit"),
    20,
    1,
    50,
    "limit",
  );
  const replyLimit = parseIntParam(
    url.searchParams.get("reply_limit"),
    5,
    0,
    20,
    "reply_limit",
  );
  const sortRaw = url.searchParams.get("sort") || "desc";
  if (sortRaw !== "desc" && sortRaw !== "asc") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "sort must be 'desc' or 'asc'.",
    );
  }
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;

  const { results: rows } = await env.DB.prepare(
    "SELECT * FROM comments WHERE path = ?",
  )
    .bind(canonicalPath)
    .all<CommentRow>();

  const page = buildCommentThreadPage({
    path: canonicalPath,
    rows,
    limit,
    replyLimit,
    sort: sortRaw,
    cursor,
  });

  return jsonResponse(page);
}

export async function handleListReplies(
  request: Request,
  env: WorkerEnv,
  rootId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const limit = parseIntParam(
    url.searchParams.get("limit"),
    20,
    1,
    50,
    "limit",
  );
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;

  const { results: threadRows } = await env.DB.prepare(
    "SELECT * FROM comments WHERE id = ? OR root_id = ?",
  )
    .bind(rootId, rootId)
    .all<CommentRow>();

  if (threadRows.length === 0) {
    throw new AppError(404, "COMMENT_NOT_FOUND", "Comment thread not found.");
  }

  const page = buildReplyPage({ rootId, threadRows, limit, cursor });
  if (!page) {
    throw new AppError(404, "COMMENT_NOT_FOUND", "Comment thread not found.");
  }

  return jsonResponse(page);
}

export async function handlePreview(
  request: Request,
  env: WorkerEnv,
  cfg: RuntimeConfig,
): Promise<Response> {
  await enforceRateLimit(request, env, cfg, "preview");
  const body = await readJsonBody<{ content?: unknown; syntax?: unknown }>(
    request,
  );
  if (typeof body.content !== "string") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Field 'content' must be a string.",
    );
  }
  if (body.content.length > cfg.maxContentLength) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Content exceeds maximum length of ${cfg.maxContentLength} characters.`,
    );
  }
  const syntax = parseCommentSyntax(body.syntax);
  const html = renderCommentContent(body.content, syntax, {
    misskeyInstanceUrl: cfg.misskeyInstanceUrl,
  });
  return jsonResponse({ html });
}

export async function handleCreateComment(
  request: Request,
  env: WorkerEnv,
  cfg: RuntimeConfig,
  ctx: ExecutionContext,
): Promise<Response> {
  await enforceRateLimit(request, env, cfg, "submit");
  const body = await readJsonBody<CreateCommentRequest>(request);

  if (typeof body !== "object" || body === null) {
    throw new AppError(400, "INVALID_INPUT", "Invalid request payload.");
  }

  // Honeypot anti-spam trap
  if (typeof body.honeypot === "string" && body.honeypot.trim().length > 0) {
    throw new AppError(400, "SPAM_DETECTED", "Submission rejected.");
  }

  await verifyTurnstileIfEnabled(request, cfg, body.turnstile_token);

  if (typeof body.path !== "string") {
    throw new AppError(400, "INVALID_PATH", "Field 'path' is required.");
  }
  const canonicalPath = await resolveCanonicalPath(env.DB, body.path);

  if (typeof body.content !== "string") {
    throw new AppError(400, "VALIDATION_ERROR", "Field 'content' is required.");
  }
  const contentMarkdown = body.content.trim();
  if (!contentMarkdown) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Comment content cannot be empty.",
    );
  }
  if (contentMarkdown.length > cfg.maxContentLength) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Content exceeds maximum length of ${cfg.maxContentLength} characters.`,
    );
  }

  let authorName: string | null = null;
  if (body.author_name !== undefined && body.author_name !== null) {
    if (typeof body.author_name !== "string") {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "author_name must be a string.",
      );
    }
    const trimmed = body.author_name.trim();
    if (trimmed.length > 80) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "author_name exceeds 80 characters.",
      );
    }
    authorName = trimmed || null;
  }

  const authorEmail = normalizeEmail(body.author_email);
  const authorUrl = normalizeHttpUrl(body.author_url);
  const notifyOnReply = Boolean(body.notify_on_reply && authorEmail);
  const syntax = parseCommentSyntax(body.syntax);

  let parentId: string | null = null;
  let rootId: string | null = null;
  let parentRow: CommentRow | null = null;

  if (
    body.parent_id !== undefined &&
    body.parent_id !== null &&
    body.parent_id !== ""
  ) {
    if (typeof body.parent_id !== "string") {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "parent_id must be a string.",
      );
    }
    parentId = body.parent_id.trim();

    const directParent = await env.DB.prepare(
      "SELECT * FROM comments WHERE id = ?",
    )
      .bind(parentId)
      .first<CommentRow>();

    if (!directParent) {
      throw new AppError(404, "PARENT_NOT_FOUND", "Parent comment not found.");
    }
    if (directParent.path !== canonicalPath) {
      throw new AppError(
        400,
        "PARENT_PATH_MISMATCH",
        "Parent comment belongs to a different page path.",
      );
    }

    // Verify parent is publicly visible & approved (not blocked by a pending ancestor)
    const threadRootId = directParent.root_id ?? directParent.id;
    const { results: threadRows } = await env.DB.prepare(
      "SELECT * FROM comments WHERE id = ? OR root_id = ?",
    )
      .bind(threadRootId, threadRootId)
      .all<CommentRow>();
    const vis = buildVisibilityIndex(threadRows);
    if (!vis.visibleApproved.has(directParent.id)) {
      throw new AppError(404, "PARENT_NOT_FOUND", "Parent comment not found.");
    }

    parentRow = directParent;
    rootId = threadRootId;
  }

  const now = new Date().toISOString();
  const id = generateId();
  const status = cfg.moderationMode === "post" ? "approved" : "pending";
  const contentHtml = renderCommentContent(contentMarkdown, syntax, {
    misskeyInstanceUrl: cfg.misskeyInstanceUrl,
  });
  const avatarHue = computeAvatarHue(authorName);
  const origin = new URL(request.url).origin;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO comments
       (id, path, parent_id, root_id, status, author_name, author_email, author_url,
        avatar_hue, is_admin, notify_on_reply, syntax, content_markdown, content_html,
        import_source, import_external_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).bind(
      id,
      canonicalPath,
      parentId,
      rootId,
      status,
      authorName,
      authorEmail,
      authorUrl,
      avatarHue,
      notifyOnReply ? 1 : 0,
      syntax,
      contentMarkdown,
      contentHtml,
      now,
      now,
    ),
  ];

  // 1. Admin new comment alert
  if (cfg.adminEmailProvider !== "none" && cfg.adminNotifyEmail) {
    statements.push(
      prepareEnqueueOutbox(env.DB, {
        dedupeKey: `admin_new:${id}`,
        kind: "admin_new_comment",
        recipientEmail: cfg.adminNotifyEmail,
        payload: {
          comment_id: id,
          path: canonicalPath,
          status,
          author_name: authorName,
          content_markdown: contentMarkdown,
          site_url: cfg.siteUrl,
          admin_url: `${origin}/admin/`,
        },
        nowIso: now,
      }),
    );
  }

  // 2. Visitor double-opt-in verification email (only if notify_on_reply requested & reply provider enabled)
  let verificationQueued = false;
  if (notifyOnReply && authorEmail && cfg.replyEmailProvider !== "none") {
    const existingSub = await env.DB.prepare(
      "SELECT email_normalized, status FROM email_subscriptions WHERE email_normalized = ?",
    )
      .bind(authorEmail)
      .first<{ email_normalized: string; status: string }>();

    if (!existingSub || existingSub.status === "pending") {
      const verifyToken = generateRandomToken();
      const verifyTokenHash = await hmacSha256Hex(
        cfg.tokenSigningSecret,
        `verify:${verifyToken}`,
      );
      const { rawToken: unsubToken, tokenHash: unsubTokenHash } =
        await deriveUnsubscribeToken(cfg.tokenSigningSecret, authorEmail);

      const verifyTokenExpiresAt = new Date(
        Date.now() + 48 * 60 * 60 * 1000,
      ).toISOString();
      statements.push(
        env.DB.prepare(
          `INSERT INTO email_subscriptions
           (email_normalized, status, verify_token_hash, verify_token_expires_at, unsubscribe_token_hash, verified_at, created_at, updated_at)
           VALUES (?, 'pending', ?, ?, ?, NULL, ?, ?)
           ON CONFLICT(email_normalized) DO UPDATE SET
             verify_token_hash = excluded.verify_token_hash,
             verify_token_expires_at = excluded.verify_token_expires_at,
             unsubscribe_token_hash = excluded.unsubscribe_token_hash,
             updated_at = excluded.updated_at`,
        ).bind(
          authorEmail,
          verifyTokenHash,
          verifyTokenExpiresAt,
          unsubTokenHash,
          now,
          now,
        ),
      );

      const dayBucket = now.slice(0, 10);
      const emailKey = await hmacSha256Hex(cfg.tokenSigningSecret, authorEmail);
      statements.push(
        prepareEnqueueOutbox(env.DB, {
          dedupeKey: `verify:${emailKey}:${dayBucket}`,
          kind: "verify_email",
          recipientEmail: authorEmail,
          payload: {
            site_url: cfg.siteUrl,
            verify_url: `${origin}/v1/subscriptions/verify?token=${encodeURIComponent(verifyToken)}`,
            unsubscribe_url: `${origin}/v1/subscriptions/unsubscribe?token=${encodeURIComponent(unsubToken)}`,
          },
          nowIso: now,
        }),
      );
      verificationQueued = true;
    }
  }

  // 3. Immediate reply notification if moderationMode=post (approved immediately)
  if (
    status === "approved" &&
    parentRow &&
    parentRow.notify_on_reply === 1 &&
    parentRow.author_email &&
    parentRow.author_email !== authorEmail &&
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

  let publicComment = null;
  if (status === "approved") {
    const createdRow: CommentRow = {
      id,
      path: canonicalPath,
      parent_id: parentId,
      root_id: rootId,
      status: "approved",
      author_name: authorName,
      author_email: authorEmail,
      author_url: authorUrl,
      avatar_hue: avatarHue,
      is_admin: 0,
      notify_on_reply: notifyOnReply ? 1 : 0,
      syntax,
      content_markdown: contentMarkdown,
      content_html: contentHtml,
      import_source: null,
      import_external_id: null,
      created_at: now,
      updated_at: now,
    };
    const vis = buildVisibilityIndex(
      parentRow ? [parentRow, createdRow] : [createdRow],
    );
    publicComment = toPublicComment(createdRow, vis);
  }

  const responseBody: CreateCommentResponse = {
    id,
    path: canonicalPath,
    parent_id: parentId,
    root_id: rootId,
    status,
    verification_queued: verificationQueued,
    comment: publicComment,
  };

  return jsonResponse(responseBody, {
    status: status === "approved" ? 201 : 202,
  });
}
