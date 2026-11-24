import { describe, expect, it } from "vitest";
import {
  buildTrackingTimeline,
  orderStatusBadge,
  type OrderDetail,
  type OrderDetailItem,
  type OrderReturnDetail,
} from "@/lib/order-tracking";

// What a customer sees while staff move an order through the admin Sales
// Orders page (Order.shipmentStatus).

function item(overrides: Partial<OrderDetailItem> = {}): OrderDetailItem {
  return {
    id: "item_1",
    title: "Book 1",
    author: "A",
    href: null,
    coverImageUrl: null,
    fulfillmentType: "SHIP",
    formatLabel: "Paperback",
    includesEbook: false,
    quantity: 1,
    unitPriceCents: 50_000,
    cancelled: false,
    returnedQuantity: 0,
    cancelBlock: null,
    returnBlock: null,
    returnableQuantity: 1,
    ...overrides,
  };
}

function returned(overrides: Partial<OrderReturnDetail> = {}): OrderReturnDetail {
  return {
    id: "return_1",
    status: "REQUESTED",
    createdAt: "2026-10-30T04:00:00.000Z",
    decidedAt: null,
    completedAt: null,
    reasonLabel: "I no longer need it",
    note: null,
    staffNote: null,
    refundCents: 50_000,
    refundedAt: null,
    items: [{ orderItemId: "item_1", quantity: 1 }],
    ...overrides,
  };
}

function order(overrides: Partial<OrderDetail> = {}): OrderDetail {
  return {
    id: "order_1",
    ref: "#der_1",
    status: "PROCESSING",
    shipmentStatus: "AWAITING_APPROVAL",
    createdAt: "2026-10-25T04:00:00.000Z",
    updatedAt: "2026-10-26T04:00:00.000Z",
    subtotalCents: 50_000,
    discountCents: 0,
    discountCode: null,
    shippingCents: 0,
    taxCents: 0,
    totalCents: 50_000,
    shippingAddress: null,
    billingAddress: null,
    gstNumber: null,
    carrier: null,
    trackingNumber: null,
    payment: { method: "COD", status: "CREATED", updatedAt: "2026-10-25T04:00:00.000Z" },
    items: [item()],
    cancellations: [],
    returns: [],
    canCancel: false,
    cancelRefundCents: 0,
    cancelsWholeOrder: false,
    canReturn: false,
    returnWindowEndsAt: null,
    facts: {
      status: "PROCESSING",
      shipmentStatus: "AWAITING_APPROVAL",
      deliveredAt: null,
      subtotalCents: 50_000,
      discountCents: 0,
      shippingCents: 0,
      totalCents: 50_000,
      paymentStatus: "CREATED",
      items: [],
      cancellations: [],
      returns: [],
    },
    ...overrides,
  };
}

const current = (detail: OrderDetail) =>
  buildTrackingTimeline(detail, "in 3-5 working days").find((step) => step.state === "current")?.key;

describe("orderStatusBadge", () => {
  it("follows the parcel while it's on its way", () => {
    expect(orderStatusBadge(order()).label).toBe("Awaiting confirmation");
    expect(orderStatusBadge(order({ shipmentStatus: "SHIPPED" })).label).toBe("Shipping");
    expect(orderStatusBadge(order({ shipmentStatus: "OUT_FOR_DELIVERY" })).label).toBe("Out for delivery");
  });

  it("shows a refused order as cancelled", () => {
    expect(orderStatusBadge(order({ status: "CANCELLED", shipmentStatus: "CANCELLED" })).label).toBe("Cancelled");
    // A mixed order whose parcel was refused keeps its PAID status.
    expect(orderStatusBadge(order({ status: "PAID", shipmentStatus: "CANCELLED" })).label).toBe("Cancelled");
  });

  it("follows a return once one is asked for", () => {
    const delivered = { status: "DELIVERED", shipmentStatus: "DELIVERED" } as const;
    expect(orderStatusBadge(order({ ...delivered, returns: [returned()] })).label).toBe("Return requested");
    expect(orderStatusBadge(order({ ...delivered, returns: [returned({ status: "APPROVED" })] })).label).toBe(
      "Return approved"
    );
    // A refused return leaves the order as it was.
    expect(orderStatusBadge(order({ ...delivered, returns: [returned({ status: "REJECTED" })] })).label).toBe("Delivered");
  });

  it("tells a full return from a partial one", () => {
    const done = returned({ status: "COMPLETED" });
    const all = order({ status: "DELIVERED", shipmentStatus: "DELIVERED", items: [item({ returnedQuantity: 1 })], returns: [done] });
    expect(orderStatusBadge(all).label).toBe("Returned");
    const some = order({ ...all, items: [item({ quantity: 2, returnedQuantity: 1 })] });
    expect(orderStatusBadge(some).label).toBe("Partly returned");
  });
});

