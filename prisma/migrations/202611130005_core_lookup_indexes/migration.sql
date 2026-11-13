-- Repository membership lookup and active tracker selection (Spec 23).
CREATE INDEX "RepositoryMember_repositoryId_login_idx" ON "RepositoryMember"("repositoryId", "login");
CREATE INDEX "Tracker_repositoryId_isActive_idx" ON "Tracker"("repositoryId", "isActive");
