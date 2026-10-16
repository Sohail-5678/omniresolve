/**
 * Hand-written fixtures for the showcase scenarios and the free-play persona.
 * These exact rows are what the demo scenarios are recorded against, so changing
 * them invalidates data/recordings (bump SEED_VERSION and re-record).
 */
import type { TrackingEvent } from "@/db/schema";
import { product } from "./catalog";

export type FixtureCustomer = {
  id: string;
  name: string;
  emailMasked: string;
  tier: "standard" | "gold" | "platinum";
  lifetimeValueCents: number;
  churnFlags: string[];
  since: string;
};

export type FixtureOrder = {
  id: string;
  customerId: string;
  orderDate: string;
  promisedDate: string;
  deliveredDate: string | null;
  status: "processing" | "shipped" | "delivered" | "lost";
  shippingCents: number;
  items: { sku: string; qty: number; unitPriceCents?: number }[];
  captures: { at: string; amountCents?: number }[];
  carrier: "carrier_a" | "carrier_b" | null;
  events: TrackingEvent[];
};

export type FixtureSet = {
  customers: FixtureCustomer[];
  orders: FixtureOrder[];
  refunds?: { orderId: string; amountCents: number; reason: string; createdAt: string }[];
  storeCredits?: { customerId: string; orderId?: string; amountCents: number; reason: string; createdAt: string }[];
  tickets?: { customerId: string; orderId?: string; subject: string; status: string; createdAt: string }[];
  inventory?: Record<string, number>;
};

const ev = (at: string, code: string, description: string): TrackingEvent => ({ at, code, description });

function deliveredTrail(orderDate: string, deliveredDate: string, extra: TrackingEvent[] = []): TrackingEvent[] {
  return [
    ev(`${orderDate}T18:20:00Z`, "label_created", "Shipping label created"),
    ev(`${orderDate}T23:05:00Z`, "picked_up", "Picked up by carrier"),
    ...extra,
    ev(`${deliveredDate}T13:40:00Z`, "delivered", "Delivered to front door"),
  ];
}

