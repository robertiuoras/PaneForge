// Generated portable copy of src/shared/promptForge.ts's pure composition rules.
// Update this file from that source during a build; the hash makes divergence visible.
export const PROMPT_FORGE_SOURCE_SHA256='a00700a7ead4629e428bb3257bc2b8bd1fdd5dec47f207a5911d3e9470f148e6';
export const MAX_PROMPT_CHARS=6000, EXAMPLE_CHARS=600, MAX_EXAMPLES=2;
export const DEFAULT_DONE='say what changed and name the command, flow or file that proves it';
export const DONE_HEAD='Done means:';
export const REMOTE_RENDER_INSTRUCTION='For browser or video rendering, use the established PC rbuild/SSH path. Do not render locally; first verify that the PC is available, and report the actual remote result.';
export const BUILT_IN_TEMPLATES={
  'multi-item-opener':{id:'multi-item-opener',guidance:['each item is finished and proved on its own before the next is started','an item that turns out to be blocked is named, not quietly dropped']},
  'build-feature':{id:'build-feature',guidance:['the behaviour is shown working locally before anything is pushed','the files changed match the scope that was fenced']},
  'research-decide':{id:'research-decide',guidance:['the answer is a decision with the reason, not a survey of the options','anything left out of the decision is named']}
};
export const builtInTemplate=id=>BUILT_IN_TEMPLATES[id]||null;
export function trimExample(text,max=EXAMPLE_CHARS){const body=String(text||'').trim();if(body.length<=max)return body;const cut=body.slice(0,max),nl=cut.lastIndexOf('\n');return(nl>max*.6?cut.slice(0,nl):cut).trimEnd()+'\n…';}
const lines=v=>(v||[]).map(s=>String(s||'').trim()).filter(Boolean);
const bullets=(head,items)=>items.length?[head,...items.map(s=>`- ${s}`),'']:[];
export function forgePrompt(input={}){
  const task=String(input.task||'').trim(),anchors=lines(input.anchors),done=lines(input.done),scope=lines(input.scope),guidance=lines(input.template?.guidance);
  const examples=lines(input.examples??input.template?.examples).slice(0,MAX_EXAMPLES).map(trimExample);
  const doneBlock=[DONE_HEAD,...(done.length?done:[DEFAULT_DONE]).map(s=>`- ${s}`)].join('\n');
  const exampleBlock=keep=>keep<=0||!examples.length?[]:[keep===1?'An example of a good ask of this kind:':'Examples of a good ask of this kind:',...examples.slice(0,keep).flatMap(e=>['---',e,'---']),''];
  const build=(keep,withGuidance,body)=>[body,'',...bullets('Start from:',anchors),...bullets('Stay inside:',scope),...(withGuidance?bullets('Judged on:',guidance):[]),...exampleBlock(keep),doneBlock].join('\n').replace(/\n{3,}/g,'\n\n').trim();
  const budget=Math.max(1,input.budget??MAX_PROMPT_CHARS);
  for(let keep=examples.length;keep>=0;keep--){const out=build(keep,true,task);if(out.length<=budget)return out;}
  const bare=build(0,false,task);if(bare.length<=budget)return bare;
  const over=bare.length-budget;return build(0,false,task.slice(0,Math.max(0,task.length-over-2)).trimEnd()+'…');
}
/** The runtime's build-task entrypoint keeps the shared prompt shape and PC rendering boundary. */
export function forgeBuildPrompt(task,input={}){
  const source={...input,task,template:input.template||builtInTemplate('build-feature'),scope:[...(input.scope||[]),REMOTE_RENDER_INSTRUCTION]};
  const complete=forgePrompt({...source,budget:Number.MAX_SAFE_INTEGER});
  if(complete.length>MAX_PROMPT_CHARS)throw Error(`Build prompt exceeds ${MAX_PROMPT_CHARS} characters; save the brief as an attachment or shorten it so no requirement is lost.`);
  return complete;
}
