/**
 * Policy rules + consistency validation. Pure functions over data/policies (no DB):
 * version selection by governing date, which date governs each family, how params are
 * written in clause text, and the validator that keeps clause prose equal to rules.json.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  RULES,
  POLICY_IDS,
  allPolicyVersions,
  displayName,
  familyInfo,
  formatParamForText,
  governingDateFor,
  policyFor,
  tryPolicyFor,
  versionInEffect,
  type PolicyId,
} from "@/lib/policy/rules";
import { validatePolicies } from "@/lib/policy/validate";
import { parseClauseFile } from "@/lib/policy/clauses";
import { governingDateForClause } from "@/lib/rag/temporal-filter";
import { addDays } from "@/lib/util/dates";

const CLAUSE_DIR = join(process.cwd(), "data/policies/clauses");

/** Same discovery as scripts/validate-policies.ts: { "2026.1": "<markdown>", ... }. */
function readClauseFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const f of readdirSync(CLAUSE_DIR).filter((x) => /^v\d{4}\.\d+\.md$/.test(x))) {
    files[f.replace(/^v|\.md$/g, "")] = readFileSync(join(CLAUSE_DIR, f), "utf8");
  }
  return files;
}

/**
 * Replace `from` with `to` inside one clause section only (heading "## §x.y" up to the next
 * "## "). Throws if the section or the text is absent so a mutation can never silently no-op.
 */
function mutateClause(md: string, clauseId: string, from: string, to: string): string {
  const start = md.indexOf(`## ${clauseId} `);
  if (start < 0) throw new Error(`section ${clauseId} not found`);
  const next = md.indexOf("\n## ", start + 3);
  const end = next < 0 ? md.length : next;
  const section = md.slice(start, end);
  if (!section.includes(from)) throw new Error(`"${from}" not found in ${clauseId}`);
  return md.slice(0, start) + section.replace(from, to) + md.slice(end);
}

/** Whole-file replace that throws when `from` is absent, so a fixture edit can never no-op. */
function replaceOnce(md: string, from: string, to: string): string {
  if (!md.includes(from)) throw new Error(`"${from}" not found in clause file`);
  return md.replace(from, to);
}

function filesWith(version: string, mutate: (md: string) => string): Record<string, string> {
  const files = readClauseFiles();
  files[version] = mutate(files[version]);
  return files;
}

const ORDER_DATE_FAMILIES: PolicyId[] = ["RETURNS_STANDARD", "SHIPPING_DELAYS", "DAMAGE_TRANSIT"];
const CLAIM_DATE_FAMILIES: PolicyId[] = ["BILLING_DISPUTES", "GOODWILL_RETENTION", "APPROVAL_AUTHORITY"];

const VERSION_WINDOWS = [
  { version: "2024.1", first: "2024-01-01", last: "2024-12-31" },
  { version: "2025.1", first: "2025-01-01", last: "2025-12-31" },
  { version: "2026.1", first: "2026-01-01", last: null },
] as const;

