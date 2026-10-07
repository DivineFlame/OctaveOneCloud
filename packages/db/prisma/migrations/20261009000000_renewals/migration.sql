-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'purchase',
ADD COLUMN     "subscriptionId" UUID;

-- AlterTable
ALTER TABLE "RenewalRun" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "orderId" UUID,
ADD COLUMN     "remindersSent" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "scheduledChangeDueAt" TIMESTAMP(3),
ADD COLUMN     "suspensionReason" TEXT;

-- CreateIndex
CREATE INDEX "Order_subscriptionId_idx" ON "Order"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "RenewalRun_orderId_key" ON "RenewalRun"("orderId");
