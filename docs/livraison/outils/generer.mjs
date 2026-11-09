// Génère les documents du dossier de livraison : Word (.docx) et PDF (via Microsoft Edge headless).
//
//   cd docs/livraison/outils && npm install && node generer.mjs [01 03 ...]
//
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  AlignmentType, HeadingLevel, LevelFormat, Header, Footer, PageNumber, PageBreak, VerticalAlign, TableLayoutType,
} from 'docx';
import { META, DOCS } from './meta.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const IMG = join(ROOT, 'images');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const NAVY = '0B2A6B', BLUE = '2563EB', LIGHT = 'EAF1FF', GREY = 'F4F6FA', LINE = 'C9D3E6', INK = '1B2437', SOFT = '5B6781';
const NOTE = { info: ['EAF1FF', '2563EB'], warn: ['FFF3E0', 'C2710C'], ok: ['E7F7EE', '16A34A'], danger: ['FDECEC', 'DC2626'] };

// ───────────────────────── utilitaires ─────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(text) {
  // → [{ text, bold?, code? }]
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m;
  const s = String(text);
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith('**')) out.push({ text: tok.slice(2, -2), bold: true });
    else out.push({ text: tok.slice(1, -1), code: true });
    last = m.index + tok.length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}
const htmlInline = (t) => inline(t).map((r) => (r.bold ? `<b>${esc(r.text)}</b>` : r.code ? `<code>${esc(r.text)}</code>` : esc(r.text))).join('').replace(/\n/g, '<br>');

function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const mk = buf[i + 1];
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), type: 'jpg' };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('taille image illisible');
}

// numérotation automatique des titres + sommaire
function numberize(blocks) {
  let a = 0, b = 0;
  const toc = [];
  const out = blocks.map((bl) => {
    if (bl.t === 'h1') { a++; b = 0; const label = `${a}. ${bl.text}`; toc.push({ level: 1, label }); return { ...bl, label }; }
    if (bl.t === 'h2') { b++; const label = `${a}.${b} ${bl.text}`; toc.push({ level: 2, label }); return { ...bl, label }; }
    return bl;
  });
  return { blocks: out, toc };
}

