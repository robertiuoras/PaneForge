const WINDOW_MS=60_000,MAX_RECORDS=100;

function speech(input){return typeof input==='string'?input.trim().toLowerCase():'';}
function terminalSpeech(input){return speech(input).replace(/[.!?]+$/,'');}
function initial(input){return speech(input).match(/^(?:please\s+)?(?:delete session|trash session) (\d+)(?:\s+please)?[.!?]*$/);}
function cancelled(input){return /^(?:cancel|stop|no)[.!?]*$/.test(speech(input));}
function key(sessionId,connectionId){return `${sessionId}\u0000${connectionId}`;}
function snapshot(session){return {id:session.id,projectId:session.projectId,sessionNumber:session.sessionNumber,title:session.title,kind:session.kind,deletedAt:session.deletedAt};}
function titleLiteral(title){const characters=Array.from(String(title));return JSON.stringify(characters.length>24?`${characters.slice(0,23).join('')}…`:title);}

export class VoiceConfirmations {
 constructor({sessions,hasExternalWork=()=>false,now=()=>Date.now()}={}){if(!sessions)throw Error('Sessions are required');this.sessions=sessions;this.hasExternalWork=hasExternalWork;this.now=now;this.pending=new Map();this.seen=new Map();}
 prune(){const cutoff=this.now()-WINDOW_MS;for(const [id,time] of this.seen)if(time<cutoff)this.seen.delete(id);while(this.seen.size>MAX_RECORDS)this.seen.delete(this.seen.keys().next().value);while(this.pending.size>MAX_RECORDS)this.pending.delete(this.pending.keys().next().value);}
 getSession(id){try{return this.sessions.get?this.sessions.get(id):this.sessions.sessions.find(session=>session.id===id&&!session.deletedAt);}catch{return null;}}
 unchanged(record){const assistant=this.getSession(record.assistantId),target=this.getSession(record.target.id);return assistant?.kind==='assistant'&&assistant.projectId===record.projectId&&target&&target.kind!=='assistant'&&!target.deletedAt&&target.id===record.target.id&&target.projectId===record.target.projectId&&target.sessionNumber===record.target.sessionNumber&&target.title===record.target.title;}
 async handle({sessionId,connectionId,delegationId,input}={}){
  this.prune();if(typeof sessionId!=='string'||typeof connectionId!=='string'||typeof delegationId!=='string'||!delegationId)return null;
  if(this.seen.has(delegationId))return 'Already handled.';
  const ownKey=key(sessionId,connectionId),record=this.pending.get(ownKey),other=[...this.pending.values()].find(entry=>entry.assistantId===sessionId&&entry.connectionId!==connectionId);
  if(other&&(/^confirm(?: delete)? session \d+$/.test(terminalSpeech(input))||cancelled(input)))return 'Confirmation is tied to the original voice connection.';
  if(record){
   this.seen.set(delegationId,this.now());
   if(this.now()-record.createdAt>WINDOW_MS){this.pending.delete(ownKey);return 'Confirmation expired.';}
   if(cancelled(input)){this.pending.delete(ownKey);return 'Deletion cancelled.';}
   if(!this.unchanged(record)){this.pending.delete(ownKey);return 'Confirmation cancelled because the conversation changed.';}
   const expected=record.stage===1?`confirm session ${record.target.sessionNumber}`:`confirm delete session ${record.target.sessionNumber}`;
   if(terminalSpeech(input)!==expected){this.pending.delete(ownKey);return 'Deletion cancelled.';}
   if(record.stage===1){record.stage=2;return `Say "confirm delete session ${record.target.sessionNumber}" to move this conversation to Trash.`;}
   this.pending.delete(ownKey);
   try{await this.sessions.remove(record.target.id,{hasExternalWork:this.hasExternalWork});return `Session ${record.target.sessionNumber} moved to Trash.`;}
   catch{return 'Conversation was not deleted.';}
  }
  if(/^confirm(?: delete)? session \d+$/.test(terminalSpeech(input)))return 'No pending confirmation.';
  const match=initial(input);if(!match)return null;
  const assistant=this.getSession(sessionId);if(!assistant||assistant.kind!=='assistant'||assistant.deletedAt)return null;
  const number=Number(match[1]),matches=(this.sessions.sessions||[]).filter(session=>session.kind!=='assistant'&&!session.deletedAt&&session.projectId===assistant.projectId&&session.sessionNumber===number);
  if(matches.length!==1)return 'No unique saved conversation has that session number.';
  this.seen.set(delegationId,this.now());const target=snapshot(matches[0]);this.pending.set(ownKey,{assistantId:sessionId,connectionId,projectId:assistant.projectId,target,createdAt:this.now(),stage:1});
  return `Move this saved conversation to recoverable Trash? Session ${target.sessionNumber}, ${titleLiteral(target.title)}. Say "confirm session ${target.sessionNumber}".`;
 }
}
