import { AppError } from "./errors.ts";

export interface CursorPayload {
  t: string;
  id: string;
}

function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(token: string): string {
  const padded = token.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLen));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export function encodeCursor(payload: CursorPayload): string {
  return toBase64Url(JSON.stringify({ t: payload.t, id: payload.id }));
}

export function decodeCursor(raw: string): CursorPayload {
  if (!raw || raw.length > 512) {
    throw new AppError(400, "INVALID_CURSOR", "Invalid pagination cursor.");
  }
  try {
    const parsed = JSON.parse(fromBase64Url(raw)) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).t !== "string" ||
      typeof (parsed as Record<string, unknown>).id !== "string"
    ) {
      throw new Error("shape");
    }
    const { t, id } = parsed as CursorPayload;
    if (!t || !id || Number.isNaN(Date.parse(t))) {
      throw new Error("values");
    }
    return { t, id };
  } catch {
    throw new AppError(400, "INVALID_CURSOR", "Malformed pagination cursor.");
  }
}
