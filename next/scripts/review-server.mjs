// Real, narrowly scoped Review host. The Stage 1 fixture server stays separate.
// Uses PaneForge's existing authenticated IPC transport; credentials never reach JS.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const state = { reviewOnly: true, fixture: false, provider: { status: 'review-only' }, sessions: [], receipts: [] };

export function phoneBridge(userData) {
  let cookie = '', base = '', pairing;
  async function pair() {
    const config = JSON.parse(await readFile(join(userData, 'config.json'), 'utf8'));
    const phone = config.phone;
    const port = phone?.port ?? 7312;
    if (!phone?.on || !Number.isInteger(port) || port < 1 || port > 65535)
      throw Error('PaneForge Phone transport is unavailable. Start the configured PaneForge profile.');
    base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/pf/pair`, {
      method: 'POST', body: JSON.stringify({ code: phone.code }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error('PaneForge pairing failed. Review remains saved on disk.');
    cookie = (response.headers.get('set-cookie') || '').split(';')[0];
    if (!cookie) throw Error('PaneForge did not return a local session.');
  }
  return async function invoke(channel, args = []) {
    if (!cookie) {
      pairing ||= pair().finally(() => { pairing = undefined; });
      await pairing;
    }
    const response = await fetch(`${base}/pf/call`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, channel, args }), signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401) { cookie = ''; throw Error('PaneForge connection expired. Refresh to reconnect.'); }
    const data = await response.json();
    if (!response.ok || data.error) throw Error(data.error || `PaneForge returned ${response.status}`);
    return data.value;
  };
}

export async function startReviewServer({ port = 4320, userData = process.env.PF_USER_DATA || join(process.platform === 'darwin' ? join(homedir(), 'Library/Application Support') : process.platform === 'win32' ? (process.env.APPDATA || join(homedir(), 'AppData/Roaming')) : join(homedir(), '.config'), 'claude-orchestrator'), invoke = phoneBridge(userData) } = {}) {
  const clients = new Set();
  const server = createServer(async (req, res) => {
    const address = server.address();
    const expected = `127.0.0.1:${address.port}`;
    // Host validation prevents DNS rebinding. No CORS, no credentials in the renderer.
    if (req.headers.host !== expected || (req.headers.origin && req.headers.origin !== `http://${expected}`)
        || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403).end('Local Review requests only'); return;
    }
    const url = new URL(req.url, `http://${expected}`);
    const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, state);
      if (req.method === 'GET' && url.pathname === '/api/projects') return json(200, { projects: [] });
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/reviews') return json(200, await invoke('reviews:list'));
      const action = url.pathname.match(/^\/api\/reviews\/([A-Za-z0-9_-]{1,160})\/(ack|open)$/);
      if (req.method === 'POST' && action) {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON required' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) return json(413, { error: 'Request too large' }); }
        const value = JSON.parse(body);
        if (action[2] === 'ack') {
          if (typeof value.reviewed !== 'boolean') return json(400, { error: 'reviewed must be boolean' });
          return json(200, await invoke('reviews:ack', [action[1], value.reviewed]));
        }
        if (!Number.isInteger(value.index) || value.index < -1) return json(400, { error: 'Invalid report link' });
        return json(200, await invoke('reviews:open', [action[1], value.index]));
      }
      if (url.pathname.startsWith('/api/')) return json(404, { error: 'Review host cannot control live sessions.' });
      if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
      const dist = join(root, 'dist');
      const name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = resolve(dist, `.${name}`);
      if (!file.startsWith(dist + sep) || !types[extname(file)]) return json(404, { error: 'Not found' });
      const content = await readFile(file);
      res.writeHead(200, {
        'content-type': types[extname(file)], 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
      });
      res.end(content);
    } catch (error) { json(502, { error: error instanceof Error ? error.message : 'Review request failed' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => { for (const client of clients) client.end(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await startReviewServer({ port: Number(process.env.PORT || 4320) });
  console.log(`PaneForge Next Review: ${server.url}/#review`);
  const stop = () => void server.close().then(() => process.exit());
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