describe("buildTrackingTimeline", () => {
  it("waits on staff confirmation, then walks the parcel's steps", () => {
    expect(current(order())).toBe("accepted");
    expect(current(order({ shipmentStatus: "PROCESSING" }))).toBe("processing");
    expect(current(order({ shipmentStatus: "OUT_FOR_DELIVERY" }))).toBe("out_for_delivery");
  });

  it("ticks every step once delivered", () => {
    const steps = buildTrackingTimeline(order({ shipmentStatus: "DELIVERED" }), "in 3-5 working days");
    expect(steps.every((step) => step.state === "done")).toBe(true);
  });

  it("stops at a cancellation, telling a mixed order its e-books are kept", () => {
    const steps = buildTrackingTimeline(order({ status: "PAID", shipmentStatus: "CANCELLED" }), "in 3-5 working days");
    const last = steps.at(-1)!;
    expect(last).toMatchObject({ key: "cancelled", state: "stopped" });
    expect(last.description).toMatch(/e-books stay in your digital library/);
  });

  it("says when the customer cancelled it themselves, and what comes back", () => {
    const cancellation = {
      id: "c1",
      createdAt: "2026-10-25T05:00:00.000Z",
      reasonLabel: "I changed my mind",
      note: null,
      refundCents: 50_000,
      refundedAt: null,
      itemIds: ["item_1"],
    };
    const steps = buildTrackingTimeline(
      order({ status: "CANCELLED", shipmentStatus: "CANCELLED", cancellations: [cancellation] }),
      "in 3-5 working days"
    );
    expect(steps.at(-1)).toMatchObject({ key: "cancelled", state: "stopped", at: cancellation.createdAt });
    expect(steps.at(-1)!.description).toMatch(/^You cancelled this order\. ₹500 is being refunded/);
  });

  it("carries on past delivery with the return's steps", () => {
    const delivered = { status: "DELIVERED", shipmentStatus: "DELIVERED" } as const;
    const requested = buildTrackingTimeline(order({ ...delivered, returns: [returned()] }), "in 3-5 working days");
    expect(requested.find((step) => step.key === "delivered")?.state).toBe("done");
    expect(current(order({ ...delivered, returns: [returned()] }))).toBe("return_requested");
    expect(current(order({ ...delivered, returns: [returned({ status: "APPROVED" })] }))).toBe("return_approved");

    const rejected = buildTrackingTimeline(
      order({ ...delivered, returns: [returned({ status: "REJECTED", staffNote: "The seal was broken." })] }),
      "in 3-5 working days"
    );
    expect(rejected.at(-1)).toMatchObject({ key: "return_rejected", state: "stopped", description: "The seal was broken." });

    const completed = buildTrackingTimeline(
      order({ ...delivered, returns: [returned({ status: "COMPLETED", completedAt: "2026-11-02T04:00:00.000Z" })] }),
      "in 3-5 working days"
    );
    expect(completed.every((step) => step.state === "done")).toBe(true);
    expect(completed.at(-1)!.description).toMatch(/bank transfer or UPI/);
  });
});
