// Aperçu de contrôle : découpe la version HTML d'un document en « pages » PNG (approximation de l'impression).
//   node apercu.mjs 03        → <temp>/wakara-doc-apercu/03-p1.png, 03-p2.png, …
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DOCS } from './meta.mjs';

const id = process.argv[2];
const d = DOCS.find((x) => x.id === id);
const html = join(tmpdir(), 'wakara-doc-html', d.fichier + '.html');
const OUT = join(tmpdir(), 'wakara-doc-apercu');
mkdirSync(OUT, { recursive: true });
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9666;
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), 'wk-edge-prev-' + Date.now())}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* retry */ } await sleep(500); }
const tgt = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let n = 0; const pend = new Map();
ws.addEventListener('message', (m) => { const x = JSON.parse(m.data); if (x.id && pend.has(x.id)) { pend.get(x.id)(x); pend.delete(x.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++n; pend.set(i, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
await send('Emulation.setEmulatedMedia', { media: 'print' });
await send('Emulation.setDeviceMetricsOverride', { width: 794, height: 1123, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pathToFileURL(html).href });
await sleep(1500);
const h = (await send('Runtime.evaluate', { expression: 'document.documentElement.scrollHeight', returnByValue: true })).result.value;
const pages = Math.ceil(h / 1123);
const from = Number(process.argv[3] || 1), to = Number(process.argv[4] || pages);
for (let i = from; i <= Math.min(to, pages); i++) {
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80, captureBeyondViewport: true, clip: { x: 0, y: (i - 1) * 1123, width: 794, height: 1123, scale: 1 } });
  writeFileSync(join(OUT, `${id}-p${i}.jpg`), Buffer.from(shot.data, 'base64'));
}
console.log('pages approx.', pages, '→', OUT);
ws.close(); edge.kill(); process.exit(0);
