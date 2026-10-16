/**
 * POST /api/rag-search — retriever inspector. Runs the same hybrid retriever the agent uses,
 * with and without the temporal filter, and returns every score, rank and removed clause.
 */
import { z } from "zod";
import { AGENT } from "@/config/agent";
import { retrieve } from "@/lib/rag/retriever";
import { rateLimit } from "@/lib/security/rate-limiter";
import { assertSameOrigin, json, parseBody, requireSandbox, route } from "@/lib/http";
import { HttpError } from "@/lib/util/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Body = z.object({
  query: z.string().min(2).max(500),
  governingDate: isoDate,
  claimDate: isoDate.optional(),
  naive: z.boolean().optional(),
  compare: z.boolean().optional(),
});

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const sandboxId = await requireSandbox(req);
  if (!rateLimit(`rag:${sandboxId}`, AGENT.rateLimits.ragPerMinuteSandbox, 60_000).ok) throw new HttpError(429, "Too many searches this minute.");
  const body = await parseBody(req, Body);
  const dates = { claimDate: body.claimDate ?? AGENT.businessDate, orderDate: body.governingDate };
  const temporal = retrieve({ query: body.query, dates, naive: false });
  const naive = body.compare || body.naive ? retrieve({ query: body.query, dates, naive: true }) : null;
  const staleInNaive = naive ? naive.results.filter((r) => !r.inEffect).length : null;
  return json({ temporal, naive, staleInNaive });
});
