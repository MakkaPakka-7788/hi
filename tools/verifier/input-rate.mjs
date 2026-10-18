// Review-only press-edge heuristic. A held key has one press, not OS key repeats.
export function inputRateEvidence(controls,timeMs,{threshold=10,windowMs=1000}={}){
  if(!Number.isSafeInteger(timeMs)||timeMs<windowMs||timeMs>300000||threshold!==10||windowMs!==1000)return null;
  const findings=[];
  for(const channel of ['up','right','down','left','reset']){
    const ticks=controls?.lists?.[channel];
    if(!Array.isArray(ticks)||ticks.length>4096)continue;
    if(ticks.some((tick,i)=>!Number.isSafeInteger(tick)||tick<0||tick>timeMs||(i&&tick<=ticks[i-1])))continue;
    const presses=ticks.filter((tick,index)=>index%2===0&&tick<timeMs);
    let end=0,best=null;
    for(let start=0;start<presses.length;start++){
      const from=presses[start];if(from+windowMs>timeMs)break;
      end=Math.max(end,start);
      while(end<presses.length&&presses[end]<from+windowMs)end++;
      if(end-start>threshold&&(!best||end-start>best.presses))best={channel,startMs:from,endMs:from+windowMs,presses:end-start,pressesPerSecond:end-start};
    }
    if(best)findings.push(best);
  }
  return findings.length?{kind:'rapid_input',version:1,windowMs,threshold,channels:findings,notice:'Advisory only. Fast input is not proof of TAS, automation, or cheating.'}:null;
}
