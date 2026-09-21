import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const text = (value, max, field) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`Invalid ${field}`); return value.trim(); };
const extensions = new Set(['.html','.htm','.md','.txt','.log','.pdf','.png','.jpg','.jpeg','.webp','.csv','.json']);
const atomic = (file, value) => { mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 }); const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, value, { mode: 0o600 }); renameSync(temp, file); };
const safeLinks = value => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30) throw Error('Invalid review links');
  return value.map(link => {
    const label = text(link?.label, 300, 'review link label'), raw = text(link?.url, 4000, 'review link URL');
    let url; try { url = new URL(raw); } catch { throw Error('Invalid review link URL'); }
    if (url.protocol === 'http:' || url.protocol === 'https:') return { label, url: url.href };
    if (url.protocol !== 'file:' || url.hostname) throw Error('Unsupported review link URL');
    const file = fileURLToPath(url);
    if (!extensions.has(extname(file).toLowerCase()) || !existsSync(file) || !statSync(file).isFile()) throw Error('Unsupported review evidence file');
    return { label, url: pathToFileURL(file).href };
  });
};
const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
const page = r => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(r.title)} · PaneForge</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#15191b;color:#e2e7e7;font:16px/1.65 system-ui,sans-serif}main{max-width:820px;margin:auto;padding:48px 24px}header{border-bottom:1px solid #3b4649;padding-bottom:24px}.brand{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a1b8b8}h1{font-size:30px;line-height:1.25;margin:14px 0}h2{font-size:17px;margin:32px 0 10px}.meta{color:#a9b6ba;font-size:13px}.badge{display:inline-block;padding:3px 10px;border:1px solid #52615e;border-radius:20px;margin-right:8px}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}a{color:#b5dacd;text-underline-offset:3px}li{margin:8px 0}details{margin-top:32px;padding-top:20px;border-top:1px solid #3b4649}summary{cursor:pointer;font-weight:600}details pre{margin-top:14px}footer{margin-top:40px;color:#a9b6ba;font-size:12px;overflow-wrap:anywhere}</style><main><header><div class="brand">PaneForge · Review</div><h1>${escape(r.title)}</h1><div class="meta"><span class="badge">${escape(r.kind === 'decision' ? 'Your decision needed' : r.kind === 'blocked' ? 'Needs attention' : 'Result ready')}</span>${escape(r.lane || '')} · ${escape(r.createdAt)}<br>Evidence: ${escape(r.proof === 'measured' ? 'verified' : r.proof === 'claimed' ? 'agent reported' : 'unverified')}</div></header>${r.resolvedAt ? '<p>A later completion receipt supersedes this interruption. See the retained completion result in Review.</p>' : ''}<h2>Result</h2><pre>${escape(r.report)}</pre>${r.links?.length ? `<h2>Open the work</h2><ul>${r.links.map(link => `<li><a href="${escape(link.url)}" rel="noreferrer">${escape(link.label)}</a></li>`).join('')}</ul>` : ''}${r.evidence?.length ? `<h2>Evidence retained</h2><ul>${r.evidence.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}<details><summary>Your original request</summary><pre>${escape(r.prompt)}</pre></details><footer>Conversation ${escape(r.nativeSessionId || "not confirmed")} · ${escape(r.provider)}<br>This report stays in Review so you can return to the work.</footer></main></html>`;

