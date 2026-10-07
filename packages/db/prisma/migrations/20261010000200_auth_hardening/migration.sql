-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "mfaFailures" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "failedLogins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loginLockedUntil" TIMESTAMP(3),
ADD COLUMN     "mfaLastStep" INTEGER;
