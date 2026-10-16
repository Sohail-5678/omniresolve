/**
 * idempotency_key = sha256(sandboxId | sagaId | stepName | canonical(args)).
 * The same step of the same saga always sends the same key, so a retry after a lost
 * response returns the stored result instead of acting twice.
 */
import { canonicalize, sha256Hex } from "@/lib/util/canonical";

export function idempotencyKey(sandboxId: string, sagaId: string, stepName: string, args: Record<string, unknown>): string {
  return sha256Hex(`${sandboxId}|${sagaId}|${stepName}|${canonicalize(args)}`);
}
