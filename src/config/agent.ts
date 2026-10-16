/**
 * Every limit, threshold and timing the agent uses, in one place.
 * Changing a value here changes behaviour everywhere; each value says why it is what it is.
 */

export const AGENT = {
  /**
   * Frozen business clock. Policy windows ("30 days from the order date") are computed
   * against this date so the seeded scenarios behave the same every day the demo is opened.
   * Security clocks (token expiry, sandbox TTL, rate limits) always use real time.
   */
  businessDate: "2026-10-16",

  /** Per-turn budget (spec 7.1). Exceeding any of these escalates with BUDGET_EXCEEDED. */
  turn: {
    maxLlmCalls: 8,
    maxRepairs: 2, // per structured call
    maxWallMs: 25_000,
    maxOutputTokens: 6_000,
  },

  /** Per LLM call ceiling sent to providers (keeps free-tier token budgets predictable). */
  llm: {
    maxTokensPerCall: 1_100,
    temperature: 0,
    providerTimeoutMs: 20_000,
    providerRetries: 2, // retries on 429/5xx inside one call (counts toward wall time, not LLM calls)
  },

  /** Saga retry policy (spec 7.7.4): min(cap, base * 2^attempt) * random(0.5, 1.0). */
  retry: {
    baseMs: 100,
    capMs: 2_000,
    maxAttempts: 3,
    /** A mock 429 says "retry-after: 1s". We honour it but never wait longer than this. */
    retryAfterCapMs: 2_000,
  },

  /** Approval tokens live for 15 minutes; a supervisor who waits longer gets fresh tokens on approve. */
  tokenTtlSeconds: 15 * 60,

  /** Chaos toggles switch themselves off after 10 minutes so a forgotten fault can't poison a demo. */
  faultAutoResetMs: 10 * 60_000,

  /** Visitor sandboxes (data, threads, traces, tokens, faults) are deleted after 24 hours. */
  sandboxTtlMs: 24 * 3_600_000,

  /** Simulated fault timings. Kept short so a turn with retries still fits the 25 s budget. */
  faults: {
    timeoutMs: 350,
    slowMs: 900,
    retryAfterSeconds: 1,
  },

  /** Per-sandbox circuit breaker for Carrier A/B. */
  breaker: {
    failureThreshold: 3,
    openMs: 30_000,
  },

  /** Retriever settings (spec 7.4). */
  retrieval: {
    bm25: { k1: 1.2, b: 0.75 },
    rrfK: 60,
    topK: 5,
    /** A clause survives the floor if BM25 > 0 or dense cosine >= this value. */
    denseFloor: 0.35,
  },

  /** Prompt firewall (spec 7.9). Scores are summed rule weights. */
  firewall: {
    maxMessageChars: 4_000,
    maxTurns: 30,
    maxBodyBytes: 64 * 1024,
    flagScore: 3,
    blockScore: 12,
  },

  /** Rate limits (spec 10.2). */
  rateLimits: {
    resolvePerMinuteSandbox: 10,
    resolvePerMinuteIp: 20,
    sessionPerHourIp: 5,
    chaosPerMinuteSandbox: 30,
    ragPerMinuteSandbox: 30,
    liveTurnsPerDaySandbox: 40,
  },

  /** Responder verifier: one regeneration, then the safe template. */
  verifier: {
    maxRegenerations: 1,
  },

  /** A saga step stuck in RUNNING for longer than this is treated as crashed by /api/saga/recover. */
  sagaStaleMs: 15_000,
} as const;

export type AgentConfig = typeof AGENT;
