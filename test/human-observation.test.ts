import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {humanMessageObservation} from '../src/human-message.js';
import {Store} from '../src/store.js';
import {fixture,NOW} from './helpers.js';

test('operator observations carry immutable human origin and are not new human approvals',async t=>{
 const {root,config}=fixture(t),store=new Store(config,NOW);t.after(()=>store.close());
 const job=store.enqueue({team:config.teamId,channel:'CPROJECT',root:'1800000000.000001',project:config.codex.cwd},'observation-event','UALICE','Watch the fixture',NOW,'1800000000.000001')!;
 const captured=path.join(root,'captured.json');
 const script='let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const v=JSON.parse(s);require("fs").writeFileSync(process.argv[1],s);process.stdout.write(JSON.stringify({handled:false,context:{recorded:true,phase:v.phase}}))})';
 const command=[process.execPath,'-e',script,captured],signal=new AbortController().signal;
 assert.equal((await humanMessageObservation(command,job,{id:'wait-1',data:{state:'waiting'}},signal)).ok,true);
 const h=JSON.parse(fs.readFileSync(captured,'utf8'));
 assert.equal(h.phase,'observation');assert.equal(h.jobId,job.id);assert.equal(h.actor,job.user);assert.equal(h.text,job.prompt);assert.deepEqual(h.observation,{state:'waiting'});
 for(const input of [{id:'bad key',data:{}},{id:'x',data:[]},{id:'x',data:{note:'x'.repeat(17000)}},{id:'x',data:{},actor:'UOTHER'}])assert.equal((await humanMessageObservation(command,job,input,signal)).ok,false);
 assert.equal(JSON.parse(fs.readFileSync(captured,'utf8')).observationId,'wait-1');
});
