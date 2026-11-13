// Banc d'essai LOCAL du mode hors connexion.
//   npm run local            construit l'application de production, démarre l'API et le site, affiche les comptes
//   npm run local:reset      repart d'une base vierge
// Tout est isolé : base SQLite, documents et clé dans frontend/.local-test (ignoré par git). Rien n'est envoyé nulle part.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, '..');
const backend = path.resolve(frontend, '../backend');
const data = path.join(frontend, '.local-test');
const dist = path.join(frontend, 'dist/wakara-frontend/browser');
const WEB = Number(process.env.LOCAL_WEB_PORT ?? 4321);
const API = Number(process.env.LOCAL_API_PORT ?? 8021);
const args = new Set(process.argv.slice(2));

const venvPython = path.join(backend, process.platform === 'win32' ? 'venv/Scripts/python.exe' : 'venv/bin/python');
const python = process.env.LOCAL_PYTHON ?? (existsSync(venvPython) ? venvPython : 'python');

if (args.has('--reset')) { rmSync(data, { recursive: true, force: true }); console.log('Banc d\'essai remis à zéro.'); }
mkdirSync(path.join(data, 'documents'), { recursive: true });

// ── identifiants et clé : créés une fois, conservés entre deux lancements ──
const read = f => (existsSync(path.join(data, f)) ? readFileSync(path.join(data, f), 'utf8').trim() : null);
const secretKey = read('secret.key') ?? randomBytes(48).toString('hex');
writeFileSync(path.join(data, 'secret.key'), secretKey);
const password = read('mot-de-passe.txt') ?? `Wk-${randomBytes(9).toString('base64url')}-7a`;
writeFileSync(path.join(data, 'mot-de-passe.txt'), password);

const env = {
  ...process.env, DEBUG: 'True', SECRET_KEY: secretKey, DATABASE_URL: '', DB_ENGINE: 'django.db.backends.sqlite3',
  SQLITE_PATH: path.join(data, 'local.sqlite3'), DOCUMENTS_STORAGE: 'filesystem', PRIVATE_MEDIA_ROOT: path.join(data, 'documents'),
  LOGIN_THROTTLE_RATE: '1000/min', ALLOWED_HOSTS: 'localhost,127.0.0.1', PYTHONUNBUFFERED: '1', LOCAL_TEST_PASSWORD: password,
};

const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { cwd: opts.cwd ?? backend, env: { ...env, ...opts.env }, stdio: 'inherit', shell: opts.shell ?? false });
  if (r.status !== 0) { console.error(`\nÉchec : ${cmd} ${argv.join(' ')}`); process.exit(r.status ?? 1); }
};

// ── application de production (le service worker n'existe que dans ce build) ──
if (!args.has('--no-build') || !existsSync(path.join(dist, 'index.html'))) {
  console.log('Construction de l\'application (build de production)…');
  run('npm', ['run', 'build'], { cwd: frontend, shell: true });
}

// ── base de données et comptes ──
const firstRun = !existsSync(path.join(data, 'local.sqlite3'));
run(python, ['manage.py', 'migrate', '--noinput', '-v', '0']);
if (firstRun) {
  run(python, ['manage.py', 'setup_initial_data', '--skip-admin', '-v', '0']);
  // règle d'envoi à la validation allégée pour le SEUL besoin de préparer les dossiers d'exemple
  run(python, ['manage.py', 'shell', '-c', `exec(open(r'${path.join(here, 'seed.py')}', encoding='utf-8').read())`],
    { env: { ACTE_REQUIRED_FOR_SUBMISSION: 'acte.declaration_date,declarant.name' } });
}
writeFileSync(path.join(data, 'identifiants.txt'),
  `Wakara — banc d'essai local\nAdresse : http://localhost:${WEB}\nPanneau de pannes : http://localhost:${WEB}/__test\n\n` +
  `Mot de passe de tous les comptes : ${password}\n\n` +
  'agent.collecte   agent de collecte (a des dossiers : brouillon, transmis, à corriger, validé)\n' +
  'agent2.collecte  second agent de collecte (pour tester un autre compte sur le même appareil)\n' +
  'secretaire       secrétaire d\'état civil\nadmin            administrateur technique (appareils, paramètres, journal)\n');

