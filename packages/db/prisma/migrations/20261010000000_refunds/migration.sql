-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "creditNoteInvoiceId" UUID,
ADD COLUMN     "lastError" TEXT;

-- CreateIndex
CREATE INDEX "Refund_status_updatedAt_idx" ON "Refund"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_refundId_key" ON "CreditNote"("refundId");
