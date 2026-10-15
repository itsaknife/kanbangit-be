-- Chạy một lần sau khi tạo bảng: npm run db:vector-index
-- Index giúp tìm issue gần giống nhanh hơn khi có nhiều issue (cosine distance).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE INDEX IF NOT EXISTS "Issue_embedding_idx"
  ON "Issue" USING hnsw (embedding vector_cosine_ops);
