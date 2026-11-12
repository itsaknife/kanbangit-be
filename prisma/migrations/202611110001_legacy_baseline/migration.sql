CREATE EXTENSION IF NOT EXISTS vector;
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "IssueState" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('todo', 'in_progress', 'done');

-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL,
    "login" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "description" TEXT,
    "isPrivate" BOOLEAN NOT NULL,
    "webhookId" BIGINT,
    "connectedById" INTEGER NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" SERIAL NOT NULL,
    "githubId" BIGINT NOT NULL,
    "repoId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "state" "IssueState" NOT NULL,
    "status" "IssueStatus" NOT NULL,
    "labels" JSONB NOT NULL DEFAULT '[]',
    "assignees" JSONB NOT NULL DEFAULT '[]',
    "authorLogin" TEXT,
    "authorAvatar" TEXT,
    "htmlUrl" TEXT NOT NULL,
    "githubUpdatedAt" TIMESTAMP(3) NOT NULL,
    "githubCreatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "embedding" vector(768),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklySummary" (
    "id" SERIAL NOT NULL,
    "repoId" INTEGER NOT NULL,
    "weekStart" TEXT NOT NULL,
    "weekEnd" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeeklySummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_login_key" ON "User"("login");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_fullName_key" ON "Repository"("fullName");

-- CreateIndex
CREATE INDEX "Issue_repoId_status_idx" ON "Issue"("repoId", "status");

-- CreateIndex
CREATE INDEX "Issue_repoId_closedAt_idx" ON "Issue"("repoId", "closedAt");

-- CreateIndex
CREATE INDEX "Issue_repoId_dueDate_idx" ON "Issue"("repoId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_repoId_number_key" ON "Issue"("repoId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_githubId_key" ON "Issue"("githubId");

-- CreateIndex
CREATE INDEX "WeeklySummary_repoId_createdAt_idx" ON "WeeklySummary"("repoId", "createdAt");

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklySummary" ADD CONSTRAINT "WeeklySummary_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklySummary" ADD CONSTRAINT "WeeklySummary_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
