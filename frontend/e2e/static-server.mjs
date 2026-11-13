// Serves the PRODUCTION build (service worker included) and forwards /api to the test API, on one origin —
// the same layout as the Vercel deployment. Started by Playwright.
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../dist/wakara-frontend/browser');
const port = Number(process.env.E2E_WEB_PORT ?? 4311);
const apiPort = Number(process.env.E2E_API_PORT ?? 8011);

if (!existsSync(path.join(root, 'index.html'))) {
  console.error('Build introuvable : lancez « npm run build » avant les tests de bout en bout.');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith('/api/')) {
    const proxied = http.request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${apiPort}` } }, upstream => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    });
    proxied.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(proxied);
    return;
  }
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Wakara (build de production) sur http://localhost:${port}`));
