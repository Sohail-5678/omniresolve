/**
 * POST /api/saga/recover — finishes sagas in this sandbox that were interrupted mid-run
 * (forward past the pivot, compensation before it), then lets each affected thread's graph
 * complete its turn. Streams the saga steps like a normal turn.
 */
import { getDb } from "@/db/client";
import { recoverThreads } from "@/lib/agent/runner";
import { assertSameOrigin, requireSandbox, route, sse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const sandboxId = await requireSandbox(req);
  const db = getDb();
  return sse(async (send) => {
    const out = await recoverThreads({ db, sandboxId, mode: "replay", emit: (e) => send(e.type, e) }, 0);
    send("result", { recovered: out.sagas.map((x) => ({ sagaId: x.sagaId, status: x.status })), threads: out.threads });
  });
});
