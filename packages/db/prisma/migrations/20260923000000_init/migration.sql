-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('owner', 'admin', 'billing', 'member');

-- CreateEnum
CREATE TYPE "OperatorRole" AS ENUM ('operator_support', 'operator_finance', 'operator_admin');

-- CreateEnum
CREATE TYPE "UserTokenPurpose" AS ENUM ('email_verification', 'password_reset');

-- CreateEnum
CREATE TYPE "ProductFamily" AS ENUM ('domains', 'web_infrastructure', 'business_essentials', 'hosted_apps', 'agentic_bundles', 'managed_services');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('draft', 'active', 'retired');

-- CreateEnum
CREATE TYPE "FulfillmentKind" AS ENUM ('resellerclub', 'app_adapter', 'bundle', 'manual_service');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('starter', 'growth', 'business', 'enterprise', 'standard');

-- CreateEnum
CREATE TYPE "MergePolicy" AS ENUM ('max', 'additive', 'boolean');

-- CreateEnum
CREATE TYPE "PriceKind" AS ENUM ('subscription', 'registration', 'renewal', 'transfer', 'one_time', 'usage_pack');

-- CreateEnum
CREATE TYPE "SupplyTypeRule" AS ENUM ('intra_state', 'inter_state', 'export', 'any');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('draft', 'accepted', 'expired', 'converted', 'cancelled');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('draft', 'awaiting_payment', 'paid', 'provisioning', 'active', 'delayed', 'needs_attention', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'issued', 'paid', 'void');

-- CreateEnum
CREATE TYPE "PaymentOrderStatus" AS ENUM ('created', 'active', 'paid', 'expired', 'terminated');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('created', 'pending', 'success', 'failed', 'user_dropped', 'cancelled', 'unknown');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('requested', 'pending', 'success', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "MandateType" AS ENUM ('periodic', 'on_demand');

-- CreateEnum
CREATE TYPE "CollectionOwner" AS ENUM ('provider_schedule', 'platform_scheduler');

-- CreateEnum
CREATE TYPE "MandateStatus" AS ENUM ('initialized', 'pending_authorization', 'active', 'on_hold', 'paused', 'cancelled', 'completed', 'expired', 'failed');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('pending_activation', 'trialing', 'active', 'past_due', 'grace', 'suspended', 'cancel_scheduled', 'cancelled');

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('pending', 'active', 'expiring', 'expired', 'suspended', 'cancelled', 'needs_attention');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('reserved', 'settled', 'released', 'expired');

-- CreateEnum
CREATE TYPE "ProvisioningStatus" AS ENUM ('queued', 'running', 'active', 'partially_failed', 'failed', 'compensating', 'unknown_outcome');

-- CreateEnum
CREATE TYPE "SupplierOperationStatus" AS ENUM ('pending', 'sent', 'succeeded', 'failed', 'unknown', 'reconciled');

-- CreateEnum
CREATE TYPE "InboxStatus" AS ENUM ('received', 'processing', 'processed', 'ignored', 'failed');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'dispatched', 'failed', 'dead');

