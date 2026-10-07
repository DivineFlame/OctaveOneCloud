-- ooc:custom-sql (hand-written; not generated from schema.prisma)
-- Issued invoices and credit notes are legal documents: their amounts and numbers never change.
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_amounts_nonneg" CHECK ("amountMinor" > 0 AND "taxMinor" >= 0);
ALTER TABLE "DocumentSequence" ADD CONSTRAINT "DocumentSequence_nonneg" CHECK ("lastNumber" >= 0);

CREATE OR REPLACE FUNCTION issued_invoice_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."number" IS NOT NULL AND (
       NEW."number" IS DISTINCT FROM OLD."number" OR NEW."subtotalMinor" <> OLD."subtotalMinor" OR
       NEW."taxMinor" <> OLD."taxMinor" OR NEW."totalMinor" <> OLD."totalMinor" OR
       NEW."billingSnapshot"::text IS DISTINCT FROM OLD."billingSnapshot"::text OR
       NEW."taxBreakdown"::text IS DISTINCT FROM OLD."taxBreakdown"::text) THEN
    RAISE EXCEPTION 'Issued invoices are immutable; issue a credit note instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Invoice_issued_immutable" BEFORE UPDATE ON "Invoice"
  FOR EACH ROW EXECUTE FUNCTION issued_invoice_immutable();

CREATE OR REPLACE FUNCTION issued_document_no_delete() RETURNS trigger AS $$
BEGIN
  IF OLD."number" IS NOT NULL THEN
    RAISE EXCEPTION 'Issued % rows cannot be deleted', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Invoice_no_delete" BEFORE DELETE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION issued_document_no_delete();
CREATE TRIGGER "CreditNote_no_delete" BEFORE DELETE ON "CreditNote" FOR EACH ROW EXECUTE FUNCTION issued_document_no_delete();

CREATE OR REPLACE FUNCTION issued_credit_note_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."number" IS NOT NULL AND (
       NEW."number" IS DISTINCT FROM OLD."number" OR NEW."invoiceId" <> OLD."invoiceId" OR
       NEW."amountMinor" <> OLD."amountMinor" OR NEW."taxMinor" <> OLD."taxMinor" OR
       NEW."taxDetail"::text IS DISTINCT FROM OLD."taxDetail"::text) THEN
    RAISE EXCEPTION 'Issued credit notes are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CreditNote_issued_immutable" BEFORE UPDATE ON "CreditNote"
  FOR EACH ROW EXECUTE FUNCTION issued_credit_note_immutable();
