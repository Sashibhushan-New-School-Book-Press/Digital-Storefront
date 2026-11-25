import { describe, expect, it } from "vitest";
import {
  LINE_BLOCK_MESSAGE,
  canCancel,
  canReturn,
  cancelBlock,
  cancelReasonLabel,
  checkReturnSelection,
  discountedValueCents,
  isRefundDue,
  planCancellation,
  refundsSoFarCents,
  returnBlock,
  returnReasonLabel,
  returnRefundCents,
  returnWindowEndsAt,
  returnableQuantity,
  returnsPrintedCopies,
  toOrderFacts,
  type OrderFacts,
  type OrderLineFacts,
} from "./returns";

const DAY = 86_400_000;
const DELIVERED_AT = new Date("2026-11-01T10:00:00.000Z");
const WINDOW = 7;
const inWindow = new Date(DELIVERED_AT.getTime() + 2 * DAY);

function line(overrides: Partial<OrderLineFacts> = {}): OrderLineFacts {
  return {
    id: "paperback",
    fulfillmentType: "SHIP",
    includesEbook: false,
    quantity: 1,
    unitPriceCents: 50_000,
    cancelled: false,
    returnedQuantity: 0,
    ebookDownloaded: false,
    ...overrides,
  };
}

const ebookLine = (overrides: Partial<OrderLineFacts> = {}) =>
  line({ id: "ebook", fulfillmentType: "DIGITAL", includesEbook: true, unitPriceCents: 20_000, ...overrides });

function order(overrides: Partial<OrderFacts> = {}): OrderFacts {
  const items = overrides.items ?? [line()];
  const subtotalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  return {
    status: "PROCESSING",
    shipmentStatus: "AWAITING_APPROVAL",
    deliveredAt: null,
    subtotalCents,
    discountCents: 0,
    shippingCents: 0,
    totalCents: subtotalCents,
    paymentStatus: "CREATED",
    cancellations: [],
    returns: [],
    ...overrides,
    items,
  };
}

const delivered = (overrides: Partial<OrderFacts> = {}) =>
  order({ shipmentStatus: "DELIVERED", deliveredAt: DELIVERED_AT, paymentStatus: "CAPTURED", ...overrides });

describe("cancelling", () => {
  it("is open until the parcel ships", () => {
    expect(canCancel(order({ shipmentStatus: "AWAITING_APPROVAL" }))).toBe(true);
    expect(canCancel(order({ shipmentStatus: "PROCESSING" }))).toBe(true);
    for (const shipmentStatus of ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"] as const) {
      expect(cancelBlock(order({ shipmentStatus }), line())).toBe("SHIPPED");
      expect(canCancel(order({ shipmentStatus }))).toBe(false);
    }
  });

  it("never reopens a closed or refused order", () => {
    expect(cancelBlock(order({ status: "CANCELLED", shipmentStatus: "CANCELLED" }), line())).toBe("ORDER_CLOSED");
    expect(cancelBlock(order({ shipmentStatus: "CANCELLED" }), line())).toBe("CANCELLED");
    expect(cancelBlock(order(), line({ cancelled: true }))).toBe("CANCELLED");
  });

  it("lets an e-book go only while it hasn't been downloaded", () => {
    const digital = order({ status: "PAID", shipmentStatus: null, paymentStatus: "CAPTURED", items: [ebookLine()] });
    expect(canCancel(digital)).toBe(true);
    const downloaded = order({ ...digital, items: [ebookLine({ ebookDownloaded: true })] });
    expect(cancelBlock(downloaded, downloaded.items[0]!)).toBe("EBOOK_DOWNLOADED");
    expect(canCancel(downloaded)).toBe(false);
  });

  it("hands an e-book bought with a parcel over to returns once the parcel leaves", () => {
    const mixed = order({ shipmentStatus: "SHIPPED", items: [line(), ebookLine()] });
    expect(cancelBlock(mixed, mixed.items[1]!)).toBe("SHIPPED");
    // A parcel staff refused never left, so the e-book can still go.
    const refused = order({ shipmentStatus: "CANCELLED", items: [line(), ebookLine()] });
    expect(cancelBlock(refused, refused.items[1]!)).toBeNull();
  });

  it("keeps a print + e-book line whole: no cancelling it once the e-book is downloaded", () => {
    const bundle = line({ includesEbook: true, ebookDownloaded: true });
    expect(cancelBlock(order({ items: [bundle] }), bundle)).toBe("EBOOK_DOWNLOADED");
  });

  it("leaves publishing services to the team", () => {
    const service = line({ id: "service", fulfillmentType: "SERVICE" });
    expect(cancelBlock(order({ shipmentStatus: null, items: [service] }), service)).toBe("SERVICE");
  });
});

