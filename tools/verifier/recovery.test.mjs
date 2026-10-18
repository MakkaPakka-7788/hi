import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {completedSlot} from './queue.mjs';
const {_internals}=createRequire(import.meta.url)('./verify.cjs');

test('one timed-out replay gets one fresh isolate and does not poison later jobs',async()=>{
  const called=[],deferred=[],errors=[],recovered=[];
  await _internals.runWithBoundedRecovery([0,1,2,3],async index=>{
    called.push(index);
    if(index===0)throw Object.assign(Error('cpu'),{reason:'cpu_deadline'});
  },async()=>recovered.push('fresh'),(index,error)=>errors.push([index,error.reason]),(index,reason)=>deferred.push([index,reason]));
  assert.deepEqual(called,[0,1,2,3]);
  assert.deepEqual(errors,[[0,'cpu_deadline']]);
  assert.deepEqual(recovered,['fresh']);
  assert.deepEqual(deferred,[]);
});

test('recovery budget is finite and unprocessed jobs remain infrastructure retries',async()=>{
  const called=[],deferred=[];let recoveries=0;
  const count=await _internals.runWithBoundedRecovery([0,1,2,3,4],async index=>{
    called.push(index);
    if(index<3)throw Object.assign(Error('deadline'),{reason:'cpu_deadline'});
  },async()=>{recoveries++;},()=>{},(index,reason)=>deferred.push([index,reason]));
  assert.equal(count,_internals.MAX_SESSION_RECOVERIES);
  assert.equal(recoveries,2);
  assert.deepEqual(called,[0,1,2]);
  assert.deepEqual(deferred,[[3,'isolate_recovery_limit'],[4,'isolate_recovery_limit']]);
  const slot=completedSlot({accountId:'a',attempts:0},{status:'unavailable',reason:'isolate_recovery_limit'},100);
  assert.equal(slot.attempts,0,'infrastructure recovery limits never consume player attempts');
  assert.ok(slot.retryAt>100,'the queue schedules a later bounded retry');
  const held=completedSlot({accountId:'b',attempts:1},{status:'unavailable',reason:'identical_replay_pending_manual_review'},100);
  assert.equal(held.attempts,2);
  assert.equal(held.retryAt,Number.MAX_SAFE_INTEGER,'manual-review holds do not loop through automatic retries');
});
