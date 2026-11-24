"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { OrderStatus, PaymentMethod, PaymentStatus, ReturnStatus, ShipmentStatus } from "@repo/database";
import { RETURN_STATUS_LABEL, isOpenReturn } from "@repo/database/returns";
import {
  DELIVERY_TYPE_LABEL,
  SHIPMENT_STATUS_LABEL,
  nextShipmentStatus,
  type DeliveryType,
} from "@repo/database/shipment";
import { Search } from "lucide-react";
import { cn } from "@repo/ui/utils";
import { EmptyState, ErrorBanner, Field, Pill, Table, buttonClass, controlClass } from "@/components/ui";
import { markCashCollected, moveSalesOrder } from "./actions";
import { decideReturn, markRefundSent } from "./return-actions";
import { SUGGESTED_CARRIERS } from "./cod";
import { FILTERS, type SalesOrderFilter } from "./filters";

const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });
// Pinned to IST so the server render and the browser agree on the date.
const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const dateTimeFormat = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

export interface SalesOrderAddress {
  name: string;
  email: string;
  line1: string;
  line2: string | null;
  district: string;
  city: string;
  state: string;
  postalCode: string;
}

/** A customer's own cancellation from My Orders — instant, nothing to decide. */
export interface SalesOrderCancellation {
  id: string;
  createdAt: string;
  reasonLabel: string;
  note: string | null;
  refundCents: number;
  refundedAt: string | null;
  refundDue: boolean;
  /** "Title (Paperback) × 2" */
  items: string[];
}

/** A customer's return request, and where staff have got to with it. */
export interface SalesOrderReturn {
  id: string;
  status: ReturnStatus;
  createdAt: string;
  decidedAt: string | null;
  completedAt: string | null;
  reasonLabel: string;
  note: string | null;
  staffNote: string | null;
  packagingUnopened: boolean;
  refundCents: number;
  refundedAt: string | null;
  refundDue: boolean;
  /** Printed copies are coming back (rather than only an e-book). */
  printed: boolean;
  items: string[];
}

/** Serializable (ISO dates) — built by page.tsx on the server. */
export interface SalesOrderRow {
  id: string;
  ref: string;
  createdAt: string;
  status: OrderStatus;
  shipmentStatus: ShipmentStatus | null;
  deliveryType: DeliveryType;
  itemCount: number;
  subtotalCents: number;
  discountCents: number;
  discountCode: string | null;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  customer: { name: string | null; email: string | null };
  shippingAddress: SalesOrderAddress | null;
  gstNumber: string | null;
  payment: { method: PaymentMethod | null; status: PaymentStatus } | null;
  carrier: string | null;
  trackingNumber: string | null;
  /** Cash on delivery whose parcel has gone out and whose cash isn't recorded yet. */
  canCollectCash: boolean;
  /** What the customer called off themselves: the whole order, its parcel, or only some lines. */
  customerCancelled: "ORDER" | "PARCEL" | "SOME" | null;
  /** Refunds worked out for cancellations and completed returns that haven't been sent yet. */
  refundDueCents: number;
  cancellations: SalesOrderCancellation[];
  returns: SalesOrderReturn[];
  items: {
    id: string;
    title: string;
    formatLabel: string | null;
    quantity: number;
    unitPriceCents: number;
    offline: boolean;
    cancelled: boolean;
    /** Copies in a return that wasn't rejected. */
    returnedQuantity: number;
    hasEbook: boolean;
    ebookDownloaded: boolean;
  }[];
}

type Bucket = Exclude<SalesOrderFilter, "all" | "returns" | "refunds">;
type Filter = SalesOrderFilter;

const openReturnOf = (order: SalesOrderRow) => order.returns.find((orderReturn) => isOpenReturn(orderReturn.status));

/** Whether an order belongs under a filter. Returns and refunds cut across the delivery buckets. */
function matches(order: SalesOrderRow, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "returns") return openReturnOf(order) !== undefined;
  if (filter === "refunds") return order.refundDueCents > 0;
  return bucket(order) === filter;
}

