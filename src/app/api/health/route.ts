/** GET /api/health — { status, commit, db, providers, mode }. Public; no secrets, only booleans. */
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { commitSha, env } from "@/config/env";
import { replayStats } from "@/lib/llm/replay";
import { corpusMeta } from "@/lib/rag/corpus";
import { json, route } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  let db: "ok" | "error" = "ok";
  let template = false;
  try {
    const r = await getDb().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM sandboxes WHERE is_template = true`);
    template = (r.rows[0]?.n ?? 0) > 0;
  } catch {
    db = "error";
  }
  return json({
    status: db === "ok" ? "ok" : "degraded",
    commit: commitSha(),
    db,
    seedTemplate: template,
    providers: { groq: !!env().GROQ_API_KEY, gemini: !!env().GEMINI_API_KEY },
    mode: env().DEFAULT_MODE,
    replay: { entries: replayStats().entries },
    corpus: corpusMeta(),
  });
});
