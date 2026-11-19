export type CommentStatus =
  | "approved"
  | "pending"
  | "hidden"
  | "spam"
  | "deleted";

export type CommentSyntax = "gfm" | "mfm";

export type PlaceholderReason = "hidden" | "deleted";

export type ModerationMode = "pre" | "post";

export type AdminEmailProviderKind =
  | "cf_email_routing"
  | "resend"
  | "http"
  | "none";

export type ReplyEmailProviderKind = "resend" | "http" | "none";

export type ErrorCode =
  | "INVALID_PATH"
  | "INVALID_INPUT"
  | "VALIDATION_ERROR"
  | "PAYLOAD_TOO_LARGE"
  | "COMMENT_NOT_FOUND"
  | "PARENT_NOT_FOUND"
  | "PARENT_PATH_MISMATCH"
  | "INVALID_CURSOR"
  | "INVALID_STATE_TRANSITION"
  | "HAS_CHILD_COMMENTS"
  | "SPAM_DETECTED"
  | "TURNSTILE_FAILED"
  | "RATE_LIMITED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INTERNAL_ERROR";

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface PublicConfig {
  version: "1";
  site_url: string;
  moderation_mode: ModerationMode;
  max_content_length: number;
  allow_anonymous: true;
  allow_remote_images: true;
  allow_image_upload: false;
  reply_notify_enabled: boolean;
  misskey_instance_url: string | null;
  markdown: {
    syntax_modes: readonly CommentSyntax[];
    default_syntax: CommentSyntax;
    gfm: true;
    mfm: true;
    mfm_functions: readonly string[];
    max_nesting_depth: number;
  };
  turnstile_site_key: string | null;
}

export interface PublicComment {
  id: string;
  path: string;
  parent_id: string | null;
  root_id: string | null;
  is_placeholder: boolean;
  placeholder_reason: PlaceholderReason | null;
  syntax: CommentSyntax;
  author_name: string | null;
  author_url: string | null;
  avatar_hue: number | null;
  is_admin: boolean;
  content_html: string | null;
  reply_to_author: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommentThread extends PublicComment {
  reply_count: number;
  replies: PublicComment[];
  replies_next_cursor: string | null;
}

export interface CommentThreadPage {
  path: string;
  total_approved: number;
  items: CommentThread[];
  next_cursor: string | null;
}

export interface ReplyPage {
  root_id: string;
  items: PublicComment[];
  next_cursor: string | null;
}

export interface CreateCommentRequest {
  path: string;
  parent_id?: string | null;
  author_name?: string | null;
  author_email?: string | null;
  author_url?: string | null;
  notify_on_reply?: boolean;
  syntax?: CommentSyntax;
  content: string;
  honeypot?: string | null;
  turnstile_token?: string | null;
}

export interface CreateCommentResponse {
  id: string;
  path: string;
  parent_id: string | null;
  root_id: string | null;
  status: "approved" | "pending";
  verification_queued: boolean;
  comment: PublicComment | null;
}

export interface AdminComment {
  id: string;
  path: string;
  parent_id: string | null;
  root_id: string | null;
  status: CommentStatus;
  author_name: string | null;
  author_email: string | null;
  author_url: string | null;
  avatar_hue: number;
  is_admin: boolean;
  notify_on_reply: boolean;
  syntax: CommentSyntax;
  content_markdown: string | null;
  content_html: string | null;
  import_source: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminCommentCounts {
  approved: number;
  pending: number;
  hidden: number;
  spam: number;
  deleted: number;
}

export interface AdminCommentPage {
  items: AdminComment[];
  counts: AdminCommentCounts;
  next_cursor: string | null;
}

export interface AdminUpdateCommentRequest {
  status: CommentStatus;
  hard_delete?: boolean;
}

export interface AdminCreateCommentRequest {
  path: string;
  parent_id?: string | null;
  author_name?: string;
  author_url?: string | null;
  syntax?: CommentSyntax;
  content: string;
}

export interface ExportPathAlias {
  alias_path: string;
  canonical_path: string;
}

export interface ExportComment {
  id: string;
  path: string;
  parent_id: string | null;
  status: CommentStatus;
  syntax?: CommentSyntax;
  author_name?: string | null;
  author_url?: string | null;
  author_email?: string | null;
  is_admin: boolean;
  content_markdown: string | null;
  created_at: string;
  updated_at?: string;
  source?: {
    system: string;
    external_id: string;
  };
}

export interface CanonicalExport {
  format: "cf-comments";
  version: 1;
  exported_at: string;
  site?: string;
  include_private: boolean;
  path_aliases?: ExportPathAlias[];
  comments: ExportComment[];
}

export interface ImportReport {
  dry_run: boolean;
  total: number;
  inserted: number;
  skipped_existing: number;
  warnings: string[];
  errors: string[];
}

export interface CommentRow {
  id: string;
  path: string;
  parent_id: string | null;
  root_id: string | null;
  status: CommentStatus;
  author_name: string | null;
  author_email: string | null;
  author_url: string | null;
  avatar_hue: number;
  is_admin: number;
  notify_on_reply: number;
  syntax: CommentSyntax;
  content_markdown: string | null;
  content_html: string | null;
  import_source: string | null;
  import_external_id: string | null;
  created_at: string;
  updated_at: string;
}
