'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {LIMITS}=require('./replay.cjs');
const ID=/^[a-f0-9]{64}$/;

function selectStaticTrackPaths(files,requestedIds,{geometry,extraCatalog}={}) {
  const sources=new Map([...files].filter(([name,file])=>
    (name.startsWith('tracks/')||name.startsWith('extra-tracks/track-data/'))&&name.endsWith('.track')&&file.bytes.length<=LIMITS.trackBytes));
  const idsByPath=new Map();
  const bind=(name,id)=>{
    if(!sources.has(name)||!ID.test(id||''))return;
    if(!idsByPath.has(name))idsByPath.set(name,new Set());
    idsByPath.get(name).add(id);
  };
  for(const row of geometry?.tracks||[])if(sources.get(row.name)?.hash===row.hash)bind(row.name,row.id);
  for(const row of Array.isArray(extraCatalog)?extraCatalog:[])bind(row.trackPath,row.trackId);
  // Catalogs are startup hints, not verdict authority. Incomplete hints retain the old full load.
  if([...sources.keys()].some(name=>idsByPath.get(name)?.size!==1))return undefined;
  const requested=new Set(requestedIds);
  const mapped=new Set([...idsByPath.values()].flatMap(ids=>[...ids]));
  if([...requested].some(id=>!mapped.has(id)))return undefined;
  return new Set([...idsByPath].filter(([,ids])=>[...ids].some(id=>requested.has(id))).map(([name])=>name));
}

function loadStaticTrackSelection(root,engine,jobs,trustedTracks=[]){
  try{const explicit=new Set(trustedTracks.map(track=>track.expectedId));return selectStaticTrackPaths(engine.files,jobs.filter(job=>!explicit.has(job.trackId)).map(job=>job.trackId),{
    geometry:JSON.parse(fs.readFileSync(path.join(__dirname,'track-geometry.json'),'utf8')),
    extraCatalog:JSON.parse(fs.readFileSync(path.join(root,'extra-tracks/catalog.json'),'utf8')),
  });}catch{return undefined;}
}
module.exports={selectStaticTrackPaths,loadStaticTrackSelection};
