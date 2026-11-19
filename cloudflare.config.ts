import { bindings, defineConfig, triggers } from "@cloudflare/config";
import { loadProjectConfig } from "./src/config/load-config.ts";

export default defineConfig(({ mode }) => {
  const cfg = loadProjectConfig();
  const isStaging = mode === "staging";
  const d1Name = isStaging ? cfg.d1StagingDatabaseName : cfg.d1DatabaseName;
  const d1Id = isStaging ? cfg.d1StagingDatabaseId : cfg.d1DatabaseId;
  const domain = isStaging ? cfg.stagingDomain : cfg.commentsDomain;
  const allowedOrigins = isStaging
    ? [
        ...new Set([
          ...cfg.allowedOrigins,
          "http://localhost:4321",
          "http://127.0.0.1:4321",
        ]),
      ]
    : cfg.allowedOrigins;

  return {
    worker: {
      name: isStaging ? cfg.stagingWorkerName : cfg.workerName,
      compatibilityDate: "2026-10-01",
      entrypoint: "./src/worker/index.ts",
      ...(domain ? { domains: [domain] } : {}),
      assets: {
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "none",
        runWorkerFirst: ["/v1/*"],
      },
      triggers: [
        // Retry pending email_outbox jobs every 5 minutes
        triggers.scheduled({ schedule: "*/5 * * * *" }),
      ],
      env: {
        DB: bindings.d1({
          name: d1Name,
          ...(d1Id ? { id: d1Id } : {}),
        }),
        ...(cfg.email.adminProvider === "cf_email_routing" &&
        cfg.email.adminNotifyEmail
          ? {
              SEND_EMAIL: bindings.sendEmail({
                destinationAddress: cfg.email.adminNotifyEmail,
              }),
            }
          : {}),
        SITE_URL: bindings.text(cfg.siteUrl),
        ALLOWED_ORIGINS: bindings.text(allowedOrigins.join(",")),
        MODERATION_MODE: bindings.text(cfg.moderationMode),
        MAX_CONTENT_LENGTH: bindings.text(String(cfg.maxContentLength)),
        MISSKEY_INSTANCE_URL: bindings.text(cfg.misskeyInstanceUrl),
        TURNSTILE_SITE_KEY: bindings.text(cfg.turnstileSiteKey),
        ADMIN_EMAIL_PROVIDER: bindings.text(cfg.email.adminProvider),
        REPLY_EMAIL_PROVIDER: bindings.text(cfg.email.replyProvider),
        EMAIL_FROM: bindings.text(cfg.email.from),
        ADMIN_NOTIFY_EMAIL: bindings.text(cfg.email.adminNotifyEmail),
        EMAIL_HTTP_ENDPOINT: bindings.text(cfg.email.httpEndpoint),
        ADMIN_TOKEN: bindings.secret(),
        TOKEN_SIGNING_SECRET: bindings.secret(),
        ...(cfg.turnstileSiteKey
          ? { TURNSTILE_SECRET_KEY: bindings.secret() }
          : {}),
        ...(cfg.email.adminProvider === "resend" ||
        cfg.email.replyProvider === "resend"
          ? { RESEND_API_KEY: bindings.secret() }
          : {}),
        ...(cfg.email.adminProvider === "http" ||
        cfg.email.replyProvider === "http"
          ? { EMAIL_HTTP_TOKEN: bindings.secret() }
          : {}),
      },
    },
  };
});
