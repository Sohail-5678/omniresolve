/**
 * Renders the conversation for prompts. Customer turns are spotlighted inside one
 * per-request random delimiter; agent turns are labeled. The logical (replay-key) form
 * excludes the random delimiter so recordings stay matchable.
 */
import { spotlight, stripDelimiters } from "@/lib/security/firewall";
import type { TurnMessage } from "./state";

export function renderConversation(messages: TurnMessage[]): string {
  const tag = spotlight("").tag;
  const open = `<<CUSTOMER_MSG_${tag}>>`;
  const close = `<</CUSTOMER_MSG_${tag}>>`;
  return messages
    .slice(-12)
    .map((m) =>
      m.role === "customer"
        ? `${open}\n${stripDelimiters(m.text)}\n${close}`
        : `AGENT: ${m.text}`,
    )
    .join("\n\n");
}

export function logicalConversation(messages: TurnMessage[]) {
  return messages.slice(-12).map((m) => ({ role: m.role, text: m.text }));
}

export function lastCustomerText(messages: TurnMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "customer") return messages[i].text;
  return "";
}
