import test from 'node:test';
import assert from 'node:assert/strict';
import {createPracticeHistory,practiceAdvice,PRACTICE_KEY} from './practice-history.mjs';
import {installPracticeObserver} from './practice-native.mjs';
const account='a'.repeat(64),track='b'.repeat(64);
function setup(){let at=100000,saved=null,writes=0;const storage={getItem:()=>saved,setItem:(_key,value)=>{saved=value;writes++;}};const history=createPracticeHistory({storage,now:()=>at});return {history,storage,advance:ms=>at+=ms,writes:()=>writes,saved:()=>saved};}
test('practice accumulates active time and resets since-PB time only for an improvement',()=>{
 const h=setup();let attempt=h.history.begin(account,track,20000);attempt.tick(1000,2);attempt.finish(21000);
 assert.equal(h.history.get(account,track).sincePbMs,1000);assert.equal(h.history.get(account,track).pbs,0);
 attempt=h.history.begin(account,track,20000);attempt.tick(1000,3);attempt.finish(19000);
 const row=h.history.get(account,track);assert.equal(row.pbs,1);assert.equal(row.finishes,2);assert.equal(row.sincePbMs,0);assert.equal(row.furthestCheckpoint,3);
});
test('duplicate finishes and post-finish restarts cannot double count',()=>{
 const h=setup(),attempt=h.history.begin(account,track);attempt.tick(1000);attempt.finish(10000);attempt.finish(10000);attempt.restart(10000);attempt.tick(1000);
 const row=h.history.get(account,track);assert.equal(row.finishes,1);assert.equal(row.pbs,1);assert.equal(row.restarts,0);assert.equal(row.activeMs,1000);
});
test('rapid restarts remain in memory and do not cause a write per attempt',()=>{
 const h=setup();for(let i=0;i<50;i++){const attempt=h.history.begin(account,track);attempt.tick(100);attempt.restart(100);}
 assert.equal(h.history.get(account,track).restarts,50);assert.ok(h.writes()<=1);
 h.history.flush(true);assert.equal(h.writes(),2);assert.ok(h.saved().length<2000);
});
test('storage failure does not break racing or delete unrelated data',()=>{
 const history=createPracticeHistory({storage:{getItem(){throw Error('blocked');},setItem(){throw Error('full');}}});
 history.begin(account,track).finish(10000);assert.equal(history.flush(true),false);assert.equal(history.get(account,track).pbs,1);
});
test('clear removes only the requested racers practice, not PBs or another account',()=>{
 const h=setup(),other='c'.repeat(64);h.history.begin(account,track).finish(100);h.history.begin(other,track).finish(200);h.history.clear(account);
 assert.equal(h.history.get(account,track),null);assert.equal(h.history.get(other,track).bestMs,200);
});
test('corrupt and excessive saved history is bounded and sanitized',()=>{
 const accounts={};for(let a=0;a<8;a++){const tracks={};for(let t=0;t<300;t++)tracks[t.toString(16).padStart(64,'0')]={attempts:'bad',activeMs:-1};accounts[a.toString(16).padStart(64,'0')]=tracks;}
 let saved;const history=createPracticeHistory({storage:{getItem:()=>JSON.stringify({version:1,accounts}),setItem:(_key,value)=>saved=value}});history.begin(account,track).finish(100);history.flush(true);
 const parsed=JSON.parse(saved);assert.ok(Object.keys(parsed.accounts).length<=4);for(const tracks of Object.values(parsed.accounts))assert.ok(Object.keys(tracks).length<=256);
});
test('practice is only a bounded hint and sparse data never claims a track is impossible',()=>{
 assert.deepEqual(practiceAdvice(null),{factor:1,text:''});assert.equal(practiceAdvice({attempts:1,activeMs:900000}).factor,1);
 const away=practiceAdvice({attempts:10,activeMs:60000,lastPlayedAt:0},8*86400000);assert.equal(away.factor,1.1);
 const plateau=practiceAdvice({attempts:20,activeMs:1000000,sincePbMs:900000,restartsSincePb:12,restarts:12,lastPlayedAt:10000},10000);assert.equal(plateau.factor,.9);assert.doesNotMatch(plateau.text,/impossible|never|bad player/);
});
function nativeFixture(onLeave=()=>{}){
 class Physics{createCar(_a,_b,_c,track,recording){return {id:1,carState:{frames:0},track,recording};}}
 class Car{constructor(state){this.state=state;this.reset=[];this.finish=[];this.started=true;this.paused=false;this.finished=false;}addResetCallback(fn){this.reset.push(fn);}addFinishCallback(fn){this.finish.push(fn);}getCarState(){return this.state;}getTime(){return {numberOfFrames:this.state.frames};}hasStarted(){return this.started;}hasFinished(){return this.finished;}get isPaused(){return this.paused;}getNextCheckpointIndex(){return 2;}dispose(){return 'native-disposed';}}
 let tick,shown=true,clock=0;const h=setup(),physics=new Physics(),require=id=>({A:id===5220?Physics:Car});
 const observer=installPracticeObserver({require,history:h.history,accountId:()=>account,onLeave,visible:()=>shown,clock:()=>clock,schedule:fn=>{tick=fn;return 1;},cancel(){}});
 const car=(recording=null)=>{const result=physics.createCar(null,null,null,{getId:()=>track},recording);const value=new Car(result.carState);value.addResetCallback(()=>{});return value;};
 return {h,physics,Car,Physics,require,observer,car,tick:()=>{clock+=1000;tick();},hide:()=>shown=false,show:()=>shown=true};
}
test('native observer excludes ghosts, pauses and hidden time; repeated install is idempotent',()=>{
 const f=nativeFixture();try{const ghost=f.car('replay');ghost.state.frames=1000;f.tick();assert.equal(f.h.history.get(account,track),null);
 const car=f.car();car.state.frames=1000;f.tick();f.hide();car.state.frames=2000;f.tick();f.show();car.paused=true;car.state.frames=3000;f.tick();car.paused=false;car.state.frames=4000;f.tick();
 assert.equal(f.h.history.get(account,track).activeMs,2000);
 assert.equal(installPracticeObserver({require:f.require}),f.observer);
 }finally{f.observer.stop();}
});
test('synchronous native car recreation counts a restart, leaving the track does not',async()=>{
 const f=nativeFixture();try{const first=f.car();first.state.frames=6000;f.tick();assert.equal(first.dispose(),'native-disposed');f.car();assert.equal(f.h.history.get(account,track).restarts,1);
 const last=f.car();last.state.frames=3000;last.dispose();await Promise.resolve();assert.equal(f.h.history.get(account,track).restarts,1);
 }finally{f.observer.stop();}
});
test('native finish counts once and native callback/return behavior stays intact',()=>{
 const f=nativeFixture();try{const car=f.car();car.state.frames=12000;car.finished=true;for(const callback of car.finish)callback(car);car.dispose();assert.equal(f.h.history.get(account,track).finishes,1);assert.equal(f.h.history.get(account,track).bestMs,12000);}finally{f.observer.stop();}
});
test('late analytics install cannot replace active event binding hooks',()=>{
 class Physics{};class Car{};Physics.prototype[Symbol.for('polytrack-native-local-binding')]=true;
 assert.throws(()=>installPracticeObserver({require:id=>({A:id===5220?Physics:Car})}),/practice_binding_already_active/);
});

