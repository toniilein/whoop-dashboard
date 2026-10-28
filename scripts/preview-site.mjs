// Builds the demo site and serves it at http://localhost:8765/whoop-dashboard/, the same
// path GitHub Pages uses, so relative links are tested the way they will run online.
//
// Usage: node scripts/preview-site.mjs
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, '_site', 'preview');
const BASE = '/whoop-dashboard/';
const PORT = Number(process.env.PORT) || 8765;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-site.mjs'), path.join(SITE, 'whoop-dashboard')], { stdio: 'inherit' });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/whoop-dashboard') {
    res.writeHead(302, { Location: BASE });
    return res.end();
  }
  const rel = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
  const file = path.join(SITE, path.normalize(rel));
  if (!file.startsWith(SITE + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Demo site at http://localhost:${PORT}${BASE}`));
