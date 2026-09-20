import assert from 'node:assert/strict';import test from 'node:test';
import {chooseCodexRoute,quotaVerdict,explicitBuildIntent} from '../server/routing.mjs';
test('direct and polite implementation requests select Code',()=>{
  for(const text of ['build a review card','Please fix the broken link','can you build a review card?','Could you please implement chat replies?','please would you add a search field','I want you to create the dashboard','I need you to fix this','I’d like you to add filters']) assert.equal(explicitBuildIntent(text),true,text);
});
test('questions, negations, quotations and missing tasks stay in Chat',()=>{
  for(const text of ['How can you build a review card?','Can you explain how to build this?','Could you review this build?','Do not build anything','Can you not create files?','"build a dashboard"','I want to discuss how to build this','Can you build?','build','create!','addendum',null,{}]) assert.equal(explicitBuildIntent(text),false,JSON.stringify(text));
});
test('help and ability phrasing still requires a task rather than negation or punctuation',()=>{
  for(const text of ['Would you be able to fix the bug?','Can you help me build the card?','Could you please help me to create a report?','build ./dashboard','fix 登录']) assert.equal(explicitBuildIntent(text),true,text);
  for(const text of ['Please build nothing','Can you build please?','build,','build…','build ...','create please','Please add no files','Could you fix not now']) assert.equal(explicitBuildIntent(text),false,text);
});
const models={data:[{id:'gpt-6-astra',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{id:'gpt-5.6-terra',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}]}]};
const quota={ordinaryUsageAllowed:true,rateLimits:{spendControlReached:false,rateLimitReachedType:null}};
test('routes deep tasks to live Astra high and simple tasks to a smaller live model',()=>{assert.deepEqual(chooseCodexRoute({task:'debug a security migration',models,rateLimits:quota}),{ok:true,model:'gpt-6-astra',effort:'high'});assert.deepEqual(chooseCodexRoute({task:'fix a small typo',models,rateLimits:quota}),{ok:true,model:'gpt-5.6-terra',effort:'low'});});
test('uses a live catalogue default when the task gives no stronger signal',()=>{assert.deepEqual(chooseCodexRoute({task:'continue the implementation',models:{data:[models.data[1]]},rateLimits:quota}),{ok:true,model:'gpt-5.6-terra',effort:'medium'});});
test('refuses unsupported model or effort',()=>{assert.equal(chooseCodexRoute({task:'x',models,rateLimits:quota,requestedModel:'made-up'}).ok,false);assert.equal(chooseCodexRoute({task:'x',models,rateLimits:quota,requestedModel:'gpt-5.6-terra',requestedEffort:'high'}).ok,false);});
test('unknown, incomplete, or exhausted usage never selects a paid fallback',()=>{assert.equal(quotaVerdict({}).ok,false);assert.equal(quotaVerdict({ordinaryUsageAllowed:false,rateLimits:{spendControlReached:false}}).ok,false);assert.equal(quotaVerdict({ordinaryUsageAllowed:true,rateLimits:{}}).ok,false);assert.equal(quotaVerdict({ordinaryUsageAllowed:true,rateLimits:{spendControlReached:true}}).ok,false);});
