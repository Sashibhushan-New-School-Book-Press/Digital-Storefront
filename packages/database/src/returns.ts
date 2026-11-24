/**
 * Cancelling and returning orders: what a customer may still call off or
 * send back, and how much comes back to them — the storefront's Refund &
 * Cancellation Policy (apps/web/app/(storefront)/refund-policy) in code.
 *
 * Cancel — instant, from My Orders, until the parcel ships:
 *  - a printed line while its parcel is AWAITING_APPROVAL or PROCESSING;
 *  - an e-book line until its PDF has been downloaded (in an order with a
 *    parcel, only until that parcel ships — after that it's a return).
 *  Everything still cancellable goes at once; the customer doesn't pick.
 *
 * Return — requested from My Orders once the parcel is DELIVERED and while
 * the return window is open, decided by staff on the admin Sales Orders page
 * (REQUESTED → APPROVED → COMPLETED, or → REJECTED):
 *  - printed copies, any number of them, in unopened packaging — the
 *    customer confirms it, staff check it when the parcel comes back;
 *  - an e-book line that was never downloaded.
 *  One return open at a time.
 *
 * Never, either way: publishing-service lines (agreed with the customer
 * directly), and a line carrying an e-book once that e-book has been
 * downloaded. The printed half of a print + e-book line can't go back
 * without its e-book, so such a line only ever goes back whole.
 *
 * Refunds: the lines' price less their share of the order's discount. A
 * cancellation that calls the parcel off also refunds the delivery charge,
 * and so does the first return the Press caused (damaged, wrong item).
 * Never more than what's left of the order total. A cancelled cash-on-
 * delivery order had not been paid, so nothing is owed. There's no refund
 * integration: staff send the money from the Razorpay dashboard (by bank
 * transfer or UPI for cash on delivery) and tick it off.
 *
 * Pure data with `type`-only imports, so Client Components in either app can
 * use it — import it from `@repo/database/returns` there.
 */

import type { FulfillmentType, OrderStatus, PaymentStatus, ReturnStatus, ShipmentStatus } from "@prisma/client";

const DAY_MS = 86_400_000;

// ── Reasons ─────────────────────────────────────────────────────────

/** Why a customer cancelled, as they pick it. Stored as the key. */
export const CANCEL_REASONS = {
  ORDERED_BY_MISTAKE: "I ordered it by mistake",
  CHANGED_MIND: "I changed my mind",
  FOUND_CHEAPER: "I found it cheaper elsewhere",
  TOO_SLOW: "It's taking too long to arrive",
  OTHER: "Another reason",
} as const;
export type CancelReason = keyof typeof CANCEL_REASONS;
export const CANCEL_REASON_KEYS = Object.keys(CANCEL_REASONS) as [CancelReason, ...CancelReason[]];

/** Why a customer is sending something back. Stored as the key. */
export const RETURN_REASONS = {
  DAMAGED: "It arrived damaged",
  WRONG_ITEM: "I was sent the wrong item",
  ORDERED_BY_MISTAKE: "I ordered it by mistake",
  NOT_NEEDED: "I no longer need it",
  OTHER: "Another reason",
} as const;
export type ReturnReason = keyof typeof RETURN_REASONS;
export const RETURN_REASON_KEYS = Object.keys(RETURN_REASONS) as [ReturnReason, ...ReturnReason[]];

/** The Press's fault — the delivery charge is refunded too. */
const PRESS_FAULT_REASONS: ReadonlySet<string> = new Set<ReturnReason>(["DAMAGED", "WRONG_ITEM"]);

/** The label for a stored reason. A key that's since been removed reads as "Another reason". */
export function cancelReasonLabel(reason: string): string {
  return (CANCEL_REASONS as Record<string, string>)[reason] ?? CANCEL_REASONS.OTHER;
}

export function returnReasonLabel(reason: string): string {
  return (RETURN_REASONS as Record<string, string>)[reason] ?? RETURN_REASONS.OTHER;
}

// ── Return steps ────────────────────────────────────────────────────

/** Staff-facing names, as the Sales Orders page shows them. */
export const RETURN_STATUS_LABEL: Record<ReturnStatus, string> = {
  REQUESTED: "Return requested",
  APPROVED: "Return approved",
  COMPLETED: "Returned",
  REJECTED: "Return rejected",
};

/** Still waiting on staff (or on the parcel coming back). */
export function isOpenReturn(status: ReturnStatus): boolean {
  return status === "REQUESTED" || status === "APPROVED";
}

// ── What the rules look at ──────────────────────────────────────────