/** Which delivery bucket an order falls in — the same reading the Current Status column gives it. */
function bucket(order: SalesOrderRow): Bucket {
  if (order.status === "CANCELLED" || order.status === "REFUNDED" || order.shipmentStatus === "CANCELLED") return "cancelled";
  if (order.deliveryType === "ONLINE" || !order.shipmentStatus || order.shipmentStatus === "DELIVERED") return "complete";
  return order.shipmentStatus === "AWAITING_APPROVAL" ? "approval" : "in_progress";
}

/**
 * The Sales Orders table plus its detail pop-up. Clicking a row opens the
 * order; the order number is also a button, so the keyboard has a way in.
 * The Accept / Deny / next-step buttons in the Current Status column work
 * straight from the row without opening it.
 */
export function SalesOrdersList({ orders, initialFilter = "all" }: { orders: SalesOrderRow[]; initialFilter?: Filter }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const open = openId ? orders.find((order) => order.id === openId) : undefined;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, "");
    return orders.filter((order) => {
      if (!matches(order, filter)) return false;
      if (!q) return true;
      return (
        order.ref.slice(1).toLowerCase().includes(q) ||
        order.id.toLowerCase().includes(q) ||
        (order.customer.name ?? "").toLowerCase().includes(q) ||
        (order.customer.email ?? "").toLowerCase().includes(q)
      );
    });
  }, [orders, query, filter]);

  const waiting = orders.filter((order) => bucket(order) === "approval").length;
  const returnRequests = orders.filter((order) => matches(order, "returns")).length;
  const refundsToSend = orders.filter((order) => matches(order, "refunds")).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-bold text-ink">
          All Sales Orders
          {waiting > 0 && (
            <span className="ml-2 font-semibold text-ink-muted">
              · {waiting} waiting for approval
            </span>
          )}
          {returnRequests > 0 && (
            <span className="ml-2 font-semibold text-ink-muted">
              · {returnRequests} return {returnRequests === 1 ? "request" : "requests"}
            </span>
          )}
          {refundsToSend > 0 && (
            <span className="ml-2 font-semibold text-ink-muted">
              · {refundsToSend} {refundsToSend === 1 ? "refund" : "refunds"} to send
            </span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
            aria-label="Show orders"
            className={cn(controlClass, "w-52")}
          >
            {FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by order number or customer"
              aria-label="Search sales orders"
              className={cn(controlClass, "w-72 pl-9")}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          title={query || filter !== "all" ? "No orders match" : "No sales orders yet"}
          description={
            query || filter !== "all"
              ? "Try a different search, or show all orders."
              : "Orders appear here as soon as customers pay online or choose cash on delivery."
          }
        />
      ) : (
        <Table
          head={
            <>
              <th>Order number</th>
              <th>Total price</th>
              <th>Items</th>
              <th>Order placed</th>
              <th>Delivery type</th>
              <th>Current status</th>
            </>
          }
        >
          {filtered.map((order) => (
            <tr key={order.id} onClick={() => setOpenId(order.id)} className="cursor-pointer transition-colors hover:bg-tile">
              <td>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenId(order.id);
                  }}
                  className="font-semibold tabular-nums text-ink hover:text-brand hover:underline"
                >
                  {order.ref}
                  <span className="sr-only"> — view details</span>
                </button>
              </td>
              <td className="tabular-nums">{money.format(order.totalCents / 100)}</td>
              <td className="tabular-nums text-ink-muted">{order.itemCount}</td>
              <td className="text-ink-muted">{dateFormat.format(new Date(order.createdAt))}</td>
              <td className="text-ink-muted">{DELIVERY_TYPE_LABEL[order.deliveryType]}</td>
              <td onClick={(event) => event.stopPropagation()} className="cursor-default">
                <CurrentStatus order={order} onError={setError} onOpen={() => setOpenId(order.id)} />
              </td>
            </tr>
          ))}
        </Table>
      )}

      {open && (
        <SalesOrderDialog
          key={open.id}
          order={open}
          error={error}
          onError={setError}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

type StatusProps = {
  order: SalesOrderRow;
  onError: (message?: string) => void;
  onOpen?: () => void;
  inDialog?: boolean;
};

/**
 * What the Current Status column shows: where the order is (`OrderState`),
 * plus any return the customer has asked for and any refund still to send.
 * Returns are decided inside the order pop-up, so from the table a return
 * only links there.
 */
function CurrentStatus(props: StatusProps) {
  const { order, onOpen, inDialog = false } = props;
  const openReturn = openReturnOf(order);
  const returned = order.returns.some((orderReturn) => orderReturn.status === "COMPLETED");
  return (
    <div className="space-y-2">
      <OrderState {...props} inDialog={inDialog} />
      {openReturn ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone="info">{RETURN_STATUS_LABEL[openReturn.status]}</Pill>
          {!inDialog && onOpen && (
            <button type="button" onClick={onOpen} className="text-xs font-semibold text-brand hover:underline">
              Review…
            </button>
          )}
        </div>
      ) : (
        returned && <p className="text-xs text-ink-muted">Some items returned</p>
      )}
      {order.refundDueCents > 0 && (
        <p className="text-xs font-semibold text-ink">Refund to send: {money.format(order.refundDueCents / 100)}</p>
      )}
    </div>
  );
}

/**
 * Where the order is, and the buttons that move it on. Online-only orders
 * are complete the moment they're paid; an order with printed items waits
 * for Accept / Deny, then walks its steps. A mixed order reads "Partially
 * complete" until its parcel is delivered. An order (or parcel) the
 * customer cancelled from My Orders says so, so it's not mistaken for one
 * staff denied.
 *
 * Shipping needs the courier and tracking number, so from the table that
 * step opens the order (`onOpen`); inside it (`inDialog`) it's a small form.
 */
function OrderState({ order, onError, onOpen, inDialog = false }: StatusProps) {
  const mixed = order.deliveryType === "MIXED";
  const byCustomer = order.customerCancelled === "ORDER" || order.customerCancelled === "PARCEL";

  if (order.status === "REFUNDED") {
    return (
      <div>
        <Pill tone="off">Refunded</Pill>
        {byCustomer && <p className="mt-1 text-xs text-ink-muted">Cancelled by the customer</p>}
      </div>
    );
  }
  if (order.status === "CANCELLED" || order.shipmentStatus === "CANCELLED") {
    return (
      <div>
        <Pill tone="off">{byCustomer ? "Cancelled by customer" : "Cancelled"}</Pill>
        {order.status !== "CANCELLED" && (mixed || order.deliveryType === "ONLINE") && (
          <p className="mt-1 text-xs text-ink-muted">Online items still delivered</p>
        )}
      </div>
    );
  }
  if (order.deliveryType === "ONLINE" || !order.shipmentStatus) return <Pill tone="on">Complete</Pill>;
  if (order.shipmentStatus === "DELIVERED") return <Pill tone="on">{mixed ? "Complete" : "Delivered"}</Pill>;

  return (
    <div className="space-y-2">
      {mixed && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone="info">Partially complete</Pill>
          {order.shipmentStatus !== "AWAITING_APPROVAL" && (
            <span className="text-xs text-ink-muted">Printed items: {SHIPMENT_STATUS_LABEL[order.shipmentStatus]}</span>
          )}
        </div>
      )}
      {!mixed && order.shipmentStatus !== "AWAITING_APPROVAL" && (
        <Pill tone="info">{SHIPMENT_STATUS_LABEL[order.shipmentStatus]}</Pill>
      )}
      <StatusButtons order={order} status={order.shipmentStatus} onError={onError} onOpen={onOpen} inDialog={inDialog} />
    </div>
  );
}

