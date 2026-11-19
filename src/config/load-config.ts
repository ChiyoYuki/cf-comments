import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ProjectEmailConfig {
  adminProvider: "cf_email_routing" | "resend" | "http" | "none";
  replyProvider: "resend" | "http" | "none";
  from: string;
  adminNotifyEmail: string;
  httpEndpoint: string;
}

export interface ProjectConfig {
  workerName: string;
  stagingWorkerName: string;
  siteUrl: string;
  allowedOrigins: string[];
  commentsDomain: string;
  stagingDomain: string;
  d1DatabaseName: string;
  d1DatabaseId: string;
  d1StagingDatabaseName: string;
  d1StagingDatabaseId: string;
  moderationMode: "pre" | "post";
  maxContentLength: number;
  misskeyInstanceUrl: string;
  turnstileSiteKey: string;
  email: ProjectEmailConfig;
}

const DEFAULT_CONFIG: ProjectConfig = {
  workerName: "cf-comments",
  stagingWorkerName: "cf-comments-staging",
  siteUrl: "https://example.com",
  allowedOrigins: ["https://example.com"],
  commentsDomain: "",
  stagingDomain: "",
  d1DatabaseName: "cf-comments",
  d1DatabaseId: "",
  d1StagingDatabaseName: "cf-comments-staging",
  d1StagingDatabaseId: "",
  moderationMode: "pre",
  maxContentLength: 4000,
  misskeyInstanceUrl: "",
  turnstileSiteKey: "",
  email: {
    adminProvider: "none",
    replyProvider: "none",
    from: "comments@example.com",
    adminNotifyEmail: "",
    httpEndpoint: "",
  },
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

function parseOrigins(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  const list = raw
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

function readLocalConfigFile(
  configPath?: string,
): Partial<ProjectConfig> & { email?: Partial<ProjectEmailConfig> } {
  const targetPath = configPath
    ? path.resolve(configPath)
    : process.env.CF_COMMENTS_CONFIG
      ? path.resolve(process.env.CF_COMMENTS_CONFIG)
      : path.join(PROJECT_ROOT, "cf-comments.config.json");

  if (!existsSync(targetPath)) {
    return {};
  }

  const raw = readFileSync(targetPath, "utf8");
  return JSON.parse(raw) as Partial<ProjectConfig> & {
    email?: Partial<ProjectEmailConfig>;
  };
}

/**
 * Load unified non-sensitive project configuration from `cf-comments.config.json`
 * (gitignored) with `CF_*` environment variable overrides for CI/CD.
 */
export function loadProjectConfig(configPath?: string): ProjectConfig {
  const file = readLocalConfigFile(configPath);
  const env = process.env;

  const siteUrl = (
    env.CF_SITE_URL ||
    file.siteUrl ||
    DEFAULT_CONFIG.siteUrl
  ).replace(/\/$/, "");

  const fileOrigins =
    Array.isArray(file.allowedOrigins) && file.allowedOrigins.length > 0
      ? file.allowedOrigins
          .map((s) => s.trim().replace(/\/$/, ""))
          .filter(Boolean)
      : [siteUrl];

  const adminProviderRaw =
    env.CF_ADMIN_EMAIL_PROVIDER ||
    file.email?.adminProvider ||
    DEFAULT_CONFIG.email.adminProvider;
  const adminProvider =
    adminProviderRaw === "cf_email_routing" ||
    adminProviderRaw === "resend" ||
    adminProviderRaw === "http"
      ? adminProviderRaw
      : "none";

  const replyProviderRaw =
    env.CF_REPLY_EMAIL_PROVIDER ||
    file.email?.replyProvider ||
    DEFAULT_CONFIG.email.replyProvider;
  const replyProvider =
    replyProviderRaw === "resend" || replyProviderRaw === "http"
      ? replyProviderRaw
      : "none";

  const moderationRaw =
    env.CF_MODERATION_MODE ||
    file.moderationMode ||
    DEFAULT_CONFIG.moderationMode;
  const moderationMode = moderationRaw === "post" ? "post" : "pre";

  const maxLenRaw = env.CF_MAX_CONTENT_LENGTH
    ? Number.parseInt(env.CF_MAX_CONTENT_LENGTH, 10)
    : (file.maxContentLength ?? DEFAULT_CONFIG.maxContentLength);
  const maxContentLength =
    Number.isFinite(maxLenRaw) && maxLenRaw >= 100 && maxLenRaw <= 10000
      ? maxLenRaw
      : DEFAULT_CONFIG.maxContentLength;

  return {
    workerName:
      env.CF_WORKER_NAME || file.workerName || DEFAULT_CONFIG.workerName,
    stagingWorkerName:
      env.CF_STAGING_WORKER_NAME ||
      file.stagingWorkerName ||
      DEFAULT_CONFIG.stagingWorkerName,
    siteUrl,
    allowedOrigins: parseOrigins(env.CF_ALLOWED_ORIGINS, fileOrigins),
    commentsDomain:
      env.CF_COMMENTS_DOMAIN ??
      file.commentsDomain ??
      DEFAULT_CONFIG.commentsDomain,
    stagingDomain:
      env.CF_STAGING_DOMAIN ??
      file.stagingDomain ??
      DEFAULT_CONFIG.stagingDomain,
    d1DatabaseName:
      env.CF_D1_DATABASE_NAME ||
      file.d1DatabaseName ||
      DEFAULT_CONFIG.d1DatabaseName,
    d1DatabaseId:
      env.CF_D1_DATABASE_ID ?? file.d1DatabaseId ?? DEFAULT_CONFIG.d1DatabaseId,
    d1StagingDatabaseName:
      env.CF_D1_STAGING_DATABASE_NAME ||
      file.d1StagingDatabaseName ||
      DEFAULT_CONFIG.d1StagingDatabaseName,
    d1StagingDatabaseId:
      env.CF_D1_STAGING_DATABASE_ID ??
      file.d1StagingDatabaseId ??
      DEFAULT_CONFIG.d1StagingDatabaseId,
    moderationMode,
    maxContentLength,
    misskeyInstanceUrl: (
      env.CF_MISSKEY_INSTANCE_URL ??
      file.misskeyInstanceUrl ??
      DEFAULT_CONFIG.misskeyInstanceUrl
    ).replace(/\/$/, ""),
    turnstileSiteKey:
      env.CF_TURNSTILE_SITE_KEY ??
      file.turnstileSiteKey ??
      DEFAULT_CONFIG.turnstileSiteKey,
    email: {
      adminProvider,
      replyProvider,
      from: env.CF_EMAIL_FROM || file.email?.from || DEFAULT_CONFIG.email.from,
      adminNotifyEmail:
        env.CF_ADMIN_NOTIFY_EMAIL ??
        file.email?.adminNotifyEmail ??
        DEFAULT_CONFIG.email.adminNotifyEmail,
      httpEndpoint:
        env.CF_EMAIL_HTTP_ENDPOINT ??
        file.email?.httpEndpoint ??
        DEFAULT_CONFIG.email.httpEndpoint,
    },
  };
}