// ---------------------------------------------------------------------------------------
describe("policyFor — version by governing date", () => {
  it("covers exactly six families with three versions each", () => {
    expect(POLICY_IDS).toEqual([
      "RETURNS_STANDARD",
      "BILLING_DISPUTES",
      "SHIPPING_DELAYS",
      "DAMAGE_TRANSIT",
      "GOODWILL_RETENTION",
      "APPROVAL_AUTHORITY",
    ]);
    for (const id of POLICY_IDS) {
      expect(allPolicyVersions().filter((p) => p.policyId === id).map((p) => p.version)).toEqual(["2024.1", "2025.1", "2026.1"]);
    }
    expect(allPolicyVersions()).toHaveLength(18);
  });

  for (const id of POLICY_IDS) {
    for (const w of VERSION_WINDOWS) {
      it(`${id}: first day ${w.first} -> ${w.version}`, () => {
        const p = policyFor(id, w.first);
        expect(p.policyId).toBe(id);
        expect(p.version).toBe(w.version);
        expect(p.effectiveFrom).toBe(w.first);
        expect(p.effectiveTo).toBe(w.last);
      });
      if (w.last) {
        it(`${id}: last day ${w.last} -> ${w.version}, next day moves on`, () => {
          expect(policyFor(id, w.last!).version).toBe(w.version);
          const nextDay = addDays(w.last!, 1);
          expect(policyFor(id, nextDay).version).not.toBe(w.version);
          expect(policyFor(id, nextDay).effectiveFrom).toBe(nextDay);
        });
      }
    }
  }

  it("returns the exact params for RETURNS_STANDARD across the version boundaries", () => {
    expect(policyFor("RETURNS_STANDARD", "2024-01-01").params.returnWindowDays).toBe(45);
    expect(policyFor("RETURNS_STANDARD", "2024-12-31").params.returnWindowDays).toBe(45);
    expect(policyFor("RETURNS_STANDARD", "2024-12-31").params.nonRefundableCategories).toEqual(["gift_card", "custom_cut_glass", "clearance"]);
    expect(policyFor("RETURNS_STANDARD", "2024-12-31").params.outOfWindowStoreCreditMaxCents).toBe(1500);
    expect(policyFor("RETURNS_STANDARD", "2025-01-01").params.returnWindowDays).toBe(90);
    expect(policyFor("RETURNS_STANDARD", "2025-01-01").params.nonRefundableCategories).toEqual(["gift_card", "custom_cut_glass"]);
    expect(policyFor("RETURNS_STANDARD", "2025-12-31").params.returnWindowDays).toBe(90);
    expect(policyFor("RETURNS_STANDARD", "2026-01-01").params.returnWindowDays).toBe(30);
    expect(policyFor("RETURNS_STANDARD", "2026-01-01").params.outOfWindowStoreCreditMaxCents).toBe(2500);
  });

  it("returns the exact params for the other families on representative dates", () => {
    expect(policyFor("BILLING_DISPUTES", "2024-06-15").params).toEqual({ duplicateReportWindowDays: 60, duplicateCaptureWindowHours: 24 });
    expect(policyFor("BILLING_DISPUTES", "2025-06-15").params.duplicateReportWindowDays).toBe(90);
    expect(policyFor("BILLING_DISPUTES", "2026-10-16").params.duplicateReportWindowDays).toBe(120);

    expect(policyFor("SHIPPING_DELAYS", "2024-12-31").params).toEqual({
      lateThresholdDays: 3,
      lateRemedy: "store_credit_flat",
      lateCreditCents: 500,
      lostAfterDays: 21,
    });
    const ship2025 = policyFor("SHIPPING_DELAYS", "2025-01-01").params;
    expect(ship2025).toEqual({ lateThresholdDays: 2, lateRemedy: "shipping_refund", lostAfterDays: 14 });
    expect("lateCreditCents" in ship2025).toBe(false);
    expect(policyFor("SHIPPING_DELAYS", "2026-01-01").params).toEqual({
      lateThresholdDays: 3,
      lateRemedy: "store_credit_pct",
      lateCreditPct: 10,
      lateCreditMaxCents: 2000,
      lostAfterDays: 10,
    });

    expect(policyFor("DAMAGE_TRANSIT", "2024-03-01").params.evidenceRequiredAboveCents).toBe(5000);
    expect(policyFor("DAMAGE_TRANSIT", "2024-03-01").params.carrierScanCountsAsEvidence).toBe(false);
    expect(policyFor("DAMAGE_TRANSIT", "2025-03-01").params.evidenceRequiredAboveCents).toBe(10000);
    expect(policyFor("DAMAGE_TRANSIT", "2025-03-01").params.shippingFeeRefund).toBe(false);
    expect(policyFor("DAMAGE_TRANSIT", "2026-03-01").params.evidenceRequiredAboveCents).toBe(15000);
    expect(policyFor("DAMAGE_TRANSIT", "2026-03-01").params.shippingFeeRefund).toBe(true);

    expect(policyFor("GOODWILL_RETENTION", "2024-12-31").params.goodwillTiers).toEqual(["platinum"]);
    expect(policyFor("GOODWILL_RETENTION", "2024-12-31").params.goodwillCooldownDays).toBe(180);
    expect(policyFor("GOODWILL_RETENTION", "2025-01-01").params.goodwillTiers).toEqual(["standard", "gold", "platinum"]);
    expect(policyFor("GOODWILL_RETENTION", "2026-01-01").params.goodwillMaxCents).toBe(2000);
    expect(policyFor("GOODWILL_RETENTION", "2026-01-01").params.goodwillTiers).toEqual(["gold", "platinum"]);

    expect(policyFor("APPROVAL_AUTHORITY", "2024-12-31").params.autoRefundLimitCents).toBe(3000);
    expect(policyFor("APPROVAL_AUTHORITY", "2024-12-31").params.vipAutoLimitCents).toBe(7500);
    expect(policyFor("APPROVAL_AUTHORITY", "2025-01-01").params.autoRefundLimitCents).toBe(5000);
    expect(policyFor("APPROVAL_AUTHORITY", "2026-10-16").params.maxRefundsPerResolution).toBe(1);
  });

  it("handles the 2024 leap day and the open-ended latest version", () => {
    expect(policyFor("RETURNS_STANDARD", "2024-02-29").version).toBe("2024.1");
    expect(policyFor("APPROVAL_AUTHORITY", "2099-12-31").version).toBe("2026.1");
    expect(policyFor("SHIPPING_DELAYS", "2030-02-28").params.lostAfterDays).toBe(10);
  });

  it("throws before 2024 and tryPolicyFor returns null instead", () => {
    expect(() => policyFor("RETURNS_STANDARD", "2023-12-31")).toThrow("No RETURNS_STANDARD policy in effect on 2023-12-31");
    expect(() => policyFor("BILLING_DISPUTES", "1999-01-01")).toThrow("No BILLING_DISPUTES policy in effect on 1999-01-01");
    expect(tryPolicyFor("GOODWILL_RETENTION", "2023-12-31")).toBeNull();
    expect(tryPolicyFor("GOODWILL_RETENTION", "2024-01-01")?.version).toBe("2024.1");
  });

  it("exactly one version applies to every day 2024-01-01..2027-12-31 for every family (no gaps/overlaps)", () => {
    const end = "2027-12-31";
    let days = 0;
    for (let d = "2024-01-01"; d <= end; d = addDays(d, 1)) {
      days++;
      const label = versionInEffect(d);
      for (const id of POLICY_IDS) {
        const matches = allPolicyVersions().filter(
          (p) => p.policyId === id && d >= p.effectiveFrom && (p.effectiveTo === null || d <= p.effectiveTo),
        );
        if (matches.length !== 1) throw new Error(`${id} on ${d}: ${matches.length} versions`);
        if (policyFor(id, d).version !== label) throw new Error(`${id} on ${d}: ${policyFor(id, d).version} vs ${label}`);
      }
    }
    expect(days).toBe(366 + 365 + 365 + 365);
  });

  it("versionInEffect follows the shared version table, null before 2024", () => {
    expect(versionInEffect("2023-12-31")).toBeNull();
    expect(versionInEffect("2024-01-01")).toBe("2024.1");
    expect(versionInEffect("2024-12-31")).toBe("2024.1");
    expect(versionInEffect("2025-01-01")).toBe("2025.1");
    expect(versionInEffect("2025-12-31")).toBe("2025.1");
    expect(versionInEffect("2026-01-01")).toBe("2026.1");
    expect(versionInEffect("2026-10-16")).toBe("2026.1");
  });

  it("each policy version's dates match the shared version table entry", () => {
    for (const p of allPolicyVersions()) {
      const v = RULES.versions.find((x) => x.version === p.version);
      expect(v, `${p.policyId} ${p.version}`).toBeTruthy();
      expect([p.effectiveFrom, p.effectiveTo]).toEqual([v!.effectiveFrom, v!.effectiveTo]);
    }
  });
});

