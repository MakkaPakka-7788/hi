import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect,decode} from './firestore.mjs';
import {REVIEW_COLLECTION,reviewInboxWrite} from './review-inbox.mjs';

export async function backfillReviewPage(db,{limit=25}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>50)throw Error('Invalid backfill limit');
  const matches=new Map();let mayHaveMore=false;
  for(const [field,value] of [['needsReview',{booleanValue:true}],['status',{stringValue:'mismatch'}]]) {
    const response=await db.call(':runQuery',{structuredQuery:{from:[{collectionId:'0.6.2_s1_verification_audit'}],
      where:{fieldFilter:{field:{fieldPath:field},op:'EQUAL',value}},
      select:{fields:['accountId','trackId','resultId','timeMs','status','reason','checkedAt','reviewEvidence'].map(fieldPath=>({fieldPath}))},limit}});
    if(!Array.isArray(response))throw Error('Unexpected backfill response');
    const docs=response.filter(item=>item.document).map(item=>item.document);mayHaveMore ||= docs.length===limit;
    for(const doc of docs){const id=doc.name.split('/').at(-1);if(/^[a-f0-9]{64}$/.test(id))matches.set(id,decode({mapValue:{fields:doc.fields||{}}}));}
  }
  const writes=[];
  for(const [id,audit] of matches) {
    if(!audit.accountId||!audit.trackId||!audit.resultId)continue;
    const write=await reviewInboxWrite(db,id,audit,audit,audit.reviewEvidence);
    if(write)writes.push(write);
  }
  // Creation preconditions prevent overwriting concurrent findings or decisions.
  if(writes.length)await db.call(':commit',{writes});
  return {matched:matches.size,created:writes.length,mayHaveMore};
}

export async function readReviewPage(db,{status='open',limit=50,after=null}={}) {
  if(!['open','resolved','dismissed','all'].includes(status)||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid review page');
  if(after!==null&&!/^[a-f0-9]{64}$/.test(after))throw Error('Invalid review cursor');
  const query={from:[{collectionId:REVIEW_COLLECTION}],limit,
    orderBy:[{field:{fieldPath:'__name__'},direction:'ASCENDING'}],
    ...(status==='all'?{}:{where:{fieldFilter:{field:{fieldPath:'status'},op:'EQUAL',value:{stringValue:status}}}}),
    ...(after?{startAt:{values:[{referenceValue:`projects/polytrack-052/databases/(default)/documents/${REVIEW_COLLECTION}/${after}`}],before:false}}:{})};
  const response=await db.call(':runQuery',{structuredQuery:query});
  if(!Array.isArray(response))throw Error('Unexpected review response');
  const rows=response.filter(x=>x.document).map(({document})=>({id:document.name.split('/').at(-1),...decode({mapValue:{fields:document.fields||{}}})}));
  return {collection:REVIEW_COLLECTION,status,rows,limit,mayHaveMore:rows.length===limit,nextCursor:rows.length===limit?rows.at(-1).id:null,generatedAt:new Date().toISOString()};
}
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function reviewHtml(page) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PolyTrack Review Inbox</title>
<style>body{font:16px/1.5 Georgia,serif;background:#f4f1e9;color:#17303b;margin:0;padding:28px}main{max-width:1200px;margin:auto}h1{margin:0}p{max-width:850px}.note{background:#e0eae7;padding:16px;border-left:4px solid #276e65}.cards{display:grid;gap:16px}article{background:white;padding:20px;border:1px solid #b8cbc9}h2{margin:0 0 8px;font-size:22px}dl{display:grid;grid-template-columns:140px 1fr;gap:6px}dt{font-weight:bold}dd{margin:0;overflow-wrap:anywhere}code{font-size:13px}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}@media(max-width:550px){body{padding:14px}dl{grid-template-columns:1fr}dd{margin-bottom:8px}}</style><main><h1>PolyTrack Review Inbox</h1>
<p>Only suspicious input matches and verification mismatches appear here. Neither is proof of cheating. Ordinary verified runs and temporary verification failures are excluded.</p>
<p class="note">${page.rows.length} findings in this ${escape(page.status)} page. ${page.mayHaveMore?'More findings may exist; the next cursor is shown below.':'This query returned less than a full page.'} This is a private, read-only report, not live data. Generated ${escape(page.generatedAt)}.</p>
<p>In Firebase, open <code>${REVIEW_COLLECTION}</code>. Set a finding's <code>status</code> to <code>resolved</code> or <code>dismissed</code> after review. Add <code>reviewNote</code> if helpful. Verification retries will not overwrite your decision. Do not remove findings to hide them.</p>
<section class="cards">${page.rows.map(row=>`<article><h2>${escape(row.category==='exact_duplicate'||row.evidence?.kind==='identical_replay'?'Exact duplicate':row.category==='input_similarity'?'Similar replay inputs':'Verification mismatch')} · ${escape(row.status)}</h2><dl><dt>Finding ID</dt><dd><code>${escape(row.id)}</code></dd><dt>Racer ID</dt><dd><code>${escape(row.accountId)}</code></dd><dt>Track</dt><dd>${escape(row.trackName||row.trackId)} <code>${escape(row.trackId)}</code></dd><dt>Run time</dt><dd>${row.timeMs==null?'Unavailable':escape(row.timeMs)+' ms'}</dd><dt>Detected</dt><dd>${escape(Number.isFinite(row.detectedAt)?new Date(row.detectedAt).toISOString():'Unknown')}</dd><dt>Reason</dt><dd>${escape(row.reason||row.category)}</dd></dl><details><summary>Review evidence</summary><pre>${escape(JSON.stringify(row.evidence||{},null,2))}</pre></details></article>`).join('')||'<article>No findings in this page.</article>'}</section>
${page.nextCursor?`<p>Next cursor: <code>${escape(page.nextCursor)}</code></p>`:''}</main></html>`;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const option=name=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
  try {
    const output=option('html');if(!output||output.includes('://'))throw Error('A private local --html path is required');
    const raw=process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;delete process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;
    if(!raw)throw Error('Private service-account environment variable required');
    const db=await connect(raw);
    const backfill=process.argv.includes('--backfill')?await backfillReviewPage(db):null;
    const page=await readReviewPage(db,{status:option('status')||'open',limit:Number(option('limit')||50),after:option('after')||null});
    await fs.writeFile(path.resolve(output),reviewHtml(page));
    console.log(JSON.stringify({findings:page.rows.length,mayHaveMore:page.mayHaveMore,nextCursor:page.nextCursor,backfill,estimatedReads:db.estimatedDocumentReads(),output:path.resolve(output)}));
  } catch(error){console.error('Review report failed: '+error.message);process.exitCode=1;}
}
