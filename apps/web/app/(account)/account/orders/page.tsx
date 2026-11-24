import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@repo/auth/server";
import {
  bookFormatLabel,
  canCancel,
  canReturn,
  cancelBlock,
  cancelReasonLabel,
  downloadedEbooksOf,
  planCancellation,
  prisma,
  returnBlock,
  returnReasonLabel,
  returnWindowEndsAt,
  returnableQuantity,
  toOrderFacts,
  type Prisma,
} from "@repo/database";
import { isHttpsUrl } from "@repo/security/href";
import { OrdersTable } from "@/components/account/orders-table";
import { SectionHead, buttonClass } from "@/components/primitives";
import { getCachedPricingConfig } from "@/lib/cms";
import type { OrderShippingAddress } from "@/lib/india-address";
import { ORDER_CHANGES_INCLUDE } from "@/lib/order-changes";
import type { OrderDetail } from "@/lib/order-tracking";
import { getPolicyDetails } from "@/lib/policies";
import { lineProductHref } from "@/lib/product-lines";

export const metadata: Metadata = { title: "Orders" };

// FR-5.2/FR-8.3: order history with status tracking. Each row opens a
// detail pop-up (components/account/order-detail-dialog.tsx); everything
// it shows is loaded here in the one query, since a customer's history is
// small and it saves a round trip per click. That includes whether each
// order can still be cancelled or returned (`@repo/database`'s returns.ts),
// worked out here against the clock so the browser never decides it.
const ORDER_INCLUDE = {
  items: {
    include: {
      product: {
        select: { title: true, author: true, slug: true, type: true, productLine: true, coverImageUrl: true },
      },
    },
  },
  payment: { select: { method: true, status: true, updatedAt: true } },
  ...ORDER_CHANGES_INCLUDE,
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

export default async function OrderHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ placed?: string | string[] }>;
}) {
  const [user, { placed }, pricing, policy] = await Promise.all([
    getCurrentUser(),
    searchParams,
    getCachedPricingConfig(),
    getPolicyDetails(),
  ]);
  // Real data only — never sample rows: a customer must see their own
  // orders or none, not someone else's (fake) history.
  const rows = user
    ? await prisma.order.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        include: ORDER_INCLUDE,
      })
    : [];
  // Whether an e-book can still be cancelled or returned turns on whether
  // it's been downloaded.
  const downloaded = user
    ? await downloadedEbooksOf(
        prisma,
        user.id,
        rows.flatMap((row) => row.items.filter((item) => item.includesEbook).map((item) => item.productId))
      )
    : new Set<string>();
  const now = new Date();
  const orders = rows.map((row) => toOrderDetail(row, downloaded, now, policy.returnWindowDays));
  // Set by the payment page after a cash-on-delivery order; only ever
  // matched against this customer's own orders.
  const justPlacedId = typeof placed === "string" ? placed : undefined;

  return (
    <section>
      <SectionHead title="Orders" href="/account/library" hrefLabel="Digital library" />

      {orders.length === 0 ? (
        <div className="rounded-tile bg-tile px-6 py-14 text-center inset-ring inset-ring-card-edge">
          <h3>No orders yet</h3>
          <p className="mx-auto mt-2 max-w-[46ch] text-sm text-ink-muted">
            Printed editions, e-books and service packages you buy will show up here.
          </p>
          <Link href="/educational-material/books" className={buttonClass("secondary", "md", "mt-5")}>
            Start browsing
          </Link>
        </div>
      ) : (
        <OrdersTable orders={orders} justPlacedId={justPlacedId} standardEta={pricing.delivery.standardEta} />
      )}
    </section>
  );
}

