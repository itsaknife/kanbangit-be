// Read-only snapshot/verification. Never applies migrations or writes to GitHub.
import {Client} from 'pg';
import {parse} from 'dotenv';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const env={...parse(await readFile('.env')), ...process.env};
const db=new Client({connectionString:env.DATABASE_URL,ssl:env.DATABASE_SSL==='true'?{rejectUnauthorized:false}:false,connectionTimeoutMillis:10000});
const directory=resolve('../.migration-backups');
try{
 await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const tables=(await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename`)).rows.map(r=>r.tablename);
 const rows={};for(const table of tables){assert.match(table,/^[A-Za-z_]+$/);rows[table]=(await db.query(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY id`)).rows.map(r=>r.row);}
 if(process.argv[2]==='--verify'){
  const filename=process.argv[3];assert.match(filename??'',/^m6-before-\d+\.json$/);const before=JSON.parse(await readFile(resolve(directory,filename),'utf8'));
  for(const [table,records] of Object.entries(before.rows)){
   assert.equal(rows[table].length,records.length,table+' count');const current=new Map(rows[table].map(r=>[r.id,r]));
   for(const previous of records){const row=current.get(previous.id);assert.ok(row);for(const [column,value] of Object.entries(previous)){
    const mapped=column==='repoId'||column==='repositoryId'?'projectId':column;assert.deepEqual(row[mapped],value,`${table}.${column}`);
   }}
  }
  assert.equal(rows.AuthIdentity.length,before.rows.User.length);
  for(const u of before.rows.User){const i=rows.AuthIdentity.find(i=>i.userId===u.id&&i.provider==='GITHUB');assert.ok(i);assert.equal(i.providerUserId,String(u.githubId));assert.equal(i.accessToken,u.accessToken);}
  const orphans=(await db.query(`SELECT count(*)::int AS n FROM public."RepositoryMember" m LEFT JOIN public."Repository" p ON p.id=m."projectId" LEFT JOIN public."User" u ON u.id=m."userId" WHERE p.id IS NULL OR (m."userId" IS NOT NULL AND u.id IS NULL)`)).rows[0].n;assert.equal(orphans,0);
  const receipt={migration:'202611170009_auth_project',verifiedAt:new Date().toISOString(),backup:filename,existingRowsAndFieldsPreserved:true,orphans,counts:Object.fromEntries(tables.map(t=>[t,rows[t].length]))};
  await writeFile(resolve(directory,'m6-deployment-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
 }else{await mkdir(directory,{recursive:true});const filename=`m6-before-${Date.now()}.json`;await writeFile(resolve(directory,filename),JSON.stringify({capturedAt:new Date().toISOString(),rows}),{flag:'wx',mode:0o600});console.log(JSON.stringify({backup:filename,counts:Object.fromEntries(tables.map(t=>[t,rows[t].length]))}));}
 await db.query('COMMIT');
}finally{await db.end();}