describe("planCancellation", () => {
  it("calls off a whole unshipped cash-on-delivery order with nothing to refund", () => {
    expect(planCancellation(order({ items: [line(), line({ id: "chart", unitPriceCents: 9_900 })] }))).toEqual({
      lineIds: ["paperback", "chart"],
      cancelsParcel: true,
      cancelsOrder: true,
      refundCents: 0,
    });
  });

  it("refunds everything paid online, delivery included", () => {
    const paid = order({ paymentStatus: "CAPTURED", shippingCents: 4_900, discountCents: 5_000, totalCents: 49_900 });
    expect(planCancellation(paid)?.refundCents).toBe(49_900);
  });

  it("keeps a downloaded e-book and refunds only what was cancelled", () => {
    const mixed = order({
      paymentStatus: "CAPTURED",
      items: [line(), ebookLine({ ebookDownloaded: true })],
      shippingCents: 4_900,
      discountCents: 7_000, // 10% of the 70,000 subtotal
      totalCents: 67_900,
    });
    expect(planCancellation(mixed)).toEqual({
      lineIds: ["paperback"],
      cancelsParcel: true,
      cancelsOrder: false,
      // 50,000 less its 10% share of the discount, plus the delivery charge.
      refundCents: 45_000 + 4_900,
    });
  });

  it("keeps the parcel going when a print + e-book line can't be cancelled", () => {
    const plan = planCancellation(
      order({ items: [line(), line({ id: "bundle", includesEbook: true, ebookDownloaded: true })] })
    );
    expect(plan).toMatchObject({ lineIds: ["paperback"], cancelsParcel: false, cancelsOrder: false });
  });

  it("is null when nothing can be cancelled", () => {
    expect(planCancellation(order({ shipmentStatus: "SHIPPED" }))).toBeNull();
  });
});

