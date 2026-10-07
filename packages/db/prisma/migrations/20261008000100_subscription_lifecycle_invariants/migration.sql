-- ooc:custom-sql (hand-written; not generated from schema.prisma)
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pendingAction_valid" CHECK ("pendingAction" IS NULL OR "pendingAction" IN ('suspend', 'resume'));
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_quantity_positive" CHECK ("quantity" >= 1);
UPDATE "Subscription" SET "cancelledAt" = "updatedAt" WHERE "status" = 'cancelled' AND "cancelledAt" IS NULL;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_cancelled_consistent" CHECK ("status" <> 'cancelled' OR "cancelledAt" IS NOT NULL);
