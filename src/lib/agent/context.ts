/**
 * N2 — context loader. Calls CRM, Orders, Billing and both carriers IN PARALLEL
 * (Promise.allSettled, per-call timeout, one retry for retryable errors) and derives the
 * facts the planner and gate need: paid vs refunded, duplicate captures, damage scans,
 * lateness, days since order/delivery. Each source is marked ok / retried / failed.
 */
import { AGENT } from "@/config/agent";
import type { ServiceCtx } from "@/lib/services/core";
import * as crm from "@/lib/services/crm";
import * as ordersApi from "@/lib/services/orders";
import * as billing from "@/lib/services/billing";
import * as carriers from "@/lib/services/carriers";
import * as wire from "@/lib/services/wire";
import { isRetryable } from "@/lib/saga/retry";
import { daysBetween } from "@/lib/util/dates";
import { ServiceError } from "@/lib/util/errors";
import { findDuplicateCapture } from "@/lib/policy/gate";
import { policyFor } from "@/lib/policy/rules";
import type { ContextOrder, CustomerContext, SourceStatus } from "./state";

const CALL_TIMEOUT_MS = 4_000;

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ServiceError(504, "TIMEOUT", `${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry<T>(fn: () => Promise<T>, what: string): Promise<{ value: T; status: SourceStatus }> {
  try {
    return { value: await withTimeout(fn(), CALL_TIMEOUT_MS, what), status: "ok" };
  } catch (err) {
    if (!isRetryable(err)) throw err;
    await new Promise((r) => setTimeout(r, AGENT.retry.baseMs));
    return { value: await withTimeout(fn(), CALL_TIMEOUT_MS, what), status: "retried" };
  }
}

export async function loadContext(svc: ServiceCtx, customerId: string, businessDate: string, mentioned: string[]): Promise<CustomerContext> {
  const [c, o, l, ta, tb] = await Promise.allSettled([
    fetchWithRetry(async () => wire.parseWire(wire.CustomerWire, await crm.getCustomer(svc, customerId), "crm.getCustomer"), "CRM"),
    fetchWithRetry(async () => wire.parseWire(wire.OrdersWire, await ordersApi.getOrders(svc, customerId), "orders.getOrders"), "Orders"),
    fetchWithRetry(async () => wire.parseWire(wire.LedgerWire, await billing.getLedger(svc, customerId), "billing.getLedger"), "Billing"),
    fetchWithRetry(async () => wire.parseWire(wire.TrackingWire, await carriers.getTracking(svc, "carrier_a", customerId), "carrier_a.getTracking"), "Carrier A"),
    fetchWithRetry(async () => wire.parseWire(wire.TrackingWire, await carriers.getTracking(svc, "carrier_b", customerId), "carrier_b.getTracking"), "Carrier B"),
  ]);

  const sourceErrors: Record<string, string> = {};
  const status = <T>(r: PromiseSettledResult<{ value: T; status: SourceStatus }>, key: string): SourceStatus => {
    if (r.status === "fulfilled") return r.value.status;
    sourceErrors[key] = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return "failed";
  };
  const crmStatus = status(c, "crm");
  const ordersStatus = status(o, "orders");
  const billingStatus = status(l, "billing");
  const aStatus = status(ta, "carrier_a");
  const bStatus = status(tb, "carrier_b");
  const carriersStatus: SourceStatus = aStatus === "failed" && bStatus === "failed" ? "failed" : aStatus === "ok" && bStatus === "ok" ? "ok" : aStatus === "failed" || bStatus === "failed" ? "failed" : "retried";

  const customer = c.status === "fulfilled" ? c.value.value : null;
  const ordersWire = o.status === "fulfilled" ? o.value.value : { orders: [], inventory: {} };
  const ledger = l.status === "fulfilled" ? l.value.value : { charges: [], refunds: [], storeCredits: [] };
  const shipments = [
    ...(ta.status === "fulfilled" ? ta.value.value.shipments : []),
    ...(tb.status === "fulfilled" ? tb.value.value.shipments : []),
  ];

  const orders: ContextOrder[] = ordersWire.orders.map((ow) => {
    const captures = ledger.charges.filter((x) => x.orderId === ow.orderId).map((x) => ({ id: x.chargeId, amountCents: x.amountCents, capturedAt: x.capturedAt }));
    const refunds = ledger.refunds.filter((x) => x.orderId === ow.orderId);
    const ship = shipments.find((s) => s.orderId === ow.orderId);
    const events = ship?.events ?? [];
    const lastEvent = events.length ? events[events.length - 1].at.slice(0, 10) : null;
    return {
      id: ow.orderId,
      customerId,
      orderDate: ow.orderDate,
      promisedDate: ow.promisedDate,
      deliveredDate: ow.deliveredDate,
      status: ow.status,
      subtotalCents: ow.subtotalCents,
      shippingCents: ow.shippingCents,
      totalCents: ow.totalCents,
      items: ow.items,
      captures,
      paidCents: captures.reduce((s, x) => s + x.amountCents, 0),
      refundedCents: refunds.reduce((s, x) => s + x.amountCents, 0),
      priorRefunds: refunds.map((r) => ({ amountCents: r.amountCents, reason: r.reason })),
      priorReplacements: ow.replacements,
      activeLabels: ow.activeLabels,
      damageScan: events.some((e) => e.code === "exception_damaged"),
      lastTrackingEventDate: lastEvent,
      daysSinceOrder: daysBetween(ow.orderDate, businessDate),
      daysSinceDelivery: ow.deliveredDate ? daysBetween(ow.deliveredDate, businessDate) : null,
      lateByDays: ow.deliveredDate ? daysBetween(ow.promisedDate, ow.deliveredDate) : null,
      carrier: ship?.carrier ?? null,
      trackingNo: ship?.trackingNo ?? null,
      trackingStatus: ship?.status ?? null,
      trackingEvents: events,
      daysSinceLastTrackingEvent: lastEvent ? daysBetween(lastEvent, businessDate) : null,
    };
  });

  const primaryOrderId =
    mentioned.find((id) => orders.some((x) => x.id === id)) ??
    (orders.filter((x) => x.daysSinceOrder <= 120).length === 1 ? orders.find((x) => x.daysSinceOrder <= 120)!.id : null);

  return {
    businessDate,
    customer: customer
      ? {
          id: customer.customerId,
          name: customer.name,
          tier: customer.tier,
          lifetimeValueCents: customer.lifetimeValueCents,
          churnFlags: customer.churnFlags,
          openTickets: customer.openTickets,
          since: customer.since,
        }
      : null,
    orders,
    storeCredits: ledger.storeCredits,
    inventory: ordersWire.inventory,
    sources: { crm: crmStatus, orders: ordersStatus, billing: billingStatus, carriers: carriersStatus },
    sourceErrors,
    primaryOrderId,
  };
}

/** Compact, prompt-safe view of the context for the planner (relevant orders in detail). */
export function contextForPlanner(ctx: CustomerContext, focusOrderIds: string[]) {
  const focus = new Set(focusOrderIds.length ? focusOrderIds : ctx.primaryOrderId ? [ctx.primaryOrderId] : []);
  const detailed = ctx.orders.filter((o) => focus.has(o.id));
  const others = ctx.orders.filter((o) => !focus.has(o.id)).slice(0, 6);
  return {
    businessDate: ctx.businessDate,
    customer: ctx.customer
      ? { name: ctx.customer.name, tier: ctx.customer.tier, lifetimeValueCents: ctx.customer.lifetimeValueCents, churnFlags: ctx.customer.churnFlags, openTickets: ctx.customer.openTickets }
      : { name: "unknown (CRM unavailable)", tier: "standard" },
    orders: detailed.map((o) => {
      const dup = findDuplicateCapture(o.captures, policyFor("BILLING_DISPUTES", ctx.businessDate).params.duplicateCaptureWindowHours);
      return {
        orderId: o.id,
        orderDate: o.orderDate,
        promisedDate: o.promisedDate,
        deliveredDate: o.deliveredDate,
        status: o.status,
        daysSinceOrder: o.daysSinceOrder,
        daysSinceDelivery: o.daysSinceDelivery,
        deliveredDaysLate: o.lateByDays !== null && o.lateByDays > 0 ? o.lateByDays : 0,
        items: o.items.map((i) => ({ sku: i.sku, name: i.name, category: i.category, qty: i.qty, unitPriceCents: i.unitPriceCents, inStock: (ctx.inventory[i.sku] ?? 0) >= i.qty })),
        shippingCents: o.shippingCents,
        totalCents: o.totalCents,
        ledger: {
          captures: o.captures.map((c) => ({ amountCents: c.amountCents, capturedAt: c.capturedAt })),
          paidCents: o.paidCents,
          refundedCents: o.refundedCents,
          duplicateCapture: dup ? { amountCents: dup.amountCents, count: dup.count } : null,
          priorRefunds: o.priorRefunds,
        },
        tracking: o.carrier
          ? {
              carrier: o.carrier === "carrier_a" ? "Carrier A" : "Carrier B",
              status: o.trackingStatus,
              damageScan: o.damageScan,
              daysSinceLastUpdate: o.daysSinceLastTrackingEvent,
              events: o.trackingEvents.map((e) => `${e.at.slice(0, 10)} ${e.code}: ${e.description}`),
            }
          : null,
        priorReplacements: o.priorReplacements,
      };
    }),
    otherOrders: others.map((o) => ({ orderId: o.id, orderDate: o.orderDate, status: o.status, items: o.items.map((i) => i.name) })),
    recentStoreCredits: ctx.storeCredits.slice(-3).map((c) => ({ amountCents: c.amountCents, reason: c.reason, date: c.createdAt.slice(0, 10) })),
    dataSources: ctx.sources,
  };
}
