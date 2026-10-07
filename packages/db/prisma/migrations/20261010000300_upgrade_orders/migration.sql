-- ooc:custom-sql (hand-written; not generated from schema.prisma)
-- Upgrade orders (prorated plan changes) join purchase and renewal orders.
ALTER TABLE "Order" DROP CONSTRAINT "Order_kind_valid";
ALTER TABLE "Order" ADD CONSTRAINT "Order_kind_valid" CHECK ("kind" IN ('purchase', 'renewal', 'upgrade'));
ALTER TABLE "Order" DROP CONSTRAINT "Order_renewal_has_subscription";
ALTER TABLE "Order" ADD CONSTRAINT "Order_subscription_kinds" CHECK ("kind" = 'purchase' OR "subscriptionId" IS NOT NULL);