describe("returning", () => {
  it("opens when the parcel is delivered and closes with the window", () => {
    expect(returnBlock(order({ shipmentStatus: "OUT_FOR_DELIVERY" }), line(), inWindow, WINDOW)).toBe("NOT_DELIVERED");
    expect(returnWindowEndsAt(delivered(), WINDOW)).toEqual(new Date(DELIVERED_AT.getTime() + 7 * DAY));
    expect(canReturn(delivered(), inWindow, WINDOW)).toBe(true);
    expect(returnBlock(delivered(), line(), new Date(DELIVERED_AT.getTime() + 7 * DAY), WINDOW)).toBe("WINDOW_CLOSED");
  });

  it("never offers a return on a digital-only order", () => {
    const digital = order({ status: "PAID", shipmentStatus: null, items: [ebookLine()] });
    expect(canReturn(digital, inWindow, WINDOW)).toBe(false);
  });

  it("takes back an undownloaded e-book with the parcel, but not a downloaded one", () => {
    const mixed = delivered({ items: [line(), ebookLine()] });
    expect(returnBlock(mixed, mixed.items[1]!, inWindow, WINDOW)).toBeNull();
    const downloaded = delivered({ items: [line(), ebookLine({ ebookDownloaded: true })] });
    expect(returnBlock(downloaded, downloaded.items[1]!, inWindow, WINDOW)).toBe("EBOOK_DOWNLOADED");
  });

  it("allows one return at a time, and only the copies not already going back", () => {
    const three = line({ quantity: 3, returnedQuantity: 1 });
    const busy = delivered({ items: [three], returns: [{ status: "REQUESTED", reason: "NOT_NEEDED", refundCents: 0, printed: true }] });
    expect(canReturn(busy, inWindow, WINDOW)).toBe(false);
    const after = delivered({ items: [three], returns: [{ status: "COMPLETED", reason: "NOT_NEEDED", refundCents: 0, printed: true }] });
    expect(canReturn(after, inWindow, WINDOW)).toBe(true);
    expect(checkReturnSelection(after, [{ lineId: "paperback", quantity: 2 }], inWindow, WINDOW)).toEqual({ ok: true });
    expect(checkReturnSelection(after, [{ lineId: "paperback", quantity: 3 }], inWindow, WINDOW).ok).toBe(false);
  });

  it("sends a print + e-book line back whole", () => {
    const bundle = delivered({ items: [line({ includesEbook: true, quantity: 2 })] });
    expect(checkReturnSelection(bundle, [{ lineId: "paperback", quantity: 1 }], inWindow, WINDOW).ok).toBe(false);
    expect(checkReturnSelection(bundle, [{ lineId: "paperback", quantity: 2 }], inWindow, WINDOW)).toEqual({ ok: true });
  });

  it("refuses an empty, repeated or unknown pick", () => {
    const ok = delivered();
    expect(checkReturnSelection(ok, [], inWindow, WINDOW).ok).toBe(false);
    expect(checkReturnSelection(ok, [{ lineId: "nope", quantity: 1 }], inWindow, WINDOW).ok).toBe(false);
    const twice = [
      { lineId: "paperback", quantity: 1 },
      { lineId: "paperback", quantity: 1 },
    ];
    expect(checkReturnSelection(ok, twice, inWindow, WINDOW).ok).toBe(false);
  });

  it("asks about packaging only when printed copies go back", () => {
    const mixed = delivered({ items: [line(), ebookLine()] });
    expect(returnsPrintedCopies(mixed, [{ lineId: "ebook", quantity: 1 }])).toBe(false);
    expect(returnsPrintedCopies(mixed, [{ lineId: "paperback", quantity: 1 }])).toBe(true);
  });
});

describe("returnRefundCents", () => {
  const twoCopies = () =>
    delivered({ items: [line({ quantity: 2 })], shippingCents: 4_900, discountCents: 10_000, totalCents: 94_900 });

  it("refunds the copies less their share of the discount", () => {
    expect(returnRefundCents(twoCopies(), [{ lineId: "paperback", quantity: 1 }], "NOT_NEEDED")).toBe(45_000);
  });

  it("adds the delivery charge, once, when the Press got it wrong", () => {
    expect(returnRefundCents(twoCopies(), [{ lineId: "paperback", quantity: 1 }], "DAMAGED")).toBe(49_900);
    const second = { ...twoCopies(), returns: [{ status: "COMPLETED" as const, reason: "DAMAGED", refundCents: 49_900, printed: true }] };
    expect(returnRefundCents(second, [{ lineId: "paperback", quantity: 1 }], "WRONG_ITEM")).toBe(45_000);
  });

  it("never refunds more than is left of the total", () => {
    const earlier = { ...twoCopies(), cancellations: [{ refundCents: 80_000 }] };
    expect(returnRefundCents(earlier, [{ lineId: "paperback", quantity: 2 }], "DAMAGED")).toBe(14_900);
  });
});

