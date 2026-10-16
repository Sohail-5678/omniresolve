/**
 * Prompt firewall (spec 7.9). Size caps, strips invisible/Unicode-Tag characters (and scans
 * what they were hiding), then scores heuristic signals: instruction overrides, authority
 * claims, tool-call text, prompt extraction, pressure, fake promises/citations.
 *   allow  → normal run
 *   flag   → run continues, but every money action is forced to NEEDS_HUMAN
 *   block  → polite refusal, no graph run
 * Honest limit: heuristics REDUCE risk and improve routing to humans; they can be bypassed.
 * What actually prevents unauthorized money movement is the token check at the tool boundary.
 */
import { randomBytes } from "node:crypto";
import { AGENT } from "@/config/agent";

export type FirewallSignal = { rule: string; weight: number; match: string };
export type FirewallOutcome = "allow" | "flag" | "block";
export type FirewallResult = {
  outcome: FirewallOutcome;
  score: number;
  signals: FirewallSignal[];
  sanitizedText: string;
  strippedChars: number;
  hiddenText: string | null;
  reason: string | null;
};

const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿᠎­]/g;

type Rule = { rule: string; weight: number; patterns: RegExp[] };

const RULES: Rule[] = [
  {
    rule: "instruction_override",
    weight: 3,
    patterns: [
      /\b(ignore|disregard|forget|override|bypass|skip)\b[^.\n]{0,40}?\b(rules?|(?<!(?:shipping|delivery|care|washing|assembly|return) )instructions?|polic(?:y|ies)|guidelines|guardrails|restrictions|system prompt|safety checks?)\b/i,
      /\b(system override|developer mode|jailbreak|dan mode|admin mode|god mode|maintenance mode|sudo mode)\b/i,
      /\bnew instructions?\s*:/i,
      /\byou are now (a|an|the|in)\b/i,
    ],
  },
  {
    rule: "authority_claim",
    weight: 2,
    patterns: [
      /\b(?:i am|i'm|im|this is)\s+(?:the\s+|a\s+|your\s+)?(?:vp|vice president|ceo|cfo|cto|coo|founder|director|head|supervisor|admin(?:istrator)?)\b(?:\s+of\s+(?:support|customer|engineering|operations|billing|the company))?/i,
      /\b(?:i am|i'm|this is)\s+(?:a\s+|the\s+)?(?:staff|employee|support agent|manager)\s+(?:at|of|from|here)\b/i,
    ],
  },
  {
    rule: "authority_approval",
    weight: 3,
    patterns: [
      /\b(ceo|vp|management|your supervisor|your manager|your boss|legal team|executive team|head of support)\s+(?:has\s+|have\s+|already\s+)*(approved|authori[sz]ed|signed off|okayed|cleared)\b/i,
      /\b(pre-?approved|already approved|approval code|authori[sz]ation code)\b/i,
    ],
  },
  {
    rule: "tool_call_text",
    weight: 3,
    patterns: [
      /\b(issue_refund|refund_order|create_refund|process_refund|issue_store_credit|store_credit|create_label|create_return_label|tool_call|function_call|execute_action|approve_refund)\s*\(/i,
      /"(order_?id|amount(?:_cents)?|action|tool|function|arguments)"\s*:/i,
      /<\/?(tool|function|system|assistant)\b[^>]*>/i,
    ],
  },
  {
    rule: "role_tag",
    weight: 3,
    patterns: [/^\s*(system|assistant|developer)\s*:/im, /\[\s*(system|admin)\s*\]/i],
  },
  {
    rule: "system_prompt_probe",
    weight: 3,
    patterns: [
      /\b(system prompt|hidden prompt|initial prompt)\b/i,
      /\b(reveal|print|show|repeat|output)\s+(?:me\s+)?(your|the)\s+(prompt|instructions|rules)\b/i,
      /\bwhat (?:are|were) your (?:exact )?instructions\b/i,
    ],
  },
  {
    rule: "urgency_pressure",
    weight: 1,
    patterns: [/\b(right now|immediately|asap|or else|final warning|last chance|within (?:the )?(?:next )?\d+ minutes)\b/i, /\b(lawsuit|sue you|my lawyer|attorney|report you)\b/i],
  },
  {
    rule: "fake_prior_promise",
    weight: 1,
    patterns: [/\b(previous|earlier|last|other)\s+(agent|rep(?:resentative)?|person|chat|associate)\s+(promised|said|told|guaranteed|approved|agreed)\b/i],
  },
  {
    rule: "encoded_payload",
    weight: 2,
    patterns: [/[A-Za-z0-9+/]{60,}={0,2}/],
  },
];

export function stripHidden(text: string): { clean: string; stripped: number; hidden: string } {
  let stripped = 0;
  let hidden = "";
  const noTags = text.replace(TAG_CHARS, (ch) => {
    stripped++;
    const cp = ch.codePointAt(0)! - 0xe0000;
    if (cp >= 0x20 && cp < 0x7f) hidden += String.fromCharCode(cp);
    return "";
  });
  const clean = noTags.replace(INVISIBLE, () => {
    stripped++;
    return "";
  });
  return { clean, stripped, hidden };
}

export function runFirewall(
  text: string,
  opts: { turnCount?: number; knownClauseIds?: ReadonlySet<string> } = {},
): FirewallResult {
  const { clean, stripped, hidden } = stripHidden(text);
  const signals: FirewallSignal[] = [];

  if (text.length > AGENT.firewall.maxMessageChars) {
    return { outcome: "block", score: 99, signals: [{ rule: "message_too_long", weight: 99, match: `${text.length} chars` }], sanitizedText: clean.slice(0, AGENT.firewall.maxMessageChars), strippedChars: stripped, hiddenText: hidden || null, reason: "MESSAGE_TOO_LONG" };
  }
  if ((opts.turnCount ?? 0) > AGENT.firewall.maxTurns) {
    return { outcome: "block", score: 99, signals: [{ rule: "conversation_too_long", weight: 99, match: `${opts.turnCount} turns` }], sanitizedText: clean, strippedChars: stripped, hiddenText: hidden || null, reason: "CONVERSATION_TOO_LONG" };
  }

  if (stripped > 0) signals.push({ rule: "hidden_unicode", weight: 4, match: `${stripped} invisible character(s) removed` });

  const scan = hidden ? `${clean}\n${hidden}` : clean;
  for (const r of RULES) {
    for (const p of r.patterns) {
      const m = p.exec(scan);
      if (m) {
        signals.push({ rule: r.rule, weight: r.weight, match: m[0].slice(0, 80) });
        break;
      }
    }
  }

  if (opts.knownClauseIds) {
    for (const m of scan.matchAll(/(?:§|section\s+)(\d+\.\d+)/gi)) {
      const id = `§${m[1]}`;
      if (!opts.knownClauseIds.has(id)) {
        signals.push({ rule: "fake_policy_citation", weight: 2, match: m[0] });
        break;
      }
    }
  }

  const score = signals.reduce((s, x) => s + x.weight, 0);
  const outcome: FirewallOutcome = score >= AGENT.firewall.blockScore ? "block" : score >= AGENT.firewall.flagScore ? "flag" : "allow";
  return { outcome, score, signals, sanitizedText: clean, strippedChars: stripped, hiddenText: hidden || null, reason: outcome === "block" ? "INJECTION_SCORE" : null };
}

/** Wraps untrusted customer text in per-request random delimiters (spotlighting). */
export function spotlight(text: string): { open: string; close: string; wrapped: string; tag: string } {
  const tag = randomBytes(3).toString("hex");
  const open = `<<CUSTOMER_MSG_${tag}>>`;
  const close = `<</CUSTOMER_MSG_${tag}>>`;
  const safe = stripDelimiters(text);
  return { open, close, wrapped: `${open}\n${safe}\n${close}`, tag };
}

/** Removes spotlight delimiters until none remain (one pass can leave a nested one behind). */
export function stripDelimiters(text: string): string {
  let prev = text;
  for (let i = 0; i < 20; i++) {
    const next = prev.replace(/<<\/?CUSTOMER_MSG_[0-9a-f]+>>/gi, "");
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}