const smallButton = "px-3 py-1.5 text-[13px]";

function StatusButtons({
  order,
  status,
  onError,
  onOpen,
  inDialog,
}: {
  order: SalesOrderRow;
  status: ShipmentStatus;
  onError: (message?: string) => void;
  onOpen?: () => void;
  inDialog: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function run(move: "accept" | "deny" | "advance", tracking?: { carrier: string; trackingNumber: string }) {
    onError(undefined);
    startTransition(async () => {
      const result = await moveSalesOrder({ orderId: order.id, from: status, move, ...tracking });
      if (!result.ok) onError(result.error);
    });
  }

  if (status === "AWAITING_APPROVAL") {
    const mixed = order.deliveryType === "MIXED";
    return (
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pending} onClick={() => run("accept")} className={buttonClass("primary", smallButton)}>
          {pending ? "Saving…" : "Accept"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            const message = mixed
              ? `Deny the printed items in order ${order.ref}? They'll be cancelled and their copies put back in stock. The customer keeps their e-book.`
              : `Deny order ${order.ref}? It will be cancelled, its copies put back in stock, and the customer will see it as cancelled.`;
            if (window.confirm(message)) run("deny");
          }}
          className={buttonClass("danger", smallButton)}
        >
          Deny
        </button>
      </div>
    );
  }

  const next = nextShipmentStatus(status);
  if (!next) return null;
  if (next === "SHIPPED") {
    if (!inDialog) {
      return (
        <button type="button" onClick={onOpen} className={buttonClass("secondary", smallButton)}>
          Mark as shipping…
        </button>
      );
    }
    return <ShippingForm order={order} pending={pending} onSubmit={(tracking) => run("advance", tracking)} />;
  }
  return (
    <button type="button" disabled={pending} onClick={() => run("advance")} className={buttonClass("secondary", smallButton)}>
      {pending ? "Saving…" : `Mark as ${SHIPMENT_STATUS_LABEL[next].toLowerCase()}`}
    </button>
  );
}

