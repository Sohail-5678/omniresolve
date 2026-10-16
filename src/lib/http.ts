/**
 * Route helpers: signed-session lookup (sandbox ID from the cookie, never the body),
 * same-origin check for state-changing routes, generic errors with a trace ID, and a
 * Server-Sent Events response for streaming agent progress.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { getDb } from "@/db/client";
import { SESSION_COOKIE, sandboxIsLive, verifySession } from "@/lib/security/sandbox";
import { HttpError } from "@/lib/util/errors";
import { AGENT } from "@/config/agent";

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join("="));
    } catch {
      return null; // a malformed escape is just an invalid cookie
    }
  }
  return null;
}

export async function requireSandbox(req: Request): Promise<string> {
  const session = verifySession(readCookie(req, SESSION_COOKIE));
  if (!session) throw new HttpError(401, "No active sandbox. Start a session first.");
  if (!(await sandboxIsLive(getDb(), session.sid))) throw new HttpError(401, "Your sandbox expired. Start a new session.");
  return session.sid;
}

/** CSRF defence alongside SameSite=Lax: a browser Origin header must match this host. */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    if (new URL(origin).host !== host) throw new HttpError(403, "Cross-origin requests are not allowed.");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(403, "Bad origin.");
  }
}

export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > AGENT.firewall.maxBodyBytes) throw new HttpError(413, "Request body too large.");
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > AGENT.firewall.maxBodyBytes) throw new HttpError(413, "Request body too large.");
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, `Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? ""}`.trim());
  }
  return parsed.data;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.publicMessage }, err.status);
  const traceId = randomUUID().slice(0, 8);
  console.error(`[api] trace=${traceId}`, err);
  return json({ error: "Something went wrong.", traceId }, 500);
}

export function route<T extends unknown[]>(handler: (...args: T) => Promise<Response>) {
  return async (...args: T): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Streams events as SSE; `run` receives a send function and the stream closes when it resolves. */
export function sse(run: (send: (event: string, data: unknown) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const ping = setInterval(() => send("ping", { t: Date.now() }), 10_000);
      try {
        await run(send);
      } catch (err) {
        const traceId = randomUUID().slice(0, 8);
        console.error(`[sse] trace=${traceId}`, err);
        send("error", { message: err instanceof HttpError ? err.publicMessage : "Something went wrong.", traceId });
      } finally {
        clearInterval(ping);
        closed = true;
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
