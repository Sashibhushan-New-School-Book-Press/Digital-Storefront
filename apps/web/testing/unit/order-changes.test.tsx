// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderDetail, OrderDetailItem } from "@/lib/order-tracking";

// The My Orders pop-up's "Cancel order" / "Return order": which button shows
// when, what each form asks, and what it sends. The Server Actions and the
// router are stubbed; the rules behind `canCancel`/`canReturn` are tested in
// packages/database/src/returns.test.ts and against a real database in
// testing/integration/order-changes.test.ts.

const actions = vi.hoisted(() => ({
  cancelOrder: vi.fn(async (_input: unknown) => ({ ok: true }) as { ok: true } | { ok: false; error: string }),
  requestReturn: vi.fn(async (_input: unknown) => ({ ok: true }) as { ok: true } | { ok: false; error: string }),
}));
vi.mock("@/app/(account)/account/orders/actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/image", () => ({ default: () => null }));

const { OrderDetailDialog } = await import("@/components/account/order-detail-dialog");

beforeAll(() => {
  // jsdom has <dialog> but not its modal methods.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  Element.prototype.scrollTo = () => {};
});

beforeEach(() => {
  actions.cancelOrder.mockClear();
  actions.requestReturn.mockClear();
});

function item(overrides: Partial<OrderDetailItem> = {}): OrderDetailItem {
  return {
    id: "item_1",
    title: "The Little Grammar",
    author: "A. Writer",
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
    returnBlock: "NOT_DELIVERED",
    returnableQuantity: 1,
    ...overrides,
  };
}

function order(overrides: Partial<OrderDetail> = {}): OrderDetail {
  const items = overrides.items ?? [item()];
  const subtotalCents = items.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
  return {
    id: "order_1",
    ref: "#der_1",
    status: "PROCESSING",
    shipmentStatus: "AWAITING_APPROVAL",
    createdAt: "2026-11-01T04:00:00.000Z",
    updatedAt: "2026-11-01T04:00:00.000Z",
    subtotalCents,
    discountCents: 0,
    discountCode: null,
    shippingCents: 0,
    taxCents: 0,
    totalCents: subtotalCents,
    shippingAddress: null,
    billingAddress: null,
    gstNumber: null,
    carrier: null,
    trackingNumber: null,
    payment: { method: "COD", status: "CREATED", updatedAt: "2026-11-01T04:00:00.000Z" },
    cancellations: [],
    returns: [],
    canCancel: true,
    cancelRefundCents: 0,
    cancelsWholeOrder: true,
    canReturn: false,
    returnWindowEndsAt: null,
    facts: {
      status: "PROCESSING",
      shipmentStatus: "AWAITING_APPROVAL",
      deliveredAt: null,
      subtotalCents,
      discountCents: 0,
      shippingCents: 0,
      totalCents: subtotalCents,
      paymentStatus: "CREATED",
      items: items.map((line) => ({
        id: line.id,
        fulfillmentType: line.fulfillmentType,
        includesEbook: line.includesEbook,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        cancelled: line.cancelled,
        returnedQuantity: line.returnedQuantity,
        ebookDownloaded: false,
      })),
      cancellations: [],
      returns: [],
    },
    ...overrides,
    items,
  };
}

const show = (detail: OrderDetail) =>
  render(<OrderDetailDialog order={detail} standardEta="in 3-5 working days" onClose={() => {}} />);

