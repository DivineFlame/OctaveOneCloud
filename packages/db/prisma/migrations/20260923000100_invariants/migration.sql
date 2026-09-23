-- Database-level monetary and access invariants that Prisma schema syntax cannot express.
-- Hand-written. Prisma does not track CHECK constraints, so these survive future diffs.

ALTER TABLE "PriceVersion"
  ADD CONSTRAINT "PriceVersion_amount_nonneg" CHECK ("amountMinor" >= 0 AND "setupFeeMinor" >= 0),
  ADD CONSTRAINT "PriceVersion_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "Quote"
  ADD CONSTRAINT "Quote_totals_consistent" CHECK ("subtotalMinor" >= 0 AND "discountMinor" >= 0 AND "taxMinor" >= 0
    AND "totalMinor" = "subtotalMinor" - "discountMinor" + "taxMinor");

ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_quantity_pos" CHECK ("quantity" > 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_quantity_pos" CHECK ("quantity" > 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_total_nonneg" CHECK ("totalMinor" >= 0);
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_amount_pos" CHECK ("amountMinor" > 0);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_pos" CHECK ("amountMinor" > 0);
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_max_pos" CHECK ("maxAmountMinor" > 0);
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_quantity_nonneg" CHECK ("quantity" >= 0);
ALTER TABLE "UsageReservation" ADD CONSTRAINT "UsageReservation_quantity_pos" CHECK ("quantity" > 0);

-- Usage caps must hold under concurrency: reservations use conditional UPDATEs, and the
-- database rejects any state where consumption exceeds the limit.
ALTER TABLE "UsageCounter"
  ADD CONSTRAINT "UsageCounter_nonneg" CHECK ("used" >= 0 AND "reserved" >= 0),
  ADD CONSTRAINT "UsageCounter_within_limit" CHECK ("used" + "reserved" <= "limit");

-- A paid order can have at most one PaymentOrder in 'paid' state.
CREATE UNIQUE INDEX "PaymentOrder_one_paid_per_order" ON "PaymentOrder" ("orderId") WHERE "status" = 'paid';

-- Only one open renewal charge per subscription at a time.
CREATE UNIQUE INDEX "RenewalRun_one_pending" ON "RenewalRun" ("subscriptionId") WHERE "status" = 'pending';

-- Audit events are append-only. Deletion is permitted only by the retention job, which sets
-- SET LOCAL ooc.audit_retention = 'on' inside its transaction.
CREATE OR REPLACE FUNCTION audit_event_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('ooc.audit_retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AuditEvent rows are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AuditEvent_no_update" BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();

-- Published plan versions and price versions are immutable.
CREATE OR REPLACE FUNCTION price_version_immutable() RETURNS trigger AS $$
BEGIN
  IF (OLD."amountMinor", OLD."setupFeeMinor", OLD."currency", OLD."billingInterval", OLD."kind", OLD."planVersionId")
     IS DISTINCT FROM (NEW."amountMinor", NEW."setupFeeMinor", NEW."currency", NEW."billingInterval", NEW."kind", NEW."planVersionId") THEN
    RAISE EXCEPTION 'PriceVersion commercial fields are immutable; create a new version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PriceVersion_immutable" BEFORE UPDATE ON "PriceVersion"
  FOR EACH ROW EXECUTE FUNCTION price_version_immutable();

CREATE OR REPLACE FUNCTION plan_feature_immutable() RETURNS trigger AS $$
DECLARE published timestamptz;
BEGIN
  SELECT "publishedAt" INTO published FROM "PlanVersion" WHERE id = COALESCE(OLD."planVersionId", NEW."planVersionId");
  IF published IS NOT NULL THEN
    RAISE EXCEPTION 'Features of a published PlanVersion are immutable; create a new version';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PlanFeature_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "PlanFeature"
  FOR EACH ROW EXECUTE FUNCTION plan_feature_immutable();