describe("toOrderFacts", () => {
  it("counts returned copies outside rejected returns, and only downloads of this line's e-book", () => {
    const facts = toOrderFacts(
      {
        status: "DELIVERED",
        shipmentStatus: "DELIVERED",
        deliveredAt: DELIVERED_AT,
        subtotalCents: 0,
        discountCents: 0,
        shippingCents: 0,
        totalCents: 0,
        payment: { status: "CAPTURED" },
        items: [
          { id: "a", productId: "p1", fulfillmentType: "SHIP", includesEbook: false, quantity: 3, unitPriceCents: 1, cancellationId: null },
          { id: "b", productId: "p2", fulfillmentType: "DIGITAL", includesEbook: true, quantity: 1, unitPriceCents: 1, cancellationId: "c1" },
        ],
        cancellations: [{ refundCents: 1 }],
        returns: [
          { status: "COMPLETED", reason: "NOT_NEEDED", refundCents: 1, items: [{ orderItemId: "a", quantity: 1 }] },
          { status: "REJECTED", reason: "NOT_NEEDED", refundCents: 1, items: [{ orderItemId: "a", quantity: 2 }] },
          { status: "COMPLETED", reason: "WRONG_ITEM", refundCents: 1, items: [{ orderItemId: "b", quantity: 1 }] },
        ],
      },
      new Set(["p1", "p2"])
    );
    expect(facts.items).toMatchObject([
      { id: "a", returnedQuantity: 1, cancelled: false, ebookDownloaded: false },
      { id: "b", returnedQuantity: 1, cancelled: true, ebookDownloaded: true },
    ]);
    // Which returns sent printed copies back.
    expect(facts.returns.map((orderReturn) => orderReturn.printed)).toEqual([true, true, false]);
  });
});

describe("isRefundDue", () => {
  it("is owed for a cancellation at once and for a return once it's completed, until sent", () => {
    expect(isRefundDue({ refundCents: 100, refundedAt: null })).toBe(true);
    expect(isRefundDue({ refundCents: 0, refundedAt: null })).toBe(false);
    expect(isRefundDue({ refundCents: 100, refundedAt: new Date() })).toBe(false);
    expect(isRefundDue({ refundCents: 100, refundedAt: null, status: "APPROVED" })).toBe(false);
    expect(isRefundDue({ refundCents: 100, refundedAt: null, status: "COMPLETED" })).toBe(true);
  });

  it("is never owed for a rejected return, or one already sent", () => {
    expect(isRefundDue({ refundCents: 100, refundedAt: null, status: "REJECTED" })).toBe(false);
    expect(isRefundDue({ refundCents: 100, refundedAt: "2026-11-05T00:00:00.000Z", status: "COMPLETED" })).toBe(false);
  });
});

describe("reason labels", () => {
  it("reads a stored key as its label, and one since removed as another reason", () => {
    expect(cancelReasonLabel("TOO_SLOW")).toBe("It's taking too long to arrive");
    expect(cancelReasonLabel("NO_LONGER_A_KEY")).toBe("Another reason");
    expect(returnReasonLabel("WRONG_ITEM")).toBe("I was sent the wrong item");
    expect(returnReasonLabel("")).toBe("Another reason");
  });
});

describe("a closed order", () => {
  it("can't be cancelled or returned once unpaid, cancelled or refunded", () => {
    for (const status of ["PENDING", "CANCELLED", "REFUNDED"] as const) {
      expect(cancelBlock(order({ status }), line())).toBe("ORDER_CLOSED");
      expect(returnBlock(delivered({ status }), line(), inWindow, WINDOW)).toBe("ORDER_CLOSED");
      expect(planCancellation(order({ status }))).toBeNull();
      expect(canReturn(delivered({ status }), inWindow, WINDOW)).toBe(false);
    }
  });
});

describe("the return window", () => {
  it("is open until its last millisecond", () => {
    const lastMoment = new Date(DELIVERED_AT.getTime() + WINDOW * DAY - 1);
    expect(returnBlock(delivered(), line(), lastMoment, WINDOW)).toBeNull();
  });

  it("reads a delivery time serialized for the browser the same as a Date", () => {
    const serialized = delivered({ deliveredAt: DELIVERED_AT.toISOString() });
    expect(returnWindowEndsAt(serialized, WINDOW)).toEqual(new Date(DELIVERED_AT.getTime() + WINDOW * DAY));
    expect(canReturn(serialized, inWindow, WINDOW)).toBe(true);
  });

  it("stays shut for a delivered parcel with no delivery time", () => {
    const unknown = delivered({ deliveredAt: null });
    expect(returnWindowEndsAt(unknown, WINDOW)).toBeNull();
    expect(returnBlock(unknown, line(), inWindow, WINDOW)).toBe("WINDOW_CLOSED");
  });

  it("is shut on the day of delivery when the window is zero days", () => {
    expect(returnBlock(delivered(), line(), DELIVERED_AT, 0)).toBe("WINDOW_CLOSED");
  });
});

