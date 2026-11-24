/**
 * What the "My Orders" detail dialog shows about one order, and the
 * tracking timeline derived from it.
 *
 * There's no per-status history table yet — an `Order` carries only its
 * current `status` (plus `shipmentStatus` for the parcel's leg, which staff
 * move along from the admin Sales Orders page — packages/database/src/
 * shipment.ts), `createdAt`/`updatedAt`, the carrier + tracking number
 * staff enter, and its `Payment`. So the timeline is reconstructed: every
 * step up to the current status is done, the current one is dated by
 * `updatedAt` (the last time the order changed), and only "placed" and
 * "payment received" have exact dates of their own. If an order-event table
 * is added later, `buildTrackingTimeline` is the one place to swap over.
 *
 * Pure data with `type`-only imports, so the dialog (a Client Component)
 * can import it; the page builds `OrderDetail` on the server.
 */

import type { FulfillmentType, OrderStatus, PaymentMethod, PaymentStatus, ReturnStatus, ShipmentStatus } from "@repo/database";
import type { LineBlock, OrderFacts } from "@repo/database/returns";
import { formatINRWhole } from "./format";
import type { OrderBillingAddress, OrderShippingAddress } from "./india-address";

export interface OrderDetailItem {
  id: string;
  title: string;
  author: string;
  /** Detail-page path, or null when the product can't be linked to. */
  href: string | null;
  coverImageUrl: string | null;
  fulfillmentType: FulfillmentType;
  /** "Paperback" / "Hardcover" / "E-book", or "Paperback + E-book" for a bundle; null for non-books. */
  formatLabel: string | null;
  includesEbook: boolean;
  quantity: number;
  unitPriceCents: number;
  /** Cancelled by the customer. */
  cancelled: boolean;
  /** Units in a return that wasn't rejected. */
  returnedQuantity: number;
  /** Why "Cancel order" leaves this line alone, or null if it would go. */
  cancelBlock: LineBlock | null;
  /** Why it can't be returned right now, or null if it can. */
  returnBlock: LineBlock | null;
  /** How many copies could go back now. */
  returnableQuantity: number;
}

/** A cancellation the customer made from My Orders. */
export interface OrderCancellationDetail {
  id: string;
  createdAt: string;
  reasonLabel: string;
  note: string | null;
  refundCents: number;
  refundedAt: string | null;
  itemIds: string[];
}

/** A return the customer asked for, and where staff have got to with it. */
export interface OrderReturnDetail {
  id: string;
  status: ReturnStatus;
  createdAt: string;
  decidedAt: string | null;
  completedAt: string | null;
  reasonLabel: string;
  note: string | null;
  staffNote: string | null;
  refundCents: number;
  refundedAt: string | null;
  items: { orderItemId: string; quantity: number }[];
}

/** Serializable (ISO dates) — it crosses from the Server Component to the dialog. */
export interface OrderDetail {
  id: string;
  /** The short "#ab12c" reference shown everywhere a customer sees the order. */
  ref: string;
  status: OrderStatus;
  /** The printed part's progress; null when nothing ships, or before the order is placed. */
  shipmentStatus: ShipmentStatus | null;
  createdAt: string;
  updatedAt: string;
  subtotalCents: number;
  discountCents: number;
  discountCode: string | null;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  shippingAddress: OrderShippingAddress | null;
  /** Null on orders placed before checkout asked for one. */
  billingAddress: OrderBillingAddress | null;
  gstNumber: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  payment: {
    method: PaymentMethod | null;
    status: PaymentStatus;
    updatedAt: string;
  } | null;
  items: OrderDetailItem[];
  cancellations: OrderCancellationDetail[];
  /** Oldest first. */
  returns: OrderReturnDetail[];
  /** "Cancel order" shows. */
  canCancel: boolean;
  /** What cancelling now would refund, and whether it ends the whole order. */
  cancelRefundCents: number;
  cancelsWholeOrder: boolean;
  /** "Return order" shows. */
  canReturn: boolean;
  /** When returns close; null until the parcel is delivered. */
  returnWindowEndsAt: string | null;
  /** What the return form's live refund estimate is worked out from (`@repo/database/returns`). */
  facts: OrderFacts;
}

