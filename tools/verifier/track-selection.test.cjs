'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {selectStaticTrackPaths,loadStaticTrackSelection}=require('./track-selection.cjs');
const a='a'.repeat(64),b='b'.repeat(64),hash='c'.repeat(64);
const files=new Map([['tracks/a.track',{bytes:Buffer.from('a'),hash}],['extra-tracks/track-data/x/b.track',{bytes:Buffer.from('b'),hash}],['models/road.glb',{bytes:Buffer.from('mesh'),hash}]]);
const metadata={geometry:{tracks:[{name:'tracks/a.track',id:a,hash}]},extraCatalog:[{trackPath:'extra-tracks/track-data/x/b.track',trackId:b}]};
test('complete hints select only requested pinned static files',()=>{
 assert.deepEqual([...selectStaticTrackPaths(files,[a],metadata)],['tracks/a.track']);
 assert.deepEqual([...selectStaticTrackPaths(files,[b],metadata)],['extra-tracks/track-data/x/b.track']);
 assert.equal(selectStaticTrackPaths(files,['d'.repeat(64)],metadata),undefined);
 assert.deepEqual([...selectStaticTrackPaths(files,[a,b],metadata)],[...files.keys()].slice(0,2));
});
test('missing, conflicting, or hash-mismatched hints fall back to the original full catalog',()=>{
 assert.equal(selectStaticTrackPaths(files,[a],{}),undefined);
 assert.equal(selectStaticTrackPaths(files,[a],{...metadata,extraCatalog:[]}),undefined);
 assert.equal(selectStaticTrackPaths(files,[a],{...metadata,geometry:{tracks:[{name:'tracks/a.track',id:a,hash:'d'.repeat(64)}]}}),undefined);
 assert.equal(selectStaticTrackPaths(files,[a],{...metadata,extraCatalog:[...metadata.extraCatalog,{trackPath:'tracks/a.track',trackId:b}]}),undefined);
});
test('known repository catalogs cover the pinned static track sources',()=>{
 const root=path.resolve(__dirname,'../..'),{snapshot}=require('./assets.cjs'),engine=snapshot(root);
 const selection=loadStaticTrackSelection(root,engine,[{trackId:'5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038'}]);
 assert.ok(selection instanceof Set,'new unmapped sources must be reviewed before relying on optimized startup');
 assert.deepEqual([...selection],['tracks/official/summer1.track']);
 assert.equal(loadStaticTrackSelection(root,engine,[{trackId:'d'.repeat(64)}],[{expectedId:'d'.repeat(64)}]).size,0,'explicit trusted event tracks need no static source');
 const source=fs.readFileSync(path.join(__dirname,'verify.cjs'),'utf8');
 assert.ok(source.includes("'track-selection.cjs'"),'selection code must be in verdict provenance');
 assert.ok(source.includes("if (expectedId && id !== expectedId) reason = 'track_identity_mismatch'"));
 assert.ok(source.includes('geometryDecision(track, engine.engineFingerprint)'));
 assert.ok(source.includes('pending.map(index => jobs[index])'),'rejected jobs must not expand catalog startup for other runs');
});
