import test from 'node:test';import assert from 'node:assert/strict';import {inputRateEvidence} from './input-rate.mjs';
const taps=(count,step)=>Array.from({length:count},(_,i)=>[i*step,i*step+1]).flat();
test('held keys and releases are not counted as repeated presses',()=>{assert.equal(inputRateEvidence({lists:{up:[0,2000]}},2000),null);});
test('only more than ten press edges inside a full second are advisory',()=>{assert.equal(inputRateEvidence({lists:{left:taps(10,100)}},2000),null);const e=inputRateEvidence({lists:{left:taps(11,80)}},2000);assert.equal(e.channels[0].presses,11);assert.equal(e.kind,'rapid_input');assert.match(e.notice,/not proof/);});
test('individual keys are not combined and window boundaries are half-open',()=>{assert.equal(inputRateEvidence({lists:{left:taps(6,100),right:taps(6,100)}},2000),null);assert.equal(inputRateEvidence({lists:{left:taps(11,100)}},2000),null);});
test('malformed or too-short recordings never become evidence',()=>{for(const ticks of [[0,0,1],[2,1],[NaN],[-1],Array(5000).fill(0)])assert.equal(inputRateEvidence({lists:{left:ticks}},2000),null);assert.equal(inputRateEvidence({lists:{left:taps(11,10)}},999),null);});