-- CreateEnum
CREATE TYPE "AdapterStatus" AS ENUM ('unconfigured', 'sandbox', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired', 'invalidated', 'executed');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('open', 'pending_customer', 'pending_internal', 'resolved', 'closed');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "operatorRole" "OperatorRole",
    "mfaSecretEnc" TEXT,
    "mfaKeyId" TEXT,
    "mfaEnabledAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "mfaVerified" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" "UserTokenPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "legalName" TEXT,
    "gstin" TEXT,
    "billingEmail" TEXT,
    "billingAddress" JSONB,
    "stateCode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "OrgRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedById" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCustomerMapping" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerCustomerId" TEXT NOT NULL,
    "contactIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCustomerMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "family" "ProductFamily" NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'draft',
    "fulfillment" "FulfillmentKind" NOT NULL,
    "adapterKey" TEXT,
    "taxCategory" TEXT NOT NULL,
    "description" TEXT,
    "verificationNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" "PlanTier" NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanVersion" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "supportLevel" TEXT,
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feature" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT,
    "mergePolicy" "MergePolicy" NOT NULL,
    "metered" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Feature_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PlanFeature" (
    "id" UUID NOT NULL,
    "planVersionId" UUID NOT NULL,
    "featureKey" TEXT NOT NULL,
    "limit" BIGINT,

    CONSTRAINT "PlanFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleComponent" (
    "id" UUID NOT NULL,
    "bundleVersionId" UUID NOT NULL,
    "componentVersionId" UUID NOT NULL,
    "provisionOrder" INTEGER NOT NULL DEFAULT 0,
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "BundleComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceVersion" (
    "id" UUID NOT NULL,
    "planVersionId" UUID NOT NULL,
    "kind" "PriceKind" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "billingInterval" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "setupFeeMinor" BIGINT NOT NULL DEFAULT 0,
    "costMinor" BIGINT,
    "costSource" TEXT,
    "isPremium" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxRule" (
    "id" UUID NOT NULL,
    "taxCategory" TEXT NOT NULL,
    "supplyType" "SupplyTypeRule" NOT NULL,
    "components" JSONB NOT NULL,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "notes" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "supplyType" TEXT NOT NULL,
    "subtotalMinor" BIGINT NOT NULL,
    "discountMinor" BIGINT NOT NULL,
    "taxMinor" BIGINT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLine" (
    "id" UUID NOT NULL,
    "quoteId" UUID NOT NULL,
    "priceVersionId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitAmountMinor" BIGINT NOT NULL,
    "setupFeeMinor" BIGINT NOT NULL DEFAULT 0,
    "discountMinor" BIGINT NOT NULL DEFAULT 0,
    "taxMinor" BIGINT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "costMinor" BIGINT,
    "billingInterval" TEXT NOT NULL,
    "configuration" JSONB,

    CONSTRAINT "QuoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "quoteId" UUID,
    "status" "OrderStatus" NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "totalMinor" BIGINT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "priceVersionId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "configuration" JSONB,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "orderId" UUID,
    "number" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "subtotalMinor" BIGINT NOT NULL,
    "taxMinor" BIGINT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "taxBreakdown" JSONB NOT NULL,
    "billingSnapshot" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "taxMinor" BIGINT NOT NULL,
    "taxDetail" JSONB NOT NULL,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "number" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "taxMinor" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "refundId" UUID,
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentOrder" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'cashfree',
    "environment" TEXT NOT NULL,
    "providerOrderId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentOrderStatus" NOT NULL DEFAULT 'created',
    "paymentSessionId" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" UUID NOT NULL,
    "paymentOrderId" UUID NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "status" "PaymentAttemptStatus" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "method" TEXT,
    "feeMinor" BIGINT,
    "taxOnFeeMinor" BIGINT,
    "providerPayload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "paymentOrderId" UUID NOT NULL,
    "refundRequestId" TEXT NOT NULL,
    "providerRefundId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'requested',
    "reason" TEXT NOT NULL,
    "requestedById" UUID,
    "providerPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" UUID NOT NULL,
    "providerDisputeId" TEXT NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "providerPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" UUID NOT NULL,
    "providerSettlementId" TEXT NOT NULL,
    "grossMinor" BIGINT NOT NULL,
    "feesMinor" BIGINT NOT NULL,
    "taxOnFeesMinor" BIGINT NOT NULL,
    "netMinor" BIGINT NOT NULL,
    "settledAt" TIMESTAMP(3),
    "providerPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mandate" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "providerSubscriptionId" TEXT NOT NULL,
    "providerPlanId" TEXT,
    "type" "MandateType" NOT NULL,
    "collectionOwner" "CollectionOwner" NOT NULL,
    "status" "MandateStatus" NOT NULL DEFAULT 'initialized',
    "maxAmountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "authorizedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "consentSnapshot" JSONB NOT NULL,
    "providerPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mandate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "planVersionId" UUID NOT NULL,
    "priceVersionId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'pending_activation',
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "scheduledChange" JSONB,
    "graceEndsAt" TIMESTAMP(3),
    "mandateId" UUID,
    "sourceOrderItemId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenewalRun" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "paymentRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RenewalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "displayName" TEXT NOT NULL,
    "status" "ServiceStatus" NOT NULL DEFAULT 'pending',
    "supplierExpiresAt" TIMESTAMP(3),
    "autoRenew" BOOLEAN NOT NULL DEFAULT false,
    "importedFromLegacy" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entitlement" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "featureKey" TEXT NOT NULL,
    "limit" BIGINT,
    "mergePolicy" "MergePolicy" NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "planVersionId" UUID,
    "reservationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "limit" BIGINT NOT NULL,
    "used" BIGINT NOT NULL DEFAULT 0,
    "reserved" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageReservation" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "counterId" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "settledQuantity" BIGINT,
    "status" "ReservationStatus" NOT NULL DEFAULT 'reserved',
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisioningJob" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "orderItemId" UUID,
    "adapterKey" TEXT NOT NULL,
    "status" "ProvisioningStatus" NOT NULL DEFAULT 'queued',
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProvisioningJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisioningStep" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ProvisioningStatus" NOT NULL DEFAULT 'queued',
    "evidence" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ProvisioningStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierOperation" (
    "id" UUID NOT NULL,
    "operationKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "chargeable" BOOLEAN NOT NULL,
    "status" "SupplierOperationStatus" NOT NULL DEFAULT 'pending',
    "requestRedacted" JSONB NOT NULL,
    "responseRedacted" JSONB,
    "providerRef" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookInbox" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "eventType" TEXT,
    "rawBody" BYTEA NOT NULL,
    "headers" JSONB NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "status" "InboxStatus" NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "aggregateId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppAdapter" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contractVersion" TEXT NOT NULL DEFAULT '2026-09',
    "baseUrl" TEXT,
    "authRef" TEXT,
    "status" "AdapterStatus" NOT NULL DEFAULT 'unconfigured',
    "lastHealthAt" TIMESTAMP(3),
    "lastHealthOk" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppAdapter_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ConnectorGrant" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "scopes" TEXT[],
    "tokenEnc" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "ConnectorGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "agentRunId" TEXT,
    "actionType" TEXT NOT NULL,
    "actionHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "actorType" TEXT NOT NULL,
    "orgId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'open',
    "category" TEXT,
    "serviceId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserToken_tokenHash_key" ON "UserToken"("tokenHash");

-- CreateIndex
CREATE INDEX "UserToken_userId_purpose_idx" ON "UserToken"("userId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_orgId_userId_key" ON "Membership"("orgId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_orgId_email_idx" ON "Invitation"("orgId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCustomerMapping_provider_providerCustomerId_key" ON "ProviderCustomerMapping"("provider", "providerCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCustomerMapping_orgId_provider_key" ON "ProviderCustomerMapping"("orgId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "Product_key_key" ON "Product"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_key_key" ON "Plan"("key");

-- CreateIndex
CREATE UNIQUE INDEX "PlanVersion_planId_version_key" ON "PlanVersion"("planId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PlanFeature_planVersionId_featureKey_key" ON "PlanFeature"("planVersionId", "featureKey");

-- CreateIndex
CREATE UNIQUE INDEX "BundleComponent_bundleVersionId_componentVersionId_key" ON "BundleComponent"("bundleVersionId", "componentVersionId");

-- CreateIndex
CREATE INDEX "PriceVersion_planVersionId_kind_currency_billingInterval_idx" ON "PriceVersion"("planVersionId", "kind", "currency", "billingInterval");

-- CreateIndex
CREATE INDEX "TaxRule_taxCategory_supplyType_idx" ON "TaxRule"("taxCategory", "supplyType");

-- CreateIndex
CREATE INDEX "Quote_orgId_status_idx" ON "Quote"("orgId", "status");

-- CreateIndex
CREATE INDEX "Order_orgId_status_idx" ON "Order"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orgId_idempotencyKey_key" ON "Order"("orgId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_number_key" ON "CreditNote"("number");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentOrder_providerOrderId_key" ON "PaymentOrder"("providerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_providerPaymentId_key" ON "PaymentAttempt"("providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_refundRequestId_key" ON "Refund"("refundRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_providerRefundId_key" ON "Refund"("providerRefundId");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_providerDisputeId_key" ON "Dispute"("providerDisputeId");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_providerSettlementId_key" ON "Settlement"("providerSettlementId");

-- CreateIndex
CREATE UNIQUE INDEX "Mandate_providerSubscriptionId_key" ON "Mandate"("providerSubscriptionId");

-- CreateIndex
CREATE INDEX "Subscription_orgId_status_idx" ON "Subscription"("orgId", "status");

-- CreateIndex
CREATE INDEX "Subscription_currentPeriodEnd_idx" ON "Subscription"("currentPeriodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "RenewalRun_subscriptionId_periodStart_key" ON "RenewalRun"("subscriptionId", "periodStart");

-- CreateIndex
CREATE INDEX "Service_orgId_idx" ON "Service"("orgId");

-- CreateIndex
CREATE INDEX "Service_supplierExpiresAt_idx" ON "Service"("supplierExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Service_provider_providerOrderId_key" ON "Service"("provider", "providerOrderId");

-- CreateIndex
CREATE INDEX "Entitlement_orgId_featureKey_idx" ON "Entitlement"("orgId", "featureKey");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_orgId_featureKey_sourceType_sourceId_key" ON "Entitlement"("orgId", "featureKey", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "UsageEvent_orgId_resource_occurredAt_idx" ON "UsageEvent"("orgId", "resource", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_source_sourceEventId_key" ON "UsageEvent"("source", "sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_orgId_resource_periodStart_key" ON "UsageCounter"("orgId", "resource", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "UsageReservation_idempotencyKey_key" ON "UsageReservation"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProvisioningJob_idempotencyKey_key" ON "ProvisioningJob"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProvisioningStep_jobId_name_key" ON "ProvisioningStep"("jobId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierOperation_operationKey_key" ON "SupplierOperation"("operationKey");

-- CreateIndex
CREATE INDEX "SupplierOperation_status_idx" ON "SupplierOperation"("status");

-- CreateIndex
CREATE INDEX "WebhookInbox_status_receivedAt_idx" ON "WebhookInbox"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookInbox_provider_channel_dedupeKey_key" ON "WebhookInbox"("provider", "channel", "dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_idx" ON "OutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_scope_key_key" ON "IdempotencyRecord"("scope", "key");

-- CreateIndex
CREATE INDEX "ConnectorGrant_orgId_provider_idx" ON "ConnectorGrant"("orgId", "provider");

-- CreateIndex
CREATE INDEX "ApprovalRequest_orgId_status_idx" ON "ApprovalRequest"("orgId", "status");

-- CreateIndex
CREATE INDEX "AuditEvent_orgId_createdAt_idx" ON "AuditEvent"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicket_orgId_status_idx" ON "SupportTicket"("orgId", "status");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserToken" ADD CONSTRAINT "UserToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCustomerMapping" ADD CONSTRAINT "ProviderCustomerMapping_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanVersion" ADD CONSTRAINT "PlanVersion_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanFeature" ADD CONSTRAINT "PlanFeature_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanFeature" ADD CONSTRAINT "PlanFeature_featureKey_fkey" FOREIGN KEY ("featureKey") REFERENCES "Feature"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleComponent" ADD CONSTRAINT "BundleComponent_bundleVersionId_fkey" FOREIGN KEY ("bundleVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleComponent" ADD CONSTRAINT "BundleComponent_componentVersionId_fkey" FOREIGN KEY ("componentVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceVersion" ADD CONSTRAINT "PriceVersion_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_paymentOrderId_fkey" FOREIGN KEY ("paymentOrderId") REFERENCES "PaymentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentOrderId_fkey" FOREIGN KEY ("paymentOrderId") REFERENCES "PaymentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "Mandate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenewalRun" ADD CONSTRAINT "RenewalRun_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageReservation" ADD CONSTRAINT "UsageReservation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningJob" ADD CONSTRAINT "ProvisioningJob_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningJob" ADD CONSTRAINT "ProvisioningJob_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningStep" ADD CONSTRAINT "ProvisioningStep_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProvisioningJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorGrant" ADD CONSTRAINT "ConnectorGrant_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
