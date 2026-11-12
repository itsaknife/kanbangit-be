BEGIN;
-- Keep legacy identifiers as mappings; no application rows or vectors are deleted.
ALTER TABLE "Repository" DROP CONSTRAINT "Repository_connectedById_fkey";
ALTER TABLE "Issue" DROP CONSTRAINT "Issue_repoId_fkey";
ALTER TABLE "WeeklySummary" DROP CONSTRAINT "WeeklySummary_repoId_fkey";
ALTER TABLE "WeeklySummary" DROP CONSTRAINT "WeeklySummary_createdById_fkey";
ALTER TABLE "RepositoryMember" DROP CONSTRAINT "RepositoryMember_repositoryId_fkey";
ALTER TABLE "RepositoryMember" DROP CONSTRAINT "RepositoryMember_userId_fkey";
ALTER TABLE "Tracker" DROP CONSTRAINT "Tracker_repositoryId_fkey";

ALTER TABLE "User" RENAME COLUMN id TO "legacyId";
ALTER TABLE "User" DROP CONSTRAINT "User_pkey";
ALTER TABLE "User" ADD COLUMN id TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "User" ADD COLUMN "githubId" BIGINT;
UPDATE "User" SET "githubId"="legacyId";
ALTER TABLE "User" ALTER COLUMN "githubId" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "legacyId" DROP NOT NULL;
ALTER TABLE "User" ADD CONSTRAINT "User_pkey" PRIMARY KEY(id);
CREATE UNIQUE INDEX "User_legacyId_key" ON "User"("legacyId");
CREATE UNIQUE INDEX "User_githubId_key" ON "User"("githubId");

ALTER TABLE "Repository" RENAME COLUMN id TO "legacyId";
ALTER TABLE "Repository" DROP CONSTRAINT "Repository_pkey";
ALTER TABLE "Repository" ADD COLUMN id TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "Repository" ADD COLUMN "githubId" BIGINT;
UPDATE "Repository" SET "githubId"="legacyId";
ALTER TABLE "Repository" ALTER COLUMN "githubId" SET NOT NULL;
ALTER TABLE "Repository" ALTER COLUMN "legacyId" DROP NOT NULL;
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_pkey" PRIMARY KEY(id);
CREATE UNIQUE INDEX "Repository_legacyId_key" ON "Repository"("legacyId");
CREATE UNIQUE INDEX "Repository_githubId_key" ON "Repository"("githubId");

ALTER TABLE "Issue" RENAME COLUMN id TO "legacyId";
ALTER TABLE "Issue" DROP CONSTRAINT "Issue_pkey";
ALTER TABLE "Issue" ADD COLUMN id TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "Issue" ALTER COLUMN "legacyId" DROP NOT NULL;
ALTER TABLE "Issue" ALTER COLUMN "legacyId" DROP DEFAULT;
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_pkey" PRIMARY KEY(id);
CREATE UNIQUE INDEX "Issue_legacyId_key" ON "Issue"("legacyId");

ALTER TABLE "WeeklySummary" RENAME COLUMN id TO "legacyId";
ALTER TABLE "WeeklySummary" DROP CONSTRAINT "WeeklySummary_pkey";
ALTER TABLE "WeeklySummary" ADD COLUMN id TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "WeeklySummary" ALTER COLUMN "legacyId" DROP NOT NULL;
ALTER TABLE "WeeklySummary" ALTER COLUMN "legacyId" DROP DEFAULT;
ALTER TABLE "WeeklySummary" ADD CONSTRAINT "WeeklySummary_pkey" PRIMARY KEY(id);
CREATE UNIQUE INDEX "WeeklySummary_legacyId_key" ON "WeeklySummary"("legacyId");
ALTER TABLE "User" ALTER COLUMN id DROP DEFAULT;
ALTER TABLE "Repository" ALTER COLUMN id DROP DEFAULT;
ALTER TABLE "Issue" ALTER COLUMN id DROP DEFAULT;
ALTER TABLE "WeeklySummary" ALTER COLUMN id DROP DEFAULT;

