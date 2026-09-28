-- CreateTable
CREATE TABLE "NotificationQueue" (
    "id" SERIAL NOT NULL,
    "petitionId" INTEGER NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationQueue_pkey" PRIMARY KEY ("id")
);