export const ORDER_STATUS: Record<OrderStatus, { label: string; tone: "ok" | "tile" | "brand" }> = {
  PENDING: { label: "Pending payment", tone: "tile" },
  PAID: { label: "Paid", tone: "brand" },
  PROCESSING: { label: "Processing", tone: "brand" },
  SHIPPED: { label: "Dispatched", tone: "ok" },
  DELIVERED: { label: "Delivered", tone: "ok" },
  READY_FOR_DOWNLOAD: { label: "Ready for download", tone: "ok" },
  CANCELLED: { label: "Cancelled", tone: "tile" },
  REFUNDED: { label: "Refunded", tone: "tile" },
};

type StatusBadge = { label: string; tone: "ok" | "tile" | "brand" };

/** Customer-facing names for the parcel's steps — "approval" is staff talk. */
const SHIPMENT_STATUS: Record<ShipmentStatus, StatusBadge> = {
  AWAITING_APPROVAL: { label: "Awaiting confirmation", tone: "tile" },
  PROCESSING: { label: "Processing", tone: "brand" },
  SHIPPED: { label: "Shipping", tone: "ok" },
  OUT_FOR_DELIVERY: { label: "Out for delivery", tone: "ok" },
  DELIVERED: { label: "Delivered", tone: "ok" },
  CANCELLED: { label: "Cancelled", tone: "tile" },
};

const RETURN_STATUS: Record<ReturnStatus, StatusBadge> = {
  REQUESTED: { label: "Return requested", tone: "tile" },
  APPROVED: { label: "Return approved", tone: "brand" },
  COMPLETED: { label: "Returned", tone: "tile" },
  REJECTED: { label: "Return not accepted", tone: "tile" },
};

/**
 * The one status an order's row and dialog show: the order's own when it's
 * been called off, then a return that's under way or done, otherwise the
 * parcel's when there is one (that's what a customer waiting on a delivery
 * wants to know), otherwise the order's.
 */
export function orderStatusBadge(
  order: Pick<OrderDetail, "status" | "shipmentStatus"> & Partial<Pick<OrderDetail, "returns" | "items">>
): StatusBadge {
  if (order.status === "CANCELLED" || order.status === "REFUNDED") return ORDER_STATUS[order.status];
  const latest = order.returns?.at(-1);
  if (latest && latest.status !== "REJECTED") {
    if (latest.status !== "COMPLETED") return RETURN_STATUS[latest.status];
    // Everything that was delivered went back, or only some of it.
    const kept = (order.items ?? []).some(
      (item) => item.fulfillmentType !== "SERVICE" && !item.cancelled && item.returnedQuantity < item.quantity
    );
    return kept ? { label: "Partly returned", tone: "ok" } : RETURN_STATUS.COMPLETED;
  }
  if (!order.shipmentStatus) return ORDER_STATUS[order.status];
  return SHIPMENT_STATUS[order.shipmentStatus];
}

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  CARD: "Card",
  UPI: "UPI",
  NETBANKING: "Net banking",
  WALLET: "Wallet",
  COD: "Cash on delivery",
  OTHER: "Other",
};

export type TrackingStepState = "done" | "current" | "upcoming" | "stopped";

export interface TrackingStep {
  key: string;
  label: string;
  description: string;
  state: TrackingStepState;
  /** ISO timestamp, when one is actually known for this step. */
  at: string | null;
}

/** Ships anything physical? Digital-only and service-only orders have no courier leg. */
export function shipsPhysically(order: Pick<OrderDetail, "items">): boolean {
  return order.items.some((item) => item.fulfillmentType === "SHIP");
}

/**
 * The steps an order goes through for its mix of lines, marked against its
 * current status. `standardEta` is the admin-managed delivery promise
 * ("in 3-5 working days"), shown on the delivery step while it's upcoming.
 */
