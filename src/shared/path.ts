import { AppError } from "./errors.ts";

const MAX_PATH_BYTES = 512;
const CANONICAL_PATH_RE = /^\/(?:[^/?#]+\/)*$/;

/**
 * Normalize and validate an explicit site-relative thread path.
 *
 * Rules:
 * - Must begin with '/'
 * - Rejects query ('?'), hash ('#'), backslashes, control chars, consecutive '//', and '.'/'..' segments
 * - Preserves case sensitivity
 * - Enforces trailing '/' ('/' stays '/', '/about' -> '/about/')
 */
export function normalizePath(raw: string): string {
  if (typeof raw !== "string") {
    throw new AppError(400, "INVALID_PATH", "Path must be a string.");
  }

  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) {
    throw new AppError(400, "INVALID_PATH", "Path must start with '/'.");
  }

  if (trimmed.includes("?") || trimmed.includes("#")) {
    throw new AppError(
      400,
      "INVALID_PATH",
      "Path must not contain query string or fragment.",
    );
  }

  if (trimmed.includes("\\") || trimmed.includes("//")) {
    throw new AppError(
      400,
      "INVALID_PATH",
      "Path must not contain backslashes or consecutive slashes.",
    );
  }

  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      throw new AppError(
        400,
        "INVALID_PATH",
        "Path must not contain control characters.",
      );
    }
  }

  const normalized = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;

  if (new TextEncoder().encode(normalized).byteLength > MAX_PATH_BYTES) {
    throw new AppError(
      400,
      "INVALID_PATH",
      `Path exceeds maximum length of ${MAX_PATH_BYTES} bytes.`,
    );
  }

  const segments = normalized.split("/").filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      throw new AppError(
        400,
        "INVALID_PATH",
        "Path must not contain relative traversal segments.",
      );
    }
  }

  if (!CANONICAL_PATH_RE.test(normalized)) {
    throw new AppError(400, "INVALID_PATH", "Path format is invalid.");
  }

  return normalized;
}

/**
 * Validate an optional http(s) URL (author website, image URL, etc.).
 * Returns normalized href or null if empty.
 */
export function normalizeHttpUrl(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > 512) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "URL exceeds maximum length of 512 characters.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid URL format.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Only http:// and https:// URLs are allowed.",
    );
  }
  return parsed.toString();
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.length > 254) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Email exceeds maximum length of 254 characters.",
    );
  }
  // Pragmatic RFC-compatible email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid email address.");
  }
  return trimmed;
}
