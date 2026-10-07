-- ooc:custom-sql (hand-written; not generated from schema.prisma)
ALTER TABLE "Order" ADD CONSTRAINT "Order_kind_valid" CHECK ("kind" IN ('purchase', 'renewal'));
ALTER TABLE "Order" ADD CONSTRAINT "Order_renewal_has_subscription" CHECK ("kind" <> 'renewal' OR "subscriptionId" IS NOT NULL);
UPDATE "RenewalRun" SET "status" = 'paid' WHERE "status" = 'charged';
UPDATE "RenewalRun" SET "status" = 'cancelled' WHERE "status" IN ('failed', 'skipped');
ALTER TABLE "RenewalRun" ADD CONSTRAINT "RenewalRun_status_valid" CHECK ("status" IN ('pending', 'paid', 'lapsed', 'cancelled'));
-- Scheduled changes created before this migration fall due at the period end they were scheduled for.
UPDATE "Subscription" SET "scheduledChangeDueAt" = ("scheduledChange"->>'effectiveAt')::timestamptz
  WHERE "scheduledChange" IS NOT NULL AND "scheduledChangeDueAt" IS NULL;
