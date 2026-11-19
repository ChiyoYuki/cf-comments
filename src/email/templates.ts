import { escapeHtml } from "../shared/html.ts";
import type {
  AdminNewCommentPayload,
  ReplyApprovedPayload,
  VerifyEmailPayload,
} from "./types.ts";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function truncatePreview(text: string, maxLen = 500): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}…`;
}

export function renderAdminNewCommentEmail(
  payload: AdminNewCommentPayload,
): RenderedEmail {
  const author = payload.author_name || "匿名访客";
  const pageUrl = `${payload.site_url.replace(/\/$/, "")}${payload.path}`;
  const preview = truncatePreview(payload.content_markdown);
  const statusLabel =
    payload.status === "pending" ? "待审核 (pending)" : payload.status;

  const subject = `[评论通知] ${author} 在 ${payload.path} 发表了新评论`;
  const text = [
    `页面: ${pageUrl}`,
    `作者: ${author}`,
    `状态: ${statusLabel}`,
    `评论 ID: ${payload.comment_id}`,
    "",
    preview,
    "",
    `审核管理: ${payload.admin_url}`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="zh-CN"><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1f2937">
  <h2 style="margin:0 0 12px">收到新评论</h2>
  <p style="margin:0 0 8px"><strong>页面：</strong><a href="${escapeHtml(pageUrl)}">${escapeHtml(payload.path)}</a></p>
  <p style="margin:0 0 8px"><strong>作者：</strong>${escapeHtml(author)}　<strong>状态：</strong>${escapeHtml(statusLabel)}</p>
  <blockquote style="margin:12px 0;padding:12px 16px;border-left:3px solid #6366f1;background:#f8fafc;white-space:pre-wrap">${escapeHtml(preview)}</blockquote>
  <p><a href="${escapeHtml(payload.admin_url)}">前往审核管理后台</a></p>
</body></html>`;

  return { subject, text, html };
}

export function renderReplyApprovedEmail(
  payload: ReplyApprovedPayload,
): RenderedEmail {
  const author = payload.reply_author_name || "匿名访客";
  const pageUrl = `${payload.site_url.replace(/\/$/, "")}${payload.path}#comment-${payload.reply_id}`;
  const preview = truncatePreview(payload.reply_content_markdown);

  const subject = `[回复通知] ${author} 回复了你在 ${payload.path} 的评论`;
  const text = [
    `${author} 回复了你在 ${payload.path} 的评论：`,
    "",
    preview,
    "",
    `查看回复: ${pageUrl}`,
    `如不再接收回复邮件提醒，请访问退订页面: ${payload.unsubscribe_url}`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="zh-CN"><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1f2937">
  <h2 style="margin:0 0 12px">你的评论收到了新回复</h2>
  <p style="margin:0 0 8px"><strong>${escapeHtml(author)}</strong> 回复了你在 <a href="${escapeHtml(pageUrl)}">${escapeHtml(payload.path)}</a> 的评论：</p>
  <blockquote style="margin:12px 0;padding:12px 16px;border-left:3px solid #6366f1;background:#f8fafc;white-space:pre-wrap">${escapeHtml(preview)}</blockquote>
  <p><a href="${escapeHtml(pageUrl)}">点击查看完整对话</a></p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
  <p style="font-size:12px;color:#6b7280">你收到此邮件是因为曾验证订阅回复提醒。如不再需要，可前往 <a href="${escapeHtml(payload.unsubscribe_url)}">退订确认页</a>。</p>
</body></html>`;

  return { subject, text, html };
}

export function renderVerifySubscriptionEmail(
  payload: VerifyEmailPayload,
): RenderedEmail {
  const subject = "[评论通知] 请确认订阅评论回复提醒";
  const text = [
    `你在 ${payload.site_url} 提交评论时勾选了回复邮件提醒。`,
    "请打开以下页面并点击确认按钮，验证后才会在收到已审核回复时向你发送通知：",
    "",
    payload.verify_url,
    "",
    `如果这不是你的操作，可以忽略此邮件，或访问退订页面：${payload.unsubscribe_url}`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="zh-CN"><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1f2937">
  <h2 style="margin:0 0 12px">确认订阅评论回复提醒</h2>
  <p>你在 <a href="${escapeHtml(payload.site_url)}">${escapeHtml(payload.site_url)}</a> 发表评论时选择了接收回复提醒。</p>
  <p>为防止误发，请点击下方链接进入确认页完成验证：</p>
  <p><a href="${escapeHtml(payload.verify_url)}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:8px">前往邮箱验证页</a></p>
  <p style="font-size:12px;color:#6b7280">如非本人操作请忽略，或点击 <a href="${escapeHtml(payload.unsubscribe_url)}">退订</a>。</p>
</body></html>`;

  return { subject, text, html };
}
