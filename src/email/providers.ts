import type { EmailMessageInput } from "./types.ts";

function toBase64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function encodeMimeHeader(value: string): string {
  // Strip CR/LF to prevent header injection
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(clean)) {
    return clean;
  }
  return `=?UTF-8?B?${toBase64Utf8(clean)}?=`;
}

function wrapBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

/**
 * Build a minimal RFC 5322 multipart/alternative MIME message suitable for
 * Cloudflare Workers `send_email` binding.
 */
export function buildMimeMessage(input: EmailMessageInput): string {
  const boundary = `cc_${crypto.randomUUID().replace(/-/g, "")}`;
  const fromClean = input.from.replace(/[\r\n]+/g, "").trim();
  const toClean = input.to.replace(/[\r\n]+/g, "").trim();
  const domain = fromClean.includes("@")
    ? (fromClean.split("@")[1] ?? "localhost")
    : "localhost";
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const date = new Date().toUTCString();

  return [
    `From: ${fromClean}`,
    `To: ${toClean}`,
    `Subject: ${encodeMimeHeader(input.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(toBase64Utf8(input.text)),
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(toBase64Utf8(input.html)),
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export interface SendEmailBindingLike {
  send(message: unknown): Promise<void>;
}

export type EmailMessageFactory = (
  from: string,
  to: string,
  rawMime: string,
) => Promise<unknown>;

async function defaultEmailMessageFactory(
  from: string,
  to: string,
  rawMime: string,
): Promise<unknown> {
  const mod = await import("cloudflare:email");
  return new mod.EmailMessage(from, to, rawMime);
}

export async function sendViaCloudflareEmailRouting(
  binding: SendEmailBindingLike,
  input: EmailMessageInput,
  factory: EmailMessageFactory = defaultEmailMessageFactory,
): Promise<void> {
  const rawMime = buildMimeMessage(input);
  const message = await factory(input.from, input.to, rawMime);
  await binding.send(message);
}

export async function sendViaResend(
  apiKey: string,
  input: EmailMessageInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: input.from,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      html: input.html,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `Resend API failed (${response.status}): ${bodyText.slice(0, 300)}`,
    );
  }
}

export async function sendViaHttpEndpoint(
  endpoint: string,
  token: string | undefined,
  input: EmailMessageInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Invalid EMAIL_HTTP_ENDPOINT URL.");
  }
  const isLocal =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (
    parsed.protocol !== "https:" &&
    !(isLocal && parsed.protocol === "http:")
  ) {
    throw new Error("EMAIL_HTTP_ENDPOINT must use https://.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetchImpl(parsed.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify({
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      meta: input.meta ?? {},
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `HTTP email endpoint failed (${response.status}): ${bodyText.slice(0, 300)}`,
    );
  }
}
