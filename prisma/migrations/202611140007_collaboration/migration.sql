CREATE TABLE "Worklog" (
  "id" TEXT NOT NULL PRIMARY KEY, "issueId" TEXT NOT NULL REFERENCES "Issue"("id") ON DELETE CASCADE,
  "memberId" TEXT NOT NULL REFERENCES "RepositoryMember"("id") ON DELETE RESTRICT,
  "githubUserId" BIGINT NOT NULL, "startAt" TIMESTAMPTZ(3) NOT NULL, "endAt" TIMESTAMPTZ(3) NOT NULL,
  "durationMinutes" DOUBLE PRECISION NOT NULL, "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Worklog_positive_range" CHECK ("endAt" > "startAt")
);
CREATE INDEX "Worklog_issueId_startAt_idx" ON "Worklog"("issueId","startAt");
CREATE INDEX "Worklog_memberId_startAt_idx" ON "Worklog"("memberId","startAt");
CREATE INDEX "Worklog_githubUserId_startAt_endAt_idx" ON "Worklog"("githubUserId","startAt","endAt");

-- A stable GitHub identity serializes writes across all repository memberships.
-- Trigger also protects direct database writes; no btree_gist extension required.
CREATE FUNCTION validate_worklog() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member_github BIGINT; member_repo TEXT; issue_repo TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."memberId" <> OLD."memberId" OR NEW."issueId" <> OLD."issueId") THEN
    RAISE EXCEPTION 'WORKLOG_AUTHOR_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  SELECT "githubUserId", "repositoryId" INTO member_github, member_repo FROM "RepositoryMember" WHERE id=NEW."memberId";
  SELECT "repoId" INTO issue_repo FROM "Issue" WHERE id=NEW."issueId";
  IF member_repo IS DISTINCT FROM issue_repo OR member_github IS NULL THEN
    RAISE EXCEPTION 'WORKLOG_REPOSITORY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  NEW."githubUserId" := member_github;
  PERFORM pg_advisory_xact_lock(member_github);
  IF NEW."endAt" <= NEW."startAt" OR NEW."startAt" > statement_timestamp() OR NEW."endAt" > statement_timestamp() THEN
    RAISE EXCEPTION 'WORKLOG_INVALID_TIME' USING ERRCODE = '23514';
  END IF;
  IF EXISTS(SELECT 1 FROM "Worklog" w WHERE w."githubUserId"=member_github AND w.id<>NEW.id
    AND w."startAt"<NEW."endAt" AND w."endAt">NEW."startAt") THEN
    RAISE EXCEPTION 'WORKLOG_OVERLAP' USING ERRCODE = '23P01';
  END IF;
  NEW."durationMinutes" := EXTRACT(EPOCH FROM (NEW."endAt"-NEW."startAt"))/60.0;
  RETURN NEW;
END $$;
CREATE TRIGGER worklog_validation BEFORE INSERT OR UPDATE ON "Worklog" FOR EACH ROW EXECUTE FUNCTION validate_worklog();

CREATE TABLE "Comment" (
  "id" TEXT NOT NULL PRIMARY KEY, "issueId" TEXT NOT NULL REFERENCES "Issue"("id") ON DELETE CASCADE,
  "authorId" TEXT NOT NULL REFERENCES "RepositoryMember"("id") ON DELETE RESTRICT,
  "content" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "Comment_issueId_createdAt_idx" ON "Comment"("issueId","createdAt");
CREATE TABLE "CommentMention" (
  "id" TEXT NOT NULL PRIMARY KEY, "commentId" TEXT NOT NULL REFERENCES "Comment"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "CommentMention_commentId_userId_key" ON "CommentMention"("commentId","userId");
CREATE TABLE "Attachment" (
  "id" TEXT NOT NULL PRIMARY KEY, "commentId" TEXT NOT NULL REFERENCES "Comment"("id") ON DELETE CASCADE,
  "fileName" TEXT NOT NULL, "mimeType" TEXT NOT NULL, "fileSize" INTEGER NOT NULL,
  "storageKey" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Attachment_size" CHECK ("fileSize">0 AND "fileSize"<=2097152)
);
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");
CREATE INDEX "Attachment_commentId_idx" ON "Attachment"("commentId");
CREATE TABLE "Notification" (
  "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "repositoryId" TEXT NOT NULL REFERENCES "Repository"("id") ON DELETE CASCADE,
  "issueId" TEXT NOT NULL REFERENCES "Issue"("id") ON DELETE CASCADE,
  "commentId" TEXT NOT NULL REFERENCES "Comment"("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL DEFAULT 'MENTION', "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Notification_commentId_userId_key" ON "Notification"("commentId","userId");
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId","createdAt");
