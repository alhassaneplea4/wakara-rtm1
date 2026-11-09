// Génère les schémas du dossier de livraison (architecture, circuit d'un dossier, modèle de données)
// en PNG, avec Microsoft Edge en mode headless (aucune dépendance npm).
//
//   node diagrammes.mjs        (depuis docs/livraison/outils)
//
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'images');
mkdirSync(OUT, { recursive: true });

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const C = { navy: '#0B2A6B', blue: '#2563EB', light: '#EAF1FF', line: '#9DB4E8', ink: '#1B2437', soft: '#5B6781',
  green: '#16A34A', greenL: '#E7F7EE', orange: '#C2710C', orangeL: '#FFF3E0', red: '#DC2626', redL: '#FDECEC', grey: '#EEF1F6' };

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function lines(x, y, arr, { size = 15, weight = 400, fill = C.ink, anchor = 'middle', lh = 1.25 } = {}) {
  const t = Array.isArray(arr) ? arr : [arr];
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">` +
    t.map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : size * lh}">${esc(l)}</tspan>`).join('') + '</text>';
}

function box(x, y, w, h, title, sub, { fill = C.light, stroke = C.blue, tFill = C.navy, size = 15, subSize = 12.5 } = {}) {
  const t = Array.isArray(title) ? title : [title];
  const s = sub ? (Array.isArray(sub) ? sub : [sub]) : [];
  const total = t.length * size * 1.25 + (s.length ? 6 + s.length * subSize * 1.25 : 0);
  const y0 = y + (h - total) / 2 + size;
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>`;
  out += lines(x + w / 2, y0, t, { size, weight: 700, fill: tFill });
  if (s.length) out += lines(x + w / 2, y0 + t.length * size * 1.25 + 4, s, { size: subSize, fill: C.soft });
  return out;
}

function arrow(pts, { color = C.blue, dashed = false, width = 2 } = {}) {
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" ${dashed ? 'stroke-dasharray="7 5"' : ''} marker-end="url(#a-${color.slice(1)})"/>`;
}

const defs = Object.values(C).map((c) => `<marker id="a-${c.slice(1)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join('');

function svg(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Segoe UI, Arial, sans-serif"><defs>${defs}</defs><rect width="${w}" height="${h}" fill="#fff"/>${body}</svg>`;
}

// ───────── 1. Architecture ─────────
function architecture() {
  let b = '';
  b += `<rect x="20" y="70" width="230" height="300" rx="14" fill="${C.grey}" stroke="${C.line}" stroke-width="1.4"/>`;
  b += lines(135, 98, ['Utilisateurs', '(navigateur web)'], { size: 16, weight: 700, fill: C.navy });
  b += box(40, 150, 190, 50, 'Agent de collecte', null, { size: 14 });
  b += box(40, 215, 190, 50, "Secrétaire d'état civil", null, { size: 14 });
  b += box(40, 280, 190, 50, 'Administrateur technique', null, { size: 14 });

  b += `<rect x="330" y="30" width="400" height="380" rx="14" fill="#F7FAFF" stroke="${C.blue}" stroke-width="1.8" stroke-dasharray="8 5"/>`;
  b += lines(530, 60, 'Vercel — un seul domaine (HTTPS)', { size: 16, weight: 700, fill: C.navy });
  b += box(360, 90, 340, 120, ['Interface Angular 17', 'fichiers statiques'], ['Écrans, formulaires, tableau de bord', "Aucune règle critique côté navigateur"], { size: 16 });
  b += box(360, 260, 340, 130, ['API Django 5.2 + REST', 'chemin /api/…'], ['Authentification JWT · permissions', 'workflow · audit · statistiques'], { size: 16, fill: C.greenL, stroke: C.green });

  b += `<rect x="820" y="130" width="230" height="240" rx="14" fill="${C.orangeL}" stroke="${C.orange}" stroke-width="1.6"/>`;
  b += lines(935, 165, ['Neon', 'PostgreSQL'], { size: 17, weight: 700, fill: C.navy });
  b += lines(935, 225, ['Données métier', "Journal d'audit (ajout seul)", 'Pièces justificatives (privé)', 'Sauvegardes du fournisseur'], { size: 13, fill: C.ink });

  b += arrow([[250, 190], [358, 150]]);
  b += lines(300, 150, 'HTTPS', { size: 12, fill: C.soft });
  b += arrow([[250, 300], [358, 325]]);
  b += lines(296, 332, 'JSON /api', { size: 12, fill: C.soft });
  b += arrow([[700, 325], [818, 280]], { color: C.green });
  b += lines(780, 318, 'SQL / TLS', { size: 12, fill: C.soft });
  b += arrow([[530, 210], [530, 258]], { dashed: true });
  b += lines(600, 238, 'même domaine', { size: 12, fill: C.soft });
  b += lines(560, 438, 'Option prévue : stockage S3 privé pour les pièces (non activé en v1) · Django Admin non exposé', { size: 12.5, fill: C.soft });
  return svg(1080, 460, b);
}

