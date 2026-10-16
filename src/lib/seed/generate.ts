/**
 * Deterministic seed generator (fixed PRNG seed). Produces the template sandbox:
 * the hand-written showcase fixtures plus ~45 filler customers and ~260 filler orders
 * with matching charges, a few double captures, shipments with tracking (some damaged,
 * late or lost), prior refunds/credits and open tickets. All people and data are fake.
 */
import type { TrackingEvent } from "@/db/schema";
import { Rng } from "@/lib/util/prng";
import { addDays, daysBetween } from "@/lib/util/dates";
import { AGENT } from "@/config/agent";
import { CATALOG, product } from "./catalog";
import { SHOWCASE_FIXTURES, fixtureOrderTotal, type FixtureSet, type FixtureOrder } from "./fixtures";

/** Bump when seed output changes; the template sandbox is rebuilt and recordings must be re-made. */
export const SEED_VERSION = 5;
export const TEMPLATE_SANDBOX_ID = "__template__";
export const SEED = 9941;

export type SeedRows = {
  customers: {
    id: string;
    name: string;
    emailMasked: string;
    tier: string;
    lifetimeValueCents: number;
    churnFlags: string[];
    since: string;
  }[];
  orders: {
    id: string;
    customerId: string;
    orderDate: string;
    promisedDate: string;
    deliveredDate: string | null;
    status: string;
    subtotalCents: number;
    shippingCents: number;
    totalCents: number;
    currency: string;
  }[];
  orderItems: { orderId: string; line: number; sku: string; name: string; category: string; qty: number; unitPriceCents: number }[];
  inventory: { sku: string; name: string; onHand: number; reserved: number }[];
  charges: { id: string; orderId: string; amountCents: number; capturedAt: Date; status: string }[];
  refunds: { id: string; orderId: string; amountCents: number; reason: string; createdAt: Date }[];
  storeCredits: { id: string; customerId: string; orderId: string | null; amountCents: number; reason: string; createdAt: Date }[];
  shipments: { id: string; orderId: string; carrier: string; trackingNo: string; status: string; events: TrackingEvent[] }[];
  tickets: { id: string; customerId: string; orderId: string | null; subject: string; status: string; createdAt: Date; updatedAt: Date }[];
  idCounters: { prefix: string; value: number }[];
};

