import {
  normalizeEmail,
  normalizeHttpUrl,
  normalizePath,
} from "../shared/path.ts";
import type {
  CanonicalExport,
  CommentStatus,
  ExportComment,
} from "../shared/types.ts";

export interface WalineCommentRecord {
  objectId: string;
  nick?: string;
  mail?: string;
  link?: string;
  comment?: string;
  url?: string;
  pid?: string;
  rid?: string;
  status?: string;
  user_id?: string;
  like?: number;
  ip?: string;
  ua?: string;
  insertedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface WalineUserRecord {
  objectId?: string;
  type?: string;
}

export interface WalineExportPayload {
  type?: string;
  data?: {
    Comment?: WalineCommentRecord[];
    Counter?: unknown[];
    Users?: WalineUserRecord[];
  };
}

export interface WalineConvertOptions {
  includePrivate?: boolean;
  skipPaths?: string[];
  pathRemap?: Record<string, string>;
  siteUrl?: string;
}

export interface WalineConvertResult {
  canonical: CanonicalExport;
  stats: {
    source_total: number;
    converted: number;
    skipped_by_path: number;
    emoji_tags_converted: number;
    invalid_links_dropped: number;
  };
  warnings: string[];
  errors: string[];
}

const WL_EMOJI_IMG_RE =
  /<img\b[^>]*\bclass=["'][^"']*\bwl-emoji\b[^"']*["'][^>]*>/gi;

function convertWalineEmojiTags(text: string): {
  markdown: string;
  convertedCount: number;
} {
  let convertedCount = 0;
  const markdown = text.replace(WL_EMOJI_IMG_RE, (tag) => {
    const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i);
    if (!srcMatch?.[1]) return tag;
    let src = srcMatch[1].trim();
    if (src.startsWith("//")) {
      src = `https:${src}`;
    }
    try {
      const parsed = new URL(src);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return tag;
      }
      const altMatch = tag.match(/\balt=["']([^"']*)["']/i);
      const alt = (altMatch?.[1] ?? "emoji").replace(/[[\]]/g, "");
      convertedCount++;
      return `![${alt}](${parsed.toString()})`;
    } catch {
      return tag;
    }
  });
  return { markdown, convertedCount };
}

function mapWalineStatus(raw: string | undefined): CommentStatus {
  switch (raw) {
    case "approved":
      return "approved";
    case "waiting":
      return "pending";
    case "spam":
      return "spam";
    default:
      return "hidden";
  }
}

