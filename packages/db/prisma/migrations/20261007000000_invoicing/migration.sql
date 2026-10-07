-- AlterTable
ALTER TABLE "TaxRule" ADD COLUMN     "sacCode" TEXT;

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "sacCode" TEXT;

-- AlterTable
ALTER TABLE "CreditNote" ADD COLUMN     "createdById" UUID,
ADD COLUMN     "taxDetail" JSONB;

-- CreateTable
CREATE TABLE "DocumentSequence" (
    "series" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentSequence_pkey" PRIMARY KEY ("series")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_orderId_key" ON "Invoice"("orderId");

-- CreateIndex
CREATE INDEX "Invoice_orgId_issuedAt_idx" ON "Invoice"("orgId", "issuedAt");
