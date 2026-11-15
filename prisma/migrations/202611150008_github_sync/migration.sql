BEGIN;
ALTER TABLE "Issue" ADD COLUMN "syncVersion" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "lastSyncedAt" TIMESTAMP(3);
ALTER TABLE "SyncJob" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "nextRetryAt" TIMESTAMP(3), ADD COLUMN "lastError" TEXT,
 ADD COLUMN "processedAt" TIMESTAMP(3),
 ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_retry_count_check" CHECK ("retryCount" BETWEEN 0 AND 5),
 ADD CONSTRAINT "SyncJob_status_check" CHECK (status IN ('PENDING','PROCESSING','RETRY_WAIT','SUCCEEDED','FAILED')),
 ADD CONSTRAINT "SyncJob_operation_check" CHECK (operation IN ('CREATE','UPDATE'));
CREATE INDEX "SyncJob_status_nextRetryAt_idx" ON "SyncJob"(status,"nextRetryAt");
CREATE INDEX "SyncJob_repositoryId_status_idx" ON "SyncJob"("repositoryId",status);
-- Keep all historical rows; only the oldest active request for each issue needs processing.
WITH ranked AS (SELECT id, row_number() OVER (PARTITION BY "issueId" ORDER BY "createdAt",id) n
 FROM "SyncJob" WHERE status IN ('PENDING','PROCESSING','RETRY_WAIT'))
UPDATE "SyncJob" SET status='SUCCEEDED',"processedAt"=CURRENT_TIMESTAMP
 WHERE id IN (SELECT id FROM ranked WHERE n>1);
CREATE UNIQUE INDEX "SyncJob_one_active_issue" ON "SyncJob"("issueId")
 WHERE status IN ('PENDING','PROCESSING','RETRY_WAIT');
CREATE TABLE "WebhookEvent" (
 id TEXT PRIMARY KEY, "repositoryId" TEXT NOT NULL REFERENCES "Repository"(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "githubDeliveryId" TEXT NOT NULL UNIQUE,"eventType" TEXT NOT NULL,
 "processedAt" TIMESTAMP(3),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "WebhookEvent_repositoryId_createdAt_idx" ON "WebhookEvent"("repositoryId","createdAt");
-- Recover pending local work even when an older deployment did not create its outbox row.
INSERT INTO "SyncJob" (id,"repositoryId","issueId",operation,status,"idempotencyKey")
 SELECT gen_random_uuid()::text,i."repoId",i.id,
 CASE WHEN i."githubId" IS NULL THEN 'CREATE' ELSE 'UPDATE' END,'PENDING','m5-backfill:'||i.id
 FROM "Issue" i WHERE i."syncStatus"='PENDING_SYNC'
 AND NOT EXISTS (SELECT 1 FROM "SyncJob" j WHERE j."issueId"=i.id AND j.status IN ('PENDING','PROCESSING','RETRY_WAIT'));
COMMIT;