describe("Cancel order", () => {
  it("shows only while the order can still be cancelled", () => {
    show(order());
    expect(screen.getByRole("button", { name: "Cancel order" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Return order" })).not.toBeInTheDocument();
  });

  it("is gone once the parcel has shipped", () => {
    show(order({ shipmentStatus: "SHIPPED", canCancel: false, items: [item({ cancelBlock: "SHIPPED" })] }));
    expect(screen.queryByRole("button", { name: "Cancel order" })).not.toBeInTheDocument();
  });

  it("asks why, then cancels", async () => {
    const user = userEvent.setup();
    show(order());
    await user.click(screen.getByRole("button", { name: "Cancel order" }));

    const form = screen.getByRole("form", { name: "Cancel order #der_1?" });
    expect(within(form).getByText(/nothing to refund/)).toBeInTheDocument();
    await user.click(within(form).getByRole("radio", { name: "I changed my mind" }));
    await user.click(within(form).getByRole("button", { name: "Cancel order" }));

    expect(actions.cancelOrder).toHaveBeenCalledWith({ orderId: "order_1", reason: "CHANGED_MIND", note: undefined });
    expect(await screen.findByRole("status")).toHaveTextContent("Order #der_1 is cancelled.");
  });

  it("says which items stay, and why", async () => {
    const user = userEvent.setup();
    show(
      order({
        cancelsWholeOrder: false,
        items: [
          item(),
          item({ id: "item_2", title: "Grammar E-book", fulfillmentType: "DIGITAL", includesEbook: true, cancelBlock: "EBOOK_DOWNLOADED" }),
        ],
      })
    );
    await user.click(screen.getByRole("button", { name: "Cancel order" }));
    expect(screen.getByText("Stays in your order")).toBeInTheDocument();
    expect(screen.getByText(/Its e-book has been downloaded/)).toBeInTheDocument();
  });

  it("shows the error and stays open when the server refuses", async () => {
    actions.cancelOrder.mockResolvedValueOnce({ ok: false, error: "This order can no longer be cancelled." });
    const user = userEvent.setup();
    show(order());
    await user.click(screen.getByRole("button", { name: "Cancel order" }));
    await user.click(screen.getByRole("radio", { name: "I ordered it by mistake" }));
    await user.click(within(screen.getByRole("form")).getByRole("button", { name: "Cancel order" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This order can no longer be cancelled.");
  });
});

describe("Return order", () => {
  const delivered = () =>
    order({
      status: "PROCESSING",
      shipmentStatus: "DELIVERED",
      canCancel: false,
      canReturn: true,
      returnWindowEndsAt: "2026-11-20T04:00:00.000Z",
      items: [item({ quantity: 3, returnableQuantity: 3, cancelBlock: "SHIPPED", returnBlock: null })],
    });

  it("shows once the parcel is delivered", () => {
    show(delivered());
    expect(screen.getByRole("button", { name: "Return order" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel order" })).not.toBeInTheDocument();
    expect(screen.getByText(/until 20 Nov 2026/)).toBeInTheDocument();
  });

  it("won't send printed items without the unopened-packaging confirmation", async () => {
    const user = userEvent.setup();
    show(delivered());
    await user.click(screen.getByRole("button", { name: "Return order" }));
    await user.click(screen.getByRole("radio", { name: "I no longer need it" }));
    await user.selectOptions(screen.getByRole("combobox"), "2");
    expect(screen.getByText(/Refund once we've received it: ₹1,000/)).toBeInTheDocument();

    // The browser's own required-checkbox check stops the first submit.
    const unopened = screen.getByRole("checkbox", { name: /unopened packaging/ });
    expect(unopened).toBeRequired();
    await user.click(unopened);
    await user.click(screen.getByRole("button", { name: "Request return" }));

    expect(actions.requestReturn).toHaveBeenCalledWith({
      orderId: "order_1",
      reason: "NOT_NEEDED",
      note: undefined,
      packagingUnopened: true,
      items: [{ lineId: "item_1", quantity: 2 }],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Return requested.");
  });

  it("lists what's under way instead of offering another return", () => {
    show(
      order({
        ...delivered(),
        canReturn: false,
        returns: [
          {
            id: "r1",
            status: "APPROVED",
            createdAt: "2026-11-05T04:00:00.000Z",
            decidedAt: "2026-11-06T04:00:00.000Z",
            completedAt: null,
            reasonLabel: "I no longer need it",
            note: null,
            staffNote: "Our courier collects on Tuesday.",
            refundCents: 50_000,
            refundedAt: null,
            items: [{ orderItemId: "item_1", quantity: 1 }],
          },
        ],
      })
    );
    expect(screen.queryByRole("button", { name: "Return order" })).not.toBeInTheDocument();
    const history = screen.getByRole("region", { name: "Cancellations and returns" });
    expect(within(history).getByText("Return approved")).toBeInTheDocument();
    expect(within(history).getByText(/Our courier collects on Tuesday/)).toBeInTheDocument();
  });
});