// ───────────────────────── rendu HTML (→ PDF) ─────────────────────────
function renderHtml(doc, num) {
  const logo = pathToFileURL(join(ROOT, '..', '..', 'frontend', 'src', 'assets', 'logo-full.png')).href;
  const css = `
  @page{size:A4;margin:22mm 17mm 20mm;
    @top-left{content:"${META.projet} — ${doc.title.replace(/"/g, '')}";font:7.5pt "Segoe UI",Arial,sans-serif;color:#${SOFT};vertical-align:bottom;padding-bottom:3mm;width:70%}
    @bottom-left{content:"${META.clientCourt} · version ${META.version}";font:7.5pt "Segoe UI",Arial,sans-serif;color:#${SOFT};vertical-align:top;padding-top:3mm}
    @bottom-right{content:"Page " counter(page) " / " counter(pages);font:7.5pt "Segoe UI",Arial,sans-serif;color:#${SOFT};vertical-align:top;padding-top:3mm}}
  @page :first{margin:0;@top-left{content:none}@bottom-left{content:none}@bottom-right{content:none}}
  *{box-sizing:border-box}
  body{font:10pt/1.5 "Segoe UI",Arial,sans-serif;color:#${INK};margin:0}
  .cover{height:297mm;width:210mm;padding:30mm 24mm 22mm;display:flex;flex-direction:column;page-break-after:always;position:relative;
    background:linear-gradient(180deg,#f3f7ff 0,#fff 55%)}
  .cover:before{content:"";position:absolute;left:0;top:0;bottom:0;width:9mm;background:#${NAVY}}
  .cover .logo{width:56mm;margin:0 0 14mm 6mm}
  .cover .kicker{font-size:11pt;letter-spacing:.18em;text-transform:uppercase;color:#${BLUE};font-weight:700;margin-left:6mm}
  .cover h1{font-size:30pt;line-height:1.15;color:#${NAVY};margin:4mm 0 4mm 6mm;border:0;padding:0}
  .cover .sub{font-size:13pt;color:#${SOFT};margin:0 0 0 6mm;max-width:140mm}
  .cover .meta{margin:auto 0 0 6mm;border-collapse:collapse;font-size:10pt}
  .cover .meta td{padding:2.2mm 5mm 2.2mm 0;vertical-align:top;border:0;border-top:1px solid #${LINE};background:none}
  .cover .meta td:first-child{color:#${SOFT};width:34mm}
  .cover .foot{margin:10mm 0 0 6mm;font-size:8.5pt;color:#${SOFT}}
  h1.s{font-size:16pt;color:#${NAVY};border-bottom:2px solid #${BLUE};padding-bottom:2mm;margin:9mm 0 4mm;page-break-after:avoid}
  h2.s{font-size:12.5pt;color:#${NAVY};margin:6mm 0 2mm;page-break-after:avoid}
  h3.s{font-size:10.5pt;color:#${BLUE};margin:4mm 0 1.5mm;page-break-after:avoid}
  p{margin:0 0 2.6mm;text-align:left}
  ul,ol{margin:0 0 3mm;padding-left:6.5mm}li{margin:0 0 1mm}
  code{font:9pt Consolas,"Courier New",monospace;background:#EEF2FA;padding:0 1mm;border-radius:1mm}
  pre{font:8.6pt/1.45 Consolas,"Courier New",monospace;background:#F1F4FA;border:1px solid #${LINE};border-radius:2mm;padding:3mm;margin:0 0 3.5mm;white-space:pre-wrap;word-break:break-word;page-break-inside:avoid}
  table{width:100%;border-collapse:collapse;margin:0 0 4mm;font-size:8.8pt;table-layout:fixed}
  th{background:#${NAVY};color:#fff;text-align:left;padding:1.8mm 2mm;font-weight:600;border:1px solid #${NAVY}}
  td{padding:1.6mm 2mm;border:1px solid #${LINE};vertical-align:top;overflow-wrap:anywhere}
  tr{page-break-inside:avoid}
  table.z tr:nth-child(even) td{background:#${GREY}}
  table.lab td:first-child{background:#${LIGHT};font-weight:600;color:#${NAVY}}
  table.sm{font-size:8pt}
  .note{border-left:4px solid;border-radius:1mm;padding:2.4mm 3.5mm;margin:0 0 4mm;page-break-inside:avoid}
  .fig{margin:2mm 0 5mm;text-align:center;page-break-inside:avoid}
  .fig img{max-width:100%;border:1px solid #${LINE};border-radius:1.5mm}
  .fig.plain img{border:0}
  .fig .cap{font-size:8.5pt;color:#${SOFT};margin-top:1.5mm}
  .toc{margin:0 0 6mm}.toc div{padding:.6mm 0;border-bottom:1px dotted #${LINE}}
  .toc .l2{padding-left:7mm;color:#${SOFT};font-size:9.4pt}.toc .l1{font-weight:600;color:#${NAVY};margin-top:1.5mm}
  .sign{display:grid;gap:5mm;margin:3mm 0 4mm;page-break-inside:avoid}
  .sign>div{border:1.5px solid #${LINE};border-radius:2mm;padding:3mm 4mm;min-height:52mm}
  .sign b{color:#${NAVY};display:block;margin-bottom:2.5mm}
  .sign .ln{margin:2.4mm 0;color:#${SOFT}}
  .sign .sg{margin-top:9mm;font-size:8.5pt;color:#${SOFT}}`;

  let h = '';
  h += `<section class="cover"><img class="logo" src="${logo}"><div class="kicker">${esc(META.projet)} · Dossier officiel de livraison</div>
    <h1>${esc(doc.title)}</h1><p class="sub">${esc(doc.subtitle)}</p>
    <table class="meta">
      <tr><td>Client</td><td>${esc(META.client)}</td></tr>
      <tr><td>Prestataire</td><td>${esc(META.prestataire)}</td></tr>
      <tr><td>Document</td><td>${esc(doc.id)} / 07 — ${esc(doc.audience)}</td></tr>
      <tr><td>Version</td><td>${esc(META.version)} — ${esc(META.date)}</td></tr>
      <tr><td>Application</td><td>${esc(META.url)}</td></tr>
    </table><div class="foot">${esc(META.diffusion)}</div></section>`;

  if (doc.toc !== false) {
    h += `<h1 class="s" style="margin-top:0">Sommaire</h1><div class="toc">` +
      num.toc.map((e) => `<div class="l${e.level}">${esc(e.label)}</div>`).join('') + '</div>';
  }
  for (const bl of num.blocks) {
    switch (bl.t) {
      case 'h1': h += `<h1 class="s">${esc(bl.label)}</h1>`; break;
      case 'h2': h += `<h2 class="s">${esc(bl.label)}</h2>`; break;
      case 'h3': h += `<h3 class="s">${esc(bl.text)}</h3>`; break;
      case 'p': h += `<p>${htmlInline(bl.text)}</p>`; break;
      case 'ul': h += `<ul>${bl.items.map((i) => `<li>${htmlInline(i)}</li>`).join('')}</ul>`; break;
      case 'ol': h += `<ol>${bl.items.map((i) => `<li>${htmlInline(i)}</li>`).join('')}</ol>`; break;
      case 'code': h += `<pre>${esc(bl.text)}</pre>`; break;
      case 'pb': h += '<div style="page-break-after:always"></div>'; break;
      case 'note': { const [bg, bd] = NOTE[bl.kind] || NOTE.info; h += `<div class="note" style="background:#${bg};border-color:#${bd}">${htmlInline(bl.text)}</div>`; break; }
      case 'img': {
        const f = pathToFileURL(join(IMG, bl.file)).href;
        const plain = bl.file.startsWith('schema-');
        h += `<div class="fig${plain ? ' plain' : ''}"><img src="${f}" style="width:${bl.width}%"><div class="cap">${esc(bl.caption || '')}</div></div>`;
        break;
      }
      case 'table': {
        const tot = bl.widths.reduce((a, b) => a + b, 0);
        const cols = bl.widths.map((w) => `<col style="width:${(w / tot * 100).toFixed(2)}%">`).join('');
        const cls = [bl.zebra ? 'z' : '', bl.labelCol ? 'lab' : '', bl.small ? 'sm' : ''].join(' ');
        const min = bl.minRow ? ` style="height:${Math.round(bl.minRow / 56.7 * 10) / 10}mm"` : '';
        h += `<table class="${cls}"><colgroup>${cols}</colgroup>`;
        if (bl.head) h += `<thead><tr>${bl.head.map((c) => `<th>${htmlInline(c)}</th>`).join('')}</tr></thead>`;
        h += '<tbody>' + bl.rows.map((r) => `<tr${min}>${r.map((c) => `<td>${htmlInline(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
        break;
      }
      case 'sign':
        h += `<div class="sign" style="grid-template-columns:repeat(${bl.parties.length},1fr)">` + bl.parties.map((pt) =>
          `<div><b>${esc(pt.title)}</b>${pt.lines.map((l) => `<div class="ln">${esc(l)} ……………………………</div>`).join('')}<div class="sg">Signature et cachet :</div></div>`).join('') + '</div>';
        break;
      default: throw new Error('bloc inconnu ' + bl.t);
    }
  }
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>${css}</style></head><body>${h}</body></html>`;
}

// ───────────────────────── rendu Word ─────────────────────────
function runsFrom(text, { size, color, bold } = {}) {
  const runs = [];
  for (const [li, line] of String(text).split('\n').entries()) {
    inline(line).forEach((r, i) => runs.push(new TextRun({
      text: r.text, bold: r.bold || bold, size, color,
      font: r.code ? 'Consolas' : undefined, shading: r.code ? { type: ShadingType.CLEAR, fill: 'EEF2FA', color: 'auto' } : undefined,
      break: li > 0 && i === 0 ? 1 : undefined,
    })));
  }
  return runs;
}

const border = (c = LINE, sz = 4) => ({ style: BorderStyle.SINGLE, size: sz, color: c });
const allBorders = (c) => ({ top: border(c), bottom: border(c), left: border(c), right: border(c) });
const TEXT_W = 9638; // 17 cm en DXA

function renderDocx(doc, num) {
  const numbering = [{
    reference: 'bullets',
    levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }],
  }];
  let olCount = 0;
  const kids = [];

  const para = (text, o = {}) => new Paragraph({ children: runsFrom(text, o.run), spacing: { after: 100, line: 276 }, ...o.p });

  // couverture
  const logoBuf = readFileSync(join(ROOT, '..', '..', 'frontend', 'src', 'assets', 'logo-full.png'));
  const ls = imageSize(logoBuf);
  const cover = [];
  cover.push(new Paragraph({ children: [new ImageRun({ type: 'png', data: logoBuf, transformation: { width: 190, height: Math.round(190 * ls.h / ls.w) }, altText: { title: 'Logo', description: 'Logo CECI Ratoma', name: 'logo' } })], spacing: { before: 600, after: 600 } }));
  cover.push(new Paragraph({ children: [new TextRun({ text: `${META.projet} · DOSSIER OFFICIEL DE LIVRAISON`, bold: true, size: 22, color: BLUE, characterSpacing: 40 })], spacing: { after: 200 } }));
  cover.push(new Paragraph({ children: [new TextRun({ text: doc.title, bold: true, size: 60, color: NAVY })], spacing: { after: 200, line: 300 } }));
  cover.push(new Paragraph({ children: [new TextRun({ text: doc.subtitle, size: 26, color: SOFT })], spacing: { after: 1800 } }));
  const metaRows = [
    ['Client', META.client], ['Prestataire', META.prestataire], ['Document', `${doc.id} / 07 — ${doc.audience}`],
    ['Version', `${META.version} — ${META.date}`], ['Application', META.url],
  ];
  cover.push(new Table({
    width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: [1900, TEXT_W - 1900], layout: TableLayoutType.FIXED,
    rows: metaRows.map(([k, v]) => new TableRow({
      children: [
        new TableCell({ width: { size: 1900, type: WidthType.DXA }, borders: { top: border(LINE), bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } }, margins: { top: 80, bottom: 80, left: 0, right: 100 }, children: [new Paragraph({ children: [new TextRun({ text: k, color: SOFT, size: 20 })] })] }),
        new TableCell({ width: { size: TEXT_W - 1900, type: WidthType.DXA }, borders: { top: border(LINE), bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } }, margins: { top: 80, bottom: 80, left: 0, right: 0 }, children: [new Paragraph({ children: [new TextRun({ text: v, size: 20 })] })] }),
      ],
    })),
  }));
  cover.push(new Paragraph({ children: [new TextRun({ text: META.diffusion, size: 17, color: SOFT })], spacing: { before: 300 } }));

  // sommaire
  if (doc.toc !== false) {
    kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Sommaire')], pageBreakBefore: false }));
    for (const e of num.toc) {
      kids.push(new Paragraph({
        children: [new TextRun({ text: e.label, size: e.level === 1 ? 21 : 19, bold: e.level === 1, color: e.level === 1 ? NAVY : SOFT })],
        spacing: { before: e.level === 1 ? 100 : 0, after: 20 }, indent: { left: e.level === 2 ? 360 : 0 },
      }));
    }
    kids.push(new Paragraph({ children: [new PageBreak()] }));
  }

  const cell = (text, w, o = {}) => new TableCell({
    width: { size: w, type: WidthType.DXA }, borders: allBorders(o.head ? NAVY : LINE), verticalAlign: VerticalAlign.TOP,
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: String(text).split('\n\n').map((chunk) => new Paragraph({ children: runsFrom(chunk, { size: o.size, color: o.color, bold: o.bold }), spacing: { after: 20, line: 250 } })),
  });

  for (const bl of num.blocks) {
    switch (bl.t) {
      case 'h1': kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(bl.label)] })); break;
      case 'h2': kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(bl.label)] })); break;
      case 'h3': kids.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(bl.text)] })); break;
      case 'p': kids.push(para(bl.text)); break;
      case 'ul': bl.items.forEach((i) => kids.push(new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: runsFrom(i), spacing: { after: 50, line: 270 } }))); break;
      case 'ol': {
        const ref = `ol${++olCount}`;
        numbering.push({ reference: ref, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 320 } } } }] });
        bl.items.forEach((i) => kids.push(new Paragraph({ numbering: { reference: ref, level: 0 }, children: runsFrom(i), spacing: { after: 50, line: 270 } })));
        break;
      }
      case 'code': bl.text.split('\n').forEach((ln, i, a) => kids.push(new Paragraph({
        children: [new TextRun({ text: ln || ' ', font: 'Consolas', size: 17 })],
        shading: { type: ShadingType.CLEAR, fill: 'F1F4FA', color: 'auto' }, indent: { left: 120, right: 120 },
        spacing: { before: i === 0 ? 40 : 0, after: i === a.length - 1 ? 140 : 0, line: 240 }, keepLines: true,
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: LINE, space: 6 } },
      }))); break;
      case 'pb': kids.push(new Paragraph({ children: [new PageBreak()] })); break;
      case 'note': {
        const [bg, bd] = NOTE[bl.kind] || NOTE.info;
        kids.push(new Table({
          width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: [TEXT_W], layout: TableLayoutType.FIXED,
          rows: [new TableRow({ cantSplit: true, children: [new TableCell({
            width: { size: TEXT_W, type: WidthType.DXA },
            borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, left: { style: BorderStyle.SINGLE, size: 24, color: bd } },
            shading: { type: ShadingType.CLEAR, fill: bg, color: 'auto' }, margins: { top: 90, bottom: 90, left: 160, right: 120 },
            children: [new Paragraph({ children: runsFrom(bl.text, { size: 20 }), spacing: { after: 0, line: 260 } })],
          })] })],
        }));
        kids.push(new Paragraph({ children: [], spacing: { after: 80 } }));
        break;
      }
      case 'img': {
        const buf = readFileSync(join(IMG, bl.file));
        const s = imageSize(buf);
        const w = Math.round(620 * bl.width / 100);
        kids.push(new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 60, after: 40 }, children: [new ImageRun({ type: s.type, data: buf, transformation: { width: w, height: Math.round(w * s.h / s.w) }, altText: { title: bl.caption || bl.file, description: bl.caption || bl.file, name: bl.file } })] }));
        kids.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: bl.caption || '', size: 17, color: SOFT })] }));
        break;
      }
      case 'table': {
        const tot = bl.widths.reduce((a, b) => a + b, 0);
        let ws = bl.widths.map((w) => Math.floor(w / tot * TEXT_W));
        ws[ws.length - 1] += TEXT_W - ws.reduce((a, b) => a + b, 0);
        const size = bl.small ? 16 : 18;
        const rows = [];
        if (bl.head) rows.push(new TableRow({ tableHeader: true, cantSplit: true, children: bl.head.map((c, i) => cell(c, ws[i], { head: true, fill: NAVY, color: 'FFFFFF', bold: true, size })) }));
        bl.rows.forEach((r, ri) => rows.push(new TableRow({
          cantSplit: true, height: bl.minRow ? { value: bl.minRow, rule: 'atLeast' } : undefined,
          children: r.map((c, i) => cell(c, ws[i], { size, fill: bl.labelCol && i === 0 ? LIGHT : bl.zebra && ri % 2 === 1 ? GREY : undefined, bold: bl.labelCol && i === 0, color: bl.labelCol && i === 0 ? NAVY : undefined })),
        })));
        kids.push(new Table({ width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: ws, layout: TableLayoutType.FIXED, rows }));
        kids.push(new Paragraph({ children: [], spacing: { after: 100 } }));
        break;
      }
      case 'sign': {
        const n = bl.parties.length;
        const w = Math.floor(TEXT_W / n);
        const ws = bl.parties.map((_, i) => (i === n - 1 ? TEXT_W - w * (n - 1) : w));
        kids.push(new Table({
          width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: ws, layout: TableLayoutType.FIXED,
          rows: [new TableRow({ cantSplit: true, height: { value: 3300, rule: 'atLeast' }, children: bl.parties.map((pt, i) => new TableCell({
            width: { size: ws[i], type: WidthType.DXA }, borders: allBorders(LINE), margins: { top: 120, bottom: 120, left: 160, right: 160 },
            children: [
              new Paragraph({ children: [new TextRun({ text: pt.title, bold: true, color: NAVY, size: 20 })], spacing: { after: 120 } }),
              ...pt.lines.map((l) => new Paragraph({ children: [new TextRun({ text: `${l} …………………………`, color: SOFT, size: 19 })], spacing: { after: 100 } })),
              new Paragraph({ children: [new TextRun({ text: 'Signature et cachet :', color: SOFT, size: 17 })], spacing: { before: 500 } }),
            ],
          })) })],
        }));
        kids.push(new Paragraph({ children: [], spacing: { after: 100 } }));
        break;
      }
      default: throw new Error('bloc inconnu ' + bl.t);
    }
  }

  const heading = (size, color, extra = {}) => ({ run: { font: 'Calibri', size, bold: true, color }, paragraph: { keepNext: true, ...extra } });
  return new Document({
    creator: META.prestataire, title: doc.title, description: `${META.projet} — ${doc.subtitle}`,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 21, color: INK }, paragraph: { spacing: { after: 100, line: 276 } } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, ...heading(34, NAVY, { spacing: { before: 360, after: 140 }, outlineLevel: 0, border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: BLUE, space: 4 } } }) },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, ...heading(26, NAVY, { spacing: { before: 260, after: 90 }, outlineLevel: 1 }) },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, ...heading(22, BLUE, { spacing: { before: 200, after: 70 }, outlineLevel: 2 }) },
      ],
    },
    numbering: { config: numbering },
    sections: [
      { properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children: cover },
      {
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1300, bottom: 1200, left: 1134, right: 1134, header: 560, footer: 520 } } },
        headers: { default: new Header({ children: [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 4 } }, children: [new TextRun({ text: `${META.projet} — ${doc.title}`, size: 16, color: SOFT })] })] }) },
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${META.clientCourt} · version ${META.version} · page `, size: 16, color: SOFT }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: SOFT }), new TextRun({ text: ' / ', size: 16, color: SOFT }), new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: SOFT })] })] }) },
        children: kids,
      },
    ],
  });
}

