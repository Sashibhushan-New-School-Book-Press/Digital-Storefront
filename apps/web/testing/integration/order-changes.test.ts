import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type OrderStatus, type PaymentStatus, type ShipmentStatus } from "@repo/database";
import { resetTestDatabase, testDatabaseUrl } from "@repo/database/testing";
import { createBook, createCustomer } from "./support/fixtures";

// "Cancel order" / "Return order" on My Orders (app/(account)/account/orders/
// actions.ts) against a real database: who may, what the order becomes,
// stock, e-book access and the refund worked out. The session, email and
// Next's request scope are stubbed.

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
const sent = vi.hoisted(() => [] as { kind: string; params: Record<string, unknown> }[]);
vi.mock("@repo/auth/server", () => ({ getCurrentUser: async () => session.user }));
vi.mock("@repo/email", () => ({
  sendOrderCancelled: vi.fn(async (params: Record<string, unknown>) => {
    sent.push({ kind: "cancelled", params });
    return { error: null };
  }),
  sendReturnUpdate: vi.fn(async (params: Record<string, unknown>) => {
    sent.push({ kind: "return", params });
    return { error: null };
  }),
}));
vi.mock("@repo/security/rate-limit", () => ({ RATE_LIMITS: { accountWrite: {} }, rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/policies", () => ({ getPolicyDetails: async () => ({ returnWindowDays: 7 }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: (task: () => Promise<void>) => void task() }));

const { cancelOrder, requestReturn } = await import("@/app/(account)/account/orders/actions");
const { entitledAssetsWhere, ownsEbook } = await import("@/lib/library");

type Line = { kind: "paperback" | "ebook"; quantity?: number };

/** A placed order for `customer`: printed copies of `book`, and/or its e-book. */
async function placedOrder(
  customer: { id: string },
  book: { id: string },
  options: {
    lines?: Line[];
    status?: OrderStatus;
    shipmentStatus?: ShipmentStatus | null;
    paymentStatus?: PaymentStatus;
    method?: "COD" | "UPI";
    deliveredAt?: Date | null;
  } = {}
) {
  const lines = options.lines ?? [{ kind: "paperback" }];
  const items = lines.map((line) =>
    line.kind === "paperback"
      ? { productId: book.id, quantity: line.quantity ?? 1, unitPriceCents: 49_900, fulfillmentType: "SHIP" as const, bookFormat: "PAPERBACK" as const }
      : { productId: book.id, quantity: 1, unitPriceCents: 19_900, fulfillmentType: "DIGITAL" as const, bookFormat: "EBOOK" as const, includesEbook: true }
  );
  const subtotalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  return prisma.order.create({
    data: {
      userId: customer.id,
      status: options.status ?? "PROCESSING",
      shipmentStatus: options.shipmentStatus === undefined ? "AWAITING_APPROVAL" : options.shipmentStatus,
      deliveredAt: options.deliveredAt ?? null,
      subtotalCents,
      totalCents: subtotalCents,
      items: { create: items },
      payment: {
        create: { amountCents: subtotalCents, method: options.method ?? "COD", status: options.paymentStatus ?? "CREATED" },
      },
    },
    include: { items: true },
  });
}

const paperbackStock = async (productId: string) =>
  (await prisma.bookEdition.findUniqueOrThrow({ where: { productId_format: { productId, format: "PAPERBACK" } } }))
    .stockQty;

async function ebookFile(productId: string) {
  return prisma.fileAsset.create({
    data: { kind: "EBOOK_FILE", blobPath: "ebooks/x.pdf", fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 1, malwareScanStatus: "CLEAN", productId },
  });
}

describe.skipIf(!testDatabaseUrl())("cancelling and returning orders", () => {
  let customer: { id: string; email: string };
  let book: { id: string };

  beforeEach(async () => {
    await resetTestDatabase(prisma);
    sent.length = 0;
    customer = await createCustomer();
    book = await createBook({ paperback: 5 });
    session.user = { id: customer.id, email: customer.email };
  });
  afterAll(() => prisma.$disconnect());

  describe("cancelOrder", () => {
    it("calls off an unshipped cash-on-delivery order and puts its copies back", async () => {
      const order = await placedOrder(customer, book, { lines: [{ kind: "paperback", quantity: 2 }], shipmentStatus: "PROCESSING" });

      expect(await cancelOrder({ orderId: order.id, reason: "CHANGED_MIND" })).toEqual({ ok: true });

      expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
        status: "CANCELLED",
        shipmentStatus: "CANCELLED",
      });
      expect(await paperbackStock(book.id)).toBe(7);
      const [cancellation] = await prisma.orderCancellation.findMany({ include: { items: true } });
      expect(cancellation).toMatchObject({ reason: "CHANGED_MIND", refundCents: 0 });
      expect(cancellation!.items.map((item) => item.id)).toEqual([order.items[0]!.id]);
      expect(sent).toEqual([{ kind: "cancelled", params: expect.objectContaining({ partial: false, refundCents: 0 }) }]);
    });

    it("refuses once the parcel has shipped", async () => {
      const order = await placedOrder(customer, book, { shipmentStatus: "SHIPPED" });
      expect(await cancelOrder({ orderId: order.id, reason: "CHANGED_MIND" })).toMatchObject({ ok: false });
      expect(await prisma.orderCancellation.count()).toBe(0);
      expect(await paperbackStock(book.id)).toBe(5);
    });

    it("never touches another customer's order", async () => {
      const someoneElse = await createCustomer();
      const order = await placedOrder(someoneElse, book);
      expect(await cancelOrder({ orderId: order.id, reason: "CHANGED_MIND" })).toMatchObject({ ok: false });
      expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "PROCESSING" });
    });

    it("refunds an undownloaded e-book paid online and takes it out of the library", async () => {
      const order = await placedOrder(customer, book, {
        lines: [{ kind: "ebook" }],
        status: "PAID",
        shipmentStatus: null,
        paymentStatus: "CAPTURED",
        method: "UPI",
      });
      await ebookFile(book.id);
      expect(await prisma.fileAsset.count({ where: entitledAssetsWhere(customer.id) })).toBe(1);

      expect(await cancelOrder({ orderId: order.id, reason: "ORDERED_BY_MISTAKE" })).toEqual({ ok: true });

      expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "CANCELLED" });
      expect(await prisma.orderCancellation.findFirstOrThrow()).toMatchObject({ refundCents: 19_900 });
      expect(await prisma.fileAsset.count({ where: entitledAssetsWhere(customer.id) })).toBe(0);
    });

    it("keeps a downloaded e-book and cancels only the parcel beside it", async () => {
      const order = await placedOrder(customer, book, {
        lines: [{ kind: "paperback" }, { kind: "ebook" }],
        status: "PAID",
        paymentStatus: "CAPTURED",
        method: "UPI",
      });
      const file = await ebookFile(book.id);
      await prisma.libraryDownload.create({ data: { userId: customer.id, fileAssetId: file.id, count: 1 } });

      expect(await cancelOrder({ orderId: order.id, reason: "TOO_SLOW" })).toEqual({ ok: true });

      expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
        status: "PAID",
        shipmentStatus: "CANCELLED",
      });
      expect(await prisma.orderCancellation.findFirstOrThrow()).toMatchObject({ refundCents: 49_900 });
      expect(await prisma.fileAsset.count({ where: entitledAssetsWhere(customer.id) })).toBe(1);
    });

    it("cancels once, however many times it's clicked", async () => {
      const order = await placedOrder(customer, book);
      const results = await Promise.all([
        cancelOrder({ orderId: order.id, reason: "CHANGED_MIND" }),
        cancelOrder({ orderId: order.id, reason: "CHANGED_MIND" }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(await prisma.orderCancellation.count()).toBe(1);
      expect(await paperbackStock(book.id)).toBe(6);
    });
  });

  describe("requestReturn", () => {
    const deliveredYesterday = () => new Date(Date.now() - 86_400_000);

    it("opens a return for delivered copies in unopened packaging", async () => {
      const order = await placedOrder(customer, book, {
        lines: [{ kind: "paperback", quantity: 3 }],
        status: "PROCESSING",
        shipmentStatus: "DELIVERED",
        deliveredAt: deliveredYesterday(),
      });
      const request = {
        orderId: order.id,
        reason: "NOT_NEEDED" as const,
        packagingUnopened: true,
        items: [{ lineId: order.items[0]!.id, quantity: 2 }],
      };

      expect(await requestReturn({ ...request, packagingUnopened: false })).toMatchObject({ ok: false });
      expect(await requestReturn(request)).toEqual({ ok: true });

      const orderReturn = await prisma.orderReturn.findFirstOrThrow({ include: { items: true } });
      expect(orderReturn).toMatchObject({ status: "REQUESTED", packagingUnopened: true, refundCents: 2 * 49_900 });
      expect(orderReturn.items).toMatchObject([{ orderItemId: order.items[0]!.id, quantity: 2 }]);
      // Stock only comes back when staff receive the parcel.
      expect(await paperbackStock(book.id)).toBe(5);
      // One return at a time.
      expect(await requestReturn({ ...request, items: [{ lineId: order.items[0]!.id, quantity: 1 }] })).toMatchObject({
        ok: false,
      });
      expect(sent).toEqual([{ kind: "return", params: expect.objectContaining({ stage: "requested", cashOnDelivery: true }) }]);
    });

    it("isn't open before delivery or after the window", async () => {
      const onTheWay = await placedOrder(customer, book, { shipmentStatus: "OUT_FOR_DELIVERY" });
      const late = await placedOrder(customer, book, {
        shipmentStatus: "DELIVERED",
        deliveredAt: new Date(Date.now() - 8 * 86_400_000),
      });
      for (const order of [onTheWay, late]) {
        const result = await requestReturn({
          orderId: order.id,
          reason: "NOT_NEEDED",
          packagingUnopened: true,
          items: [{ lineId: order.items[0]!.id, quantity: 1 }],
        });
        expect(result).toMatchObject({ ok: false });
      }
      expect(await prisma.orderReturn.count()).toBe(0);
    });

    it("pauses an e-book that's being returned with its parcel", async () => {
      const order = await placedOrder(customer, book, {
        lines: [{ kind: "paperback" }, { kind: "ebook" }],
        status: "PAID",
        shipmentStatus: "DELIVERED",
        deliveredAt: deliveredYesterday(),
        paymentStatus: "CAPTURED",
        method: "UPI",
      });
      await ebookFile(book.id);
      const ebookLine = order.items.find((item) => item.includesEbook)!;

      expect(
        await requestReturn({ orderId: order.id, reason: "DAMAGED", packagingUnopened: false, items: [{ lineId: ebookLine.id, quantity: 1 }] })
      ).toEqual({ ok: true });
      expect(await prisma.fileAsset.count({ where: entitledAssetsWhere(customer.id) })).toBe(0);

      // Rejected: the e-book is the customer's again.
      await prisma.orderReturn.updateMany({ data: { status: "REJECTED" } });
      expect(await prisma.fileAsset.count({ where: entitledAssetsWhere(customer.id) })).toBe(1);
    });

    it("won't take back a line from a different order", async () => {
      const delivered = { shipmentStatus: "DELIVERED" as const, deliveredAt: deliveredYesterday() };
      const mine = await placedOrder(customer, book, delivered);
      const other = await placedOrder(customer, book, { ...delivered, lines: [{ kind: "paperback", quantity: 3 }] });

      const result = await requestReturn({
        orderId: mine.id,
        reason: "NOT_NEEDED",
        packagingUnopened: true,
        items: [{ lineId: other.items[0]!.id, quantity: 3 }],
      });

      expect(result).toEqual({ ok: false, error: "One of those items isn't in this order." });
      expect(await prisma.orderReturn.count()).toBe(0);
    });

    it("never opens a return on another customer's order", async () => {
      const someoneElse = await createCustomer();
      const order = await placedOrder(someoneElse, book, { shipmentStatus: "DELIVERED", deliveredAt: deliveredYesterday() });
      const result = await requestReturn({
        orderId: order.id,
        reason: "NOT_NEEDED",
        packagingUnopened: true,
        items: [{ lineId: order.items[0]!.id, quantity: 1 }],
      });
      expect(result).toEqual({ ok: false, error: "We couldn't find that order." });
      expect(await prisma.orderReturn.count()).toBe(0);
    });

    it("asks for a note when the reason is 'Another reason'", async () => {
      const order = await placedOrder(customer, book, { shipmentStatus: "DELIVERED", deliveredAt: deliveredYesterday() });
      const request = {
        orderId: order.id,
        reason: "OTHER" as const,
        packagingUnopened: true,
        items: [{ lineId: order.items[0]!.id, quantity: 1 }],
      };

      expect(await requestReturn({ ...request, note: "   " })).toEqual({
        ok: false,
        error: "Tell us a little about why you're returning it.",
      });
      expect(await requestReturn({ ...request, note: "It was a gift I already had." })).toEqual({ ok: true });
      expect(await prisma.orderReturn.findFirstOrThrow()).toMatchObject({ reason: "OTHER", note: "It was a gift I already had." });
    });

    it("won't take back an e-book that's been downloaded", async () => {
      const order = await placedOrder(customer, book, {
        lines: [{ kind: "paperback" }, { kind: "ebook" }],
        status: "PAID",
        shipmentStatus: "DELIVERED",
        deliveredAt: deliveredYesterday(),
        paymentStatus: "CAPTURED",
        method: "UPI",
      });
      const file = await ebookFile(book.id);
      await prisma.libraryDownload.create({ data: { userId: customer.id, fileAssetId: file.id, count: 1 } });
      const ebookLine = order.items.find((item) => item.includesEbook)!;

      const result = await requestReturn({
        orderId: order.id,
        reason: "WRONG_ITEM",
        packagingUnopened: false,
        items: [{ lineId: ebookLine.id, quantity: 1 }],
      });

      expect(result).toEqual({ ok: false, error: "Its e-book has been downloaded, so it can't be cancelled or returned." });
      expect(await prisma.orderReturn.count()).toBe(0);
      expect(await prisma.fileAsset.count({ where: entitledAssetsWhere(customer.id) })).toBe(1);
    });

    it("refunds the delivery charge with a parcel that arrived damaged", async () => {
      const order = await placedOrder(customer, book, {
        lines: [{ kind: "paperback", quantity: 2 }],
        status: "PAID",
        shipmentStatus: "DELIVERED",
        deliveredAt: deliveredYesterday(),
        paymentStatus: "CAPTURED",
        method: "UPI",
      });
      await prisma.order.update({ where: { id: order.id }, data: { shippingCents: 4_900, totalCents: 2 * 49_900 + 4_900 } });

      expect(
        await requestReturn({
          orderId: order.id,
          reason: "DAMAGED",
          packagingUnopened: true,
          items: [{ lineId: order.items[0]!.id, quantity: 1 }],
        })
      ).toEqual({ ok: true });

      expect(await prisma.orderReturn.findFirstOrThrow()).toMatchObject({ refundCents: 49_900 + 4_900 });
      expect(sent).toEqual([
        { kind: "return", params: expect.objectContaining({ stage: "requested", refundCents: 54_800, cashOnDelivery: false }) },
      ]);
    });

    it("opens one return, however many times it's clicked", async () => {
      const order = await placedOrder(customer, book, {
        lines: [{ kind: "paperback", quantity: 2 }],
        shipmentStatus: "DELIVERED",
        deliveredAt: deliveredYesterday(),
      });
      const request = {
        orderId: order.id,
        reason: "NOT_NEEDED" as const,
        packagingUnopened: true,
        items: [{ lineId: order.items[0]!.id, quantity: 1 }],
      };

      const results = await Promise.all([requestReturn(request), requestReturn(request)]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(await prisma.orderReturn.count()).toBe(1);
    });
  });

  describe("guards", () => {
    it("asks a signed-out visitor to sign in, and changes nothing", async () => {
      const order = await placedOrder(customer, book, { shipmentStatus: "DELIVERED", deliveredAt: new Date() });
      session.user = null;

      expect(await cancelOrder({ orderId: order.id, reason: "CHANGED_MIND" })).toEqual({
        ok: false,
        error: "Please sign in again to cancel this order.",
      });
      expect(
        await requestReturn({
          orderId: order.id,
          reason: "NOT_NEEDED",
          packagingUnopened: true,
          items: [{ lineId: order.items[0]!.id, quantity: 1 }],
        })
      ).toEqual({ ok: false, error: "Please sign in again to return this order." });
      expect(await prisma.orderCancellation.count()).toBe(0);
      expect(await prisma.orderReturn.count()).toBe(0);
    });

    it("refuses malformed input before reading the order", async () => {
      const order = await placedOrder(customer, book);
      const refused = [
        // @ts-expect-error — not a reason the form offers
        cancelOrder({ orderId: order.id, reason: "FREE_STUFF" }),
        cancelOrder({ orderId: `${order.id}' OR '1'='1`, reason: "CHANGED_MIND" }),
        cancelOrder({ orderId: order.id, reason: "OTHER", note: "x".repeat(501) }),
        requestReturn({ orderId: order.id, reason: "NOT_NEEDED", packagingUnopened: true, items: [] }),
        requestReturn({
          orderId: order.id,
          reason: "NOT_NEEDED",
          packagingUnopened: true,
          items: [{ lineId: order.items[0]!.id, quantity: 101 }],
        }),
      ];
      for (const result of await Promise.all(refused)) expect(result).toMatchObject({ ok: false });
      expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
        status: "PROCESSING",
        shipmentStatus: "AWAITING_APPROVAL",
      });
      expect(await prisma.orderCancellation.count()).toBe(0);
    });

    it("lets a cancelled e-book be bought again", async () => {
      const order = await placedOrder(customer, book, {
        lines: [{ kind: "ebook" }],
        status: "PAID",
        shipmentStatus: null,
        paymentStatus: "CAPTURED",
        method: "UPI",
      });
      expect(await ownsEbook(customer.id, [book.id])).toBe(true);

      expect(await cancelOrder({ orderId: order.id, reason: "ORDERED_BY_MISTAKE" })).toEqual({ ok: true });

      expect(await ownsEbook(customer.id, [book.id])).toBe(false);
    });
  });
});
