-- Customer cancellations and returns, from the storefront's My Orders and
-- handled on the admin Sales Orders page. Additive: two new kinds of record
-- (a cancellation, a return with its lines), a pointer from each cancelled
-- order line to its cancellation, and the parcel's delivery time, which the
-- return window counts from.

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('REQUESTED', 'APPROVED', 'COMPLETED', 'REJECTED');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "deliveredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "cancellationId" TEXT;

-- CreateTable
CREATE TABLE "order_cancellations" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "refundCents" INTEGER NOT NULL DEFAULT 0,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_returns" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "packagingUnopened" BOOLEAN NOT NULL DEFAULT false,
    "staffNote" TEXT,
    "refundCents" INTEGER NOT NULL DEFAULT 0,
    "refundedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_return_items" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "order_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_cancellations_orderId_idx" ON "order_cancellations"("orderId");

-- CreateIndex
CREATE INDEX "order_returns_orderId_idx" ON "order_returns"("orderId");

-- CreateIndex
CREATE INDEX "order_returns_status_idx" ON "order_returns"("status");

-- CreateIndex
CREATE INDEX "order_return_items_orderItemId_idx" ON "order_return_items"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "order_return_items_returnId_orderItemId_key" ON "order_return_items"("returnId", "orderItemId");

-- CreateIndex
CREATE INDEX "order_items_cancellationId_idx" ON "order_items"("cancellationId");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_cancellationId_fkey" FOREIGN KEY ("cancellationId") REFERENCES "order_cancellations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_cancellations" ADD CONSTRAINT "order_cancellations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "order_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma only; never reachable over the Data API (see lock_down_data_api).
ALTER TABLE "order_cancellations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_returns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_return_items" ENABLE ROW LEVEL SECURITY;

-- Parcels already delivered: nothing recorded when, so their last change is
-- the closest there is. Their return window counts from it.
UPDATE "orders" SET "deliveredAt" = "updatedAt" WHERE "shipmentStatus" = 'DELIVERED' AND "deliveredAt" IS NULL;