// ───────────────────────── PDF via Edge ─────────────────────────
async function withEdge(fn) {
  const PORT = 9555;
  const profile = join(tmpdir(), 'wakara-edge-doc-' + Date.now());
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* retry */ } await sleep(500); }
  const tgt = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (d) => (d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  try { return await fn({ send, sleep }); } finally { ws.close(); edge.kill(); }
}

async function toPdf(items) {
  await withEdge(async ({ send, sleep }) => {
    for (const { htmlFile, pdfFile, doc } of items) {
      await send('Page.navigate', { url: pathToFileURL(htmlFile).href });
      await sleep(1500);
      const r = await send('Page.printToPDF', {
        printBackground: true, preferCSSPageSize: true, generateDocumentOutline: true, generateTaggedPDF: true,
      });
      writeFileSync(pdfFile, Buffer.from(r.data, 'base64'));
      console.log('pdf ', pdfFile.split(/[\\/]/).pop());
    }
  });
}

// ───────────────────────── principal ─────────────────────────
const only = process.argv.slice(2);
const tmp = join(tmpdir(), 'wakara-doc-html');
mkdirSync(tmp, { recursive: true });
const pdfItems = [];
for (const d of DOCS) {
  if (only.length && !only.includes(d.id)) continue;
  const mod = await import(pathToFileURL(join(HERE, d.module)).href);
  const doc = { ...mod.default, id: d.id };
  const num = numberize(doc.blocks);
  const htmlFile = join(tmp, d.fichier + '.html');
  writeFileSync(htmlFile, renderHtml(doc, num));
  pdfItems.push({ htmlFile, pdfFile: join(ROOT, d.fichier + '.pdf'), doc });
  const buf = await Packer.toBuffer(renderDocx(doc, num));
  writeFileSync(join(ROOT, d.fichier + '.docx'), buf);
  console.log('docx', d.fichier + '.docx', Math.round(buf.length / 1024) + ' Ko');
}
if (!process.env.NO_PDF) await toPdf(pdfItems);
process.exit(0);