// ───────── 2. Circuit d'un dossier ─────────
function circuit() {
  const W = 150, H = 62, y = 120;
  const xs = [30, 216, 402, 588, 774, 960];
  const steps = [
    ['Brouillon', 'Agent de collecte', C.light, C.blue],
    ['Transmis', 'Secrétariat', C.light, C.blue],
    ['En complément', 'Secrétariat (facultatif)', C.light, C.blue],
    ['En attente de', 'validation', C.orangeL, C.orange],
    ['Validé', 'définitivement', C.greenL, C.green],
    ['Acte délivré', 'dossier clos', C.greenL, C.green],
  ];
  let b = '';
  b += lines(570, 30, 'Circuit d’un dossier de naissance', { size: 20, weight: 700, fill: C.navy });
  const actors = [
    ['AGENT DE COLLECTE', 30, 336, C.blue],
    ['SECRÉTARIAT', 216, 336, C.blue],
    ['ADMINISTRATEUR TECHNIQUE', 588, 150, C.orange],
    ['SECRÉTARIAT', 774, 336, C.green],
  ];
  steps.forEach((s, i) => {
    const t = i === 3 ? ['En attente de', 'validation'] : i === 4 ? ['Validé', 'définitivement'] : [s[0]];
    b += box(xs[i], y, W, H, t, i === 3 || i === 4 ? null : null, { fill: s[2], stroke: s[3], size: 15 });
  });
  const who = ['Agent de collecte', 'Secrétariat', 'Secrétariat', 'Administrateur', 'Secrétariat', 'Dossier clos'];
  const whoSub = ['saisit et transmet', 'reçoit le dossier', 'complète l’acte', 'décide', 'imprime, délivre', ''];
  who.forEach((w, i) => {
    b += lines(xs[i] + W / 2, y + H + 26, w, { size: 13, weight: 700, fill: steps[i][3] });
    if (whoSub[i]) b += lines(xs[i] + W / 2, y + H + 44, whoSub[i], { size: 12, fill: C.soft });
  });
  for (let i = 0; i < 5; i++) b += arrow([[xs[i] + W + 2, y + H / 2], [xs[i + 1] - 2, y + H / 2]], { color: i === 3 ? C.green : C.blue, width: 2.2 });
  // direct treatment: Transmis → En attente (over the top)
  b += arrow([[xs[1] + W / 2, y - 2], [xs[1] + W / 2, y - 34], [xs[3] + W / 2, y - 34], [xs[3] + W / 2, y - 3]], { dashed: true });
  b += lines((xs[1] + xs[3] + W) / 2, y - 42, 'traitement en une seule fois (sans « prise en charge »)', { size: 12, fill: C.soft });

  // returns / reject
  const ry = 300;
  b += box(xs[1] - 10, ry, 210, 70, ['À corriger', 'collecte'], null, { fill: C.redL, stroke: C.red, size: 14 });
  b += box(xs[3] - 40, ry, 210, 70, ['À corriger', 'secrétariat'], null, { fill: C.redL, stroke: C.red, size: 14 });
  b += box(xs[4] + 70, ry, 190, 70, ['Rejeté', 'dossier clos'], null, { fill: C.redL, stroke: C.red, size: 14 });
  b += arrow([[xs[3] + W / 2 - 40, y + H + 56], [xs[1] + 95, ry - 2]], { color: C.red });
  b += arrow([[xs[3] + W / 2, y + H + 56], [xs[3] + 65, ry - 2]], { color: C.red });
  b += arrow([[xs[3] + W / 2 + 40, y + H + 56], [xs[4] + 165, ry - 2]], { color: C.red });
  b += lines(570, ry + 140, 'Retour ou rejet par l’administrateur : le motif est obligatoire.', { size: 13, weight: 700, fill: C.red });
  b += lines(xs[1] + 95, ry + 92, 'l’agent corrige', { size: 12, fill: C.soft });
  b += lines(xs[1] + 95, ry + 107, 'puis retransmet', { size: 12, fill: C.soft });
  b += lines(xs[3] + 65, ry + 92, 'le secrétariat corrige', { size: 12, fill: C.soft });
  b += lines(xs[3] + 65, ry + 107, 'puis soumet à nouveau', { size: 12, fill: C.soft });
  b += lines(xs[4] + 165, ry + 92, 'aucune modification possible', { size: 12, fill: C.soft });
  b += lines(570, 480, 'Un dossier validé, rejeté ou délivré est figé : plus personne ne peut le modifier.', { size: 13, weight: 700, fill: C.navy });
  return svg(1140, 510, b);
}

