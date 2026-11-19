const required = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CF_WORKER_NAME",
  "CF_SITE_URL",
  "CF_ALLOWED_ORIGINS",
  "CF_COMMENTS_DOMAIN",
  "CF_D1_DATABASE_NAME",
  "CF_D1_DATABASE_ID",
  "CF_MODERATION_MODE",
  "CF_MAX_CONTENT_LENGTH",
  "CF_GRAVATAR_ENABLED",
  "CF_ADMIN_EMAIL_PROVIDER",
  "CF_REPLY_EMAIL_PROVIDER",
];

const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  throw new Error(`Missing production settings: ${missing.join(", ")}.`);
}

const {
  CLOUDFLARE_ACCOUNT_ID: account,
  CLOUDFLARE_API_TOKEN: token,
  CF_WORKER_NAME: worker,
  CF_SITE_URL: site,
  CF_ALLOWED_ORIGINS: origins,
  CF_COMMENTS_DOMAIN: domain,
  CF_D1_DATABASE_ID: databaseId,
  CF_MODERATION_MODE: moderation,
  CF_MAX_CONTENT_LENGTH: maxLength,
  CF_GRAVATAR_ENABLED: gravatar,
  CF_ADMIN_EMAIL_PROVIDER: adminProvider,
  CF_REPLY_EMAIL_PROVIDER: replyProvider,
  CF_EMAIL_FROM: from,
  CF_ADMIN_NOTIFY_EMAIL: adminEmail,
  CF_EMAIL_HTTP_ENDPOINT: emailEndpoint,
} = process.env;

function isHttpsOrigin(value) {
  const url = URL.parse(value);
  return url?.protocol === "https:" && url.origin === value;
}

const allowedOrigins = origins.split(",").map((origin) => origin.trim());
if (
  !/^[a-f0-9]{32}$/i.test(account) ||
  !/^[a-z0-9][a-z0-9-]*$/.test(worker) ||
  !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain) ||
  !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(databaseId) ||
  !allowedOrigins.every(isHttpsOrigin) ||
  !allowedOrigins.includes(site) ||
  !["pre", "post"].includes(moderation) ||
  !/^\d+$/.test(maxLength) ||
  Number(maxLength) < 100 ||
  Number(maxLength) > 10000 ||
  !["true", "false"].includes(gravatar) ||
  !["none", "cf_email_routing", "resend", "http"].includes(adminProvider) ||
  !["none", "resend", "http"].includes(replyProvider) ||
  (adminProvider === "cf_email_routing" && !adminEmail?.trim()) ||
  ((adminProvider !== "none" || replyProvider !== "none") && !from?.trim()) ||
  ((adminProvider === "http" || replyProvider === "http") &&
    URL.parse(emailEndpoint ?? "")?.protocol !== "https:")
) {
  throw new Error(
    "Invalid production settings; check the deployment variables.",
  );
}

async function cloudflare(path) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not verify production bindings (HTTP ${response.status}).`,
    );
  }
  const data = await response.json();
  if (!data.success)
    throw new Error("Cloudflare could not verify production bindings.");
  return data.result;
}

const [settings, domains] = await Promise.all([
  cloudflare(`/workers/scripts/${worker}/settings`),
  cloudflare(`/workers/domains?${new URLSearchParams({ service: worker })}`),
]);
const database = settings?.bindings?.find(({ name }) => name === "DB");
if (
  database?.type !== "d1" ||
  (database.id ?? database.database_id) !== databaseId
) {
  throw new Error("Configured D1 must match the existing Worker's DB binding.");
}
if (
  !Array.isArray(domains) ||
  domains.length !== 1 ||
  domains[0].hostname !== domain ||
  domains[0].service !== worker
) {
  throw new Error(
    "Configured domain must match the existing Worker's sole custom domain.",
  );
}
console.log("Validated the existing Worker, production D1, and custom domain.");
