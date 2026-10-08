-- ooc:custom-sql (hand-written; not generated from schema.prisma)
ALTER TABLE "SupplierPriceSnapshot" ADD CONSTRAINT "SupplierPriceSnapshot_kind_valid" CHECK ("kind" IN ('cost', 'customer'));
ALTER TABLE "SupplierPrice" ADD CONSTRAINT "SupplierPrice_amount_nonneg" CHECK ("amountMinor" >= 0);
ALTER TABLE "SupplierPrice" ADD CONSTRAINT "SupplierPrice_term_unit_valid" CHECK ("termUnit" IS NULL OR "termUnit" IN ('years', 'months'));
