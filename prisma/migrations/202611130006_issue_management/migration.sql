BEGIN;
ALTER TYPE "IssueStatus" RENAME TO "IssueStatus_legacy";
CREATE TYPE "IssueStatus" AS ENUM ('todo','in_progress','done','verified','closed','reopen','rejected','paused','canceled');
ALTER TABLE "Issue" ALTER COLUMN status TYPE "IssueStatus" USING
  (CASE WHEN state::text='closed' THEN 'closed' ELSE status::text END)::"IssueStatus";
DROP TYPE "IssueStatus_legacy";
CREATE TYPE "SyncStatus" AS ENUM ('PENDING_SYNC','SYNCED','NEEDS_ATTENTION');
ALTER TABLE "Issue"
  ALTER COLUMN "githubId" DROP NOT NULL,
  ALTER COLUMN number DROP NOT NULL,
  ALTER COLUMN "htmlUrl" DROP NOT NULL,
  ALTER COLUMN "githubCreatedAt" DROP NOT NULL,
  ALTER COLUMN "githubUpdatedAt" DROP NOT NULL,
  ADD COLUMN "startDate" DATE,
  ADD COLUMN "endDate" DATE,
  ADD COLUMN "estimateMinutes" INTEGER,
  ADD COLUMN "assigneeId" TEXT,
  ADD COLUMN "parentId" TEXT,
  ADD COLUMN "syncStatus" "SyncStatus" NOT NULL DEFAULT 'SYNCED';
-- Prisma DateTime is timestamp without time zone and stores UTC values.
UPDATE "Issue" SET "endDate"=("dueDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ho_Chi_Minh')::date WHERE "dueDate" IS NOT NULL;
-- Preserve the first legacy GitHub assignee as the single KanbanGit assignee.
UPDATE "Issue" i SET "assigneeId"=m.id FROM "RepositoryMember" m
WHERE m."repositoryId"=i."repoId" AND lower(m.login)=lower(i.assignees->0->>'login');
CREATE UNIQUE INDEX "RepositoryMember_id_repositoryId_key" ON "RepositoryMember"(id,"repositoryId");
CREATE UNIQUE INDEX "Issue_id_repoId_key" ON "Issue"(id,"repoId");
CREATE INDEX "Issue_repoId_endDate_idx" ON "Issue"("repoId","endDate");
CREATE INDEX "Issue_repoId_parentId_idx" ON "Issue"("repoId","parentId");
CREATE INDEX "Issue_repoId_assigneeId_idx" ON "Issue"("repoId","assigneeId");
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_assigneeId_repoId_fkey" FOREIGN KEY ("assigneeId","repoId") REFERENCES "RepositoryMember"(id,"repositoryId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_parentId_repoId_fkey" FOREIGN KEY ("parentId","repoId") REFERENCES "Issue"(id,"repoId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_estimate_step" CHECK ("estimateMinutes" IS NULL OR ("estimateMinutes">=0 AND "estimateMinutes"%30=0));
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_date_order" CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "startDate"<="endDate");
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_not_self_parent" CHECK ("parentId" IS NULL OR "parentId"<>id);
CREATE TABLE "IssueStatusHistory" (
 id TEXT NOT NULL PRIMARY KEY,"issueId" TEXT NOT NULL,"fromStatus" "IssueStatus","toStatus" "IssueStatus" NOT NULL,"changedById" TEXT,source TEXT NOT NULL DEFAULT 'APP',"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "IssueStatusHistory_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "IssueStatusHistory_issueId_createdAt_idx" ON "IssueStatusHistory"("issueId","createdAt");
ALTER TABLE "IssueStatusHistory" ADD CONSTRAINT "IssueStatusHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "RepositoryMember"(id) ON DELETE SET NULL ON UPDATE CASCADE;
INSERT INTO "IssueStatusHistory" (id,"issueId","toStatus",source,"createdAt") SELECT gen_random_uuid()::text,id,status,'SYSTEM',"updatedAt" FROM "Issue";
CREATE TABLE "SyncJob" (
 id TEXT NOT NULL PRIMARY KEY,"repositoryId" TEXT NOT NULL,"issueId" TEXT NOT NULL,operation TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',"idempotencyKey" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "SyncJob_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"(id) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "SyncJob_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SyncJob_idempotencyKey_key" ON "SyncJob"("idempotencyKey");
CREATE INDEX "SyncJob_issueId_status_idx" ON "SyncJob"("issueId",status);
COMMIT;