export function buildTrackingTimeline(order: OrderDetail, standardEta: string): TrackingStep[] {
  const isCod = order.payment?.method === "COD";
  const paidAt = order.payment?.status === "CAPTURED" ? order.payment.updatedAt : null;
  const physical = shipsPhysically(order);
  const servicesOnly = order.items.length > 0 && order.items.every((item) => item.fulfillmentType === "SERVICE");

  const steps: Omit<TrackingStep, "state" | "at">[] = [
    { key: "placed", label: "Order placed", description: `We received order ${order.ref}.` },
    isCod
      ? {
          key: "confirmed",
          label: "Cash on delivery",
          description: "Pay the courier when your parcel arrives.",
        }
      : order.status === "PENDING"
        ? { key: "paid", label: "Awaiting payment", description: "Complete payment to confirm your order." }
        : { key: "paid", label: "Payment received", description: "Your payment was confirmed." },
  ];

  if (physical) {
    const awaiting = order.shipmentStatus === "AWAITING_APPROVAL";
    steps.push(
      {
        key: "accepted",
        label: awaiting ? "Awaiting confirmation" : "Order confirmed",
        description: awaiting ? "We're checking your order and will confirm it shortly." : "We've confirmed your order.",
      },
      { key: "processing", label: "Packing your order", description: "Your items are being picked and packed." },
      {
        key: "shipped",
        label: "Shipping",
        description: order.trackingNumber
          ? `Handed to ${order.carrier || "the courier"} — tracking number ${order.trackingNumber}.`
          : order.status === "DELIVERED" || order.shipmentStatus === "OUT_FOR_DELIVERY" || order.shipmentStatus === "DELIVERED"
            ? "Handed to the courier."
            : "Handed to the courier. Tracking details appear here once added.",
      },
      {
        key: "out_for_delivery",
        label: "Out for delivery",
        description: `Your parcel is on its way to you today.${isCod ? " Keep the cash ready for the courier." : ""}`,
      },
      {
        key: "delivered",
        label: "Delivered",
        description:
          order.status === "DELIVERED" || order.shipmentStatus === "DELIVERED"
            ? "Your parcel was delivered."
            : `Usually arrives ${standardEta} after dispatch.${isCod ? " Pay the courier in cash on delivery." : ""}`,
      }
    );
  } else if (servicesOnly) {
    steps.push(
      { key: "processing", label: "In progress", description: "Our team is working on your service package." },
      { key: "delivered", label: "Completed", description: "Your service package has been delivered." }
    );
  } else {
    steps.push({
      key: "ready",
      label: "Ready for download",
      description: "Your e-books are waiting in your digital library.",
    });
  }

  const keys = steps.map((step) => step.key);
  const reached =
    physical && order.shipmentStatus
      ? shipmentStepKey(order.shipmentStatus, keys)
      : reachedStepKey(order.status, keys, isCod);

  // Cancelled / refunded: we can't tell how far it got before stopping, so
  // only "placed" (and a payment we know was captured) stay ticked, then a
  // terminal step explains what happened. A refused parcel on an order that
  // also held an e-book is this too — only the printed part stopped.
  const parcelOnlyCancelled =
    order.status !== "CANCELLED" && order.status !== "REFUNDED" && order.shipmentStatus === "CANCELLED";
  if (order.status === "CANCELLED" || order.status === "REFUNDED" || parcelOnlyCancelled) {
    const kept: TrackingStep[] = [{ ...steps[0]!, state: "done", at: order.createdAt }];
    if (paidAt) kept.push({ ...steps[1]!, state: "done", at: paidAt });
    // The customer called it off themselves, rather than staff refusing it.
    const own = order.status === "REFUNDED" ? null : customerCancellation(order, parcelOnlyCancelled);
    kept.push({
      key: order.status === "REFUNDED" ? "refunded" : "cancelled",
      label:
        order.status === "REFUNDED"
          ? "Order refunded"
          : parcelOnlyCancelled && own
            ? "Printed items cancelled"
            : "Order cancelled",
      description:
        order.status === "REFUNDED"
          ? "Your payment has been refunded to the original payment method. Banks usually take 5–7 working days to show it."
          : own
            ? [
                parcelOnlyCancelled ? "You cancelled the printed items in this order." : "You cancelled this order.",
                cancellationRefundText(own.refundCents, own.refundedAt),
                parcelOnlyCancelled ? "Your e-books stay in your digital library." : "",
              ]
                .filter(Boolean)
                .join(" ")
            : parcelOnlyCancelled
              ? "We couldn't send the printed items in this order, so they were cancelled and are refunded to your original payment method. Your e-books stay in your digital library."
              : "This order was cancelled. If you paid online, the amount is refunded to your original payment method.",
      state: "stopped",
      at: own?.createdAt ?? order.updatedAt,
    });
    return kept;
  }

  const reachedIndex = steps.findIndex((step) => step.key === reached);
  // Reaching the last step means the order is complete, so it's ticked
  // rather than shown as still in progress.
  const complete = reachedIndex === steps.length - 1;
  const tracked = steps.map((step, index): TrackingStep => {
    const state: TrackingStepState =
      index < reachedIndex || (index === reachedIndex && complete)
        ? "done"
        : index === reachedIndex
          ? "current"
          : "upcoming";
    let at: string | null = null;
    if (step.key === "placed") at = order.createdAt;
    else if (step.key === "paid" && paidAt) at = paidAt;
    else if (step.key === "confirmed") at = order.createdAt;
    else if (index === reachedIndex) at = order.updatedAt;
    return { ...step, state, at };
  });
  return [...tracked, ...returnSteps(order)];
}