describe("what can't go back", () => {
  it("never takes back a cancelled line, a refused parcel or a publishing service", () => {
    const service = line({ id: "service", fulfillmentType: "SERVICE" });
    const mixed = delivered({ items: [line({ cancelled: true }), service] });
    expect(returnBlock(mixed, mixed.items[0]!, inWindow, WINDOW)).toBe("CANCELLED");
    expect(returnBlock(mixed, service, inWindow, WINDOW)).toBe("SERVICE");
    expect(canReturn(mixed, inWindow, WINDOW)).toBe(false);
    const refused = order({ shipmentStatus: "CANCELLED", items: [line()] });
    expect(returnBlock(refused, line(), inWindow, WINDOW)).toBe("CANCELLED");
  });

  it("counts a print + e-book line as returned after any of it goes back", () => {
    expect(returnableQuantity(line({ includesEbook: true, quantity: 2, returnedQuantity: 1 }))).toBe(0);
    expect(returnableQuantity(line({ quantity: 2, returnedQuantity: 5 }))).toBe(0);
    expect(returnableQuantity(line({ quantity: 4, returnedQuantity: 1 }))).toBe(3);
  });
});

describe("checkReturnSelection, refusing", () => {
  it("a zero, fractional, negative or missing quantity", () => {
    const two = delivered({ items: [line({ quantity: 2 })] });
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      expect(checkReturnSelection(two, [{ lineId: "paperback", quantity }], inWindow, WINDOW)).toEqual({
        ok: false,
        error: "That's more copies than can be returned.",
      });
    }
  });

  it("a line it can't take, with the reason the customer sees", () => {
    const mixed = delivered({ items: [line(), ebookLine({ ebookDownloaded: true })] });
    expect(checkReturnSelection(mixed, [{ lineId: "ebook", quantity: 1 }], inWindow, WINDOW)).toEqual({
      ok: false,
      error: LINE_BLOCK_MESSAGE.EBOOK_DOWNLOADED,
    });
  });

  it("anything while a return is under way, before looking at the pick", () => {
    const busy = delivered({ returns: [{ status: "APPROVED", reason: "NOT_NEEDED", refundCents: 0, printed: true }] });
    expect(checkReturnSelection(busy, [], inWindow, WINDOW)).toEqual({
      ok: false,
      error: "A return for this order is already under way.",
    });
  });
});

describe("planCancellation, more", () => {
  it("leaves a publishing service standing, so the order stays open", () => {
    const withService = order({
      status: "PAID",
      paymentStatus: "CAPTURED",
      items: [line(), line({ id: "service", fulfillmentType: "SERVICE", unitPriceCents: 100_000 })],
    });
    expect(planCancellation(withService)).toEqual({
      lineIds: ["paperback"],
      cancelsParcel: true,
      cancelsOrder: false,
      refundCents: 50_000,
    });
  });

  it("calls off a digital-only order without a parcel, less its discount", () => {
    const digital = order({
      status: "PAID",
      shipmentStatus: null,
      paymentStatus: "CAPTURED",
      discountCents: 2_000,
      totalCents: 18_000,
      items: [ebookLine()],
    });
    expect(planCancellation(digital)).toEqual({
      lineIds: ["ebook"],
      cancelsParcel: false,
      cancelsOrder: true,
      refundCents: 18_000,
    });
  });

  it("never refunds more than what's left after earlier cancellations", () => {
    const partlyRefunded = order({
      status: "PAID",
      shipmentStatus: null,
      paymentStatus: "CAPTURED",
      items: [ebookLine()],
      cancellations: [{ refundCents: 15_000 }],
    });
    expect(planCancellation(partlyRefunded)?.refundCents).toBe(5_000);
  });

  it("refunds nothing while an online payment hasn't been captured", () => {
    for (const paymentStatus of ["AUTHORIZED", "FAILED", null] as const) {
      expect(planCancellation(order({ status: "PAID", paymentStatus }))?.refundCents).toBe(0);
    }
  });
});

