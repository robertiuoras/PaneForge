import assert from 'node:assert/strict';
import { get } from 'node:http';
import { startReviewServer } from './review-server.mjs';
const calls = [];
const server = await startReviewServer({ port: 0, invoke: async (channel, args) => { calls.push({channel,args}); return channel === 'reviews:list' ? {reviews:[],persistent:true} : {opened:true}; } });
const request = (path, body, headers = {}) => fetch(server.url + path, {method: body === undefined ? 'GET' : 'POST', headers: {'content-type':'application/json', ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
try {
  assert.equal((await (await request('/api/state')).json()).reviewOnly, true);
  assert.deepEqual(await (await request('/api/reviews')).json(), {reviews:[],persistent:true});
  assert.equal((await request('/api/reviews/a/ack', {reviewed:false})).status, 200);
  assert.deepEqual(calls.at(-1), {channel:'reviews:ack',args:['a',false]});
  assert.equal((await request('/api/reviews/a/open', {index:-1})).status, 200);
  assert.deepEqual(calls.at(-1), {channel:'reviews:open',args:['a',-1]});
  const before = calls.length;
  assert.equal((await request('/api/reviews/a/ack', {reviewed:'yes'})).status, 400);
  assert.equal((await request('/api/reviews/a/open', {index:-2})).status, 400);
  assert.equal((await request('/api/reviews/a/ack', {reviewed:true}, {origin:'https://evil.test'})).status, 403);
  assert.equal(await new Promise((resolve, reject) => get(server.url + '/api/reviews', {headers:{host:'evil.test'}}, res => {res.resume();resolve(res.statusCode)}).on('error',reject)), 403);
  assert.equal((await request('/api/reviews', undefined, {'sec-fetch-site':'cross-site'})).status, 403);
  assert.equal((await request('/api/sessions', {})).status, 404);
  assert.equal(calls.length, before);
  const page = await request('/'); assert.equal(page.status,200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  console.log('PASS real Review host routing, undo, report open, isolation and static policy');
} finally { await server.close(); }
