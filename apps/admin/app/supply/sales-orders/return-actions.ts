"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { bookFormatLabel, isRefundDue, prisma, returnStock, type ReturnStatus } from "@repo/database";
import { getCurrentStaff } from "@repo/auth/server";
import { assertRole, ORDER_WRITE_ROLES } from "@repo/auth/roles";
import { sendReturnUpdate, type ReturnUpdateStage } from "@repo/email";
import { stockReturnedTags } from "@repo/cache/tags";
import { revalidateStorefront } from "@/lib/storefront-cache";
import { ORDER_STATS_TAG } from "@/lib/admin-cache";
import { shippingEmail, storefrontOrdersUrl } from "./customer";

/**
 * Staff handling the customer cancellations and returns that come in from
 * the storefront's My Orders (rules: `@repo/database`'s returns.ts).
 *
 * A return is decided here: Approve (the customer then posts it back),
 * Mark as received (it came back unopened — its copies go back in stock),
 * or Reject (packaging opened, outside the window, …) with a note the
 * customer sees. A return of nothing but an undownloaded e-book has nothing
 * to post, so approving it completes it. A cancellation needs no decision —
 * it happened the moment the customer asked.
 *
 * There's no refund integration: staff send the money from the Razorpay
 * dashboard (bank transfer or UPI for cash on delivery) and then tick it off
 * with `markRefundSent`, which is what clears it from "Refunds to send".
 */

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export type ReturnActionResult = { ok: true } | { ok: false; error: string };

const RETRY = "That change couldn't be made. Refresh the page and try again.";
const RACED = "Someone else has just updated this return. The list has been refreshed.";

const decideSchema = z
  .object({
    returnId: idSchema,
    // What the operator saw on screen; the update only lands while the
    // return is still there, so a double click can't apply twice.
    from: z.enum(["REQUESTED", "APPROVED"]),
    decision: z.enum(["approve", "receive", "reject"]),
    staffNote: z.string().trim().max(500, "Please keep the message under 500 characters.").optional(),
  })
  .refine((input) => input.decision !== "reject" || (input.staffNote?.length ?? 0) >= 3, {
    message: "Tell the customer why the return can't be accepted.",
    path: ["staffNote"],
  });

export async function decideReturn(input: z.input<typeof decideSchema>): Promise<ReturnActionResult> {
  const staff = await getCurrentStaff();
  assertRole(staff?.role, ORDER_WRITE_ROLES);

  const parsed = decideSchema.safeParse(input);
  if (!parsed.success) {
    const note = parsed.error.issues.find((issue) => issue.path[0] === "staffNote");
    return { ok: false, error: note?.message ?? RETRY };
  }
  const { returnId, from, decision } = parsed.data;
  const staffNote = parsed.data.staffNote || null;

  const orderReturn = await prisma.orderReturn.findUnique({
    where: { id: returnId },
    include: {
      items: {
        include: {
          orderItem: {
            select: {
              productId: true,
              bookFormat: true,
              fulfillmentType: true,
              product: { select: { title: true, slug: true, productLine: true, type: true } },
            },
          },
        },
      },
      order: {
        select: {
          id: true,
          guestEmail: true,
          shippingAddress: true,
          user: { select: { email: true } },
          payment: { select: { method: true } },
        },
      },
    },
  });
  if (!orderReturn) return { ok: false, error: "This return no longer exists." };

  const printed = orderReturn.items.filter((item) => item.orderItem.fulfillmentType === "SHIP");
  // Approving a return with nothing to post back (an undownloaded e-book)
  // is the whole of it.
  const to: ReturnStatus | null =
    decision === "reject"
      ? "REJECTED"
      : decision === "approve"
        ? from === "REQUESTED"
          ? printed.length
            ? "APPROVED"
            : "COMPLETED"
          : null
        : from === "APPROVED"
          ? "COMPLETED"
          : null;
  if (!to) return { ok: false, error: "That step isn't available for this return." };

  const now = new Date();
  const moved = await prisma.$transaction(async (tx) => {
    const { count } = await tx.orderReturn.updateMany({
      where: { id: returnId, status: from },
      data: {
        status: to,
        ...(decision !== "receive" && { decidedAt: now }),
        ...(to === "COMPLETED" && { completedAt: now }),
        // Keep what was said on approval unless there's something new to say.
        ...(staffNote && { staffNote }),
      },
    });
    // Back on the shelf: the copies came back unopened.
    if (count === 1 && to === "COMPLETED" && printed.length) {
      await returnStock(
        tx,
        printed.map((item) => ({
          productId: item.orderItem.productId,
          bookFormat: item.orderItem.bookFormat,
          quantity: item.quantity,
        }))
      );
    }
    return count === 1;
  });
  if (!moved) return { ok: false, error: RACED };

  await prisma.auditLog.create({
    data: {
      actorId: staff!.id,
      actorEmail: staff!.email,
      action: `sales_order.return_${to === "REJECTED" ? "rejected" : to === "APPROVED" ? "approved" : "completed"}`,
      entity: "Order",
      entityId: orderReturn.orderId,
      diff: {
        returnId,
        status: { from, to },
        ...(staffNote && { staffNote }),
        ...(to === "COMPLETED" && { refundCents: orderReturn.refundCents }),
      },
    },
  });

  const { order } = orderReturn;
  const customerEmail = order.user?.email ?? order.guestEmail ?? shippingEmail(order.shippingAddress);
  const stage: ReturnUpdateStage = to === "REJECTED" ? "rejected" : to === "APPROVED" ? "approved" : "completed";
  if (customerEmail) {
    // After the response, best-effort, never retried — like every email here.
    after(async () => {
      try {
        const { error } = await sendReturnUpdate({
          to: customerEmail,
          stage,
          orderRef: `#${order.id.slice(-5)}`,
          items: orderReturn.items.map((item) => {
            const { orderItem } = item;
            const title = orderItem.bookFormat
              ? `${orderItem.product.title} (${bookFormatLabel(orderItem.bookFormat)})`
              : orderItem.product.title;
            return item.quantity > 1 ? `${title} × ${item.quantity}` : title;
          }),
          refundCents: orderReturn.refundCents,
          cashOnDelivery: order.payment?.method === "COD",
          staffNote: staffNote ?? (to === "COMPLETED" ? null : orderReturn.staffNote),
          ordersUrl: storefrontOrdersUrl() ?? undefined,
        });
        if (error) console.error("[sales-orders] could not send the return email", error);
      } catch (error) {
        console.error("[sales-orders] could not send the return email", error);
      }
    });
  }

  revalidatePath("/supply/sales-orders");
  revalidatePath("/");
  revalidateTag(ORDER_STATS_TAG, { expire: 0 });
  if (to === "COMPLETED" && printed.length) {
    revalidateStorefront(stockReturnedTags(printed.map((item) => item.orderItem.product)));
  }
  return { ok: true };
}

