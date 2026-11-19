import type { SendEmailBindingLike } from "../email/providers.ts";
import { isSafeHttpUrl } from "../markdown/sanitize-schema.ts";
import type {
  AdminEmailProviderKind,
  ModerationMode,
  ReplyEmailProviderKind,
} from "../shared/types.ts";

export interface RateLimiterBindingLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface WorkerEnv {
  DB: D1Database;
  SEND_EMAIL?: SendEmailBindingLike;
  RATE_LIMIT_SUBMIT?: RateLimiterBindingLike;
  RATE_LIMIT_PREVIEW?: RateLimiterBindingLike;

  // Public vars
  SITE_URL?: string;
  ALLOWED_ORIGINS?: string;
  MODERATION_MODE?: string;
  MAX_CONTENT_LENGTH?: string;
  GRAVATAR_ENABLED?: string;
  MISSKEY_INSTANCE_URL?: string;
  TURNSTILE_SITE_KEY?: string;
  ADMIN_EMAIL_PROVIDER?: string;
  REPLY_EMAIL_PROVIDER?: string;
  EMAIL_FROM?: string;
  ADMIN_NOTIFY_EMAIL?: string;
  EMAIL_HTTP_ENDPOINT?: string;

  // Secrets
  ADMIN_TOKEN?: string;
  TOKEN_SIGNING_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  EMAIL_HTTP_TOKEN?: string;
}

export interface RuntimeConfig {
  siteUrl: string;
  allowedOrigins: Set<string>;
  moderationMode: ModerationMode;
  maxContentLength: number;
  gravatarEnabled: boolean;
  misskeyInstanceUrl: string | null;
  turnstileSiteKey: string | null;
  turnstileSecretKey: string | null;
  adminEmailProvider: AdminEmailProviderKind;
  replyEmailProvider: ReplyEmailProviderKind;
  emailFrom: string;
  adminNotifyEmail: string | null;
  emailHttpEndpoint: string | null;
  tokenSigningSecret: string;
}

export function parseModerationMode(raw: string | undefined): ModerationMode {
  return raw === "post" ? "post" : "pre";
}

export function parseMaxContentLength(
  raw: string | number | undefined,
  fallback = 3000,
): number {
  const parsed =
    typeof raw === "number"
      ? raw
      : Number.parseInt(raw || String(fallback), 10);
  return Number.isFinite(parsed) && parsed >= 100 && parsed <= 10000
    ? parsed
    : fallback;
}

export function parseAdminEmailProvider(
  raw: string | undefined,
): AdminEmailProviderKind {
  return raw === "cf_email_routing" || raw === "resend" || raw === "http"
    ? raw
    : "none";
}

export function parseReplyEmailProvider(
  raw: string | undefined,
): ReplyEmailProviderKind {
  return raw === "resend" || raw === "http" ? raw : "none";
}

export function parseRuntimeConfig(env: WorkerEnv): RuntimeConfig {
  const siteUrl = (env.SITE_URL || "https://example.com").replace(/\/$/, "");
  const allowedOrigins = new Set(
    (env.ALLOWED_ORIGINS || siteUrl)
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );

  const moderationMode = parseModerationMode(env.MODERATION_MODE);
  const maxContentLength = parseMaxContentLength(env.MAX_CONTENT_LENGTH);

  const misskeyRaw = env.MISSKEY_INSTANCE_URL?.trim();
  const misskeyInstanceUrl = misskeyRaw
    ? (isSafeHttpUrl(misskeyRaw)?.replace(/\/$/, "") ?? null)
    : null;

  const adminEmailProvider = parseAdminEmailProvider(env.ADMIN_EMAIL_PROVIDER);
  const replyEmailProvider = parseReplyEmailProvider(env.REPLY_EMAIL_PROVIDER);

  return {
    siteUrl,
    allowedOrigins,
    moderationMode,
    maxContentLength,
    gravatarEnabled: env.GRAVATAR_ENABLED === "true",
    misskeyInstanceUrl,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY?.trim() || null,
    turnstileSecretKey: env.TURNSTILE_SECRET_KEY?.trim() || null,
    adminEmailProvider,
    replyEmailProvider,
    emailFrom: env.EMAIL_FROM?.trim() || "comments@example.com",
    adminNotifyEmail: env.ADMIN_NOTIFY_EMAIL?.trim() || null,
    emailHttpEndpoint: env.EMAIL_HTTP_ENDPOINT?.trim() || null,
    tokenSigningSecret:
      env.TOKEN_SIGNING_SECRET?.trim() ||
      env.ADMIN_TOKEN?.trim() ||
      "dev-insecure-default-secret",
  };
}
