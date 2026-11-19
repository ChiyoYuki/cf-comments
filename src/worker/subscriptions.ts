import { escapeHtml } from "../markdown/index.ts";
import { AppError, jsonResponse } from "../shared/errors.ts";
import { hmacSha256Hex } from "../shared/id.ts";
import type { RuntimeConfig, WorkerEnv } from "./env.ts";

interface SubscriptionRow {
  email_normalized: string;
  status: "pending" | "verified" | "unsubscribed";
  verify_token_expires_at?: string | null;
}

function noStoreHtml(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

function renderConfirmPage(params: {
  title: string;
  heading: string;
  description: string;
  buttonLabel: string;
  actionPath: string;
  token: string;
  siteUrl: string;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(params.title)}</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#111827;margin:0;padding:32px 16px;display:flex;justify-content:center}
    main{max-width:460px;width:100%;background:#fff;border-radius:16px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
    h1{font-size:1.25rem;margin:0 0 12px}
    p{color:#4b5563;line-height:1.6;margin:0 0 20px}
    button{background:#3b5bdb;color:#fff;border:none;border-radius:999px;padding:10px 22px;font-size:.95rem;cursor:pointer}
    button:hover{background:#364fc7}
    a{color:#3b5bdb;text-decoration:none}
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(params.heading)}</h1>
    <p>${escapeHtml(params.description)}</p>
    <form method="POST" action="${escapeHtml(params.actionPath)}">
      <input type="hidden" name="token" value="${escapeHtml(params.token)}">
      <button type="submit">${escapeHtml(params.buttonLabel)}</button>
    </form>
    <p style="margin-top:20px;font-size:.85rem"><a href="${escapeHtml(params.siteUrl)}">返回站点</a></p>
  </main>
</body>
</html>`;
}

function renderResultPage(params: {
  title: string;
  heading: string;
  description: string;
  siteUrl: string;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(params.title)}</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#111827;margin:0;padding:32px 16px;display:flex;justify-content:center}
    main{max-width:460px;width:100%;background:#fff;border-radius:16px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
    h1{font-size:1.25rem;margin:0 0 12px}
    p{color:#4b5563;line-height:1.6;margin:0 0 20px}
    a{color:#3b5bdb;text-decoration:none}
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(params.heading)}</h1>
    <p>${escapeHtml(params.description)}</p>
    <p><a href="${escapeHtml(params.siteUrl)}">返回站点</a></p>
  </main>
</body>
</html>`;
}

async function readTokenFromPost(request: Request): Promise<string> {
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as {
      token?: unknown;
    } | null;
    if (!body || typeof body.token !== "string" || !body.token.trim()) {
      throw new AppError(400, "INVALID_INPUT", "Missing token.");
    }
    return body.token.trim();
  }

  const text = await request.text();
  const params = new URLSearchParams(text);
  const token = params.get("token")?.trim();
  if (!token) {
    throw new AppError(400, "INVALID_INPUT", "Missing token.");
  }
  return token;
}

function wantsJson(request: Request): boolean {
  const accept = request.headers.get("Accept") || "";
  return accept.includes("application/json");
}

export async function handleGetVerifyPage(
  request: Request,
  env: WorkerEnv,
  cfg: RuntimeConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim();
  if (!token) {
    throw new AppError(400, "INVALID_INPUT", "Missing verification token.");
  }
  const tokenHash = await hmacSha256Hex(
    cfg.tokenSigningSecret,
    `verify:${token}`,
  );
  const existing = await env.DB.prepare(
    "SELECT email_normalized, status, verify_token_expires_at FROM email_subscriptions WHERE verify_token_hash = ?",
  )
    .bind(tokenHash)
    .first<SubscriptionRow>();

  const nowIso = new Date().toISOString();
  if (
    !existing ||
    (existing.verify_token_expires_at &&
      existing.verify_token_expires_at <= nowIso)
  ) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Invalid or expired verification token.",
    );
  }

  return noStoreHtml(
    renderConfirmPage({
      title: "确认订阅回复提醒",
      heading: "确认验证邮箱",
      description:
        "点击下方按钮完成邮箱验证。验证后，仅当你的评论收到已审核的新回复时才会发送提醒邮件。",
      buttonLabel: "确认验证邮箱",
      actionPath: "/v1/subscriptions/verify",
      token,
      siteUrl: cfg.siteUrl,
    }),
  );
}

export async function handlePostVerify(
  request: Request,
  env: WorkerEnv,
  cfg: RuntimeConfig,
): Promise<Response> {
  const token = await readTokenFromPost(request);
  const tokenHash = await hmacSha256Hex(
    cfg.tokenSigningSecret,
    `verify:${token}`,
  );
  const existing = await env.DB.prepare(
    "SELECT email_normalized, status, verify_token_expires_at FROM email_subscriptions WHERE verify_token_hash = ?",
  )
    .bind(tokenHash)
    .first<SubscriptionRow>();

  const nowIso = new Date().toISOString();
  if (
    !existing ||
    (existing.verify_token_expires_at &&
      existing.verify_token_expires_at <= nowIso)
  ) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Invalid or expired verification token.",
    );
  }

  await env.DB.prepare(
    `UPDATE email_subscriptions
     SET status = 'verified', verify_token_hash = NULL, verify_token_expires_at = NULL, verified_at = ?, updated_at = ?
     WHERE email_normalized = ?`,
  )
    .bind(nowIso, nowIso, existing.email_normalized)
    .run();

  if (wantsJson(request)) {
    return jsonResponse(
      { status: "verified" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return noStoreHtml(
    renderResultPage({
      title: "邮箱验证成功",
      heading: "邮箱已验证",
      description:
        "你已成功订阅评论回复邮件提醒。今后可随时通过邮件底部的链接退订。",
      siteUrl: cfg.siteUrl,
    }),
  );
}

export async function handleGetUnsubscribePage(
  request: Request,
  env: WorkerEnv,
  cfg: RuntimeConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim();
  if (!token) {
    throw new AppError(400, "INVALID_INPUT", "Missing unsubscribe token.");
  }
  const tokenHash = await hmacSha256Hex(
    cfg.tokenSigningSecret,
    `unsub:${token}`,
  );
  const existing = await env.DB.prepare(
    "SELECT email_normalized, status FROM email_subscriptions WHERE unsubscribe_token_hash = ?",
  )
    .bind(tokenHash)
    .first<SubscriptionRow>();

  if (!existing) {
    throw new AppError(400, "INVALID_INPUT", "Invalid unsubscribe token.");
  }

  return noStoreHtml(
    renderConfirmPage({
      title: "退订回复提醒",
      heading: "确认退订回复邮件提醒",
      description: "点击下方按钮后，本站将不再向此邮箱发送评论回复提醒邮件。",
      buttonLabel: "确认退订",
      actionPath: "/v1/subscriptions/unsubscribe",
      token,
      siteUrl: cfg.siteUrl,
    }),
  );
}

export async function handlePostUnsubscribe(
  request: Request,
  env: WorkerEnv,
  cfg: RuntimeConfig,
): Promise<Response> {
  const token = await readTokenFromPost(request);
  const tokenHash = await hmacSha256Hex(
    cfg.tokenSigningSecret,
    `unsub:${token}`,
  );
  const existing = await env.DB.prepare(
    "SELECT email_normalized, status FROM email_subscriptions WHERE unsubscribe_token_hash = ?",
  )
    .bind(tokenHash)
    .first<SubscriptionRow>();

  if (!existing) {
    throw new AppError(400, "INVALID_INPUT", "Invalid unsubscribe token.");
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE email_subscriptions
     SET status = 'unsubscribed', verify_token_hash = NULL, verify_token_expires_at = NULL, updated_at = ?
     WHERE email_normalized = ?`,
  )
    .bind(now, existing.email_normalized)
    .run();

  if (wantsJson(request)) {
    return jsonResponse(
      { status: "unsubscribed" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return noStoreHtml(
    renderResultPage({
      title: "已退订回复提醒",
      heading: "已成功退订",
      description: "我们已停止向该邮箱发送未来的评论回复提醒邮件。",
      siteUrl: cfg.siteUrl,
    }),
  );
}
