import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ApiError, createApi, httpUrl } from "../../src/client/api.ts";
import { avatarInitial, commentAvatarUrl } from "../../src/client/avatar.ts";
import { formatCommentTime, formatTime } from "../../src/client/content.ts";
import { createEmojiResolver } from "../../src/client/emoji.ts";
import { renderCommentContent as renderPreview } from "../../src/client/preview.ts";
import {
  arrangeReplies,
  hasMoreReplies,
  mergeById,
} from "../../src/client/threads.ts";
import { renderCommentContent } from "../../src/markdown/index.ts";
import type { CommentThreadPage, ReplyPage } from "../../src/shared/types.ts";

function fixture<Data>(name: string): Data {
  return JSON.parse(
    readFileSync(
      new URL(`../../docs/fixtures/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

test("live preview shares the same sanitized Markdown renderer as publishing", () => {
  assert.equal(renderPreview, renderCommentContent);
  assert.match(renderPreview("~~review~~", "gfm"), /<del>review<\/del>/);
  const mfm = renderPreview("$[blur spoiler] :blobcat:", "mfm", {
    misskeyInstanceUrl: "https://misskey.example.com",
  });
  assert.match(mfm, /class="mfm-blur"/);
  assert.match(mfm, /data-emoji="blobcat"/);
});

test("reader comment dates use local relative time through seven days", () => {
  const now = Date.parse("2026-11-19T12:00:00Z");
  const day = 86_400_000;
  assert.equal(formatCommentTime(now - 59_999, "zh-CN", now), "刚刚");
  assert.equal(formatCommentTime(now, "en", now), "just now");
  assert.equal(formatCommentTime(now - 60_000, "en", now), "1 minute ago");
  assert.equal(formatCommentTime(now - 3_600_000, "en", now), "1 hour ago");
  assert.equal(formatCommentTime(now - day, "en", now), "yesterday");
  assert.equal(formatCommentTime(now - 7 * day, "en", now), "7 days ago");
  const old = now - 7 * day - 1;
  assert.equal(
    formatCommentTime(old, "en", now),
    new Intl.DateTimeFormat("en", { dateStyle: "short" }).format(old),
  );
  assert.notEqual(formatCommentTime(old, "en", now), formatTime(old, "en"));
  assert.equal(formatCommentTime("invalid", "en", now), null);
});

test("monogram fallback preserves the first complete nickname character", () => {
  assert.equal(avatarInitial("  晴空"), "晴");
  assert.equal(avatarInitial("Anonymous"), "A");
  assert.equal(avatarInitial("👩‍💻 Dev"), "👩‍💻");
  assert.equal(avatarInitial("e\u0301toile"), "e\u0301");
});

test("avatars accept only the fixed HTTPS Gravatar URL for public comments", () => {
  const row = { is_placeholder: false };
  const hash = "0123456789abcdef".repeat(4);
  const path = `/avatar/${hash}?s=96&d=404&r=g`;
  const url = `https://gravatar.com${path}`;
  assert.equal(commentAvatarUrl({ ...row, avatar_url: url }), url);
  for (const avatar_url of [
    null,
    "/v1/comments/example01/avatar",
    `//gravatar.com${path}`,
    `http://gravatar.com${path}`,
    `https://gravatar.com.evil.example${path}`,
    url.replace(hash, hash.toUpperCase()),
    url.replace(hash, hash.slice(1)),
    url.replace("d=404", "d=mp"),
    `${url}&tracking=extra`,
    `${url}#fragment`,
  ]) {
    assert.equal(commentAvatarUrl({ ...row, avatar_url }), null);
  }
  assert.equal(commentAvatarUrl(row), null);
  assert.equal(
    commentAvatarUrl({ avatar_url: url, is_placeholder: true }),
    null,
  );
});

test("a hidden or deleted ancestor remains in the hierarchy without becoming replyable content", () => {
  const thread = fixture<CommentThreadPage>("comments-hidden-parent").items[0];
  assert.ok(thread?.is_placeholder);
  const tree = arrangeReplies(thread.id, thread.replies);
  assert.deepEqual(
    tree.map(({ row, depth }) => [row.placeholder_reason, depth]),
    [
      ["deleted", 0],
      [null, 1],
      [null, 2],
    ],
  );
  assert.equal(tree[0]?.row.content_html, null);
  assert.equal(thread.reply_count, 2);
});

test("reply pages merge by ID and an ancestor loaded later restores indentation", () => {
  const thread = fixture<CommentThreadPage>("comments-paginated").items[0];
  assert.ok(thread);
  const extra = fixture<ReplyPage>("replies-paginated");
  assert.equal(arrangeReplies(thread.id, extra.items)[0]?.depth, 0);
  const merged = mergeById(extra.items, [...thread.replies, ...extra.items]);
  assert.equal(merged.length, thread.reply_count);
  assert.deepEqual(
    arrangeReplies(thread.id, merged).map(({ depth }) => depth),
    [0, 1, 2],
  );
  assert.equal(
    hasMoreReplies(thread.replies_next_cursor, true, thread.reply_count),
    true,
  );
  assert.equal(
    hasMoreReplies(extra.next_cursor, true, thread.reply_count),
    false,
  );
  assert.equal(hasMoreReplies(null, false, thread.reply_count), true);
  assert.equal(hasMoreReplies(null, false, 0), false);
});

test("request helper preserves opaque cursors, supports 204, and exposes moderation conflicts", async () => {
  const origin = new URL("https://comments.example.test");
  const responses = [
    new Response(null, { status: 204 }),
    Response.json(
      { error: { code: "HAS_CHILD_COMMENTS", message: "Children exist" } },
      { status: 409 },
    ),
  ];
  const calls: Request[] = [];
  const mock: typeof fetch = async (input, options) => {
    calls.push(new Request(input, options));
    const response = responses.shift();
    assert.ok(response);
    return response;
  };
  const api = createApi(origin, mock);
  const opts = {
    method: "PATCH" as const,
    token: "example-token",
    body: { status: "deleted", hard_delete: true },
    query: { cursor: "has+/=?", dry_run: false, unused: null },
  };
  await api.empty("/v1/admin/comments/example", opts);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.credentials, "omit");
  assert.equal(call.redirect, "error");
  assert.equal(call.headers.get("Authorization"), "Bearer example-token");
  assert.deepEqual(Object.fromEntries(new URL(call.url).searchParams), {
    cursor: "has+/=?",
    dry_run: "false",
  });
  await assert.rejects(
    api.empty("/v1/admin/comments/example", opts),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 409 &&
      error.code === "HAS_CHILD_COMMENTS",
  );
  await assert.rejects(
    api.empty("//other.example.test/", opts),
    /Unexpected API origin/,
  );
  assert.equal(calls.length, 2);
});

test("Misskey lookups share an in-memory request and never pass credentials or unsafe URLs", async () => {
  const calls: Request[] = [];
  const signal = new AbortController();
  const mock: typeof fetch = async (input, options) => {
    const request = new Request(input, options);
    calls.push(request);
    const { name } = (await request.json()) as { name: string };
    if (name === "failed") throw new TypeError("CORS blocked");
    if (name === "missing") return new Response(null, { status: 404 });
    return Response.json({
      url:
        name === "safe"
          ? "https://cdn.example.test/one.webp"
          : "data:image/svg+xml,not-allowed",
    });
  };
  const resolve = createEmojiResolver(
    "https://social.example.test/",
    signal.signal,
    mock,
  );
  const first = resolve("safe");
  assert.equal(first, resolve("safe"));
  assert.equal(await first, "https://cdn.example.test/one.webp");
  assert.equal(calls[0]?.url, "https://social.example.test/api/emoji");
  assert.equal(calls[0]?.credentials, "omit");
  assert.equal(await resolve("failed"), null);
  assert.equal(await resolve("missing"), null);
  assert.equal(await resolve("unsafe"), null);
  assert.equal(await resolve("bad/name"), null);
  signal.abort();
  assert.equal(await resolve("post_abort"), null);
  assert.equal(calls.length, 4);
  assert.equal(httpUrl("https://name:password@example.test/"), null);
});

test("Misskey lookup preserves hyphens and plus signs in emoji names", async () => {
  const names: string[] = [];
  const mock: typeof fetch = async (input, options) => {
    const request = new Request(input, options);
    const body = (await request.json()) as { name: string };
    names.push(body.name);
    return Response.json({ url: "https://cdn.example.test/blob.webp" });
  };
  const resolve = createEmojiResolver(
    "https://social.example.test/",
    new AbortController().signal,
    mock,
  );

  assert.equal(await resolve("blob-cat"), "https://cdn.example.test/blob.webp");
  assert.equal(await resolve("blob+cat"), "https://cdn.example.test/blob.webp");
  assert.equal(await resolve("a".repeat(129)), null);
  assert.deepEqual(names, ["blob-cat", "blob+cat"]);
});
