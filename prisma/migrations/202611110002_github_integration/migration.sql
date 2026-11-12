-- CreateEnum
CREATE TYPE "RepositoryRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "GithubPermission" AS ENUM ('ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "importCompleted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "RepositoryMember" (
    "id" TEXT NOT NULL,
    "repositoryId" INTEGER NOT NULL,
    "githubUserId" BIGINT NOT NULL,
    "login" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "githubPermission" "GithubPermission" NOT NULL DEFAULT 'UNKNOWN',
    "userId" INTEGER,
    "role" "RepositoryRole" NOT NULL DEFAULT 'MEMBER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepositoryMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tracker" (
    "id" TEXT NOT NULL,
    "repositoryId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "nextSequence" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tracker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RepositoryMember_userId_idx" ON "RepositoryMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryMember_repositoryId_githubUserId_key" ON "RepositoryMember"("repositoryId", "githubUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Tracker_repositoryId_name_key" ON "Tracker"("repositoryId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Tracker_repositoryId_prefix_key" ON "Tracker"("repositoryId", "prefix");

-- AddForeignKey
ALTER TABLE "RepositoryMember" ADD CONSTRAINT "RepositoryMember_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryMember" ADD CONSTRAINT "RepositoryMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tracker" ADD CONSTRAINT "Tracker_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve legacy repositories and bootstrap only identities already known locally.
UPDATE "Repository" SET "importCompleted" = ("webhookId" IS NOT NULL);
INSERT INTO "RepositoryMember" ("id","repositoryId","githubUserId","login","avatarUrl","userId","role","updatedAt")
SELECT gen_random_uuid()::text,r.id,u.id::bigint,u.login,u."avatarUrl",u.id,
CASE WHEN lower(u.login)=lower(r.owner) THEN 'OWNER'::"RepositoryRole" ELSE 'MEMBER'::"RepositoryRole" END,CURRENT_TIMESTAMP
FROM "Repository" r JOIN "User" u ON u.id=r."connectedById" OR lower(u.login)=lower(r.owner)
WHERE true
ON CONFLICT ("repositoryId","githubUserId") DO NOTHING;

INSERT INTO "Tracker" ("id","repositoryId","name","prefix","color","displayOrder","updatedAt")
SELECT gen_random_uuid()::text,r.id,t.name,t.prefix,t.color,t.sort,CURRENT_TIMESTAMP
FROM "Repository" r CROSS JOIN (VALUES
('Bug','BUG','#EF4444',0),('Feature','FEAT','#3B82F6',1),('Task','TASK','#64748B',2),
('Enhancement','ENH','#8B5CF6',3),('Spec Analytics','SPEC','#F59E0B',4),('Release','REL','#10B981',5)
) t(name,prefix,color,sort)
WHERE true
ON CONFLICT ("repositoryId","prefix") DO NOTHING;
