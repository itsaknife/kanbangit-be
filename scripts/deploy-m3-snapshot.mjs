import { Client } from 'pg';
import { parse } from 'dotenv';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const config = { ...parse(await readFile('.env')), ...process.env };
const fingerprint = createHash('sha256').update(config.DATABASE_URL).digest('hex');
const client = new Client({ connectionString: config.DATABASE_URL, ssl: config.DATABASE_SSL==='true' ? {rejectUnauthorized:false} : false, connectionTimeoutMillis:10000, statement_timeout:30000 });
const tables = ['User','Repository','RepositoryMember','Tracker','TrackerPrefix','Issue','WeeklySummary'];
const directory = resolve('../.migration-backups');
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const rows = {};
  for (const table of tables) rows[table]=(await client.query(`SELECT to_jsonb(t)::text AS row FROM public."${table}" t ORDER BY id`)).rows.map(r=>r.row);
  const history=(await client.query('SELECT migration_name,finished_at,rolled_back_at FROM public._prisma_migrations ORDER BY started_at')).rows;
  await client.query('ROLLBACK');
  if (process.argv[2]==='--verify') {
    const filename=process.argv[3];
    assert.match(filename??'',/^m3-before-\d+\.json$/);
    const before=JSON.parse(await readFile(resolve(directory,filename),'utf8'));
    assert.equal(before.fingerprint,fingerprint);
    assert.ok(history.some(h=>h.migration_name==='202611130006_issue_management'&&h.finished_at&&!h.rolled_back_at));
    for(const table of tables) {
      assert.equal(rows[table].length,before.rows[table].length);
      for(let i=0;i<rows[table].length;i++) {
        const current=JSON.parse(rows[table][i]); const old=JSON.parse(before.rows[table][i]);
        if(table==='Issue') {
          for(const key of ['startDate','endDate','estimateMinutes','assigneeId','parentId','syncStatus']) delete current[key];
          assert.equal(current.status,old.state==='closed'?'closed':old.status);
          current.status=old.status;
        }
        assert.deepEqual(current,old);
      }
    }
    const receipt={verifiedAt:new Date().toISOString(),migration:'202611130006_issue_management',backup:filename,counts:Object.fromEntries(tables.map(t=>[t,rows[t].length])),existingRowsPreserved:true};
    await writeFile(resolve(directory,'m3-deployment-receipt.json'),JSON.stringify(receipt,null,2));
    process.stdout.write(JSON.stringify(receipt));
  } else {
    assert.ok(!history.some(h=>h.migration_name==='202611130006_issue_management'&&h.finished_at&&!h.rolled_back_at),'M3 already deployed');
    assert.ok(history.every(h=>h.finished_at||h.rolled_back_at),'Unresolved migration');
    await mkdir(directory,{recursive:true});
    const filename=`m3-before-${Date.now()}.json`;
    await writeFile(resolve(directory,filename),JSON.stringify({capturedAt:new Date().toISOString(),fingerprint,rows,history}),{flag:'wx',mode:0o600});
    process.stdout.write(JSON.stringify({backup:filename,counts:Object.fromEntries(tables.map(t=>[t,rows[t].length]))}));
  }
} catch(error) {
  await client.query('ROLLBACK').catch(()=>{});
  process.stderr.write(`M3 snapshot failed: ${error.code ?? error.name}\n`);
  process.exitCode=1;
} finally { await client.end(); }
