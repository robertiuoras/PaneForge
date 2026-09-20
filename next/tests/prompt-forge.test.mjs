import assert from 'node:assert/strict';import test from 'node:test';
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {forgePrompt,forgeBuildPrompt,MAX_PROMPT_CHARS,PROMPT_FORGE_SOURCE_SHA256,builtInTemplate,REMOTE_RENDER_INSTRUCTION} from '../server/prompt-forge.mjs';
test('preserves acceptance and done evidence',()=>{const output=forgePrompt({task:'Fix the route',template:builtInTemplate('build-feature'),done:['node --test']});assert.match(output,/Fix the route/);assert.match(output,/Done means:\n- node --test/);assert.match(output,/Judged on:/);});
test('truncates optional material before its task and done evidence',()=>{const output=forgePrompt({task:'A'.repeat(9000),anchors:['x'],examples:['E'.repeat(1000)],budget:180});assert.ok(output.length<=180);assert.match(output,/Done means:/);assert.match(output,/…/);});
test('build prompts reject oversize briefs rather than truncating requirements',()=>assert.throws(()=>forgeBuildPrompt('A'.repeat(7000)),/exceeds 6000/));
test('build prompts require remote PC rendering evidence',()=>assert.match(forgeBuildPrompt('Make a launch video'),new RegExp(REMOTE_RENDER_INSTRUCTION.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))));
test('copy records the source hash when source checkout is present',()=>{const source=readFileSync(new URL('../../src/shared/promptForge.ts',import.meta.url));assert.equal(createHash('sha256').update(source).digest('hex'),PROMPT_FORGE_SOURCE_SHA256);assert.equal(MAX_PROMPT_CHARS,6000);});
