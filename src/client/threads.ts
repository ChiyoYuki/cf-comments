import type { PublicComment } from "../shared/types.ts";

export function mergeById<Row extends { id: string }>(
  existing: readonly Row[],
  added: readonly Row[],
): Row[] {
  return [
    ...new Map([...existing, ...added].map((row) => [row.id, row])).values(),
  ];
}

export function arrangeReplies(
  rootId: string,
  replies: readonly PublicComment[],
) {
  const sorted = replies.slice().sort((first, second) => {
    if (first.created_at !== second.created_at)
      return first.created_at < second.created_at ? -1 : 1;
    return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
  });
  const rows = new Map(sorted.map((row) => [row.id, row]));
  const children = new Map<string, PublicComment[]>();
  for (const row of rows.values()) {
    const parent =
      row.parent_id && rows.has(row.parent_id) ? row.parent_id : rootId;
    const siblings = children.get(parent) ?? [];
    siblings.push(row);
    children.set(parent, siblings);
  }
  const result: { row: PublicComment; depth: number }[] = [];
  const visited = new Set<string>([rootId]);
  const stack = (children.get(rootId) ?? [])
    .map((row) => ({ row, depth: 0 }))
    .reverse();
  while (stack.length) {
    const next = stack.pop();
    if (!next || visited.has(next.row.id)) continue;
    visited.add(next.row.id);
    result.push(next);
    const descendants = children.get(next.row.id) ?? [];
    for (const descendant of descendants.slice().reverse()) {
      stack.push({ row: descendant, depth: Math.min(next.depth + 1, 2) });
    }
  }
  for (const row of rows.values()) {
    if (!visited.has(row.id)) result.push({ row, depth: 0 });
  }
  return result;
}

export function hasMoreReplies(
  nextCursor: string | null,
  loaded: boolean,
  replyCount: number,
): boolean {
  return nextCursor !== null || (!loaded && replyCount > 0);
}
