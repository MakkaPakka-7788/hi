import test from 'node:test';
import assert from 'node:assert/strict';
import {eventWorkerHandler} from '../src/events-worker.js';
import {eventEncode} from '../src/events-store.js';
import {preparePublicationPages,PUBLIC_MANIFEST_COLLECTION,publicationManifestId} from '../src/paged-publication.js';
import {publicEventTotal,publicEventPage} from '../src/event-public-projection.js';

test('public totals/pages use allowlists rather than copying private source fields',()=>{
 const row={accountId:'public-racer',name:'Racer',rp:123,events:2,rank:1,carStyle:'native',ownerUid:'PRIVATE_CANARY',proof:{key:'PRIVATE_CANARY'},replay:'PRIVATE_CANARY',privateNotes:'PRIVATE_CANARY'};
 assert.equal(JSON.stringify(publicEventTotal(row)).includes('PRIVATE_CANARY'),false);
 const page=publicEventPage({generation:'a'.repeat(64),page:0,pageSize:100,pageCount:1,totalEntries:1,complete:true,sourceRevision:7,
   entries:[row],ownerUid:'PRIVATE_CANARY',dynamicComponents:{permanentRollingHills:{status:'complete',sourceRevision:7,proof:'PRIVATE_CANARY'}}},'event_totals');
 assert.equal(JSON.stringify(page).includes('PRIVATE_CANARY'),false);assert.equal(page.sourceRevision,7);
});

test('event pages share cold fills, ignore irrelevant query parameters, and warm hits bypass database and limiter',async()=>{
 const prior=globalThis.caches,stored=new Map();let reads=0,transactions=0,rateChecks=0,admit=true;
 globalThis.caches={default:{match:async key=>stored.get(key.url)?.clone()||null,put:async(key,response)=>{stored.set(key.url,response.clone());}}};
 const rows=Array.from({length:101},(_,i)=>({accountId:'racer-'+i,name:'Racer '+i,rp:101-i,events:1,rank:i+1,ownerUid:'PRIVATE_CANARY'}));
 const paged=await preparePublicationPages('event_totals','main',rows,{sourceRevision:19});
 const data=new Map(paged.documents.map(d=>[d.collection+'/'+d.id,d.data]));
 data.set(PUBLIC_MANIFEST_COLLECTION+'/'+publicationManifestId('event_totals','main',paged.pagination.generation),paged.pagination);
 const handler=eventWorkerHandler({EVENTS_ENABLED:'true',EVENT_RATE_LIMITER:{limit:async()=>{rateChecks++;return {success:admit};}}},{
   request:async route=>{if(route===':beginTransaction'){transactions++;return {transaction:'fixture'};}if(route===':commit'||route===':rollback')return {};
     reads++;const key=new URL('https://fixture.test'+route).pathname.slice(1),value=data.get(key);return value?{fields:eventEncode(value).mapValue.fields,updateTime:'v1'}:null;},
   authenticate:async()=>'unused',origins:new Set(['https://game.test'])});
 const url=`https://ranked.example/v1/events/totals/page?generation=${paged.pagination.generation}&page=0`;
 const headers={Origin:'https://game.test','CF-Connecting-IP':'192.0.2.1'};
 try{
   const results=await Promise.all(Array.from({length:8},(_,i)=>handler(new Request(url+'&ignored='+i,{headers}))));
   for(const response of results){assert.equal(response.status,200);const body=await response.json();assert.equal(body.sourceRevision,19);assert.equal(body.entries.length,100);assert.equal(JSON.stringify(body).includes('PRIVATE_CANARY'),false);}
   assert.equal(transactions,1);assert.equal(reads,2);assert.equal(rateChecks,1);
   admit=false;const warm=await handler(new Request(url+'&another=1',{headers}));assert.equal(warm.status,200);assert.equal(transactions,1);assert.equal(reads,2);assert.equal(rateChecks,1);
   const denied=await handler(new Request(url.replace('page=0','page=1'),{headers}));assert.equal(denied.status,429);assert.equal(reads,2);
   admit=true;const second=await handler(new Request(url.replace('page=0','page=1'),{headers}));assert.equal(second.status,200);assert.equal((await second.json()).entries[0].accountId,'racer-100');assert.equal(reads,4);
 }finally{if(prior===undefined)delete globalThis.caches;else globalThis.caches=prior;}
});
