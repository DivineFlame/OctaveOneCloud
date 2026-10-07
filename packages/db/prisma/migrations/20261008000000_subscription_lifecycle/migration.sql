-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "lastLifecycleError" TEXT,
ADD COLUMN     "lifecycleVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextLifecycleAttemptAt" TIMESTAMP(3),
ADD COLUMN     "pendingAction" TEXT,
ADD COLUMN     "pendingActionReason" TEXT,
ADD COLUMN     "suspendedAt" TIMESTAMP(3);
