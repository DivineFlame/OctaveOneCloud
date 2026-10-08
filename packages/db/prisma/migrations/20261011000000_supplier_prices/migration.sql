-- CreateTable
CREATE TABLE "SupplierPriceSnapshot" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT NOT NULL,
    "changedCount" INTEGER,
    "fetchedById" UUID,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPrice" (
    "id" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "ref" TEXT NOT NULL,
    "productKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "plan" TEXT,
    "action" TEXT,
    "term" INTEGER,
    "termUnit" TEXT,
    "amountMinor" BIGINT NOT NULL,

    CONSTRAINT "SupplierPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierPriceSnapshot_provider_kind_fetchedAt_idx" ON "SupplierPriceSnapshot"("provider", "kind", "fetchedAt");

-- CreateIndex
CREATE INDEX "SupplierPrice_snapshotId_productKey_idx" ON "SupplierPrice"("snapshotId", "productKey");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPrice_snapshotId_ref_key" ON "SupplierPrice"("snapshotId", "ref");

-- AddForeignKey
ALTER TABLE "SupplierPrice" ADD CONSTRAINT "SupplierPrice_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "SupplierPriceSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
