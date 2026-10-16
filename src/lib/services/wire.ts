/**
 * Response contracts for the mock APIs, validated on the *caller* side like a real
 * API client would. A `schema_drift` fault returns a payload that fails these
 * schemas, which surfaces as UPSTREAM_SCHEMA_MISMATCH (never retried).
 */
import { z } from "zod";
import { ServiceError } from "@/lib/util/errors";

export const CustomerWire = z.object({
  customerId: z.string(),
  name: z.string(),
  emailMasked: z.string(),
  tier: z.enum(["standard", "gold", "platinum"]),
  lifetimeValueCents: z.number().int(),
  churnFlags: z.array(z.string()),
  since: z.string(),
  openTickets: z.number().int(),
});

export const OrderWire = z.object({
  orderId: z.string(),
  orderDate: z.string(),
  promisedDate: z.string(),
  deliveredDate: z.string().nullable(),
  status: z.string(),
  subtotalCents: z.number().int(),
  shippingCents: z.number().int(),
  totalCents: z.number().int(),
  items: z.array(
    z.object({ sku: z.string(), name: z.string(), category: z.string(), qty: z.number().int(), unitPriceCents: z.number().int() }),
  ),
  replacements: z.number().int(),
  activeLabels: z.number().int(),
});
export const OrdersWire = z.object({ orders: z.array(OrderWire), inventory: z.record(z.string(), z.number().int()) });

export const LedgerWire = z.object({
  charges: z.array(z.object({ chargeId: z.string(), orderId: z.string(), amountCents: z.number().int(), capturedAt: z.string() })),
  refunds: z.array(z.object({ refundId: z.string(), orderId: z.string(), amountCents: z.number().int(), reason: z.string(), createdAt: z.string() })),
  storeCredits: z.array(
    z.object({ creditId: z.string(), orderId: z.string().nullable(), amountCents: z.number().int(), reason: z.string(), createdAt: z.string() }),
  ),
});

export const TrackingWire = z.object({
  shipments: z.array(
    z.object({
      orderId: z.string(),
      carrier: z.string(),
      trackingNo: z.string(),
      status: z.string(),
      events: z.array(z.object({ at: z.string(), code: z.string(), description: z.string() })),
    }),
  ),
});

export const HoldWire = z.object({ holdId: z.string(), sku: z.string(), qty: z.number().int(), status: z.literal("held") });
export const DraftWire = z.object({ draftId: z.string(), orderId: z.string(), sku: z.string(), qty: z.number().int(), status: z.literal("draft") });
export const ConfirmWire = z.object({ draftId: z.string(), status: z.literal("confirmed") });
export const RefundWire = z.object({ refundId: z.string(), orderId: z.string(), amountCents: z.number().int(), status: z.literal("succeeded") });
export const CreditWire = z.object({ creditId: z.string(), amountCents: z.number().int(), status: z.literal("issued") });
export const LabelWire = z.object({ labelId: z.string(), carrier: z.string(), trackingNo: z.string(), status: z.literal("active") });
export const TicketWire = z.object({ ticketId: z.string(), status: z.string() });
export const NoteWire = z.object({ noteId: z.string(), ticketId: z.string() });
export const NotifyWire = z.object({ notificationId: z.string(), channel: z.string(), preview: z.string() });
export const CompensationWire = z.object({ affected: z.number().int() });

export function parseWire<T>(schema: z.ZodType<T>, payload: unknown, what: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ServiceError(
      502,
      "UPSTREAM_SCHEMA_MISMATCH",
      `${what}: response did not match the expected schema (${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"})`,
    );
  }
  return parsed.data;
}
