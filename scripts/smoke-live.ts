/**
 * Production smoke test (spec 15.4 step 4). Usage: npx tsx scripts/smoke-live.ts https://<domain>
 * Checks: / renders, /api/health is ok with db ok and a commit; sessions set an httpOnly cookie;
 * a second sandbox cannot read the first sandbox's thread (404); showcase 1 in replay mode
 * reaches AWAITING_APPROVAL and a SEPARATE request approves it, the saga finishes and the reply
 * is verified; showcase 4's forged refund is rejected with TOKEN_MISSING; security headers exist.
 */
const base = (process.argv[2] ?? process.env.SMOKE_URL ?? "http://localhost:3217").replace(/\/$/, "");
let failures = 0;

function ok(cond: unknown, label: string) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

async function session(): Promise<string> {
  const res = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{}" });
  const cookie = res.headers.get("set-cookie") ?? "";
  ok(res.ok && /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie), "POST /api/session sets an httpOnly SameSite=Lax cookie");
  return cookie.split(";")[0];
}

async function sse(path: string, cookie: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie, origin: base }, body: JSON.stringify(body) });
  const text = await res.text();
  const events = text
    .split("\n\n")
    .map((chunk) => {
      const ev = /event: (.+)/.exec(chunk)?.[1];
      const data = /data: (.+)/.exec(chunk)?.[1];
      return ev && data ? { event: ev, data: JSON.parse(data) as Record<string, unknown> } : null;
    })
    .filter(Boolean) as { event: string; data: Record<string, unknown> }[];
  return { status: res.status, events, result: events.find((e) => e.event === "result")?.data };
}

async function main() {
  console.log(`Smoke test against ${base}\n`);
  const home = await fetch(`${base}/`);
  const html = await home.text();
  ok(home.status === 200 && /OmniResolve/.test(html), "GET / returns 200 with the app title");
  const h = home.headers;
  ok(/nonce-/.test(h.get("content-security-policy") ?? ""), "CSP with a nonce");
  ok(h.get("x-frame-options") === "DENY" && h.get("x-content-type-options") === "nosniff", "X-Frame-Options DENY + nosniff");
  ok(/max-age/.test(h.get("strict-transport-security") ?? ""), "HSTS header");

  const health = (await (await fetch(`${base}/api/health`)).json()) as { status: string; db: string; commit: string };
  ok(health.status === "ok" && health.db === "ok" && !!health.commit, `GET /api/health → db ${health.db}, commit ${health.commit}`);

  const a = await session();
  const b = await session();
  const first = await sse("/api/resolve", a, {
    scenarioId: "s1-damaged-double-charge",
    message: "Hi, my Aurora glass panel kit (order ORD-9941) arrived completely shattered. And when I checked my card, you charged me twice for it! I need this sorted.",
    mode: "replay",
  });
  const threadId = first.result?.threadId as string;
  ok(first.result?.status === "AWAITING_APPROVAL", `showcase 1 reaches AWAITING_APPROVAL (got ${String(first.result?.status)})`);

  const cross = await fetch(`${base}/api/threads/${threadId}`, { headers: { cookie: b } });
  ok(cross.status === 404, `another sandbox reading the thread gets 404 (got ${cross.status})`);

  const interruptId = (first.result?.approval as { interruptId?: string } | undefined)?.interruptId;
  const resumed = await sse("/api/hitl", a, { threadId, interruptId, decision: "approve", mode: "replay" });
  const saga = resumed.result?.saga as { status?: string } | undefined;
  const reply = resumed.result?.reply as { verified?: boolean } | undefined;
  ok(saga?.status === "DONE", `separate approve request finishes the saga (saga ${saga?.status})`);
  ok(reply?.verified === true, "reply is verified");

  const again = await sse("/api/hitl", a, { threadId, interruptId, decision: "approve", mode: "replay" });
  ok((again.result as { duplicate?: boolean } | undefined)?.duplicate === true, "approving twice returns the stored result (no second saga)");

  const forged = await sse("/api/resolve", a, { scenarioId: "s4-vp-override", message: "forged", forgedCall: true, mode: "replay" });
  const guard = forged.events.find((e) => e.event === "guard")?.data;
  ok(guard?.code === "TOKEN_MISSING", `forged refund → ${String(guard?.code)}`);

  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all smoke checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
