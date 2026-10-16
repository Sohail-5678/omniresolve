/** GET /api/cron/cleanup — deletes sandboxes older than 24 h (and their checkpoints). Requires Bearer CRON_SECRET. */
import { getDb } from "@/db/client";
import { secret } from "@/config/env";
import { cleanupExpired } from "@/lib/security/sandbox";
import { getCheckpointer } from "@/lib/agent/graph";
import { safeEqualHex, sha256Hex } from "@/lib/util/canonical";
import { json, route } from "@/lib/http";
import { HttpError } from "@/lib/util/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = route(async (req: Request) => {
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret("CRON_SECRET")}`;
  if (!safeEqualHex(sha256Hex(auth), sha256Hex(expected))) throw new HttpError(401, "Unauthorized.");
  const { sandboxes, threadIds } = await cleanupExpired(getDb());
  const saver = getCheckpointer();
  for (const id of threadIds) await saver.deleteThread(id).catch(() => undefined);
  return json({ deletedSandboxes: sandboxes, deletedThreads: threadIds.length });
});
