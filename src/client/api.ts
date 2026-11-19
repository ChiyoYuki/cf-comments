import type { ApiErrorBody } from "../shared/types.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function httpUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return !url.username &&
      !url.password &&
      ["https:", "http:"].includes(url.protocol)
      ? url
      : null;
  } catch {
    return null;
  }
}

type Options = {
  method?: "GET" | "POST" | "PATCH";
  query?: Record<string, string | number | boolean | null>;
  body?: unknown;
  signal?: AbortSignal;
  token?: string;
};

export function createApi(base: URL, request: typeof fetch = fetch) {
  async function send(path: string, options: Options): Promise<Response> {
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new Error("Unexpected API origin.");
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== null) url.searchParams.set(key, String(value));
    }
    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined)
      headers.set("Content-Type", "application/json");
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
    const response = await request(url, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      const body = (await response
        .json()
        .catch(() => null)) as ApiErrorBody | null;
      throw new ApiError(
        response.status,
        body?.error?.code ?? "REQUEST_FAILED",
        body?.error?.message ?? `HTTP ${response.status}`,
        body?.error?.details,
      );
    }
    return response;
  }
  return {
    async json<Data>(path: string, options: Options = {}): Promise<Data> {
      return (await send(path, options)).json();
    },
    async empty(path: string, options: Options): Promise<void> {
      await send(path, options);
    },
  };
}

export type Api = ReturnType<typeof createApi>;

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