export interface OrderLineFacts {
  id: string;
  fulfillmentType: FulfillmentType;
  includesEbook: boolean;
  quantity: number;
  unitPriceCents: number;
  /** Called off by a customer cancellation (`OrderItem.cancellationId`). */
  cancelled: boolean;
  /** Units of this line in the order's returns that weren't rejected. */
  returnedQuantity: number;
  /** The customer has downloaded this line's e-book at least once. Meaningless without one. */
  ebookDownloaded: boolean;
}

export interface OrderFacts {
  status: OrderStatus;
  shipmentStatus: ShipmentStatus | null;
  /** When the parcel was delivered (Date, or an ISO string once serialized). */
  deliveredAt: Date | string | null;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  totalCents: number;
  paymentStatus: PaymentStatus | null;
  items: OrderLineFacts[];
  cancellations: { refundCents: number }[];
  returns: { status: ReturnStatus; reason: string; refundCents: number }[];
}

/** The Prisma rows `toOrderFacts` reads — an Order with its items, payment, cancellations and returns. */
export interface OrderFactsRow {
  status: OrderStatus;
  shipmentStatus: ShipmentStatus | null;
  deliveredAt: Date | string | null;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  totalCents: number;
  payment: { status: PaymentStatus } | null;
  items: {
    id: string;
    productId: string;
    fulfillmentType: FulfillmentType;
    includesEbook: boolean;
    quantity: number;
    unitPriceCents: number;
    cancellationId: string | null;
  }[];
  cancellations: { refundCents: number }[];
  returns: { status: ReturnStatus; reason: string; refundCents: number; items: { orderItemId: string; quantity: number }[] }[];
}

/**
 * Folds an order's rows into the facts the rules need. `downloadedProductIds`
 * are the products whose e-book file this order's customer has downloaded
 * (`LibraryDownload.count > 0`).
 */
export function toOrderFacts(row: OrderFactsRow, downloadedProductIds: ReadonlySet<string>): OrderFacts {
  const returned = new Map<string, number>();
  for (const orderReturn of row.returns) {
    if (orderReturn.status === "REJECTED") continue;
    for (const item of orderReturn.items) {
      returned.set(item.orderItemId, (returned.get(item.orderItemId) ?? 0) + item.quantity);
    }
  }
  return {
    status: row.status,
    shipmentStatus: row.shipmentStatus,
    deliveredAt: row.deliveredAt,
    subtotalCents: row.subtotalCents,
    discountCents: row.discountCents,
    shippingCents: row.shippingCents,
    totalCents: row.totalCents,
    paymentStatus: row.payment?.status ?? null,
    items: row.items.map((item) => ({
      id: item.id,
      fulfillmentType: item.fulfillmentType,
      includesEbook: item.includesEbook,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      cancelled: item.cancellationId !== null,
      returnedQuantity: returned.get(item.id) ?? 0,
      ebookDownloaded: item.includesEbook && downloadedProductIds.has(item.productId),
    })),
    cancellations: row.cancellations.map(({ refundCents }) => ({ refundCents })),
    returns: row.returns.map(({ status, reason, refundCents }) => ({ status, reason, refundCents })),
  };
}

// ── Why a line can't be cancelled or returned ───────────────────────

export type LineBlock =
  | "ORDER_CLOSED"
  | "CANCELLED"
  | "SERVICE"
  | "RETURNED"
  | "EBOOK_DOWNLOADED"
  | "SHIPPED"
  | "NOT_DELIVERED"
  | "WINDOW_CLOSED";

/** What the customer is told about a line they can't pick. */
export const LINE_BLOCK_MESSAGE: Record<LineBlock, string> = {
  ORDER_CLOSED: "This order is closed.",
  CANCELLED: "Cancelled.",
  SERVICE: "Publishing services are cancelled with our team — contact us with your order number.",
  RETURNED: "Already in a return.",
  EBOOK_DOWNLOADED: "Its e-book has been downloaded, so it can't be cancelled or returned.",
  SHIPPED: "Your parcel has left us. Once it's delivered you can return this instead.",
  NOT_DELIVERED: "Can be returned once your parcel is delivered.",
  WINDOW_CLOSED: "The return window for this order has closed.",
};

/** Placed and still standing: paid (or cash on delivery) and not called off. */
function isLive(status: OrderStatus): boolean {
  return status !== "PENDING" && status !== "CANCELLED" && status !== "REFUNDED";
}

const NOT_SHIPPED: readonly (ShipmentStatus | null)[] = ["AWAITING_APPROVAL", "PROCESSING"];
const LEFT_US: readonly (ShipmentStatus | null)[] = ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];

