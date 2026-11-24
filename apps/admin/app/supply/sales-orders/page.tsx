import {
  bookFormatLabel,
  cancelReasonLabel,
  deliveryType,
  downloadedEbooks,
  isRefundDue,
  prisma,
  returnReasonLabel,
  toOrderFacts,
  type Prisma,
} from "@repo/database";
import { PageHeader } from "@/components/ui";
import { requireStaffPage } from "@/lib/guard";
import { canMarkCashCollected } from "./cod";
import { isSalesOrderFilter } from "./filters";
import { SalesOrdersList, type SalesOrderAddress, type SalesOrderRow } from "./sales-orders-list";

// Every order a customer has actually placed — paid online, or ordered cash
// on delivery. An online checkout that was never paid isn't a sale yet, so
// it stays off this list: unpaid orders have no shipment status and a status
// of PENDING (or CANCELLED, once the attempt is abandoned). An e-book order
// the customer cancelled has no shipment status either, but its cancellation
// keeps it listed.
const PLACED_ORDER: Prisma.OrderWhereInput = {
  OR: [
    { shipmentStatus: { not: null } },
    { status: { in: ["PAID", "PROCESSING", "SHIPPED", "DELIVERED", "READY_FOR_DOWNLOAD", "REFUNDED"] } },
    { cancellations: { some: {} } },
  ],
};

const ORDER_INCLUDE = {
  user: { select: { name: true, email: true } },
  payment: { select: { method: true, status: true } },
  items: { include: { product: { select: { title: true } } } },
  // What the customer cancelled or sent back from My Orders.
  cancellations: { orderBy: { createdAt: "asc" }, include: { items: { select: { id: true } } } },
  returns: { orderBy: { createdAt: "asc" }, include: { items: { select: { orderItemId: true, quantity: true } } } },
} satisfies Prisma.OrderInclude;

type OrderWithDetails = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

export default async function SalesOrdersPage({ searchParams }: { searchParams: Promise<{ filter?: string | string[] }> }) {
  await requireStaffPage();
  // The dashboard's "needs attention" links open the list already filtered.
  const { filter } = await searchParams;
  const orders = await prisma.order.findMany({
    where: PLACED_ORDER,
    include: ORDER_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  // Whether each e-book was downloaded — why it could or couldn't be
  // cancelled or returned.
  const ebookLines = orders.flatMap((order) =>
    order.userId ? order.items.filter((item) => item.includesEbook).map((item) => ({ userId: order.userId!, item })) : []
  );
  const downloads = await downloadedEbooks(
    prisma,
    ebookLines.map((line) => line.userId),
    ebookLines.map((line) => line.item.productId)
  );

  return (
    <div className="max-w-6xl pt-10">
      <PageHeader
        title="Sales Orders"
        description="Orders placed by customers, newest first. Accept or deny each new order with printed items, then move it along as it's packed and delivered. E-books are delivered automatically."
      />
      <SalesOrdersList
        orders={orders.map((order) => toRow(order, (order.userId && downloads.get(order.userId)) || new Set()))}
        initialFilter={typeof filter === "string" && isSalesOrderFilter(filter) ? filter : "all"}
      />
    </div>
  );
}

function toRow(order: OrderWithDetails, downloaded: ReadonlySet<string>): SalesOrderRow {
  const address = parseAddress(order.shippingAddress);
  const facts = toOrderFacts(order, downloaded);
  const factsById = new Map(facts.items.map((line) => [line.id, line]));
  const itemLabel = (id: string, quantity?: number) => {
    const item = order.items.find((candidate) => candidate.id === id);
    if (!item) return "An item no longer in the order";
    const title = item.bookFormat ? `${item.product.title} (${bookFormatLabel(item.bookFormat)})` : item.product.title;
    return quantity && quantity > 1 ? `${title} × ${quantity}` : title;
  };
  const cancelledLines = order.items.filter((item) => item.cancellationId !== null);
  const refundDueCents =
    order.cancellations.filter(isRefundDue).reduce((sum, c) => sum + c.refundCents, 0) +
    order.returns.filter(isRefundDue).reduce((sum, r) => sum + r.refundCents, 0);
  return {
    id: order.id,
    // The same short reference the customer sees on their Orders page.
    ref: `#${order.id.slice(-5)}`,
    createdAt: order.createdAt.toISOString(),
    status: order.status,
    shipmentStatus: order.shipmentStatus,
    deliveryType: deliveryType(order.items),
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    discountCode: order.discountCode,
    shippingCents: order.shippingCents,
    taxCents: order.taxCents,
    totalCents: order.totalCents,
    customer: {
      name: order.user?.name || address?.name || null,
      email: order.user?.email ?? order.guestEmail ?? address?.email ?? null,
    },
    shippingAddress: address,
    gstNumber: order.gstNumber,
    payment: order.payment ? { method: order.payment.method, status: order.payment.status } : null,
    carrier: order.carrier,
    trackingNumber: order.trackingNumber,
    canCollectCash: canMarkCashCollected(order),
    // The customer called off the order, or its parcel, themselves — as
    // opposed to staff denying it.
    customerCancelled:
      order.cancellations.length === 0
        ? null
        : order.status === "CANCELLED" || order.status === "REFUNDED"
          ? "ORDER"
          : order.shipmentStatus === "CANCELLED" && cancelledLines.some((item) => item.fulfillmentType === "SHIP")
            ? "PARCEL"
            : "SOME",
    refundDueCents,
    cancellations: order.cancellations.map((cancellation) => ({
      id: cancellation.id,
      createdAt: cancellation.createdAt.toISOString(),
      reasonLabel: cancelReasonLabel(cancellation.reason),
      note: cancellation.note,
      refundCents: cancellation.refundCents,
      refundedAt: cancellation.refundedAt?.toISOString() ?? null,
      refundDue: isRefundDue(cancellation),
      items: cancellation.items.map((item) => itemLabel(item.id)),
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
      packagingUnopened: orderReturn.packagingUnopened,
      refundCents: orderReturn.refundCents,
      refundedAt: orderReturn.refundedAt?.toISOString() ?? null,
      refundDue: isRefundDue(orderReturn),
      printed: orderReturn.items.some(
        (item) => order.items.find((candidate) => candidate.id === item.orderItemId)?.fulfillmentType === "SHIP"
      ),
      items: orderReturn.items.map((item) => itemLabel(item.orderItemId, item.quantity)),
    })),
    items: order.items.map((item) => {
      const format = item.bookFormat ? bookFormatLabel(item.bookFormat) : null;
      const line = factsById.get(item.id)!;
      return {
        id: item.id,
        title: item.product.title,
        formatLabel: format && item.includesEbook && item.bookFormat !== "EBOOK" ? `${format} + E-book` : format,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        offline: item.fulfillmentType === "SHIP",
        cancelled: line.cancelled,
        returnedQuantity: line.returnedQuantity,
        ebookDownloaded: line.ebookDownloaded,
        hasEbook: item.includesEbook,
      };
    }),
  };
}

/** `Order.shippingAddress` is untyped JSON — the checkout snapshot, or nothing usable. */
function parseAddress(value: Prisma.JsonValue): SalesOrderAddress | null {
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
  };
}
