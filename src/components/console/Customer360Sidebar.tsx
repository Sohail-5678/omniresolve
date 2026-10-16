"use client";

/**
 * Customer 360: profile, orders, ledger (duplicate captures highlighted), tracking, labels,
 * replacements and tickets — read from the MOCK systems in this sandbox and refreshed after
 * every turn, so you can watch refunds, labels and tickets appear.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, PackageCheck, Truck } from "lucide-react";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { cents, shortDate } from "@/lib/client/format";
import { ModeBadge, Panel, StatusChip } from "./ui";

type Overview = {
  customer: { id: string; name: string; emailMasked: string; tier: string; lifetimeValueCents: number; churnFlags: string[]; since: string };
  orders: {
    id: string;
    orderDate: string;
    promisedDate: string;
    deliveredDate: string | null;
    status: string;
    totalCents: number;
    shippingCents: number;
    items: { sku: string; name: string; qty: number; unitPriceCents: number; category: string }[];
  }[];
  ledger: {
    charges: { id: string; orderId: string; amountCents: number; capturedAt: string }[];
    refunds: { id: string; orderId: string; amountCents: number; reason: string; createdAt: string }[];
    storeCredits: { id: string; orderId: string | null; amountCents: number; reason: string; createdAt: string }[];
  };
  shipments: { orderId: string; carrier: string; trackingNo: string; status: string; events: { at: string; code: string; description: string }[] }[];
  tickets: { id: string; subject: string; status: string; createdAt: string; orderId: string | null }[];
  labels: { id: string; orderId: string; carrier: string; trackingNo: string; status: string }[];
  replacements: { id: string; orderId: string; sku: string; status: string }[];
  outbox: { id: string; kind: string; createdAt: string }[];
  notifications: { id: string; preview: string; channel: string }[];
};

const TIER_STYLE: Record<string, string> = {
  platinum: "bg-ink text-paper",
  gold: "bg-[#e9d29a] text-ink",
  standard: "bg-paper-2 text-ink",
};

function isDuplicate(charges: Overview["ledger"]["charges"], orderId: string) {
  const own = charges.filter((c) => c.orderId === orderId);
  for (let i = 0; i < own.length; i++)
    for (let j = i + 1; j < own.length; j++)
      if (own[i].amountCents === own[j].amountCents && Math.abs(new Date(own[i].capturedAt).getTime() - new Date(own[j].capturedAt).getTime()) <= 24 * 3_600_000) return true;
  return false;
}

export function Customer360Sidebar({ customerId, refreshKey, focusOrderIds, className }: { customerId: string; refreshKey: number; focusOrderIds: string[]; className?: string }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<Overview>(`/api/services/overview?customerId=${encodeURIComponent(customerId)}`)
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [customerId, refreshKey]);

  return (
    <Panel className={className} kicker="Customer 360" title={data?.customer.name ?? "Loading…"} right={<ModeBadge badge="MOCK SERVICE" />} bodyClassName="overflow-y-auto scroll-thin">
      {error && <p className="p-4 text-[0.78rem] text-bad">{error}</p>}
      {data && (
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn("mono rounded-md px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider", TIER_STYLE[data.customer.tier] ?? TIER_STYLE.standard)}>{data.customer.tier}</span>
            <span className="mono text-[0.66rem] text-muted">{data.customer.id}</span>
            <span className="mono text-[0.66rem] text-muted">· {data.customer.emailMasked}</span>
          </div>
          <dl className="grid grid-cols-3 gap-2 text-[0.7rem]">
            <div className="rounded-lg bg-paper-2/70 p-2">
              <dt className="text-muted">Lifetime</dt>
              <dd className="mt-0.5 font-bold tabular">{cents(data.customer.lifetimeValueCents)}</dd>
            </div>
            <div className="rounded-lg bg-paper-2/70 p-2">
              <dt className="text-muted">Since</dt>
              <dd className="mt-0.5 font-bold">{data.customer.since.slice(0, 4)}</dd>
            </div>
            <div className="rounded-lg bg-paper-2/70 p-2">
              <dt className="text-muted">Open tickets</dt>
              <dd className="mt-0.5 font-bold">{data.tickets.filter((t) => ["OPEN", "ESCALATED", "REFUNDED_PENDING_FULFILLMENT"].includes(t.status)).length}</dd>
            </div>
          </dl>
          {data.customer.churnFlags.length > 0 && (
            <p className="flex items-center gap-1.5 text-[0.7rem] font-semibold text-warn">
              <AlertTriangle className="size-3" aria-hidden /> {data.customer.churnFlags.join(", ").replace(/_/g, " ")}
            </p>
          )}

          <div>
            <p className="eyebrow mb-2 text-muted">Orders</p>
            <ul className="space-y-2">
              {data.orders.map((o) => {
                const focus = focusOrderIds.includes(o.id);
                const charges = data.ledger.charges.filter((c) => c.orderId === o.id);
                const refunds = data.ledger.refunds.filter((r) => r.orderId === o.id);
                const credits = data.ledger.storeCredits.filter((c) => c.orderId === o.id);
                const ship = data.shipments.find((s) => s.orderId === o.id);
                const damaged = ship?.events.some((e) => e.code === "exception_damaged");
                const dup = isDuplicate(data.ledger.charges, o.id);
                const labels = data.labels.filter((l) => l.orderId === o.id);
                const repl = data.replacements.filter((r) => r.orderId === o.id);
                return (
                  <li key={o.id} className={cn("rounded-xl p-3 transition-shadow duration-300", focus ? "bg-card shadow-[inset_0_0_0_1.5px_var(--ink)]" : "bg-paper-2/50 shadow-[inset_0_0_0_1px_var(--line)]")}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="mono text-[0.72rem] font-bold">{o.id}</span>
                      <span className="mono text-[0.62rem] text-muted">{shortDate(o.orderDate)}</span>
                    </div>
                    <p className="mt-1 text-[0.74rem] leading-snug">{o.items.map((i) => `${i.qty > 1 ? `${i.qty}× ` : ""}${i.name}`).join(", ")}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span className="mono text-[0.64rem] font-semibold tabular">{cents(o.totalCents)}</span>
                      <span className="mono rounded bg-card px-1 text-[0.56rem] uppercase text-muted shadow-[inset_0_0_0_1px_var(--line)]">{o.status}</span>
                      {damaged && (
                        <span className="mono inline-flex items-center gap-0.5 rounded bg-bad-wash px-1 text-[0.56rem] font-semibold uppercase text-bad">
                          <Truck className="size-2.5" aria-hidden /> damage scan
                        </span>
                      )}
                      {o.deliveredDate && o.deliveredDate > o.promisedDate && <span className="mono rounded bg-warn-wash px-1 text-[0.56rem] font-semibold uppercase text-warn">late</span>}
                    </div>
                    {(focus || dup || refunds.length > 0 || labels.length > 0) && (
                      <div className="mt-2 space-y-0.5 border-t border-line pt-2">
                        {charges.map((c) => (
                          <p key={c.id} className={cn("mono flex justify-between text-[0.62rem]", dup ? "font-semibold text-bad" : "text-muted")}>
                            <span>capture {new Date(c.capturedAt).toISOString().slice(11, 16)}Z</span>
                            <span className="tabular">{cents(c.amountCents)}</span>
                          </p>
                        ))}
                        {dup && <p className="text-[0.62rem] font-semibold text-bad">Duplicate capture within 24 h</p>}
                        {refunds.map((r) => (
                          <p key={r.id} className="mono flex justify-between text-[0.62rem] font-semibold text-ok">
                            <span>
                              {r.id} refund · {r.reason.replace(/_/g, " ")}
                            </span>
                            <span className="tabular">{cents(-r.amountCents)}</span>
                          </p>
                        ))}
                        {credits.map((c) => (
                          <p key={c.id} className="mono flex justify-between text-[0.62rem] font-semibold text-info">
                            <span>{c.id} store credit</span>
                            <span className="tabular">{cents(c.amountCents)}</span>
                          </p>
                        ))}
                        {labels.map((l) => (
                          <p key={l.id} className={cn("mono text-[0.62rem]", l.status === "voided" ? "text-muted line-through" : "text-ink")}>
                            {l.id} label · {l.carrier === "carrier_b" ? "Carrier B" : "Carrier A"} · {l.trackingNo}
                          </p>
                        ))}
                        {repl.map((r) => (
                          <p key={r.id} className="mono flex items-center gap-1 text-[0.62rem] text-ink">
                            <PackageCheck className="size-2.5" aria-hidden /> {r.id} replacement · {r.status}
                          </p>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {data.ledger.storeCredits.filter((c) => !c.orderId).length > 0 && (
            <div>
              <p className="eyebrow mb-2 text-muted">Store credit</p>
              {data.ledger.storeCredits
                .filter((c) => !c.orderId)
                .map((c) => (
                  <p key={c.id} className="mono flex justify-between text-[0.64rem]">
                    <span>
                      {c.id} · {c.reason}
                    </span>
                    <span>{cents(c.amountCents)}</span>
                  </p>
                ))}
            </div>
          )}

          <div>
            <p className="eyebrow mb-2 text-muted">Tickets</p>
            {data.tickets.length === 0 ? (
              <p className="text-[0.72rem] text-muted">None.</p>
            ) : (
              <ul className="space-y-1.5">
                {data.tickets.slice(0, 6).map((t) => (
                  <li key={t.id} className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="mono text-[0.66rem] font-semibold">{t.id}</p>
                      <p className="truncate text-[0.68rem] text-muted">{t.subject}</p>
                    </div>
                    <StatusChip status={t.status} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {(data.outbox.length > 0 || data.notifications.length > 0) && (
            <div>
              <p className="eyebrow mb-2 text-muted">Ops outbox & notifications</p>
              <ul className="space-y-1.5">
                {data.outbox.slice(0, 4).map((o) => (
                  <li key={o.id} className="mono text-[0.62rem] text-warn">
                    {o.id} · {o.kind.replace(/_/g, " ")}
                  </li>
                ))}
                {data.notifications.slice(0, 2).map((n) => (
                  <li key={n.id} className="rounded-lg bg-paper-2/60 p-2 text-[0.66rem] leading-snug">
                    <span className="mono block text-[0.56rem] uppercase text-muted">{n.channel}</span>
                    {n.preview}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
