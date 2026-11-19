import { AppError } from "../shared/errors.ts";
import { constantTimeEqual, hmacSha256Hex } from "../shared/id.ts";
import type { RuntimeConfig, WorkerEnv } from "./env.ts";

export function buildCorsHeaders(
  request: Request,
  cfg: RuntimeConfig,
  isAdminRoute: boolean,
): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  if (!origin) {
    return headers;
  }

  const reqOrigin = new URL(request.url).origin;
  const isSameOrigin = origin === reqOrigin;

  if (isAdminRoute) {
    if (isSameOrigin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
    }
    return headers;
  }

  if (isSameOrigin || cfg.allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "600");
  }

  return headers;
}

export function requireAdminAuth(request: Request, env: WorkerEnv): void {
  const configuredToken = env.ADMIN_TOKEN?.trim();
  if (!configuredToken) {
    throw new AppError(
      500,
      "INTERNAL_ERROR",
      "Admin authentication is not configured.",
    );
  }

  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Admin API requires same-origin access.",
    );
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token || !constantTimeEqual(token, configuredToken)) {
    throw new AppError(401, "UNAUTHORIZED", "Invalid or missing admin token.");
  }
}

export async function enforceRateLimit(
  request: Request,
  env: WorkerEnv,
  cfg: RuntimeConfig,
  bucket: "submit" | "preview",
): Promise<void> {
  const limiter =
    bucket === "submit" ? env.RATE_LIMIT_SUBMIT : env.RATE_LIMIT_PREVIEW;
  if (!limiter) return;

  // Never persist raw IP; derive an ephemeral per-route HMAC key
  const rawIp =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown";
  const key = await hmacSha256Hex(cfg.tokenSigningSecret, `${bucket}:${rawIp}`);
  const outcome = await limiter.limit({ key });
  if (!outcome.success) {
    throw new AppError(
      429,
      "RATE_LIMITED",
      "Too many requests. Please try again later.",
      { retry_after_seconds: 60 },
    );
  }
}

export async function verifyTurnstileIfEnabled(
  request: Request,
  cfg: RuntimeConfig,
  token: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!cfg.turnstileSiteKey || !cfg.turnstileSecretKey) {
    return;
  }
  const trimmed = token?.trim();
  if (!trimmed) {
    throw new AppError(
      400,
      "TURNSTILE_FAILED",
      "Turnstile verification token is required.",
    );
  }

  const form = new URLSearchParams();
  form.set("secret", cfg.turnstileSecretKey);
  form.set("response", trimmed);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) {
    form.set("remoteip", ip);
  }

  const res = await fetchImpl(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      body: form,
    },
  );
  if (!res.ok) {
    throw new AppError(
      400,
      "TURNSTILE_FAILED",
      "Turnstile verification service error.",
    );
  }

  const data = (await res.json()) as { success?: boolean };
  if (!data.success) {
    throw new AppError(
      400,
      "TURNSTILE_FAILED",
      "Turnstile verification failed.",
    );
  }
}

const MAX_BODY_BYTES = 32 * 1024;

export async function readJsonBody<T>(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<T> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    const num = Number.parseInt(contentLength, 10);
    if (Number.isFinite(num) && num > maxBytes) {
      throw new AppError(
        413,
        "PAYLOAD_TOO_LARGE",
        `Request body exceeds ${maxBytes} bytes.`,
      );
    }
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new AppError(
      413,
      "PAYLOAD_TOO_LARGE",
      `Request body exceeds ${maxBytes} bytes.`,
    );
  }

  const text = new TextDecoder().decode(buf);
  if (!text.trim()) {
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Request body must be valid JSON.",
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError(400, "INVALID_INPUT", "Malformed JSON request body.");
  }
}
