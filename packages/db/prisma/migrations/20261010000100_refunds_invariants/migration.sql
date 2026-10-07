-- ooc:custom-sql (hand-written; not generated from schema.prisma)
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_request_id_format" CHECK ("refundRequestId" ~ '^[A-Za-z0-9]{3,40}$') NOT VALID;