export const ID_PREFIXES = ["TCK", "RF", "SC", "LBL", "HLD", "RPL", "NTE", "OBX", "NTF"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

const FIRST = ["Maya", "Jonah", "Imani", "Felix", "Rosa", "Theo", "Hana", "Marcus", "Iris", "Omar", "Clara", "Dev", "Noor", "Elliot", "Sofia", "Ravi", "June", "Mateo", "Ada", "Kofi", "Lucia", "Sam", "Yara", "Bram", "Nadia", "Owen", "Esme", "Tariq", "Wren", "Lior", "Ines", "Caleb", "Mira", "Arjun", "Zoe", "Hugo", "Leila", "Finn", "Amara", "Ezra", "Nia", "Rhys", "Talia", "Jude", "Selin"];
const LAST = ["Abara", "Lindqvist", "Moreau", "Castellano", "Whitfield", "Nakamura", "Oduya", "Brennan", "Halvorsen", "Quintero", "Ashdown", "Petrov", "Delacroix", "Mwangi", "Sorensen", "Varga", "Okonjo", "Fairweather", "Ibarra", "Kowalczyk", "Thorne", "Esposito", "Hadley", "Rahimi", "Calloway", "Duarte", "Engstrom", "Mbeki", "Laurent", "Penhaligon", "Szabo", "Achebe", "Rourke", "Valdez", "Holloway", "Ferreira", "Yildiz", "Marchetti", "Osei", "Langford", "Novak", "Arden", "Bishara", "Kerrigan", "Tamura"];
const DOMAINS = ["example.com", "example.net", "example.org", "mail.test"];

function trackingNo(carrier: string, orderNum: number): string {
  const body = String(7_000_000_000 + ((orderNum * 1_013_904_223) % 999_999_999)).padStart(10, "0");
  return `${carrier === "carrier_a" ? "CA" : "CB"}${body}`;
}

function orderNum(id: string): number {
  return Number(id.replace(/\D/g, ""));
}

function trail(orderDate: string, opts: { deliveredDate: string | null; damaged: boolean; lostLastEvent?: string }): TrackingEvent[] {
  const events: TrackingEvent[] = [
    { at: `${orderDate}T19:00:00Z`, code: "label_created", description: "Shipping label created" },
    { at: `${addDays(orderDate, 1)}T14:00:00Z`, code: "picked_up", description: "Picked up by carrier" },
  ];
  if (opts.lostLastEvent) {
    events.push({ at: `${opts.lostLastEvent}T08:00:00Z`, code: "in_transit", description: "Departed regional hub" });
    return events;
  }
  if (!opts.deliveredDate) {
    events.push({ at: `${addDays(orderDate, 2)}T09:00:00Z`, code: "in_transit", description: "In transit" });
    return events;
  }
  if (opts.damaged) {
    events.push({ at: `${addDays(opts.deliveredDate, -1)}T22:10:00Z`, code: "exception_damaged", description: "Package damaged in transit" });
  }
  events.push({ at: `${opts.deliveredDate}T15:30:00Z`, code: "delivered", description: "Delivered" });
  return events;
}

/** Converts a fixture set (showcase or an eval scenario's overrides) into table rows. */
export function fixtureRows(fx: FixtureSet, idBase: string): Omit<SeedRows, "inventory" | "idCounters"> {
  const rows: Omit<SeedRows, "inventory" | "idCounters"> = {
    customers: fx.customers.map((c) => ({ ...c })),
    orders: [],
    orderItems: [],
    charges: [],
    refunds: [],
    storeCredits: [],
    shipments: [],
    tickets: [],
  };
  for (const o of fx.orders) appendOrder(rows, o);
  (fx.refunds ?? []).forEach((r, i) =>
    rows.refunds.push({ id: `RF-${idBase}${String(i + 1).padStart(2, "0")}`, orderId: r.orderId, amountCents: r.amountCents, reason: r.reason, createdAt: new Date(r.createdAt) }),
  );
  (fx.storeCredits ?? []).forEach((c, i) =>
    rows.storeCredits.push({ id: `SC-${idBase}${String(i + 1).padStart(2, "0")}`, customerId: c.customerId, orderId: c.orderId ?? null, amountCents: c.amountCents, reason: c.reason, createdAt: new Date(c.createdAt) }),
  );
  (fx.tickets ?? []).forEach((t, i) =>
    rows.tickets.push({ id: `TCK-${idBase}${String(i + 1).padStart(2, "0")}`, customerId: t.customerId, orderId: t.orderId ?? null, subject: t.subject, status: t.status, createdAt: new Date(t.createdAt), updatedAt: new Date(t.createdAt) }),
  );
  return rows;
}

function appendOrder(rows: Omit<SeedRows, "inventory" | "idCounters">, o: FixtureOrder) {
  const { subtotal, total } = fixtureOrderTotal(o);
  rows.orders.push({
    id: o.id,
    customerId: o.customerId,
    orderDate: o.orderDate,
    promisedDate: o.promisedDate,
    deliveredDate: o.deliveredDate,
    status: o.status,
    subtotalCents: subtotal,
    shippingCents: o.shippingCents,
    totalCents: total,
    currency: "USD",
  });
  o.items.forEach((it, idx) => {
    const p = product(it.sku);
    rows.orderItems.push({ orderId: o.id, line: idx + 1, sku: it.sku, name: p.name, category: p.category, qty: it.qty, unitPriceCents: it.unitPriceCents ?? p.priceCents });
  });
  o.captures.forEach((c, idx) => {
    rows.charges.push({ id: `CH-${orderNum(o.id)}-${idx + 1}`, orderId: o.id, amountCents: c.amountCents ?? total, capturedAt: new Date(c.at), status: "captured" });
  });
  if (o.carrier) {
    rows.shipments.push({ id: `SHP-${orderNum(o.id)}`, orderId: o.id, carrier: o.carrier, trackingNo: trackingNo(o.carrier, orderNum(o.id)), status: o.status, events: o.events });
  }
}

export function generateSeed(): SeedRows {
  const rng = new Rng(SEED);
  const businessDate = AGENT.businessDate;
  const base = fixtureRows(SHOWCASE_FIXTURES, "07");
  const rows: SeedRows = {
    ...base,
    inventory: CATALOG.map((p) => ({ sku: p.sku, name: p.name, onHand: p.stock, reserved: 0 })),
    idCounters: ID_PREFIXES.map((prefix) => ({ prefix, value: 1000 })),
  };

  const sellable = CATALOG.filter((p) => p.sku !== "GLS-AUR-01");
  let nextOrder = 2003;
  let refundSeq = 1;
  let creditSeq = 1;
  let ticketSeq = 1;
  const usedNames = new Set(rows.customers.map((c) => c.name));

  for (let n = 8; n <= 51; n++) {
    const id = `CUS-${1000 + n}`;
    let name = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
    while (usedNames.has(name)) name = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
    usedNames.add(name);
    const tierRoll = rng.float();
    const tier = tierRoll < 0.6 ? "standard" : tierRoll < 0.86 ? "gold" : "platinum";
    const churnFlags = rng.chance(0.1) ? [rng.pick(["mentioned_cancelling", "support_contacts_high"])] : [];
    const since = addDays("2021-01-01", rng.int(0, 1_700));
    let ltv = rng.int(0, 120_000);

    const orderCount = rng.int(3, 9);
    for (let k = 0; k < orderCount; k++) {
      const orderId = `ORD-${nextOrder}`;
      nextOrder += rng.int(1, 13);
      const ageRoll = rng.float();
      const age =
        ageRoll < 0.35 ? rng.int(2, 45) : ageRoll < 0.6 ? rng.int(46, 180) : ageRoll < 0.85 ? rng.int(181, 650) : rng.int(651, 980);
      const orderDate = addDays(businessDate, -age);
      if (orderDate < "2024-01-15") continue;
      const promisedDate = addDays(orderDate, rng.int(4, 7));
      const lineCount = rng.chance(0.25) ? 2 : 1;
      const items: { sku: string; qty: number }[] = [];
      for (let l = 0; l < lineCount; l++) {
        const p = rng.pick(sellable);
        if (!items.some((i) => i.sku === p.sku)) items.push({ sku: p.sku, qty: p.category === "outdoor" ? rng.int(1, 3) : 1 });
      }
      const shippingCents = rng.chance(0.5) ? 0 : rng.pick([500, 700, 900]);

      let status: FixtureOrder["status"] = "delivered";
      let deliveredDate: string | null = null;
      let damaged = false;
      let lostLastEvent: string | undefined;
      if (age <= 2) {
        status = "processing";
      } else if (age <= 5) {
        status = "shipped";
      } else {
        const r = rng.float();
        if (r < 0.04 && age > 25 && age < 200) {
          status = "shipped";
          lostLastEvent = addDays(orderDate, 3);
        } else {
          const offset = r < 0.84 ? -rng.int(0, 2) : rng.int(1, 6);
          deliveredDate = addDays(promisedDate, offset);
          if (daysBetween(deliveredDate, businessDate) < 0) deliveredDate = addDays(businessDate, -1);
          damaged = rng.chance(0.05);
        }
      }

      const fx: FixtureOrder = {
        id: orderId,
        customerId: id,
        orderDate,
        promisedDate,
        deliveredDate,
        status,
        shippingCents,
        items,
        captures: [{ at: `${orderDate}T${String(rng.int(8, 21)).padStart(2, "0")}:${String(rng.int(10, 59))}:00Z` }],
        carrier: status === "processing" ? null : rng.chance(0.55) ? "carrier_a" : "carrier_b",
        events: [],
      };
      if (fx.carrier) fx.events = trail(orderDate, { deliveredDate, damaged, lostLastEvent });
      // A handful of genuine double captures (1–9 minutes apart).
      if (status === "delivered" && rng.chance(0.012)) {
        const first = new Date(fx.captures[0].at);
        fx.captures.push({ at: new Date(first.getTime() + rng.int(1, 9) * 60_000).toISOString() });
      }
      appendOrder(rows, fx);
      const { total } = fixtureOrderTotal(fx);
      ltv += total;

      if (status === "delivered" && age > 40 && rng.chance(0.05)) {
        const p = product(items[0].sku);
        rows.refunds.push({ id: `RF-0${String(refundSeq++).padStart(3, "0")}`, orderId, amountCents: p.priceCents, reason: "return", createdAt: new Date(`${addDays(orderDate, 12)}T12:00:00Z`) });
      }
    }

    if (rng.chance(0.12)) {
      rows.storeCredits.push({ id: `SC-0${String(creditSeq++).padStart(3, "0")}`, customerId: id, orderId: null, amountCents: rng.pick([1000, 1500, 2000]), reason: "goodwill", createdAt: new Date(`${addDays(businessDate, -rng.int(10, 80))}T12:00:00Z`) });
    }
    if (rng.chance(0.18)) {
      const created = addDays(businessDate, -rng.int(1, 20));
      rows.tickets.push({ id: `TCK-0${String(800 + ticketSeq++)}`, customerId: id, orderId: null, subject: rng.pick(["Question about delivery date", "Change of address", "Invoice copy request", "Product care question"]), status: "OPEN", createdAt: new Date(`${created}T10:00:00Z`), updatedAt: new Date(`${created}T10:00:00Z`) });
    }

    rows.customers.push({ id, name, emailMasked: `${name[0].toLowerCase()}•••@${rng.pick(DOMAINS)}`, tier, lifetimeValueCents: ltv, churnFlags, since });
  }
  return rows;
}