/** Processing → Shipping: who's carrying the parcel and its tracking number, both required. */
function ShippingForm({
  order,
  pending,
  onSubmit,
}: {
  order: SalesOrderRow;
  pending: boolean;
  onSubmit: (tracking: { carrier: string; trackingNumber: string }) => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onSubmit({ carrier: String(data.get("carrier") ?? ""), trackingNumber: String(data.get("trackingNumber") ?? "") });
      }}
      className="grid gap-4 rounded-tile border border-line-strong p-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Courier"
          htmlFor={`carrier-${order.id}`}
          required
          help="Who's delivering the parcel. Delhivery, Shiprocket and Blue Dart give the customer a tracking link."
        >
          <input
            id={`carrier-${order.id}`}
            name="carrier"
            list={`carrier-suggestions-${order.id}`}
            defaultValue={order.carrier ?? ""}
            required
            maxLength={60}
            autoComplete="off"
            className={controlClass}
          />
          <datalist id={`carrier-suggestions-${order.id}`}>
            {SUGGESTED_CARRIERS.map((carrier) => (
              <option key={carrier} value={carrier} />
            ))}
          </datalist>
        </Field>
        <Field
          label="Tracking number"
          htmlFor={`tracking-${order.id}`}
          required
          help="From the courier's receipt (sometimes called the AWB number)."
        >
          <input
            id={`tracking-${order.id}`}
            name="trackingNumber"
            defaultValue={order.trackingNumber ?? ""}
            required
            maxLength={60}
            pattern="[A-Za-z0-9\-]+"
            title="Letters, numbers and dashes only — no spaces"
            autoComplete="off"
            className={controlClass}
          />
        </Field>
      </div>
      <div>
        <button type="submit" disabled={pending} className={buttonClass("primary", smallButton)}>
          {pending ? "Saving…" : "Mark as shipping"}
        </button>
        <p className="mt-2 text-[13px] text-ink-muted">The customer gets an email saying their parcel is on its way.</p>
      </div>
    </form>
  );
}