test('a new PB clears the plateau restart count but retains lifetime restarts',()=>{
 const h=setup();for(let i=0;i<12;i++)h.history.begin(account,track,20000).restart(1000);
 h.history.begin(account,track).finish(19000);
 const row=h.history.get(account,track);assert.equal(row.restarts,12);assert.equal(row.restartsSincePb,0);
 assert.notEqual(practiceAdvice({...row,attempts:20,activeMs:1000000,sincePbMs:900000}).factor,.9);
});

test('opening and leaving a track without driving is not a practice attempt',()=>{
 const h=setup();h.history.begin(account,track).leave();
 const row=h.history.get(account,track);assert.equal(row.attempts,0);assert.equal(row.lastPlayedAt,0);
});

test('return hint uses observed improvements on other tracks without changing points',()=>{const at=1000000000,row={trackId:track,attempts:8,activeMs:600000,lastPlayedAt:at-4*86400000};const advice=practiceAdvice(row,at,{otherTracks:['c','d','e'].map(id=>({trackId:id.repeat(64),improvedMs:100,lastPbAt:at-1000}))});assert.equal(advice.factor,1.1);assert.match(advice.text,/3 other tracks improved/);});

test('native leave callback ignores repeated disposal and synchronous replacement',async()=>{let leaves=0;const f=nativeFixture(()=>leaves++);try{const first=f.car();first.dispose();f.car();await Promise.resolve();assert.equal(leaves,0);first.dispose();await Promise.resolve();assert.equal(leaves,0);const last=f.car();last.dispose();await Promise.resolve();assert.equal(leaves,1);last.dispose();await Promise.resolve();assert.equal(leaves,1);}finally{f.observer.stop();}});
