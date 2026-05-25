-- AlterTable
ALTER TABLE "Interview" ADD COLUMN     "githubCommitsData" JSONB,
ADD COLUMN     "githubRepo" TEXT,
ADD COLUMN     "githubUsername" TEXT,
ADD COLUMN     "problemStatementText" TEXT;