// ---------------------------------------------------------------------------------------
describe("governingDateFor — order date vs claim date", () => {
  const dates = { orderDate: "2025-12-20", claimDate: "2026-01-10" };

  it("families are split 3/3 between order_date and claim_date", () => {
    expect(POLICY_IDS.filter((id) => familyInfo(id).governingDate === "order_date")).toEqual(ORDER_DATE_FAMILIES);
    expect(POLICY_IDS.filter((id) => familyInfo(id).governingDate === "claim_date")).toEqual(CLAIM_DATE_FAMILIES);
  });

  for (const id of ORDER_DATE_FAMILIES) {
    it(`${id} is governed by the order date`, () => {
      expect(governingDateFor(id, dates)).toBe("2025-12-20");
    });
  }

  for (const id of CLAIM_DATE_FAMILIES) {
    it(`${id} is governed by the claim date even when an order date is given`, () => {
      expect(governingDateFor(id, dates)).toBe("2026-01-10");
    });
  }

  it("order-date families fall back to the claim date when no order date is known", () => {
    for (const id of ORDER_DATE_FAMILIES) {
      expect(governingDateFor(id, { claimDate: "2026-02-02" })).toBe("2026-02-02");
      expect(governingDateFor(id, { orderDate: null, claimDate: "2026-02-02" })).toBe("2026-02-02");
      expect(governingDateFor(id, { orderDate: "", claimDate: "2026-02-02" })).toBe("2026-02-02");
    }
  });

  it("an order placed in 2025 and claimed in 2026 mixes versions by family", () => {
    const v = <P extends PolicyId>(id: P) => policyFor(id, governingDateFor(id, dates));
    expect(v("RETURNS_STANDARD").version).toBe("2025.1");
    expect(v("RETURNS_STANDARD").params.returnWindowDays).toBe(90);
    expect(v("SHIPPING_DELAYS").params.lateRemedy).toBe("shipping_refund");
    expect(v("DAMAGE_TRANSIT").params.evidenceRequiredAboveCents).toBe(10000);
    expect(v("BILLING_DISPUTES").version).toBe("2026.1");
    expect(v("BILLING_DISPUTES").params.duplicateReportWindowDays).toBe(120);
    expect(v("GOODWILL_RETENTION").params.goodwillTiers).toEqual(["gold", "platinum"]);
    expect(v("APPROVAL_AUTHORITY").version).toBe("2026.1");
  });

  it("every version's governingDate field agrees with its family", () => {
    for (const p of allPolicyVersions()) expect(p.governingDate).toBe(familyInfo(p.policyId).governingDate);
  });

  it("agrees with the RAG temporal filter's governingDateForClause for every family", () => {
    const cases = [
      dates,
      { claimDate: "2026-03-03" },
      { orderDate: null, claimDate: "2024-05-05" },
      { orderDate: "", claimDate: "2025-07-07" },
      { orderDate: "2026-04-04", claimDate: "2024-08-08" },
    ];
    for (const id of POLICY_IDS) {
      for (const d of cases) expect(governingDateForClause({ policyId: id }, d)).toBe(governingDateFor(id, d));
    }
  });
});

