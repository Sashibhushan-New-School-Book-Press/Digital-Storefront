import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@repo/database";
import { resetTestDatabase, testDatabaseUrl } from "@repo/database/testing";

// Staff handling customers' returns and refunds on the Sales Orders page
// (app/supply/sales-orders/return-actions.ts) against a real database: the
// steps, stock coming back, the refund ledger and the audit trail. The staff
// session, email and Next's request scope are stubbed.

const staff = vi.hoisted(() => ({ current: null as null | { id: string; email: string; role: string } }));
const emails = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@repo/auth/server", () => ({ getCurrentStaff: async () => staff.current }));
vi.mock("@repo/email", () => ({
  sendReturnUpdate: vi.fn(async (params: Record<string, unknown>) => {
    emails.push(params);
    return { error: null };
  }),
}));
vi.mock("@/lib/storefront-cache", () => ({ revalidateStorefront: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));
vi.mock("next/server", () => ({ after: (task: () => Promise<void>) => void task() }));

const { decideReturn, markRefundSent } = await import("@/app/supply/sales-orders/return-actions");

const support = { id: randomUUID(), email: "support@example.test", role: "SUPPORT" };

async function deliveredOrderWithReturn(options: { method?: "COD" | "UPI"; quantity?: number } = {}) {
  const customer = await prisma.user.create({ data: { id: randomUUID(), email: `reader-${randomUUID()}@example.test` } });
  const book = await prisma.product.create({
    data: {
      type: "PHYSICAL_BOOK",
      productLine: "BOOK",
      title: "Returned Book",
      author: "A. Writer",
      slug: `returned-${randomUUID()}`,
      priceCents: 49_900,
      editions: { create: [{ format: "PAPERBACK", priceCents: 49_900, stockQty: 2 }] },
    },
  });
  const quantity = options.quantity ?? 2;
  const order = await prisma.order.create({
    data: {
      userId: customer.id,
      status: options.method === "UPI" ? "PAID" : "PROCESSING",
      shipmentStatus: "DELIVERED",
      deliveredAt: new Date(),
      subtotalCents: 49_900 * quantity,
      totalCents: 49_900 * quantity,
      items: {
        create: [{ productId: book.id, quantity, unitPriceCents: 49_900, fulfillmentType: "SHIP", bookFormat: "PAPERBACK" }],
      },
      payment: {
        create: {
          amountCents: 49_900 * quantity,
          method: options.method ?? "COD",
          status: options.method === "UPI" ? "CAPTURED" : "CREATED",
        },
      },
    },
    include: { items: true },
  });
  const orderReturn = await prisma.orderReturn.create({
    data: {
      orderId: order.id,
      reason: "NOT_NEEDED",
      packagingUnopened: true,
      refundCents: 49_900,
      items: { create: [{ orderItemId: order.items[0]!.id, quantity: 1 }] },
    },
  });
  return { order, orderReturn, book };
}

const paperbackStock = async (productId: string) =>
  (await prisma.bookEdition.findUniqueOrThrow({ where: { productId_format: { productId, format: "PAPERBACK" } } }))
    .stockQty;

describe.skipIf(!testDatabaseUrl())("return and refund actions", () => {
  beforeEach(async () => {
    await resetTestDatabase(prisma);
    staff.current = support;
    emails.length = 0;
  });
  afterAll(() => prisma.$disconnect());

  it("walks a return from approval to received, restocking only then", async () => {
    const { orderReturn, book, order } = await deliveredOrderWithReturn();

    expect(
      await decideReturn({ returnId: orderReturn.id, from: "REQUESTED", decision: "approve", staffNote: "Our courier collects on Tuesday." })
    ).toEqual({ ok: true });
    expect(await prisma.orderReturn.findUniqueOrThrow({ where: { id: orderReturn.id } })).toMatchObject({
      status: "APPROVED",
      staffNote: "Our courier collects on Tuesday.",
    });
    expect(await paperbackStock(book.id)).toBe(2);

    expect(await decideReturn({ returnId: orderReturn.id, from: "APPROVED", decision: "receive" })).toEqual({ ok: true });
    const completed = await prisma.orderReturn.findUniqueOrThrow({ where: { id: orderReturn.id } });
    expect(completed).toMatchObject({ status: "COMPLETED", staffNote: "Our courier collects on Tuesday." });
    expect(completed.completedAt).not.toBeNull();
    expect(await paperbackStock(book.id)).toBe(3);

    // A stale screen can't receive it twice.
    expect(await decideReturn({ returnId: orderReturn.id, from: "APPROVED", decision: "receive" })).toMatchObject({ ok: false });
    expect(await paperbackStock(book.id)).toBe(3);

    expect(emails.map((email) => email.stage)).toEqual(["approved", "completed"]);
    expect(await prisma.auditLog.findMany({ where: { entityId: order.id }, orderBy: { createdAt: "asc" } })).toMatchObject([
      { action: "sales_order.return_approved", actorId: support.id },
      { action: "sales_order.return_completed", actorId: support.id },
    ]);
  });

  it("needs a reason to reject, and tells the customer it", async () => {
    const { orderReturn } = await deliveredOrderWithReturn();
    expect(await decideReturn({ returnId: orderReturn.id, from: "REQUESTED", decision: "reject" })).toMatchObject({ ok: false });
    expect(
      await decideReturn({ returnId: orderReturn.id, from: "REQUESTED", decision: "reject", staffNote: "The seal was broken." })
    ).toEqual({ ok: true });
    expect(await prisma.orderReturn.findUniqueOrThrow({ where: { id: orderReturn.id } })).toMatchObject({ status: "REJECTED" });
    expect(emails).toEqual([expect.objectContaining({ stage: "rejected", staffNote: "The seal was broken." })]);
  });

  it("records a refund as sent once, and only once it's owed", async () => {
    const { orderReturn } = await deliveredOrderWithReturn({ method: "UPI" });
    expect(await markRefundSent({ kind: "return", id: orderReturn.id })).toMatchObject({ ok: false });

    await decideReturn({ returnId: orderReturn.id, from: "REQUESTED", decision: "approve" });
    await decideReturn({ returnId: orderReturn.id, from: "APPROVED", decision: "receive" });
    expect(await markRefundSent({ kind: "return", id: orderReturn.id })).toEqual({ ok: true });
    expect((await prisma.orderReturn.findUniqueOrThrow({ where: { id: orderReturn.id } })).refundedAt).not.toBeNull();
    expect(await markRefundSent({ kind: "return", id: orderReturn.id })).toMatchObject({ ok: false });
  });

  it("marks a wholly cancelled online order refunded once its refund is sent", async () => {
    const { order } = await deliveredOrderWithReturn({ method: "UPI" });
    await prisma.order.update({ where: { id: order.id }, data: { status: "CANCELLED", shipmentStatus: "CANCELLED" } });
    const cancellation = await prisma.orderCancellation.create({
      data: { orderId: order.id, reason: "CHANGED_MIND", refundCents: order.totalCents },
    });

    expect(await markRefundSent({ kind: "cancellation", id: cancellation.id })).toEqual({ ok: true });

    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payment: true } })).toMatchObject({
      status: "REFUNDED",
      payment: { status: "REFUNDED" },
    });
  });

  it("completes a return of only an undownloaded e-book on approval, with nothing to restock", async () => {
    const customer = await prisma.user.create({ data: { id: randomUUID(), email: `reader-${randomUUID()}@example.test` } });
    const ebook = await prisma.product.create({
      data: { type: "EBOOK", productLine: "BOOK", title: "Returned E-book", author: "A. Writer", slug: `ebook-${randomUUID()}`, priceCents: 19_900 },
    });
    const order = await prisma.order.create({
      data: {
        userId: customer.id,
        status: "PAID",
        shipmentStatus: "DELIVERED",
        deliveredAt: new Date(),
        subtotalCents: 19_900,
        totalCents: 19_900,
        items: {
          create: [{ productId: ebook.id, quantity: 1, unitPriceCents: 19_900, fulfillmentType: "DIGITAL", bookFormat: "EBOOK", includesEbook: true }],
        },
        payment: { create: { amountCents: 19_900, method: "UPI", status: "CAPTURED" } },
      },
      include: { items: true },
    });
    const orderReturn = await prisma.orderReturn.create({
      data: { orderId: order.id, reason: "WRONG_ITEM", refundCents: 19_900, items: { create: [{ orderItemId: order.items[0]!.id, quantity: 1 }] } },
    });

    expect(await decideReturn({ returnId: orderReturn.id, from: "REQUESTED", decision: "approve" })).toEqual({ ok: true });

    const completed = await prisma.orderReturn.findUniqueOrThrow({ where: { id: orderReturn.id } });
    expect(completed).toMatchObject({ status: "COMPLETED" });
    expect(completed.decidedAt).not.toBeNull();
    expect(completed.completedAt).not.toBeNull();
    expect(emails).toEqual([expect.objectContaining({ stage: "completed", refundCents: 19_900, cashOnDelivery: false })]);
    // Owed straight away.
    expect(await markRefundSent({ kind: "return", id: orderReturn.id })).toEqual({ ok: true });
  });

  it("rejects a parcel that came back opened, without restocking it", async () => {
    const { orderReturn, book } = await deliveredOrderWithReturn();
    await decideReturn({ returnId: orderReturn.id, from: "REQUESTED", decision: "approve", staffNote: "Post it to us." });

    expect(
      await decideReturn({ returnId: orderReturn.id, from: "APPROVED", decision: "reject", staffNote: "The seal was broken." })
    ).toEqual({ ok: true });

    expect(await prisma.orderReturn.findUniqueOrThrow({ where: { id: orderReturn.id } })).toMatchObject({
      status: "REJECTED",
      staffNote: "The seal was broken.",
    });
    expect(await paperbackStock(book.id)).toBe(2);
    expect(await markRefundSent({ kind: "return", id: orderReturn.id })).toMatchObject({ ok: false });
    expect(emails.map((email) => email.stage)).toEqual(["approved", "rejected"]);
  });

  it("offers only the step that comes next", async () => {
    const { orderReturn, book } = await deliveredOrderWithReturn();
    const unavailable = { ok: false, error: "That step isn't available for this return." };

    expect(await decideReturn({ returnId: orderReturn.id, from: "REQUESTED", decision: "receive" })).toEqual(unavailable);
    await decideReturn({ returnId: orderReturn.id, from: "REQUESTED", decision: "approve" });
    expect(await decideReturn({ returnId: orderReturn.id, from: "APPROVED", decision: "approve" })).toEqual(unavailable);
    // What a stale screen still shows: the return has moved on, nothing changes.
    expect(await decideReturn({ returnId: orderReturn.id, from: "REQUESTED", decision: "reject", staffNote: "Too late." })).toMatchObject({
      ok: false,
    });
    expect(await prisma.orderReturn.findUniqueOrThrow({ where: { id: orderReturn.id } })).toMatchObject({ status: "APPROVED" });
    expect(await paperbackStock(book.id)).toBe(2);
    expect(await decideReturn({ returnId: "no_such_return", from: "REQUESTED", decision: "approve" })).toEqual({
      ok: false,
      error: "This return no longer exists.",
    });
  });

  it("refuses an over-long message and a malformed id", async () => {
    const { orderReturn } = await deliveredOrderWithReturn();
    expect(
      await decideReturn({ returnId: orderReturn.id, from: "REQUESTED", decision: "approve", staffNote: "x".repeat(501) })
    ).toEqual({ ok: false, error: "Please keep the message under 500 characters." });
    expect(await decideReturn({ returnId: "../etc/passwd", from: "REQUESTED", decision: "approve" })).toMatchObject({ ok: false });
    expect(await markRefundSent({ kind: "return", id: "' OR 1=1 --" })).toMatchObject({ ok: false });
    expect(await prisma.orderReturn.findUniqueOrThrow({ where: { id: orderReturn.id } })).toMatchObject({ status: "REQUESTED" });
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("receives a parcel once when two staff click together", async () => {
    const { orderReturn, book } = await deliveredOrderWithReturn();
    await decideReturn({ returnId: orderReturn.id, from: "REQUESTED", decision: "approve" });

    const results = await Promise.all([
      decideReturn({ returnId: orderReturn.id, from: "APPROVED", decision: "receive" }),
      decideReturn({ returnId: orderReturn.id, from: "APPROVED", decision: "receive" }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await paperbackStock(book.id)).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: "sales_order.return_completed" } })).toBe(1);
  });

  it("records a refund once when two staff tick it together", async () => {
    const { order } = await deliveredOrderWithReturn({ method: "UPI" });
    const cancellation = await prisma.orderCancellation.create({
      data: { orderId: order.id, reason: "CHANGED_MIND", refundCents: 10_000 },
    });

    const results = await Promise.all([
      markRefundSent({ kind: "cancellation", id: cancellation.id }),
      markRefundSent({ kind: "cancellation", id: cancellation.id }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: "sales_order.refund_sent" } })).toBe(1);
  });

  it("leaves a partly cancelled order as it is once its refund is sent", async () => {
    const { order } = await deliveredOrderWithReturn({ method: "UPI" });
    const cancellation = await prisma.orderCancellation.create({
      data: { orderId: order.id, reason: "CHANGED_MIND", refundCents: 10_000 },
    });

    expect(await markRefundSent({ kind: "cancellation", id: cancellation.id })).toEqual({ ok: true });

    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payment: true } })).toMatchObject({
      status: "PAID",
      payment: { status: "CAPTURED" },
    });
  });

  it("has nothing to send for a cash-on-delivery cancellation", async () => {
    const { order } = await deliveredOrderWithReturn();
    const cancellation = await prisma.orderCancellation.create({
      data: { orderId: order.id, reason: "CHANGED_MIND", refundCents: 0 },
    });
    expect(await markRefundSent({ kind: "cancellation", id: cancellation.id })).toEqual({
      ok: false,
      error: "There's no refund waiting to be sent for this.",
    });
  });

  it("is staff-only", async () => {
    const { orderReturn } = await deliveredOrderWithReturn();
    staff.current = { id: randomUUID(), email: "reader@example.test", role: "READER" };
    await expect(decideReturn({ returnId: orderReturn.id, from: "REQUESTED", decision: "approve" })).rejects.toThrow(/Forbidden/);
    await expect(markRefundSent({ kind: "return", id: orderReturn.id })).rejects.toThrow(/Forbidden/);
  });
});
