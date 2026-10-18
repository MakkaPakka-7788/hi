import test from 'node:test';import assert from 'node:assert/strict';import {completeRankedSnapshot} from './ranked-live-snapshot.mjs';
const generation='a'.repeat(64),rows=Array.from({length:205},(_,i)=>({accountId:(i+1).toString(16).padStart(64,'0')}));
const pagination={version:1,generation,pageSize:100,pageCount:3,totalEntries:205,complete:true};
const preview=()=>({entries:rows.slice(0,200),pagination,sourceRevision:7,totalEntries:205,sourceComplete:true});
const page=i=>({generation,page:i,pageSize:100,pageCount:3,totalEntries:205,complete:true,sourceComplete:true,sourceRevision:7,entries:rows.slice(i*100,(i+1)*100)});
test('live previews assemble all racers using exact generation-bound pages',async()=>{
 const urls=[];const result=await completeRankedSnapshot(preview(),{kind:'track',trackId:'b'.repeat(64),endpoint:'https://worker.test',fetchImpl:async url=>{urls.push(new URL(url));return Response.json(page(Number(new URL(url).searchParams.get('page'))));}});
 assert.equal(result.entries.length,205);assert.equal(result.complete,true);assert.equal(urls.length,3);assert.ok(urls.every(u=>u.searchParams.get('generation')===generation&&u.searchParams.get('trackId')==='b'.repeat(64)));
});
test('matching complete snapshot generations avoid every page request',async()=>{
 const saved={...preview(),entries:rows,paginatedSource:true,complete:true};const result=await completeRankedSnapshot(preview(),{saved,kind:'overall',endpoint:'https://worker.test',fetchImpl:()=>assert.fail('Unchanged pages requested')});assert.equal(result.entries.length,205);
});
test('mixed-generation pages fail instead of replacing the snapshot with a partial board',async()=>{
 await assert.rejects(completeRankedSnapshot(preview(),{kind:'overall',endpoint:'https://worker.test',fetchImpl:async()=>Response.json({...page(0),generation:'b'.repeat(64)})}),/Invalid or incomplete/);
});
test('throttling stops assembly immediately and preserves the cooldown information',async()=>{
 let calls=0;await assert.rejects(completeRankedSnapshot(preview(),{kind:'overall',endpoint:'https://worker.test',fetchImpl:async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'120'}});}}),e=>e.status===429&&e.retryAfter==='120');assert.equal(calls,1);
});
test('legacy responses are unchanged and page budgets remain bounded',async()=>{
 const legacy={entries:[]};assert.equal(await completeRankedSnapshot(legacy),legacy);
 await assert.rejects(completeRankedSnapshot({...preview(),pagination:{...pagination,pageCount:101,totalEntries:10100}},{kind:'overall'}),/page budget/);
});

test('unchanged full page sets are reused without pretending source coverage is complete',async()=>{
 const value={...preview(),sourceComplete:false},saved={...value,entries:rows,paginatedSource:true,complete:false};
 const result=await completeRankedSnapshot(value,{saved,kind:'overall',endpoint:'https://worker.test',fetchImpl:()=>assert.fail('Unchanged pages requested')});
 assert.equal(result.entries.length,205);assert.equal(result.complete,false);assert.equal(result.sourceComplete,false);
});
