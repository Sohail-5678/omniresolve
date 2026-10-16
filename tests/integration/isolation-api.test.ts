/**
 * Sandbox isolation + API route contract tests. Route handlers are called directly with
 * Request objects; sessions are created through POST /api/session and the signed cookie
 * from its set-cookie header is passed back exactly like a browser would.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, lt, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import type { Db } from "@/db/client";
import { AGENT } from "@/config/agent";
import { secret, resetEnvCache } from "@/config/env";
import { hmacHex } from "@/lib/util/canonical";
import { ServiceError } from "@/lib/util/errors";
import { resetRateLimits } from "@/lib/security/rate-limiter";
import { applyPreFault } from "@/lib/services/fault-injector";
import { runTurn } from "@/lib/agent/runner";
import { SESSION_COOKIE, cleanupExpired, deleteSandbox, hashIp, sandboxIsLive, signSession, verifySession } from "@/lib/security/sandbox";
import { TEMPLATE_SANDBOX_ID } from "@/lib/seed/generate";
import { POST as sessionPOST, GET as sessionGET } from "@/app/api/session/route";
import { GET as threadGET } from "@/app/api/threads/[id]/route";
import { GET as chaosGET, POST as chaosPOST } from "@/app/api/chaos/route";
import { GET as servicesGET } from "@/app/api/services/[name]/route";
import { GET as healthGET } from "@/app/api/health/route";
import { POST as ragPOST } from "@/app/api/rag-search/route";
import { POST as resolvePOST } from "@/app/api/resolve/route";
import { POST as hitlPOST } from "@/app/api/hitl/route";
import { POST as recoverPOST } from "@/app/api/saga/recover/route";
import { GET as cronGET } from "@/app/api/cron/cleanup/route";
import { db, freshSandbox, newThread, fault, instant, ScriptedLlm, templateResponder, cite } from "../helpers";

const HOST = "localhost:3000";
const BASE = `http://${HOST}`;
const SAME_ORIGIN = BASE;
const FOREIGN_ORIGIN = "https://evil.example";
const NO_SANDBOX = { error: "No active sandbox. Start a session first." };
const EXPIRED = { error: "Your sandbox expired. Start a new session." };

let ipSeq = 0;
const created: string[] = [];

type ReqOpts = { method?: string; cookie?: string | null; origin?: string; body?: unknown; rawBody?: string; ip?: string; headers?: Record<string, string> };

function makeReq(path: string, o: ReqOpts = {}): Request {
  const h = new Headers({ host: HOST, "x-forwarded-for": o.ip ?? `10.77.0.${(ipSeq++ % 250) + 1}`, ...(o.headers ?? {}) });
  if (o.cookie) h.set("cookie", o.cookie);
  if (o.origin) h.set("origin", o.origin);
  let body: string | undefined;
  if (o.rawBody !== undefined) body = o.rawBody;
  else if (o.body !== undefined) body = JSON.stringify(o.body);
  if (body !== undefined) h.set("content-type", "application/json");
  return new Request(`${BASE}${path}`, { method: o.method ?? (body !== undefined ? "POST" : "GET"), headers: h, body });
}

type SessionBody = { session: { sandboxId: string; expiresAt: string; businessDate: string; defaultMode: string } | null };

async function newSession(ip?: string): Promise<{ sandboxId: string; cookie: string; setCookie: string; body: SessionBody }> {
  const res = await sessionPOST(makeReq("/api/session", { method: "POST", origin: SAME_ORIGIN, body: {}, ip }));
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  const body = (await res.json()) as SessionBody;
  const sandboxId = body.session!.sandboxId;
  created.push(sandboxId);
  return { sandboxId, cookie: setCookie!.split(";")[0], setCookie: setCookie!, body };
}

function cookieValue(cookie: string): string {
  return decodeURIComponent(cookie.slice(`${SESSION_COOKIE}=`.length));
}

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

async function getThread(id: string, cookie: string) {
  return threadGET(makeReq(`/api/threads/${id}`, { cookie }), params({ id }));
}

async function overview(customerId: string, cookie: string) {
  return servicesGET(makeReq(`/api/services/overview?customerId=${customerId}`, { cookie }), params({ name: "overview" }));
}

type ChaosBody = { faults: { service: string; operation: string; mode: string; n: number | null; calls: number }[] };

async function chaosList(cookie: string): Promise<ChaosBody> {
  const res = await chaosGET(makeReq("/api/chaos", { cookie }));
  expect(res.status).toBe(200);
  return (await res.json()) as ChaosBody;
}

/** Rows a thread owns in the LangGraph checkpoint tables (no FK to sandboxes, so never cascaded). */
async function checkpointRows(threadId: string): Promise<number> {
  const r = await db().execute<{ n: number }>(sql`
    SELECT (SELECT count(*) FROM checkpoints WHERE thread_id = ${threadId})
         + (SELECT count(*) FROM checkpoint_writes WHERE thread_id = ${threadId})
         + (SELECT count(*) FROM checkpoint_blobs WHERE thread_id = ${threadId}) AS n`);
  return Number(r.rows[0].n);
}

/** Every public table that carries a sandbox_id column, read from the live schema (so new tables are covered automatically). */
async function sandboxTables(): Promise<string[]> {
  const r = await db().execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'sandbox_id' ORDER BY table_name`);
  return r.rows.map((x) => x.table_name);
}

async function rowCounts(tables: string[], sandboxId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const r = await db().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE sandbox_id = ${sandboxId}`);
    out[t] = Number(r.rows[0].n);
  }
  return out;
}

