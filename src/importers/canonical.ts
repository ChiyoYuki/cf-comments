import { renderCommentContent } from "../markdown/index.ts";
import { AppError } from "../shared/errors.ts";
import { computeAvatarHue } from "../shared/id.ts";
import {
  normalizeEmail,
  normalizeHttpUrl,
  normalizePath,
} from "../shared/path.ts";
import type {
  CanonicalExport,
  CommentRow,
  CommentStatus,
  CommentSyntax,
  ExportComment,
  ExportPathAlias,
  ImportReport,
} from "../shared/types.ts";

const VALID_STATUSES = new Set<CommentStatus>([
  "approved",
  "pending",
  "hidden",
  "spam",
  "deleted",
]);
const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

export function validateCanonicalExport(raw: unknown): CanonicalExport {
  if (typeof raw !== "object" || raw === null) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Export payload must be an object.",
    );
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== "cf-comments" || obj.version !== 1) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Unsupported export format or version (expected cf-comments v1).",
    );
  }
  if (
    typeof obj.exported_at !== "string" ||
    Number.isNaN(Date.parse(obj.exported_at))
  ) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Invalid exported_at timestamp.",
    );
  }
  if (typeof obj.include_private !== "boolean") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "include_private must be a boolean.",
    );
  }
  if (!Array.isArray(obj.comments)) {
    throw new AppError(400, "VALIDATION_ERROR", "comments must be an array.");
  }

  const includePrivate = obj.include_private;
  const seenIds = new Set<string>();
  const validatedComments: ExportComment[] = [];

  for (let i = 0; i < obj.comments.length; i++) {
    const item = obj.comments[i];
    if (typeof item !== "object" || item === null) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `comments[${i}] must be an object.`,
      );
    }
    const c = item as Record<string, unknown>;

    if (typeof c.id !== "string" || !ID_RE.test(c.id)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `comments[${i}].id is invalid.`,
      );
    }
    if (seenIds.has(c.id)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Duplicate comment id: ${c.id}.`,
      );
    }
    seenIds.add(c.id);

    if (typeof c.path !== "string") {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `comments[${i}].path must be a string.`,
      );
    }
    const normalizedPath = normalizePath(c.path);
    if (normalizedPath !== c.path) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `comments[${i}].path must be canonical (${normalizedPath}).`,
      );
    }

    if (
      c.parent_id !== null &&
      (typeof c.parent_id !== "string" || !ID_RE.test(c.parent_id))
    ) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `comments[${i}].parent_id is invalid.`,
      );
    }

    if (
      typeof c.status !== "string" ||
      !VALID_STATUSES.has(c.status as CommentStatus)
    ) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `comments[${i}].status is invalid.`,
      );
    }
    const status = c.status as CommentStatus;

    let syntax: CommentSyntax = "gfm";
    if (c.syntax !== undefined) {
      if (c.syntax !== "gfm" && c.syntax !== "mfm") {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          `comments[${i}].syntax must be 'gfm' or 'mfm'.`,
        );
      }
      syntax = c.syntax;
    }

    if (typeof c.is_admin !== "boolean") {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `comments[${i}].is_admin must be boolean.`,
      );
    }

    if (!includePrivate && "author_email" in c) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `comments[${i}].author_email is forbidden when include_private is false.`,
      );
    }

    let authorEmail: string | null | undefined;
    if (includePrivate && c.author_email !== undefined) {
      if (c.author_email !== null && typeof c.author_email !== "string") {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          `comments[${i}].author_email is invalid.`,
        );
      }
      authorEmail = normalizeEmail(c.author_email);
    }

    let authorName: string | null = null;
    if (c.author_name !== undefined && c.author_name !== null) {
      if (typeof c.author_name !== "string" || c.author_name.length > 80) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          `comments[${i}].author_name is invalid.`,
        );
      }
      authorName = c.author_name.trim() || null;
    }

    let authorUrl: string | null = null;
    if (c.author_url !== undefined && c.author_url !== null) {
      if (typeof c.author_url !== "string") {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          `comments[${i}].author_url is invalid.`,
        );
      }
      authorUrl = normalizeHttpUrl(c.author_url);
    }

    let contentMarkdown: string | null = null;
    if (status === "deleted") {
      if (c.content_markdown !== null) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          `comments[${i}].content_markdown must be null when status is deleted.`,
        );
      }
      contentMarkdown = null;
    } else {
      if (
        typeof c.content_markdown !== "string" ||
        c.content_markdown.trim().length === 0 ||
        c.content_markdown.length > 10000
      ) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          `comments[${i}].content_markdown must be a non-empty string (<=10000 chars).`,
        );
      }
      contentMarkdown = c.content_markdown;
    }

    if (
      typeof c.created_at !== "string" ||
      Number.isNaN(Date.parse(c.created_at))
    ) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `comments[${i}].created_at is invalid.`,
      );
    }

    const updatedAt =
      typeof c.updated_at === "string" &&
      !Number.isNaN(Date.parse(c.updated_at))
        ? c.updated_at
        : c.created_at;

    let source: { system: string; external_id: string } | undefined;
    if (c.source !== undefined) {
      if (
        typeof c.source !== "object" ||
        c.source === null ||
        typeof (c.source as Record<string, unknown>).system !== "string" ||
        typeof (c.source as Record<string, unknown>).external_id !== "string"
      ) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          `comments[${i}].source is invalid.`,
        );
      }
      source = {
        system: ((c.source as Record<string, unknown>).system as string).trim(),
        external_id: (
          (c.source as Record<string, unknown>).external_id as string
        ).trim(),
      };
    }

    validatedComments.push({
      id: c.id,
      path: normalizedPath,
      parent_id: c.parent_id,
      status,
      syntax,
      author_name: status === "deleted" ? null : authorName,
      author_url: status === "deleted" ? null : authorUrl,
      ...(includePrivate
        ? { author_email: status === "deleted" ? null : (authorEmail ?? null) }
        : {}),
      is_admin: c.is_admin,
      content_markdown: contentMarkdown,
      created_at: new Date(c.created_at).toISOString(),
      updated_at: new Date(updatedAt).toISOString(),
      ...(source ? { source } : {}),
    });
  }

  const pathAliases: ExportPathAlias[] = [];
  if (obj.path_aliases !== undefined) {
    if (!Array.isArray(obj.path_aliases)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "path_aliases must be an array.",
      );
    }
    for (const alias of obj.path_aliases) {
      if (
        typeof alias !== "object" ||
        alias === null ||
        typeof (alias as Record<string, unknown>).alias_path !== "string" ||
        typeof (alias as Record<string, unknown>).canonical_path !== "string"
      ) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Invalid path_alias entry.",
        );
      }
      pathAliases.push({
        alias_path: normalizePath(
          (alias as Record<string, unknown>).alias_path as string,
        ),
        canonical_path: normalizePath(
          (alias as Record<string, unknown>).canonical_path as string,
        ),
      });
    }
  }

  return {
    format: "cf-comments",
    version: 1,
    exported_at: new Date(obj.exported_at).toISOString(),
    ...(typeof obj.site === "string" ? { site: obj.site } : {}),
    include_private: includePrivate,
    ...(pathAliases.length > 0 ? { path_aliases: pathAliases } : {}),
    comments: validatedComments,
  };
}

export async function exportCanonicalFromDb(
  db: D1Database,
  options: { includePrivate: boolean; siteUrl?: string },
): Promise<CanonicalExport> {
  const { results: rows } = await db
    .prepare("SELECT * FROM comments ORDER BY created_at ASC, id ASC")
    .all<CommentRow>();

  const { results: aliases } = await db
    .prepare(
      "SELECT alias_path, canonical_path FROM path_aliases ORDER BY alias_path ASC",
    )
    .all<ExportPathAlias>();

  const comments: ExportComment[] = rows.map((row) => {
    const base: ExportComment = {
      id: row.id,
      path: row.path,
      parent_id: row.parent_id,
      status: row.status,
      syntax: row.syntax,
      author_name: row.author_name,
      author_url: row.author_url,
      is_admin: row.is_admin === 1,
      content_markdown: row.content_markdown,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    if (options.includePrivate) {
      base.author_email = row.author_email;
    }

    if (row.import_source && row.import_external_id) {
      base.source = {
        system: row.import_source,
        external_id: row.import_external_id,
      };
    }

    return base;
  });

  return {
    format: "cf-comments",
    version: 1,
    exported_at: new Date().toISOString(),
    ...(options.siteUrl ? { site: options.siteUrl } : {}),
    include_private: options.includePrivate,
    ...(aliases.length > 0 ? { path_aliases: aliases } : {}),
    comments,
  };
}

export async function importCanonicalToDb(
  db: D1Database,
  rawPayload: unknown,
  options: { dryRun: boolean; misskeyInstanceUrl?: string | null },
): Promise<ImportReport> {
  const payload = validateCanonicalExport(rawPayload);
  const warnings: string[] = [];
  const errors: string[] = [];

  // Load existing IDs and import provenance keys for idempotency
  const { results: existingRows } = await db
    .prepare(
      "SELECT id, path, root_id, import_source, import_external_id FROM comments",
    )
    .all<{
      id: string;
      path: string;
      root_id: string | null;
      import_source: string | null;
      import_external_id: string | null;
    }>();

  const existingById = new Map<
    string,
    { path: string; root_id: string | null }
  >();
  const existingSourceKeys = new Set<string>();
  for (const r of existingRows) {
    existingById.set(r.id, { path: r.path, root_id: r.root_id });
    if (r.import_source && r.import_external_id) {
      existingSourceKeys.add(`${r.import_source}:${r.import_external_id}`);
    }
  }

  const incomingById = new Map<string, ExportComment>();
  for (const c of payload.comments) {
    incomingById.set(c.id, c);
  }

  // Validate tree integrity (orphans, cycles, cross-path replies) and topologically order
  const resolvedRootId = new Map<string, string | null>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: ExportComment[] = [];

  function visit(comment: ExportComment): boolean {
    if (visited.has(comment.id)) return true;
    if (visiting.has(comment.id)) {
      errors.push(`Cycle detected involving comment ${comment.id}.`);
      return false;
    }
    visiting.add(comment.id);

    if (comment.parent_id === null) {
      resolvedRootId.set(comment.id, null);
    } else {
      const parentIncoming = incomingById.get(comment.parent_id);
      const parentExisting = existingById.get(comment.parent_id);
      if (!parentIncoming && !parentExisting) {
        errors.push(
          `Orphan comment ${comment.id}: parent_id ${comment.parent_id} not found.`,
        );
        visiting.delete(comment.id);
        return false;
      }

      if (parentIncoming) {
        if (parentIncoming.path !== comment.path) {
          errors.push(
            `Cross-path reply ${comment.id}: path ${comment.path} != parent path ${parentIncoming.path}.`,
          );
          visiting.delete(comment.id);
          return false;
        }
        if (!visit(parentIncoming)) {
          visiting.delete(comment.id);
          return false;
        }
        const parentRoot =
          resolvedRootId.get(parentIncoming.id) ?? parentIncoming.id;
        resolvedRootId.set(comment.id, parentRoot);
      } else if (parentExisting) {
        if (parentExisting.path !== comment.path) {
          errors.push(
            `Cross-path reply ${comment.id}: path ${comment.path} != existing parent path ${parentExisting.path}.`,
          );
          visiting.delete(comment.id);
          return false;
        }
        resolvedRootId.set(
          comment.id,
          parentExisting.root_id ?? comment.parent_id,
        );
      }
    }

    visiting.delete(comment.id);
    visited.add(comment.id);
    ordered.push(comment);
    return true;
  }

  for (const c of payload.comments) {
    visit(c);
  }

  if (errors.length > 0) {
    return {
      dry_run: options.dryRun,
      total: payload.comments.length,
      inserted: 0,
      skipped_existing: 0,
      warnings,
      errors,
    };
  }

  let inserted = 0;
  let skippedExisting = 0;
  const statements: D1PreparedStatement[] = [];

  if (payload.path_aliases) {
    const now = new Date().toISOString();
    for (const alias of payload.path_aliases) {
      statements.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO path_aliases (alias_path, canonical_path, created_at) VALUES (?, ?, ?)",
          )
          .bind(alias.alias_path, alias.canonical_path, now),
      );
    }
  }

  for (const c of ordered) {
    const sourceKey = c.source
      ? `${c.source.system}:${c.source.external_id}`
      : null;
    if (
      existingById.has(c.id) ||
      (sourceKey && existingSourceKeys.has(sourceKey))
    ) {
      skippedExisting++;
      continue;
    }

    const rootId = resolvedRootId.get(c.id) ?? null;
    const syntax: CommentSyntax = c.syntax ?? "gfm";
    const html =
      c.status === "deleted" || !c.content_markdown
        ? null
        : renderCommentContent(c.content_markdown, syntax, {
            misskeyInstanceUrl: options.misskeyInstanceUrl,
          });
    const avatarHue = computeAvatarHue(c.author_name ?? null);
    const importSource = c.source?.system ?? "canonical";
    const importExternalId = c.source?.external_id ?? c.id;

    // Historical imports NEVER enable notify_on_reply or trigger emails
    statements.push(
      db
        .prepare(
          `INSERT INTO comments
           (id, path, parent_id, root_id, status, author_name, author_email, author_url,
            avatar_hue, is_admin, notify_on_reply, syntax, content_markdown, content_html,
            import_source, import_external_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          c.id,
          c.path,
          c.parent_id,
          rootId,
          c.status,
          c.author_name ?? null,
          c.author_email ?? null,
          c.author_url ?? null,
          avatarHue,
          c.is_admin ? 1 : 0,
          syntax,
          c.content_markdown,
          html,
          importSource,
          importExternalId,
          c.created_at,
          c.updated_at ?? c.created_at,
        ),
    );
    inserted++;
  }

  if (!options.dryRun && statements.length > 0) {
    await db.batch(statements);
  }

  return {
    dry_run: options.dryRun,
    total: payload.comments.length,
    inserted,
    skipped_existing: skippedExisting,
    warnings,
    errors,
  };
}
