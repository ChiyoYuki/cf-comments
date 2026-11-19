import { cleanupEmailOutbox, drainEmailOutbox } from "../email/outbox.ts";
import { AppError, errorResponse } from "../shared/errors.ts";
import { buildCorsHeaders } from "./auth.ts";
import { parseRuntimeConfig, type WorkerEnv } from "./env.ts";
import {
  handleAdminCreateComment,
  handleAdminExport,
  handleAdminImport,
  handleAdminListComments,
  handleAdminUpdateComment,
} from "./handlers/admin.ts";
import {
  handleCreateComment,
  handleGetConfig,
  handleListComments,
  handleListReplies,
  handlePreview,
} from "./handlers/public.ts";
import {
  handleGetUnsubscribePage,
  handleGetVerifyPage,
  handlePostUnsubscribe,
  handlePostVerify,
} from "./subscriptions.ts";

function applyHeaders(response: Response, extra: Headers): Response {
  let hasExtra = false;
  extra.forEach(() => {
    hasExtra = true;
  });
  if (!hasExtra) {
    return response;
  }
  const merged = new Headers(response.headers);
  extra.forEach((value, key) => {
    merged.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

async function routeApiRequest(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const cfg = parseRuntimeConfig(env);
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method.toUpperCase();
  const isAdminRoute = pathname.startsWith("/v1/admin/");
  const corsHeaders = buildCorsHeaders(request, cfg, isAdminRoute);

  if (method === "OPTIONS" && pathname.startsWith("/v1/")) {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    let response: Response;

    if (pathname === "/v1/config" && method === "GET") {
      response = handleGetConfig(cfg);
    } else if (pathname === "/v1/comments" && method === "GET") {
      response = await handleListComments(request, env);
    } else if (pathname === "/v1/comments" && method === "POST") {
      response = await handleCreateComment(request, env, cfg, ctx);
    } else if (pathname === "/v1/preview" && method === "POST") {
      response = await handlePreview(request, env, cfg);
    } else if (pathname === "/v1/subscriptions/verify" && method === "GET") {
      response = await handleGetVerifyPage(request, env, cfg);
    } else if (pathname === "/v1/subscriptions/verify" && method === "POST") {
      response = await handlePostVerify(request, env, cfg);
    } else if (
      pathname === "/v1/subscriptions/unsubscribe" &&
      method === "GET"
    ) {
      response = await handleGetUnsubscribePage(request, env, cfg);
    } else if (
      pathname === "/v1/subscriptions/unsubscribe" &&
      method === "POST"
    ) {
      response = await handlePostUnsubscribe(request, env, cfg);
    } else if (pathname === "/v1/admin/comments" && method === "GET") {
      response = await handleAdminListComments(request, env);
    } else if (pathname === "/v1/admin/comments" && method === "POST") {
      response = await handleAdminCreateComment(request, env, cfg, ctx);
    } else if (pathname === "/v1/admin/export" && method === "GET") {
      response = await handleAdminExport(request, env, cfg);
    } else if (pathname === "/v1/admin/import" && method === "POST") {
      response = await handleAdminImport(request, env, cfg);
    } else {
      const repliesMatch = pathname.match(/^\/v1\/comments\/([^/]+)\/replies$/);
      if (repliesMatch?.[1] && method === "GET") {
        response = await handleListReplies(
          request,
          env,
          decodeURIComponent(repliesMatch[1]),
        );
      } else {
        const adminCommentMatch = pathname.match(
          /^\/v1\/admin\/comments\/([^/]+)$/,
        );
        if (adminCommentMatch?.[1] && method === "PATCH") {
          response = await handleAdminUpdateComment(
            request,
            env,
            cfg,
            ctx,
            decodeURIComponent(adminCommentMatch[1]),
          );
        } else {
          throw new AppError(404, "COMMENT_NOT_FOUND", "Endpoint not found.");
        }
      }
    }

    return applyHeaders(response, corsHeaders);
  } catch (err) {
    if (err instanceof AppError) {
      const headers = new Headers(corsHeaders);
      if (isAdminRoute || pathname.startsWith("/v1/subscriptions/")) {
        headers.set("Cache-Control", "no-store");
      }
      return errorResponse(err, headers);
    }
    console.error("Unhandled worker error:", err);
    return errorResponse(
      new AppError(500, "INTERNAL_ERROR", "Internal server error."),
      corsHeaders,
    );
  }
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return routeApiRequest(request, env, ctx);
  },

  async scheduled(
    _controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(drainEmailOutbox(env).then(() => cleanupEmailOutbox(env.DB)));
  },
} satisfies ExportedHandler<WorkerEnv>;
