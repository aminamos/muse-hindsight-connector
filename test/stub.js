'use strict';

/** In-process stub of the Hindsight HTTP API for hermetic tests. */
const http = require('node:http');

function startStub({ expectedToken = null, stats = null } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let json = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = null;
      }
      requests.push({ method: req.method, url: req.url, body: json, auth: req.headers.authorization || '' });
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (expectedToken && req.headers.authorization !== `Bearer ${expectedToken}`) {
        send(401, { detail: 'unauthorized' });
        return;
      }
      const m = req.url.match(/^\/v1\/default\/banks\/([^/]+)(\/.*)?$/);
      const bank = m ? decodeURIComponent(m[1]) : null;
      const rest = m ? m[2] || '' : '';
      if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'healthy' });
      if (!bank) return send(404, { detail: 'not found' });
      if (req.method === 'PUT' && rest === '') return send(200, { bank_id: bank });
      if (req.method === 'GET' && rest === '/stats') {
        if (stats === 'missing') return send(404, { detail: 'no bank' });
        return send(200, { bank_id: bank, fact_count: 42 });
      }
      if (req.method === 'POST' && rest === '/memories/recall') {
        return send(200, {
          results: [
            { id: 'stub-1', text: `stub memory about ${json && json.query ? String(json.query).slice(0, 40) : ''}`, type: 'world' },
            { id: 'stub-2', text: 'stub standing preference', type: 'experience' },
          ],
        });
      }
      if (req.method === 'POST' && rest === '/memories') {
        return send(200, { ok: true, retained: Array.isArray(json && json.items) ? json.items.length : 0 });
      }
      if (req.method === 'POST' && rest === '/reflect') {
        return send(200, { answer: `stub reflection on: ${json && json.query ? json.query : ''}` });
      }
      return send(404, { detail: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startStub };
