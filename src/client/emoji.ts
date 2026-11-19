import { httpUrl } from "./api.ts";

export function createEmojiResolver(
  instance: string | null,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const origin = httpUrl(instance);
  const cache = new Map<string, Promise<string | null>>();
  let active = 0;
  const waiting: (() => void)[] = [];

  async function lookup(name: string): Promise<string | null> {
    if (!origin || signal.aborted) return null;
    if (active >= 4)
      await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      if (signal.aborted) return null;
      const response = await request(new URL("/api/emoji", origin), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { url?: unknown } | null;
      return httpUrl(data?.url)?.href ?? null;
    } catch {
      return null;
    } finally {
      active--;
      waiting.shift()?.();
    }
  }

  return (name: string): Promise<string | null> => {
    if (!/^[a-z0-9_]{1,128}$/i.test(name) || signal.aborted)
      return Promise.resolve(null);
    const cached = cache.get(name);
    if (cached) return cached;
    if (cache.size >= 256) return Promise.resolve(null);
    const pending = lookup(name);
    cache.set(name, pending);
    return pending;
  };
}
