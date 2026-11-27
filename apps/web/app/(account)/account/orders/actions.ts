"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@repo/auth/server";
import {
  CANCEL_REASON_KEYS,
  RETURN_REASON_KEYS,
  checkReturnSelection,
  downloadedEbooksOf,
  planCancellation,
  prisma,
  returnRefundCents,
  returnStock,
  returnsPrintedCopies,
  toOrderFacts,
} from "@repo/database";
import { sendOrderCancelled, sendReturnUpdate } from "@repo/email";
import { securityEvent } from "@repo/security/log";
import { RATE_LIMITS, rateLimit } from "@repo/security/rate-limit";
import { ORDER_CHANGES_INCLUDE, lineLabel } from "@/lib/order-changes";
import { getPolicyDetails } from "@/lib/policies";
import { siteUrl } from "@/lib/site-url";
import { expireReturnedStock } from "@/lib/stock";

/**
 * "Cancel order" and "Return order" on My Orders. The rules — what can
 * still be cancelled or returned, and what it refunds — are `@repo/database`'s
 * returns.ts; these actions re-check them against the order as it is now,
 * never what the browser saw.
 *
 * A cancellation is instant: the lines are marked cancelled, the parcel (if
 * nothing printed is left in it) and the order (if nothing at all is left)
 * become CANCELLED, and the copies go back on the shelf. A return is only a
 * request — staff approve, receive or reject it on apps/admin's Sales Orders
 * page. Either way an e-book in it stops downloading at once (lib/library.ts).
 * There's no refund integration: staff refund by hand, and both apps show
 * what's owed until they tick it off.
 */

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const noteSchema = z.string().trim().max(500, "Please keep the note under 500 characters.").optional();

export type OrderChangeResult = { ok: true } | { ok: false; error: string };

const CHANGED = "This order has just changed. Refresh the page to see where it's got to.";

/** Thrown inside a transaction when the order moved on since it was read, to roll it back. */
class OrderChangedError extends Error {}

const ORDER_INCLUDE = {
  items: { include: { product: { select: { title: true, slug: true, productLine: true, type: true } } } },
  payment: { select: { method: true, status: true } },
  user: { select: { email: true } },
  ...ORDER_CHANGES_INCLUDE,
} as const;

async function loadOwnOrder(orderId: string, userId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, userId }, include: ORDER_INCLUDE });
  if (!order) return null;
  const ebookProducts = order.items.filter((item) => item.includesEbook).map((item) => item.productId);
  const downloaded = await downloadedEbooksOf(prisma, userId, ebookProducts);
  return { order, facts: toOrderFacts(order, downloaded) };
}

/** Throws if any of these e-books was downloaded since the page loaded — that e-book can't go any more. */
async function assertNotDownloaded(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  userId: string,
  productIds: string[]
) {
  if (productIds.length && (await downloadedEbooksOf(tx, userId, productIds)).size) throw new OrderChangedError();
}

// ── Cancel ──────────────────────────────────────────────────────────

const cancelSchema = z.object({
  orderId: idSchema,
  reason: z.enum(CANCEL_REASON_KEYS, { error: "Choose why you're cancelling." }),
  note: noteSchema,
});

export async function cancelOrder(input: z.input<typeof cancelSchema>): Promise<OrderChangeResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Please sign in again to cancel this order." };
  if (!(await rateLimit(RATE_LIMITS.accountWrite, user.id)).ok) {
    return { ok: false, error: "Too many changes in a row — please wait a minute and try again." };
  }
  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That didn't work. Please try again." };
  const { orderId, reason } = parsed.data;
  const note = parsed.data.note || null;

  const loaded = await loadOwnOrder(orderId, user.id);
  if (!loaded) {
    securityEvent("account.order_not_found", { userId: user.id, orderId, action: "cancel" });
    return { ok: false, error: "We couldn't find that order." };
  }
  const { order, facts } = loaded;
  const plan = planCancellation(facts);
  if (!plan) return { ok: false, error: "This order can no longer be cancelled." };

  const lines = order.items.filter((item) => plan.lineIds.includes(item.id));
  const printed = lines.filter((item) => item.fulfillmentType === "SHIP");

  try {
    await prisma.$transaction(async (tx) => {
      // Only while the order is still where the customer saw it — a parcel
      // staff have just sent out can't be cancelled from under them. The
      // write also locks the order, so a double click waits here, then
      // finds the lines already taken below.
      const { count } = await tx.order.updateMany({
        where: { id: orderId, userId: user.id, status: order.status, shipmentStatus: order.shipmentStatus },
        data: {
          updatedAt: new Date(),
          ...(plan.cancelsParcel && { shipmentStatus: "CANCELLED" }),
          ...(plan.cancelsOrder && { status: "CANCELLED" }),
        },
      });
      if (count !== 1) throw new OrderChangedError();

      const cancellation = await tx.orderCancellation.create({
        data: { orderId, reason, note, refundCents: plan.refundCents },
      });
      const marked = await tx.orderItem.updateMany({
        where: { id: { in: plan.lineIds }, orderId, cancellationId: null },
        data: { cancellationId: cancellation.id },
      });
      if (marked.count !== plan.lineIds.length) throw new OrderChangedError();

      await assertNotDownloaded(
        tx,
        user.id,
        lines.filter((item) => item.includesEbook).map((item) => item.productId)
      );
      // Checkout took these copies off the shelf; put them back.
      if (printed.length) {
        await returnStock(
          tx,
          printed.map(({ productId, bookFormat, quantity }) => ({ productId, bookFormat, quantity }))
        );
      }
    });
  } catch (error) {
    if (error instanceof OrderChangedError) return { ok: false, error: CHANGED };
    throw error;
  }

  if (printed.length) expireReturnedStock(printed.map((item) => item.product));
  revalidatePath("/account/orders");
  revalidatePath("/account/library");

  const to = order.user?.email ?? user.email;
  if (to) {
    // After the response, and best-effort: the order is cancelled whether
    // or not the mail goes out, and nothing retries it.
    after(async () => {
      try {
        const { error } = await sendOrderCancelled({
          to,
          orderRef: `#${orderId.slice(-5)}`,
          items: lines.map((item) => lineLabel(item)),
          partial: !plan.cancelsOrder,
          refundCents: plan.refundCents,
          ordersUrl: `${siteUrl()}/account/orders`,
        });
        if (error) console.error("[orders] could not send the cancellation email", error);
      } catch (error) {
        console.error("[orders] could not send the cancellation email", error);
      }
    });
  }
  return { ok: true };
}

