import type { Metadata } from "next";
import { ConsoleApp } from "@/components/console/ConsoleApp";

export const metadata: Metadata = {
  title: "Console — OmniResolve",
  description: "Run support cases against mock business systems: watch the agent graph, approve as the supervisor, break services and watch the saga recover.",
};

export default async function ConsolePage({ searchParams }: PageProps<"/console">) {
  const params = await searchParams;
  const scenario = typeof params.scenario === "string" ? params.scenario : null;
  return <ConsoleApp initialScenarioId={scenario} />;
}
