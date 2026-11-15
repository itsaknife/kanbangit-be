import { Client } from 'pg';
import { parse } from 'dotenv';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const migration = '202611140007_collaboration';
const previousTables = [
  'User',
  'Repository',
  'RepositoryMember',
  'Tracker',
  'TrackerPrefix',
  'Issue',
  'WeeklySummary',
  'IssueStatusHistory',
  'SyncJob',
];
const newTables = ['Worklog', 'Comment', 'CommentMention', 'Attachment', 'Notification'];
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
  const rows = {};
  for (const table of previousTables)
    rows[table] = (
      await client.query(
        'SELECT to_jsonb(t)::text AS row FROM public."' + table + '" t ORDER BY id',
      )
    ).rows.map((r) => r.row);
  const history = (
    await client.query(
      'SELECT migration_name,finished_at,rolled_back_at FROM public._prisma_migrations ORDER BY started_at',
    )
  ).rows;
  if (process.argv[2] === '--verify') {
    const filename = process.argv[3];
    assert.match(filename ?? '', /^m4-before-\d+\.json$/);
    const before = JSON.parse(await readFile(resolve(directory, filename), 'utf8'));
    assert.equal(before.fingerprint, fingerprint);
    assert.ok(
      history.some((h) => h.migration_name === migration && h.finished_at && !h.rolled_back_at),
    );
    for (const table of previousTables)
      assert.deepEqual(rows[table], before.rows[table], table + ' existing data changed');
    const counts = Object.fromEntries(previousTables.map((t) => [t, rows[t].length]));
    for (const table of newTables)
      counts[table] = Number(
        (await client.query('SELECT count(*) AS count FROM public."' + table + '"')).rows[0].count,
      );
    await client.query('ROLLBACK');
    const receipt = {
      verifiedAt: new Date().toISOString(),
      migration,
      backup: filename,
      counts,
      existingRowsPreserved: true,
    };
    await writeFile(
      resolve(directory, 'm4-deployment-receipt.json'),
      JSON.stringify(receipt, null, 2),
    );
    process.stdout.write(JSON.stringify(receipt));
  } else {
    assert.ok(
      !history.some((h) => h.migration_name === migration && h.finished_at && !h.rolled_back_at),
      'M4 already deployed',
    );
    assert.ok(
      history.every((h) => h.finished_at || h.rolled_back_at),
      'Unresolved migration',
    );
    await client.query('ROLLBACK');
    await mkdir(directory, { recursive: true });
    const filename = 'm4-before-' + Date.now() + '.json';
    await writeFile(
      resolve(directory, filename),
      JSON.stringify({ capturedAt: new Date().toISOString(), fingerprint, rows, history }),
      { flag: 'wx', mode: 0o600 },
    );
    process.stdout.write(
      JSON.stringify({
        backup: filename,
        counts: Object.fromEntries(previousTables.map((t) => [t, rows[t].length])),
      }),
    );
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  process.stderr.write('M4 snapshot failed: ' + (error.code ?? error.name) + '\n');
  process.exitCode = 1;
} finally {
  await client.end();
}
