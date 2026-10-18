'use strict';

// Public-safe shutdown race tests. Fake owned processes only, no OS process kills.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const cp = require('node:child_process');
let calls = [];
let command;
cp.execFile = (...args) => { calls.push(args.slice(0, 3)); command(args.at(-1)); };
const { _internals: { terminate, waitForExit } } = require('./verify.cjs');

function fixture() {
  const child = Object.assign(new EventEmitter(), { pid: 987654321, exitCode: null, signalCode: null });
  const exit = () => { child.exitCode = 0; child.emit('exit', 0); };
  return { child, exit, session: { server: { process: () => child, close: async () => exit() } } };
}

test('exit listener is removed after timeout', async () => {
  const { child } = fixture();
  assert.equal(await waitForExit(child, 5), false);
  assert.equal(child.listenerCount('exit'), 0);
});
test('already exited process ignores previously rejected cleanup promise', async () => {
  const { session, exit } = fixture();
  session.killPromise = Promise.reject(Error('earlier failure'));
  session.killPromise.catch(() => {});
  exit();
  await terminate(session);
});
test('normal close does not invoke taskkill', async () => {
  calls = [];
  const { session } = fixture();
  await terminate(session, { graceful: true });
  assert.equal(calls.length, 0);
});
test('taskkill failure before process exit is not a cleanup failure', { skip: process.platform !== 'win32' }, async () => {
  calls = [];
  const { session, exit } = fixture();
  command = callback => {
    callback(Object.assign(Error('child already gone'), { code: 128 }), '', 'A child process already exited');
    setTimeout(exit, 20);
  };
  await Promise.all([terminate(session), terminate(session)]);
  await terminate(session);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['/PID', '987654321', '/T', '/F']);
  assert.equal(session.cleanup.commandCode, 128);
});
test('still-live owned process remains a real cleanup failure with diagnostics', { skip: process.platform !== 'win32' }, async () => {
  const { session, child } = fixture();
  command = callback => callback(Object.assign(Error('permission denied'), { code: 'EACCES' }), '', 'permission denied');
  await assert.rejects(terminate(session), /process_cleanup_failed/);
  assert.equal(session.cleanup.commandCode, 'EACCES');
  assert.equal(session.cleanup.exitObserved, false);
  assert.equal(child.listenerCount('exit'), 0);
});


test('page errors use bounded recovery instead of contaminating later jobs',async()=>{
 const {requireCleanNativeResult,runWithBoundedRecovery}=require('./verify.cjs')._internals;
 let session={pageErrors:['worker error']},recovered=0;const results=[];
 await runWithBoundedRecovery([0,1],async index=>{results[index]=requireCleanNativeResult(session,{status:'verified',reason:'native_exact_finish'}).reason;},async()=>{recovered++;session={pageErrors:[]};},(index,error)=>{results[index]=error.reason;},()=>assert.fail('unexpected deferred job'));
 assert.deepEqual(results,['page_error','native_exact_finish']);assert.equal(recovered,1);
 const clean={status:'verified'};assert.equal(requireCleanNativeResult({pageErrors:[]},clean),clean);
});