// ───────── 3. Modèle de données (vue simplifiée) ─────────
function donnees() {
  let b = '';
  const R = { fill: C.light, stroke: C.blue };
  b += lines(540, 28, 'Modèle de données — vue simplifiée', { size: 20, weight: 700, fill: C.navy });
  // access cluster
  b += box(20, 70, 180, 56, 'Utilisateur', 'comptes', R);
  b += box(20, 190, 180, 56, 'Rôle', '3 rôles par défaut', R);
  b += box(20, 310, 180, 56, 'Permission', '32 droits', R);
  b += arrow([[110, 128], [110, 188]]);
  b += arrow([[110, 248], [110, 308]]);
  b += lines(212, 160, 'attribué à', { size: 11.5, fill: C.soft, anchor: 'start' });
  b += lines(212, 282, 'contient', { size: 11.5, fill: C.soft, anchor: 'start' });
  // core
  b += box(330, 70, 190, 56, 'Établissement', 'hôpital, maternité', R);
  b += box(330, 190, 190, 70, 'Déclaration', 'référence · statut', { fill: C.orangeL, stroke: C.orange });
  b += arrow([[425, 128], [425, 188]]);
  b += lines(437, 160, 'déclare', { size: 11.5, fill: C.soft, anchor: 'start' });
  b += box(330, 340, 190, 56, 'Historique des statuts', 'ajout seul', { fill: C.greenL, stroke: C.green });
  b += arrow([[425, 262], [425, 338]], { color: C.green });
  // people
  b += box(640, 70, 170, 50, 'Enfant', null, R);
  b += box(640, 140, 170, 50, 'Parents (père, mère)', null, R);
  b += box(640, 210, 170, 50, 'Déclarant', null, R);
  b += box(640, 280, 170, 50, 'Pièces justificatives', null, R);
  b += arrow([[522, 215], [638, 100]]);
  b += arrow([[522, 225], [638, 165]]);
  b += arrow([[522, 232], [638, 235]]);
  b += arrow([[522, 250], [638, 305]]);
  // acte
  b += box(900, 190, 170, 70, 'Acte de naissance', 'registre, feuillet, n° officiel', { fill: C.greenL, stroke: C.green });
  b += arrow([[528, 190], [528, 52], [985, 52], [985, 188]], { color: C.green, dashed: true });
  b += lines(735, 46, 'une déclaration = un acte', { size: 11.5, fill: C.soft, anchor: 'middle' });
  b += box(900, 320, 150, 56, 'Impressions', 'copie n°', R);
  b += box(900, 400, 150, 56, 'Délivrances', 'remise, duplicata', R);
  b += arrow([[985, 262], [985, 318]]);
  b += arrow([[1062, 262], [1062, 428], [1052, 428]], { color: C.blue });
  // audit
  b += box(330, 440, 190, 56, "Journal d'audit", 'ajout seul · qui, quoi, quand', { fill: C.redL, stroke: C.red });
  b += lines(715, 470, "Toute action est inscrite au journal d'audit (jamais modifié ni effacé).", { size: 12.5, fill: C.soft, anchor: 'middle' });
  b += lines(110, 410, 'Utilisateur ← créé par / modifié par', { size: 11.5, fill: C.soft });
  b += lines(110, 428, 'sur toutes les tables métier', { size: 11.5, fill: C.soft });
  return svg(1100, 520, b);
}

const diagrams = { 'schema-architecture': architecture(), 'schema-circuit': circuit(), 'schema-donnees': donnees() };

// ───────── rendu PNG via Edge (CDP) ─────────
const PORT = 9444;
const profile = join(tmpdir(), 'wakara-edge-diag-' + Date.now());
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* retry */ } await sleep(500); }
const tgt = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
for (const [name, s] of Object.entries(diagrams)) {
  const m = s.match(/width="(\d+)" height="(\d+)"/);
  const w = +m[1], h = +m[2];
  const file = join(tmpdir(), name + '.svg');
  writeFileSync(file, s);
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') });
  await sleep(700);
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
  writeFileSync(join(OUT, name + '.png'), Buffer.from(shot.data, 'base64'));
  console.log('ok', name, w + 'x' + h);
}
ws.close(); edge.kill(); process.exit(0);
