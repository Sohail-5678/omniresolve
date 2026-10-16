/**
 * Loads data/policies/rules.json (the source of truth for every number the gate checks)
 * and picks the version in effect on a governing date. Families decide whether the
 * governing date is the order date (customer-facing promises) or the claim date (process rules).
 */
import rulesJson from "@data/policies/rules.json";
import { inEffect } from "@/lib/util/dates";

export type PolicyId =
  | "RETURNS_STANDARD"
  | "BILLING_DISPUTES"
  | "SHIPPING_DELAYS"
  | "DAMAGE_TRANSIT"
  | "GOODWILL_RETENTION"
  | "APPROVAL_AUTHORITY";

export const POLICY_IDS: PolicyId[] = [
  "RETURNS_STANDARD",
  "BILLING_DISPUTES",
  "SHIPPING_DELAYS",
  "DAMAGE_TRANSIT",
  "GOODWILL_RETENTION",
  "APPROVAL_AUTHORITY",
];

export type GoverningDateKind = "order_date" | "claim_date";
export type Tier = "standard" | "gold" | "platinum";

export type ReturnsParams = {
  returnWindowDays: number;
  nonRefundableCategories: string[];
  outOfWindowStoreCreditMaxCents: number;
};
export type BillingParams = { duplicateReportWindowDays: number; duplicateCaptureWindowHours: number };
export type ShippingParams = {
  lateThresholdDays: number;
  lateRemedy: "store_credit_flat" | "shipping_refund" | "store_credit_pct";
  lateCreditCents?: number;
  lateCreditPct?: number;
  lateCreditMaxCents?: number;
  lostAfterDays: number;
};
export type DamageParams = {
  damageReportWindowDays: number;
  evidenceRequiredAboveCents: number;
  carrierScanCountsAsEvidence: boolean;
  returnLabelProvided: boolean;
  shippingFeeRefund: boolean;
};
export type GoodwillParams = {
  goodwillMaxCents: number;
  goodwillCooldownDays: number;
  goodwillTiers: Tier[];
  churnExceptionRequiresHuman: boolean;
};
export type ApprovalParams = {
  autoRefundLimitCents: number;
  vipAutoLimitCents: number;
  vipTiers: Tier[];
  maxRefundsPerResolution: number;
};

export type ParamsOf = {
  RETURNS_STANDARD: ReturnsParams;
  BILLING_DISPUTES: BillingParams;
  SHIPPING_DELAYS: ShippingParams;
  DAMAGE_TRANSIT: DamageParams;
  GOODWILL_RETENTION: GoodwillParams;
  APPROVAL_AUTHORITY: ApprovalParams;
};

export type PolicyVersion<P extends PolicyId = PolicyId> = {
  policyId: P;
  version: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  governingDate: GoverningDateKind;
  params: ParamsOf[P];
  clauseIds: string[];
};

type RulesFile = {
  schemaVersion: number;
  currency: string;
  families: Record<PolicyId, { title: string; section: number; governingDate: GoverningDateKind }>;
  paramFormats: Record<string, "days" | "hours" | "money" | "percent" | "count" | "categories" | "tiers">;
  displayNames: Record<string, string>;
  versions: { version: string; effectiveFrom: string; effectiveTo: string | null }[];
  policies: PolicyVersion[];
};

export const RULES = rulesJson as unknown as RulesFile;

export function familyInfo(policyId: PolicyId) {
  return RULES.families[policyId];
}

export function allPolicyVersions(): PolicyVersion[] {
  return RULES.policies;
}

/** The version of a policy family in effect on a date. Throws if none (dates before 2024). */
export function policyFor<P extends PolicyId>(policyId: P, governingDateIso: string): PolicyVersion<P> {
  const found = RULES.policies.find(
    (p) => p.policyId === policyId && inEffect(governingDateIso, p.effectiveFrom, p.effectiveTo),
  );
  if (!found) throw new Error(`No ${policyId} policy in effect on ${governingDateIso}`);
  return found as PolicyVersion<P>;
}

export function tryPolicyFor<P extends PolicyId>(policyId: P, governingDateIso: string): PolicyVersion<P> | null {
  try {
    return policyFor(policyId, governingDateIso);
  } catch {
    return null;
  }
}

/** Version label ("2026.1") in effect on a date, for any family (all families share version dates). */
export function versionInEffect(dateIso: string): string | null {
  return RULES.versions.find((v) => inEffect(dateIso, v.effectiveFrom, v.effectiveTo))?.version ?? null;
}

export function governingDateFor(
  policyId: PolicyId,
  dates: { orderDate?: string | null; claimDate: string },
): string {
  const kind = RULES.families[policyId].governingDate;
  if (kind === "order_date" && dates.orderDate) return dates.orderDate;
  return dates.claimDate;
}

export function displayName(key: string, rules: Pick<typeof RULES, "displayNames"> = RULES): string {
  return rules.displayNames[key] ?? key;
}

/** How a param value must appear in clause text, e.g. 30 -> ["30 days"], 2500 -> ["$25.00"]. */
export function formatParamForText(
  name: string,
  value: unknown,
  rules: Pick<typeof RULES, "paramFormats" | "displayNames"> = RULES,
): string[] {
  const format = rules.paramFormats[name];
  switch (format) {
    case "days":
      return [`${value} days`];
    case "hours":
      return [`${value} hours`];
    case "percent":
      return [`${value}%`];
    case "count":
      return [String(value)];
    case "money": {
      const cents = Number(value);
      return [`$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`];
    }
    case "categories":
    case "tiers":
      return (value as string[]).map((v) => displayName(v, rules));
    default:
      return [];
  }
}

export function isVip(tier: Tier, approval: ApprovalParams): boolean {
  return approval.vipTiers.includes(tier);
}
