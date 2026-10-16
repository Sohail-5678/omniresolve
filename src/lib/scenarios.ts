/** Showcase scenarios (data/scenarios/showcase.json), shared by the API and the UI. */
import showcaseJson from "@data/scenarios/showcase.json";
import type { FaultMode, ServiceName } from "@/lib/services/fault-injector";
import type { HitlDecision } from "@/lib/agent/state";

export type ScenarioFault = { service: ServiceName; operation: string; mode: FaultMode; n?: number };

export type SupervisorPreset = {
  label: string;
  decision: Pick<HitlDecision, "decision" | "note" | "amountCents"> & { removeActionsOfType?: string[] };
};

export type Scenario = {
  id: string;
  number: string;
  title: string;
  kicker: string;
  summary: string;
  customerId: string;
  message: string;
  faults: ScenarioFault[];
  evidenceAttached: boolean;
  watchFor: string[];
  supervisorPresets?: SupervisorPreset[];
  suggestedReplies: string[];
  forgedCall?: { orderId: string; amountCents: number };
};

export const SCENARIOS: Scenario[] = (showcaseJson as unknown as { scenarios: Scenario[] }).scenarios;

export function scenarioById(id: string | null | undefined): Scenario | undefined {
  return id ? SCENARIOS.find((s) => s.id === id) : undefined;
}
