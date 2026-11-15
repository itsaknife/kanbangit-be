// Backup/verify only: this script never applies a migration or calls GitHub.
import { Client } from 'pg';
import { parse } from 'dotenv';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const migration = '202611150008_github_sync';
const config = { ...parse(await readFile('.env')), ...process.env };
const fingerprint = createHash('sha256').update(config.DATABASE_URL).digest('hex');
const client = new Client({
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
});
const directory = resolve('../.migration-backups');
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const tables = (
    await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND tablename IN ('User','Repository','RepositoryMember','Tracker','TrackerPrefix','Issue','WeeklySummary',
    'IssueStatusHistory','SyncJob','Worklog','Comment','CommentMention','Attachment','Notification') ORDER BY tablename`)
  ).rows.map((r) => r.tablename);
  const rows = {};
  for (const table of tables)
    rows[table] = (
      await client.query('SELECT to_jsonb(t) AS row FROM public."' + table + '" t ORDER BY id')
    ).rows.map((r) => r.row);
  const history = (
    await client.query(
      'SELECT migration_name,finished_at,rolled_back_at FROM public._prisma_migrations ORDER BY started_at',
    )
  ).rows;
  if (process.argv[2] === '--verify') {
    const filename = process.argv[3];
    assert.match(filename ?? '', /^m5-before-\d+\.json$/);
    const before = JSON.parse(await readFile(resolve(directory, filename), 'utf8'));
    assert.equal(before.fingerprint, fingerprint);
    assert.ok(
      history.some((h) => h.migration_name === migration && h.finished_at && !h.rolled_back_at),
    );
    for (const table of tables) {
      const current = new Map(rows[table].map((row) => [row.id, row]));
      for (const previous of before.rows[table]) {
        const row = current.get(previous.id);
        assert.ok(row, table + ' row disappeared');
        // Migration adds columns; compare every pre-existing column and row.
        const projected = Object.fromEntries(Object.keys(previous).map((key) => [key, row[key]]));
        assert.deepEqual(projected, previous, table + ' old data changed');
      }
    }
    const receipt = {
      verifiedAt: new Date().toISOString(),
      migration,
      backup: filename,
      existingRowsPreserved: true,
      counts: Object.fromEntries(tables.map((t) => [t, rows[t].length])),
      webhookEvents: Number(
        (await client.query('SELECT count(*)::int AS n FROM public."WebhookEvent"')).rows[0].n,
      ),
    };
    await writeFile(
      resolve(directory, 'm5-deployment-receipt.json'),
      JSON.stringify(receipt, null, 2),
    );
    console.log(JSON.stringify(receipt));
  } else {
    assert.ok(
      !history.some((h) => h.migration_name === migration && h.finished_at && !h.rolled_back_at),
      'Already migrated',
    );
    assert.ok(
      history.every((h) => h.finished_at || h.rolled_back_at),
      'Unresolved migration',
    );
    await mkdir(directory, { recursive: true });
    const filename = 'm5-before-' + Date.now() + '.json';
    await writeFile(
      resolve(directory, filename),
      JSON.stringify({ capturedAt: new Date().toISOString(), fingerprint, rows, history }),
      { flag: 'wx', mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        backup: filename,
        counts: Object.fromEntries(tables.map((t) => [t, rows[t].length])),
      }),
    );
  }
  await client.query('ROLLBACK');
} finally {
  await client.end();
}
