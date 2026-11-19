import { generateId } from "../shared/id.ts";
import type { WorkerEnv } from "../worker/env.ts";
import { parseRuntimeConfig } from "../worker/env.ts";
import {
  type EmailMessageFactory,
  sendViaCloudflareEmailRouting,
  sendViaHttpEndpoint,
  sendViaResend,
} from "./providers.ts";
import {
  renderAdminNewCommentEmail,
  renderReplyApprovedEmail,
  renderVerifySubscriptionEmail,
} from "./templates.ts";
import type {
  AdminNewCommentPayload,
  EmailMessageInput,
  EmailOutboxRow,
  OutboxKind,
  ReplyApprovedPayload,
  VerifyEmailPayload,
} from "./types.ts";

export interface EnqueueOutboxInput {
  dedupeKey: string;
  kind: OutboxKind;
  recipientEmail: string;
  payload: AdminNewCommentPayload | ReplyApprovedPayload | VerifyEmailPayload;
  nowIso?: string;
}

/**
 * Prepare a transactional INSERT OR IGNORE statement for `email_outbox`.
 * Designed to be executed in the same `db.batch([...])` as the comment/status write.
 */
export function prepareEnqueueOutbox(
  db: D1Database,
  job: EnqueueOutboxInput,
): D1PreparedStatement {
  const now = job.nowIso ?? new Date().toISOString();
  return db
    .prepare(
      `INSERT OR IGNORE INTO email_outbox
       (id, dedupe_key, kind, recipient_email, payload_json, status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, 5, ?, ?, ?)`,
    )
    .bind(
      generateId(),
      job.dedupeKey,
      job.kind,
      job.recipientEmail,
      JSON.stringify(job.payload),
      now,
      now,
      now,
    );
}

function renderOutboxRow(
  row: EmailOutboxRow,
): EmailMessageInput & { from: string } {
  const parsed = JSON.parse(row.payload_json) as unknown;
  let rendered: { subject: string; text: string; html: string };

  if (row.kind === "admin_new_comment") {
    rendered = renderAdminNewCommentEmail(parsed as AdminNewCommentPayload);
  } else if (row.kind === "reply_approved") {
    rendered = renderReplyApprovedEmail(parsed as ReplyApprovedPayload);
  } else {
    rendered = renderVerifySubscriptionEmail(parsed as VerifyEmailPayload);
  }

  return {
    from: "",
    to: row.recipient_email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    meta: {
      kind: row.kind,
      dedupe_key: row.dedupe_key,
    },
  };
}

export interface DrainOptions {
  limit?: number;
  nowMs?: number;
  fetchImpl?: typeof fetch;
  emailMessageFactory?: EmailMessageFactory;
}

export interface DrainSummary {
  processed: number;
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
}

export async function drainEmailOutbox(
  env: WorkerEnv,
  options: DrainOptions = {},
): Promise<DrainSummary> {
  const cfg = parseRuntimeConfig(env);
  const limit = options.limit ?? 20;
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const { results } = await env.DB.prepare(
    `SELECT * FROM email_outbox
     WHERE status = 'pending' AND next_attempt_at <= ?
     ORDER BY next_attempt_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(nowIso, limit)
    .all<EmailOutboxRow>();

  const summary: DrainSummary = {
    processed: 0,
    sent: 0,
    skipped: 0,
    retried: 0,
    failed: 0,
  };

  for (const row of results) {
    summary.processed++;
    const provider =
      row.kind === "admin_new_comment"
        ? cfg.adminEmailProvider
        : cfg.replyEmailProvider;

    if (provider === "none") {
      await env.DB.prepare(
        `UPDATE email_outbox SET status = 'skipped', last_error = ?, updated_at = ? WHERE id = ?`,
      )
        .bind("Email provider disabled", nowIso, row.id)
        .run();
      summary.skipped++;
      continue;
    }

    const msg = renderOutboxRow(row);
    msg.from = cfg.emailFrom;

    try {
      if (provider === "cf_email_routing") {
        if (!env.SEND_EMAIL) {
          throw new Error("SEND_EMAIL binding is not configured.");
        }
        await sendViaCloudflareEmailRouting(
          env.SEND_EMAIL,
          msg,
          options.emailMessageFactory,
        );
      } else if (provider === "resend") {
        if (!env.RESEND_API_KEY) {
          throw new Error("RESEND_API_KEY secret is not configured.");
        }
        await sendViaResend(env.RESEND_API_KEY, msg, options.fetchImpl);
      } else if (provider === "http") {
        if (!cfg.emailHttpEndpoint) {
          throw new Error("EMAIL_HTTP_ENDPOINT is not configured.");
        }
        await sendViaHttpEndpoint(
          cfg.emailHttpEndpoint,
          env.EMAIL_HTTP_TOKEN,
          msg,
          options.fetchImpl,
        );
      }

      await env.DB.prepare(
        `UPDATE email_outbox
         SET status = 'sent', attempts = attempts + 1, last_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
        .bind(nowIso, row.id)
        .run();
      summary.sent++;
    } catch (err) {
      const nextAttempts = row.attempts + 1;
      const errMsg =
        err instanceof Error
          ? err.message.slice(0, 500)
          : String(err).slice(0, 500);

      if (nextAttempts >= row.max_attempts) {
        await env.DB.prepare(
          `UPDATE email_outbox
           SET status = 'failed', attempts = ?, last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
          .bind(nextAttempts, errMsg, nowIso, row.id)
          .run();
        summary.failed++;
      } else {
        const backoffSec = Math.min(3600, 60 * 2 ** (nextAttempts - 1));
        const nextAt = new Date(nowMs + backoffSec * 1000).toISOString();
        await env.DB.prepare(
          `UPDATE email_outbox
           SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
          .bind(nextAttempts, nextAt, errMsg, nowIso, row.id)
          .run();
        summary.retried++;
      }
    }
  }

  return summary;
}
