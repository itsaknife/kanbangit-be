import {Client} from 'pg';
import {parse} from 'dotenv';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const config={...parse(readFileSync(new URL('../.env',import.meta.url))),...process.env};
const client=new Client({connectionString:config.DATABASE_URL,ssl:config.DATABASE_SSL==='true'?{rejectUnauthorized:false}:false,connectionTimeoutMillis:10000,statement_timeout:30000});
const tables=['User','Repository','Tracker','RepositoryMember','Issue','WeeklySummary'];
const versions=['202611110001_legacy_baseline','202611110002_github_integration','202611110003_core_data_permission'];
const directory=new URL('../../.migration-backups/',import.meta.url);
const sql=name=>readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`,import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const fingerprint=hash(config.DATABASE_URL??'');
const quote=name=>`"${name.replaceAll('"','""')}"`;
const catalog=async schema=>({
 columns:(await client.query('SELECT table_name,column_name,udt_name,is_nullable,column_default,datetime_precision FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2) ORDER BY table_name,column_name',[schema,tables])).rows,
 constraints:(await client.query('SELECT c.relname,co.conname,pg_get_constraintdef(co.oid) definition FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2) ORDER BY 1,2',[schema,tables])).rows,
 indexes:(await client.query('SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=ANY($2) ORDER BY 1,2',[schema,tables])).rows,
 enums:(await client.query('SELECT t.typname,e.enumlabel,e.enumsortorder FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname=$1 ORDER BY 1,3',[schema])).rows,
});
const readRows=async schema=>{
 const result={};
 for(const table of tables)result[table]=(await client.query(`SELECT to_jsonb(t) row FROM ${quote(schema)}.${quote(table)} t ORDER BY id`)).rows.map(r=>r.row);
 return result;
};
const ordered=rows=>[...rows].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
async function verify(snapshot,schema){
 const after=await readRows(schema);
 const maps={User:new Map(after.User.map(r=>[r.id,r.legacyId])),Repository:new Map(after.Repository.map(r=>[r.id,r.legacyId]))};
 for(const table of ['User','Repository','Issue','WeeklySummary']){
  assert.ok(after[table].every(r=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.id)),`UUID check ${table}`);
 }
 for(const table of tables){
  const restored=after[table].map(row=>{
   const r={...row};
   if(['User','Repository','Issue','WeeklySummary'].includes(table)){r.id=r.legacyId;delete r.legacyId;}
   if(table==='User'||table==='Repository'){
    assert.equal(String(r.githubId),String(r.id),'GitHub identity preserved');delete r.githubId;
   }
   if(table==='Repository')r.connectedById=maps.User.get(r.connectedById);
   if(table==='Issue'||table==='WeeklySummary')r.repoId=maps.Repository.get(r.repoId);
   if(table==='WeeklySummary')r.createdById=maps.User.get(r.createdById);
   if(table==='Issue'){delete r.trackerId;delete r.issueCode;}
   if(table==='Tracker'||table==='RepositoryMember')r.repositoryId=maps.Repository.get(r.repositoryId);
   if(table==='RepositoryMember'&&r.userId!==null)r.userId=maps.User.get(r.userId);
   if(table==='Tracker'){
    const original=snapshot.rows.Tracker.find(t=>t.id===r.id);
    assert.ok(original);
    const count=after.Issue.filter(i=>i.trackerId===r.id).length;
    assert.equal(r.nextSequence,count+1,'Counter follows backfilled codes');
    r.nextSequence=original.nextSequence;
   }
   return r;
  });
  assert.deepEqual(ordered(restored),ordered(snapshot.rows[table]),`Preserved data ${table}`);
 }
 const codeKeys=new Set();
 for(const issue of after.Issue){
  const tracker=after.Tracker.find(t=>t.id===issue.trackerId);
  assert.ok(tracker&&tracker.repositoryId===issue.repoId&&tracker.prefix==='TASK');
  assert.match(issue.issueCode,/^TASK-\d{3,}$/);
  const key=issue.repoId+':'+issue.issueCode;assert.ok(!codeKeys.has(key));codeKeys.add(key);
 }
 const prefixes=(await client.query(`SELECT count(*)::int n FROM ${quote(schema)}."TrackerPrefix"`)).rows[0].n;
 assert.equal(prefixes,after.Tracker.length);
 const metadata=await client.query(`SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND t.tgname='Issue_code_immutable'`,[schema]);
 assert.equal(metadata.rowCount,1);
 return {counts:Object.fromEntries(tables.map(t=>[t,after[t].length])),prefixes,issueCodes:after.Issue.map(i=>i.issueCode).sort(),repositories:after.Repository.map(r=>({legacyId:r.legacyId,id:r.id})),legacyDataPreserved:true,uuidMappingsVerified:true};
}
let phase='connect';
try{
 await client.connect();
 if(process.argv.includes('--verify-after')){
  phase='post-migration-verification';
  const name=process.argv.find(a=>a.startsWith('--backup='))?.slice(9);
  assert.match(name??'',/^m2-before-\d+\.json$/);
  const snapshot=JSON.parse(readFileSync(new URL(name,directory),'utf8'));
  assert.equal(snapshot.targetFingerprint,fingerprint);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const result=await verify(snapshot,'public');
  const migrations=(await client.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM public._prisma_migrations ORDER BY started_at')).rows;
  assert.deepEqual(migrations.map(m=>m.migration_name),versions);
  for(const m of migrations){assert.ok(m.finished_at&&!m.rolled_back_at);assert.equal(m.checksum,hash(sql(m.migration_name)));}
  await client.query('ROLLBACK');
  const receipt={status:'VERIFIED',verifiedAt:new Date().toISOString(),backup:name,...result,migrations:migrations.map(({checksum,...m})=>m)};
  writeFileSync(new URL('m2-deployment-receipt.json',directory),JSON.stringify(receipt,null,2),{mode:0o600});
  console.log(JSON.stringify(receipt));
 }else{
  phase='preflight';
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const history=(await client.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM public._prisma_migrations ORDER BY started_at')).rows;
  assert.deepEqual(history.map(m=>m.migration_name),versions.slice(0,2));
  for(const m of history){assert.ok(m.finished_at&&!m.rolled_back_at);assert.equal(m.checksum,hash(sql(m.migration_name)));}
  const found=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename")).rows.map(r=>r.tablename);
  assert.deepEqual(found,[...tables].sort());
  const snapshot={capturedAt:new Date().toISOString(),targetFingerprint:fingerprint,migrationChecksum:hash(sql(versions[2])),history,schema:await catalog('public'),rows:await readRows('public'),sequences:(await client.query("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows};
  for(const repo of snapshot.rows.Repository){
   assert.equal(snapshot.rows.Tracker.filter(t=>t.repositoryId===repo.id&&t.prefix==='TASK').length,1);
   assert.ok(snapshot.rows.RepositoryMember.filter(m=>m.repositoryId===repo.id&&m.role==='OWNER'&&m.isActive).length<=1);
  }
  await client.query('ROLLBACK');
  phase='backup';mkdirSync(directory,{recursive:true,mode:0o700});
  const name=`m2-before-${Date.now()}.json`;
  writeFileSync(new URL(name,directory),JSON.stringify(snapshot,null,2),{flag:'wx',mode:0o600});
  assert.deepEqual(JSON.parse(readFileSync(new URL(name,directory),'utf8')),snapshot);
  phase='restore-rehearsal';
  const schema=`m2_restore_${randomUUID().replaceAll('-','')}`;
  const vectorSchema=(await client.query("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'")).rows[0].nspname;
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA ${quote(schema)}`);
  await client.query(`SET LOCAL search_path TO ${quote(schema)},public,${quote(vectorSchema)}`);
  await client.query(sql(versions[0]));await client.query(sql(versions[1]));
  const normalize=value=>JSON.stringify(value,(_key,v)=>typeof v==='string'?v.replaceAll(schema,'public').replaceAll('"public".','').replaceAll('public.',''):v);
  assert.equal(normalize(await catalog(schema)),normalize(snapshot.schema),'M1 schema matches baseline');
  for(const table of tables)await client.query(`INSERT INTO ${quote(schema)}.${quote(table)} SELECT * FROM jsonb_populate_recordset(NULL::${quote(schema)}.${quote(table)},$1::jsonb)`,[JSON.stringify(snapshot.rows[table])]);
  const restored=await readRows(schema);for(const table of tables)assert.deepEqual(ordered(restored[table]),ordered(snapshot.rows[table]));
  await client.query(sql(versions[2]).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,''));
  const result=await verify(snapshot,schema);
  await client.query('ROLLBACK');
  assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount,0);
  console.log(JSON.stringify({status:'READY',backup:name,restoreVerified:true,migrationRehearsalPassed:true,...result}));
 }
}catch(error){
 await client.query('ROLLBACK').catch(()=>{});
 console.error(JSON.stringify({status:'FAILED',phase,code:error.code??'VERIFICATION_FAILED',reason:error.name==='AssertionError'?String(error.message).split('\n')[0]:undefined}));process.exitCode=1;
}finally{await client.end().catch(()=>{});}
