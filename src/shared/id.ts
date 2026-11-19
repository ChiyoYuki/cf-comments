const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generate a monotonically sortable ULID (26 chars, Crockford Base32).
 * Matches schema pattern ^[a-zA-Z0-9_-]{8,64}$.
 */
export function generateId(nowMs = Date.now()): string {
  let time = nowMs;
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = CROCKFORD[time % 32] ?? "0";
    time = Math.floor(time / 32);
  }

  const randBytes = new Uint8Array(10);
  crypto.getRandomValues(randBytes);
  let randBits = 0n;
  for (const b of randBytes) {
    randBits = (randBits << 8n) | BigInt(b);
  }

  const randChars = new Array<string>(16);
  for (let i = 15; i >= 0; i--) {
    randChars[i] = CROCKFORD[Number(randBits & 31n)] ?? "0";
    randBits >>= 5n;
  }

  return timeChars.join("") + randChars.join("");
}

/**
 * Generate a URL-safe cryptographically random token (256 bits).
 */
export function generateRandomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Compute deterministic 0..359 hue from author display name (never from raw email).
 * Anonymous authors get a random hue per comment.
 */
export function computeAvatarHue(authorName: string | null): number {
  if (!authorName) {
    const buf = new Uint16Array(1);
    crypto.getRandomValues(buf);
    return (buf[0] ?? 220) % 360;
  }
  let hash = 2166136261;
  for (let i = 0; i < authorName.length; i++) {
    hash ^= authorName.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 360;
}

export const AVATAR_HASH_RE = /^[0-9a-f]{64}$/;

export async function sha256Hex(message: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(message));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function buildGravatarUrl(
  avatarHash: string | null | undefined,
): string | null {
  if (!avatarHash || !AVATAR_HASH_RE.test(avatarHash)) {
    return null;
  }
  return `https://gravatar.com/avatar/${avatarHash}?s=96&d=404&r=g`;
}

export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