/**
 * The customer's own cancellation that stopped the order (with `parcel`,
 * the one that called off its printed part) — null when staff refused it.
 */
function customerCancellation(order: OrderDetail, parcel: boolean): OrderCancellationDetail | null {
  const printed = new Set(order.items.filter((item) => item.fulfillmentType === "SHIP").map((item) => item.id));
  const relevant = parcel
    ? order.cancellations.filter((cancellation) => cancellation.itemIds.some((id) => printed.has(id)))
    : order.cancellations;
  return relevant.at(-1) ?? null;
}

/** What a customer's cancellation refunds, in a sentence. */
export function cancellationRefundText(refundCents: number, refundedAt: string | null): string {
  if (refundCents <= 0) return "Nothing had been charged for it, so there's nothing to refund.";
  const amount = formatINRWhole(refundCents);
  return refundedAt
    ? `${amount} was refunded to your original payment method on ${formatOrderDate(refundedAt)}.`
    : `${amount} is being refunded to your original payment method — banks usually take 5–7 working days to show it.`;
}

/** What a completed return refunds, in a sentence. */
export function returnRefundText(orderReturn: OrderReturnDetail, cashOnDelivery: boolean): string {
  if (orderReturn.refundCents <= 0) return "We've received your return.";
  const amount = formatINRWhole(orderReturn.refundCents);
  if (orderReturn.refundedAt) return `We've received your return. ${amount} was refunded on ${formatOrderDate(orderReturn.refundedAt)}.`;
  return cashOnDelivery
    ? `We've received your return. ${amount} is being refunded by bank transfer or UPI — we'll contact you for the account to send it to.`
    : `We've received your return. ${amount} is being refunded to your original payment method — banks usually take 5–7 working days to show it.`;
}

