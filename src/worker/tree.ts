import { type CursorPayload, encodeCursor } from "../shared/cursor.ts";
import { buildGravatarUrl } from "../shared/id.ts";
import type {
  AdminComment,
  CommentRow,
  CommentThread,
  CommentThreadPage,
  PublicComment,
  ReplyPage,
} from "../shared/types.ts";

function compareAsc(a: CommentRow, b: CommentRow): number {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? -1 : 1;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

function compareDesc(a: CommentRow, b: CommentRow): number {
  return -compareAsc(a, b);
}

function isAfterCursor(
  row: CommentRow,
  cursor: CursorPayload,
  direction: "asc" | "desc",
): boolean {
  if (direction === "asc") {
    return (
      row.created_at > cursor.t ||
      (row.created_at === cursor.t && row.id > cursor.id)
    );
  }
  return (
    row.created_at < cursor.t ||
    (row.created_at === cursor.t && row.id < cursor.id)
  );
}

export interface VisibilityIndex {
  byId: Map<string, CommentRow>;
  childrenByParent: Map<string | null, CommentRow[]>;
  blockedByPending: Set<string>;
  visibleApproved: Set<string>;
  visiblePlaceholder: Set<string>;
  isVisible: (id: string) => boolean;
}

/**
 * Compute full public visibility for all comment rows belonging to a page or thread.
 *
 * Rules:
 * - A `pending` node blocks its entire subtree (neither it nor any descendant is visible or counted).
 * - An unblocked `approved` node is visible with full content.
 * - An unblocked `hidden`, `spam`, or `deleted` node is visible ONLY as a placeholder if it has
 *   at least one unblocked `approved` descendant.
 */
export function buildVisibilityIndex(rows: CommentRow[]): VisibilityIndex {
  const byId = new Map<string, CommentRow>();
  const childrenByParent = new Map<string | null, CommentRow[]>();

  for (const row of rows) {
    byId.set(row.id, row);
    const parentKey = row.parent_id ?? null;
    const list = childrenByParent.get(parentKey);
    if (list) {
      list.push(row);
    } else {
      childrenByParent.set(parentKey, [row]);
    }
  }

  const blockedByPending = new Set<string>();
  const visibleApproved = new Set<string>();
  const visiblePlaceholder = new Set<string>();

  function dfs(node: CommentRow, parentBlocked: boolean): boolean {
    const blocked = parentBlocked || node.status === "pending";
    if (blocked) {
      blockedByPending.add(node.id);
    }

    let hasApprovedDescendant = false;
    const children = childrenByParent.get(node.id) ?? [];
    for (const child of children) {
      if (dfs(child, blocked)) {
        hasApprovedDescendant = true;
      }
    }

    if (blocked) {
      return false;
    }

    if (node.status === "approved") {
      visibleApproved.add(node.id);
      return true;
    }

    if (hasApprovedDescendant) {
      visiblePlaceholder.add(node.id);
      return true;
    }

    return false;
  }

  // Walk all roots (and any detached nodes if present)
  const roots = childrenByParent.get(null) ?? [];
  for (const root of roots) {
    dfs(root, false);
  }
  for (const row of rows) {
    if (row.parent_id !== null && !byId.has(row.parent_id)) {
      dfs(row, false);
    }
  }

  return {
    byId,
    childrenByParent,
    blockedByPending,
    visibleApproved,
    visiblePlaceholder,
    isVisible: (id: string) =>
      visibleApproved.has(id) || visiblePlaceholder.has(id),
  };
}

export function toPublicComment(
  row: CommentRow,
  index: VisibilityIndex,
  options?: { gravatarEnabled?: boolean },
): PublicComment {
  const isPlaceholder = index.visiblePlaceholder.has(row.id);
  if (isPlaceholder) {
    return {
      id: row.id,
      path: row.path,
      parent_id: row.parent_id,
      root_id: row.root_id,
      is_placeholder: true,
      placeholder_reason: row.status === "deleted" ? "deleted" : "hidden",
      syntax: row.syntax,
      author_name: null,
      author_url: null,
      avatar_hue: null,
      avatar_url: null,
      is_admin: false,
      content_html: null,
      reply_to_author: null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  let replyToAuthor: string | null = null;
  if (row.parent_id) {
    const parent = index.byId.get(row.parent_id);
    if (parent && index.visibleApproved.has(parent.id) && parent.author_name) {
      replyToAuthor = parent.author_name;
    }
  }

  return {
    id: row.id,
    path: row.path,
    parent_id: row.parent_id,
    root_id: row.root_id,
    is_placeholder: false,
    placeholder_reason: null,
    syntax: row.syntax,
    author_name: row.author_name,
    author_url: row.author_url,
    avatar_hue: row.avatar_hue,
    avatar_url: options?.gravatarEnabled
      ? buildGravatarUrl(row.avatar_hash)
      : null,
    is_admin: row.is_admin === 1,
    content_html: row.content_html,
    reply_to_author: replyToAuthor,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toAdminComment(row: CommentRow): AdminComment {
  return {
    id: row.id,
    path: row.path,
    parent_id: row.parent_id,
    root_id: row.root_id,
    status: row.status,
    author_name: row.author_name,
    author_email: row.author_email,
    author_url: row.author_url,
    avatar_hue: row.avatar_hue,
    is_admin: row.is_admin === 1,
    notify_on_reply: row.notify_on_reply === 1,
    syntax: row.syntax,
    content_markdown: row.content_markdown,
    content_html: row.content_html,
    import_source: row.import_source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function collectVisibleDescendants(
  rootId: string,
  index: VisibilityIndex,
): CommentRow[] {
  const result: CommentRow[] = [];
  const stack = [...(index.childrenByParent.get(rootId) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (index.isVisible(node.id)) {
      result.push(node);
    }
    const children = index.childrenByParent.get(node.id);
    if (children) {
      for (const c of children) {
        stack.push(c);
      }
    }
  }
  result.sort(compareAsc);
  return result;
}

export function buildCommentThreadPage(params: {
  path: string;
  rows: CommentRow[];
  limit: number;
  replyLimit: number;
  sort: "desc" | "asc";
  cursor: CursorPayload | null;
  gravatarEnabled?: boolean;
}): CommentThreadPage {
  const index = buildVisibilityIndex(params.rows);
  const publicOpts = { gravatarEnabled: params.gravatarEnabled };

  const visibleRoots = (index.childrenByParent.get(null) ?? []).filter((r) =>
    index.isVisible(r.id),
  );
  visibleRoots.sort(params.sort === "asc" ? compareAsc : compareDesc);

  const filteredRoots = params.cursor
    ? visibleRoots.filter((r) =>
        isAfterCursor(r, params.cursor as CursorPayload, params.sort),
      )
    : visibleRoots;

  const hasMoreRoots = filteredRoots.length > params.limit;
  const pageRoots = filteredRoots.slice(0, params.limit);

  const items: CommentThread[] = pageRoots.map((rootRow) => {
    const descendants = collectVisibleDescendants(rootRow.id, index);
    const approvedReplyCount = descendants.filter((d) =>
      index.visibleApproved.has(d.id),
    ).length;

    let repliesSlice: PublicComment[] = [];
    let repliesNextCursor: string | null = null;

    if (params.replyLimit > 0) {
      const slicedRows = descendants.slice(0, params.replyLimit);
      repliesSlice = slicedRows.map((d) =>
        toPublicComment(d, index, publicOpts),
      );
      if (descendants.length > params.replyLimit) {
        const lastReply = slicedRows[slicedRows.length - 1];
        if (lastReply) {
          repliesNextCursor = encodeCursor({
            t: lastReply.created_at,
            id: lastReply.id,
          });
        }
      }
    }

    return {
      ...toPublicComment(rootRow, index, publicOpts),
      reply_count: approvedReplyCount,
      replies: repliesSlice,
      replies_next_cursor: repliesNextCursor,
    };
  });

  const lastRoot = pageRoots[pageRoots.length - 1];
  const nextCursor =
    hasMoreRoots && lastRoot
      ? encodeCursor({ t: lastRoot.created_at, id: lastRoot.id })
      : null;

  return {
    path: params.path,
    total_approved: index.visibleApproved.size,
    items,
    next_cursor: nextCursor,
  };
}

export function buildReplyPage(params: {
  rootId: string;
  threadRows: CommentRow[];
  limit: number;
  cursor: CursorPayload | null;
  gravatarEnabled?: boolean;
}): ReplyPage | null {
  const index = buildVisibilityIndex(params.threadRows);
  const rootRow = index.byId.get(params.rootId);
  if (!rootRow || rootRow.parent_id !== null || !index.isVisible(rootRow.id)) {
    return null;
  }

  const descendants = collectVisibleDescendants(rootRow.id, index);
  const filtered = params.cursor
    ? descendants.filter((d) =>
        isAfterCursor(d, params.cursor as CursorPayload, "asc"),
      )
    : descendants;

  const hasMore = filtered.length > params.limit;
  const pageRows = filtered.slice(0, params.limit);
  const lastRow = pageRows[pageRows.length - 1];
  const publicOpts = { gravatarEnabled: params.gravatarEnabled };

  return {
    root_id: params.rootId,
    items: pageRows.map((r) => toPublicComment(r, index, publicOpts)),
    next_cursor:
      hasMore && lastRow
        ? encodeCursor({ t: lastRow.created_at, id: lastRow.id })
        : null,
  };
}
