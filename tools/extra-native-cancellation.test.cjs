const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  async function importExtraTrack('),end=source.indexOf('  async function submitExtraTrack(',start);
assert.ok(start>=0&&end>start);
const entry={id:'test',trackId:'a'.repeat(64),trackPath:'extra-tracks/track-data/test/test.track'};
function compile(context){
 const body=source.slice(start,end),anchor="await import(new URL('../tools/track-import-storage.mjs?v=133',eventsModuleUrl).href)";
 assert.equal(body.split(anchor).length,2,'storage module import remains an explicit boundary');
 vm.createContext(context);vm.runInContext(body.replace(anchor,'await Promise.resolve(storageModule)'),context);return context.importExtraTrack;
}
test('closing and reopening the catalog cancels a pending import before native UI changes',async()=>{
 let release,current=true,touches=0;const fetch=()=>new Promise(resolve=>{release=resolve});
 const load=compile({URL,AbortSignal,fetch,extraTracksBaseUrl:'https://example.test/extra-tracks/',__pt062WebpackRequire:()=>{touches++;throw Error('stale decode');},document:{querySelector(){touches++;}}});
 const pending=load(entry,{isCurrent:()=>current});current=false;
 release({ok:true,headers:new Headers(),text:async()=> 'PolyTrack123'});
 await pending;assert.equal(touches,0);
});
test('a native import already confirmed may finish saving but cannot close a newer catalog view',async()=>{
 let current=true,closed=0;const known={};const field={value:'',dispatchEvent(){}};
 const confirm={querySelector:()=>({}),click(){dialog.isConnected=false;current=false;}};
 const dialog={isConnected:true,querySelector:()=>field,querySelectorAll:()=>[confirm]};
 const importButton={querySelector:()=>({}),click(){}};
 const storageModule=await import('./track-import-storage.mjs');
 const context={storageModule,URL,AbortSignal,Headers,Event,extraTracksBaseUrl:'https://example.test/extra-tracks/',fetch:async()=>({ok:true,headers:new Headers(),text:async()=> 'PolyTrack123'}),
 __pt062WebpackRequire:()=>()=>({A:{fromExportString:()=>({trackData:{getId:()=>entry.trackId},trackMetadata:{name:'Test'}})}}),
 extraTrackIds:()=>known,extraTrackIdsKey:'known',localStorage:{setItem(){},removeItem(){},getItem(){return null;}},volatileLeaderboardCache:new Map(),jsonStorageCache:new Map(),extraTracksUi:{close(){closed++;}},
 document:{querySelector:selector=>selector.includes('track-export-ui')?dialog:null,querySelectorAll:selector=>selector.includes('track-title')?[]:[importButton]}};
 await compile(context)(entry,{isCurrent:()=>current});assert.equal(known.test,entry.trackId);assert.equal(closed,0);
});