const refundSchema = z.object({ kind: z.enum(["cancellation", "return"]), id: idSchema });

/**
 * The refund for a customer's cancellation, or for a completed return, has
 * been sent by hand. When that settles an order the customer cancelled
 * outright, the order and its payment read as refunded too.
 */
export async function markRefundSent(input: z.input<typeof refundSchema>): Promise<ReturnActionResult> {
  const staff = await getCurrentStaff();
  assertRole(staff?.role, ORDER_WRITE_ROLES);

  const parsed = refundSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: RETRY };
  const { kind, id } = parsed.data;

  const record =
    kind === "cancellation"
      ? await prisma.orderCancellation.findUnique({
          where: { id },
          select: { orderId: true, refundCents: true, refundedAt: true },
        })
      : await prisma.orderReturn.findUnique({
          where: { id },
          select: { orderId: true, refundCents: true, refundedAt: true, status: true },
        });
  if (!record) return { ok: false, error: "This refund no longer exists." };
  if (!isRefundDue(record)) return { ok: false, error: "There's no refund waiting to be sent for this." };

  const now = new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    const due = { id, refundedAt: null, refundCents: { gt: 0 } };
    const { count } =
      kind === "cancellation"
        ? await tx.orderCancellation.updateMany({ where: due, data: { refundedAt: now } })
        : await tx.orderReturn.updateMany({ where: { ...due, status: "COMPLETED" }, data: { refundedAt: now } });
    if (count !== 1) return null;

    // A wholly cancelled order whose money has all gone back is refunded.
    const order = await tx.order.findUniqueOrThrow({
      where: { id: record.orderId },
      select: {
        status: true,
        payment: { select: { id: true, status: true } },
        cancellations: { select: { refundCents: true, refundedAt: true } },
      },
    });
    const settled = order.status === "CANCELLED" && order.cancellations.every((c) => !isRefundDue(c));
    if (kind === "cancellation" && settled && order.payment?.status === "CAPTURED") {
      await tx.order.updateMany({ where: { id: record.orderId, status: "CANCELLED" }, data: { status: "REFUNDED" } });
      await tx.payment.updateMany({ where: { id: order.payment.id, status: "CAPTURED" }, data: { status: "REFUNDED" } });
      return { orderRefunded: true };
    }
    return { orderRefunded: false };
  });
  if (!outcome) return { ok: false, error: RACED };

  await prisma.auditLog.create({
    data: {
      actorId: staff!.id,
      actorEmail: staff!.email,
      action: "sales_order.refund_sent",
      entity: "Order",
      entityId: record.orderId,
      diff: {
        [kind === "cancellation" ? "cancellationId" : "returnId"]: id,
        refundCents: record.refundCents,
        ...(outcome.orderRefunded && { status: { from: "CANCELLED", to: "REFUNDED" } }),
      },
    },
  });

  revalidatePath("/supply/sales-orders");
  revalidatePath("/");
  revalidateTag(ORDER_STATS_TAG, { expire: 0 });
  return { ok: true };
}