ALTER TABLE "Repository" ALTER COLUMN "connectedById" TYPE TEXT USING "connectedById"::text;
UPDATE "Repository" r SET "connectedById"=u.id FROM "User" u WHERE r."connectedById"=u."legacyId"::text;
ALTER TABLE "Issue" ALTER COLUMN "repoId" TYPE TEXT USING "repoId"::text;
UPDATE "Issue" i SET "repoId"=r.id FROM "Repository" r WHERE i."repoId"=r."legacyId"::text;
ALTER TABLE "WeeklySummary" ALTER COLUMN "repoId" TYPE TEXT USING "repoId"::text;
UPDATE "WeeklySummary" s SET "repoId"=r.id FROM "Repository" r WHERE s."repoId"=r."legacyId"::text;
ALTER TABLE "WeeklySummary" ALTER COLUMN "createdById" TYPE TEXT USING "createdById"::text;
UPDATE "WeeklySummary" s SET "createdById"=u.id FROM "User" u WHERE s."createdById"=u."legacyId"::text;
ALTER TABLE "RepositoryMember" ALTER COLUMN "repositoryId" TYPE TEXT USING "repositoryId"::text;
UPDATE "RepositoryMember" m SET "repositoryId"=r.id FROM "Repository" r WHERE m."repositoryId"=r."legacyId"::text;
ALTER TABLE "RepositoryMember" ALTER COLUMN "userId" TYPE TEXT USING "userId"::text;
UPDATE "RepositoryMember" m SET "userId"=u.id FROM "User" u WHERE m."userId"=u."legacyId"::text;
ALTER TABLE "Tracker" ALTER COLUMN "repositoryId" TYPE TEXT USING "repositoryId"::text;
UPDATE "Tracker" t SET "repositoryId"=r.id FROM "Repository" r WHERE t."repositoryId"=r."legacyId"::text;

ALTER TABLE "Repository" ADD CONSTRAINT "Repository_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repository"(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WeeklySummary" ADD CONSTRAINT "WeeklySummary_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repository"(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WeeklySummary" ADD CONSTRAINT "WeeklySummary_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RepositoryMember" ADD CONSTRAINT "RepositoryMember_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepositoryMember" ADD CONSTRAINT "RepositoryMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Tracker" ADD CONSTRAINT "Tracker_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"(id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TrackerPrefix" (
  id TEXT NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  "repositoryId" TEXT NOT NULL REFERENCES "Repository"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "trackerId" TEXT NOT NULL REFERENCES "Tracker"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  prefix TEXT NOT NULL
);
CREATE UNIQUE INDEX "TrackerPrefix_repositoryId_prefix_key" ON "TrackerPrefix"("repositoryId",prefix);
CREATE UNIQUE INDEX "RepositoryMember_one_active_owner" ON "RepositoryMember"("repositoryId") WHERE role='OWNER' AND "isActive"=true;
INSERT INTO "TrackerPrefix"("repositoryId","trackerId",prefix) SELECT "repositoryId",id,prefix FROM "Tracker";
ALTER TABLE "TrackerPrefix" ALTER COLUMN id DROP DEFAULT;

ALTER TABLE "Issue" ADD COLUMN "trackerId" TEXT, ADD COLUMN "issueCode" TEXT;
-- Import old issues into the default Task tracker, ordered deterministically.
WITH numbered AS (
 SELECT i.id,t.id AS tracker,t.prefix,row_number() OVER (PARTITION BY i."repoId" ORDER BY i."githubCreatedAt",i.number,i."legacyId") AS seq
 FROM "Issue" i JOIN "Tracker" t ON t."repositoryId"=i."repoId" AND t.prefix='TASK'
)
UPDATE "Issue" i SET "trackerId"=n.tracker,"issueCode"=n.prefix||'-'||lpad(n.seq::text,greatest(3,length(n.seq::text)),'0') FROM numbered n WHERE i.id=n.id;
UPDATE "Tracker" t SET "nextSequence"=coalesce((SELECT count(*)+1 FROM "Issue" i WHERE i."trackerId"=t.id),1);
ALTER TABLE "Issue" ALTER COLUMN "trackerId" SET NOT NULL, ALTER COLUMN "issueCode" SET NOT NULL;
CREATE UNIQUE INDEX "Tracker_id_repositoryId_key" ON "Tracker"(id,"repositoryId");
CREATE UNIQUE INDEX "Issue_repoId_issueCode_key" ON "Issue"("repoId","issueCode");
CREATE INDEX "Issue_repoId_trackerId_idx" ON "Issue"("repoId","trackerId");
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_trackerId_repoId_fkey" FOREIGN KEY ("trackerId","repoId") REFERENCES "Tracker"(id,"repositoryId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Tracker" ADD CONSTRAINT "Tracker_nextSequence_check" CHECK ("nextSequence">0);
CREATE FUNCTION preserve_issue_code() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."issueCode" IS DISTINCT FROM OLD."issueCode" THEN RAISE EXCEPTION 'Issue Code is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Issue_code_immutable" BEFORE UPDATE ON "Issue" FOR EACH ROW EXECUTE FUNCTION preserve_issue_code();
COMMIT;
