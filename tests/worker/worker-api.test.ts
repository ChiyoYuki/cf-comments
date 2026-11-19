import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { drainEmailOutbox } from "../../src/email/outbox.ts";
import { convertWalineToCanonical } from "../../src/importers/waline.ts";
import type { WorkerEnv } from "../../src/worker/env.ts";
import worker from "../../src/worker/index.ts";
import { createMockExecutionContext, createTestD1 } from "./helpers/mock-d1.ts";

function createTestEnv(overrides: Partial<WorkerEnv> = {}): {
  env: WorkerEnv;
  sentCfEmails: Array<{ from: string; to: string; rawMime: string }>;
} {
  const { db } = createTestD1();
  const sentCfEmails: Array<{ from: string; to: string; rawMime: string }> = [];

  const env: WorkerEnv = {
    DB: db,
    SITE_URL: "https://blog.example.com",
    ALLOWED_ORIGINS: "https://blog.example.com",
    MODERATION_MODE: "pre",
    MAX_CONTENT_LENGTH: "4000",
    MISSKEY_INSTANCE_URL: "https://misskey.example.com",
    ADMIN_EMAIL_PROVIDER: "cf_email_routing",
    REPLY_EMAIL_PROVIDER: "resend",
    EMAIL_FROM: "comments@example.com",
    ADMIN_NOTIFY_EMAIL: "owner@example.com",
    ADMIN_TOKEN: "test-admin-secret-token",
    TOKEN_SIGNING_SECRET: "test-signing-secret",
    RESEND_API_KEY: "re_test_key",
    SEND_EMAIL: {
      async send(msg: unknown) {
        sentCfEmails.push(msg as { from: string; to: string; rawMime: string });
      },
    },
    ...overrides,
  };
  return { env, sentCfEmails };
}

