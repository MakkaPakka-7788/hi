import test from 'node:test';
import assert from 'node:assert/strict';
import {readReviewPage,reviewHtml,backfillReviewPage} from './review-report.mjs';
test('review queries only the indexed inbox, never scans audits or canonical replays',async()=>{
  let query,calls=0;
  const result=await readReviewPage({call:async(_,{structuredQuery})=>{calls++;query=structuredQuery;return [];}});
  assert.equal(calls,1);assert.equal(query.from[0].collectionId,'0.6.2_s1_review_inbox');
  assert.equal(query.where.fieldFilter.value.stringValue,'open');assert.equal(query.limit,50);assert.equal(result.mayHaveMore,false);
});
test('limits and cursors are bounded before any database call',async()=>{
  for(const options of [{limit:101},{status:'bad'},{after:'../x'}])await assert.rejects(readReviewPage({},options));
});
test('private report escapes names, evidence and identifiers',()=>{
  const html=reviewHtml({rows:[{accountId:'<script>x</script>',evidence:{text:'<img src=x>'}}],status:'open',generatedAt:'now'});
  assert.doesNotMatch(html,/<script>|<img/);assert.match(html,/&lt;script&gt;/);
});
test('report labels the exact_duplicate category explicitly',()=>{
  const html=reviewHtml({rows:[{id:'a'.repeat(64),category:'exact_duplicate',status:'open',reason:'exact_duplicate_run'}],
    status:'open',generatedAt:'now'});
  assert.match(html,/<h2>Exact duplicate · open<\/h2>/);
});
test('historical backfill uses only two filtered, bounded queries',async()=>{
  const queries=[];
  const result=await backfillReviewPage({call:async(_,body)=>{queries.push(body.structuredQuery);return [];}});
  assert.equal(queries.length,2);assert.ok(queries.every(query=>query.limit===25&&query.where));
  assert.equal(result.created,0);assert.equal(result.mayHaveMore,false);
});
