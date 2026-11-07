#!/usr/bin/env node
/*
 * meshos-fetch — airgap OS-update downloader for the MeshCentral pkgmanager plugin.
 *
 * Consumes the report.json exported by the plugin («Esporta report (.json)»,
 * v1.6.0) and downloads ONLY the missing updates, per operating system,
 * from the vendor sources. The MeshCentral server stays offline: run this on
 * ANY machine with internet, then copy the output folder into
 * plugins/pkgmanager/store/ on the server and import it in the plugin.
 *
 *   node meshos-fetch.js <report.json> --out ./os-updates [options]
 *
 * Output layout (ready for the plugin import):
 *   os-updates/linux/<name>_<version>_<arch>.deb   (delta + resolved deps)
 *   os-updates/windows/<KB>.msu                   (--kb list, best effort)
 *   os-updates/macos/<combo>.pkg                   (best effort)
 *   os-updates/manifest.json                       (machine-readable result:
 *       files with sha384 — the plugin recomputes them server-side at import)
 *
 * Linux (solid): reads the installed packages from the report, downloads the
 *   Ubuntu security+updates Packages indexes for that codename, computes the
 *   delta per machine (installed != available) and resolves the dependency
 *   closure from the index itself (packages not already installed are queued
 *   recursively; version constraints are logged, dpkg --compare-versions is
 *   used when available to pick the newest candidate).
 *
 * Windows (best effort): --kb KB5034441,KB5031356 queries the Microsoft
 *   Update Catalog (search + download dialog) and downloads the x64 .msu.
 *   Without --kb, Windows machines are reported and skipped (the report lists
 *   INSTALLED hotfixes; "missing" KBs must come from your WSUS/patch list).
 *
 * macOS (best effort): --macos "15.2" fetches the matching combo/full update
 *   from swscan.apple.com (per-major .sucatalog); without it, macOS machines
 *   are reported and skipped.
 *
 * No npm dependencies: Node built-ins only (>=18: fetch, zlib).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) meshos-fetch/1.0';

function log(msg) { console.log('[meshos-fetch] ' + msg); }
function die(msg) { console.error('[meshos-fetch] FATAL: ' + msg); process.exit(1); }

function usage(code) {
  console.log('usage: node meshos-fetch.js <report.json> --out <dir> [--max N] [--kb KB1,KB2] [--macos 15.2] [--skip-deps]');
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.length < 1 || argv[0].startsWith('-')) usage(1);
const REPORT = argv[0];
let outDir = null, maxFiles = Infinity, kbList = [], macosVersion = null, skipDeps = false;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') { outDir = argv[++i]; }
  else if (a === '--max') { maxFiles = parseInt(argv[++i], 10); }
  else if (a === '--kb') { kbList = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean); }
  else if (a === '--macos') { macosVersion = String(argv[++i] || ''); }
  else if (a === '--skip-deps') { skipDeps = true; }
  else if (a === '--help' || a === '-h') usage(0);
  else die('unknown option: ' + a);
}
if (!outDir) { console.error('missing --out'); usage(1); }

// ---------- helpers ----------
async function get(url, { asText = false, gunzip = false } = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' per ' + url);
  const buf = Buffer.from(await r.arrayBuffer());
  return gunzip ? zlib.gunzipSync(buf) : (asText ? buf.toString('utf8') : buf);
}
function sha384Of(buf) { return crypto.createHash('sha384').update(buf).digest('hex'); }

// dpkg version compare when available (best), else string compare fallback
let hasDpkg = false;
try { execFileSync('dpkg', ['--version'], { stdio: 'ignore' }); hasDpkg = true; } catch (e) { }
function verGe(a, b) { // a >= b ?
  if (a === b) return true;
  if (hasDpkg) { try { execFileSync('dpkg', ['--compare-versions', a, 'ge', b], { stdio: 'ignore' }); return true; } catch (e) { return false; } }
  return String(a) >= String(b); // approximation without dpkg
}

// ---------- report ----------
let report;
try { report = JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch (e) { die('report non leggibile: ' + e.message); }
if (!report || !Array.isArray(report.machines)) die('report senza machines[] — esportalo di nuovo dal plugin (v1.6.0+)');
log('report: ' + report.machines.length + ' macchina/e, generato ' + report.generated);

// ---------- Linux: Packages index -> delta + deps ----------
function parsePackagesIdx(text) {
  const idx = new Map(); // name -> array of stanzas
  const stanzas = String(text).split(/\n\n/);
  for (const st of stanzas) {
    const o = {};
    for (const line of st.split('\n')) {
      const c = line.indexOf(':');
      if (c > 0) { const k = line.slice(0, c).trim(); const v = line.slice(c + 1).trim(); if (!(k in o)) o[k] = v; }
    }
    if (o.Package && o.Version && (o.Architecture === 'amd64' || o.Architecture === 'all') && o.Filename) {
      if (!idx.has(o.Package)) idx.set(o.Package, []);
      idx.get(o.Package).push(o);
    }
  }
  return idx;
}
function bestCandidate(stanzas) {
  let best = stanzas[0];
  for (const s of stanzas) { if (verGe(s.Version, best.Version)) best = s; }
  return best;
}
function parseDepends(st) {
  // "pkgA (>= 1), pkgB | pkgC, pkgD" -> [ [A,B], [C], [D] ] (first alternative first)
  const out = [];
  const groups = String(st || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const g of groups) {
    const alts = g.split('|').map((s) => s.trim().split(/[ (]/)[0].trim()).filter(Boolean);
    if (alts.length) out.push(alts);
  }
  return out;
}

async function fetchLinuxIndex(codename) {
  const pockets = [
    'https://security.ubuntu.com/ubuntu/dists/' + codename + '-security',
    'http://archive.ubuntu.com/ubuntu/dists/' + codename + '-updates'
  ];
  const areas = ['main', 'universe'];
  const idx = new Map();
  for (const base of pockets) {
    for (const area of areas) {
      const url = base + '/' + area + '/binary-amd64/Packages.gz';
      let txt = null;
      for (const u of [url, url.replace('http://', 'https://')]) {
        try { txt = (await get(u, { gunzip: true })).toString('utf8'); break; } catch (e) { }
      }
      if (txt == null) { log('  avviso: indice non raggiungibile ' + url.split('/dists/')[1]); continue; }
      for (const [name, stanzas] of parsePackagesIdx(txt)) {
        if (!idx.has(name)) idx.set(name, []);
        for (const s of stanzas) idx.get(name).push(s);
      }
    }
  }
  return idx; // name -> stanzas[]
}

// ---------- main ----------
(async () => {
  fs.mkdirSync(outDir, { recursive: true }); // FLAT: i nomi sono unici e il plugin store e' piatto (store/<id>/<file>)

  const machines = report.machines;
  const byOs = { linux: [], windows: [], macos: [] };
  for (const m of machines) {
    const os = String(m.os || '').toLowerCase();
    if (os === 'windows') byOs.windows.push(m);
    else if (os === 'macos' || os === 'darwin') byOs.macos.push(m);
    else byOs.linux.push(m);
  }
  log('riparto: linux=' + byOs.linux.length + ' windows=' + byOs.windows.length + ' macos=' + byOs.macos.length);

  const manifest = { tool: 'meshos-fetch', version: '1.0', generated: new Date().toISOString(), sourceReport: REPORT, files: [], skipped: [] };
  let downloaded = 0;

  // ---- LINUX: delta per macchina + chiusura dipendenze ----
  const linuxDone = new Map(); // "name_version" -> {file, sha384, size, url, targets:Set}
  for (const m of byOs.linux) {
    const codename = (m.osInfo && m.osInfo.codename && m.osInfo.codename.trim()) || null;
    if (!codename) { manifest.skipped.push({ machine: m.name, reason: 'osInfo.codename assente nel report (scansione vecchia?)' }); continue; }
    const installed = new Map();
    for (const it of m.items || []) {
      const sp = it.indexOf(' ');
      if (sp > 0) installed.set(it.slice(0, sp), it.slice(sp + 1).trim());
    }
    log('linux ' + m.name + ': ' + installed.size + ' pacchetti installati (Ubuntu ' + ((m.osInfo && m.osInfo.version) || '?') + ' ' + codename + ')');
    const idx = await fetchLinuxIndex(codename);
    log('  indice vendor: ' + idx.size + ' pacchetti (security+updates, main+universe)');

    const queue = [];
    const queued = new Set();
    const pushPkg = (name, reason) => {
      const st = idx.get(name);
      if (!st) { manifest.skipped.push({ machine: m.name, package: name, reason: 'non nell indice vendor (probabile virtuale/non in pool)' }); return; }
      const cand = bestCandidate(st);
      const key = name + '_' + cand.Version;
      if (queued.has(key)) return;
      queued.add(key);
      queue.push({ name, reason, stanza: cand });
    };
    // delta: installato con versione diversa dal candidato piu' nuovo
    let deltaN = 0;
    for (const [name, inst] of installed) {
      const st = idx.get(name);
      if (!st) continue;
      const cand = bestCandidate(st);
      if (!verGe(inst, cand.Version)) { pushPkg(name, 'aggiornamento disponibile'); deltaN++; }
    }
    log('  delta (security+updates): ' + deltaN + ' pacchetti');
    // chiusura dipendenze (se abilitata): qualsiasi dipendenza non installata viene accodata
    if (!skipDeps) {
      const seen = new Set(queued);
      let frontier = queue.slice();
      while (frontier.length > 0) {
        const next = [];
        for (const q of frontier) {
          for (const alts of parseDepends((q.stanza.Depends || '') + ',' + (q.stanza['Pre-Depends'] || ''))) {
            let hit = null;
            for (const a of alts) { if (idx.has(a) && !seen.has(a + '_dep')) { hit = a; break; } }
            const pick = hit || (alts.find((a) => idx.has(a)) || null);
            if (pick == null) continue; // virtuale o non in pool
            if (installed.has(pick)) continue; // gia' installata sulla macchina
            seen.add(pick + '_dep');
            const stz = bestCandidate(idx.get(pick));
            const key = pick + '_' + stz.Version;
            if (queued.has(key)) continue;
            queued.add(key);
            queue.push({ name: pick, reason: 'dipendenza di ' + q.name, stanza: stz });
            next.push({ name: pick, stanza: stz });
          }
        }
        frontier = next;
      }
      log('  con dipendenze nuove: ' + queue.length + ' pacchetti totali da scaricare');
    }
    // registro i target per ogni pacchetto
    for (const q of queue) {
      const key = q.name + '_' + q.stanza.Version;
      if (!linuxDone.has(key)) {
        const fname = q.name + '_' + q.stanza.Version + '_' + (q.stanza.Architecture || 'amd64') + '.deb';
        linuxDone.set(key, { package: q.name, version: q.stanza.Version, file: fname, url: 'http://security.ubuntu.com/ubuntu/' + q.stanza.Filename.replace(/^\/?/, q.stanza.Filename.startsWith('pool') ? '' : ''), origUrl: 'http://archive.ubuntu.com/ubuntu/' + q.stanza.Filename, size: parseInt(q.stanza.Size || '0', 10), sha384: null, reasons: new Set(), targets: new Set() });
      }
      const e = linuxDone.get(key);
      e.reasons.add(q.reason);
      e.targets.add(m.id || m.name);
    }
  }
  // scarico (dedup), con --max per i test
  const linuxList = Array.from(linuxDone.values()).sort((a, b) => (a.size || 0) - (b.size || 0)); // prima i piccoli
  log('download linux unificato: ' + linuxList.length + ' file distinti' + ((maxFiles < Infinity) ? (' (cap --max ' + maxFiles + ')') : '') + ', ~' + (linuxList.reduce((s, e) => s + (e.size || 0), 0) / 1e6).toFixed(1) + ' MB totali');
  for (const e of linuxList) {
    if (downloaded >= maxFiles) { manifest.skipped.push({ file: e.file, reason: 'cap --max raggiunto' }); continue; }
    let buf = null, used = null;
    for (const u of [e.origUrl, e.url]) {
      try { buf = await get(u); used = u; break; } catch (err) { }
    }
    if (buf == null) { manifest.skipped.push({ file: e.file, reason: 'download fallito (' + e.origUrl + ')' }); continue; }
    const dst = path.join(outDir, e.file);
    fs.writeFileSync(dst, buf);
    e.sha384 = sha384Of(buf);
    e.size = buf.length;
    manifest.files.push({ os: 'linux', package: e.package, version: e.version, file: e.file, sha384: e.sha384, size: buf.length, url: used, reasons: Array.from(e.reasons), targets: Array.from(e.targets) });
    downloaded++;
    log('  ✓ ' + e.file + ' (' + (buf.length / 1024).toFixed(0) + 'KB)');
  }

  // ---- WINDOWS (best effort): --kb -> .msu dal Microsoft Update Catalog ----
  for (const m of byOs.windows) {
    if (kbList.length === 0) { manifest.skipped.push({ machine: m.name, reason: 'windows: nessun --kb fornito (il report elenca i KB installati; i mancanti arrivano dalla tua lista patch/WSUS)' }); continue; }
    const build = (m.osInfo && m.osInfo.version) || '';
    log('windows ' + m.name + ': ' + (m.items || []).length + ' hotfix installati, build ' + build + ' — KB richiesti: ' + kbList.join(','));
    for (const kb of kbList) {
      if (downloaded >= maxFiles) { manifest.skipped.push({ file: kb, reason: 'cap --max raggiunto' }); continue; }
      try {
        const search = await get('https://www.catalog.update.microsoft.com/Search.aspx?q=' + encodeURIComponent(kb), { asText: true });
        let guid = null;
        const m1 = /goToDetails\(\s*["']([0-9a-f-]{36})["']/i.exec(search);
        if (m1) guid = m1[1];
        if (!guid) { const m2 = /updateID=([0-9a-f-]{36})/i.exec(search); if (m2) guid = m2[1]; }
        if (!guid) { manifest.skipped.push({ file: kb, reason: 'KB non trovato nella ricerca del Catalog (html senza risultati o markup cambiato)' }); continue; }
        const dl = await get('https://www.catalog.update.microsoft.com/DownloadDialog.aspx', { asText: true, method: 'POST' }).catch(() => null);
        // DownloadDialog vuole POST form; fetch POST:
        const r2 = await fetch('https://www.catalog.update.microsoft.com/DownloadDialog.aspx', {
          method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'updateIDs=' + encodeURIComponent(JSON.stringify([{ size: 0, languages: '', uidInfo: guid, updateID: guid }]))
        });
        const dlg = await r2.text();
        const mu = /downloadInformation\[0\]\.files\[0\]\.url\s*=\s*['"]([^'"]+)['"]/.exec(dlg);
        if (!mu) { manifest.skipped.push({ file: kb, reason: 'dialog di download senza url (markup Catalog cambiato)' }); continue; }
        const buf = await get(mu[1]);
        const fname = kb + '.msu';
        fs.writeFileSync(path.join(outDir, fname), buf);
        manifest.files.push({ os: 'windows', package: kb, version: '', file: fname, sha384: sha384Of(buf), size: buf.length, url: mu[1], reasons: ['richiesto --kb'], targets: [m.id || m.name] });
        downloaded++;
        log('  ✓ ' + fname + ' (' + (buf.length / 1048576).toFixed(1) + 'MB)');
      } catch (e) {
        manifest.skipped.push({ file: kb, reason: 'errore Catalog: ' + e.message });
      }
    }
  }

  // ---- macOS (best effort): combo dal sucatalog di Apple ----
  for (const m of byOs.macos) {
    const ver = macosVersion || ((m.osInfo && m.osInfo.version) || '');
    if (!ver) { manifest.skipped.push({ machine: m.name, reason: 'macos: nessuna --macos fornita e osInfo.version assente' }); continue; }
    const major = String(ver).split('.')[0];
    log('macos ' + m.name + ': cerco combo/full-installer per ' + ver + ' (sucatalog index-' + major + '-1)');
    try {
      const cat = await get('https://swscan.apple.com/content/catalogs/others/index-' + major + '-1.sucatalog', { asText: true });
      // best-effort: accoppia ProductVersion <-> DistURL nel plist
      const pvRe = /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/g;
      const duRe = /<key>DistURL<\/key>\s*<string>([^<]+)<\/string>/g;
      const pvs = []; let mm; while ((mm = pvRe.exec(cat)) !== null) pvs.push(mm[1]);
      const dus = []; while ((mm = duRe.exec(cat)) !== null) dus.push(mm[1]);
      let distUrl = null;
      for (let k = 0; k < Math.min(pvs.length, dus.length); k++) { if (pvs[k] === ver) { distUrl = dus[k]; break; } }
      if (!distUrl) { manifest.skipped.push({ machine: m.name, reason: 'nessun prodotto combo per macOS ' + ver + ' nel sucatalog (prova --macos con la versione esatta, es. 15.1.1)' }); continue; }
      const dist = await get(distUrl, { asText: true });
      const pu = /https?:\/\/[^"'<\s]+\.pkg/i.exec(dist);
      if (!pu) { manifest.skipped.push({ machine: m.name, reason: 'dist senza url .pkg (markup Apple cambiato)' }); continue; }
      const buf = await get(pu[0]);
      const fname = path.basename(new URL(pu[0]).pathname);
      fs.writeFileSync(path.join(outDir, fname), buf);
      manifest.files.push({ os: 'macos', package: fname, version: ver, file: fname, sha384: sha384Of(buf), size: buf.length, url: pu[0], reasons: ['combo ' + ver], targets: [m.id || m.name] });
      downloaded++;
      log('  ✓ ' + fname + ' (' + (buf.length / 1048576).toFixed(1) + 'MB)');
    } catch (e) {
      manifest.skipped.push({ machine: m.name, reason: 'errore sucatalog: ' + e.message });
    }
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log('fatto: ' + manifest.files.length + ' file scaricati, ' + manifest.skipped.length + ' saltati -> ' + outDir);
  log('prossimo passo: copia ' + outDir + ' sul server in plugins/pkgmanager/store/<id-bundle>/ e importa il manifest con «Importa manifest…» in Gestione aggiornamenti.');
  process.exit(0);
})().catch((e) => { die(e.stack || e.message); });