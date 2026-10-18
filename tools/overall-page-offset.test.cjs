const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  let overallPageOffset=0;');
const end=source.indexOf('  function handleArchivePageShortcut(',start);
function fixture(){
 let now=1000;const jumps=[];const panel={querySelector:()=>null};
 const context=vm.createContext({Date:{now:()=>now},HTMLInputElement:class{},HTMLTextAreaElement:class{},HTMLSelectElement:class{},document:{getElementById:()=>panel},isElementVisible:value=>Boolean(value),overallPage:4,currentLeaderboardCount:()=>400,OVERALL_PAGE_SIZE:10,
 shortcutDigit:event=>/^Digit[0-9]$/.test(event.code)?Number(event.code.at(-1))||10:null,
 jumpOverallPage:page=>{if(page<1||page>40)return false;jumps.push(page);context.overallPage=page-1;return true;},changeOverallPage:delta=>context.overallPage+=delta});
 vm.runInContext(source.slice(start,end),context);
 const key=(code,other={})=>context.handleOverallLeaderboardShortcut({code,key:'',target:null,shiftKey:true,preventDefault(){},stopPropagation(){},...other});
 return {context,jumps,key,advance:()=>now+=4000};
}
test('relative page shortcuts add and subtract without changing direct Shift digits',()=>{
 const f=fixture();f.key('Equal');f.key('Digit5');assert.deepEqual(f.jumps,[10]);
 f.key('Minus');f.key('Digit3');assert.deepEqual(f.jumps,[10,7]);
 f.context.handleOverallLeaderboardModifierRelease({key:'Shift',code:'ShiftLeft'});f.key('Digit2');assert.deepEqual(f.jumps,[10,7,2]);
 f.key('NumpadAdd');f.key('Digit0');assert.deepEqual(f.jumps,[10,7,2,12]);
});
test('relative page mode survives delay but clears on Shift release and ignores typing',()=>{
 const f=fixture();f.key('Equal');f.advance();f.key('Digit5');assert.deepEqual(f.jumps,[10]);f.context.handleOverallLeaderboardModifierRelease({key:'Shift',code:'ShiftRight'});
 f.key('Equal',{ctrlKey:true});f.key('Digit3');assert.equal(f.jumps.at(-1),3);
 f.key('Digit4',{target:new f.context.HTMLInputElement()});assert.equal(f.jumps.at(-1),3);
 f.key('Minus',{repeat:true});f.key('Digit2');assert.equal(f.jumps.at(-1),2);
});

test('relative jumps clamp to available pages rather than silently doing nothing',()=>{
 const f=fixture();f.key('Minus');f.key('Digit9');assert.equal(f.jumps.at(-1),1);
 f.context.overallPage=37;f.key('Equal');f.key('Digit9');assert.equal(f.jumps.at(-1),40);
});

test('repeated plus/minus digits preserve relative mode until Shift is released',()=>{
 const f=fixture();f.key('Equal');f.key('Digit3');f.key('Digit3');f.advance();f.key('Digit3');assert.deepEqual(f.jumps,[8,11,14]);
 f.key('Minus');f.key('Digit3');f.key('Digit3');assert.deepEqual(f.jumps,[8,11,14,11,8]);
 f.context.handleOverallLeaderboardModifierRelease({key:'3',code:'Digit3'});f.key('Digit3');assert.equal(f.jumps.at(-1),5);
 f.context.handleOverallLeaderboardModifierRelease({key:'Shift',code:'ShiftLeft'});f.key('Digit3');assert.equal(f.jumps.at(-1),3);
 f.key('Equal');f.context.resetOverallPageOffset();f.key('Digit2');assert.equal(f.jumps.at(-1),2);
});
test('keyup and window blur are wired to modifier-mode cleanup',()=>{
 assert.match(source,/addEventListener\('keyup',handleOverallLeaderboardModifierRelease\)/);
 assert.match(source,/addEventListener\('blur',resetOverallPageOffset\)/);
});

function pageFieldFixture(){
 const pages=[];const context=vm.createContext({overallPage:4,changeOverallPage(delta){context.overallPage=Math.max(0,Math.min(9,context.overallPage+delta));pages.push(context.overallPage+1);},jumpOverallPage(page){if(!Number.isSafeInteger(page)||page<1||page>10)return false;context.overallPage=page-1;pages.push(page);return true;}});
 vm.runInContext(source.slice(source.indexOf('  function handleOverallPageInput('),source.indexOf('  function jumpOverallPage(')),context);
 const input={id:'overallPageJump',value:'5'};
 return {context,input,pages,event(type,key,inputType){return {type,key,inputType,target:input,preventDefault(){this.prevented=true;},stopPropagation(){}};}};
}
test('footer up/down arrows change pages immediately and clamp at ends',()=>{
 const f=pageFieldFixture();const up=f.event('keydown','ArrowUp');assert.equal(f.context.handleOverallPageInput(up),true);assert.equal(up.prevented,true);assert.equal(f.input.value,'6');
 f.context.handleOverallPageInput(f.event('keydown','ArrowDown'));assert.deepEqual(f.pages,[6,5]);f.context.overallPage=0;f.input.value='1';f.context.handleOverallPageInput(f.event('keydown','ArrowDown'));assert.equal(f.input.value,'1');
});
test('footer spinner switches immediately while text entry waits for Enter',()=>{
 const f=pageFieldFixture();f.input.value='7';f.context.handleOverallPageInput(f.event('input'));assert.deepEqual(f.pages,[7]);
 f.input.value='1';assert.equal(f.context.handleOverallPageInput(f.event('input',null,'insertText')),false);assert.deepEqual(f.pages,[7]);
 assert.match(source,/addEventListener\('input',handleOverallPageInput\)/);
});

test('page-field arrows step from an edited page number rather than losing the edit',()=>{const f=pageFieldFixture();f.input.value='7';f.context.handleOverallPageInput(f.event('keydown','ArrowUp'));assert.equal(f.input.value,'8');assert.deepEqual(f.pages,[8]);});