/** Cash on delivery, once the parcel has gone out: record that the courier collected the money. */
function CashCollected({ order, onError }: { order: SalesOrderRow; onError: (message?: string) => void }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-btn border border-line-strong bg-tile px-4 py-3">
      <p className="text-sm text-ink">
        The customer pays {money.format(order.totalCents / 100)} in cash. Once the courier has collected it, record it here.
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          onError(undefined);
          startTransition(async () => {
            const result = await markCashCollected({ orderId: order.id });
            if (!result.ok) onError(result.error);
          });
        }}
        className={buttonClass("secondary", smallButton)}
      >
        {pending ? "Saving…" : "Mark cash collected"}
      </button>
    </div>
  );
}

const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  CARD: "Card",
  UPI: "UPI",
  NETBANKING: "Net banking",
  WALLET: "Wallet",
  COD: "Cash on delivery",
  OTHER: "Other",
};

function paymentLabel(order: SalesOrderRow): string {
  const payment = order.payment;
  if (!payment) return "No payment recorded";
  const method = payment.method ? PAYMENT_METHOD_LABEL[payment.method] : "Online";
  if (payment.status === "CAPTURED") return `${method} — paid`;
  if (payment.status === "REFUNDED") return `${method} — refunded`;
  if (payment.method === "COD") return order.status === "CANCELLED" ? `${method} — not collected` : `${method} — to be collected`;
  return `${method} — not paid`;
}