export const SHOWCASE_FIXTURES: FixtureSet = {
  customers: [
    { id: "CUS-1001", name: "Sarah Jenkins", emailMasked: "s•••@example.com", tier: "platinum", lifetimeValueCents: 1_842_000, churnFlags: [], since: "2021-04-12" },
    { id: "CUS-1002", name: "Daniel Okafor", emailMasked: "d•••@example.net", tier: "standard", lifetimeValueCents: 61_300, churnFlags: [], since: "2024-08-03" },
    { id: "CUS-1003", name: "Priya Raman", emailMasked: "p•••@example.org", tier: "standard", lifetimeValueCents: 48_800, churnFlags: [], since: "2025-02-19" },
    { id: "CUS-1004", name: "Tomás Vidal", emailMasked: "t•••@example.com", tier: "gold", lifetimeValueCents: 287_400, churnFlags: [], since: "2023-06-30" },
    { id: "CUS-1005", name: "Lena Fischer", emailMasked: "l•••@example.net", tier: "standard", lifetimeValueCents: 39_200, churnFlags: [], since: "2025-09-14" },
    { id: "CUS-1006", name: "Kevin Marsh", emailMasked: "k•••@example.org", tier: "standard", lifetimeValueCents: 25_800, churnFlags: [], since: "2026-03-02" },
    { id: "CUS-1007", name: "Alex Rivera", emailMasked: "a•••@example.com", tier: "gold", lifetimeValueCents: 412_700, churnFlags: ["mentioned_cancelling"], since: "2022-11-08" },
  ],
  orders: [
    // Showcase 1 — shattered glass kit, double-captured, Platinum customer.
    {
      id: "ORD-9941",
      customerId: "CUS-1001",
      orderDate: "2026-10-02",
      promisedDate: "2026-10-08",
      deliveredDate: "2026-10-09",
      status: "delivered",
      shippingCents: 0,
      items: [{ sku: "GLS-AUR-01", qty: 1 }],
      captures: [{ at: "2026-10-02T14:12:09Z" }, { at: "2026-10-02T14:13:41Z" }],
      carrier: "carrier_a",
      events: deliveredTrail("2026-10-02", "2026-10-09", [
        ev("2026-10-05T09:15:00Z", "in_transit", "In transit to regional hub"),
        ev("2026-10-08T06:52:00Z", "exception_damaged", "Package damaged in transit: contents reported broken at sort facility"),
        ev("2026-10-09T08:10:00Z", "out_for_delivery", "Out for delivery"),
      ]),
    },
    { id: "ORD-9712", customerId: "CUS-1001", orderDate: "2026-06-18", promisedDate: "2026-06-24", deliveredDate: "2026-06-23", status: "delivered", shippingCents: 0, items: [{ sku: "TXT-LIN-Q", qty: 1 }], captures: [{ at: "2026-06-18T11:02:00Z" }], carrier: "carrier_b", events: deliveredTrail("2026-06-18", "2026-06-23") },
    { id: "ORD-9530", customerId: "CUS-1001", orderDate: "2025-11-30", promisedDate: "2025-12-05", deliveredDate: "2025-12-04", status: "delivered", shippingCents: 0, items: [{ sku: "LGT-BRS-01", qty: 1 }], captures: [{ at: "2025-11-30T19:44:00Z" }], carrier: "carrier_a", events: deliveredTrail("2025-11-30", "2025-12-04") },

    // Showcase 2A — damaged pour-over set; Carrier A outage -> failover to Carrier B.
    {
      id: "ORD-8820",
      customerId: "CUS-1002",
      orderDate: "2026-10-05",
      promisedDate: "2026-10-10",
      deliveredDate: "2026-10-11",
      status: "delivered",
      shippingCents: 700,
      items: [{ sku: "KIT-POUR-02", qty: 1 }],
      captures: [{ at: "2026-10-05T16:30:00Z" }],
      carrier: "carrier_a",
      events: deliveredTrail("2026-10-05", "2026-10-11", [ev("2026-10-10T21:04:00Z", "exception_damaged", "Carton crushed during sort; contents broken")]),
    },
    // Showcase 2B — damaged mug set; Orders API fails at the replacement draft -> rollback.
    {
      id: "ORD-8821",
      customerId: "CUS-1003",
      orderDate: "2026-10-06",
      promisedDate: "2026-10-11",
      deliveredDate: "2026-10-12",
      status: "delivered",
      shippingCents: 700,
      items: [{ sku: "MUG-STN-04", qty: 1 }],
      captures: [{ at: "2026-10-06T10:05:00Z" }],
      carrier: "carrier_b",
      events: deliveredTrail("2026-10-06", "2026-10-12", [ev("2026-10-11T17:48:00Z", "exception_damaged", "Package damaged in transit: box punctured")]),
    },
    // Showcase 2C — damaged skillet; refund response lost after commit -> idempotent retry.
    {
      id: "ORD-8822",
      customerId: "CUS-1004",
      orderDate: "2026-10-07",
      promisedDate: "2026-10-11",
      deliveredDate: "2026-10-12",
      status: "delivered",
      shippingCents: 800,
      items: [{ sku: "SKL-CI-12", qty: 1 }],
      captures: [{ at: "2026-10-07T08:41:00Z" }],
      carrier: "carrier_a",
      events: deliveredTrail("2026-10-07", "2026-10-12", [ev("2026-10-11T12:30:00Z", "exception_damaged", "Item damaged in transit: handle cracked")]),
    },
    // Showcase 3 — undamaged blanket bought 68 days before the business date; customer quotes the old 90-day window.
    { id: "ORD-7350", customerId: "CUS-1005", orderDate: "2026-08-09", promisedDate: "2026-08-14", deliveredDate: "2026-08-13", status: "delivered", shippingCents: 0, items: [{ sku: "TXT-MER-01", qty: 1 }], captures: [{ at: "2026-08-09T20:12:00Z" }], carrier: "carrier_b", events: deliveredTrail("2026-08-09", "2026-08-13") },
    // Showcase 4 — the order the "VP override" message targets.
    { id: "ORD-7721", customerId: "CUS-1006", orderDate: "2026-09-21", promisedDate: "2026-09-26", deliveredDate: "2026-09-25", status: "delivered", shippingCents: 0, items: [{ sku: "ELC-NCH-01", qty: 1 }], captures: [{ at: "2026-09-21T13:27:00Z" }], carrier: "carrier_a", events: deliveredTrail("2026-09-21", "2026-09-25") },

    // Free-play persona (Alex Rivera): one order per interesting case.
    { id: "ORD-6610", customerId: "CUS-1007", orderDate: "2026-10-01", promisedDate: "2026-10-05", deliveredDate: "2026-10-04", status: "delivered", shippingCents: 0, items: [{ sku: "ELC-THM-01", qty: 1 }], captures: [{ at: "2026-10-01T09:30:00Z" }], carrier: "carrier_a", events: deliveredTrail("2026-10-01", "2026-10-04") },
    { id: "ORD-6611", customerId: "CUS-1007", orderDate: "2026-09-12", promisedDate: "2026-09-17", deliveredDate: "2026-09-24", status: "delivered", shippingCents: 900, items: [{ sku: "OUT-CHR-02", qty: 2 }], captures: [{ at: "2026-09-12T15:10:00Z" }], carrier: "carrier_b", events: deliveredTrail("2026-09-12", "2026-09-24", [ev("2026-09-16T10:00:00Z", "in_transit", "Delayed at hub: carrier capacity")]) },
    {
      id: "ORD-6612",
      customerId: "CUS-1007",
      orderDate: "2026-09-20",
      promisedDate: "2026-09-25",
      deliveredDate: null,
      status: "shipped",
      shippingCents: 600,
      items: [{ sku: "TXT-APR-01", qty: 1 }],
      captures: [{ at: "2026-09-20T18:00:00Z" }],
      carrier: "carrier_a",
      events: [
        ev("2026-09-20T22:00:00Z", "label_created", "Shipping label created"),
        ev("2026-09-21T15:00:00Z", "picked_up", "Picked up by carrier"),
        ev("2026-09-25T07:30:00Z", "in_transit", "Departed regional hub"),
      ],
    },
    { id: "ORD-6613", customerId: "CUS-1007", orderDate: "2026-07-02", promisedDate: "2026-07-02", deliveredDate: "2026-07-02", status: "delivered", shippingCents: 0, items: [{ sku: "GFT-050", qty: 1 }], captures: [{ at: "2026-07-02T12:00:00Z" }], carrier: null, events: [] },
    { id: "ORD-6614", customerId: "CUS-1007", orderDate: "2026-10-10", promisedDate: "2026-10-15", deliveredDate: "2026-10-14", status: "delivered", shippingCents: 0, items: [{ sku: "LGT-BRS-01", qty: 1 }], captures: [{ at: "2026-10-10T17:21:05Z" }, { at: "2026-10-10T17:23:40Z" }], carrier: "carrier_b", events: deliveredTrail("2026-10-10", "2026-10-14") },
  ],
  tickets: [{ customerId: "CUS-1001", orderId: "ORD-9712", subject: "Duvet cover color question", status: "CLOSED", createdAt: "2026-06-25T10:00:00Z" }],
};

export function fixtureOrderTotal(o: FixtureOrder): { subtotal: number; total: number } {
  const subtotal = o.items.reduce((s, i) => s + (i.unitPriceCents ?? product(i.sku).priceCents) * i.qty, 0);
  return { subtotal, total: subtotal + o.shippingCents };
}
