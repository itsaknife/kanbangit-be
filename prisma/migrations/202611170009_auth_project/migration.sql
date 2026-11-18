BEGIN;
CREATE TYPE "AuthProvider" AS ENUM ('GOOGLE','GITHUB');
CREATE TYPE "ProjectProvider" AS ENUM ('GITHUB','KANBANGIT');
CREATE TABLE "AuthIdentity" (
 "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 provider "AuthProvider" NOT NULL,"providerUserId" TEXT NOT NULL,email TEXT,"emailVerified" BOOLEAN NOT NULL DEFAULT false,
 login TEXT,"accessToken" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "AuthIdentity_provider_providerUserId_key" ON "AuthIdentity"(provider,"providerUserId");
CREATE UNIQUE INDEX "AuthIdentity_userId_provider_key" ON "AuthIdentity"("userId",provider);
CREATE INDEX "AuthIdentity_email_idx" ON "AuthIdentity"(email);
INSERT INTO "AuthIdentity"(id,"userId",provider,"providerUserId",login,"accessToken","createdAt","updatedAt")
 SELECT gen_random_uuid()::text,id,'GITHUB',"githubId"::text,login,"accessToken","createdAt","updatedAt" FROM "User";
ALTER TABLE "User" ALTER COLUMN "githubId" DROP NOT NULL, ALTER COLUMN "accessToken" DROP NOT NULL;
-- Legacy encrypted tokens are retained for rollback only; all runtime access uses AuthIdentity.
ALTER TABLE "Repository" ADD COLUMN "providerType" "ProjectProvider" NOT NULL DEFAULT 'GITHUB';
ALTER TABLE "Repository" ALTER COLUMN "githubId" DROP NOT NULL, ALTER COLUMN owner DROP NOT NULL, ALTER COLUMN "isPrivate" DROP NOT NULL;
DROP INDEX "Repository_fullName_key";
CREATE UNIQUE INDEX "Repository_github_fullName_key" ON "Repository"("fullName") WHERE "providerType"='GITHUB';
ALTER TABLE "Repository" ADD CONSTRAINT "Project_provider_metadata" CHECK (
 ("providerType"='GITHUB' AND "githubId" IS NOT NULL AND owner IS NOT NULL AND "isPrivate" IS NOT NULL) OR
 ("providerType"='KANBANGIT' AND "githubId" IS NULL AND owner IS NULL AND "isPrivate" IS NULL AND "webhookId" IS NULL));
ALTER TABLE "RepositoryMember" ALTER COLUMN "githubUserId" DROP NOT NULL;
ALTER TABLE "Worklog" ALTER COLUMN "githubUserId" DROP NOT NULL;
CREATE UNIQUE INDEX "RepositoryMember_projectId_userId_key" ON "RepositoryMember"("repositoryId","userId");
ALTER TABLE "Worklog" ADD COLUMN "personKey" TEXT NOT NULL DEFAULT '';
UPDATE "Worklog" w SET "personKey"=COALESCE(m."userId",'github:'||m."githubUserId"::text) FROM "RepositoryMember" m WHERE m.id=w."memberId";
ALTER TABLE "RepositoryMember" RENAME COLUMN "repositoryId" TO "projectId";
ALTER TABLE "Tracker" RENAME COLUMN "repositoryId" TO "projectId";
ALTER TABLE "TrackerPrefix" RENAME COLUMN "repositoryId" TO "projectId";
ALTER TABLE "Issue" RENAME COLUMN "repoId" TO "projectId";
ALTER TABLE "WeeklySummary" RENAME COLUMN "repoId" TO "projectId";
ALTER TABLE "SyncJob" RENAME COLUMN "repositoryId" TO "projectId";
ALTER TABLE "WebhookEvent" RENAME COLUMN "repositoryId" TO "projectId";
ALTER TABLE "Notification" RENAME COLUMN "repositoryId" TO "projectId";
CREATE OR REPLACE FUNCTION validate_worklog() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member_person TEXT; member_github BIGINT; member_project TEXT; issue_project TEXT;
BEGIN
 IF TG_OP='UPDATE' AND (NEW."memberId"<>OLD."memberId" OR NEW."issueId"<>OLD."issueId") THEN RAISE EXCEPTION 'WORKLOG_AUTHOR_IMMUTABLE' USING ERRCODE='23514'; END IF;
 SELECT COALESCE("userId",'github:'||"githubUserId"::text),"githubUserId","projectId" INTO member_person,member_github,member_project FROM "RepositoryMember" WHERE id=NEW."memberId";
 SELECT "projectId" INTO issue_project FROM "Issue" WHERE id=NEW."issueId";
 IF member_person IS NULL OR member_project IS DISTINCT FROM issue_project THEN RAISE EXCEPTION 'WORKLOG_REPOSITORY_MISMATCH' USING ERRCODE='23514'; END IF;
 NEW."personKey":=member_person;NEW."githubUserId":=member_github;
 PERFORM pg_advisory_xact_lock(hashtextextended(member_person,0));
 IF NEW."endAt"<=NEW."startAt" OR NEW."endAt">statement_timestamp() OR NEW."startAt">statement_timestamp() THEN RAISE EXCEPTION 'WORKLOG_INVALID_TIME' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM "Worklog" w WHERE w."personKey"=member_person AND w.id<>NEW.id AND w."startAt"<NEW."endAt" AND w."endAt">NEW."startAt") THEN RAISE EXCEPTION 'WORKLOG_OVERLAP' USING ERRCODE='23P01'; END IF;
 NEW."durationMinutes":=EXTRACT(EPOCH FROM (NEW."endAt"-NEW."startAt"))/60.0;RETURN NEW;
END $$;
CREATE FUNCTION guard_project_provider() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind "ProjectProvider";
BEGIN
 SELECT "providerType" INTO kind FROM "Repository" WHERE id=NEW."projectId";
 IF kind='KANBANGIT' THEN
  IF TG_TABLE_NAME IN ('SyncJob','WebhookEvent') THEN RAISE EXCEPTION 'LOCAL_PROJECT_NO_GITHUB'; END IF;
  IF TG_TABLE_NAME='Issue' AND (to_jsonb(NEW)->>'githubId' IS NOT NULL OR to_jsonb(NEW)->>'number' IS NOT NULL OR to_jsonb(NEW)->>'htmlUrl' IS NOT NULL) THEN RAISE EXCEPTION 'LOCAL_ISSUE_NO_GITHUB'; END IF;
  IF TG_TABLE_NAME='RepositoryMember' AND (to_jsonb(NEW)->>'userId' IS NULL OR to_jsonb(NEW)->>'githubUserId' IS NOT NULL) THEN RAISE EXCEPTION 'LOCAL_MEMBER_REQUIRES_USER'; END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER local_issue_provider BEFORE INSERT OR UPDATE ON "Issue" FOR EACH ROW EXECUTE FUNCTION guard_project_provider();
CREATE TRIGGER local_member_provider BEFORE INSERT OR UPDATE ON "RepositoryMember" FOR EACH ROW EXECUTE FUNCTION guard_project_provider();
CREATE TRIGGER local_sync_provider BEFORE INSERT OR UPDATE ON "SyncJob" FOR EACH ROW EXECUTE FUNCTION guard_project_provider();
CREATE TRIGGER local_webhook_provider BEFORE INSERT OR UPDATE ON "WebhookEvent" FOR EACH ROW EXECUTE FUNCTION guard_project_provider();
COMMIT;