/** A printed line whose parcel staff refused is as good as cancelled. */
function isGone(order: OrderFacts, line: OrderLineFacts): boolean {
  return line.cancelled || (line.fulfillmentType === "SHIP" && order.shipmentStatus === "CANCELLED");
}

function hasParcel(order: OrderFacts): boolean {
  return order.items.some((line) => line.fulfillmentType === "SHIP");
}

/** Null when the line can be cancelled now. */
export function cancelBlock(order: OrderFacts, line: OrderLineFacts): LineBlock | null {
  if (!isLive(order.status)) return "ORDER_CLOSED";
  if (isGone(order, line)) return "CANCELLED";
  if (line.fulfillmentType === "SERVICE") return "SERVICE";
  if (line.returnedQuantity > 0) return "RETURNED";
  if (line.includesEbook && line.ebookDownloaded) return "EBOOK_DOWNLOADED";
  if (line.fulfillmentType === "SHIP" && !NOT_SHIPPED.includes(order.shipmentStatus)) return "SHIPPED";
  // An e-book bought with a parcel: "Cancel order" goes once the parcel has
  // left, and the e-book is returned with the parcel instead.
  if (line.fulfillmentType !== "SHIP" && hasParcel(order) && LEFT_US.includes(order.shipmentStatus)) return "SHIPPED";
  return null;
}

/** Units of a line still able to go back. A line carrying an e-book only ever goes back whole. */
export function returnableQuantity(line: OrderLineFacts): number {
  if (line.includesEbook) return line.returnedQuantity > 0 ? 0 : line.quantity;
  return Math.max(0, line.quantity - line.returnedQuantity);
}

/** When the return window closes, or null if the parcel hasn't been delivered. */
export function returnWindowEndsAt(order: OrderFacts, windowDays: number): Date | null {
  if (order.shipmentStatus !== "DELIVERED" || !order.deliveredAt) return null;
  return new Date(new Date(order.deliveredAt).getTime() + windowDays * DAY_MS);
}

/** Null when (some of) the line can be returned now. */
export function returnBlock(order: OrderFacts, line: OrderLineFacts, now: Date, windowDays: number): LineBlock | null {
  if (!isLive(order.status)) return "ORDER_CLOSED";
  if (isGone(order, line)) return "CANCELLED";
  if (line.fulfillmentType === "SERVICE") return "SERVICE";
  if (line.includesEbook && line.ebookDownloaded) return "EBOOK_DOWNLOADED";
  if (returnableQuantity(line) === 0) return "RETURNED";
  if (order.shipmentStatus !== "DELIVERED") return "NOT_DELIVERED";
  const endsAt = returnWindowEndsAt(order, windowDays);
  if (!endsAt || now.getTime() >= endsAt.getTime()) return "WINDOW_CLOSED";
  return null;
}

export function hasOpenReturn(order: OrderFacts): boolean {
  return order.returns.some((orderReturn) => isOpenReturn(orderReturn.status));
}

/** "Cancel order" shows: something can still be called off. */
export function canCancel(order: OrderFacts): boolean {
  return order.items.some((line) => cancelBlock(order, line) === null);
}

/** "Return order" shows: the parcel is delivered, the window's open, no return is under way, and something can go back. */
export function canReturn(order: OrderFacts, now: Date, windowDays: number): boolean {
  return !hasOpenReturn(order) && order.items.some((line) => returnBlock(order, line, now, windowDays) === null);
}

// ── Money ───────────────────────────────────────────────────────────

/** `valueCents` of the order's items, less its share of the order's discount. */
export function discountedValueCents(order: Pick<OrderFacts, "subtotalCents" | "discountCents">, valueCents: number): number {
  if (order.subtotalCents <= 0 || order.discountCents <= 0) return valueCents;
  return valueCents - Math.round((valueCents * order.discountCents) / order.subtotalCents);
}

/** Refunds already worked out for this order: every cancellation's, and every return's that wasn't rejected. */
export function refundsSoFarCents(order: OrderFacts): number {
  const cancelled = order.cancellations.reduce((sum, cancellation) => sum + cancellation.refundCents, 0);
  const returned = order.returns
    .filter((orderReturn) => orderReturn.status !== "REJECTED")
    .reduce((sum, orderReturn) => sum + orderReturn.refundCents, 0);
  return cancelled + returned;
}

function leftToRefundCents(order: OrderFacts): number {
  return Math.max(0, order.totalCents - refundsSoFarCents(order));
}

// ── Cancelling ──────────────────────────────────────────────────────

