// Observes native callbacks only. No engine assets, inputs, replay data or messages are changed.
const installed=new WeakMap();
export function installPracticeObserver({require,history,accountId,bestMs=()=>0,visible=()=>true,onTrack=()=>{},onLeave=()=>{},schedule=setInterval,cancel=clearInterval,clock=()=>performance.now()}){
 const Physics=require(5220)?.A,Car=require(641)?.A;
 if(!Physics?.prototype||!Car?.prototype)throw Error('practice_native_unavailable');
 const pp=Physics.prototype,cp=Car.prototype;
 if(installed.has(pp))return installed.get(pp);
 if(pp[Symbol.for('polytrack-native-local-binding')])throw Error('practice_binding_already_active');
 for(const fn of ['addResetCallback','addFinishCallback','getCarState','getTime','hasStarted','hasFinished','getNextCheckpointIndex','dispose'])if(typeof cp[fn]!=='function')throw Error('practice_native_contract');
 if(typeof Object.getOwnPropertyDescriptor(cp,'isPaused')?.get!=='function')throw Error('practice_native_contract');
 if(typeof pp.createCar!=='function')throw Error('practice_native_contract');
 const originalCreate=pp.createCar,originalReset=cp.addResetCallback,originalFinish=cp.addFinishCallback;
 const states=new WeakMap(),attached=new WeakSet();let current=null,pending=null,stopped=false;
 const report=fn=>{try{return fn();}catch{return undefined;}};
 function sample(){
  if(!current)return;
  const frame=Number(current.car.getTime()?.numberOfFrames)||0;
  const delta=frame-current.frame,wall=clock()-current.sampleAt;current.sampleAt=clock();
  if(wall>2500||!visible()||current.car.isPaused)current.reliable=false;
  if(visible()&&!current.car.isPaused&&current.car.hasStarted()&&!current.finished&&delta>0)current.attempt?.tick(delta,current.car.getNextCheckpointIndex(),Math.min(2000,Math.max(0,current.running?wall:Math.min(wall,delta))));
  current.running=visible()&&!current.car.isPaused&&current.car.hasStarted()&&!current.finished&&delta>0;
  current.frame=frame;current.last=Math.max(current.last,frame);
 }
 function create(...args){
  const result=originalCreate.apply(this,args);
  if(!stopped&&args[4]==null&&result?.carState&&args[3]?.getId){const trackId=report(()=>args[3].getId());if(/^[a-f0-9]{64}$/.test(trackId||''))states.set(result.carState,{trackId,physics:this});}
  return result;
 }
 function resetRegistration(callback){
  if(!stopped&&!attached.has(this)){
   const evidence=report(()=>states.get(this.getCarState()));
   if(evidence){
    attached.add(this);report(()=>{
     if(pending&&pending.physics===evidence.physics&&pending.trackId===evidence.trackId&&pending.account===accountId()){pending.attempt?.restart(pending.last);pending=null;}
     if(current){sample();current.attempt?.leave();}
     const car=this,account=accountId(),attempt=history.begin(account,evidence.trackId,bestMs(account,evidence.trackId));
     const state={...evidence,account,car,attempt,frame:Number(car.getTime()?.numberOfFrames)||0,last:0,finished:false,sampleAt:clock(),reliable:true};current=state;
     report(()=>onTrack(evidence.trackId));
     originalReset.call(car,()=>report(()=>{sample();if(!state.finished){state.reliable=false;attempt?.respawn(state.last);}}));
     originalFinish.call(car,()=>report(()=>{if(current===state)sample();attempt?.finish(Number(car.getFinishTime?.()?.numberOfFrames??car.getTime()?.numberOfFrames),{reliable:state.reliable});state.finished=true;}));
     const dispose=car.dispose;
     car.dispose=function(...args){
      if(current===state){report(sample);current=null;if(!state.finished){pending=state;queueMicrotask(()=>{if(pending===state){pending=null;attempt?.leave();}});}
       queueMicrotask(()=>{if(!stopped&&current===null)report(()=>onLeave(state.trackId));});}
      return dispose.apply(this,args);
     };
    });
   }
  }
  return originalReset.call(this,callback);
 }
 pp.createCar=create;cp.addResetCallback=resetRegistration;
 const timer=schedule(()=>report(sample),1000);
 const handle={stop(){stopped=true;cancel(timer);if(pp.createCar===create)pp.createCar=originalCreate;if(cp.addResetCallback===resetRegistration)cp.addResetCallback=originalReset;current?.attempt?.leave();current=null;pending=null;history.flush(true);installed.delete(pp);}};
 installed.set(pp,handle);return handle;
}
