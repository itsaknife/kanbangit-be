// Runs real PostgreSQL migrations in a unique schema, always rolled back.
// It never migrates application tables or reads application row data.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { parse } from 'dotenv';
import assert from 'node:assert/strict';

const config = { ...parse(readFileSync(new URL('../.env', import.meta.url))), ...process.env };
const client = new Client({
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  statement_timeout: 15000,
});
const schema = `m1_verify_${randomUUID().replaceAll('-', '')}`;
let phase = 'connect';
try {
  await client.connect();
  const extension = await client.query(
    "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE extname='vector'",
  );
  assert.equal(extension.rowCount, 1, 'Existing vector extension required');
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA "${schema}"`);
  const vectorSchema = extension.rows[0].nspname.replaceAll('"', '""');
  await client.query(`SET LOCAL search_path TO "${schema}", public, "${vectorSchema}"`);
  phase = 'baseline';
  await client.query(
    readFileSync(
      new URL('../prisma/migrations/202611110001_legacy_baseline/migration.sql', import.meta.url),
      'utf8',
    ),
  );
  phase = 'legacy-fixtures';
  await client.query(`INSERT INTO "User" (id,login,"avatarUrl","accessToken","updatedAt") VALUES (1,'owner','avatar','fake-ciphertext',CURRENT_TIMESTAMP);
    INSERT INTO "Repository" (id,name,owner,"fullName","isPrivate","connectedById","webhookId") VALUES (100,'app','owner','owner/app',true,1,99);
    INSERT INTO "Issue" ("githubId","repoId",number,title,state,status,"htmlUrl","githubUpdatedAt","githubCreatedAt","updatedAt","dueDate")
    VALUES (999,100,1,'fixture','closed','done','url',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'2026-11-12');`);
  phase = 'm1-migration';
  await client.query(
    readFileSync(
      new URL(
        '../prisma/migrations/202611110002_github_integration/migration.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  phase = 'assertions';
  assert.equal((await client.query('SELECT count(*)::int n FROM "Tracker"')).rows[0].n, 6);
  const member = (await client.query('SELECT role,"githubUserId","userId" FROM "RepositoryMember"'))
    .rows[0];
  assert.equal(member.role, 'OWNER');
  assert.equal(member.githubUserId, '1');
  assert.equal(member.userId, 1);
  assert.equal(
    (await client.query('SELECT "importCompleted" FROM "Repository"')).rows[0].importCompleted,
    true,
  );
  assert.equal(
    (await client.query('SELECT title, "dueDate"::date::text AS "day" FROM "Issue"')).rows[0].day,
    '2026-11-12',
  );
  await client.query(
    `INSERT INTO "RepositoryMember" (id,"repositoryId","githubUserId",login,"updatedAt") VALUES ('unlinked',100,2,'guest',CURRENT_TIMESTAMP)`,
  );
  assert.equal(
    (await client.query(`SELECT "userId" FROM "RepositoryMember" WHERE id='unlinked'`)).rows[0]
      .userId,
    null,
  );
  await client.query('SAVEPOINT duplicate_check');
  await assert.rejects(
    client.query(
      `INSERT INTO "RepositoryMember" (id,"repositoryId","githubUserId",login,"updatedAt") VALUES ('duplicate',100,2,'guest',CURRENT_TIMESTAMP)`,
    ),
    (error) => error.code === '23505',
  );
  await client.query('ROLLBACK TO SAVEPOINT duplicate_check');
  await client.query('ROLLBACK');
  assert.equal(
    (await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount,
    0,
  );
  console.log(
    'PASS: baseline + M1 migration, legacy preservation, six trackers, Owner backfill, nullable member userId, identity uniqueness; isolated schema rolled back.',
  );
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(
    JSON.stringify({
      status: 'failed',
      phase,
      code: error.code ?? 'MIGRATION_VERIFICATION_FAILED',
      position: error.position,
    }),
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