function SalesOrderDialog({
  order,
  error,
  onError,
  onClose,
}: {
  order: SalesOrderRow;
  error?: string;
  onError: (message?: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const offline = order.deliveryType !== "ONLINE";
  // Denying an order that was paid online doesn't refund it — there's no
  // refund integration yet, so say what's left to do by hand. (A customer's
  // own cancellation works its refund out, below.)
  const refundDue =
    order.customerCancelled !== "ORDER" &&
    order.customerCancelled !== "PARCEL" &&
    (order.shipmentStatus === "CANCELLED" || order.status === "CANCELLED") &&
    order.payment?.status === "CAPTURED";
  const address = order.shippingAddress;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => event.target === event.currentTarget && dialogRef.current?.close()}
      aria-labelledby="sales-order-title"
      className="fixed inset-0 m-auto h-fit max-h-[calc(100vh-2rem)] w-[min(44rem,calc(100vw-2rem))] overflow-y-auto rounded-tile border border-line-strong bg-ground p-0 text-ink backdrop:bg-ink/40"
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-ground px-6 py-5">
        <div>
          <h2 id="sales-order-title" className="font-display text-lg font-bold tracking-[-0.01em] text-ink">
            Order {order.ref}
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Placed {dateTimeFormat.format(new Date(order.createdAt))} · {DELIVERY_TYPE_LABEL[order.deliveryType]} ·{" "}
            <span className="tabular-nums">{money.format(order.totalCents / 100)}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Close order details"
          className="-mr-2 -mt-1 grid size-10 shrink-0 place-items-center rounded-full text-xl text-ink-muted hover:bg-tile hover:text-ink"
        >
          <span aria-hidden>×</span>
        </button>
      </div>

      <div className="grid gap-6 px-6 py-6">
        <section>
          <h3 className="text-xs font-bold uppercase tracking-wide text-ink-muted">Current status</h3>
          <div className="mt-2">
            <CurrentStatus order={order} onError={onError} inDialog />
          </div>
          {error && (
            <div className="mt-3">
              <ErrorBanner message={error} />
            </div>
          )}
          {order.trackingNumber && (
            <p className="mt-3 text-sm text-ink-muted">
              Sent with {order.carrier || "the courier"} · tracking number{" "}
              <span className="font-semibold tabular-nums text-ink">{order.trackingNumber}</span>
            </p>
          )}
          {order.canCollectCash && <CashCollected order={order} onError={onError} />}
          {refundDue && (
            <p className="mt-3 rounded-btn border border-line-strong bg-tile px-4 py-3 text-sm text-ink">
              This order was paid online. Refund the customer from your Razorpay dashboard — denying an order doesn&apos;t
              send the money back by itself.
            </p>
          )}
        </section>

        <OrderChanges order={order} onError={onError} />

        <div className="grid gap-6 sm:grid-cols-2">
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-ink-muted">Customer</h3>
            <p className="mt-2 text-sm font-semibold text-ink">{order.customer.name || "Name not given"}</p>
            {order.customer.email ? (
              <a href={`mailto:${order.customer.email}`} className="text-sm text-brand hover:underline">
                {order.customer.email}
              </a>
            ) : (
              <p className="text-sm text-ink-muted">No email on file</p>
            )}
            <p className="mt-3 text-sm text-ink-muted">{paymentLabel(order)}</p>
            {order.gstNumber && <p className="mt-1 text-sm text-ink-muted">GSTIN {order.gstNumber}</p>}
          </section>

          {offline && (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-ink-muted">Delivery address</h3>
              {address ? (
                <address className="mt-2 text-sm not-italic leading-relaxed text-ink">
                  {address.name && <span className="block font-semibold">{address.name}</span>}
                  <span className="block">{address.line1}</span>
                  {address.line2 && <span className="block">{address.line2}</span>}
                  <span className="block">
                    {[address.city, address.district].filter(Boolean).join(", ")}
                  </span>
                  <span className="block">
                    {address.state} {address.postalCode}
                  </span>
                </address>
              ) : (
                <p className="mt-2 text-sm text-ink-muted">No delivery address was saved with this order.</p>
              )}
            </section>
          )}
        </div>

        <section>
          <h3 className="text-xs font-bold uppercase tracking-wide text-ink-muted">Items</h3>
          <ul className="mt-2 divide-y divide-line rounded-tile border border-line-strong">
            {order.items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{item.title}</p>
                  <p className="mt-0.5 text-[13px] text-ink-muted">
                    {[item.formatLabel, item.offline ? "Offline — ships by courier" : "Online — delivered digitally"]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {(item.cancelled || item.returnedQuantity > 0 || item.hasEbook) && (
                    <p className="mt-0.5 text-[13px] font-semibold text-ink">
                      {[
                        item.cancelled ? "Cancelled by the customer" : null,
                        item.returnedQuantity > 0
                          ? item.returnedQuantity >= item.quantity
                            ? "In a return"
                            : `${item.returnedQuantity} of ${item.quantity} in a return`
                          : null,
                        item.hasEbook ? (item.ebookDownloaded ? "E-book downloaded" : "E-book not downloaded yet") : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right tabular-nums">
                  <p className="text-ink">{money.format((item.unitPriceCents * item.quantity) / 100)}</p>
                  <p className="text-[13px] text-ink-muted">
                    {item.quantity} × {money.format(item.unitPriceCents / 100)}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          <dl className="mt-4 space-y-1.5 text-sm [&>div]:flex [&>div]:justify-between [&_dd]:tabular-nums [&_dt]:text-ink-muted">
            <div>
              <dt>Items</dt>
              <dd>{money.format(order.subtotalCents / 100)}</dd>
            </div>
            {order.discountCents > 0 && (
              <div>
                <dt>Discount{order.discountCode ? ` (${order.discountCode})` : ""}</dt>
                <dd>−{money.format(order.discountCents / 100)}</dd>
              </div>
            )}
            <div>
              <dt>Delivery</dt>
              <dd>{order.shippingCents ? money.format(order.shippingCents / 100) : "Free"}</dd>
            </div>
            {order.taxCents > 0 && (
              <div>
                <dt>Includes GST</dt>
                <dd>{money.format(order.taxCents / 100)}</dd>
              </div>
            )}
            <div className="border-t border-line pt-2 font-bold">
              <dt className="!text-ink">Total</dt>
              <dd>{money.format(order.totalCents / 100)}</dd>
            </div>
          </dl>
        </section>
      </div>
    </dialog>
  );
}

/**
 * The customer's cancellations and returns on this order, newest last,
 * with what's left for staff to do: decide a return, mark it received,
 * send a refund.
 */
function OrderChanges({ order, onError }: { order: SalesOrderRow; onError: (message?: string) => void }) {
  if (!order.cancellations.length && !order.returns.length) return null;
  const cashOnDelivery = order.payment?.method === "COD";
  return (
    <section>
      <h3 className="text-xs font-bold uppercase tracking-wide text-ink-muted">Cancellations and returns</h3>
      <ul className="mt-2 space-y-3">
        {order.cancellations.map((cancellation) => (
          <li key={cancellation.id} className="rounded-tile border border-line-strong p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Pill tone="off">Cancelled by customer</Pill>
              <span className="text-[13px] text-ink-muted">{dateTimeFormat.format(new Date(cancellation.createdAt))}</span>
            </div>
            <p className="mt-2 text-ink">{cancellation.items.join(", ")}</p>
            <p className="mt-1 text-ink-muted">Reason: {cancellation.reasonLabel}</p>
            {cancellation.note && <p className="mt-1 text-ink-muted">Customer&apos;s note: {cancellation.note}</p>}
            <p className="mt-1 text-[13px] text-ink-muted">
              Copies went back in stock automatically. Nothing for you to approve.
            </p>
            <RefundLine
              kind="cancellation"
              id={cancellation.id}
              refundCents={cancellation.refundCents}
              refundedAt={cancellation.refundedAt}
              due={cancellation.refundDue}
              cashOnDelivery={cashOnDelivery}
              onError={onError}
            />
          </li>
        ))}
        {order.returns.map((orderReturn) => (
          <ReturnCard key={orderReturn.id} orderReturn={orderReturn} cashOnDelivery={cashOnDelivery} onError={onError} />
        ))}
      </ul>
    </section>
  );
}

function ReturnCard({
  orderReturn,
  cashOnDelivery,
  onError,
}: {
  orderReturn: SalesOrderReturn;
  cashOnDelivery: boolean;
  onError: (message?: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const noteId = `return-note-${orderReturn.id}`;

  function decide(decision: "approve" | "receive" | "reject") {
    if (decision === "reject" && message.trim().length < 3) {
      onError("Tell the customer why the return can't be accepted — write it in the message box first.");
      return;
    }
    if (decision === "receive" && !window.confirm("Has the parcel come back with its packaging unopened? Its copies go back in stock and the refund becomes due.")) {
      return;
    }
    if (decision === "reject" && !window.confirm("Reject this return? The customer is emailed your message and keeps the items.")) {
      return;
    }
    onError(undefined);
    startTransition(async () => {
      const result = await decideReturn({
        returnId: orderReturn.id,
        from: orderReturn.status as "REQUESTED" | "APPROVED",
        decision,
        staffNote: message.trim() || undefined,
      });
      if (!result.ok) onError(result.error);
      else setMessage("");
    });
  }

  const open = isOpenReturn(orderReturn.status);
  return (
    <li className="rounded-tile border border-line-strong p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Pill tone={orderReturn.status === "COMPLETED" ? "on" : orderReturn.status === "REJECTED" ? "off" : "info"}>
          {RETURN_STATUS_LABEL[orderReturn.status]}
        </Pill>
        <span className="text-[13px] text-ink-muted">Asked {dateTimeFormat.format(new Date(orderReturn.createdAt))}</span>
      </div>
      <p className="mt-2 text-ink">{orderReturn.items.join(", ")}</p>
      <p className="mt-1 text-ink-muted">Reason: {orderReturn.reasonLabel}</p>
      {orderReturn.note && <p className="mt-1 text-ink-muted">Customer&apos;s note: {orderReturn.note}</p>}
      {orderReturn.printed && orderReturn.packagingUnopened && (
        <p className="mt-1 text-ink-muted">The customer says the packaging is unopened — check it when the parcel arrives.</p>
      )}
      {orderReturn.staffNote && <p className="mt-1 text-ink-muted">Your message to the customer: {orderReturn.staffNote}</p>}

      {open && (
        <div className="mt-3 grid gap-3 rounded-btn bg-tile p-3">
          <p className="text-[13px] text-ink">
            {orderReturn.status === "REQUESTED"
              ? orderReturn.printed
                ? "Approve it and the customer is emailed to send the items back. Say how in the message — for example the courier pickup date, or the address to post it to."
                : "Only an e-book that was never downloaded is coming back, so there's nothing to post. Approving completes the return; the e-book stays locked."
              : "Waiting for the parcel to come back. When it arrives, check the packaging is unopened, then mark it received. If it was opened, reject the return and say why."}
          </p>
          <Field label="Message to the customer" htmlFor={noteId} help="Optional when approving. Needed to reject — it's emailed to them.">
            <textarea
              id={noteId}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={500}
              rows={2}
              className={controlClass}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            {orderReturn.status === "REQUESTED" ? (
              <button type="button" disabled={pending} onClick={() => decide("approve")} className={buttonClass("primary", smallButton)}>
                {pending ? "Saving…" : "Approve return"}
              </button>
            ) : (
              <button type="button" disabled={pending} onClick={() => decide("receive")} className={buttonClass("primary", smallButton)}>
                {pending ? "Saving…" : "Mark as received"}
              </button>
            )}
            <button type="button" disabled={pending} onClick={() => decide("reject")} className={buttonClass("danger", smallButton)}>
              Reject return
            </button>
          </div>
        </div>
      )}

      {orderReturn.status === "COMPLETED" && (
        <RefundLine
          kind="return"
          id={orderReturn.id}
          refundCents={orderReturn.refundCents}
          refundedAt={orderReturn.refundedAt}
          due={orderReturn.refundDue}
          cashOnDelivery={cashOnDelivery}
          onError={onError}
        />
      )}
      {open && orderReturn.refundCents > 0 && (
        <p className="mt-2 text-[13px] text-ink-muted">
          Refund once it&apos;s received: {money.format(orderReturn.refundCents / 100)}
        </p>
      )}
    </li>
  );
}

/** What a cancellation or completed return owes the customer, and the button that records it as sent. */
function RefundLine({
  kind,
  id,
  refundCents,
  refundedAt,
  due,
  cashOnDelivery,
  onError,
}: {
  kind: "cancellation" | "return";
  id: string;
  refundCents: number;
  refundedAt: string | null;
  due: boolean;
  cashOnDelivery: boolean;
  onError: (message?: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const amount = money.format(refundCents / 100);

  if (refundCents <= 0) {
    return (
      <p className="mt-2 text-[13px] text-ink-muted">
        Nothing to refund — {cashOnDelivery ? "the cash hadn't been collected yet." : "nothing had been paid for it."}
      </p>
    );
  }
  if (refundedAt) {
    return (
      <p className="mt-2 text-[13px] text-ink-muted">
        Refund of {amount} marked as sent on {dateFormat.format(new Date(refundedAt))}.
      </p>
    );
  }
  if (!due) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-btn border border-line-strong bg-tile px-4 py-3">
      <p className="min-w-0 flex-1 text-sm text-ink">
        <span className="font-semibold">Refund due: {amount}.</span>{" "}
        {cashOnDelivery
          ? "The customer paid in cash — send it by bank transfer or UPI (email them for the account), then record it here."
          : "Refund it from your Razorpay dashboard, then record it here."}
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Have you sent the ${amount} refund? This only records it — it doesn't move any money.`)) return;
          onError(undefined);
          startTransition(async () => {
            const result = await markRefundSent({ kind, id });
            if (!result.ok) onError(result.error);
          });
        }}
        className={buttonClass("secondary", smallButton)}
      >
        {pending ? "Saving…" : "Mark refund sent"}
      </button>
    </div>
  );
}
