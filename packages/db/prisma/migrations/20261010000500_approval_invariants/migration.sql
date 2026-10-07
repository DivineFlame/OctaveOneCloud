-- ooc:custom-sql (hand-written; not generated from schema.prisma)
-- The approved action can never be swapped after the request: payload, hash and type are immutable.
CREATE OR REPLACE FUNCTION approval_action_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."actionHash" IS DISTINCT FROM OLD."actionHash" OR NEW."actionType" IS DISTINCT FROM OLD."actionType"
     OR NEW."payload"::text IS DISTINCT FROM OLD."payload"::text OR NEW."orgId" IS DISTINCT FROM OLD."orgId" THEN
    RAISE EXCEPTION 'Approval requests are immutable; create a new request';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ApprovalRequest_action_immutable" BEFORE UPDATE ON "ApprovalRequest"
  FOR EACH ROW EXECUTE FUNCTION approval_action_immutable();
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_action_type_valid" CHECK ("actionType" IN ('outbound_message', 'publish_campaign', 'delete', 'spend'));