function toOrderDetail(order: OrderRow, downloaded: ReadonlySet<string>, now: Date, windowDays: number): OrderDetail {
  const facts = toOrderFacts(order, downloaded);
  const factsById = new Map(facts.items.map((line) => [line.id, line]));
  const plan = planCancellation(facts);
  const windowEnds = returnWindowEndsAt(facts, windowDays);
  return {
    id: order.id,
    ref: `#${order.id.slice(-5)}`,
    status: order.status,
    shipmentStatus: order.shipmentStatus,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    discountCode: order.discountCode,
    shippingCents: order.shippingCents,
    taxCents: order.taxCents,
    totalCents: order.totalCents,
    shippingAddress: parseOrderAddress(order.shippingAddress),
    billingAddress: parseOrderAddress(order.billingAddress),
    gstNumber: order.gstNumber,
    carrier: order.carrier,
    trackingNumber: order.trackingNumber,
    payment: order.payment
      ? { method: order.payment.method, status: order.payment.status, updatedAt: order.payment.updatedAt.toISOString() }
      : null,
    items: order.items.map((item) => {
      const { product } = item;
      const line = factsById.get(item.id)!;
      const format = item.bookFormat ? bookFormatLabel(item.bookFormat) : null;
      return {
        id: item.id,
        title: product.title,
        author: product.author,
        href:
          product.type === "SERVICE_PACKAGE"
            ? `/services/${product.slug}`
            : product.productLine === "BOOK" || product.type === "EBOOK"
              ? `/educational-material/books/${product.slug}`
              : (lineProductHref(product.productLine, product.slug) ?? null),
        // Only an https URL reaches next/image — a relative or http value
        // (legacy/seed rows) would make it throw and take the dialog down.
        coverImageUrl: isHttpsUrl(product.coverImageUrl) ? product.coverImageUrl : null,
        fulfillmentType: item.fulfillmentType,
        formatLabel: format && item.includesEbook && item.bookFormat !== "EBOOK" ? `${format} + E-book` : format,
        includesEbook: item.includesEbook,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        cancelled: line.cancelled,
        returnedQuantity: line.returnedQuantity,
        cancelBlock: cancelBlock(facts, line),
        returnBlock: returnBlock(facts, line, now, windowDays),
        returnableQuantity: returnableQuantity(line),
      };
    }),
    cancellations: order.cancellations.map((cancellation) => ({
      id: cancellation.id,
      createdAt: cancellation.createdAt.toISOString(),
      reasonLabel: cancelReasonLabel(cancellation.reason),
      note: cancellation.note,
      refundCents: cancellation.refundCents,
      refundedAt: cancellation.refundedAt?.toISOString() ?? null,
      itemIds: cancellation.items.map((item) => item.id),
    })),
    returns: order.returns.map((orderReturn) => ({
      id: orderReturn.id,
      status: orderReturn.status,
      createdAt: orderReturn.createdAt.toISOString(),
      decidedAt: orderReturn.decidedAt?.toISOString() ?? null,
      completedAt: orderReturn.completedAt?.toISOString() ?? null,
      reasonLabel: returnReasonLabel(orderReturn.reason),
      note: orderReturn.note,
      staffNote: orderReturn.staffNote,
      refundCents: orderReturn.refundCents,
      refundedAt: orderReturn.refundedAt?.toISOString() ?? null,
      items: orderReturn.items.map(({ orderItemId, quantity }) => ({ orderItemId, quantity })),
    })),
    canCancel: canCancel(facts),
    cancelRefundCents: plan?.refundCents ?? 0,
    cancelsWholeOrder: plan?.cancelsOrder ?? false,
    canReturn: canReturn(facts, now, windowDays),
    returnWindowEndsAt: windowEnds?.toISOString() ?? null,
    facts: { ...facts, deliveredAt: order.deliveredAt?.toISOString() ?? null },
  };
}

/**
 * `Order.shippingAddress` / `billingAddress` are untyped JSON; anything not
 * shaped like the checkout snapshot is dropped.
 */
function parseOrderAddress(value: Prisma.JsonValue): OrderShippingAddress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : "");
  if (!text("line1") || !text("postalCode")) return null;
  return {
    name: text("name"),
    email: text("email"),
    line1: text("line1"),
    line2: text("line2") || null,
    district: text("district"),
    city: text("city"),
    state: text("state"),
    postalCode: text("postalCode"),
    country: "IN",
  };
}