export function convertWalineToCanonical(
  waline: WalineExportPayload,
  options: WalineConvertOptions = {},
): WalineConvertResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  const rawComments = waline.data?.Comment;
  if (!Array.isArray(rawComments)) {
    throw new Error("Invalid Waline export: missing data.Comment array.");
  }

  if (Array.isArray(waline.data?.Counter) && waline.data.Counter.length > 0) {
    warnings.push(
      `Skipped Waline Counter table (${waline.data.Counter.length} pageview records; pageview is out of scope for v1).`,
    );
  }

  const adminUserIds = new Set<string>();
  if (Array.isArray(waline.data?.Users)) {
    for (const u of waline.data.Users) {
      if (u.type === "administrator" && typeof u.objectId === "string") {
        adminUserIds.add(u.objectId);
      }
    }
    warnings.push(
      "Stripped Waline Users credentials/password hashes; only administrator objectIds were used to mark is_admin.",
    );
  }

  const skipPaths = new Set(
    (options.skipPaths ?? []).map((p) => normalizePath(p)),
  );
  const pathRemap = new Map<string, string>();
  for (const [from, to] of Object.entries(options.pathRemap ?? {})) {
    pathRemap.set(normalizePath(from), normalizePath(to));
  }

  // First pass: index paths and filter skipped paths
  const keptRecords: WalineCommentRecord[] = [];
  const keptById = new Map<
    string,
    { record: WalineCommentRecord; path: string }
  >();
  let skippedByPath = 0;

  for (const rec of rawComments) {
    if (!rec.objectId) {
      errors.push("Encountered Waline comment without objectId.");
      continue;
    }
    const rawUrl = rec.url || "/";
    let normalized = normalizePath(rawUrl);
    const remapped = pathRemap.get(normalized);
    if (remapped) normalized = remapped;

    if (skipPaths.has(normalized)) {
      skippedByPath++;
      continue;
    }
    keptRecords.push(rec);
    keptById.set(rec.objectId, { record: rec, path: normalized });
  }

  // Second pass: validate pid/rid integrity, orphans, and cross-path replies
  let emojiTagsConverted = 0;
  let invalidLinksDropped = 0;
  let likeCountWarned = false;
  let ipUaWarned = false;
  const convertedComments: ExportComment[] = [];

  for (const rec of keptRecords) {
    const entry = keptById.get(rec.objectId);
    if (!entry) continue;

    if ((rec.ip || rec.ua) && !ipUaWarned) {
      warnings.push(
        "Omitted raw IP and User-Agent fields (not stored by cf-comments).",
      );
      ipUaWarned = true;
    }
    if (typeof rec.like === "number" && rec.like > 0 && !likeCountWarned) {
      warnings.push(
        "Waline comment like counts are not represented in v1 schema and were omitted.",
      );
      likeCountWarned = true;
    }

    const parentId = rec.pid?.trim() || null;
    if (parentId) {
      const parentEntry = keptById.get(parentId);
      if (!parentEntry) {
        errors.push(
          `Orphan Waline comment ${rec.objectId}: pid ${parentId} not found.`,
        );
        continue;
      }
      if (parentEntry.path !== entry.path) {
        errors.push(
          `Cross-path Waline reply ${rec.objectId}: ${entry.path} != parent ${parentEntry.path}.`,
        );
        continue;
      }
    }

    if (rec.rid?.trim()) {
      const rootEntry = keptById.get(rec.rid.trim());
      if (!rootEntry) {
        errors.push(
          `Orphan Waline comment ${rec.objectId}: rid ${rec.rid} not found.`,
        );
        continue;
      }
      if (rootEntry.path !== entry.path) {
        errors.push(
          `Cross-path Waline root ${rec.objectId}: ${entry.path} != root ${rootEntry.path}.`,
        );
        continue;
      }
    }

    let authorUrl: string | null = null;
    if (rec.link?.trim()) {
      try {
        authorUrl = normalizeHttpUrl(rec.link);
      } catch {
        invalidLinksDropped++;
        warnings.push(
          `Dropped invalid author_url on comment ${rec.objectId} (non-http(s) scheme).`,
        );
      }
    }

    let authorEmail: string | null = null;
    if (options.includePrivate && rec.mail?.trim()) {
      try {
        authorEmail = normalizeEmail(rec.mail);
      } catch {
        warnings.push(`Dropped invalid email on comment ${rec.objectId}.`);
      }
    }

    const rawNick = rec.nick?.trim() || "";
    const isAnonNick =
      !rawNick || rawNick === "匿名" || rawNick.toLowerCase() === "anonymous";
    const authorName = isAnonNick ? null : rawNick.slice(0, 80);

    const { markdown, convertedCount } = convertWalineEmojiTags(
      (rec.comment ?? "").trim(),
    );
    emojiTagsConverted += convertedCount;

    const createdAt = new Date(
      rec.insertedAt || rec.createdAt || new Date().toISOString(),
    ).toISOString();
    const updatedAt = new Date(rec.updatedAt || createdAt).toISOString();

    const exportItem: ExportComment = {
      id: rec.objectId,
      path: entry.path,
      parent_id: parentId,
      status: mapWalineStatus(rec.status),
      syntax: "gfm",
      author_name: authorName,
      author_url: authorUrl,
      ...(options.includePrivate ? { author_email: authorEmail } : {}),
      is_admin: Boolean(rec.user_id && adminUserIds.has(rec.user_id)),
      content_markdown: markdown || "(empty)",
      created_at: createdAt,
      updated_at: updatedAt,
      source: {
        system: "waline",
        external_id: rec.objectId,
      },
    };
    convertedComments.push(exportItem);
  }

  const canonical: CanonicalExport = {
    format: "cf-comments",
    version: 1,
    exported_at: new Date().toISOString(),
    ...(options.siteUrl ? { site: options.siteUrl } : {}),
    include_private: Boolean(options.includePrivate),
    comments: convertedComments,
  };

  return {
    canonical,
    stats: {
      source_total: rawComments.length,
      converted: convertedComments.length,
      skipped_by_path: skippedByPath,
      emoji_tags_converted: emojiTagsConverted,
      invalid_links_dropped: invalidLinksDropped,
    },
    warnings,
    errors,
  };
}