describe("Worker API End-to-End Integration", () => {
  it("serves public config (including misskey_instance_url & syntax_modes) and exact-origin CORS headers", async () => {
    const { env } = createTestEnv();
    const { ctx } = createMockExecutionContext();

    const okRes = await worker.fetch(
      new Request("https://comments.example.com/v1/config", {
        headers: { Origin: "https://blog.example.com" },
      }),
      env,
      ctx,
    );
    assert.equal(okRes.status, 200);
    assert.equal(
      okRes.headers.get("Access-Control-Allow-Origin"),
      "https://blog.example.com",
    );
    const cfg = (await okRes.json()) as {
      allow_image_upload: boolean;
      allow_remote_images: boolean;
      reply_notify_enabled: boolean;
      misskey_instance_url: string | null;
      markdown: { syntax_modes: string[]; default_syntax: string };
    };
    assert.equal(cfg.allow_image_upload, false);
    assert.equal(cfg.allow_remote_images, true);
    assert.equal(cfg.reply_notify_enabled, true);
    assert.equal(cfg.misskey_instance_url, "https://misskey.example.com");
    assert.deepEqual(cfg.markdown.syntax_modes, ["gfm", "mfm"]);
    assert.equal(cfg.markdown.default_syntax, "gfm");

    const blockedOriginRes = await worker.fetch(
      new Request("https://comments.example.com/v1/config", {
        headers: { Origin: "https://evil.example" },
      }),
      env,
      ctx,
    );
    assert.equal(
      blockedOriginRes.headers.get("Access-Control-Allow-Origin"),
      null,
    );
  });

  it("supports explicit syntax selection in /v1/preview and /v1/comments", async () => {
    const { env } = createTestEnv({ MODERATION_MODE: "post" });
    const { ctx } = createMockExecutionContext();

    const previewMfm = await worker.fetch(
      new Request("https://comments.example.com/v1/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          syntax: "mfm",
          content: "$[x3 大字] :blobcat:",
        }),
      }),
      env,
      ctx,
    );
    assert.equal(previewMfm.status, 200);
    const previewBody = (await previewMfm.json()) as { html: string };
    assert.ok(previewBody.html.includes("mfm-x3"));
    assert.ok(previewBody.html.includes('data-emoji="blobcat"'));

    const postMfm = await worker.fetch(
      new Request("https://comments.example.com/v1/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/about",
          syntax: "mfm",
          content: "$[blur 秘密] @alice",
        }),
      }),
      env,
      ctx,
    );
    assert.equal(postMfm.status, 201);
    const created = (await postMfm.json()) as {
      comment: { syntax: string; content_html: string };
    };
    assert.equal(created.comment.syntax, "mfm");
    assert.ok(created.comment.content_html.includes("mfm-blur"));
    assert.ok(
      created.comment.content_html.includes(
        "https://misskey.example.com/@alice",
      ),
    );

    // Invalid syntax rejected
    const badSyntax = await worker.fetch(
      new Request("https://comments.example.com/v1/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ syntax: "bbcode", content: "hi" }),
      }),
      env,
      ctx,
    );
    assert.equal(badSyntax.status, 400);
  });

  it("rejects invalid paths, enforces honeypot and rate limit, and returns 202 in pre-moderation mode", async () => {
    const { env } = createTestEnv({
      RATE_LIMIT_SUBMIT: {
        async limit() {
          return { success: true };
        },
      },
    });
    const { ctx } = createMockExecutionContext();

    const badPathRes = await worker.fetch(
      new Request("https://comments.example.com/v1/comments?path=/foo//bar/"),
      env,
      ctx,
    );
    assert.equal(badPathRes.status, 400);
    const badPathBody = (await badPathRes.json()) as {
      error: { code: string };
    };
    assert.equal(badPathBody.error.code, "INVALID_PATH");

    const spamRes = await worker.fetch(
      new Request("https://comments.example.com/v1/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/about",
          content: "hello",
          honeypot: "http://spam.example",
        }),
      }),
      env,
      ctx,
    );
    assert.equal(spamRes.status, 400);
    const spamBody = (await spamRes.json()) as { error: { code: string } };
    assert.equal(spamBody.error.code, "SPAM_DETECTED");

    const createRes = await worker.fetch(
      new Request("https://comments.example.com/v1/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/about",
          content: "匿名测试 ~~删除线~~",
        }),
      }),
      env,
      ctx,
    );
    assert.equal(createRes.status, 202);
    const created = (await createRes.json()) as {
      id: string;
      path: string;
      status: string;
      verification_queued: boolean;
      comment: null;
    };
    assert.equal(created.path, "/about/");
    assert.equal(created.status, "pending");
    assert.equal(created.verification_queued, false);
    assert.equal(created.comment, null);

    const listRes = await worker.fetch(
      new Request("https://comments.example.com/v1/comments?path=/about/"),
      env,
      ctx,
    );
    const listBody = (await listRes.json()) as {
      total_approved: number;
      items: unknown[];
    };
    assert.equal(listBody.total_approved, 0);
    assert.equal(listBody.items.length, 0);
  });

  it("handles hidden/deleted parent placeholders, pending subtree blocking, reply_limit=0, and pagination", async () => {
    const { env } = createTestEnv({ MODERATION_MODE: "post" });
    const { ctx } = createMockExecutionContext();
    const adminHeaders = {
      Authorization: "Bearer test-admin-secret-token",
      "Content-Type": "application/json",
    };

    const r1Res = await worker.fetch(
      new Request("https://comments.example.com/v1/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/posts/demo/",
          author_name: "Alice",
          content: "Root comment",
        }),
      }),
      env,
      ctx,
    );
    assert.equal(r1Res.status, 201);
    const r1 = (await r1Res.json()) as { id: string };

    const replyIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const repRes = await worker.fetch(
        new Request("https://comments.example.com/v1/comments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: "/posts/demo/",
            parent_id: i === 1 ? r1.id : replyIds[i - 2],
            author_name: `User${i}`,
            content: `Reply ${i}`,
          }),
        }),
        env,
        ctx,
      );
      assert.equal(repRes.status, 201);
      const rep = (await repRes.json()) as { id: string };
      replyIds.push(rep.id);
    }

    const hideRes = await worker.fetch(
      new Request(`https://comments.example.com/v1/admin/comments/${r1.id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ status: "hidden" }),
      }),
      env,
      ctx,
    );
    assert.equal(hideRes.status, 200);
    assert.equal(hideRes.headers.get("Cache-Control"), "no-store");

    const delRep1 = await worker.fetch(
      new Request(
        `https://comments.example.com/v1/admin/comments/${replyIds[0]}`,
        {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({ status: "deleted" }),
        },
      ),
      env,
      ctx,
    );
    assert.equal(delRep1.status, 200);

    const restoreAttempt = await worker.fetch(
      new Request(
        `https://comments.example.com/v1/admin/comments/${replyIds[0]}`,
        {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({ status: "approved" }),
        },
      ),
      env,
      ctx,
    );
    assert.equal(restoreAttempt.status, 409);
    const restoreBody = (await restoreAttempt.json()) as {
      error: { code: string };
    };
    assert.equal(restoreBody.error.code, "INVALID_STATE_TRANSITION");

    const hardDelParent = await worker.fetch(
      new Request(
        `https://comments.example.com/v1/admin/comments/${replyIds[0]}`,
        {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({ status: "deleted", hard_delete: true }),
        },
      ),
      env,
      ctx,
    );
    assert.equal(hardDelParent.status, 409);
    const hardDelBody = (await hardDelParent.json()) as {
      error: { code: string };
    };
    assert.equal(hardDelBody.error.code, "HAS_CHILD_COMMENTS");

    const zeroReplyRes = await worker.fetch(
      new Request(
        "https://comments.example.com/v1/comments?path=/posts/demo/&reply_limit=0",
      ),
      env,
      ctx,
    );
    const zeroBody = (await zeroReplyRes.json()) as {
      total_approved: number;
      items: Array<{
        id: string;
        is_placeholder: boolean;
        placeholder_reason: string;
        author_name: null;
        content_html: null;
        reply_count: number;
        replies: unknown[];
        replies_next_cursor: string | null;
      }>;
    };
    assert.equal(zeroBody.total_approved, 2);
    assert.equal(zeroBody.items.length, 1);
    assert.equal(zeroBody.items[0]?.is_placeholder, true);
    assert.equal(zeroBody.items[0]?.placeholder_reason, "hidden");
    assert.equal(zeroBody.items[0]?.reply_count, 2);
    assert.equal(zeroBody.items[0]?.replies.length, 0);
    assert.equal(zeroBody.items[0]?.replies_next_cursor, null);

    const page1Res = await worker.fetch(
      new Request(
        `https://comments.example.com/v1/comments/${r1.id}/replies?limit=2`,
      ),
      env,
      ctx,
    );
    assert.equal(page1Res.status, 200);
    const page1 = (await page1Res.json()) as {
      items: Array<{
        id: string;
        is_placeholder: boolean;
        reply_to_author: string | null;
      }>;
      next_cursor: string | null;
    };
    assert.equal(page1.items.length, 2);
    assert.equal(page1.items[0]?.is_placeholder, true);
    assert.equal(page1.items[1]?.is_placeholder, false);
    assert.equal(page1.items[1]?.reply_to_author, null);
    const nextCursor = page1.next_cursor;
    assert.ok(nextCursor);

    const page2Res = await worker.fetch(
      new Request(
        `https://comments.example.com/v1/comments/${r1.id}/replies?limit=2&cursor=${encodeURIComponent(nextCursor)}`,
      ),
      env,
      ctx,
    );
    const page2 = (await page2Res.json()) as {
      items: Array<{ id: string; reply_to_author: string | null }>;
      next_cursor: string | null;
    };
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0]?.reply_to_author, "User2");
    assert.equal(page2.next_cursor, null);

    await worker.fetch(
      new Request(
        `https://comments.example.com/v1/admin/comments/${replyIds[1]}`,
        {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({ status: "pending" }),
        },
      ),
      env,
      ctx,
    );

    const blockedRes = await worker.fetch(
      new Request("https://comments.example.com/v1/comments?path=/posts/demo/"),
      env,
      ctx,
    );
    const blockedBody = (await blockedRes.json()) as {
      total_approved: number;
      items: unknown[];
    };
    assert.equal(blockedBody.total_approved, 0);
    assert.equal(blockedBody.items.length, 0);

    const hardDelLeaf = await worker.fetch(
      new Request(
        `https://comments.example.com/v1/admin/comments/${replyIds[2]}`,
        {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({ status: "deleted", hard_delete: true }),
        },
      ),
      env,
      ctx,
    );
    assert.equal(hardDelLeaf.status, 204);
  });

  it("enforces RFC 9110 safe GET+POST subscription verification and transactional dual-provider email outbox", async () => {
    const { env, sentCfEmails } = createTestEnv({ MODERATION_MODE: "pre" });
    const { ctx } = createMockExecutionContext();
    const sentHttpEmails: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      sentHttpEmails.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    };

    const postRes = await worker.fetch(
      new Request("https://comments.example.com/v1/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/about/",
          author_name: "Visitor",
          author_email: "visitor@example.com",
          notify_on_reply: true,
          content: "Hello!",
        }),
      }),
      env,
      ctx,
    );
    assert.equal(postRes.status, 202);
    const postBody = (await postRes.json()) as {
      id: string;
      verification_queued: boolean;
    };
    assert.equal(postBody.verification_queued, true);

    const drain1 = await drainEmailOutbox(env, {
      fetchImpl: mockFetch,
      emailMessageFactory: async (from, to, rawMime) => ({ from, to, rawMime }),
    });
    assert.equal(drain1.sent, 2);
    assert.equal(sentCfEmails.length, 1);
    assert.equal(sentCfEmails[0]?.to, "owner@example.com");
    assert.equal(sentHttpEmails.length, 1);
    assert.equal(sentHttpEmails[0]?.url, "https://api.resend.com/emails");

    const verifyText = String(sentHttpEmails[0]?.body.text);
    const tokenMatch = verifyText.match(/verify\?token=([^\s]+)/);
    const rawVerifyToken = tokenMatch?.[1];
    assert.ok(rawVerifyToken);
    const verifyToken = decodeURIComponent(rawVerifyToken);

    const getVerifyRes = await worker.fetch(
      new Request(
        `https://comments.example.com/v1/subscriptions/verify?token=${encodeURIComponent(verifyToken)}`,
      ),
      env,
      ctx,
    );
    assert.equal(getVerifyRes.status, 200);
    assert.equal(getVerifyRes.headers.get("Cache-Control"), "no-store");
    const subBefore = await env.DB.prepare(
      "SELECT status FROM email_subscriptions WHERE email_normalized = 'visitor@example.com'",
    ).first<{ status: string }>();
    assert.equal(subBefore?.status, "pending");

    const postVerifyRes = await worker.fetch(
      new Request("https://comments.example.com/v1/subscriptions/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ token: verifyToken }).toString(),
      }),
      env,
      ctx,
    );
    assert.equal(postVerifyRes.status, 200);
    const subAfter = await env.DB.prepare(
      "SELECT status FROM email_subscriptions WHERE email_normalized = 'visitor@example.com'",
    ).first<{ status: string }>();
    assert.equal(subAfter?.status, "verified");

    const adminHeaders = {
      Authorization: "Bearer test-admin-secret-token",
      "Content-Type": "application/json",
    };
    await worker.fetch(
      new Request(
        `https://comments.example.com/v1/admin/comments/${postBody.id}`,
        {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({ status: "approved" }),
        },
      ),
      env,
      ctx,
    );

    const adminReplyRes = await worker.fetch(
      new Request("https://comments.example.com/v1/admin/comments", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          path: "/about/",
          parent_id: postBody.id,
          author_name: "Owner",
          syntax: "mfm",
          content: "$[tada Welcome!]",
        }),
      }),
      env,
      ctx,
    );
    assert.equal(adminReplyRes.status, 201);
    const adminReply = (await adminReplyRes.json()) as {
      comment: { is_admin: boolean; syntax: string };
    };
    assert.equal(adminReply.comment.is_admin, true);
    assert.equal(adminReply.comment.syntax, "mfm");

    const drain2 = await drainEmailOutbox(env, {
      fetchImpl: mockFetch,
      emailMessageFactory: async (from, to, rawMime) => ({ from, to, rawMime }),
    });
    assert.equal(drain2.sent, 1);
    assert.equal(sentHttpEmails.length, 2);
    assert.deepEqual(sentHttpEmails[1]?.body.to, ["visitor@example.com"]);
  });

  it("converts Waline export, imports idempotently without emailing, and enforces export privacy rules", async () => {
    const { env } = createTestEnv();
    const { ctx } = createMockExecutionContext();
    const adminHeaders = {
      Authorization: "Bearer test-admin-secret-token",
      "Content-Type": "application/json",
    };

    const walineSample = {
      type: "waline",
      data: {
        Users: [{ objectId: "admin_u1", type: "administrator" }],
        Counter: [{ url: "/about/", time: 100 }],
        Comment: [
          {
            objectId: "6911d1e4899bcd1d2da8d6a2",
            nick: "Owner",
            mail: "owner@example.com",
            comment: "test home",
            url: "/",
            status: "approved",
            insertedAt: "2025-11-10T11:52:03.971Z",
          },
          {
            objectId: "69134471632ef37f28595f23",
            nick: "Guest",
            mail: "guest@example.com",
            link: "https://guest.example.com",
            comment:
              'Hi <img class="wl-emoji" src="//unpkg.com/@waline/emojis@1.1.0/weibo/weibo_love.png" alt="weibo_love">',
            url: "/about/",
            status: "approved",
            insertedAt: "2025-11-11T14:13:04.498Z",
          },
          {
            objectId: "69180b72889d6023ff2fd5e7",
            nick: "Owner",
            mail: "owner@example.com",
            user_id: "admin_u1",
            pid: "69134471632ef37f28595f23",
            rid: "69134471632ef37f28595f23",
            comment: "Thanks!",
            url: "/about/",
            status: "approved",
            insertedAt: "2025-11-15T05:11:14.296Z",
          },
        ],
      },
    };

    const converted = convertWalineToCanonical(walineSample, {
      skipPaths: ["/"],
      includePrivate: false,
      siteUrl: "https://blog.example.com",
    });
    assert.equal(converted.errors.length, 0);
    assert.equal(converted.stats.skipped_by_path, 1);
    assert.equal(converted.stats.converted, 2);
    assert.equal(converted.stats.emoji_tags_converted, 1);
    assert.equal(converted.canonical.comments[0]?.syntax, "gfm");
    assert.equal(converted.canonical.comments[1]?.is_admin, true);

    const dryRes = await worker.fetch(
      new Request("https://comments.example.com/v1/admin/import?dry_run=true", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify(converted.canonical),
      }),
      env,
      ctx,
    );
    assert.equal(dryRes.status, 200);
    const dryReport = (await dryRes.json()) as {
      dry_run: boolean;
      inserted: number;
    };
    assert.equal(dryReport.dry_run, true);
    assert.equal(dryReport.inserted, 2);

    const imp1Res = await worker.fetch(
      new Request("https://comments.example.com/v1/admin/import", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify(converted.canonical),
      }),
      env,
      ctx,
    );
    const imp1 = (await imp1Res.json()) as {
      inserted: number;
      skipped_existing: number;
    };
    assert.equal(imp1.inserted, 2);
    assert.equal(imp1.skipped_existing, 0);

    const imp2Res = await worker.fetch(
      new Request("https://comments.example.com/v1/admin/import", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify(converted.canonical),
      }),
      env,
      ctx,
    );
    const imp2 = (await imp2Res.json()) as {
      inserted: number;
      skipped_existing: number;
    };
    assert.equal(imp2.inserted, 0);
    assert.equal(imp2.skipped_existing, 2);

    const outboxCnt = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM email_outbox",
    ).first<{ cnt: number }>();
    assert.equal(outboxCnt?.cnt, 0);

    const expRes = await worker.fetch(
      new Request("https://comments.example.com/v1/admin/export", {
        headers: { Authorization: "Bearer test-admin-secret-token" },
      }),
      env,
      ctx,
    );
    assert.equal(expRes.headers.get("Cache-Control"), "no-store");
    const exported = (await expRes.json()) as {
      include_private: boolean;
      comments: Array<Record<string, unknown>>;
    };
    assert.equal(exported.include_private, false);
    assert.equal("author_email" in (exported.comments[0] ?? {}), false);
    assert.equal(exported.comments[0]?.syntax, "gfm");
  });
});
