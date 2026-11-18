// Read-only real AppModule check; the background worker is disabled before init.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import cookieParser from 'cookie-parser';
import {NestFactory} from '@nestjs/core';
import {JwtService} from '@nestjs/jwt';
import {ConfigService} from '@nestjs/config';
import {AppModule} from '../dist/app.module.js';
import {PrismaService} from '../dist/prisma/prisma.service.js';
const app=await NestFactory.create(AppModule,{logger:false});
try{
 const config=app.get(ConfigService);config.set('SYNC_WORKER_ENABLED',false);app.use(cookieParser());await app.listen(0,'127.0.0.1');
 const member=await app.get(PrismaService).repositoryMember.findFirstOrThrow({where:{isActive:true,userId:{not:null},role:'OWNER'}});
 const token=await app.get(JwtService).signAsync({sub:member.userId},{expiresIn:'60s'});const root='http://127.0.0.1:'+app.getHttpServer().address().port;
 const checks=[];
 for(const path of ['/auth/me','/users/me/identities','/projects',`/projects/${member.repositoryId}/members`]){
  const response=await fetch(root+path,{headers:{cookie:'session='+token},signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);const body=await response.json();assert.ok(!JSON.stringify(body).includes('accessToken'));checks.push({path:path.replace(member.repositoryId,':projectId'),status:response.status});
 }
 assert.equal((await fetch(root+'/projects')).status,401);
 console.log(JSON.stringify({readOnly:true,workerDisabled:true,googleConfigured:!!config.get('GOOGLE_CLIENT_ID')&&!!config.get('GOOGLE_CLIENT_SECRET'),checks,anonymousStatus:401}));
}finally{await app.close();}
