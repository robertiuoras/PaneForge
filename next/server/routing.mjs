import { randomUUID } from 'node:crypto';
import { forgeBuildPrompt } from './prompt-forge.mjs';

const DEEP = /\b(security|auth(?:entication|orization)?|exploit|incident|forensic|migration|database schema|data loss|race condition|root cause|debug)\b/i;
const SIMPLE = /\b(rename|copy|format|typo|spelling|one[- ]line|small|simple|explain|summari[sz]e)\b/i;
const modelRows = (value) => Array.isArray(value?.data) ? value.data : [];
const effortSet = (model) => new Set((model?.supportedReasoningEfforts ?? []).map((row) => typeof row === 'string' ? row : row?.reasoningEffort).filter(Boolean));

// Recognize direct requests, including polite phrasing, without treating
// explanations, quoted instructions, or capability questions as execution.
export function explicitBuildIntent(text) {
  if (typeof text !== 'string') return false;
  const request = /^\s*(?:please\s+)?(?:(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:be\s+able\s+to\s+|help\s+me\s+(?:to\s+)?)?|(?:i\s+(?:want|need)|i['’]d\s+like)\s+you\s+to\s+)(?:please\s+)?)?(?:build|implement|fix|add|create)\s+([\s\S]+)$/i.exec(text);
  if (!request) return false;
  const task = request[1].trim().replace(/^please\b[\s,]*/i, '');
  return /[\p{L}\p{N}]/u.test(task) && !/^(?:nothing|none|no|not|neither)\b/i.test(task);
}

export function quotaVerdict(reply) {
  const result = reply?.result ?? reply;
  const rate = result?.rateLimits;
  if (!result || typeof result.ordinaryUsageAllowed !== 'boolean' || !rate || typeof rate.spendControlReached !== 'boolean') return { ok: false, reason: 'Codex usage availability is unknown. The draft was preserved and no paid fallback was selected.' };
  if (!result.ordinaryUsageAllowed || rate.spendControlReached || rate.rateLimitReachedType) return { ok: false, reason: 'Included Codex subscription usage is unavailable. The draft was preserved and no paid fallback was selected.' };
  return { ok: true };
}

export function chooseCodexRoute({ task, models, rateLimits, requestedModel, requestedEffort } = {}) {
  const quota = quotaVerdict(rateLimits);
  if (!quota.ok) return quota;
  const rows = modelRows(models).filter((row) => row && typeof row.id === 'string' && !row.hidden);
  if (!rows.length) return { ok: false, reason: 'Codex did not report an available model catalogue. The draft was preserved.' };
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (requestedModel && !byId.has(requestedModel)) return { ok: false, reason: `Requested model ${requestedModel} is not available in the current Codex catalogue.` };
  const taskText = String(task || '');
  const preferred = requestedModel || (DEEP.test(taskText) && byId.has('gpt-6-astra') ? 'gpt-6-astra' : (rows.find((row) => /gpt-5\.6-(terra|sol|luna)/.test(row.id)) || rows[0]).id);
  const model = byId.get(preferred);
  const wanted = requestedEffort || (DEEP.test(taskText) ? 'high' : SIMPLE.test(taskText) ? 'low' : model.defaultReasoningEffort);
  if (typeof wanted !== 'string' || !effortSet(model).has(wanted)) return { ok: false, reason: `Requested reasoning effort ${wanted || 'unknown'} is unsupported by ${model.id}.` };
  return { ok: true, model: model.id, effort: wanted };
}

function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function bad(res, error) { json(res, 400, { error }); return true; }

async function selectionFor(supervisor, body, confirmed) {
  if (typeof supervisor.ensureCodexReady !== 'function') throw Error('Codex provider startup is unavailable.');
  const live = await supervisor.ensureCodexReady();
  return chooseCodexRoute({ task: body?.text || body?.task || body?.title || '', models: live.models, rateLimits: live.rateLimits, requestedModel: confirmed?.model ?? body?.model, requestedEffort: confirmed?.effort ?? body?.effort });
}

export async function routeApi({ req, res, url, body = {}, supervisor }) {
  if (!url.pathname.startsWith('/api/')) return false;
  if (req.method === 'GET' && url.pathname === '/api/state') { json(res, 200, supervisor.state()); return true; }
  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    const choice = await selectionFor(supervisor, body);
    if (!choice.ok) return bad(res, choice.reason);
    const session = await supervisor.sessions.create({ ...body, model: choice.model, effort: choice.effort });
    json(res, 201, { session, selection: choice });
    return true;
  }
  const turn = /^\/api\/sessions\/([^/]+)\/(turn|steer)$/.exec(url.pathname);
  if (req.method === 'POST' && turn) {
    if (typeof body.requestId !== 'string' || !body.requestId.trim()) return bad(res, 'A request identity is required.');
    let session;
    try { session = supervisor.sessions.get(decodeURIComponent(turn[1])); } catch { return bad(res, 'Session not found.'); }
    const explicit = Object.hasOwn(body, 'model') || Object.hasOwn(body, 'effort');
    if (explicit && (body.model !== session.model || body.effort !== session.effort)) return bad(res, 'This session already has a confirmed model and effort. Start a new session to change it.');
    const choice = await selectionFor(supervisor, body, session.model && session.effort ? session : null);
    if (!choice.ok) return bad(res, choice.reason);
    session.model = choice.model;
    session.effort = choice.effort;
    let text;
    try { text = forgeBuildPrompt(body.text); } catch (error) { return bad(res, error.message); }
    const result = await supervisor.sessions.turn(session.id, { ...body, text, requestId: body.requestId || randomUUID() }, turn[2] === 'steer');
    json(res, 202, { result, selection: choice });
    return true;
  }
  json(res, 404, { error: 'API route not found.' });
  return true;
}
