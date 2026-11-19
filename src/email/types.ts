export type OutboxKind =
  | "admin_new_comment"
  | "reply_approved"
  | "verify_email";

export interface EmailMessageInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  meta?: Record<string, string>;
}

export interface EmailOutboxRow {
  id: string;
  dedupe_key: string;
  kind: OutboxKind;
  recipient_email: string;
  payload_json: string;
  status: "pending" | "sent" | "failed" | "skipped";
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminNewCommentPayload {
  comment_id: string;
  path: string;
  status: string;
  author_name: string | null;
  content_markdown: string;
  site_url: string;
  admin_url: string;
}

export interface ReplyApprovedPayload {
  reply_id: string;
  parent_id: string;
  path: string;
  reply_author_name: string | null;
  reply_content_markdown: string;
  site_url: string;
  unsubscribe_url: string;
}

export interface VerifyEmailPayload {
  site_url: string;
  verify_url: string;
  unsubscribe_url: string;
}
