import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanupEmailOutbox,
  drainEmailOutbox,
} from "../../src/email/outbox.ts";
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
    MAX_CONTENT_LENGTH: "3000",
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
    const { ctx, flush } = createMockExecutionContext();
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

    await flush();
    const drain1 = await drainEmailOutbox(env, {
      nowMs: Date.now() + 120_000,
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

    await flush();
    const drain2 = await drainEmailOutbox(env, {
      nowMs: Date.now() + 120_000,
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

  it("prevents duplicate outbox sends under concurrency, recovers expired leases, cleans old rows, rejects expired verify tokens, and enforces DB CHECK constraints", async () => {
    const { env, sentCfEmails } = createTestEnv({
      MODERATION_MODE: "pre",
      REPLY_EMAIL_PROVIDER: "resend",
    });
    const { ctx, flush } = createMockExecutionContext();

    // 1. Concurrent drainEmailOutbox calls must claim atomically and send each email only once
    await worker.fetch(
      new Request("https://comments.example.com/v1/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/about/",
          author_name: "Alice",
          author_email: "alice@example.com",
          notify_on_reply: true,
          content: "Concurrency test",
        }),
      }),
      env,
      ctx,
    );
    await flush();

    // Simulate one row stuck in 'processing' with an expired lease to verify lease recovery too
    await env.DB.prepare(
      `UPDATE email_outbox
       SET status = 'processing', locked_until = '2020-01-01T00:00:00.000Z'
       WHERE kind = 'admin_new_comment'`,
    ).run();

    const resendCalls: string[] = [];
    const slowFetch: typeof fetch = async (_input, init) => {
      await new Promise((r) => setTimeout(r, 10));
      const payload = JSON.parse(String(init?.body)) as { text?: string };
      resendCalls.push(String(payload.text ?? ""));
      return new Response(JSON.stringify({ id: "ok" }), { status: 200 });
    };

    const futureNow = Date.now() + 120_000;
    const [d1, d2] = await Promise.all([
      drainEmailOutbox(env, {
        nowMs: futureNow,
        fetchImpl: slowFetch,
        emailMessageFactory: async (from, to, rawMime) => ({
          from,
          to,
          rawMime,
        }),
      }),
      drainEmailOutbox(env, {
        nowMs: futureNow,
        fetchImpl: slowFetch,
        emailMessageFactory: async (from, to, rawMime) => ({
          from,
          to,
          rawMime,
        }),
      }),
    ]);
    assert.equal(d1.sent + d2.sent, 2);
    assert.equal(sentCfEmails.length, 1);
    assert.equal(resendCalls.length, 1);

    // 2. Cleanup removes sent outbox records older than 30 days
    const oldTime = new Date(
      Date.now() - 40 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await env.DB.prepare("UPDATE email_outbox SET updated_at = ?")
      .bind(oldTime)
      .run();
    const deletedCnt = await cleanupEmailOutbox(env.DB, { retentionDays: 30 });
    assert.equal(deletedCnt, 2);

    // 3. Expired verify token must be rejected on both GET and POST
    const tokenMatch = resendCalls[0]?.match(/verify\?token=([^\s]+)/);
    const verifyToken = decodeURIComponent(tokenMatch?.[1] ?? "");
    assert.ok(verifyToken);
    await env.DB.prepare(
      "UPDATE email_subscriptions SET verify_token_expires_at = '2020-01-01T00:00:00.000Z' WHERE email_normalized = 'alice@example.com'",
    ).run();

    const expiredGet = await worker.fetch(
      new Request(
        `https://comments.example.com/v1/subscriptions/verify?token=${encodeURIComponent(verifyToken)}`,
      ),
      env,
      ctx,
    );
    assert.equal(expiredGet.status, 400);

    const expiredPost = await worker.fetch(
      new Request("https://comments.example.com/v1/subscriptions/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: verifyToken }),
      }),
      env,
      ctx,
    );
    assert.equal(expiredPost.status, 400);

    // 4. DB CHECK constraints enforce tree, soft-delete, hue, and self-alias invariants
    await assert.rejects(async () => {
      await env.DB.prepare(
        `INSERT INTO comments
         (id, path, parent_id, root_id, status, avatar_hue, is_admin, notify_on_reply, syntax, content_markdown, created_at, updated_at)
         VALUES ('BADTREE1', '/about/', 'BADTREE1', NULL, 'approved', 200, 0, 0, 'gfm', 'hi', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run();
    });

    await assert.rejects(async () => {
      await env.DB.prepare(
        `INSERT INTO comments
         (id, path, parent_id, root_id, status, avatar_hue, is_admin, notify_on_reply, syntax, content_markdown, created_at, updated_at)
         VALUES ('BADDEL01', '/about/', NULL, NULL, 'deleted', 200, 0, 0, 'gfm', 'must be null', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run();
    });

    await assert.rejects(async () => {
      await env.DB.prepare(
        "INSERT INTO path_aliases (alias_path, canonical_path, created_at) VALUES ('/same/', '/same/', '2026-01-01T00:00:00.000Z')",
      ).run();
    });
  });

  it("direct Gravatar avatar_url respects gravatar_enabled, normalizes email SHA-256, and clears on placeholder/soft-delete", async () => {
    const { env } = createTestEnv({
      MODERATION_MODE: "post",
      GRAVATAR_ENABLED: "true",
    });
    const { ctx } = createMockExecutionContext();

    // 1. Config exposes gravatar_enabled=true
    const cfgRes = await worker.fetch(
      new Request("https://comments.example.com/v1/config"),
      env,
      ctx,
    );
    const cfg = (await cfgRes.json()) as { gravatar_enabled: boolean };
    assert.equal(cfg.gravatar_enabled, true);

    // 2. Posting with mixed-case email generates deterministic SHA-256 Gravatar URL
    const createRes = await worker.fetch(
      new Request("https://comments.example.com/v1/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/posts/gravatar/",
          author_name: "Alice",
          author_email: "  Alice@Example.COM ",
          content: "Root comment with Gravatar",
        }),
      }),
      env,
      ctx,
    );
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      id: string;
      comment: {
        avatar_url: string | null;
        author_email?: unknown;
      };
    };
    const expectedUrl =
      "https://gravatar.com/avatar/ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976?s=96&d=404&r=g";
    assert.equal(created.comment.avatar_url, expectedUrl);
    assert.equal("author_email" in created.comment, false);

    // 3. Reply without email gets avatar_url=null
    const replyRes = await worker.fetch(
      new Request("https://comments.example.com/v1/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/posts/gravatar/",
          parent_id: created.id,
          author_name: "Bob",
          content: "Reply without email",
        }),
      }),
      env,
      ctx,
    );
    assert.equal(replyRes.status, 201);
    const replyCreated = (await replyRes.json()) as {
      comment: { avatar_url: string | null };
    };
    assert.equal(replyCreated.comment.avatar_url, null);

    // 4. Listing comments returns avatar_url when enabled, null when disabled
    const listOn = (await (
      await worker.fetch(
        new Request(
          "https://comments.example.com/v1/comments?path=/posts/gravatar/",
        ),
        env,
        ctx,
      )
    ).json()) as {
      items: Array<{
        avatar_url: string | null;
        replies: Array<{ avatar_url: string | null }>;
      }>;
    };
    assert.equal(listOn.items[0]?.avatar_url, expectedUrl);
    assert.equal(listOn.items[0]?.replies[0]?.avatar_url, null);

    const listOff = (await (
      await worker.fetch(
        new Request(
          "https://comments.example.com/v1/comments?path=/posts/gravatar/",
        ),
        { ...env, GRAVATAR_ENABLED: "false" },
        ctx,
      )
    ).json()) as {
      items: Array<{ avatar_url: string | null }>;
    };
    assert.equal(listOff.items[0]?.avatar_url, null);

    // 5. Hidden parent becomes placeholder with avatar_url=null
    await worker.fetch(
      new Request(
        `https://comments.example.com/v1/admin/comments/${created.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: "Bearer test-admin-secret-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "hidden" }),
        },
      ),
      env,
      ctx,
    );
    const listHidden = (await (
      await worker.fetch(
        new Request(
          "https://comments.example.com/v1/comments?path=/posts/gravatar/",
        ),
        env,
        ctx,
      )
    ).json()) as {
      items: Array<{ is_placeholder: boolean; avatar_url: string | null }>;
    };
    assert.equal(listHidden.items[0]?.is_placeholder, true);
    assert.equal(listHidden.items[0]?.avatar_url, null);

    // 6. Soft-delete clears avatar_hash in D1
    await worker.fetch(
      new Request(
        `https://comments.example.com/v1/admin/comments/${created.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: "Bearer test-admin-secret-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "deleted" }),
        },
      ),
      env,
      ctx,
    );
    const dbRow = await env.DB.prepare(
      "SELECT author_email, avatar_hash FROM comments WHERE id = ?",
    )
      .bind(created.id)
      .first<{ author_email: string | null; avatar_hash: string | null }>();
    assert.equal(dbRow?.author_email, null);
    assert.equal(dbRow?.avatar_hash, null);
  });

  it("POST /v1/admin/avatars/backfill performs idempotent hash-only backfill without restoring email or reply notifications", async () => {
    const { env } = createTestEnv({ GRAVATAR_ENABLED: "true" });
    const { ctx } = createMockExecutionContext();

    // Seed two imported comments (one approved without email, one spam without email)
    const importPayload = {
      format: "cf-comments",
      version: 1,
      exported_at: "2026-11-19T00:00:00.000Z",
      include_private: false,
      comments: [
        {
          id: "waline_approved_01",
          path: "/about/",
          parent_id: null,
          status: "approved",
          syntax: "gfm",
          author_name: "LegacyUser",
          author_url: null,
          is_admin: false,
          content_markdown: "Legacy approved comment",
          created_at: "2025-11-01T00:00:00.000Z",
          source: { system: "waline", external_id: "ext-approved-1" },
        },
        {
          id: "waline_spam_000001",
          path: "/about/",
          parent_id: null,
          status: "spam",
          syntax: "gfm",
          author_name: "Spammer",
          author_url: null,
          is_admin: false,
          content_markdown: "Legacy spam comment",
          created_at: "2025-11-02T00:00:00.000Z",
          source: { system: "waline", external_id: "ext-spam-1" },
        },
      ],
    };

    const impRes = await worker.fetch(
      new Request("https://comments.example.com/v1/admin/import", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-admin-secret-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(importPayload),
      }),
      env,
      ctx,
    );
    assert.equal(impRes.status, 200);

    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const hashC = "c".repeat(64);
    const backfillBody = {
      items: [
        {
          import_source: "waline",
          import_external_id: "ext-approved-1",
          avatar_hash: hashA,
        },
        {
          import_source: "waline",
          import_external_id: "ext-spam-1",
          avatar_hash: hashB,
        },
        {
          import_source: "waline",
          import_external_id: "ext-missing-99",
          avatar_hash: hashC,
        },
      ],
    };

    // 1. Dry-run reports exact counts without writing
    const dryRes = await worker.fetch(
      new Request(
        "https://comments.example.com/v1/admin/avatars/backfill?dry_run=true",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-admin-secret-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(backfillBody),
        },
      ),
      env,
      ctx,
    );
    assert.equal(dryRes.status, 200);
    assert.deepEqual(await dryRes.json(), {
      dry_run: true,
      total: 3,
      updated: 1,
      skipped_already_set: 0,
      skipped_non_public: 1,
      unmatched: 1,
    });

    // 2. Apply updates only approved row, keeps author_email=NULL and notify_on_reply=0
    const applyRes = await worker.fetch(
      new Request(
        "https://comments.example.com/v1/admin/avatars/backfill?dry_run=false",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-admin-secret-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(backfillBody),
        },
      ),
      env,
      ctx,
    );
    assert.equal(applyRes.status, 200);
    assert.deepEqual(await applyRes.json(), {
      dry_run: false,
      total: 3,
      updated: 1,
      skipped_already_set: 0,
      skipped_non_public: 1,
      unmatched: 1,
    });

    const approvedRow = await env.DB.prepare(
      "SELECT author_email, notify_on_reply, avatar_hash FROM comments WHERE id = 'waline_approved_01'",
    ).first<{
      author_email: string | null;
      notify_on_reply: number;
      avatar_hash: string | null;
    }>();
    assert.equal(approvedRow?.author_email, null);
    assert.equal(approvedRow?.notify_on_reply, 0);
    assert.equal(approvedRow?.avatar_hash, hashA);

    const spamRow = await env.DB.prepare(
      "SELECT avatar_hash FROM comments WHERE id = 'waline_spam_000001'",
    ).first<{ avatar_hash: string | null }>();
    assert.equal(spamRow?.avatar_hash, null);

    // 3. Re-running is idempotent
    const repeatRes = await worker.fetch(
      new Request(
        "https://comments.example.com/v1/admin/avatars/backfill?dry_run=false",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-admin-secret-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(backfillBody),
        },
      ),
      env,
      ctx,
    );
    assert.deepEqual(await repeatRes.json(), {
      dry_run: false,
      total: 3,
      updated: 0,
      skipped_already_set: 1,
      skipped_non_public: 1,
      unmatched: 1,
    });

    // 4. Public endpoint exposes direct Gravatar URL for backfilled comment
    const pubList = (await (
      await worker.fetch(
        new Request("https://comments.example.com/v1/comments?path=/about/"),
        env,
        ctx,
      )
    ).json()) as { items: Array<{ avatar_url: string | null }> };
    assert.equal(
      pubList.items[0]?.avatar_url,
      `https://gravatar.com/avatar/${hashA}?s=96&d=404&r=g`,
    );
  });
});
