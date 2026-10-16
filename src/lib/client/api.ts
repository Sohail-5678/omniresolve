/**
 * Browser-side API helpers. JSON calls go through `api`; streaming turns use `postSSE`,
 * which parses Server-Sent Events from a POST response (EventSource can't POST).
 * BYOK keys are sent as headers for one request and never stored by the server.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
    headers: { ...(init?.json !== undefined ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    credentials: "same-origin",
    cache: "no-store",
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data;
}

export type SSEHandler = (event: string, data: unknown) => void;

export async function postSSE(url: string, body: unknown, onEvent: SSEHandler, opts: { headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...(opts.headers ?? {}) },
    body: JSON.stringify(body),
    credentials: "same-origin",
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (!data.length || event === "ping") continue;
      try {
        onEvent(event, JSON.parse(data.join("\n")));
      } catch {
        onEvent(event, data.join("\n"));
      }
    }
  }
}

export function byokHeaders(keys: { groq?: string }): Record<string, string> {
  return keys.groq ? { "x-byok-groq": keys.groq } : {};
}