/** Where the latest return has got to, appended after "Delivered". */
function returnSteps(order: OrderDetail): TrackingStep[] {
  const latest = order.returns.at(-1);
  if (!latest) return [];
  const count = latest.items.reduce((sum, item) => sum + item.quantity, 0);
  const steps: TrackingStep[] = [
    {
      key: "return_requested",
      label: "Return requested",
      description: `You asked to return ${count} item${count === 1 ? "" : "s"}: ${latest.reasonLabel.toLowerCase()}.`,
      state: latest.status === "REQUESTED" ? "current" : "done",
      at: latest.createdAt,
    },
  ];
  if (latest.status === "REJECTED") {
    steps.push({
      key: "return_rejected",
      label: "Return not accepted",
      description: latest.staffNote || "We couldn't accept this return, so the items stay yours.",
      state: "stopped",
      at: latest.decidedAt,
    });
    return steps;
  }
  steps.push(
    {
      key: "return_approved",
      label: "Return approved",
      description:
        latest.status === "REQUESTED"
          ? "We'll let you know how to send it back. Keep printed items in their unopened packaging."
          : latest.staffNote || "Send the items back in their unopened packaging, as we've emailed you.",
      state: latest.status === "APPROVED" ? "current" : latest.status === "COMPLETED" ? "done" : "upcoming",
      at: latest.decidedAt,
    },
    {
      key: "returned",
      label: "Returned",
      description:
        latest.status === "COMPLETED"
          ? returnRefundText(latest, order.payment?.method === "COD")
          : latest.refundCents > 0
            ? `Once it reaches us and we've checked it, we refund ${formatINRWhole(latest.refundCents)}.`
            : "Once it reaches us we'll confirm it by email.",
      state: latest.status === "COMPLETED" ? "done" : "upcoming",
      at: latest.completedAt,
    }
  );
  return steps;
}

/** Which step a parcel's shipment status has reached. CANCELLED is handled before this is asked. */
function shipmentStepKey(status: ShipmentStatus, keys: string[]): string {
  const key: Record<ShipmentStatus, string> = {
    AWAITING_APPROVAL: "accepted",
    PROCESSING: "processing",
    SHIPPED: "shipped",
    OUT_FOR_DELIVERY: "out_for_delivery",
    DELIVERED: "delivered",
    CANCELLED: "placed",
  };
  return keys.includes(key[status]) ? key[status] : keys[0]!;
}

/**
 * Which step key the order's current status has reached, among the keys
 * this order has. For a parcel this is only the fallback for an order with
 * no `shipmentStatus` yet (unpaid) or from before it existed —
 * `shipmentStepKey` covers the rest.
 */
function reachedStepKey(status: OrderStatus, keys: string[], isCod: boolean): string {
  const pick = (...candidates: string[]) => candidates.find((key) => keys.includes(key)) ?? keys[0]!;
  switch (status) {
    case "PENDING":
      // Placed, now waiting on the payment step. (A COD order is never
      // PENDING — it's created PROCESSING — but lands on its step the same.)
      return pick(isCod ? "confirmed" : "paid");
    // A paid e-book is already downloadable (lib/library.ts entitles from
    // PAID), so a digital-only order jumps straight to "ready".
    case "PAID":
      return pick("ready", isCod ? "confirmed" : "paid");
    case "PROCESSING":
      return pick("ready", "processing", isCod ? "confirmed" : "paid");
    case "SHIPPED":
      return pick("shipped", "processing");
    case "DELIVERED":
      return pick("delivered", "ready");
    case "READY_FOR_DOWNLOAD":
      return pick("ready", "delivered");
    default:
      return "placed";
  }
}

/**
 * The carrier's own tracking page for a consignment, for the couriers whose
 * tracking URL takes the number directly. Any other carrier gets the number
 * with a copy button instead of a link.
 */
const CARRIER_TRACKING: { match: RegExp; url: (trackingNumber: string) => string }[] = [
  { match: /delhivery/i, url: (n) => `https://www.delhivery.com/track/package/${n}` },
  { match: /shiprocket/i, url: (n) => `https://shiprocket.co/tracking/${n}` },
  { match: /blue\s*dart/i, url: (n) => `https://www.bluedart.com/web/guest/trackdartresult?trackFor=0&trackNo=${n}` },
];

export function carrierTrackingUrl(carrier: string | null, trackingNumber: string | null): string | null {
  if (!carrier || !trackingNumber) return null;
  const entry = CARRIER_TRACKING.find((candidate) => candidate.match.test(carrier));
  return entry ? entry.url(encodeURIComponent(trackingNumber.trim())) : null;
}

// Pinned to IST rather than the runtime's zone, so the server render and
// the browser format an order's dates identically (no hydration mismatch)
// and a customer abroad still sees the Press's local dispatch times.
const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});
const dateTimeFormat = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

/** "12 Oct 2026" */
export function formatOrderDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

/** "12 Oct 2026, 4:05 pm" */
export function formatOrderDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}
