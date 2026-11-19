import { bindings, defineConfig, triggers } from "@cloudflare/config";

export default defineConfig(({ mode }) => {
  const isStaging = mode === "staging";
  const siteUrl = process.env.CF_SITE_URL || "https://blog.chiyo.uk";
  const allowedOrigins =
    process.env.CF_ALLOWED_ORIGINS ||
    (isStaging ? `${siteUrl},http://localhost:4321` : siteUrl);
  const adminNotifyEmail = process.env.CF_ADMIN_NOTIFY_EMAIL || "";
  const adminEmailProvider = process.env.CF_ADMIN_EMAIL_PROVIDER || "none";
  const replyEmailProvider = process.env.CF_REPLY_EMAIL_PROVIDER || "none";
  const d1Id = isStaging
    ? process.env.CF_D1_STAGING_DATABASE_ID
    : process.env.CF_D1_DATABASE_ID;
  const d1Name = isStaging ? "cf-comments-staging" : "cf-comments";
  const prodDomain = process.env.CF_COMMENTS_DOMAIN || "comments.chiyo.uk";
  const stagingDomain = process.env.CF_STAGING_DOMAIN || "";

  const domains = isStaging
    ? stagingDomain
      ? [stagingDomain]
      : undefined
    : [prodDomain];

  return {
    worker: {
      name: isStaging ? "cf-comments-staging" : "cf-comments",
      compatibilityDate: "2026-10-01",
      entrypoint: "./src/worker/index.ts",
      ...(domains ? { domains } : {}),
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
        ...(adminEmailProvider === "cf_email_routing" && adminNotifyEmail
          ? {
              SEND_EMAIL: bindings.sendEmail({
                destinationAddress: adminNotifyEmail,
              }),
            }
          : {}),
        SITE_URL: bindings.text(siteUrl),
        ALLOWED_ORIGINS: bindings.text(allowedOrigins),
        MODERATION_MODE: bindings.text(process.env.CF_MODERATION_MODE || "pre"),
        MAX_CONTENT_LENGTH: bindings.text(
          process.env.CF_MAX_CONTENT_LENGTH || "4000",
        ),
        TURNSTILE_SITE_KEY: bindings.text(
          process.env.CF_TURNSTILE_SITE_KEY || "",
        ),
        ADMIN_EMAIL_PROVIDER: bindings.text(adminEmailProvider),
        REPLY_EMAIL_PROVIDER: bindings.text(replyEmailProvider),
        EMAIL_FROM: bindings.text(
          process.env.CF_EMAIL_FROM || "comments@chiyo.uk",
        ),
        ADMIN_NOTIFY_EMAIL: bindings.text(adminNotifyEmail),
        EMAIL_HTTP_ENDPOINT: bindings.text(
          process.env.CF_EMAIL_HTTP_ENDPOINT || "",
        ),
        ADMIN_TOKEN: bindings.secret(),
        TOKEN_SIGNING_SECRET: bindings.secret(),
        TURNSTILE_SECRET_KEY: bindings.secret(),
        RESEND_API_KEY: bindings.secret(),
        EMAIL_HTTP_TOKEN: bindings.secret(),
      },
    },
  };
});