// ── API Django ──
const server = spawn(python, ['manage.py', 'runserver', `127.0.0.1:${API}`, '--noreload'], { cwd: backend, env, stdio: ['ignore', 'ignore', 'inherit'] });
server.on('exit', code => { console.log(`API arrêtée (${code}).`); process.exit(code ?? 0); });
const stop = () => { server.kill(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

// ── site (build de production) + proxy /api + panneau de pannes ──
let mode = 'normal';
let lostOnce = false;
const MODES = {
  normal: 'Tout fonctionne.',
  panne: 'Le serveur ne répond plus (coupure réseau côté serveur, sans passer en mode avion).',
  expiree: 'La session est refusée par le serveur (jeton expiré) ; la connexion reste possible.',
  perdue: 'La prochaine synchronisation est appliquée par le serveur MAIS sa réponse est perdue (une seule fois).',
};
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

const PANEL = `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pannes simulées — Wakara</title>
<style>body{font:15px system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;color:#0f1f3d}h1{font-size:22px}
button{display:block;width:100%;text-align:left;padding:12px 14px;margin:8px 0;border:1px solid #c6d3ea;border-radius:10px;background:#fff;font:inherit;cursor:pointer}
button small{display:block;color:#4d5b78;margin-top:2px}button.on{background:#e3edff;border-color:#1f5ed8;font-weight:600}
#state{padding:10px 14px;background:#fff0d6;border-radius:10px;margin:14px 0}a{color:#1f5ed8}</style>
<h1>Pannes simulées</h1>
<p>Ouvrez Wakara dans un autre onglet, puis changez ici ce que fait le serveur. Cette page reste accessible, même serveur coupé.</p>
<div id="state"></div><div id="buttons"></div>
<p><a href="/">← Retour à Wakara</a></p>
<script>
const MODES=${JSON.stringify(MODES)};
async function refresh(){const m=(await (await fetch('/__mode')).json()).mode;
 document.getElementById('state').textContent='État actuel : '+m+' — '+MODES[m];
 document.getElementById('buttons').innerHTML=Object.entries(MODES).map(([k,v])=>'<button data-m="'+k+'" class="'+(k===m?'on':'')+'">'+k+'<small>'+v+'</small></button>').join('');
 document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{await fetch('/__mode/'+b.dataset.m,{method:'POST'});refresh()});}
refresh();
</script></html>`;

const proxy = (req, res, { dropAnswer = false } = {}) => {
  const up = http.request({ host: '127.0.0.1', port: API, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${API}` } }, upstream => {
    if (dropAnswer) { upstream.resume(); upstream.on('end', () => req.socket.destroy()); return; }  // appliqué par le serveur, réponse perdue
    res.writeHead(upstream.statusCode ?? 502, upstream.headers);
    upstream.pipe(res);
  });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${WEB}`);
  const p = url.pathname;
  if (p === '/__test') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(PANEL); return; }
  if (p === '/__mode') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ mode })); return; }
  if (p.startsWith('/__mode/') && req.method === 'POST') {
    const next = p.slice('/__mode/'.length);
    if (next in MODES) { mode = next; lostOnce = next === 'perdue'; console.log(`[panneau] mode : ${mode}`); }
    res.writeHead(204); res.end(); return;
  }
  if (p.startsWith('/api/')) {
    const open = /^\/api\/(sync\/ping|auth\/login|public)\//.test(p);
    if (mode === 'panne') { req.socket.destroy(); return; }
    if (mode === 'expiree' && !open) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"detail":"Jeton expiré (simulation)."}'); return; }
    if (mode === 'perdue' && lostOnce && /^\/api\/sync\/(push|documents)\//.test(p)) { lostOnce = false; mode = 'normal'; console.log('[panneau] réponse perdue, retour au mode normal'); proxy(req, res, { dropAnswer: true }); return; }
    proxy(req, res); return;
  }
  let file = path.join(dist, decodeURIComponent(p));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}).listen(WEB, () => {
  console.log(`\n=========================================================
 Wakara — banc d'essai local du mode hors connexion
=========================================================
 Site              http://localhost:${WEB}
 Pannes simulées   http://localhost:${WEB}/__test
 Comptes           agent.collecte · agent2.collecte · secretaire · admin
 Mot de passe      ${password}
                   (rappelé dans frontend/.local-test/identifiants.txt)

 Ctrl+C pour arrêter. « npm run local:reset » repart d'une base vierge.
=========================================================\n`);
});
