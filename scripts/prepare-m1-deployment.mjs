// Snapshot application rows and validate a baseline restore before resolving migrations.
import { Client } from 'pg';
import { parse } from 'dotenv';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const config = { ...parse(readFileSync(new URL('../.env', import.meta.url))), ...process.env };
const client = new Client({
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  statement_timeout: 20000,
});
const tables = ['User', 'Repository', 'Issue', 'WeeklySummary'];
const directory = new URL('../../.migration-backups/', import.meta.url);
const catalog = async (schema) => ({
  columns: (
    await client.query(
      `SELECT table_name,column_name,udt_name,is_nullable,column_default,character_maximum_length,datetime_precision FROM information_schema.columns WHERE table_schema=$1 AND table_name IN ('User','Repository','Issue','WeeklySummary') ORDER BY table_name,ordinal_position`,
      [schema],
    )
  ).rows,
  constraints: (
    await client.query(
      `SELECT c.relname, con.conname, pg_get_constraintdef(con.oid) definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname IN ('User','Repository','Issue','WeeklySummary') ORDER BY 1,2`,
      [schema],
    )
  ).rows,
  indexes: (
    await client.query(
      `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename IN ('User','Repository','Issue','WeeklySummary') ORDER BY 1,2`,
      [schema],
    )
  ).rows,
  enums: (
    await client.query(
      `SELECT t.typname,e.enumlabel,e.enumsortorder FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 ORDER BY 1,3`,
      [schema],
    )
  ).rows,
});
const canonical = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
let phase = 'connect';
try {
  await client.connect();
  if (process.argv.includes('--verify-after')) {
    phase = 'post-migration-verification';
    const backupName = process.argv.find((arg) => arg.startsWith('--backup='))?.slice(9);
    assert.match(backupName ?? '', /^m1-before-\d+\.json$/);
    const snapshot = JSON.parse(readFileSync(new URL(backupName, directory), 'utf8'));
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const migrations = (
      await client.query(
        'SELECT migration_name,finished_at,rolled_back_at FROM public._prisma_migrations ORDER BY started_at',
      )
    ).rows;
    assert.deepEqual(
      migrations.map((m) => m.migration_name),
      ['202611110001_legacy_baseline', '202611110002_github_integration'],
    );
    assert.ok(migrations.every((m) => m.finished_at && !m.rolled_back_at));
    for (const table of tables) {
      const projection = table === 'Repository' ? "to_jsonb(t)-'importCompleted'" : 'to_jsonb(t)';
      const rows = (
        await client.query(`SELECT ${projection} AS row FROM public."${table}" t ORDER BY id`)
      ).rows.map((r) => r.row);
      assert.deepEqual(rows, snapshot.rows[table], `${table} legacy data changed`);
    }
    const trackers = Number(
      (await client.query('SELECT count(*) FROM public."Tracker"')).rows[0].count,
    );
    const members = Number(
      (await client.query('SELECT count(*) FROM public."RepositoryMember"')).rows[0].count,
    );
    const owners = Number(
      (
        await client.query(
          `SELECT count(*) FROM public."RepositoryMember" WHERE role='OWNER' AND "isActive"=true`,
        )
      ).rows[0].count,
    );
    assert.equal(trackers, snapshot.rows.Repository.length * 6);
    assert.ok(owners > 0 || snapshot.rows.Repository.length === 0);
    await client.query('ROLLBACK');
    const receipt = {
      status: 'VERIFIED',
      verifiedAt: new Date().toISOString(),
      backup: backupName,
      legacyDataUnchanged: true,
      counts: Object.fromEntries(tables.map((t) => [t, snapshot.rows[t].length])),
      trackers,
      members,
      owners,
      migrations,
    };
    writeFileSync(
      new URL('m1-deployment-receipt.json', directory),
      JSON.stringify(receipt, null, 2),
      { mode: 0o600 },
    );
    console.log(JSON.stringify(receipt));
    await client.end();
    process.exit(0);
  }
  const history = await client.query(`SELECT to_regclass('public._prisma_migrations') AS name`);
  if (process.argv.includes('--inspect')) {
    console.log(
      JSON.stringify({
        migrations: history.rows[0].name
          ? (
              await client.query(
                'SELECT migration_name,finished_at,rolled_back_at,applied_steps_count FROM public._prisma_migrations ORDER BY started_at',
              )
            ).rows
          : [],
        tables: (
          await client.query(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
          )
        ).rows,
      }),
    );
    await client.end();
    process.exit(0);
  }
  if (history.rows[0].name) {
    const migrations = (
      await client.query(
        'SELECT migration_name,finished_at,rolled_back_at,checksum FROM public._prisma_migrations ORDER BY started_at',
      )
    ).rows;
    assert.equal(migrations.length, 1);
    assert.equal(migrations[0].migration_name, '202611110001_legacy_baseline');
    assert.ok(migrations[0].finished_at);
    assert.equal(migrations[0].rolled_back_at, null);
    assert.equal(
      migrations[0].checksum,
      createHash('sha256')
        .update(
          readFileSync(
            new URL(
              '../prisma/migrations/202611110001_legacy_baseline/migration.sql',
              import.meta.url,
            ),
          ),
        )
        .digest('hex'),
    );
  }
  const publicTables = (
    await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename`,
    )
  ).rows
    .map((r) => r.tablename)
    .sort();
  assert.deepEqual(publicTables, [...tables].sort());
  const snapshot = {
    capturedAt: new Date().toISOString(),
    schema: await catalog('public'),
    rows: {},
    sequences: [],
  };
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  for (const table of tables)
    snapshot.rows[table] = (
      await client.query(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY id`)
    ).rows.map((r) => r.row);
  snapshot.sequences = (
    await client.query(
      `SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`,
    )
  ).rows;
  await client.query('ROLLBACK');
  phase = 'backup';
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const backupName = `m1-before-${Date.now()}.json`;
  writeFileSync(new URL(backupName, directory), JSON.stringify(snapshot, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  assert.deepEqual(JSON.parse(readFileSync(new URL(backupName, directory), 'utf8')), snapshot);
  phase = 'restore-rehearsal';
  const schema = `m1_restore_${randomUUID().replaceAll('-', '')}`;
  const vectorSchema = (
    await client.query(
      `SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'`,
    )
  ).rows[0].nspname;
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(
    `SET LOCAL search_path TO "${schema}",public,"${vectorSchema.replaceAll('"', '""')}"`,
  );
  await client.query(
    readFileSync(
      new URL('../prisma/migrations/202611110001_legacy_baseline/migration.sql', import.meta.url),
      'utf8',
    ),
  );
  const restored = await catalog(schema);
  const normalize = (value) =>
    JSON.stringify(value, (_key, item) =>
      typeof item === 'string'
        ? item.replaceAll(schema, 'public').replaceAll('"public".', '').replaceAll('public.', '')
        : item,
    );
  for (const section of Object.keys(restored)) {
    phase = `baseline-compare-${section}`;
    if (section === 'columns') {
      const order = (a, b) =>
        `${a.table_name}.${a.column_name}`.localeCompare(`${b.table_name}.${b.column_name}`);
      restored[section].sort(order);
      snapshot.schema[section].sort(order);
    }
    assert.equal(
      normalize(restored[section]),
      normalize(snapshot.schema[section]),
      'Baseline differs from live schema',
    );
  }
  for (const table of tables) {
    phase = `restore-data-${table}`;
    await client.query(
      `INSERT INTO "${schema}"."${table}" SELECT * FROM jsonb_populate_recordset(NULL::"${schema}"."${table}",$1::jsonb)`,
      [JSON.stringify(snapshot.rows[table])],
    );
    const rows = (
      await client.query(`SELECT to_jsonb(t) AS row FROM "${schema}"."${table}" t ORDER BY id`)
    ).rows.map((r) => r.row);
    assert.deepEqual(rows, snapshot.rows[table]);
  }
  await client.query(
    readFileSync(
      new URL(
        '../prisma/migrations/202611110002_github_integration/migration.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.equal(
    Number((await client.query(`SELECT count(*) FROM "Tracker"`)).rows[0].count),
    snapshot.rows.Repository.length * 6,
  );
  await client.query('ROLLBACK');
  assert.equal(
    (await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount,
    0,
  );
  console.log(
    JSON.stringify({
      status: 'READY',
      backup: backupName,
      counts: Object.fromEntries(tables.map((t) => [t, snapshot.rows[t].length])),
      digest: canonical(snapshot.rows),
      baselineMatches: true,
      restoreVerified: true,
      m1RehearsalPassed: true,
    }),
  );
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(
    JSON.stringify({
      status: 'FAILED',
      phase,
      code: error.code ?? 'PREPARATION_FAILED',
      reason: error.name === 'AssertionError' ? 'Verification mismatch' : undefined,
    }),
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
