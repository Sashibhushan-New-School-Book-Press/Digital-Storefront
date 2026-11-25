import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type ShipmentStatus } from "@repo/database";
import { resetTestDatabase, testDatabaseUrl } from "@repo/database/testing";

// Staff moving a parcel on the Sales Orders page (app/supply/sales-orders/
// actions.ts) where the customer has already cancelled part of the order
// from My Orders, against a real database: Deny mustn't restock those copies
// twice, and Delivered starts the return window. The staff session, email and
// Next's request scope are stubbed.

const staff = vi.hoisted(() => ({ current: null as null | { id: string; email: string; role: string } }));
vi.mock("@repo/auth/server", () => ({ getCurrentStaff: async () => staff.current }));
vi.mock("@repo/email", () => ({ sendOrderShipped: vi.fn(async () => ({ error: null })) }));
vi.mock("@/lib/storefront-cache", () => ({ revalidateStorefront: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));
vi.mock("next/server", () => ({ after: (task: () => Promise<void>) => void task() }));

const { moveSalesOrder } = await import("@/app/supply/sales-orders/actions");

const support = { id: randomUUID(), email: "support@example.test", role: "SUPPORT" };

async function book(stockQty: number) {
  return prisma.product.create({
    data: {
      type: "PHYSICAL_BOOK",
      productLine: "BOOK",
      title: "Sales Order Book",
      author: "A. Writer",
      slug: `sales-order-${randomUUID()}`,
      priceCents: 49_900,
      editions: { create: [{ format: "PAPERBACK", priceCents: 49_900, stockQty }] },
    },
  });
}

type Line = { kind: "paperback" | "bundle" | "ebook"; quantity?: number; cancelled?: boolean };

/** An online order for one book, some of whose lines the customer has already cancelled. */
async function order(productId: string, lines: Line[], shipmentStatus: ShipmentStatus = "AWAITING_APPROVAL") {
  const customer = await prisma.user.create({ data: { id: randomUUID(), email: `reader-${randomUUID()}@example.test` } });
  const created = await prisma.order.create({
    data: {
      userId: customer.id,
      status: "PAID",
      shipmentStatus,
      subtotalCents: 0,
      totalCents: 0,
      items: {
        create: lines.map((line) => ({
          productId,
          quantity: line.quantity ?? 1,
          unitPriceCents: 49_900,
          fulfillmentType: line.kind === "ebook" ? ("DIGITAL" as const) : ("SHIP" as const),
          bookFormat: line.kind === "ebook" ? ("EBOOK" as const) : ("PAPERBACK" as const),
          includesEbook: line.kind !== "paperback",
        })),
      },
      payment: { create: { amountCents: 0, method: "UPI", status: "CAPTURED" } },
    },
    include: { items: true },
  });
  const cancelled = created.items.filter((_, index) => lines[index]!.cancelled);
  if (cancelled.length) {
    const cancellation = await prisma.orderCancellation.create({
      data: { orderId: created.id, reason: "CHANGED_MIND", refundCents: 0 },
    });
    await prisma.orderItem.updateMany({
      where: { id: { in: cancelled.map((item) => item.id) } },
      data: { cancellationId: cancellation.id },
    });
  }
  return created;
}

const paperbackStock = async (productId: string) =>
  (await prisma.bookEdition.findUniqueOrThrow({ where: { productId_format: { productId, format: "PAPERBACK" } } }))
    .stockQty;

describe.skipIf(!testDatabaseUrl())("moving a sales order the customer has partly cancelled", () => {
  beforeEach(async () => {
    await resetTestDatabase(prisma);
    staff.current = support;
  });
  afterAll(() => prisma.$disconnect());

  it("restocks on Deny only the copies the customer didn't already cancel", async () => {
    // The customer's cancellation already put their paperback back on the shelf.
    const product = await book(5);
    const placed = await order(product.id, [
      { kind: "paperback", quantity: 1, cancelled: true },
      { kind: "bundle", quantity: 2 },
    ]);

    expect(await moveSalesOrder({ orderId: placed.id, from: "AWAITING_APPROVAL", move: "deny" })).toEqual({ ok: true });

    expect(await paperbackStock(product.id)).toBe(7);
    // The bundle's e-book is still delivered online, so only the parcel is cancelled.
    expect(await prisma.order.findUniqueOrThrow({ where: { id: placed.id } })).toMatchObject({
      status: "PAID",
      shipmentStatus: "CANCELLED",
    });
  });

  it("restocks once when the customer cancels just as staff deny", async () => {
    const product = await book(5);
    const placed = await order(product.id, [{ kind: "paperback" }, { kind: "bundle", quantity: 2 }]);
    // The customer's "Cancel order" commits after Deny has read the order but
    // before it writes: their paperback is cancelled and put back on the shelf.
    // (The bundle's e-book was downloaded, so the parcel stays for it.)
    // (Overridden by hand: vi.spyOn can't restore a method on Prisma 7's client.)
    const client = prisma as unknown as Record<"$transaction", (...args: unknown[]) => Promise<unknown>>;
    const transaction = client.$transaction.bind(prisma);
    client.$transaction = async (...args) => {
      delete (client as Partial<typeof client>).$transaction;
      const cancellation = await prisma.orderCancellation.create({ data: { orderId: placed.id, reason: "CHANGED_MIND" } });
      await prisma.orderItem.update({ where: { id: placed.items[0]!.id }, data: { cancellationId: cancellation.id } });
      await prisma.bookEdition.update({
        where: { productId_format: { productId: product.id, format: "PAPERBACK" } },
        data: { stockQty: { increment: 1 } },
      });
      return transaction(...args);
    };

    try {
      expect(await moveSalesOrder({ orderId: placed.id, from: "AWAITING_APPROVAL", move: "deny" })).toEqual({ ok: true });
    } finally {
      delete (client as Partial<typeof client>).$transaction;
    }
    expect(typeof prisma.$transaction).toBe("function");

    // 5 on the shelf, the customer's paperback back, then the bundle's 2 — not the paperback again.
    expect(await paperbackStock(product.id)).toBe(8);
  });

  it("cancels the whole order on Deny once the customer has cancelled its only e-book", async () => {
    const product = await book(5);
    const placed = await order(product.id, [{ kind: "paperback" }, { kind: "ebook", cancelled: true }]);

    expect(await moveSalesOrder({ orderId: placed.id, from: "AWAITING_APPROVAL", move: "deny" })).toEqual({ ok: true });

    expect(await prisma.order.findUniqueOrThrow({ where: { id: placed.id } })).toMatchObject({
      status: "CANCELLED",
      shipmentStatus: "CANCELLED",
    });
    expect(await paperbackStock(product.id)).toBe(6);
    expect(await prisma.auditLog.findFirstOrThrow()).toMatchObject({
      action: "sales_order.denied",
      diff: { status: { from: "PAID", to: "CANCELLED" } },
    });
  });

  it("starts the return window when the parcel is marked delivered", async () => {
    const product = await book(5);
    const placed = await order(product.id, [{ kind: "paperback" }], "OUT_FOR_DELIVERY");
    const before = Date.now();

    expect(await moveSalesOrder({ orderId: placed.id, from: "OUT_FOR_DELIVERY", move: "advance" })).toEqual({ ok: true });

    const delivered = await prisma.order.findUniqueOrThrow({ where: { id: placed.id } });
    expect(delivered.shipmentStatus).toBe("DELIVERED");
    expect(delivered.deliveredAt?.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(delivered.deliveredAt?.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("leaves deliveredAt alone on every other step", async () => {
    const product = await book(5);
    const placed = await order(product.id, [{ kind: "paperback" }], "PROCESSING");

    await moveSalesOrder({ orderId: placed.id, from: "PROCESSING", move: "advance", carrier: "India Post", trackingNumber: "EE123IN" });

    expect(await prisma.order.findUniqueOrThrow({ where: { id: placed.id } })).toMatchObject({
      shipmentStatus: "SHIPPED",
      deliveredAt: null,
    });
  });
});