async function sagaStepRows(sandboxId: string): Promise<number> {
  const r = await db().execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM saga_steps st JOIN saga_runs sr ON sr.id = st.saga_id WHERE sr.sandbox_id = ${sandboxId}`);
  return Number(r.rows[0].n);
}

/** Auto-approved damaged-skillet flow for CUS-1004 / ORD-8822: replacement + label + $8.00 shipping refund. */
function skilletLlm() {
  return new ScriptedLlm({
    triage: () => ({
      intents: ["damaged_item"],
      severity: "medium",
      sentiment: "negative",
      churnRisk: "low",
      orderIdsMentioned: ["ORD-8822"],
      missingInfo: [],
      clarifyingQuestion: null,
      socialEngineeringSignals: [],
      summary: "Skillet arrived cracked.",
    }),
    planner: (req) => ({
      actions: [
        { type: "replacement", orderId: "ORD-8822", sku: "SKL-CI-12", qty: 1, reason: "damaged" },
        { type: "return_label", orderId: "ORD-8822", reason: "damaged" },
        { type: "refund", orderId: "ORD-8822", amountCents: 800, reason: "damaged" },
      ],
      rationale: "Transit damage confirmed by carrier scan; policy refunds shipping.",
      citedClauseIds: cite(req, ["§4.2", "§4.5"]),
    }),
    responder: templateResponder,
  });
}

async function skilletTurn(sandboxId: string, threadId: string) {
  return runTurn({ db: db(), sandboxId, threadId, mode: "live", llm: skilletLlm(), customerId: "CUS-1004", message: "Skillet ORD-8822 arrived cracked.", evidenceAttached: false, sagaHooks: instant });
}

beforeEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  for (const id of created) await deleteSandbox(db(), id).catch(() => undefined);
});

// ---------------------------------------------------------------------------------------
describe("signSession / verifySession", () => {
  const future = () => Math.floor(Date.now() / 1000) + 3600;

  it("round-trips a valid payload exactly", () => {
    const payload = { sid: "sb_roundtrip", exp: future() };
    const cookie = signSession(payload);
    expect(cookie).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    expect(verifySession(cookie)).toEqual(payload);
    // The body is just the base64url JSON; the signature is HMAC-SHA256 under SESSION_SECRET.
    const [body, sig] = cookie.split(".");
    expect(JSON.parse(Buffer.from(body, "base64url").toString("utf8"))).toEqual(payload);
    expect(sig).toBe(hmacHex(body, secret("SESSION_SECRET")));
  });

  it("rejects an expired payload even though the signature is valid", () => {
    const now = Math.floor(Date.now() / 1000);
    const cookie = signSession({ sid: "sb_old", exp: now - 5 });
    expect(verifySession(cookie)).toBeNull();
    // Long-expired too, and a payload a few seconds in the future is still accepted.
    expect(verifySession(signSession({ sid: "sb_old", exp: now - 86_400 }))).toBeNull();
    expect(verifySession(signSession({ sid: "sb_soon", exp: now + 5 }))?.sid).toBe("sb_soon");
  });

  it("rejects a body swapped for another sandbox while keeping the original signature", () => {
    const exp = future();
    const [, sigA] = signSession({ sid: "sb_victim_a", exp }).split(".");
    const [bodyB] = signSession({ sid: "sb_victim_b", exp }).split(".");
    expect(verifySession(`${bodyB}.${sigA}`)).toBeNull();
  });

  it("rejects a signature made with a different secret", () => {
    const body = Buffer.from(JSON.stringify({ sid: "sb_x", exp: future() })).toString("base64url");
    const forged = `${body}.${hmacHex(body, "attacker-chosen-secret-that-is-not-the-real-one")}`;
    expect(verifySession(forged)).toBeNull();
    // Same body with the real secret verifies, proving only the key differs.
    expect(verifySession(`${body}.${hmacHex(body, secret("SESSION_SECRET"))}`)?.sid).toBe("sb_x");
  });

  it("rejects a flipped signature character, truncated/non-hex signatures, missing parts, garbage and empty input", () => {
    const cookie = signSession({ sid: "sb_flip", exp: future() });
    const [body, sig] = cookie.split(".");
    const last = cookie.at(-1)!;
    const flipped = cookie.slice(0, -1) + (last === "0" ? "1" : "0");
    expect(verifySession(flipped)).toBeNull();
    expect(verifySession(`${body}.${sig.slice(0, -2)}`)).toBeNull(); // one byte short
    expect(verifySession(`${body}.${sig}00`)).toBeNull(); // one byte long
    expect(verifySession(`${body}.${"z".repeat(64)}`)).toBeNull(); // right length, not hex
    expect(verifySession(cookie.split(".")[0])).toBeNull();
    expect(verifySession(`.${cookie.split(".")[1]}`)).toBeNull();
    expect(verifySession("not-a-cookie")).toBeNull();
    expect(verifySession("")).toBeNull();
    expect(verifySession(null)).toBeNull();
    expect(verifySession(undefined)).toBeNull();
  });

  it("rejects a correctly signed payload with the wrong field types", () => {
    const badSid = signSession({ sid: 42 as unknown as string, exp: future() });
    const badExp = signSession({ sid: "sb_ok", exp: "never" as unknown as number });
    expect(verifySession(badSid)).toBeNull();
    expect(verifySession(badExp)).toBeNull();
    // Correctly signed but not JSON at all.
    const body = Buffer.from("{not json").toString("base64url");
    expect(verifySession(`${body}.${hmacHex(body, secret("SESSION_SECRET"))}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
describe("POST /api/session — cookie", () => {
  it("sets an HttpOnly, SameSite=Lax, path-wide signed cookie naming the new sandbox", async () => {
    const ip = "10.66.66.66";
    const { sandboxId, setCookie, cookie, body } = await newSession(ip);
    const attrs = setCookie.split(";").map((p) => p.trim());
    expect(attrs[0].startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(attrs).toContain("HttpOnly");
    expect(attrs).toContain("SameSite=Lax");
    expect(attrs).toContain("Path=/");
    expect(attrs).toContain(`Max-Age=${AGENT.sandboxTtlMs / 1000}`);
    expect(attrs).toContain("Max-Age=86400");
    expect(attrs).not.toContain("Secure"); // only in production
    expect(sandboxId).toMatch(/^sb_[A-Za-z0-9_-]{12}$/);
    const payload = verifySession(cookieValue(cookie));
    expect(payload?.sid).toBe(sandboxId);
    expect(payload?.exp).toBe(Math.floor(Date.parse(body.session!.expiresAt) / 1000));
    expect(body.session!.businessDate).toBe("2026-10-16");
    expect(await sandboxIsLive(db(), sandboxId)).toBe(true);

    // The DB row agrees with the cookie, expires ~24 h out, and stores only a keyed hash of the IP.
    const [row] = await db().select().from(s.sandboxes).where(eq(s.sandboxes.id, sandboxId));
    expect(row.isTemplate).toBe(false);
    expect(Math.floor(row.expiresAt.getTime() / 1000)).toBe(payload!.exp);
    expect(Math.abs(row.expiresAt.getTime() - Date.now() - AGENT.sandboxTtlMs)).toBeLessThan(60_000);
    expect(row.ipHash).toBe(hashIp(ip));
    expect(row.ipHash).not.toContain(ip);
    // The sandbox was seeded from the template.
    const custs = await db().select({ id: s.customers.id }).from(s.customers).where(eq(s.customers.sandboxId, sandboxId));
    expect(custs.map((c) => c.id)).toContain("CUS-1004");
  });

  it("adds the Secure attribute when running in production", async () => {
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      const res = await sessionPOST(makeReq("/api/session", { method: "POST", origin: SAME_ORIGIN, body: {} }));
      expect(res.status).toBe(200);
      created.push(((await res.json()) as SessionBody).session!.sandboxId);
      const attrs = res.headers.get("set-cookie")!.split(";").map((p) => p.trim());
      expect(attrs).toContain("Secure");
      expect(attrs).toContain("HttpOnly");
      expect(attrs).toContain("SameSite=Lax");
    } finally {
      if (prev === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
      else (process.env as Record<string, string | undefined>).NODE_ENV = prev;
    }
  });

  it("reuses the live sandbox when the cookie is sent back (no new cookie), and reset replaces it and wipes its checkpoints", async () => {
    const a = await newSession();
    const again = await sessionPOST(makeReq("/api/session", { method: "POST", origin: SAME_ORIGIN, cookie: a.cookie, body: {} }));
    expect(again.status).toBe(200);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(((await again.json()) as SessionBody).session!.sandboxId).toBe(a.sandboxId);

    // Give A a real thread with LangGraph checkpoints so reset has something to clean.
    const thread = await newThread(a.sandboxId, "CUS-1004");
    expect((await skilletTurn(a.sandboxId, thread)).status).toBe("REPLIED");
    expect(await checkpointRows(thread)).toBeGreaterThan(0);

    const reset = await sessionPOST(makeReq("/api/session", { method: "POST", origin: SAME_ORIGIN, cookie: a.cookie, body: { reset: true } }));
    expect(reset.status).toBe(200);
    const newId = ((await reset.json()) as SessionBody).session!.sandboxId;
    created.push(newId);
    expect(newId).not.toBe(a.sandboxId);
    const newCookie = reset.headers.get("set-cookie")!.split(";")[0];
    expect(verifySession(cookieValue(newCookie))?.sid).toBe(newId);
    expect(await sandboxIsLive(db(), a.sandboxId)).toBe(false);
    const oldCustomers = await db().select().from(s.customers).where(eq(s.customers.sandboxId, a.sandboxId));
    expect(oldCustomers).toHaveLength(0);
    expect(await db().select().from(s.threads).where(eq(s.threads.id, thread))).toHaveLength(0);
    expect(await checkpointRows(thread)).toBe(0);

    // The old cookie is still validly signed but its sandbox is gone; the new one works.
    const stale = await chaosGET(makeReq("/api/chaos", { cookie: a.cookie }));
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual(EXPIRED);
    expect((await chaosGET(makeReq("/api/chaos", { cookie: newCookie }))).status).toBe(200);
  });

  it("a cookie for an expired or tampered sandbox gets a brand-new sandbox (not the old one)", async () => {
    const a = await newSession();
    await db().update(s.sandboxes).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(s.sandboxes.id, a.sandboxId));
    const res = await sessionPOST(makeReq("/api/session", { method: "POST", origin: SAME_ORIGIN, cookie: a.cookie, body: {} }));
    expect(res.status).toBe(200);
    const id = ((await res.json()) as SessionBody).session!.sandboxId;
    created.push(id);
    expect(id).not.toBe(a.sandboxId);
    expect(verifySession(cookieValue(res.headers.get("set-cookie")!.split(";")[0]))?.sid).toBe(id);

    const [bodyPart, sig] = cookieValue(a.cookie).split(".");
    const tampered = `${SESSION_COOKIE}=${bodyPart}.${sig.slice(0, -1)}${sig.at(-1) === "a" ? "b" : "a"}`;
    const res2 = await sessionPOST(makeReq("/api/session", { method: "POST", origin: SAME_ORIGIN, cookie: tampered, body: {} }));
    expect(res2.status).toBe(200);
    const id2 = ((await res2.json()) as SessionBody).session!.sandboxId;
    created.push(id2);
    expect(id2).not.toBe(a.sandboxId);
    expect(id2).not.toBe(id);
    expect(res2.headers.get("set-cookie")).toBeTruthy();
  });

  it("GET /api/session reports the session for a valid cookie and null without one, for an expired sandbox, or a tampered cookie", async () => {
    const a = await newSession();
    const withCookie = (await (await sessionGET(makeReq("/api/session", { cookie: a.cookie }))).json()) as SessionBody;
    expect(withCookie.session!.sandboxId).toBe(a.sandboxId);
    // GET derives expiry from the cookie's whole-second exp; POST reports the row's millisecond value.
    expect(Math.floor(Date.parse(withCookie.session!.expiresAt) / 1000)).toBe(Math.floor(Date.parse(a.body.session!.expiresAt) / 1000));
    const res = await sessionGET(makeReq("/api/session"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session: null });

    const [bodyPart, sig] = cookieValue(a.cookie).split(".");
    const tampered = await sessionGET(makeReq("/api/session", { cookie: `${SESSION_COOKIE}=${bodyPart}.${sig.slice(0, -1)}${sig.at(-1) === "a" ? "b" : "a"}` }));
    expect(await tampered.json()).toEqual({ session: null });

    await db().update(s.sandboxes).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(s.sandboxes.id, a.sandboxId));
    const expired = await sessionGET(makeReq("/api/session", { cookie: a.cookie }));
    expect(expired.status).toBe(200);
    expect(await expired.json()).toEqual({ session: null });
  });

  it("rate-limits new sandboxes per IP (5 per hour), without affecting other IPs", async () => {
    const ip = "10.250.250.250";
    for (let i = 0; i < 5; i++) {
      const res = await sessionPOST(makeReq("/api/session", { method: "POST", origin: SAME_ORIGIN, body: {}, ip }));
      expect(res.status).toBe(200);
      created.push(((await res.json()) as SessionBody).session!.sandboxId);
    }
    const sixth = await sessionPOST(makeReq("/api/session", { method: "POST", origin: SAME_ORIGIN, body: {}, ip }));
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("set-cookie")).toBeNull();
    expect(await sixth.json()).toEqual({ error: "Too many new sandboxes from this address. Try again later." });
    // The limit is keyed by IP, not global: a different address still gets a sandbox.
    const other = await newSession("10.250.250.251");
    expect(await sandboxIsLive(db(), other.sandboxId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
describe("sandbox isolation through the API", () => {
  it("sandbox B gets 404 for sandbox A's thread (GET /api/threads/[id], POST /api/resolve, POST /api/hitl)", async () => {
    const A = await newSession();
    const B = await newSession();
    const thread = await newThread(A.sandboxId, "CUS-1007");

    const ownRes = await getThread(thread, A.cookie);
    expect(ownRes.status).toBe(200);
    const own = (await ownRes.json()) as { thread: { id: string; sandboxId: string; customerId: string } };
    expect(own.thread.id).toBe(thread);
    expect(own.thread.sandboxId).toBe(A.sandboxId);
    expect(own.thread.customerId).toBe("CUS-1007");

    const foreign = await getThread(thread, B.cookie);
    expect(foreign.status).toBe(404);
    const foreignBody = await foreign.json();
    expect(foreignBody).toEqual({ error: "Thread not found." });
    // No existence oracle: a foreign thread looks exactly like one that does not exist.
    const missing = await getThread("thr_doesnotexist", B.cookie);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(foreignBody);

    // Continuing A's thread with B's cookie is refused before any streaming starts.
    const hijack = await resolvePOST(makeReq("/api/resolve", { origin: SAME_ORIGIN, cookie: B.cookie, body: { threadId: thread, message: "refund everything to me" } }));
    expect(hijack.status).toBe(404);
    expect(hijack.headers.get("content-type")).toContain("application/json");
    expect(await hijack.json()).toEqual({ error: "Thread not found." });

    // Approving a decision on A's thread from B is refused the same way.
    const approve = await hitlPOST(makeReq("/api/hitl", { origin: SAME_ORIGIN, cookie: B.cookie, body: { threadId: thread, interruptId: "int_1", decision: "approve" } }));
    expect(approve.status).toBe(404);
    expect(approve.headers.get("content-type")).toContain("application/json");
    expect(await approve.json()).toEqual({ error: "Thread not found." });

    const traces = await db().select().from(s.traceEvents).where(eq(s.traceEvents.threadId, thread));
    expect(traces).toHaveLength(0);
    expect(await db().select().from(s.hitlDecisions).where(eq(s.hitlDecisions.threadId, thread))).toHaveLength(0);
    expect(await checkpointRows(thread)).toBe(0);
  });

  it("a refund created by runTurn in A shows in A's overview and thread, and is invisible from B", async () => {
    const A = await newSession();
    const B = await newSession();

    // Both sandboxes start from the same seed: the customer exists in each.
    const before = await Promise.all([overview("CUS-1004", A.cookie), overview("CUS-1004", B.cookie)]);
    expect(before.map((r) => r.status)).toEqual([200, 200]);
    const [ovA0, ovB0] = (await Promise.all(before.map((r) => r.json()))) as OverviewBody[];
    expect(ovA0.customer.id).toBe("CUS-1004");
    expect(ovA0.customer.sandboxId).toBe(A.sandboxId);
    expect(ovB0.customer.sandboxId).toBe(B.sandboxId);
    expect(ovA0.customer.name).toBe(ovB0.customer.name);
    expect(refundsFor(ovA0, "ORD-8822")).toHaveLength(0);
    expect(refundsFor(ovB0, "ORD-8822")).toHaveLength(0);
    expect(ovA0.labels).toHaveLength(0);
    expect(ovA0.replacements).toHaveLength(0);

    const bRefundsBefore = await db().select().from(s.refunds).where(eq(s.refunds.sandboxId, B.sandboxId));
    const thread = await newThread(A.sandboxId, "CUS-1004");
    const r = await skilletTurn(A.sandboxId, thread);
    expect(r.status).toBe("REPLIED");
    expect(r.saga?.status).toBe("DONE");

    const ovA = (await (await overview("CUS-1004", A.cookie)).json()) as OverviewBody;
    const ovB = (await (await overview("CUS-1004", B.cookie)).json()) as OverviewBody;
    expect(refundsFor(ovA, "ORD-8822").map((x) => x.amountCents)).toEqual([800]);
    expect(refundsFor(ovB, "ORD-8822")).toHaveLength(0);
    expect(ovA.labels).toHaveLength(1);
    expect(ovA.labels[0]).toMatchObject({ sandboxId: A.sandboxId, orderId: "ORD-8822", status: "active" });
    expect(ovB.labels).toHaveLength(0);
    expect(ovA.replacements).toHaveLength(1);
    expect(ovA.replacements[0]).toMatchObject({ sandboxId: A.sandboxId, orderId: "ORD-8822", sku: "SKL-CI-12", qty: 1, status: "confirmed" });
    expect(ovB.replacements).toHaveLength(0);
    expect(ovB.tickets.length).toBe(ovB0.tickets.length);
    expect(ovA.tickets.length).toBe(ovA0.tickets.length + 1);
    expect(ovA.ledger.refunds.length).toBeGreaterThan(0);
    expect(ovA.ledger.refunds.every((x) => x.sandboxId === A.sandboxId)).toBe(true);
    expect(ovB.ledger.refunds.every((x) => x.sandboxId === B.sandboxId)).toBe(true);
    expect(ovB.ledger.refunds).toEqual(ovB0.ledger.refunds);

    // A sees the thread's saga and checkpoint history; B gets a 404 for the same id.
    const ownRes = await getThread(thread, A.cookie);
    expect(ownRes.status).toBe(200);
    const ownText = await ownRes.text();
    const own = JSON.parse(ownText) as ThreadBody;
    expect(own.sagas).toHaveLength(1);
    expect(own.sagas[0].status).toBe("DONE");
    expect(own.sagas[0].plan).toBeUndefined();
    const dbSteps = await db().select().from(s.sagaSteps).where(eq(s.sagaSteps.sagaId, own.sagas[0].id));
    expect(own.sagas[0].steps).toHaveLength(dbSteps.length);
    expect(own.sagas[0].steps.map((st) => st.seq)).toEqual(dbSteps.map((st) => st.seq).sort((x, y) => x - y));
    // Token ids are in the DB step requests but stripped from the response.
    expect(dbSteps.some((st) => typeof (st.request as { tokenId?: unknown } | null)?.tokenId === "string")).toBe(true);
    expect(own.sagas[0].steps.every((st) => st.request.tokenId === undefined)).toBe(true);
    // History mirrors the thread's LangGraph checkpoints; trace mirrors its trace_events rows.
    const cps = await db().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM checkpoints WHERE thread_id = ${thread}`);
    expect(own.history.length).toBe(Math.min(40, Number(cps.rows[0].n)));
    expect(own.history.length).toBeGreaterThan(0);
    const dbTrace = await db().select().from(s.traceEvents).where(and(eq(s.traceEvents.sandboxId, A.sandboxId), eq(s.traceEvents.threadId, thread)));
    expect(own.trace.length).toBe(dbTrace.length);
    expect(own.trace.length).toBeGreaterThan(0);
    // Approval tokens: one per action, shown only as an 8-char prefix; full ids never leave the server.
    const tokens = await db().select().from(s.approvalTokens).where(and(eq(s.approvalTokens.sandboxId, A.sandboxId), eq(s.approvalTokens.threadId, thread)));
    expect(tokens).toHaveLength(3);
    expect(own.state.tokens).toHaveLength(3);
    expect(own.state.tokens!.map((t) => t.action)).toEqual(["replacement", "return_label", "refund"]);
    for (const t of own.state.tokens!) expect(t.tokenId).toMatch(/^[0-9a-f]{8}…$/);
    expect(own.state.tokens!.map((t) => t.tokenId.slice(0, 8)).sort()).toEqual(tokens.map((t) => t.tokenId.slice(0, 8)).sort());
    for (const t of tokens) expect(ownText).not.toContain(t.tokenId);
    expect((await getThread(thread, B.cookie)).status).toBe(404);

    // Raw DB check: B's seeded refund history is exactly what it was before A's turn.
    const bRefunds = await db().select().from(s.refunds).where(eq(s.refunds.sandboxId, B.sandboxId));
    expect(bRefunds).toEqual(bRefundsBefore);
    expect(bRefunds.filter((x) => x.orderId === "ORD-8822")).toHaveLength(0);
    const aRefunds = await db().select().from(s.refunds).where(eq(s.refunds.sandboxId, A.sandboxId));
    expect(aRefunds.length).toBe(bRefundsBefore.length + 1);
    expect(await db().select().from(s.approvalTokens).where(eq(s.approvalTokens.sandboxId, B.sandboxId))).toHaveLength(0);
    expect(await db().select().from(s.sagaRuns).where(eq(s.sagaRuns.sandboxId, B.sandboxId))).toHaveLength(0);
  });

  it("POST /api/chaos in A does not appear in GET /api/chaos for B, and only affects A's mock calls", async () => {
    const A = await newSession();
    const B = await newSession();
    const set = await chaosPOST(makeReq("/api/chaos", { origin: SAME_ORIGIN, cookie: A.cookie, body: { service: "billing", operation: "refund", mode: "fail_503" } }));
    expect(set.status).toBe(200);
    const setBody = (await set.json()) as ChaosBody;
    expect(setBody.faults.map((f) => `${f.service}.${f.operation}:${f.mode}`)).toEqual(["billing.refund:fail_503"]);

    expect((await chaosList(A.cookie)).faults.map((f) => f.mode)).toEqual(["fail_503"]);
    expect((await chaosList(B.cookie)).faults).toEqual([]);

    // The fault only fires for A's sandbox.
    await expect(applyPreFault(db(), A.sandboxId, "billing", "refund")).rejects.toBeInstanceOf(ServiceError);
    await expect(applyPreFault(db(), B.sandboxId, "billing", "refund")).resolves.toEqual({ mode: null, post: "none" });

    // B setting a different fault on the same operation does not overwrite A's.
    const setB = await chaosPOST(makeReq("/api/chaos", { origin: SAME_ORIGIN, cookie: B.cookie, body: { service: "billing", operation: "refund", mode: "rate_limit_429" } }));
    expect(setB.status).toBe(200);
    expect(((await setB.json()) as ChaosBody).faults.map((f) => `${f.service}.${f.operation}:${f.mode}`)).toEqual(["billing.refund:rate_limit_429"]);
    expect((await chaosList(A.cookie)).faults.map((f) => f.mode)).toEqual(["fail_503"]);

    // B resetting its chaos leaves A's fault in place.
    const resetB = await chaosPOST(makeReq("/api/chaos", { origin: SAME_ORIGIN, cookie: B.cookie, body: { reset: true } }));
    expect(resetB.status).toBe(200);
    expect(((await resetB.json()) as ChaosBody).faults).toEqual([]);
    expect((await chaosList(B.cookie)).faults).toEqual([]);
    const aAfter = (await chaosList(A.cookie)).faults;
    expect(aAfter).toHaveLength(1);
    expect(aAfter[0]).toMatchObject({ service: "billing", operation: "refund", mode: "fail_503", calls: 1 });
  });

  it("a sandboxId smuggled in the body is ignored: the fault lands in the cookie's sandbox", async () => {
    const A = await newSession();
    const B = await newSession();
    const res = await chaosPOST(
      makeReq("/api/chaos", { origin: SAME_ORIGIN, cookie: B.cookie, body: { service: "carrier_a", operation: "createReturnLabel", mode: "fail_n_times", n: 3, sandboxId: A.sandboxId } }),
    );
    expect(res.status).toBe(200);
    expect((await chaosList(A.cookie)).faults).toEqual([]);
    const bFaults = (await chaosList(B.cookie)).faults;
    expect(bFaults).toHaveLength(1);
    expect(bFaults[0]).toMatchObject({ service: "carrier_a", operation: "createReturnLabel", mode: "fail_n_times", n: 3, calls: 0 });
    const rows = await db().select().from(s.faultSettings).where(eq(s.faultSettings.sandboxId, A.sandboxId));
    expect(rows).toHaveLength(0);
  });

  it("customers list and overview are per-sandbox: edits and new rows in A never show up in B", async () => {
    const A = await newSession();
    const B = await newSession();
    const list = async (cookie: string) =>
      ((await (await servicesGET(makeReq("/api/services/customers", { cookie }), params({ name: "customers" }))).json()) as { customers: { id: string; name: string }[]; badge: string });
    const [la, lb] = await Promise.all([list(A.cookie), list(B.cookie)]);
    expect(la.badge).toBe("MOCK SERVICE");
    expect(la.customers.map((c) => c.id)).toEqual(lb.customers.map((c) => c.id));
    expect(la.customers.map((c) => c.id)).toContain("CUS-1004");
    // Exactly this sandbox's rows: no duplicates pulled in from other sandboxes.
    const dbA = await db().select({ id: s.customers.id }).from(s.customers).where(eq(s.customers.sandboxId, A.sandboxId));
    expect(la.customers).toHaveLength(Math.min(60, dbA.length));
    expect(new Set(la.customers.map((c) => c.id)).size).toBe(la.customers.length);

    // Rename a customer in A only.
    const original = la.customers.find((c) => c.id === "CUS-1004")!.name;
    await db().update(s.customers).set({ name: "Renamed In A" }).where(and(eq(s.customers.sandboxId, A.sandboxId), eq(s.customers.id, "CUS-1004")));
    const [la2, lb2] = await Promise.all([list(A.cookie), list(B.cookie)]);
    expect(la2.customers.find((c) => c.id === "CUS-1004")!.name).toBe("Renamed In A");
    expect(lb2.customers.find((c) => c.id === "CUS-1004")!.name).toBe(original);

    // A customer that exists only in A is a 404 from B's overview.
    await db().insert(s.customers).values({ sandboxId: A.sandboxId, id: "CUS-7777", name: "Only In A", emailMasked: "o•••@example.com", tier: "standard", lifetimeValueCents: 0, since: "2025-01-01" });
    const ovA = await overview("CUS-7777", A.cookie);
    expect(ovA.status).toBe(200);
    expect(((await ovA.json()) as OverviewBody).customer).toMatchObject({ id: "CUS-7777", name: "Only In A", sandboxId: A.sandboxId });
    const ovB = await overview("CUS-7777", B.cookie);
    expect(ovB.status).toBe(404);
    expect(await ovB.json()).toEqual({ error: "Customer not found." });
    expect((await list(B.cookie)).customers.map((c) => c.id)).not.toContain("CUS-7777");
  });
});

type OverviewBody = {
  customer: { id: string; name: string; sandboxId: string };
  ledger: { refunds: { orderId: string; amountCents: number; sandboxId: string }[] };
  labels: Record<string, unknown>[];
  replacements: Record<string, unknown>[];
  tickets: unknown[];
};
type ThreadBody = {
  sagas: { id: string; status: string; plan?: unknown; steps: { seq: number; request: { tokenId?: string } }[] }[];
  history: unknown[];
  trace: unknown[];
  state: { tokens?: { tokenId: string; action: string }[] };
};
const refundsFor = (ov: OverviewBody, orderId: string) => ov.ledger.refunds.filter((x) => x.orderId === orderId);

// ---------------------------------------------------------------------------------------
describe("request guards: origin, auth, body", () => {
  it("POST requests with a foreign Origin get 403 and change nothing", async () => {
    const A = await newSession();
    const chaos = await chaosPOST(makeReq("/api/chaos", { origin: FOREIGN_ORIGIN, cookie: A.cookie, body: { service: "billing", operation: "refund", mode: "fail_503" } }));
    expect(chaos.status).toBe(403);
    expect(await chaos.json()).toEqual({ error: "Cross-origin requests are not allowed." });
    expect((await chaosList(A.cookie)).faults).toEqual([]);

    const session = await sessionPOST(makeReq("/api/session", { method: "POST", origin: FOREIGN_ORIGIN, body: {} }));
    expect(session.status).toBe(403);
    expect(session.headers.get("set-cookie")).toBeNull();

    // A foreign reset must not wipe the victim's sandbox.
    const resetSession = await sessionPOST(makeReq("/api/session", { method: "POST", origin: FOREIGN_ORIGIN, cookie: A.cookie, body: { reset: true } }));
    expect(resetSession.status).toBe(403);
    expect(await sandboxIsLive(db(), A.sandboxId)).toBe(true);

    const rag = await ragPOST(makeReq("/api/rag-search", { origin: FOREIGN_ORIGIN, cookie: A.cookie, body: { query: "return window", governingDate: "2026-08-09" } }));
    expect(rag.status).toBe(403);

    const resolve = await resolvePOST(makeReq("/api/resolve", { origin: FOREIGN_ORIGIN, cookie: A.cookie, body: { message: "hi" } }));
    expect(resolve.status).toBe(403);
    expect(await db().select().from(s.threads).where(eq(s.threads.sandboxId, A.sandboxId))).toHaveLength(0);

    const hitl = await hitlPOST(makeReq("/api/hitl", { origin: FOREIGN_ORIGIN, cookie: A.cookie, body: { threadId: "thr_abcdef12", interruptId: "x", decision: "approve" } }));
    expect(hitl.status).toBe(403);
    const recover = await recoverPOST(makeReq("/api/saga/recover", { method: "POST", origin: FOREIGN_ORIGIN, cookie: A.cookie }));
    expect(recover.status).toBe(403);
    expect(recover.headers.get("content-type")).toContain("application/json");

    // Same host on a different port is a different origin; userinfo tricks and an opaque "null" origin are refused.
    const port = await chaosPOST(makeReq("/api/chaos", { origin: "http://localhost:4000", cookie: A.cookie, body: { reset: true } }));
    expect(port.status).toBe(403);
    const userinfo = await chaosPOST(makeReq("/api/chaos", { origin: "http://localhost:3000@evil.example", cookie: A.cookie, body: { reset: true } }));
    expect(userinfo.status).toBe(403);
    const sub = await chaosPOST(makeReq("/api/chaos", { origin: "http://localhost:3000.evil.example", cookie: A.cookie, body: { reset: true } }));
    expect(sub.status).toBe(403);
    const opaque = await chaosPOST(makeReq("/api/chaos", { origin: "null", cookie: A.cookie, body: { reset: true } }));
    expect(opaque.status).toBe(403);
    expect(await opaque.json()).toEqual({ error: "Bad origin." });

    // Control: the same request from this origin is accepted.
    const ok = await chaosPOST(makeReq("/api/chaos", { origin: SAME_ORIGIN, cookie: A.cookie, body: { service: "billing", operation: "refund", mode: "fail_503" } }));
    expect(ok.status).toBe(200);
    expect((await chaosList(A.cookie)).faults.map((f) => f.mode)).toEqual(["fail_503"]);
  });

  it("requests without a session cookie get 401", async () => {
    const id = "thr_nocookie1";
    const responses = await Promise.all([
      chaosGET(makeReq("/api/chaos")),
      chaosPOST(makeReq("/api/chaos", { origin: SAME_ORIGIN, body: { reset: true } })),
      threadGET(makeReq(`/api/threads/${id}`), params({ id })),
      servicesGET(makeReq("/api/services/overview?customerId=CUS-1004"), params({ name: "overview" })),
      servicesGET(makeReq("/api/services/customers"), params({ name: "customers" })),
      ragPOST(makeReq("/api/rag-search", { origin: SAME_ORIGIN, body: { query: "return window", governingDate: "2026-08-09" } })),
      resolvePOST(makeReq("/api/resolve", { origin: SAME_ORIGIN, body: { message: "hello" } })),
      hitlPOST(makeReq("/api/hitl", { origin: SAME_ORIGIN, body: { threadId: "thr_abcdef12", interruptId: "x", decision: "approve" } })),
      recoverPOST(makeReq("/api/saga/recover", { method: "POST", origin: SAME_ORIGIN })),
    ]);
    expect(responses.map((r) => r.status)).toEqual(responses.map(() => 401));
    const bodies = await Promise.all(responses.map((r) => r.json()));
    for (const b of bodies) expect(b).toEqual(NO_SANDBOX);
  });

  it("only the session cookie's exact name is read, wherever it sits in the cookie header", async () => {
    const A = await newSession();
    const res = await chaosGET(makeReq("/api/chaos", { cookie: `other_${A.cookie}` }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(NO_SANDBOX);
    const prefixed = await chaosGET(makeReq("/api/chaos", { cookie: `x${A.cookie}` }));
    expect(prefixed.status).toBe(401);
    // Control: the same cookie among unrelated ones is found and accepted.
    const mixed = await chaosGET(makeReq("/api/chaos", { cookie: `theme=dark; ${A.cookie}; consent=no` }));
    expect(mixed.status).toBe(200);
  });

  it("tampering with the cookie signature or payload gets 401", async () => {
    const A = await newSession();
    const B = await newSession();
    const valueA = cookieValue(A.cookie);
    const [bodyA, sigA] = valueA.split(".");
    const flippedSig = sigA.slice(0, -1) + (sigA.at(-1) === "a" ? "b" : "a");
    const bodyB = cookieValue(B.cookie).split(".")[0];
    const longLived = Buffer.from(JSON.stringify({ sid: A.sandboxId, exp: 9_999_999_999 })).toString("base64url");
    const forgedKey = `${longLived}.${hmacHex(longLived, "guessed-secret")}`;

    const variants = [
      `${bodyA}.${flippedSig}`, // flipped signature char
      `${bodyB}.${sigA}`, // B's payload with A's signature
      `${longLived}.${sigA}`, // extended expiry, stale signature
      forgedKey, // re-signed with a guessed key
      `${bodyA}.`, // signature stripped
      bodyA, // no signature part at all
      "", // empty value
    ];
    for (const v of variants) {
      const res = await chaosGET(makeReq("/api/chaos", { cookie: `${SESSION_COOKIE}=${encodeURIComponent(v)}` }));
      expect(res.status, v).toBe(401);
      expect(await res.json()).toEqual(NO_SANDBOX);
    }
    // The untampered cookie still works, and still names A's sandbox (not B's).
    const good = await chaosGET(makeReq("/api/chaos", { cookie: A.cookie }));
    expect(good.status).toBe(200);
    await chaosPOST(makeReq("/api/chaos", { origin: SAME_ORIGIN, cookie: A.cookie, body: { service: "billing", operation: "refund", mode: "fail_503" } }));
    expect((await chaosList(A.cookie)).faults).toHaveLength(1);
    expect((await chaosList(B.cookie)).faults).toHaveLength(0);
  });

  // BUG: readCookie() in src/lib/http.ts calls decodeURIComponent() on the raw cookie value
  // without a try/catch. A tampered cookie containing a malformed percent-escape (e.g.
  // "or_session=%E0%A4%A") makes decodeURIComponent throw URIError, which route() turns into
  // a generic 500 "Something went wrong." (and logs a stack trace) instead of the 401
  // "No active sandbox" every other invalid cookie gets.
  // Expected: 401. Actual: 500.
  it("a cookie with a malformed percent-escape is rejected with 401 (not 500)", async () => {
    const res = await chaosGET(makeReq("/api/chaos", { cookie: `${SESSION_COOKIE}=%E0%A4%A` }));
    expect(res.status).toBe(401);
  });

  it("validly signed cookies for missing, expired or template sandboxes get 401", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const missing = signSession({ sid: "sb_doesnotexist", exp: future });
    const template = signSession({ sid: TEMPLATE_SANDBOX_ID, exp: future });
    for (const v of [missing, template]) {
      const res = await chaosGET(makeReq("/api/chaos", { cookie: `${SESSION_COOKIE}=${v}` }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(EXPIRED);
    }
    // The template cannot be read through the services API either.
    const tplOverview = await overview("CUS-1004", `${SESSION_COOKIE}=${template}`);
    expect(tplOverview.status).toBe(401);

    // A real sandbox whose row has expired (but has not been cleaned up yet) is refused too.
    const A = await newSession();
    await db().update(s.sandboxes).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(s.sandboxes.id, A.sandboxId));
    const res = await chaosGET(makeReq("/api/chaos", { cookie: A.cookie }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(EXPIRED);

    // A signed cookie whose own exp has passed is rejected before the DB is consulted.
    const B = await newSession();
    const stale = signSession({ sid: B.sandboxId, exp: Math.floor(Date.now() / 1000) - 1 });
    const staleRes = await chaosGET(makeReq("/api/chaos", { cookie: `${SESSION_COOKIE}=${stale}` }));
    expect(staleRes.status).toBe(401);
    expect(await staleRes.json()).toEqual(NO_SANDBOX);
    // Control: B's own cookie is fine.
    expect((await chaosGET(makeReq("/api/chaos", { cookie: B.cookie }))).status).toBe(200);
  });

  it("malformed bodies get 400 and write nothing", async () => {
    const A = await newSession();
    const post = (path: string, rawBody: string) => makeReq(path, { origin: SAME_ORIGIN, cookie: A.cookie, rawBody });

    const notJson = await chaosPOST(post("/api/chaos", "{service:"));
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: "Body must be JSON." });

    const empty = await chaosPOST(post("/api/chaos", ""));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toMatch(/^Invalid request:/);

    for (const raw of ["null", "[]", '"reset"', "42"]) {
      const res = await chaosPOST(post("/api/chaos", raw));
      expect(res.status, raw).toBe(400);
      expect(((await res.json()) as { error: string }).error, raw).toMatch(/^Invalid request:/);
    }

    const badMode = await chaosPOST(post("/api/chaos", JSON.stringify({ service: "billing", operation: "refund", mode: "explode" })));
    expect(badMode.status).toBe(400);
    expect(((await badMode.json()) as { error: string }).error).toMatch(/^Invalid request:/);

    const badN = await chaosPOST(post("/api/chaos", JSON.stringify({ service: "billing", operation: "refund", mode: "fail_n_times", n: 9 })));
    expect(badN.status).toBe(400);
    expect(((await badN.json()) as { error: string }).error).toMatch(/^Invalid request: n /);

    const resetFalse = await chaosPOST(post("/api/chaos", JSON.stringify({ reset: false })));
    expect(resetFalse.status).toBe(400);

    const unknownOp = await chaosPOST(post("/api/chaos", JSON.stringify({ service: "billing", operation: "wireTransfer", mode: "fail_503" })));
    expect(unknownOp.status).toBe(400);
    expect(await unknownOp.json()).toEqual({ error: "Unknown service operation." });

    const shortQuery = await ragPOST(post("/api/rag-search", JSON.stringify({ query: "x", governingDate: "2026-08-09" })));
    expect(shortQuery.status).toBe(400);
    expect(((await shortQuery.json()) as { error: string }).error).toMatch(/^Invalid request: query /);
    const badDate = await ragPOST(post("/api/rag-search", JSON.stringify({ query: "return window", governingDate: "08/09/2026" })));
    expect(badDate.status).toBe(400);
    expect(((await badDate.json()) as { error: string }).error).toMatch(/^Invalid request: governingDate /);

    const badReset = await sessionPOST(post("/api/session", JSON.stringify({ reset: "yes" })));
    expect(badReset.status).toBe(400);
    expect(badReset.headers.get("set-cookie")).toBeNull();
    expect(await sandboxIsLive(db(), A.sandboxId)).toBe(true);

    const badThreadId = await resolvePOST(post("/api/resolve", JSON.stringify({ threadId: "../../etc", message: "hi" })));
    expect(badThreadId.status).toBe(400);
    expect(((await badThreadId.json()) as { error: string }).error).toMatch(/^Invalid request: threadId /);
    const noMessage = await resolvePOST(post("/api/resolve", JSON.stringify({ customerId: "CUS-1004" })));
    expect(noMessage.status).toBe(400);
    expect(((await noMessage.json()) as { error: string }).error).toMatch(/^Invalid request: message /);
    const notJsonResolve = await resolvePOST(post("/api/resolve", "message=hi"));
    expect(notJsonResolve.status).toBe(400);
    expect(await notJsonResolve.json()).toEqual({ error: "Body must be JSON." });

    const badDecision = await hitlPOST(post("/api/hitl", JSON.stringify({ threadId: "thr_abcdef12", interruptId: "x", decision: "yolo" })));
    expect(badDecision.status).toBe(400);
    expect(((await badDecision.json()) as { error: string }).error).toMatch(/^Invalid request: decision /);

    const badCustomer = await servicesGET(makeReq("/api/services/overview?customerId=1004", { cookie: A.cookie }), params({ name: "overview" }));
    expect(badCustomer.status).toBe(400);
    expect(await badCustomer.json()).toEqual({ error: "customerId is required." });

    // Nothing was written by any of the rejected requests.
    expect((await chaosList(A.cookie)).faults).toEqual([]);
    expect(await db().select().from(s.threads).where(eq(s.threads.sandboxId, A.sandboxId))).toHaveLength(0);
    expect(await db().select().from(s.hitlDecisions).where(eq(s.hitlDecisions.sandboxId, A.sandboxId))).toHaveLength(0);
  });

  it("oversized bodies get 413 (by declared content-length and by actual size)", async () => {
    const A = await newSession();
    const huge = JSON.stringify({ query: "x".repeat(70 * 1024), governingDate: "2026-08-09" });
    const res = await ragPOST(makeReq("/api/rag-search", { origin: SAME_ORIGIN, cookie: A.cookie, rawBody: huge }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request body too large." });

    // A declared length over the cap is refused before the body is parsed (the body itself is tiny and valid).
    const declared = await ragPOST(
      makeReq("/api/rag-search", {
        origin: SAME_ORIGIN,
        cookie: A.cookie,
        rawBody: JSON.stringify({ query: "return window", governingDate: "2026-08-09" }),
        headers: { "content-length": String(AGENT.firewall.maxBodyBytes + 1) },
      }),
    );
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "Request body too large." });

    // Just under the cap is not a 413 (it fails validation instead: query max is 500 chars).
    const under = JSON.stringify({ query: "x".repeat(60 * 1024), governingDate: "2026-08-09" });
    const underRes = await ragPOST(makeReq("/api/rag-search", { origin: SAME_ORIGIN, cookie: A.cookie, rawBody: under }));
    expect(underRes.status).toBe(400);
  });

  // BUG: parseBody() in src/lib/http.ts enforces AGENT.firewall.maxBodyBytes (64 KiB) with
  // `text.length`, which counts UTF-16 code units, not bytes. When no Content-Length header is
  // present (e.g. a chunked request), a body of 25,000 "€" characters (75,041 UTF-8 bytes, over
  // the 65,536-byte cap) passes the size check and is JSON-parsed and validated.
  // Expected: 413 "Request body too large.". Actual: 400 from schema validation. Low severity:
  // every schema caps its strings far below the limit, so nothing oversized is accepted.
  it("a multi-byte body over the byte cap without content-length gets 413", async () => {
    const A = await newSession();
    const raw = JSON.stringify({ query: "€".repeat(25_000), governingDate: "2026-08-09" });
    expect(Buffer.byteLength(raw)).toBeGreaterThan(AGENT.firewall.maxBodyBytes);
    const res = await ragPOST(makeReq("/api/rag-search", { origin: SAME_ORIGIN, cookie: A.cookie, rawBody: raw }));
    expect(res.status).toBe(413);
  });

  it("unknown service views and customers from nowhere are 404s", async () => {
    const A = await newSession();
    const unknown = await servicesGET(makeReq("/api/services/payroll", { cookie: A.cookie }), params({ name: "payroll" }));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "Unknown service view." });
    const noCustomer = await overview("CUS-9999", A.cookie);
    expect(noCustomer.status).toBe(404);
    expect(await noCustomer.json()).toEqual({ error: "Customer not found." });
  });
});

// ---------------------------------------------------------------------------------------
describe("GET /api/health", () => {
  const SECRET_SHAPES = [/gsk_/i, /AIza/, /postgres(ql)?:\/\//i, /sk-[A-Za-z0-9]/];

  it("returns status ok with provider booleans and no secrets", async () => {
    const res = await healthGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text) as { status: string; db: string; seedTemplate: boolean; providers: Record<string, unknown>; mode: string; corpus: { clauses: number } };
    // Exactly these top-level fields: nothing else (e.g. an env dump) can ride along.
    expect(Object.keys(body).sort()).toEqual(["commit", "corpus", "db", "mode", "providers", "replay", "seedTemplate", "status"]);
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
    expect(body.seedTemplate).toBe(true);
    expect(body.providers).toEqual({ groq: false, gemini: false });
    for (const v of Object.values(body.providers)) expect(typeof v).toBe("boolean");
    expect(body.mode).toBe("replay");
    expect(body.corpus.clauses).toBe(126);
    expect(text).not.toContain(secret("SESSION_SECRET"));
    expect(text).not.toContain(secret("APPROVAL_SIGNING_SECRET"));
    expect(text).not.toContain(secret("CRON_SECRET"));
    expect(text).not.toContain(process.env.DATABASE_URL!);
    for (const re of SECRET_SHAPES) expect(text).not.toMatch(re);
  });

  it("reports a configured provider as true without echoing the key", async () => {
    const fakeKey = "gsk_unit_test_placeholder_not_a_real_key_000000";
    const prev = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = fakeKey;
    resetEnvCache();
    try {
      const res = await healthGET();
      const text = await res.text();
      const body = JSON.parse(text) as { providers: Record<string, boolean> };
      expect(body.providers).toEqual({ groq: true, gemini: false });
      expect(text).not.toContain(fakeKey);
      for (const re of SECRET_SHAPES) expect(text).not.toMatch(re);
    } finally {
      // Assigning undefined to process.env would store the string "undefined" (a truthy key).
      if (prev === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = prev;
      resetEnvCache();
    }
    // The restore really took effect.
    expect(((await (await healthGET()).json()) as { providers: Record<string, boolean> }).providers).toEqual({ groq: false, gemini: false });
  });
});

// ---------------------------------------------------------------------------------------
describe("POST /api/rag-search", () => {
  type Clause = { key: string; version: string; policyId: string; inEffect: boolean; governingDate: string; effectiveFrom: string; effectiveTo: string | null; rank: number };
  type RagBody = {
    temporal: { naive: boolean; results: Clause[]; removed: { key: string; reason: string }[]; candidates: number };
    naive: { naive: boolean; results: Clause[]; candidates: number } | null;
    staleInNaive: number | null;
  };
  const ORDER_DATE_FAMILIES = ["RETURNS_STANDARD", "SHIPPING_DELAYS", "DAMAGE_TRANSIT"];

  async function rag(cookie: string, body: Record<string, unknown>): Promise<RagBody> {
    const res = await ragPOST(makeReq("/api/rag-search", { origin: SAME_ORIGIN, cookie, body }));
    expect(res.status).toBe(200);
    return (await res.json()) as RagBody;
  }

  /** Independent check of the in-effect claim against the clause's own dates. */
  function reallyInEffect(r: Clause): boolean {
    return r.effectiveFrom <= r.governingDate && (r.effectiveTo === null || r.effectiveTo >= r.governingDate);
  }

  it("temporal results are all in effect on the governing date; the naive comparison surfaces stale versions", async () => {
    const A = await newSession();
    const body = await rag(A.cookie, { query: "return window days to return an item", governingDate: "2026-08-09", compare: true });

    const t = body.temporal;
    expect(t.naive).toBe(false);
    expect(t.results.length).toBeGreaterThan(0);
    expect(t.results.every((r) => r.inEffect)).toBe(true);
    expect(t.results.map((r) => r.rank)).toEqual(t.results.map((_, i) => i + 1));
    for (const r of t.results) {
      expect(reallyInEffect(r), r.key).toBe(true);
      if (ORDER_DATE_FAMILIES.includes(r.policyId)) expect(r.governingDate).toBe("2026-08-09");
      else expect(r.governingDate).toBe("2026-10-16");
    }
    expect(t.results.map((r) => r.key)).toContain("§1.4@2026.1");
    expect(t.results.some((r) => r.version === "2024.1")).toBe(false);
    expect(t.removed.length).toBeGreaterThan(0);
    const removed14 = t.removed.find((x) => x.key === "§1.4@2024.1");
    expect(removed14?.reason).toBe("not in effect on 2026-08-09");
    // Removed and returned clauses are disjoint, and together cover the whole corpus.
    const resultKeys = new Set(t.results.map((r) => r.key));
    expect(t.removed.filter((x) => resultKeys.has(x.key))).toEqual([]);
    expect(t.candidates + t.removed.length).toBe(126);

    expect(body.naive).not.toBeNull();
    const n = body.naive!;
    expect(n.naive).toBe(true);
    expect(n.candidates).toBe(126);
    const stale = n.results.filter((r) => !r.inEffect);
    expect(body.staleInNaive).toBe(stale.length);
    expect(stale.length).toBeGreaterThan(0);
    // The naive retriever really does surface the superseded 2024 return-window clause, and the flag is honest.
    const old14 = n.results.find((r) => r.key === "§1.4@2024.1");
    expect(old14?.inEffect).toBe(false);
    for (const r of n.results) expect(r.inEffect, r.key).toBe(reallyInEffect(r));
  });

  it("the filter follows the governing date (older versions win for older orders) and claimDate drives non-order families", async () => {
    const A = await newSession();
    const old = await rag(A.cookie, { query: "return window days to return an item", governingDate: "2024-03-01" });
    expect(old.temporal.results.length).toBeGreaterThan(0);
    expect(old.temporal.results.every((r) => r.inEffect && reallyInEffect(r))).toBe(true);
    expect(old.temporal.results.map((r) => r.key)).toContain("§1.4@2024.1");
    expect(old.temporal.results.some((r) => r.key === "§1.4@2026.1")).toBe(false);

    const withClaim = await rag(A.cookie, { query: "duplicate charge refund", governingDate: "2026-10-10", claimDate: "2026-01-15" });
    expect(withClaim.temporal.results.length).toBeGreaterThan(0);
    expect(withClaim.temporal.results.some((r) => !ORDER_DATE_FAMILIES.includes(r.policyId))).toBe(true);
    for (const r of withClaim.temporal.results) {
      expect(r.governingDate, r.key).toBe(ORDER_DATE_FAMILIES.includes(r.policyId) ? "2026-10-10" : "2026-01-15");
      expect(reallyInEffect(r), r.key).toBe(true);
    }
  });

  it("without compare/naive the naive comparison is omitted; naive:true alone includes it", async () => {
    const A = await newSession();
    const body = await rag(A.cookie, { query: "duplicate charge refund", governingDate: "2026-10-10" });
    expect(body.naive).toBeNull();
    expect(body.staleInNaive).toBeNull();
    expect(body.temporal.results.length).toBeGreaterThan(0);
    expect(body.temporal.results.every((r) => r.inEffect && reallyInEffect(r))).toBe(true);

    const naiveOnly = await rag(A.cookie, { query: "return window days to return an item", governingDate: "2026-08-09", naive: true });
    expect(naiveOnly.temporal.naive).toBe(false);
    expect(naiveOnly.naive?.naive).toBe(true);
    expect(naiveOnly.naive!.results.length).toBeGreaterThan(0);
    expect(naiveOnly.staleInNaive).toBe(naiveOnly.naive!.results.filter((r) => !r.inEffect).length);
    expect(naiveOnly.temporal.results.every((r) => r.inEffect)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
describe("cleanupExpired", () => {
  it("deletes an expired sandbox and cascades to every sandbox-scoped table, leaving live sandboxes and the template alone", async () => {
    const dead = await freshSandbox();
    const live = await freshSandbox();
    created.push(dead, live);
    // A full turn populates saga runs/steps, tokens, refunds, labels, tickets, traces and checkpoints.
    const thread = await newThread(dead, "CUS-1004");
    expect((await skilletTurn(dead, thread)).status).toBe("REPLIED");
    await fault(dead, "billing", "refund", "fail_503");

    const tables = await sandboxTables();
    expect(tables).toEqual(expect.arrayContaining(["customers", "orders", "refunds", "labels", "saga_runs", "approval_tokens", "threads", "trace_events", "fault_settings"]));
    const beforeDead = await rowCounts(tables, dead);
    for (const t of ["customers", "orders", "charges", "refunds", "labels", "replacement_drafts", "tickets", "saga_runs", "approval_tokens", "threads", "trace_events", "fault_settings", "shipments"]) {
      expect(beforeDead[t], t).toBeGreaterThan(0);
    }
    expect(await sagaStepRows(dead)).toBeGreaterThan(0);
    const beforeLive = await rowCounts(tables, live);
    const templateBefore = await rowCounts(["customers", "orders"], TEMPLATE_SANDBOX_ID);

    await db().update(s.sandboxes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(s.sandboxes.id, dead));
    const res = await cleanupExpired(db());
    expect(res.sandboxes).toBeGreaterThanOrEqual(1);
    expect(res.threadIds).toContain(thread);

    expect(await db().select().from(s.sandboxes).where(eq(s.sandboxes.id, dead))).toHaveLength(0);
    expect(await rowCounts(tables, dead)).toEqual(Object.fromEntries(tables.map((t) => [t, 0])));
    expect(await sagaStepRows(dead)).toBe(0);
    expect(await rowCounts(tables, live)).toEqual(beforeLive);
    expect(await sandboxIsLive(db(), live)).toBe(true);
    expect(await rowCounts(["customers", "orders"], TEMPLATE_SANDBOX_ID)).toEqual(templateBefore);
    const tpl = await db().select().from(s.sandboxes).where(and(eq(s.sandboxes.id, TEMPLATE_SANDBOX_ID), eq(s.sandboxes.isTemplate, true)));
    expect(tpl).toHaveLength(1);
    // A second pass has nothing of ours left to do.
    expect((await cleanupExpired(db())).threadIds).not.toContain(thread);
  });

  it("never selects or deletes the template, even when its expiry has passed (rolled back afterwards)", async () => {
    const dead = await freshSandbox();
    created.push(dead);
    class Rollback extends Error {}
    let observed: { result: { sandboxes: number; threadIds: string[] }; expected: number; templateLeft: number; deadLeft: number } | null = null;
    await db()
      .transaction(async (tx) => {
        const now = new Date();
        await tx.update(s.sandboxes).set({ expiresAt: new Date(now.getTime() - 1000) }).where(eq(s.sandboxes.id, TEMPLATE_SANDBOX_ID));
        await tx.update(s.sandboxes).set({ expiresAt: new Date(now.getTime() - 1000) }).where(eq(s.sandboxes.id, dead));
        const expiredNonTemplate = await tx
          .select({ id: s.sandboxes.id })
          .from(s.sandboxes)
          .where(and(lt(s.sandboxes.expiresAt, new Date()), eq(s.sandboxes.isTemplate, false)));
        const result = await cleanupExpired(tx as unknown as Db);
        const templateLeft = (await tx.select().from(s.sandboxes).where(eq(s.sandboxes.id, TEMPLATE_SANDBOX_ID))).length;
        const deadLeft = (await tx.select().from(s.sandboxes).where(eq(s.sandboxes.id, dead))).length;
        observed = { result, expected: expiredNonTemplate.length, templateLeft, deadLeft };
        throw new Rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(observed).not.toBeNull();
    const o = observed!;
    expect(o.expected).toBeGreaterThanOrEqual(1);
    expect(o.result.sandboxes).toBe(o.expected); // the template is not counted
    expect(o.templateLeft).toBe(1);
    expect(o.deadLeft).toBe(0);
    // The rollback restored the template's far-future expiry.
    const [tpl] = await db().select().from(s.sandboxes).where(eq(s.sandboxes.id, TEMPLATE_SANDBOX_ID));
    expect(tpl.expiresAt.getTime()).toBeGreaterThan(Date.now() + 365 * 86_400_000);
  });

  it("GET /api/cron/cleanup requires the Bearer secret, then deletes expired sandboxes and their checkpoints", async () => {
    const dead = await freshSandbox();
    created.push(dead);
    const thread = await newThread(dead, "CUS-1004");
    expect((await skilletTurn(dead, thread)).status).toBe("REPLIED");
    expect(await checkpointRows(thread)).toBeGreaterThan(0);
    await db().update(s.sandboxes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(s.sandboxes.id, dead));

    const cronSecret = secret("CRON_SECRET");
    for (const authorization of [undefined, "Bearer guess", `Bearer ${cronSecret}x`, `bearer ${cronSecret}`, cronSecret, `Bearer  ${cronSecret}`]) {
      const res = await cronGET(makeReq("/api/cron/cleanup", { headers: authorization === undefined ? {} : { authorization } }));
      expect(res.status, String(authorization)).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized." });
    }
    // Rejected calls deleted nothing.
    expect(await db().select().from(s.sandboxes).where(eq(s.sandboxes.id, dead))).toHaveLength(1);
    expect(await checkpointRows(thread)).toBeGreaterThan(0);

    const ok = await cronGET(makeReq("/api/cron/cleanup", { headers: { authorization: `Bearer ${cronSecret}` } }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { deletedSandboxes: number; deletedThreads: number };
    expect(body.deletedSandboxes).toBeGreaterThanOrEqual(1);
    expect(body.deletedThreads).toBeGreaterThanOrEqual(1);
    expect(await db().select().from(s.sandboxes).where(eq(s.sandboxes.id, dead))).toHaveLength(0);
    expect(await db().select().from(s.threads).where(eq(s.threads.id, thread))).toHaveLength(0);
    // Checkpoints have no FK to sandboxes; the cron route removes them explicitly.
    expect(await checkpointRows(thread)).toBe(0);
  });
});