export class ReviewStore {
  constructor(dataDir, { onRecord = null } = {}) { this.root = join(dataDir, 'reviews'); this.receipts = join(this.root, 'receipts'); this.onRecord = onRecord; }
  path(reviewId) { return join(this.root, `${reviewId}.json`); }
  reportPath(reviewId) { return join(this.root, `${reviewId}.html`); }
  read(reviewId) { try { return JSON.parse(readFileSync(this.path(reviewId), 'utf8')); } catch { return null; } }
  write(record) { atomic(this.reportPath(record.id), page(record)); atomic(this.path(record.id), JSON.stringify(record, null, 2)); return record; }
  record(input, session) {
    const unidentifiedFailure=input?.execution==='pc' && input.kind==='blocked' && input.proof==='unverified' && session?.nativeSessionId===null;
    if (!id(input?.id) || !id(input?.sessionId) || !id(session?.id) || (!id(session?.nativeSessionId) && !unidentifiedFailure)) throw Error('Invalid review or native session ID');
    if (input.sessionId !== session.id || input.nativeSessionId && input.nativeSessionId !== session.nativeSessionId) throw Error('Review native session ID does not match the retained session');
    if (!['result','decision','blocked'].includes(input.kind) || !['measured','claimed','unverified'].includes(input.proof)) throw Error('Invalid review kind or proof');
    if (input.execution !== undefined && (input.execution !== 'pc' || !id(input.terminalId))) throw Error('Invalid review executor');
    const base = { ...(input.execution === 'pc' ? {execution:'pc',terminalId:input.terminalId} : {}), id: input.id, sessionId: session.id, nativeSessionId: session.nativeSessionId, kind: input.kind, proof: input.proof, report: text(input.report,100000,'review report'), prompt: typeof input.prompt === 'string' ? input.prompt.slice(0,100000) : '', ...(typeof input.requestId === 'string' && id(input.requestId) ? { requestId: input.requestId } : {}), lane: typeof input.lane === 'string' ? input.lane.slice(0,300) : undefined, evidence: Array.isArray(input.evidence) ? input.evidence.map(v => text(v,10000,'review evidence')) : [], links: safeLinks(input.links), title: text(session.title || 'Untitled conversation',1000,'native title'), provider: text(session.provider || 'codex',200,'native provider'), cwd: text(session.cwd || process.cwd(),4000,'native cwd'), informational: input.informational === true, notify: input.notify === true, reportPath: this.reportPath(input.id), createdAt: new Date().toISOString(), attention: input.kind !== 'result' };
    const prior = this.read(base.id), hash = createHash('sha256').update(JSON.stringify({...base,createdAt:undefined,reportPath:undefined})).digest('hex');
    if (prior) { if (prior.payloadHash !== hash) throw Error('Conflicting duplicate review ID'); return prior; }
    base.payloadHash = hash; const saved=this.write(base); try { this.onRecord?.(saved); } catch (error) { saved.noticeError=error.message; this.write(saved); } return saved;
  }
  list() { if (!existsSync(this.root)) return []; return readdirSync(this.root).filter(file => /^[A-Za-z0-9_-]+\.json$/.test(file)).flatMap(file => { const r=this.read(file.slice(0,-5)); return r?[r]:[]; }).map(r => ({...r, attention:r.kind === 'result' ? !r.reviewedAt : r.attention})).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)); }
  ack(reviewId, reviewed) { const record = id(reviewId) && this.read(reviewId); if (!record) return {ok:false,clearedAttention:false}; if (record.kind !== 'result') return {ok:true,clearedAttention:false}; if (reviewed) { record.reviewedAt = new Date().toISOString(); record.attention=false; } else { delete record.reviewedAt; record.attention=true; } this.write(record); return {ok:true,clearedAttention:Boolean(reviewed)}; }
  open(reviewId, index) { const record = id(reviewId) && this.read(reviewId); if (!record || !Number.isInteger(index)) return null; if (index === -1) return existsSync(record.reportPath) ? record.reportPath : null; const link=record.links?.[index]; if (!link) return null; try { const url=new URL(link.url); if (url.protocol==='http:'||url.protocol==='https:') return url.href; if (url.protocol !== 'file:' || url.hostname) return null; const file=fileURLToPath(url); return extensions.has(extname(file).toLowerCase()) && existsSync(file) && statSync(file).isFile() ? file : null; } catch { return null; } }
  capturePcTurn(terminal, requestId, session) {
    const code=terminal?.code, request=code?.requests?.[requestId];
    if(code?.kind!=='job' || !['completed','failed','uncertain'].includes(request?.status) || typeof request.text!=='string') return null;
    if(request.status==='completed' && !request.nativeSessionId) return null;
    if(terminal.sessionId!==session.id || terminal.projectId!==session.projectId) throw Error('PC review belongs to a different conversation');
    const reviewId=`pc_${createHash('sha256').update(`${terminal.id}:${requestId}`).digest('hex').slice(0,32)}`;
    if(request.status!=='completed') {
      const issueId=`${reviewId}_attention`, prior=this.read(issueId); if(prior) return prior;
      const nativeSessionId=request.nativeSessionId || null;
      const report=request.status==='uncertain' ? 'PC execution is uncertain. A native completion receipt was not retained; the task may still be running. Do not retry automatically.' : 'PC execution failed. Successful completion has not been verified.';
      return this.record({id:issueId,sessionId:session.id,nativeSessionId,execution:'pc',terminalId:terminal.id,kind:'blocked',proof:'unverified',report:request.error?`${report}\n\n${request.error}`:report,prompt:request.text,requestId,lane:[code.laneName,code.laneId].filter(Boolean).join(' · '),informational:false,notify:session.kind!=='assistant'&&!/^(automatic-|renew-)/.test(requestId)},{...session,nativeSessionId,provider:code.provider,cwd:code.checkout});
    }
    const issue=this.read(`${reviewId}_attention`);
    const prior=this.read(reviewId);
    const final=request.finalText, blocked=request.outcome==='needs_attention';
    const result=prior || this.record({id:reviewId,sessionId:session.id,nativeSessionId:request.nativeSessionId,execution:'pc',terminalId:terminal.id,kind:blocked?'blocked':'result',proof:final?'claimed':'unverified',report:final?`PC provider execution completed. The retained final outcome follows:\n\n${final}`:'PC provider execution completed, but no final outcome was retained. Completion is unverified.',prompt:request.text,requestId,lane:[code.laneName,code.laneId].filter(Boolean).join(' · '),informational:Boolean(final)&&!blocked,notify:session.kind!=='assistant'&&!/^(automatic-|renew-)/.test(requestId)},{...session,nativeSessionId:request.nativeSessionId,provider:code.provider,cwd:code.checkout});
    if(issue) {
      if(!issue.resolvedAt) { issue.resolvedAt=new Date().toISOString(); issue.attention=false; issue.resolvedBy=reviewId; this.write(issue); }
      try { this.onRecord?.(issue); } catch(error) { issue.noticeError=error.message; this.write(issue); }
    }
    return result;
  }
  captureCompletedTurn(session, turn) { if (turn?.status !== 'completed' || !session?.activeReviewRequest) return null; const request=session.activeReviewRequest; const final=[...(session.items||[])].reverse().find(item=>item.type==='agentMessage' && item.turnId===turn.id && typeof item.text==='string')?.text; const proof=final?'claimed':'unverified'; const report=final?`Execution completed by the provider. The retained final outcome follows:\n\n${final}`:'Provider execution completed, but no final outcome was retained for this turn. Completion is unverified.'; const lane=[session.laneName,session.laneId].filter(Boolean).join(' · ')||undefined; const record=this.record({id:`turn_${createHash('sha256').update(`${session.id}:${request.requestId}`).digest('hex').slice(0,32)}`,sessionId:session.id,kind:'result',proof,report,prompt:request.text,requestId:request.requestId,lane,informational:Boolean(final),notify:session.kind !== 'assistant' && !/^(automatic-|renew-)/.test(request.requestId)},session); delete session.activeReviewRequest; return record; }
}