// ── Return ──────────────────────────────────────────────────────────

const returnSchema = z.object({
  orderId: idSchema,
  reason: z.enum(RETURN_REASON_KEYS, { error: "Choose why you're returning it." }),
  note: noteSchema,
  packagingUnopened: z.boolean(),
  items: z
    .array(z.object({ lineId: idSchema, quantity: z.number().int().min(1).max(100) }))
    .min(1, "Choose at least one item to return.")
    .max(50),
});

export async function requestReturn(input: z.input<typeof returnSchema>): Promise<OrderChangeResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Please sign in again to return this order." };
  if (!(await rateLimit(RATE_LIMITS.accountWrite, user.id)).ok) {
    return { ok: false, error: "Too many changes in a row — please wait a minute and try again." };
  }
  const parsed = returnSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That didn't work. Please try again." };
  const { orderId, reason, packagingUnopened, items: selection } = parsed.data;
  const note = parsed.data.note || null;
  if (reason === "OTHER" && !note) return { ok: false, error: "Tell us a little about why you're returning it." };

  const [loaded, policy] = await Promise.all([loadOwnOrder(orderId, user.id), getPolicyDetails()]);
  if (!loaded) {
    securityEvent("account.order_not_found", { userId: user.id, orderId, action: "return" });
    return { ok: false, error: "We couldn't find that order." };
  }
  const { order, facts } = loaded;
  const check = checkReturnSelection(facts, selection, new Date(), policy.returnWindowDays);
  if (!check.ok) return check;
  const printed = returnsPrintedCopies(facts, selection);
  if (printed && !packagingUnopened) {
    return { ok: false, error: "Printed items can only be returned in their unopened packaging." };
  }
  const refundCents = returnRefundCents(facts, selection, reason);
  const picked = selection.map((choice) => ({ choice, item: order.items.find((item) => item.id === choice.lineId)! }));

  try {
    await prisma.$transaction(async (tx) => {
      // Locks the order, so two requests can't both open a return.
      const { count } = await tx.order.updateMany({
        where: { id: orderId, userId: user.id, status: order.status, shipmentStatus: "DELIVERED" },
        data: { updatedAt: new Date() },
      });
      if (count !== 1) throw new OrderChangedError();
      const open = await tx.orderReturn.count({ where: { orderId, status: { in: ["REQUESTED", "APPROVED"] } } });
      if (open) throw new OrderChangedError();
      await assertNotDownloaded(
        tx,
        user.id,
        picked.filter(({ item }) => item.includesEbook).map(({ item }) => item.productId)
      );
      await tx.orderReturn.create({
        data: {
          orderId,
          reason,
          note,
          packagingUnopened: printed && packagingUnopened,
          refundCents,
          items: { create: selection.map((choice) => ({ orderItemId: choice.lineId, quantity: choice.quantity })) },
        },
      });
    });
  } catch (error) {
    if (error instanceof OrderChangedError) return { ok: false, error: CHANGED };
    throw error;
  }

  revalidatePath("/account/orders");
  revalidatePath("/account/library");

  const to = order.user?.email ?? user.email;
  if (to) {
    after(async () => {
      try {
        const { error } = await sendReturnUpdate({
          to,
          stage: "requested",
          orderRef: `#${orderId.slice(-5)}`,
          items: picked.map(({ item, choice }) => lineLabel(item, choice.quantity)),
          refundCents,
          cashOnDelivery: order.payment?.method === "COD",
          ordersUrl: `${siteUrl()}/account/orders`,
        });
        if (error) console.error("[orders] could not send the return-requested email", error);
      } catch (error) {
        console.error("[orders] could not send the return-requested email", error);
      }
    });
  }
  return { ok: true };
}