export interface CancellationPlan {
  /** Every line still cancellable — all of them go. */
  lineIds: string[];
  /** The parcel is called off with it: no printed line is left to send. `shipmentStatus` → CANCELLED. */
  cancelsParcel: boolean;
  /** Nothing in the order is left standing. `status` → CANCELLED. */
  cancelsOrder: boolean;
  refundCents: number;
}

/** What "Cancel order" would do right now, or null if nothing can be cancelled. */
export function planCancellation(order: OrderFacts): CancellationPlan | null {
  const lines = order.items.filter((line) => cancelBlock(order, line) === null);
  if (!lines.length) return null;
  const ids = new Set(lines.map((line) => line.id));
  const standing = (line: OrderLineFacts) =>
    !ids.has(line.id) && !isGone(order, line) && line.returnedQuantity < line.quantity;

  const printedGoing = order.items.filter((line) => line.fulfillmentType === "SHIP" && !isGone(order, line));
  const cancelsParcel = printedGoing.length > 0 && printedGoing.every((line) => ids.has(line.id));
  const cancelsOrder = !order.items.some(standing);

  // A cash-on-delivery order hasn't been paid before it's delivered.
  let refundCents = 0;
  if (order.paymentStatus === "CAPTURED") {
    const value = lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
    refundCents = Math.min(
      leftToRefundCents(order),
      discountedValueCents(order, value) + (cancelsParcel ? order.shippingCents : 0)
    );
  }
  return { lineIds: [...ids], cancelsParcel, cancelsOrder, refundCents };
}

// ── Returning ───────────────────────────────────────────────────────

export interface ReturnSelection {
  lineId: string;
  quantity: number;
}

export type ReturnSelectionCheck = { ok: true } | { ok: false; error: string };

/** Whether a customer's picked lines and quantities are a return the rules allow right now. */
export function checkReturnSelection(
  order: OrderFacts,
  selection: readonly ReturnSelection[],
  now: Date,
  windowDays: number
): ReturnSelectionCheck {
  if (hasOpenReturn(order)) return { ok: false, error: "A return for this order is already under way." };
  if (!selection.length) return { ok: false, error: "Choose at least one item to return." };
  if (new Set(selection.map((picked) => picked.lineId)).size !== selection.length) {
    return { ok: false, error: "Each item can only be picked once." };
  }
  for (const picked of selection) {
    const line = order.items.find((candidate) => candidate.id === picked.lineId);
    if (!line) return { ok: false, error: "One of those items isn't in this order." };
    const block = returnBlock(order, line, now, windowDays);
    if (block) return { ok: false, error: LINE_BLOCK_MESSAGE[block] };
    const most = returnableQuantity(line);
    if (!Number.isInteger(picked.quantity) || picked.quantity < 1 || picked.quantity > most) {
      return { ok: false, error: "That's more copies than can be returned." };
    }
    if (line.includesEbook && picked.quantity !== line.quantity) {
      return { ok: false, error: "An item that comes with an e-book can only be returned whole." };
    }
  }
  return { ok: true };
}

/** Whether the customer must confirm unopened packaging: something printed is going back. */
export function returnsPrintedCopies(order: OrderFacts, selection: readonly ReturnSelection[]): boolean {
  return selection.some(
    (picked) => order.items.find((line) => line.id === picked.lineId)?.fulfillmentType === "SHIP"
  );
}

/** What a return of `selection` for `reason` refunds, once it's completed. */
export function returnRefundCents(order: OrderFacts, selection: readonly ReturnSelection[], reason: string): number {
  let value = 0;
  for (const picked of selection) {
    const line = order.items.find((candidate) => candidate.id === picked.lineId);
    if (line) value += line.unitPriceCents * picked.quantity;
  }
  const deliveryRefunded = order.returns.some(
    (orderReturn) => orderReturn.status !== "REJECTED" && PRESS_FAULT_REASONS.has(orderReturn.reason)
  );
  const delivery =
    PRESS_FAULT_REASONS.has(reason) && !deliveryRefunded && returnsPrintedCopies(order, selection)
      ? order.shippingCents
      : 0;
  return Math.min(leftToRefundCents(order), discountedValueCents(order, value) + delivery);
}

/** Money staff still have to send back for a cancellation, or for a return once it's completed. */
export function isRefundDue(record: {
  refundCents: number;
  refundedAt: Date | string | null;
  status?: ReturnStatus;
}): boolean {
  if (record.refundCents <= 0 || record.refundedAt) return false;
  return record.status === undefined || record.status === "COMPLETED";
}