describe("refund maths", () => {
  it("shares the discount by value, and leaves an undiscounted order alone", () => {
    expect(discountedValueCents({ subtotalCents: 1_000, discountCents: 100 }, 400)).toBe(360);
    expect(discountedValueCents({ subtotalCents: 1_000, discountCents: 0 }, 400)).toBe(400);
    expect(discountedValueCents({ subtotalCents: 0, discountCents: 500 }, 100)).toBe(100);
  });

  it("counts every cancellation and every return that wasn't rejected", () => {
    const history = delivered({
      cancellations: [{ refundCents: 100 }],
      returns: [
        { status: "COMPLETED", reason: "NOT_NEEDED", refundCents: 200, printed: true },
        { status: "REJECTED", reason: "NOT_NEEDED", refundCents: 400, printed: true },
        { status: "REQUESTED", reason: "NOT_NEEDED", refundCents: 800, printed: true },
      ],
    });
    expect(refundsSoFarCents(history)).toBe(1_100);
  });

  it("refunds delivery again when the earlier Press-fault return was rejected", () => {
    const rejected = delivered({
      items: [line({ quantity: 2 })],
      shippingCents: 4_900,
      totalCents: 104_900,
      returns: [{ status: "REJECTED", reason: "DAMAGED", refundCents: 54_900, printed: true }],
    });
    expect(returnRefundCents(rejected, [{ lineId: "paperback", quantity: 1 }], "DAMAGED")).toBe(54_900);
  });

  it("keeps the delivery charge when only an e-book goes back", () => {
    const mixed = delivered({ items: [line(), ebookLine()], shippingCents: 4_900, totalCents: 74_900 });
    expect(returnRefundCents(mixed, [{ lineId: "ebook", quantity: 1 }], "WRONG_ITEM")).toBe(20_000);
  });

  it("ignores a picked line that isn't in the order", () => {
    expect(returnRefundCents(delivered(), [{ lineId: "nope", quantity: 3 }], "NOT_NEEDED")).toBe(0);
  });

  it("never refunds more than the order total, however the copies go back", () => {
    // 3 × ₹333.33 less a ₹100 coupon, plus ₹49 delivery.
    let current = delivered({
      items: [line({ quantity: 3, unitPriceCents: 33_333 })],
      discountCents: 10_000,
      shippingCents: 4_900,
      totalCents: 94_899,
    });
    let refunded = 0;
    for (let copy = 1; copy <= 3; copy++) {
      const refund = returnRefundCents(current, [{ lineId: "paperback", quantity: 1 }], "DAMAGED");
      refunded += refund;
      current = {
        ...current,
        items: [{ ...current.items[0]!, returnedQuantity: copy }],
        returns: [...current.returns, { status: "COMPLETED", reason: "DAMAGED", refundCents: refund, printed: true }],
      };
    }
    expect(refunded).toBe(94_899);
    expect(returnBlock(current, current.items[0]!, inWindow, WINDOW)).toBe("RETURNED");
  });

  // An e-book-only return never refunds delivery, so it doesn't use it up.
  it("refunds delivery for printed copies after an e-book-only Press-fault return", () => {
    const mixed = delivered({
      items: [line(), ebookLine()],
      shippingCents: 4_900,
      totalCents: 74_900,
      returns: [{ status: "COMPLETED", reason: "WRONG_ITEM", refundCents: 20_000, printed: false }],
    });
    expect(returnRefundCents(mixed, [{ lineId: "paperback", quantity: 1 }], "DAMAGED")).toBe(54_900);
  });
});