// ---------------------------------------------------------------------------------------
describe("formatParamForText", () => {
  it("days / hours / percent / count", () => {
    expect(formatParamForText("returnWindowDays", 30)).toEqual(["30 days"]);
    expect(formatParamForText("goodwillCooldownDays", 180)).toEqual(["180 days"]);
    expect(formatParamForText("duplicateCaptureWindowHours", 24)).toEqual(["24 hours"]);
    expect(formatParamForText("lateCreditPct", 10)).toEqual(["10%"]);
    expect(formatParamForText("maxRefundsPerResolution", 1)).toEqual(["1"]);
  });

  it("money is cents rendered as $D,DDD.CC", () => {
    expect(formatParamForText("outOfWindowStoreCreditMaxCents", 2500)).toEqual(["$25.00"]);
    expect(formatParamForText("lateCreditCents", 500)).toEqual(["$5.00"]);
    expect(formatParamForText("evidenceRequiredAboveCents", 15000)).toEqual(["$150.00"]);
    expect(formatParamForText("goodwillMaxCents", 1505)).toEqual(["$15.05"]);
    expect(formatParamForText("autoRefundLimitCents", 5)).toEqual(["$0.05"]);
    expect(formatParamForText("autoRefundLimitCents", 0)).toEqual(["$0.00"]);
    expect(formatParamForText("vipAutoLimitCents", 123456)).toEqual(["$1,234.56"]);
    expect(formatParamForText("vipAutoLimitCents", 10_000_000)).toEqual(["$100,000.00"]);
  });

  it("money boundaries: dollars are floored, cents always two digits, thousands separated", () => {
    // Math.round instead of Math.floor would turn 99 into "$1.99" and 99_999 into "$1,000.99".
    expect(formatParamForText("goodwillMaxCents", 99)).toEqual(["$0.99"]);
    expect(formatParamForText("goodwillMaxCents", 100)).toEqual(["$1.00"]);
    expect(formatParamForText("goodwillMaxCents", 110)).toEqual(["$1.10"]);
    expect(formatParamForText("goodwillMaxCents", 99_999)).toEqual(["$999.99"]);
    expect(formatParamForText("goodwillMaxCents", 100_000)).toEqual(["$1,000.00"]);
    expect(formatParamForText("goodwillMaxCents", 123_456_789)).toEqual(["$1,234,567.89"]);
  });

  it("categories and tiers map through display names, one string per item", () => {
    expect(formatParamForText("nonRefundableCategories", ["gift_card", "custom_cut_glass", "clearance"])).toEqual([
      "gift cards",
      "custom-cut glass",
      "clearance items",
    ]);
    expect(formatParamForText("goodwillTiers", ["standard", "gold", "platinum"])).toEqual(["Standard", "Gold", "Platinum"]);
    expect(formatParamForText("vipTiers", ["platinum"])).toEqual(["Platinum"]);
    expect(formatParamForText("vipTiers", ["diamond"])).toEqual(["diamond"]);
    expect(formatParamForText("goodwillTiers", [])).toEqual([]);
  });

  it("params with no text format (booleans, enums, unknown names) produce nothing", () => {
    expect(formatParamForText("carrierScanCountsAsEvidence", true)).toEqual([]);
    expect(formatParamForText("lateRemedy", "store_credit_pct")).toEqual([]);
    expect(formatParamForText("churnExceptionRequiresHuman", true)).toEqual([]);
    expect(formatParamForText("noSuchParam", 30)).toEqual([]);
  });

  it("displayName falls back to the raw key", () => {
    expect(displayName("gift_card")).toBe("gift cards");
    expect(displayName("platinum")).toBe("Platinum");
    expect(displayName("unknown_key")).toBe("unknown_key");
  });

  it("every formatted param in every real version yields at least one non-empty string", () => {
    for (const p of allPolicyVersions()) {
      for (const [k, v] of Object.entries(p.params)) {
        const out = formatParamForText(k, v);
        if (k in RULES.paramFormats) {
          expect(out.length, `${p.policyId} ${p.version} ${k}`).toBeGreaterThan(0);
          for (const s of out) expect(s.trim().length).toBeGreaterThan(0);
        } else {
          expect(out).toEqual([]);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------
describe("validatePolicies", () => {
  it("passes on the real clause files", () => {
    const files = readClauseFiles();
    expect(Object.keys(files).sort()).toEqual(["2024.1", "2025.1", "2026.1"]);
    const report = validatePolicies(files);
    expect(report.errors).toEqual([]);
    expect(report.clauses).toBe(126);
    expect([...report.versions].sort()).toEqual(["2024.1", "2025.1", "2026.1"]);
    for (const md of Object.values(files)) expect(parseClauseFile(md)).toHaveLength(42);
  });

  it("catches a mismatched number: v2026.1 §1.4 '30 days' -> '31 days'", () => {
    const files = filesWith("2026.1", (md) => mutateClause(md, "§1.4", "30 days", "31 days"));
    expect(validatePolicies(files).errors).toEqual([
      '§1.4@2026.1: expected "30 days" (returnWindowDays) in text',
      "§1.4@2026.1: number(s) not backed by rules.json: 31",
    ]);
  });

  it("the same '30 days' edit in v2025.1 §1.4 (where the rule is 90) only flags the stray number", () => {
    // 2025.1 §1.4 says "90 days"; adding "30 days" leaves 90 present but 30 unbacked.
    const files = filesWith("2025.1", (md) => mutateClause(md, "§1.4", "never the delivery date", "never 30 days after delivery"));
    expect(validatePolicies(files).errors).toEqual(["§1.4@2025.1: number(s) not backed by rules.json: 30"]);
  });

  it("catches a mismatched money amount: v2026.1 §1.6 '$25.00' -> '$35.00'", () => {
    const files = filesWith("2026.1", (md) => mutateClause(md, "§1.6", "$25.00", "$35.00"));
    expect(validatePolicies(files).errors).toEqual([
      '§1.6@2026.1: expected "$25.00" (outOfWindowStoreCreditMaxCents) in text',
      "§1.6@2026.1: number(s) not backed by rules.json: $35.00",
    ]);
  });

  it("catches a number that only contains the right one: '30 days' -> '130 days'", () => {
    const files = filesWith("2026.1", (md) => mutateClause(md, "§1.4", "30 days", "130 days"));
    expect(validatePolicies(files).errors).toEqual([
      '§1.4@2026.1: expected "30 days" (returnWindowDays) in text',
      "§1.4@2026.1: number(s) not backed by rules.json: 130",
    ]);
  });

  it("catches a missing bound value: v2026.1 §3.3 without the $20.00 cap", () => {
    const files = filesWith("2026.1", (md) => mutateClause(md, "§3.3", ", capped at $20.00 per order", ""));
    expect(validatePolicies(files).errors).toEqual(['§3.3@2026.1: expected "$20.00" (lateCreditMaxCents) in text']);
  });

  it("catches a missing bound value written in words: v2026.1 §2.2 '120 days' -> 'four months'", () => {
    const files = filesWith("2026.1", (md) => mutateClause(md, "§2.2", "within 120 days of", "within four months of"));
    expect(validatePolicies(files).errors).toEqual(['§2.2@2026.1: expected "120 days" (duplicateReportWindowDays) in text']);
  });

  it("catches a missing tier: v2026.1 §6.2 'Platinum' -> 'Gold'", () => {
    const files = filesWith("2026.1", (md) => mutateClause(md, "§6.2", "Platinum customers", "Gold customers"));
    expect(validatePolicies(files).errors).toEqual(['§6.2@2026.1: expected "Platinum" (vipTiers) in text']);
  });

  it("catches a missing category: v2024.1 §1.5 without 'clearance items'", () => {
    const files = filesWith("2024.1", (md) => mutateClause(md, "§1.5", ", and clearance items", ""));
    expect(validatePolicies(files).errors).toEqual(['§1.5@2024.1: expected "clearance items" (nonRefundableCategories) in text']);
  });

  it("catches a param no clause binds: v2026.1 §1.4 'binds: -'", () => {
    const files = filesWith("2026.1", (md) => mutateClause(md, "§1.4", "binds: returnWindowDays", "binds: -"));
    expect(validatePolicies(files).errors).toEqual([
      "§1.4@2026.1: number(s) not backed by rules.json: 30",
      'rules RETURNS_STANDARD 2026.1: param "returnWindowDays" is not stated in any clause',
    ]);
  });

  it("catches a clause binding a param the rule does not have", () => {
    const files = filesWith("2026.1", (md) => mutateClause(md, "§1.4", "binds: returnWindowDays", "binds: returnWindowDays, refundWindowDays"));
    expect(validatePolicies(files).errors).toEqual([
      '§1.4@2026.1: binds "refundWindowDays" but RETURNS_STANDARD 2026.1 has no such param',
    ]);
  });

  it("catches rules.json drifting from unchanged prose (custom rules argument)", () => {
    const rules = structuredClone(RULES);
    const ret = rules.policies.find((p) => p.policyId === "RETURNS_STANDARD" && p.version === "2026.1")!;
    (ret.params as { returnWindowDays: number }).returnWindowDays = 60;
    expect(validatePolicies(readClauseFiles(), rules).errors).toEqual([
      '§1.4@2026.1: expected "60 days" (returnWindowDays) in text',
      "§1.4@2026.1: number(s) not backed by rules.json: 30",
    ]);
    // The shared RULES object was not touched.
    expect(policyFor("RETURNS_STANDARD", "2026-01-01").params.returnWindowDays).toBe(30);
  });

  it("reports a missing clause file for a version", () => {
    const files = readClauseFiles();
    delete files["2025.1"];
    const report = validatePolicies(files);
    expect(report.errors).toEqual(["missing clause file for version 2025.1"]);
    expect(report.clauses).toBe(84);
  });

  it("reports an unparseable clause file", () => {
    const files = readClauseFiles();
    files["2026.1"] = "no front matter here";
    expect(validatePolicies(files).errors).toEqual([
      "2026.1: Clause file is missing front matter",
      "missing clause file for version 2026.1",
    ]);
  });

  it("reports front matter that names a different version", () => {
    const files = filesWith("2026.1", (md) => replaceOnce(md, "version: 2026.1", "version: 2026.2"));
    expect(validatePolicies(files).errors).toEqual(["2026.1: front matter says 2026.2"]);
  });

  it("reports clause effective dates that differ from rules.json", () => {
    const files = filesWith("2025.1", (md) => replaceOnce(md, "effectiveTo: 2025-12-31", "effectiveTo: 2025-12-30"));
    const errors = validatePolicies(files).errors;
    expect(errors).toHaveLength(42);
    expect(errors[0]).toBe("§1.1@2025.1: effective dates 2025-01-01..2025-12-30 differ from rules.json 2025-01-01..2025-12-31");
    expect(errors.every((e) => e.endsWith("differ from rules.json 2025-01-01..2025-12-31"))).toBe(true);
  });

  it("reports a clause effectiveFrom that differs from rules.json (start date checked, not only end)", () => {
    const files = filesWith("2024.1", (md) => replaceOnce(md, "effectiveFrom: 2024-01-01", "effectiveFrom: 2024-01-02"));
    const errors = validatePolicies(files).errors;
    expect(errors).toHaveLength(42);
    expect(errors[0]).toBe("§1.1@2024.1: effective dates 2024-01-02..2024-12-31 differ from rules.json 2024-01-01..2024-12-31");
    expect(errors.every((e) => e.startsWith("§") && e.includes("@2024.1: effective dates 2024-01-02..2024-12-31"))).toBe(true);
  });

  it("reports a closed end date on the open-ended version (null vs a date)", () => {
    const files = filesWith("2026.1", (md) => replaceOnce(md, "effectiveTo: null", "effectiveTo: 2026-12-31"));
    const errors = validatePolicies(files).errors;
    expect(errors).toHaveLength(42);
    expect(errors[0]).toBe("§1.1@2026.1: effective dates 2026-01-01..2026-12-31 differ from rules.json 2026-01-01..null");
    expect(errors.every((e) => e.endsWith("differ from rules.json 2026-01-01..null"))).toBe(true);
  });

  it("catches a mismatched percent in a two-param clause: v2026.1 §3.3 '10%' -> '15%'", () => {
    const files = filesWith("2026.1", (md) => mutateClause(md, "§3.3", "equal to 10% of", "equal to 15% of"));
    expect(validatePolicies(files).errors).toEqual([
      '§3.3@2026.1: expected "10%" (lateCreditPct) in text',
      "§3.3@2026.1: number(s) not backed by rules.json: 15%",
    ]);
  });

  it("catches a count written in words: v2026.1 §6.4 'at most 1 refund' -> 'at most one refund'", () => {
    const files = filesWith("2026.1", (md) => mutateClause(md, "§6.4", "at most 1 refund.", "at most one refund."));
    expect(validatePolicies(files).errors).toEqual(['§6.4@2026.1: expected "1" (maxRefundsPerResolution) in text']);
  });

  it("lists every stray number in one error, in text order, money and percent kept whole", () => {
    const files = filesWith("2026.1", (md) =>
      mutateClause(md, "§1.4", "counted from the order date.", "counted from the order date or 45 days for 2 items at $5.00 and 5%."),
    );
    expect(validatePolicies(files).errors).toEqual(["§1.4@2026.1: number(s) not backed by rules.json: 45, 2, $5.00, 5%"]);
  });

  it("accepts a bound value stated more than once in the same clause", () => {
    const files = filesWith("2026.1", (md) => mutateClause(md, "§1.4", "counted from the order date.", "counted from the order date. Again, 30 days."));
    expect(validatePolicies(files).errors).toEqual([]);
  });

  it("reports a bound param that has no text format: v2026.1 §4.5 'binds: shippingFeeRefund'", () => {
    const files = filesWith("2026.1", (md) => mutateClause(md, "§4.5", "binds: -", "binds: shippingFeeRefund"));
    expect(validatePolicies(files).errors).toEqual(['§4.5@2026.1: param "shippingFeeRefund" has no text format']);
  });

  it("a clause from another family cannot satisfy a rule's param binding", () => {
    const files = filesWith("2026.1", (md) =>
      mutateClause(
        mutateClause(md, "§1.4", "binds: returnWindowDays", "binds: -"),
        "§2.2",
        "binds: duplicateReportWindowDays",
        "binds: duplicateReportWindowDays, returnWindowDays",
      ),
    );
    expect(validatePolicies(files).errors).toEqual([
      "§1.4@2026.1: number(s) not backed by rules.json: 30",
      '§2.2@2026.1: binds "returnWindowDays" but BILLING_DISPUTES 2026.1 has no such param',
      'rules RETURNS_STANDARD 2026.1: param "returnWindowDays" is not stated in any clause',
    ]);
  });

  it("takes the version table and clause lists from the rules argument, not the bundled rules.json", () => {
    const withExtraVersion = structuredClone(RULES);
    withExtraVersion.versions.push({ version: "2027.1", effectiveFrom: "2027-01-01", effectiveTo: null });
    expect(validatePolicies(readClauseFiles(), withExtraVersion).errors).toEqual(["missing clause file for version 2027.1"]);

    const withExtraClause = structuredClone(RULES);
    withExtraClause.policies.find((p) => p.policyId === "RETURNS_STANDARD" && p.version === "2026.1")!.clauseIds.push("§1.9");
    expect(validatePolicies(readClauseFiles(), withExtraClause).errors).toEqual(["rules RETURNS_STANDARD 2026.1: clause §1.9 not found"]);

    // Neither clone leaked into the shared object.
    expect(RULES.versions.map((v) => v.version)).toEqual(["2024.1", "2025.1", "2026.1"]);
    expect(policyFor("RETURNS_STANDARD", "2026-01-01").clauseIds).not.toContain("§1.9");
  });

  it("reports a duplicate clause id and the rule clause it orphans", () => {
    const files = filesWith("2026.1", (md) => replaceOnce(md, "## §1.7 Refund method and timing", "## §1.3 Refund method and timing"));
    expect(validatePolicies(files).errors).toEqual(["§1.3@2026.1: duplicate clause id"]);
    const files2 = filesWith("2026.1", (md) => replaceOnce(md, "## §1.5 Non-refundable items", "## §1.4 Non-refundable items"));
    const errors2 = validatePolicies(files2).errors;
    expect(errors2).toContain("§1.4@2026.1: duplicate clause id");
    expect(errors2).toContain("rules RETURNS_STANDARD 2026.1: clause §1.5 not found");
  });

  it("reports a digit in a clause title", () => {
    const files = filesWith("2026.1", (md) => replaceOnce(md, "## §1.4 Return window", "## §1.4 Return window (30)"));
    expect(validatePolicies(files).errors).toEqual(["§1.4@2026.1: title contains a digit"]);
  });

  it("reports a clause listed by a rule but filed under another family", () => {
    const files = filesWith("2026.1", (md) =>
      mutateClause(mutateClause(md, "§6.4", "policy: APPROVAL_AUTHORITY", "policy: BILLING_DISPUTES"), "§6.4", "binds: maxRefundsPerResolution", "binds: -"),
    );
    expect(validatePolicies(files).errors).toEqual([
      "§6.4@2026.1: number(s) not backed by rules.json: 1",
      "rules APPROVAL_AUTHORITY 2026.1: clause §6.4 belongs to BILLING_DISPUTES",
      'rules APPROVAL_AUTHORITY 2026.1: param "maxRefundsPerResolution" is not stated in any clause',
    ]);
  });

  it("reports a clause whose family has no rule for that version", () => {
    const files = filesWith("2026.1", (md) => mutateClause(md, "§1.1", "policy: RETURNS_STANDARD", "policy: LOYALTY_POINTS"));
    expect(validatePolicies(files).errors).toEqual(["§1.1@2026.1: no LOYALTY_POINTS rule for version 2026.1"]);
  });

});

// ---------------------------------------------------------------------------------------
// Known validator gaps. Fixtures are built at collection time (outside the it.fails bodies)
// so a broken fixture crashes the file loudly instead of being swallowed as an "expected
// failure", and a normal precondition test proves each fixture says what the BUG note claims.
describe("validatePolicies — former gaps (regression)", () => {
  const elevenRefunds = filesWith("2026.1", (md) => mutateClause(md, "§6.4", "at most 1 refund.", "at most 11 refunds."));
  const vipLimitIn64 = (binds: string) =>
    filesWith("2026.1", (md) =>
      mutateClause(
        mutateClause(md, "§6.4", "binds: maxRefundsPerResolution", `binds: ${binds}`),
        "§6.4",
        "in the same resolution.",
        "in the same resolution. The VIP limit is $100.00.",
      ),
    );
  const countFirst = vipLimitIn64("maxRefundsPerResolution, vipAutoLimitCents");
  const moneyFirst = vipLimitIn64("vipAutoLimitCents, maxRefundsPerResolution");
  const diamondRules = structuredClone(RULES);
  diamondRules.displayNames.platinum = "Diamond";

  const clause64 = (files: Record<string, string>) => parseClauseFile(files["2026.1"]).find((c) => c.clauseId === "§6.4")!;

  it("precondition: the BUG fixtures contain exactly the intended edits", () => {
    const original = parseClauseFile(readClauseFiles()["2026.1"]);
    const eleven = parseClauseFile(elevenRefunds["2026.1"]);
    expect(eleven).toHaveLength(42);
    expect(clause64(elevenRefunds).text).toContain("A resolution carries at most 11 refunds.");
    // Only §6.4 changed.
    expect(eleven.filter((c, i) => c.text !== original[i].text).map((c) => c.clauseId)).toEqual(["§6.4"]);

    expect(clause64(countFirst).binds).toEqual(["maxRefundsPerResolution", "vipAutoLimitCents"]);
    expect(clause64(moneyFirst).binds).toEqual(["vipAutoLimitCents", "maxRefundsPerResolution"]);
    expect(clause64(countFirst).text).toBe(clause64(moneyFirst).text);
    expect(clause64(countFirst).text.endsWith("The VIP limit is $100.00.")).toBe(true);
    // With the money param processed first, the (consistent) prose validates cleanly.
    expect(validatePolicies(moneyFirst).errors).toEqual([]);

    expect(diamondRules.displayNames.platinum).toBe("Diamond");
    expect(RULES.displayNames.platinum).toBe("Platinum");
    expect(policyFor("APPROVAL_AUTHORITY", "2026-01-01").params.vipTiers).toEqual(["platinum"]);
  });

  // BUG (false negative): src/lib/policy/validate.ts validatePolicies() checks a bound value
  // with a bare substring test (`remaining.includes(str)`) and then erases every occurrence
  // (`remaining.split(str).join(" ")`). For "count" params the expected string is a bare
  // digit ("1" for maxRefundsPerResolution in 2026.1), so "at most 11 refunds" both passes the
  // includes() check and has both digits erased before the stray-number scan.
  // Expected: an error on §6.4@2026.1 (11 != 1). Actual: errors === [] — CI passes prose that
  // contradicts rules.json.
  it("catches a count that merely repeats the right digit: §6.4 'at most 1 refund' -> 'at most 11 refunds'", () => {
    const errors = validatePolicies(elevenRefunds).errors;
    expect(errors.some((e) => e.startsWith("§6.4@2026.1:"))).toBe(true);
  });

  // BUG (false positive, same root cause): the verdict depends on the order of the `binds:`
  // list. With "binds: maxRefundsPerResolution, vipAutoLimitCents" the count "1" is processed
  // first and erases the "1" inside "$100.00", leaving "$ 00.00", so the validator reports
  // '§6.4@2026.1: expected "$100.00" (vipAutoLimitCents) in text' and a stray "00.00." even
  // though the text is correct. The identical clause with the binds reversed validates clean
  // (asserted in the precondition test). Expected: [] for both orders. Actual: 2 errors.
  it("verdict does not depend on binds order (count bound before a money value containing its digit)", () => {
    expect(validatePolicies(countFirst).errors).toEqual([]);
  });

  // BUG (low severity, API inconsistency): validatePolicies(files, rules) uses the `rules`
  // argument for versions, policies and paramFormats, but formats expected strings with
  // formatParamForText(), which reads the module-level RULES (paramFormats + displayNames).
  // Repro: clone RULES, set displayNames.platinum = "Diamond", validate the real clause files.
  // Expected: '§6.2@2026.1: expected "Diamond" (vipTiers) in text'. Actual: errors === [].
  // Only reachable with a non-default rules argument (no production caller passes one).
  it("display names come from the rules argument, not the bundled rules.json", () => {
    expect(validatePolicies(readClauseFiles(), diamondRules).errors).toContain('§6.2@2026.1: expected "Diamond" (vipTiers) in text');
  });
});
