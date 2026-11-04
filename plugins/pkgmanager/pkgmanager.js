/**
 * MeshCentral Package Manager plugin ("pkgmanager") — v0.9.1.
 *
 * Design: the catalog lives server-side (catalog.json next to this file).
 * The plugin pages are TABS IN THE TOP GRAY BAR (their own
 * #pkgmanagerMenuSpan row next to #MainSubMenuSpan — the span that renders
 * the per-device General/Desktop/Terminal/Files tabs — with the same
 * topbar_td style3x classes; the active tab carries the same fullselect
 * class go() toggles on the core tabs). The row is ALWAYS visible as the
 * plugin top menu (v0.7.1): it is hidden ONLY while a device sub-view owns
 * the gray bar (x 9..19, the General/Desktop/... row), so the three
 * entries are discoverable right after login):
 *   - "Installazione pacchetti" (everyone) -> the existing install page:
 *     package table + target machine checkboxes on the right; the list
 *     auto-filters by the OSes of the selected machines; installs run on
 *     EVERY selected machine and the output comes back into ONE results
 *     dialog (runcommands reply).
 *   - "Gestione pacchetti" (full site admins only): catalog management —
 *     add / edit / delete packages and upload / delete airgap artifacts
 *     straight from the UI.
 *   - "Creazione pacchetti" (full site admins only): the GUIDED PACKAGE
 *     BUILDER (v0.9.0) — ONE single form with an OS dropdown (like the
 *     other options): switching OS swaps artifact/type/timeout/command
 *     fields and a per-OS draft in memory never loses anything. Airgap
 *     presets per artifact extension, {{url}}/{{sha384}} insertion at the
 *     cursor, artifact upload, live ID check. Save MERGES: drafted defs +
 *     defs already saved for that ID (the wizard never silently drops a
 *     saved OS). Catalog replies only update hints/acks, never re-render
 *     the form. v0.9.1: the management Add/Edit form uses the SAME
 *     single-form pattern (OS dropdown + its own per-OS drafts + merge
 *     save) — "Modifica" no longer shows one section per OS.
 * The sidebar box opens the main page directly (no dropdown), and the
 * per-device "Plugins" tab (p19) keeps a single-device entry point.
 *
 * AIRGAP (v0.4.0+): packages install WITHOUT internet. Artifacts are dropped
 * on the server in <datapath>/plugins/pkgmanager/store/<pkg-id>/<file> — or
 * uploaded from the management page — and served to the AGENT over the LAN by
 * this plugin via /pkgstore.ashx (GET download: per-process token; POST
 * upload/delete: session-authenticated full site admin). The device downloads
 * the artifact from THIS server and installs locally (dpkg -i / msiexec /
 * installer -pkg / plain script). Catalog "cmd" supports the {{url}} and
 * {{sha384}} placeholders (server-computed hash -> device-side verification).
 *
 * Server surface: serveraction "list" (catalog + token + artifact enrichment)
 * and "save"/"delete" (full site admins only); hook_setupHttpHandlers
 * registers /pkgstore.ashx GET+POST. Installs go through the core runcommands
 * path (device rights enforced).
 *
 * Client functions listed in obj.exports are stringified into the browser by
 * pluginHandler.prepExports() and run in page context: they must not reference
 * this closure — only page globals (meshserver, currentNode, nodes, userinfo,
 * Q, EscapeHtml, d2runBegin...) and pluginHandler.pkgmanager.*.
 */
module.exports.pkgmanager = function (parent) {
    var crypto = require('crypto');
    var obj = {};
    obj.version = '0.9.1';
    obj.fs = parent.fs;
    obj.path = parent.path;
    obj.catalogPath = parent.path.join(parent.parent.datapath, 'plugins', 'pkgmanager', 'catalog.json');

    // ---- Client-side (stringified into the browser) ----
    obj.exports = ['onWebUIStartupEnd', 'pkgSidebarInject', 'pkgRequestList', 'pkgList', 'pkgCompose', 'pkgTableHtml', 'pkgTargetOs', 'pkgDevToggle', 'pkgDevSelectAll', 'pkgSelectedNodes', 'pkgSidebarOpen', 'pkgSidebarRenderDevices', 'pkgSidebarRender', 'pkgSidebarInstall', 'pkgInstall', 'pkgRunOn', 'goPageStart', 'pkgMsg', 'pkgTabSetActive', 'pkgAdminOpen', 'pkgAdminRender', 'pkgCreateOpen', 'pkgCreateRender', 'pkgCreateCurOs', 'pkgCreateDefaultType', 'pkgCreateFieldSync', 'pkgCreateDraftSync', 'pkgCreateOsChange', 'pkgCreateOsHint', 'pkgCreateUpload', 'pkgCreateArtifactDel', 'pkgCreatePreset', 'pkgCreateInsert', 'pkgCreateSave', 'pkgCreateCheckId', 'pkgCreateCatalogArrived', 'pkgAdminAdd', 'pkgAdminEdit', 'pkgAdminForm', 'pkgAdminCurOs', 'pkgAdminFieldSync', 'pkgAdminDraftSync', 'pkgAdminOsChange', 'pkgAdminOsHint', 'pkgAdminSave', 'pkgAdminDelete', 'pkgAdminUpload', 'pkgAdminUploadDo', 'pkgAdminArtifactDel', 'pkgAdminStatus', 'pkgAdminRefresh', 'pkgDenied'];

    obj.onWebUIStartupEnd = function () {
        try {
            pluginHandler.registerPluginTab({ tabId: 'pkgmanagerTab', tabTitle: 'Packages' });
            var d = document.getElementById('pkgmanagerTab');
            if (d != null) { d.innerHTML = '<div style="padding:12px;font-family:Arial,Helvetica,sans-serif">Loading package catalog…</div>'; }
            console.log('pkgmanager: startup hook');
            pluginHandler.pkgmanager.pkgSidebarInject();
            pluginHandler.pkgmanager.pkgRequestList();
        } catch (e) { console.log('pkgmanager startup failed: ' + e); }
    };

    // "Packages" entry in the LEFT SIDEBAR (classic + default3 render #page_leftbar;
    // mobile has none, the injection skips there). Clicking it opens the main
    // page directly (no dropdown). The plugin pages are TABS IN THE TOP GRAY
    // BAR (see the injection below). The per-device "Plugins" tab from
    // registerPluginTab keeps working as a second entry point.
    obj.pkgSidebarInject = function () {
        try {
            if (document.getElementById('LeftMenuPackages') != null) return;
            var lb = document.getElementById('page_leftbar');
            if (lb == null) { console.log('pkgmanager: no sidebar in this template, entry skipped'); return; }
            var b = document.createElement('div');
            b.id = 'LeftMenuPackages';
            b.className = 'lbbutton';
            b.title = 'Installazione pacchetti';
            b.setAttribute('tabindex', '0');
            b.setAttribute('onmouseup', 'pluginHandler.pkgmanager.pkgSidebarOpen()');
            // Icon sized to match the other sidebar entries (.lbtg is 62x62).
            b.innerHTML = '<div style="position:absolute;top:8px;left:0;width:100%;text-align:center;font-size:46px;line-height:58px">📦</div>';
            lb.appendChild(b);
            var col = document.getElementById('column_l');
            if (col == null) return;
            var page = document.createElement('div');
            page.id = 'pkgmanagerMainWrap';
            page.style.display = 'none';
            page.innerHTML = '<div id="pkgmanagerMain" style="padding:12px;font-family:Arial,Helvetica,sans-serif"></div>';
            col.appendChild(page);
            // TOP GRAY BAR: the classic template HIDES #MainMenuSpan and shows
            // the per-device tabs (General/Desktop/Files) in #MainSubMenuSpan.
            // Render the plugin tabs in the SAME place and style: our own
            // #pkgmanagerMenuSpan div + table (topbar_td style3x) as a sibling
            // of #MainSubMenuSpan, shown while a plugin page is open and hidden
            // by goPageStart on every go(). "Gestione pacchetti" starts hidden
            // and is shown by pkgTabSetActive() once userinfo is known (admins).
            var sub = document.getElementById('MainSubMenuSpan') || document.getElementById('MainMenuSpan');
            var span = document.createElement('div');
            span.id = 'pkgmanagerMenuSpan';
            span.style.display = 'none';
            if ((sub != null) && (sub.parentNode != null)) {
                // v0.7.2: full-width row like the core device tab row (the core CSS width:100% on
                // #MainSubMenuSpan/#MainSubMenu does not cover this plugin span -> inline on both)
                // + padded entries (16px, like the core nonenglish tabs) so they are not glued.
                span.style.width = '100%';
                span.innerHTML = '<table id="pkgmanagerMenuTable" cellpadding=0 cellspacing=0 class="style1" style="width:100%"><tr>'
                    + '<td tabindex=0 id="MainTabPackages" class="topbar_td style3x" style="padding-left:16px;padding-right:16px" onmouseup="pluginHandler.pkgmanager.pkgSidebarOpen()" onkeypress="if (event.key == \'Enter\') pluginHandler.pkgmanager.pkgSidebarOpen()">Installazione pacchetti</td>'
                    + '<td tabindex=0 id="MainTabPkgMgmt" class="topbar_td style3x" style="display:none;padding-left:16px;padding-right:16px" onmouseup="pluginHandler.pkgmanager.pkgAdminOpen()" onkeypress="if (event.key == \'Enter\') pluginHandler.pkgmanager.pkgAdminOpen()">Gestione pacchetti</td>'
                    + '<td tabindex=0 id="MainTabPkgCreate" class="topbar_td style3x" style="display:none;padding-left:16px;padding-right:16px" onmouseup="pluginHandler.pkgmanager.pkgCreateOpen()" onkeypress="if (event.key == \'Enter\') pluginHandler.pkgmanager.pkgCreateOpen()">Creazione pacchetti</td>'
                    + '<td class="topbar_td_end style3">&nbsp;</td>'
                    + '</tr></table>';
                sub.parentNode.insertBefore(span, sub.nextSibling);
            } else {
                var tb2 = document.getElementById('topbar');
                if (tb2 != null) { tb2.appendChild(span); }
            }
            // The tab row is the plugin TOP MENU: visible right away (v0.7.1),
            // not only after a plugin page is opened.
            pluginHandler.pkgmanager.pkgTabSetActive(null, false);
            console.log('pkgmanager: sidebar entry + top bar tabs injected (row always visible)');
        } catch (e) { console.log('pkgmanager sidebar inject failed: ' + e); }
    };

    // Top gray bar tab state: our #pkgmanagerMenuSpan row shows while a plugin
    // page is open (like #MainSubMenuSpan does while a device is selected);
    // goPageStart (-> null) hides it. Highlight the ACTIVE plugin tab with the
    // same class go() toggles on the core tabs (fullselect), keep "Gestione
    // pacchetti" visible to full site admins only (userinfo.siteadmin), and
    // reserve the submenu row height on column_l exactly like go() does
    // (room4submenu) so the page does not slide under the bar.
    obj.pkgTabSetActive = function (which, hideRow) {
        try {
            var span = document.getElementById('pkgmanagerMenuSpan');
            if (span == null) return;
            var t1 = document.getElementById('MainTabPackages');
            var t2 = document.getElementById('MainTabPkgMgmt');
            var t3 = document.getElementById('MainTabPkgCreate');
            var adm = ((typeof userinfo != 'undefined') && (userinfo != null) && (userinfo.siteadmin === 0xFFFFFFFF));
            if (t2 != null) { t2.style.display = adm ? '' : 'none'; }
            if (t3 != null) { t3.style.display = adm ? '' : 'none'; }
            // The row is the plugin TOP MENU: always visible, except while a
            // device sub-view owns the gray bar (goPageStart passes hideRow
            // for x 9..19 — the same bar renders General/Desktop/... there).
            span.style.display = (hideRow === true) ? 'none' : '';
            var ts = [t1, t2, t3];
            for (var i = 0; i < ts.length; i++) { if (ts[i] != null) { ts[i].classList.remove('fullselect'); } }
            if (which != null) {
                var a = { install: t1, admin: t2, create: t3 }[which];
                if (a != null) { a.classList.add('fullselect'); }
                try { QC('column_l').add('room4submenu'); } catch (e) { }
            } else {
                try { QC('column_l').remove('room4submenu'); } catch (e) { }
            }
        } catch (e) { }
    };

    // go() calls this hook on EVERY navigation — but BEFORE its own modal guard
    // (`if (xxdialogMode) return;`): a go() fired while a modal is open (e.g. the
    // async startup-view re-entry the template runs on a server event) is a NO-OP
    // for the core, yet would tear this page down. Mirror the core guard: with a
    // modal open keep the plugin page; a real navigation (modal closed) still
    // tears it down.
    obj.goPageStart = function (x, event) {
        try {
            if ((typeof xxdialogMode !== 'undefined') && xxdialogMode) return; // core would no-op this go()
            window.pkgmanagerView = null;
            pluginHandler.pkgmanager.pkgTabSetActive(null, ((typeof x == 'number') && (x >= 9) && (x < 20)));
            var w = document.getElementById('pkgmanagerMainWrap');
            if (w != null) w.style.display = 'none';
            var b = document.getElementById('LeftMenuPackages');
            if (b != null) b.style.opacity = '';
        } catch (e) { }
    };

    obj.pkgSidebarOpen = function () {
        try {
            var w = document.getElementById('pkgmanagerMainWrap');
            if (w == null) return;
            // Hide the current core panel and reset the view tracker so any later
            // go(x) fully restores the normal panel (no same-view early return).
            try {
                if ((typeof xxcurrentView == 'number') && (xxcurrentView >= 0) && (xxcurrentView <= 60)) { QV('p' + xxcurrentView, false); }
                xxcurrentView = -1;
            } catch (e) { }
            w.style.display = '';
            window.pkgmanagerView = 'install';
            pluginHandler.pkgmanager.pkgTabSetActive('install');
            var b = document.getElementById('LeftMenuPackages');
            if (b != null) b.style.opacity = '1';
            pluginHandler.pkgmanager.pkgSidebarRenderDevices();
        } catch (e) { console.log('pkgmanager open failed: ' + e); }
    };

    // ---- "Gestione pacchetti" (full site admins) ----
    obj.pkgAdminOpen = function () {
        try {
            var w = document.getElementById('pkgmanagerMainWrap');
            if (w == null) return;
            try {
                if ((typeof xxcurrentView == 'number') && (xxcurrentView >= 0) && (xxcurrentView <= 60)) { QV('p' + xxcurrentView, false); }
                xxcurrentView = -1;
            } catch (e) { }
            w.style.display = '';
            window.pkgmanagerView = 'admin';
            window.pkgmanagerAdminMsg = '';
            pluginHandler.pkgmanager.pkgTabSetActive('admin');
            var b = document.getElementById('LeftMenuPackages');
            if (b != null) b.style.opacity = '1';
            pluginHandler.pkgmanager.pkgAdminRender();
        } catch (e) { console.log('pkgmanager admin open failed: ' + e); }
    };

    obj.pkgAdminRefresh = function () {
        try {
            window.pkgmanagerAdminMsg = '';
            pluginHandler.pkgmanager.pkgRequestList();
            pluginHandler.pkgmanager.pkgAdminStatus('Ricarico catalogo…');
        } catch (e) { }
    };

    // ---- "Creazione pacchetti" (full site admins) ----
    // ENTRY ONLY for now (user request): the guided package builder lands in
    // a later version; the tab opens a placeholder page so the flow exists
    // end-to-end and the label sits in the gray bar as requested.
    obj.pkgCreateOpen = function () {
        try {
            var w = document.getElementById('pkgmanagerMainWrap');
            if (w == null) return;
            try {
                if ((typeof xxcurrentView == 'number') && (xxcurrentView >= 0) && (xxcurrentView <= 60)) { QV('p' + xxcurrentView, false); }
                xxcurrentView = -1;
            } catch (e) { }
            w.style.display = '';
            window.pkgmanagerView = 'create';
            window.pkgmanagerAdminMsg = '';
            if (window.pkgmanagerCatalog == null) { meshserver.send({ action: 'plugin', plugin: 'pkgmanager', pluginaction: 'list' }); }
            pluginHandler.pkgmanager.pkgTabSetActive('create');
            var b = document.getElementById('LeftMenuPackages');
            if (b != null) b.style.opacity = '1';
            pluginHandler.pkgmanager.pkgCreateRender();
        } catch (e) { console.log('pkgmanager create open failed: ' + e); }
    };

    obj.pkgCreateRender = function () {
        try {
            var m = document.getElementById('pkgmanagerMain');
            if (m == null) return;
            var x = '<div style="margin-bottom:8px;font-size:16px"><b>Creazione pacchetti</b> — wizard guidato</div>';
            x += '<div style="color:#888;padding:4px 0 10px 0">Costruisci un pacchetto airgap da un\'unica maschera: scegli il sistema operativo dal menu a discesa come le altre opzioni, carica l\'artefatto e genera il comando con i preset (download dal server in LAN + verifica SHA-384 + installazione locale). Il device non usa internet. Le definizioni salvate per gli altri OS restano nel pacchetto.</div>';
            x += '<div style="border:1px solid #ccc;border-radius:6px;padding:10px;margin-bottom:10px">';
            x += '<table style="border-collapse:collapse">';
            x += '<tr><td style="padding:4px">ID</td><td style="padding:4px"><input type=text id=pkgfId style=width:280px oninput="pluginHandler.pkgmanager.pkgCreateCheckId();pluginHandler.pkgmanager.pkgCreateDraftSync()"> <span id=pkgfIdHint style="color:#888"></span></td></tr>';
            x += '<tr><td style="padding:4px">Nome</td><td style="padding:4px"><input type=text id=pkgfName style=width:280px oninput="pluginHandler.pkgmanager.pkgCreateDraftSync()"></td></tr>';
            x += '<tr><td style="padding:4px">Descrizione</td><td style="padding:4px"><input type=text id=pkgfDesc style=width:420px oninput="pluginHandler.pkgmanager.pkgCreateDraftSync()"></td></tr>';
            x += '<tr><td style="padding:4px">Sistema operativo</td><td style="padding:4px"><select id=pkgfOs onchange="pluginHandler.pkgmanager.pkgCreateOsChange()"><option value=linux selected>Linux</option><option value=windows>Windows</option><option value=macos>macOS</option></select> <span id=pkgfOsHint style="color:#888"></span></td></tr>';
            x += '<tr><td style="padding:4px">Artefatto (file nello store)</td><td style="padding:4px"><input type=text id=pkgfArt style=width:280px oninput="pluginHandler.pkgmanager.pkgCreateDraftSync()"> <input type=button value="Carica artefatto…" onclick="pluginHandler.pkgmanager.pkgCreateUpload()"> <input type=button value="Elimina artefatto" onclick="pluginHandler.pkgmanager.pkgCreateArtifactDel()"></td></tr>';
            x += '<tr><td style="padding:4px">Tipo comando</td><td style="padding:4px"><select id=pkgfType onchange="pluginHandler.pkgmanager.pkgCreateDraftSync()"><option value=3>Shell (Linux/macOS)</option><option value=1>cmd.exe (Windows)</option><option value=2>PowerShell (Windows)</option></select> · Timeout (s): <input type=text id=pkgfTo style=width:70px value=300 oninput="pluginHandler.pkgmanager.pkgCreateDraftSync()"></td></tr>';
            x += '</table>';
            x += '<div style="padding:4px 0">Comando: <input type=button value="Preset airgap" onclick="pluginHandler.pkgmanager.pkgCreatePreset()"> <input type=button value="Inserisci {{url}}" onclick="pluginHandler.pkgmanager.pkgCreateInsert(\'url\')"> <input type=button value="Inserisci {{sha384}}" onclick="pluginHandler.pkgmanager.pkgCreateInsert(\'sha384\')"></div>';
            x += '<textarea id="pkgfCmd" style="width:640px;height:80px;font-family:monospace" oninput="pluginHandler.pkgmanager.pkgCreateDraftSync()"></textarea></div>';
            x += '<div style="margin-top:6px"><input type=button value="Salva pacchetto" onclick="pluginHandler.pkgmanager.pkgCreateSave()"> <input type=file id="pkgfFile" style="display:none"></div>';
            x += '<div id="pkgadminStatus" style="margin-top:6px;color:#888"></div>';
            m.innerHTML = x;
            // Restore the draft: tab re-open re-renders, typed data lives in memory.
            var db = window.pkgmanagerDraftBase;
            if (db != null) { Q('pkgfId').value = db.id || ''; Q('pkgfName').value = db.name || ''; Q('pkgfDesc').value = db.desc || ''; }
            var osCur = window.pkgmanagerDraftOs || 'linux';
            Q('pkgfOs').value = osCur;
            var dd = ((window.pkgmanagerDraft != null) ? window.pkgmanagerDraft[osCur] : null);
            Q('pkgfArt').value = ((dd != null) ? (dd.art || '') : '');
            Q('pkgfType').value = ((dd != null) && (dd.type != null)) ? dd.type : pluginHandler.pkgmanager.pkgCreateDefaultType(osCur);
            Q('pkgfTo').value = ((dd != null) && (dd.to != null)) ? dd.to : '300';
            Q('pkgfCmd').value = ((dd != null) && (dd.cmd != null)) ? dd.cmd : '';
            pluginHandler.pkgmanager.pkgCreateCheckId();
            pluginHandler.pkgmanager.pkgCreateOsHint();
        } catch (e) { console.log('pkgmanager create render failed: ' + e); }
    };

    // ---- v0.9.0 single-form wizard state ----
    // The OS dropdown swaps artifact/type/timeout/command fields; a per-OS
    // draft in window.pkgmanagerDraft (plus window.pkgmanagerDraftBase for
    // id/name/desc) means switching OS — or leaving the page and coming
    // back — never loses what was typed. Every input syncs the draft.
    obj.pkgCreateCurOs = function () { try { return String(Q('pkgfOs').value || 'linux'); } catch (e) { return 'linux'; } };
    obj.pkgCreateDefaultType = function (os) { return (os == 'windows') ? '1' : '3'; };
    obj.pkgCreateFieldSync = function (os) {
        try {
            if (window.pkgmanagerDraft == null) { window.pkgmanagerDraft = {}; }
            window.pkgmanagerDraft[os] = { art: Q('pkgfArt').value.trim(), type: String(Q('pkgfType').value), to: Q('pkgfTo').value.trim(), cmd: Q('pkgfCmd').value };
        } catch (e) { }
    };
    // Sync base fields + the current-OS draft. Wizard-only: a no-op in the
    // management view (its form shares the pkgf* ids but must NOT pollute
    // the wizard draft).
    obj.pkgCreateDraftSync = function () {
        try {
            if (window.pkgmanagerView !== 'create') return;
            pluginHandler.pkgmanager.pkgCreateFieldSync(pluginHandler.pkgmanager.pkgCreateCurOs());
            window.pkgmanagerDraftBase = { id: Q('pkgfId').value.trim(), name: Q('pkgfName').value, desc: Q('pkgfDesc').value };
        } catch (e) { }
    };
    obj.pkgCreateOsChange = function () {
        try {
            var prev = window.pkgmanagerDraftOs || 'linux';
            pluginHandler.pkgmanager.pkgCreateFieldSync(prev);
            var os = pluginHandler.pkgmanager.pkgCreateCurOs();
            var d = ((window.pkgmanagerDraft != null) ? window.pkgmanagerDraft[os] : null);
            Q('pkgfArt').value = ((d != null) ? (d.art || '') : '');
            Q('pkgfType').value = ((d != null) && (d.type != null)) ? d.type : pluginHandler.pkgmanager.pkgCreateDefaultType(os);
            Q('pkgfTo').value = ((d != null) && (d.to != null)) ? d.to : '300';
            Q('pkgfCmd').value = ((d != null) && (d.cmd != null)) ? d.cmd : '';
            window.pkgmanagerDraftOs = os;
            pluginHandler.pkgmanager.pkgCreateOsHint();
        } catch (e) { }
    };
    obj.pkgCreateOsHint = function () {
        try {
            var h = document.getElementById('pkgfOsHint');
            if (h == null) return;
            var pid = Q('pkgfId').value.trim();
            var saved = {};
            var cat = window.pkgmanagerCatalog;
            for (var i = 0; i < ((cat != null) ? cat.packages.length : 0); i++) { if (cat.packages[i].id == pid) { var p = cat.packages[i]; if (p.linux != null) { saved.linux = 1; } if (p.windows != null) { saved.windows = 1; } if (p.macos != null) { saved.macos = 1; } break; } }
            var parts = [];
            var oses = [['linux', 'Linux'], ['windows', 'Windows'], ['macos', 'macOS']];
            for (var k = 0; k < oses.length; k++) {
                var os = oses[k][0];
                if ((window.pkgmanagerDraft != null) && (window.pkgmanagerDraft[os] != null) && (window.pkgmanagerDraft[os].cmd != null) && (window.pkgmanagerDraft[os].cmd != '')) { parts.push(oses[k][1] + ': bozza'); }
                else if (saved[os] != null) { parts.push(oses[k][1] + ': salvato'); }
            }
            h.innerText = parts.length ? ('Definizioni: ' + parts.join(' · ')) : '';
        } catch (e) { }
    };
    obj.pkgCreateUpload = function () {
        try {
            var f = document.getElementById('pkgfFile');
            if (f == null) return;
            f.value = '';
            var os = pluginHandler.pkgmanager.pkgCreateCurOs();
            f.onchange = function () { pluginHandler.pkgmanager.pkgAdminUploadDo(os); };
            f.click();
        } catch (e) { }
    };
    obj.pkgCreateArtifactDel = function () {
        try { pluginHandler.pkgmanager.pkgAdminArtifactDel(pluginHandler.pkgmanager.pkgCreateCurOs()); } catch (e) { }
    };
    // Single-form save: MERGE, never replace. Payload = every drafted OS
    // def + every def already saved in the catalog for this ID (untouched
    // OSes must survive: the server-side save replaces the whole record).
    obj.pkgCreateSave = function () {
        try {
            var pid = Q('pkgfId').value.trim();
            if (!/^[a-zA-Z0-9._-]+$/.test(pid)) { pluginHandler.pkgmanager.pkgAdminStatus('ID non valido (lettere, numeri, . _ -).'); return; }
            var name = Q('pkgfName').value.trim();
            if (name == '') { pluginHandler.pkgmanager.pkgAdminStatus('Nome mancante.'); return; }
            var os = pluginHandler.pkgmanager.pkgCreateCurOs();
            pluginHandler.pkgmanager.pkgCreateFieldSync(os);
            window.pkgmanagerDraftBase = { id: pid, name: name, desc: Q('pkgfDesc').value };
            var pkg = { id: pid, name: name, description: Q('pkgfDesc').value };
            for (var k in window.pkgmanagerDraft) {
                var d = window.pkgmanagerDraft[k];
                if ((k == 'linux') || (k == 'windows') || (k == 'macos')) {
                    if ((d != null) && (d.cmd != null) && (d.cmd.trim() != '')) {
                        var def = { type: (parseInt(d.type) || pluginHandler.pkgmanager.pkgCreateDefaultType(k)), cmd: d.cmd.trim() };
                        var to = parseInt(d.to); if (to > 0) { def.timeout = to; }
                        if ((d.art != null) && (d.art.trim() != '')) { def.artifact = d.art.trim(); }
                        pkg[k] = def;
                    }
                }
            }
            var cat = window.pkgmanagerCatalog;
            for (var i = 0; i < ((cat != null) ? cat.packages.length : 0); i++) {
                if (cat.packages[i].id == pid) {
                    var oses2 = ['linux', 'windows', 'macos'];
                    for (var j = 0; j < oses2.length; j++) {
                        var o2 = oses2[j];
                        if ((pkg[o2] == null) && (cat.packages[i][o2] != null)) { pkg[o2] = cat.packages[i][o2]; }
                    }
                    break;
                }
            }
            if ((pkg.linux == null) && (pkg.windows == null) && (pkg.macos == null)) { pluginHandler.pkgmanager.pkgAdminStatus('Compila il comando per il sistema operativo selezionato prima di salvare.'); return; }
            meshserver.send({ action: 'plugin', plugin: 'pkgmanager', pluginaction: 'save', pkg: pkg });
            pluginHandler.pkgmanager.pkgAdminStatus('Salvataggio…');
            pluginHandler.pkgmanager.pkgCreateOsHint();
        } catch (e) { pluginHandler.pkgmanager.pkgAdminStatus('Errore: ' + e); }
    };

    // Airgap command preset for one OS, chosen by the artifact extension:
    // download from THIS server over LAN ({{url}}), SHA-384 verification
    // ({{sha384}}), then the local install step. The generated command is a
    // starting point — the admin can edit it before saving.
    obj.pkgCreatePreset = function (os) {
        try {
            if (os == null) { os = pluginHandler.pkgmanager.pkgCreateCurOs(); }
            var art = Q('pkgfArt').value.trim();
            var a = (art != '') ? art : 'pacchetto';
            var ext = a.slice(a.lastIndexOf('.') + 1).toLowerCase();
            var cmd = '';
            if (os == 'linux') {
                var inst = 'sh /tmp/' + a;
                if (ext == 'deb') { inst = 'sudo -n dpkg -i /tmp/' + a; }
                else if (ext == 'rpm') { inst = 'sudo -n rpm -Uvh --force /tmp/' + a; }
                else if (ext == 'apk') { inst = 'sudo -n apk add --allow-untrusted /tmp/' + a; }
                cmd = "curl -kfsSL -o /tmp/" + a + " '{{url}}' && echo '{{sha384}}  /tmp/" + a + "' | sha384sum -c - && " + inst;
                Q('pkgfType').value = '3';
            } else if (os == 'windows') {
                var inst = '"%TEMP%\\' + a + '" /S';
                if (ext == 'msi') { inst = 'msiexec /i "%TEMP%\\' + a + '" /qn'; }
                cmd = 'curl -kfsSL -o "%TEMP%\\' + a + '" "{{url}}" && certutil -hashfile "%TEMP%\\' + a + '" SHA384 | findstr /i "{{sha384}}" && ' + inst;
                Q('pkgfType').value = '1';
            } else {
                var inst = 'sh /tmp/' + a;
                if (ext == 'pkg') { inst = 'sudo -n installer -pkg /tmp/' + a + ' -target /'; }
                else if (ext == 'app') { inst = 'cp -R /tmp/' + a + ' /Applications/'; }
                cmd = "curl -kfsSL -o /tmp/" + a + " '{{url}}' && echo '{{sha384}}  /tmp/" + a + "' | shasum -a 384 -c - && " + inst;
                Q('pkgfType').value = '3';
            }
            Q('pkgfCmd').value = cmd;
            pluginHandler.pkgmanager.pkgCreateDraftSync();
            pluginHandler.pkgmanager.pkgAdminDraftSync();
            if (window.pkgmanagerView == 'admin') { pluginHandler.pkgmanager.pkgAdminOsHint(); } else { pluginHandler.pkgmanager.pkgCreateOsHint(); }
            pluginHandler.pkgmanager.pkgAdminStatus('Preset ' + os + ' generato' + ((art == '') ? ' (nome artefatto vuoto: usato "pacchetto" — compila il campo e rigenera per il nome giusto)' : ' (' + EscapeHtml(art) + ')') + '. Controlla il comando prima di salvare.');
        } catch (e) { pluginHandler.pkgmanager.pkgAdminStatus('Preset fallito: ' + e); }
    };

    // Insert {{url}} / {{sha384}} at the textarea cursor (not appended).
    obj.pkgCreateInsert = function (which) {
        try {
            var t = Q('pkgfCmd');
            var ph = (which == 'url') ? '{{url}}' : '{{sha384}}';
            var st = t.selectionStart; if (st == null) { st = t.value.length; }
            var en = t.selectionEnd; if (en == null) { en = st; }
            t.value = t.value.slice(0, st) + ph + t.value.slice(en);
            t.focus();
            t.selectionStart = (t.selectionEnd = (st + ph.length));
            pluginHandler.pkgmanager.pkgCreateDraftSync();
            pluginHandler.pkgmanager.pkgAdminDraftSync();
        } catch (e) { }
    };

    // Live ID check: pattern + duplicates against the current catalog.
    obj.pkgCreateCheckId = function () {
        try {
            var h = document.getElementById('pkgfIdHint');
            if (h == null) return;
            var pid = Q('pkgfId').value.trim();
            if (pid == '') { h.innerText = ''; return; }
            if (!/^[a-zA-Z0-9._-]+$/.test(pid)) { h.innerText = 'ID non valido (lettere, numeri, . _ -)'; h.style.color = '#a60'; return; }
            var cat = window.pkgmanagerCatalog;
            var dup = false;
            for (var i = 0; i < ((cat != null) ? cat.packages.length : 0); i++) { if (cat.packages[i].id == pid) { dup = true; break; } }
            if (dup) { h.innerText = 'ID già esistente — salvando lo AGGIORNERAI (per modifiche usa «Gestione pacchetti»)'; h.style.color = '#a60'; }
            else if (cat == null) { h.innerText = 'Verifica catalogo… (in arrivo)'; h.style.color = '#888'; }
            else { h.innerText = 'ID libero ✓'; h.style.color = '#080'; }
            pluginHandler.pkgmanager.pkgCreateOsHint();
        } catch (e) { }
    };

    // Catalog reply while the wizard is open: update ONLY acks and hints —
    // never re-render the form (a half-filled form must not be wiped).
    obj.pkgCreateCatalogArrived = function () {
        try {
            if ((window.pkgmanagerAdminMsg != null) && (window.pkgmanagerAdminMsg != '')) {
                var st = document.getElementById('pkgadminStatus');
                if (st != null) { st.innerText = window.pkgmanagerAdminMsg; st.style.color = '#080'; }
                window.pkgmanagerAdminMsg = '';
            }
            pluginHandler.pkgmanager.pkgCreateCheckId();
            pluginHandler.pkgmanager.pkgCreateOsHint();
        } catch (e) { }
    };

    obj.pkgAdminRender = function () {
        try {
            var m = document.getElementById('pkgmanagerMain');
            if (m == null) return;
            var cat = window.pkgmanagerCatalog;
            if ((cat == null) || (cat.packages == null)) { m.innerHTML = '<div style="color:#888">Caricamento catalogo…</div>'; return; }
            var x = '<div style="margin-bottom:8px;font-size:16px"><b>Gestione pacchetti</b> — catalogo e artefatti airgap</div>';
            x += '<div style="margin-bottom:8px"><input type=button value="Aggiungi pacchetto" onclick="pluginHandler.pkgmanager.pkgAdminAdd()"> <input type=button value="Ricarica catalogo" onclick="pluginHandler.pkgmanager.pkgAdminRefresh()"></div>';
            if ((window.pkgmanagerAdminMsg != null) && (window.pkgmanagerAdminMsg != '')) { x += '<div style="margin-bottom:8px;color:#080">' + EscapeHtml(window.pkgmanagerAdminMsg) + '</div>'; }
            x += '<table style="border-collapse:collapse;width:100%">';
            x += '<tr style="text-align:left;border-bottom:1px solid #ccc"><th style="padding:4px">Pacchetto</th><th style="padding:4px">Definizioni OS / artefatto</th><th style="padding:4px">Azioni</th></tr>';
            var oses = ['linux', 'windows', 'macos'];
            for (var i = 0; i < cat.packages.length; i++) {
                var p = cat.packages[i];
                var defs = '';
                for (var k = 0; k < oses.length; k++) {
                    var def = p[oses[k]];
                    if (def == null) continue;
                    var art = '—';
                    if (def.artifact != null) {
                        art = ((def.artifactMissing === true)
                            ? '<span style="color:#a60">artefatto mancante: ' + EscapeHtml(def.artifact) + '</span>'
                            : '<span style="color:#080">artefatto ✓ ' + EscapeHtml(def.artifact) + '</span>');
                    }
                    defs += '<div style="padding:2px 0"><b>' + oses[k] + '</b>: tipo ' + EscapeHtml(String(def.type)) + ', ' + art + '</div>';
                }
                if (defs == '') { defs = '<i>nessuna definizione</i>'; }
                x += '<tr style="border-bottom:1px solid #eee;vertical-align:top"><td style="padding:4px"><b>' + EscapeHtml(p.name) + '</b><br><span style="color:#888">' + EscapeHtml(p.id) + '</span></td><td style="padding:4px">' + defs + '</td><td style="padding:4px"><input type=button value="Modifica" onclick="pluginHandler.pkgmanager.pkgAdminEdit(\'' + EscapeHtml(p.id) + '\')"> <input type=button value="Elimina" onclick="pluginHandler.pkgmanager.pkgAdminDelete(\'' + EscapeHtml(p.id) + '\')"></td></tr>';
            }
            x += '</table>';
            x += '<div style="margin-top:8px;color:#888">Artefatti: cartella server plugins/pkgmanager/store/&lt;pacchetto&gt;/&lt;file&gt;. "Carica artefatto" li inserisce da questa pagina (serve amministratore del server).</div>';
            m.innerHTML = x;
        } catch (e) { console.log('pkgmanager admin render failed: ' + e); }
    };

    obj.pkgAdminAdd = function () { pluginHandler.pkgmanager.pkgAdminForm(null); };

    obj.pkgAdminEdit = function (pkgid) {
        try {
            var pkg = null;
            var cat = window.pkgmanagerCatalog;
            for (var i = 0; i < ((cat != null) ? cat.packages.length : 0); i++) { if (cat.packages[i].id == pkgid) { pkg = cat.packages[i]; break; } }
            pluginHandler.pkgmanager.pkgAdminForm(pkg);
        } catch (e) { console.log('pkgmanager admin edit failed: ' + e); }
    };

    // ---- v0.9.1 management single-form state (same pattern as the builder,
    // SEPARATE draft so the wizard flow can never pollute it and vice versa) ----
    obj.pkgAdminCurOs = function () { try { return String(Q('pkgfOs').value || 'linux'); } catch (e) { return 'linux'; } };
    obj.pkgAdminFieldSync = function (os) {
        try {
            if (window.pkgmanagerAdminDraft == null) { window.pkgmanagerAdminDraft = {}; }
            window.pkgmanagerAdminDraft[os] = { art: Q('pkgfArt').value.trim(), type: String(Q('pkgfType').value), to: Q('pkgfTo').value.trim(), cmd: Q('pkgfCmd').value };
        } catch (e) { }
    };
    // Sync the CURRENT-OS fields into the management draft. Management-only:
    // a no-op outside the admin view (the builder draft stays untouched).
    obj.pkgAdminDraftSync = function () {
        try {
            if (window.pkgmanagerView !== 'admin') return;
            pluginHandler.pkgmanager.pkgAdminFieldSync(pluginHandler.pkgmanager.pkgAdminCurOs());
        } catch (e) { }
    };
    obj.pkgAdminOsChange = function () {
        try {
            var prev = window.pkgmanagerAdminDraftOs || 'linux';
            pluginHandler.pkgmanager.pkgAdminFieldSync(prev);
            var os = pluginHandler.pkgmanager.pkgAdminCurOs();
            var d = ((window.pkgmanagerAdminDraft != null) ? window.pkgmanagerAdminDraft[os] : null);
            Q('pkgfArt').value = ((d != null) ? (d.art || '') : '');
            Q('pkgfType').value = ((d != null) && (d.type != null)) ? d.type : pluginHandler.pkgmanager.pkgCreateDefaultType(os);
            Q('pkgfTo').value = ((d != null) && (d.to != null)) ? d.to : '300';
            Q('pkgfCmd').value = ((d != null) && (d.cmd != null)) ? d.cmd : '';
            window.pkgmanagerAdminDraftOs = os;
            pluginHandler.pkgmanager.pkgAdminOsHint();
        } catch (e) { }
    };
    obj.pkgAdminOsHint = function () {
        try {
            var h = document.getElementById('pkgfOsHint');
            if (h == null) return;
            var pid = Q('pkgfId').value.trim();
            var saved = {};
            var cat = window.pkgmanagerCatalog;
            for (var i = 0; i < ((cat != null) ? cat.packages.length : 0); i++) { if (cat.packages[i].id == pid) { var p = cat.packages[i]; if (p.linux != null) { saved.linux = p.linux; } if (p.windows != null) { saved.windows = p.windows; } if (p.macos != null) { saved.macos = p.macos; } break; } }
            var parts = [];
            var oses = [['linux', 'Linux'], ['windows', 'Windows'], ['macos', 'macOS']];
            for (var k = 0; k < oses.length; k++) {
                var os = oses[k][0];
                var d = ((window.pkgmanagerAdminDraft != null) ? window.pkgmanagerAdminDraft[os] : null);
                if ((d != null) && (d.cmd != null) && (d.cmd != '')) {
                    // A draft that still MATCHES the saved def (just loaded into
                    // the form for editing) is 'salvato'; only real edits are 'bozza'.
                    var sd = saved[os];
                    var same = (sd != null) && (String(d.cmd) == String(sd.cmd || '')) && (String(d.art || '') == String(sd.artifact || '')) && (String(d.type) == String(sd.type)) && (String(parseInt(d.to) || '') == String(sd.timeout || ''));
                    parts.push(oses[k][1] + (same ? ': salvato' : ': bozza'));
                }
                else if (saved[os] != null) { parts.push(oses[k][1] + ': salvato'); }
            }
            h.innerText = parts.length ? ('Definizioni: ' + parts.join(' · ')) : '';
        } catch (e) { }
    };

    obj.pkgAdminForm = function (pkg) {
        try {
            var m = document.getElementById('pkgmanagerMain');
            if (m == null) return;
            var isNew = (pkg == null);
            var x = '<div style="margin-bottom:8px;font-size:16px"><b>' + (isNew ? 'Aggiungi pacchetto' : 'Modifica pacchetto') + '</b></div>';
            x += '<table style="border-collapse:collapse">';
            x += '<tr><td style="padding:4px">ID</td><td style="padding:4px"><input type=text id=pkgfId style=width:280px value="' + EscapeHtml(isNew ? '' : pkg.id) + '"' + (isNew ? '' : ' readonly') + '></td></tr>';
            x += '<tr><td style="padding:4px">Nome</td><td style="padding:4px"><input type=text id=pkgfName style=width:280px value="' + EscapeHtml(isNew ? '' : (pkg.name || '')) + '"></td></tr>';
            x += '<tr><td style="padding:4px">Descrizione</td><td style="padding:4px"><input type=text id=pkgfDesc style=width:420px value="' + EscapeHtml(isNew ? '' : (pkg.description || '')) + '"></td></tr>';
            x += '</table>';
            // v0.9.1 single form: per-OS drafts seeded from the package, the OS
            // dropdown swaps the fields (same pattern as the builder).
            var draft = {};
            var oses = [['linux', 'Linux'], ['windows', 'Windows'], ['macos', 'macOS']];
            var osCur = '';
            for (var k = 0; k < oses.length; k++) {
                var os = oses[k][0];
                var def = ((pkg != null) ? pkg[os] : null);
                if (def != null) {
                    draft[os] = { art: ((def.artifact != null) ? String(def.artifact) : ''), type: String(def.type), to: ((def.timeout != null) ? String(def.timeout) : '300'), cmd: String(def.cmd || '') };
                    if (osCur == '') { osCur = os; }
                }
            }
            if (osCur == '') { osCur = 'linux'; }
            window.pkgmanagerAdminDraft = draft;
            window.pkgmanagerAdminDraftOs = osCur;
            var d0 = draft[osCur];
            x += '<tr><td style="padding:4px">Sistema operativo</td><td style="padding:4px"><select id=pkgfOs onchange="pluginHandler.pkgmanager.pkgAdminOsChange()">';
            for (var k2 = 0; k2 < oses.length; k2++) { x += '<option value="' + oses[k2][0] + '"' + ((oses[k2][0] == osCur) ? ' selected' : '') + '>' + oses[k2][1] + '</option>'; }
            x += '</select> <span id=pkgfOsHint style="color:#888"></span></td></tr>';
            x += '<tr><td style="padding:4px">Artefatto (file nello store)</td><td style="padding:4px"><input type=text id=pkgfArt style=width:280px oninput="pluginHandler.pkgmanager.pkgAdminDraftSync()" value="' + EscapeHtml(((d0 != null) ? (d0.art || '') : '')) + '"> <input type=button value="Carica artefatto…" onclick="pluginHandler.pkgmanager.pkgAdminUpload()"> <input type=button value="Elimina artefatto" onclick="pluginHandler.pkgmanager.pkgAdminArtifactDel()"></td></tr>';
            x += '<tr><td style="padding:4px">Tipo comando</td><td style="padding:4px"><select id=pkgfType onchange="pluginHandler.pkgmanager.pkgAdminDraftSync()"><option value=3' + (((d0 == null) || (d0.type == '3')) ? ' selected' : '') + '>Shell (Linux/macOS)</option><option value=1' + (((d0 != null) && (d0.type == '1')) ? ' selected' : '') + '>cmd.exe (Windows)</option><option value=2' + (((d0 != null) && (d0.type == '2')) ? ' selected' : '') + '>PowerShell (Windows)</option></select> · Timeout (s): <input type=text id=pkgfTo style=width:70px value="' + EscapeHtml(((d0 != null) && (d0.to != null)) ? d0.to : '300') + '" oninput="pluginHandler.pkgmanager.pkgAdminDraftSync()"></td></tr>';
            x += '</table>';
            x += '<div style="padding:4px 0">Comando: <input type=button value="Preset airgap" onclick="pluginHandler.pkgmanager.pkgCreatePreset()"> <input type=button value="Inserisci {{url}}" onclick="pluginHandler.pkgmanager.pkgCreateInsert(\'url\')"> <input type=button value="Inserisci {{sha384}}" onclick="pluginHandler.pkgmanager.pkgCreateInsert(\'sha384\')"></div>';
            x += '<textarea id=pkgfCmd style="width:640px;height:80px;font-family:monospace" oninput="pluginHandler.pkgmanager.pkgAdminDraftSync()">' + EscapeHtml(((d0 != null) ? (d0.cmd || '') : '')) + '</textarea></div>';
            x += '<div style="margin-top:10px"><input type=button value="Salva" onclick="pluginHandler.pkgmanager.pkgAdminSave(' + (isNew ? 'true' : 'false') + ')"> <input type=button value="Annulla" onclick="pluginHandler.pkgmanager.pkgAdminRender()"> <input type=file id="pkgfFile" style="display:none"></div>';
            x += '<div id="pkgadminStatus" style="margin-top:6px;color:#888"></div>';
            m.innerHTML = x;
            pluginHandler.pkgmanager.pkgAdminOsHint();
        } catch (e) { console.log('pkgmanager admin form failed: ' + e); }
    };

    obj.pkgAdminStatus = function (t) {
        try {
            var s = document.getElementById('pkgadminStatus');
            if (s != null) { s.innerText = t; }
            console.log('pkgmanager: ' + t);
        } catch (e) { }
    };

    obj.pkgAdminUpload = function (os) {
        try {
            if (os == null) { os = pluginHandler.pkgmanager.pkgAdminCurOs(); } // v0.9.1 single-form management
            var f = document.getElementById('pkgfFile');
            if (f == null) return;
            f.value = '';
            f.onchange = function () { pluginHandler.pkgmanager.pkgAdminUploadDo(os); };
            f.click();
        } catch (e) { }
    };

    // Upload the picked file to the SERVER STORE over /pkgstore.ashx POST
    // (session-authenticated; server gates full site admins).
    obj.pkgAdminUploadDo = function (os) {
        try {
            var f = document.getElementById('pkgfFile');
            if ((f.files == null) || (f.files.length == 0)) return;
            var pid = Q('pkgfId').value.trim();
            var artInput = document.getElementById('pkgfArt_' + os);
            if (artInput == null) { artInput = document.getElementById('pkgfArt'); } // v0.9.0 single-form wizard
            if (artInput == null) { pluginHandler.pkgmanager.pkgAdminStatus('Campo artefatto mancante.'); return; }
            var art = artInput.value.trim();
            if (art == '') { art = f.files[0].name; artInput.value = art; }
            if (!/^[a-zA-Z0-9._-]+$/.test(pid) || !/^[a-zA-Z0-9._ -]+$/.test(art)) { pluginHandler.pkgmanager.pkgAdminStatus('ID o nome artefatto non validi.'); return; }
            var fname = f.files[0].name;
            f.files[0].arrayBuffer().then(function (buf) {
                fetch('/pkgstore.ashx?op=upload&p=' + encodeURIComponent(pid + '/' + art), { method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream' } })
                    .then(function (r) { return r.json(); })
                    .then(function (j) {
                        if (j.ok) { pluginHandler.pkgmanager.pkgCreateDraftSync(); pluginHandler.pkgmanager.pkgAdminDraftSync(); pluginHandler.pkgmanager.pkgAdminStatus('Artefatto caricato: ' + art + ' (' + j.size + ' byte, sha384 ' + String(j.sha384).slice(0, 12) + '…). Salva per aggiornare il catalogo.'); }
                        else { pluginHandler.pkgmanager.pkgAdminStatus('Upload negato: ' + EscapeHtml(String(j.error || '')) + ' (serve amministratore del server).'); }
                    })
                    .catch(function (e2) { pluginHandler.pkgmanager.pkgAdminStatus('Upload fallito: ' + e2); });
            });
        } catch (e) { pluginHandler.pkgmanager.pkgAdminStatus('Upload fallito: ' + e); }
    };

    obj.pkgAdminArtifactDel = function (os) {
        try {
            if (os == null) { os = pluginHandler.pkgmanager.pkgAdminCurOs(); } // v0.9.1 single-form management
            var pid = Q('pkgfId').value.trim();
            var artInput = document.getElementById('pkgfArt_' + os);
            if (artInput == null) { artInput = document.getElementById('pkgfArt'); } // v0.9.0 single-form wizard
            if (artInput == null) { pluginHandler.pkgmanager.pkgAdminStatus('Campo artefatto mancante.'); return; }
            var art = artInput.value.trim();
            if (!/^[a-zA-Z0-9._-]+$/.test(pid) || !/^[a-zA-Z0-9._ -]+$/.test(art) || (art == '')) { pluginHandler.pkgmanager.pkgAdminStatus('ID o nome artefatto non validi.'); return; }
            fetch('/pkgstore.ashx?op=del&p=' + encodeURIComponent(pid + '/' + art), { method: 'POST' })
                .then(function (r) { return r.json(); })
                .then(function (j) {
                    if (j.ok) { artInput.value = ''; pluginHandler.pkgmanager.pkgCreateDraftSync(); pluginHandler.pkgmanager.pkgAdminDraftSync(); }
                    pluginHandler.pkgmanager.pkgAdminStatus(j.ok ? 'Artefatto eliminato dallo store: ' + art : 'Eliminazione fallita: ' + EscapeHtml(String(j.error || '')));
                })
                .catch(function (e2) { pluginHandler.pkgmanager.pkgAdminStatus('Eliminazione fallita: ' + e2); });
        } catch (e) { }
    };

    obj.pkgAdminSave = function (isNew) {
        try {
            var pid = Q('pkgfId').value.trim();
            if (!/^[a-zA-Z0-9._-]+$/.test(pid)) { pluginHandler.pkgmanager.pkgAdminStatus('ID non valido (lettere, numeri, . _ -).'); return; }
            var name = Q('pkgfName').value.trim();
            if (name == '') { pluginHandler.pkgmanager.pkgAdminStatus('Nome mancante.'); return; }
            // v0.9.1 single form: current fields + per-OS drafts, MERGED with
            // the defs already saved for this ID (an untouched saved OS must
            // survive the server-side replace-on-id save).
            pluginHandler.pkgmanager.pkgAdminFieldSync(pluginHandler.pkgmanager.pkgAdminCurOs());
            var pkg = { id: pid, name: name, description: Q('pkgfDesc').value };
            for (var k in window.pkgmanagerAdminDraft) {
                var d = window.pkgmanagerAdminDraft[k];
                if ((k == 'linux') || (k == 'windows') || (k == 'macos')) {
                    if ((d != null) && (d.cmd != null) && (d.cmd.trim() != '')) {
                        var def = { type: (parseInt(d.type) || pluginHandler.pkgmanager.pkgCreateDefaultType(k)), cmd: d.cmd.trim() };
                        var to = parseInt(d.to); if (to > 0) { def.timeout = to; }
                        if ((d.art != null) && (d.art.trim() != '')) { def.artifact = d.art.trim(); }
                        pkg[k] = def;
                    }
                }
            }
            var cat = window.pkgmanagerCatalog;
            for (var i = 0; i < ((cat != null) ? cat.packages.length : 0); i++) {
                if (cat.packages[i].id == pid) {
                    var oses2 = ['linux', 'windows', 'macos'];
                    for (var j = 0; j < oses2.length; j++) {
                        var o2 = oses2[j];
                        if ((pkg[o2] == null) && (cat.packages[i][o2] != null)) { pkg[o2] = cat.packages[i][o2]; }
                    }
                    break;
                }
            }
            if ((pkg.linux == null) && (pkg.windows == null) && (pkg.macos == null)) { pluginHandler.pkgmanager.pkgAdminStatus('Compila il comando per il sistema operativo selezionato prima di salvare.'); return; }
            meshserver.send({ action: 'plugin', plugin: 'pkgmanager', pluginaction: 'save', pkg: pkg });
            pluginHandler.pkgmanager.pkgAdminStatus('Salvataggio…');
            pluginHandler.pkgmanager.pkgAdminOsHint();
        } catch (e) { pluginHandler.pkgmanager.pkgAdminStatus('Errore: ' + e); }
    };

    obj.pkgAdminDelete = function (pkgid) {
        try {
            if (!confirm('Eliminare il pacchetto "' + pkgid + '" dal catalogo? Verranno rimossi anche i suoi artefatti dallo store del server.')) return;
            meshserver.send({ action: 'plugin', plugin: 'pkgmanager', pluginaction: 'delete', id: pkgid });
        } catch (e) { }
    };

    // ---- Install page: packages left, target machines right ----
    obj.pkgSidebarRenderDevices = function () {
        try {
            var m = document.getElementById('pkgmanagerMain');
            if (m == null) return;
            var devlist = [];
            try { for (var i in nodes) { if (nodes[i] && nodes[i]._id) devlist.push(nodes[i]); } } catch (e) { }
            var x = '<div style="margin-bottom:8px;font-size:16px"><b>Installa sui dispositivi</b></div>';
            x += '<div id="pkgmanagerSelSummary" style="margin-bottom:8px;color:#888"></div>';
            x += '<div style="display:flex;gap:16px;align-items:flex-start">';
            x += '<div style="flex:1 1 60%;min-width:0"><div style="margin-bottom:4px"><b>Pacchetti</b> <span id="pkgmanagerFilterNote" style="color:#888;font-weight:normal"></span></div><div id="pkgmanagerTableWrap"></div></div>';
            x += '<div style="flex:0 0 320px;border-left:1px solid #ddd;padding-left:12px">';
            x += '<div style="margin-bottom:4px"><b>Macchine di destinazione</b> — <span style="font-size:12px"><a href=# onclick="pluginHandler.pkgmanager.pkgDevSelectAll(true);return false">tutte</a> / <a href=# onclick="pluginHandler.pkgmanager.pkgDevSelectAll(false);return false">nessuna</a></span></div>';
            x += '<div id="pkgmanagerDeviceList" style="max-height:420px;overflow-y:auto">';
            if (devlist.length == 0) { x += '<div style="color:#888;padding:4px">Nessun dispositivo</div>'; }
            for (var i = 0; i < devlist.length; i++) {
                var n = devlist[i];
                var on = ((n.conn & 1) != 0);
                var os = pluginHandler.pkgmanager.pkgTargetOs(n);
                x += '<label style="display:block;padding:4px 2px;border-bottom:1px solid #eee;' + (on ? 'cursor:pointer' : 'color:#999;cursor:not-allowed') + '">';
                x += '<input type=checkbox class="pkgmanagerDevCb" value="' + EscapeHtml(n._id) + '"' + (on ? '' : ' disabled') + ' onchange="pluginHandler.pkgmanager.pkgDevToggle()"> ';
                x += '<b>' + EscapeHtml(n.name) + '</b> <span style="color:#888">· ' + os + (on ? ' · online' : ' · offline') + '</span></label>';
            }
            x += '</div><div style="margin-top:6px;color:#888;font-size:12px">Le macchine offline non sono selezionabili.</div>';
            x += '</div></div>';
            x += '<div id="pkgmanagerMsg" style="margin-top:10px;color:#888"></div>';
            m.innerHTML = x;
            pluginHandler.pkgmanager.pkgSidebarRender();
        } catch (e) { console.log('pkgmanager device render failed: ' + e); }
    };

    obj.pkgDevToggle = function () { pluginHandler.pkgmanager.pkgSidebarRender(); };

    obj.pkgDevSelectAll = function (v) {
        try { var cbs = document.querySelectorAll('.pkgmanagerDevCb'); for (var i = 0; i < cbs.length; i++) { if (!cbs[i].disabled) cbs[i].checked = v; } } catch (e) { }
        pluginHandler.pkgmanager.pkgSidebarRender();
    };

    obj.pkgSelectedNodes = function () {
        var out = [];
        try {
            var cbs = document.querySelectorAll('.pkgmanagerDevCb');
            for (var i = 0; i < cbs.length; i++) {
                if (!cbs[i].checked) continue;
                for (var j in nodes) { if (nodes[j] && (nodes[j]._id == cbs[i].value)) { out.push(nodes[j]); break; } }
            }
        } catch (e) { }
        return out;
    };

    // Re-render ONLY the package table (the checkbox panel keeps its state):
    // a package is visible only if it has an install def for every OS selected.
    obj.pkgSidebarRender = function () {
        try {
            var w = document.getElementById('pkgmanagerTableWrap');
            if (w == null) return;
            var cat = window.pkgmanagerCatalog;
            if ((cat == null) || (cat.packages == null)) { w.innerHTML = '<div style="color:#888">Caricamento catalogo…</div>'; return; }
            var sel = pluginHandler.pkgmanager.pkgSelectedNodes();
            var oses = {}; for (var i = 0; i < sel.length; i++) { oses[pluginHandler.pkgmanager.pkgTargetOs(sel[i])] = 1; }
            var osList = Object.keys(oses);
            var shown = [];
            for (var i = 0; i < cat.packages.length; i++) {
                var p = cat.packages[i]; var okp = true;
                for (var k = 0; k < osList.length; k++) { if (p[osList[k]] == null) { okp = false; break; } }
                if (okp) { shown.push(p); }
            }
            var note = document.getElementById('pkgmanagerFilterNote');
            if (note != null) { note.innerText = (osList.length ? ('(' + shown.length + ' di ' + cat.packages.length + ' mostrati — OS di destinazione: ' + osList.join(', ') + ')') : '(' + cat.packages.length + ' di ' + cat.packages.length + ' — seleziona le macchine per filtrare per OS)'); }
            var sum = document.getElementById('pkgmanagerSelSummary');
            if (sum != null) { sum.innerText = (sel.length ? (sel.length + ' macchina/e selezionata/e — Install gira su TUTTE, raggruppate per OS.') : 'Seleziona le macchine di destinazione a destra; l\'elenco dei pacchetti si filtra per i loro OS.'); }
            w.innerHTML = pluginHandler.pkgmanager.pkgTableHtml(shown, 'sidebar', osList);
        } catch (e) { console.log('pkgmanager sidebar table failed: ' + e); }
    };

    // meshserver.send() is a silent no-op until the user WS is connected (connectstate==1):
    // retry the catalog request until the socket is ready instead of firing it into the void.
    obj.pkgRequestList = function () {
        try {
            if ((typeof meshserver == 'undefined') || (meshserver == null) || (meshserver.connectstate != 1)) {
                console.log('pkgmanager: WS not ready (' + ((meshserver != null) ? meshserver.connectstate : 'null') + '), retry in 1s');
                setTimeout(function () { pluginHandler.pkgmanager.pkgRequestList(); }, 1000);
                return;
            }
            console.log('pkgmanager: requesting catalog');
            meshserver.send({ action: 'plugin', plugin: 'pkgmanager', pluginaction: 'list' });
        } catch (e) { console.log('pkgmanager request failed: ' + e); }
    };

    obj.pkgTargetOs = function (n) {
        var t = '';
        try { t = String(((n != null) && (n.os_title != null)) ? n.os_title : (((n != null) && (n.os != null)) ? n.os : '')); } catch (e) { }
        if (/win/i.test(t)) { return 'windows'; }
        if (/mac os x|darwin/i.test(t)) { return 'macos'; }
        return 'linux';
    };

    // The template dispatcher calls pluginHandler[plugin][method](server, message):
    // first argument is the server object, the payload lives in message.
    obj.pkgList = function (server, message) {
        console.log('pkgmanager: pkgList called');
        try {
            window.pkgmanagerCatalog = message.catalog;
            window.pkgmanagerToken = message.token;
            if (message.opAck != null) { window.pkgmanagerAdminMsg = message.opAck; }
            pluginHandler.pkgmanager.pkgTabSetActive(window.pkgmanagerView);
            var cat = window.pkgmanagerCatalog;
            var d = document.getElementById('pkgmanagerTab');
            if (d != null) {
                if ((cat == null) || (cat.packages == null)) {
                    d.innerHTML = '<div style="padding:12px;color:#888">Catalogo non disponibile.</div>';
                } else {
                    var x = '<div style="padding:12px;font-family:Arial,Helvetica,sans-serif">';
                    x += '<div style="margin-bottom:8px">Installa un pacchetto su <b>questo dispositivo</b> (canale comandi remoti standard, permessi verificati).</div>';
                    x += pluginHandler.pkgmanager.pkgTableHtml(cat.packages, 'tab');
                    x += '<div id="pkgmanagerMsgTab" style="margin-top:10px;color:#888"></div></div>';
                    d.innerHTML = x;
                }
            }
            if (window.pkgmanagerView == 'admin') { pluginHandler.pkgmanager.pkgAdminRender(); }
            else if (window.pkgmanagerView == 'create') { pluginHandler.pkgmanager.pkgCreateCatalogArrived(); }
            else { pluginHandler.pkgmanager.pkgSidebarRender(); }
        } catch (e) { console.log('pkgmanager render failed: ' + e); }
    };

    // Server-side rejection of management ops from non-admins.
    obj.pkgDenied = function (server, message) {
        try {
            window.pkgmanagerAdminMsg = ((message != null) && (message.msg != null)) ? message.msg : 'Operazione negata.';
            if (window.pkgmanagerView == 'admin') { pluginHandler.pkgmanager.pkgAdminRender(); }
            else if (window.pkgmanagerView == 'create') { pluginHandler.pkgmanager.pkgCreateCatalogArrived(); }
            else { pluginHandler.pkgmanager.pkgMsg(window.pkgmanagerAdminMsg); }
            console.log('pkgmanager: negato: ' + window.pkgmanagerAdminMsg);
        } catch (e) { }
    };

    // Compose the device-side install command for a package def. Airgap: when the
    // def carries an artifact, substitute {{url}} (LAN download URL from THIS
    // server, token included) and {{sha384}} (server-computed artifact hash).
    // Returns null if the artifact is missing in the server store.
    obj.pkgCompose = function (pkg, def) {
        try {
            if (def == null) { return null; }
            if (def.artifact != null) {
                if ((def.artifactMissing === true) || (def.sha384 == null) || (window.pkgmanagerToken == null)) { return null; }
                var url = location.origin + '/pkgstore.ashx?t=' + encodeURIComponent(window.pkgmanagerToken) + '&p=' + encodeURIComponent(pkg.id + '/' + def.artifact);
                return String(def.cmd).split('{{url}}').join(url).split('{{sha384}}').join(def.sha384);
            }
            return String(def.cmd);
        } catch (e) { return null; }
    };

    obj.pkgTableHtml = function (pkgs, mode, osList) {
        try {
            var click = ((mode == 'sidebar') ? 'pluginHandler.pkgmanager.pkgSidebarInstall' : 'pluginHandler.pkgmanager.pkgInstall');
            var x = '<table style="border-collapse:collapse;width:100%">';
            x += '<tr style="text-align:left;border-bottom:1px solid #ccc"><th style="padding:4px">Pacchetto</th><th style="padding:4px">OS</th><th style="padding:4px">Descrizione</th><th style="padding:4px"></th></tr>';
            for (var i = 0; i < ((pkgs != null) ? pkgs.length : 0); i++) {
                var p = pkgs[i];
                var osl = [];
                if (p.linux != null) { osl.push('Linux'); }
                if (p.windows != null) { osl.push('Windows'); }
                if (p.macos != null) { osl.push('macOS'); }
                // Airgap: a def that needs a store artifact missing on the server
                // gets its Install button disabled (drop the file on the server).
                var missing = false;
                if (mode == 'sidebar') {
                    for (var k = 0; k < ((osList != null) ? osList.length : 0); k++) {
                        var def = p[osList[k]];
                        if ((def != null) && (def.artifact != null) && ((def.artifactMissing === true) || (def.sha384 == null))) { missing = true; break; }
                    }
                }
                var btn = (missing
                    ? '<input type=button value="Install" disabled title="Artefatto mancante nello store del server (plugins/pkgmanager/store/' + EscapeHtml(p.id) + ')" style="opacity:0.5">'
                    : '<input type=button value="Install" onclick="' + click + '(\'' + EscapeHtml(p.id) + '\')">');
                x += '<tr style="border-bottom:1px solid #eee"><td style="padding:4px"><b>' + EscapeHtml(p.name) + '</b></td><td style="padding:4px">' + EscapeHtml(osl.join(', ')) + '</td><td style="padding:4px">' + EscapeHtml(p.description || '') + '</td><td style="padding:4px">' + btn + '</td></tr>';
            }
            x += '</table>';
            return x;
        } catch (e) { return '<div style="color:red">render error</div>'; }
    };

    // MULTI-TARGET install: run the package on ALL selected machines in ONE
    // pending/results dialog. Group the targets by OS, open a single d2runBegin
    // tracking every nodeid, then send one rights-checked runcommands per OS
    // group reusing that responseid. Airgap: each group command is composed from
    // the group OS def ({{url}} LAN artifact URL + {{sha384}} verification).
    obj.pkgSidebarInstall = function (pkgid) {
        try {
            var cat = window.pkgmanagerCatalog;
            if ((cat == null) || (cat.packages == null)) { pluginHandler.pkgmanager.pkgMsg('Catalogo non caricato.'); return; }
            var pkg = null;
            for (var i = 0; i < cat.packages.length; i++) { if (cat.packages[i].id == pkgid) { pkg = cat.packages[i]; break; } }
            if (pkg == null) { pluginHandler.pkgmanager.pkgMsg('Pacchetto sconosciuto.'); return; }
            var sel = pluginHandler.pkgmanager.pkgSelectedNodes();
            if (sel.length == 0) { pluginHandler.pkgmanager.pkgMsg('Seleziona almeno una macchina di destinazione a destra.'); return; }
            var groups = {}, allids = [];
            for (var i = 0; i < sel.length; i++) {
                var n = sel[i];
                if ((n.conn & 1) == 0) { continue; }
                var os = pluginHandler.pkgmanager.pkgTargetOs(n);
                if (pkg[os] == null) { pluginHandler.pkgmanager.pkgMsg('"' + pkg.name + '" non ha un install per ' + os + ' (' + n.name + ').'); return; }
                if (groups[os] == null) { groups[os] = []; }
                groups[os].push(n._id); allids.push(n._id);
            }
            if (allids.length == 0) { pluginHandler.pkgmanager.pkgMsg('Nessuna macchina connessa selezionata.'); return; }
            var cmds = {};
            for (var os in groups) {
                var cmd = pluginHandler.pkgmanager.pkgCompose(pkg, pkg[os]);
                if (cmd == null) { pluginHandler.pkgmanager.pkgMsg('"' + pkg.name + '" (' + os + '): artefatto mancante nello store — copialo in plugins/pkgmanager/store/' + EscapeHtml(pkg.id) + '/ sul server.'); return; }
                cmds[os] = cmd;
            }
            var responseid = d2runBegin(allids);
            for (var os in groups) {
                meshserver.send({ action: 'runcommands', nodeids: groups[os], type: pkg[os].type, cmds: cmds[os], runAsUser: 0, reply: true, responseid: responseid, timeout: (pkg[os].timeout || 300) });
            }
            pluginHandler.pkgmanager.pkgMsg('Installazione airgap di "' + pkg.name + '" avviata su ' + allids.length + ' macchina/e — artefatto servito da questo server in LAN; output nel dialogo dei risultati.');
        } catch (e) { console.log('pkgmanager sidebar install failed: ' + e); }
    };

    // Compose and run on ONE machine (per-device tab path).
    obj.pkgRunOn = function (n, pkgid) {
        try {
            var cat = window.pkgmanagerCatalog;
            if ((cat == null) || (cat.packages == null)) { pluginHandler.pkgmanager.pkgMsg('Catalogo non caricato.'); return; }
            var pkg = null;
            for (var i = 0; i < cat.packages.length; i++) { if (cat.packages[i].id == pkgid) { pkg = cat.packages[i]; break; } }
            if (pkg == null) { pluginHandler.pkgmanager.pkgMsg('Pacchetto sconosciuto.'); return; }
            if ((n == null) || ((n.conn & 1) == 0)) { pluginHandler.pkgmanager.pkgMsg('Dispositivo di destinazione non connesso.'); return; }
            var os = pluginHandler.pkgmanager.pkgTargetOs(n);
            var def = pkg[os];
            if (def == null) { pluginHandler.pkgmanager.pkgMsg('Nessun install per questo OS (' + os + ').'); return; }
            var cmd = pluginHandler.pkgmanager.pkgCompose(pkg, def);
            if (cmd == null) { pluginHandler.pkgmanager.pkgMsg('"' + pkg.name + '" (' + os + '): artefatto mancante nello store del server.'); return; }
            var responseid = d2runBegin([n._id]);
            meshserver.send({ action: 'runcommands', nodeids: [n._id], type: def.type, cmds: cmd, runAsUser: 0, reply: true, responseid: responseid, timeout: (def.timeout || 300) });
            pluginHandler.pkgmanager.pkgMsg('Installazione airgap di "' + pkg.name + '" avviata su ' + n.name + ' — output nel dialogo dei risultati.');
        } catch (e) { console.log('pkgmanager run failed: ' + e); }
    };

    // Per-device tab (p19 "Plugins") entry: single target, the current device.
    obj.pkgInstall = function (pkgid) {
        pluginHandler.pkgmanager.pkgRunOn((typeof currentNode != 'undefined') ? currentNode : null, pkgid);
    };

    obj.pkgMsg = function (t) {
        try {
            var m = document.getElementById('pkgmanagerMsg');
            if (m != null) { m.innerText = t; }
            var m2 = document.getElementById('pkgmanagerMsgTab');
            if (m2 != null) { m2.innerText = t; }
        } catch (e) { }
    };

    // ---- Server-side ----
    // AIRGAP STORE: artifacts are dropped manually on the server in
    // <datapath>/plugins/pkgmanager/store/<package-id>/<artifact-file> (or
    // uploaded from the management page) and are served to the AGENT over the
    // LAN via /pkgstore.ashx (GET download: per-process token; POST
    // upload/delete: session-authenticated full site admin). Devices download
    // from THIS server only — no internet is ever involved.
    obj.dlToken = crypto.randomBytes(24).toString('hex');
    obj.storePath = parent.path.join(parent.parent.datapath, 'plugins', 'pkgmanager', 'store');
    obj.artifactCache = {}; // "<pkgid>/<file>" -> { sha384, mtime }
    obj.webRef = null;      // webserver module ref (session users), set by the hook
    try { parent.fs.mkdirSync(obj.storePath, { recursive: true }); } catch (e) { }

    // Route registration follows the core pattern (webserver.js setupHTTPHandlers:
    // callHook('hook_setupHttpHandlers', webserverObj, serverObj) -> obj.app).
    obj.hook_setupHttpHandlers = function (webserver, server) {
        try {
            obj.webRef = webserver;
            for (var i in server.config.domains) {
                var d = server.config.domains[i];
                if ((d.dns != null) || (d.share != null)) { continue; }
                webserver.app.get(d.url + 'pkgstore.ashx', function (req, res) { obj.handleStoreGet(req, res); });
                webserver.app.post(d.url + 'pkgstore.ashx', webserver.bodyParser.raw({ type: function () { return true; }, limit: '512mb' }), function (req, res) { obj.handleStorePost(req, res); });
            }
            console.log('pkgmanager[server]: /pkgstore.ashx registered (airgap artifact route: GET download + POST upload/delete)');
        } catch (e) { console.log('pkgmanager[server]: route registration failed: ' + e); }
    };

    // GET: agent/browser download, gated by the per-process token (composed
    // into {{url}}). Same path-safety rules as POST.
    obj.handleStoreGet = function (req, res) {
        try {
            if ((req.query == null) || (req.query.t !== obj.dlToken)) { res.status(403).send('Forbidden'); return; }
            var p = String(req.query.p || '');
            var full = parent.path.join(obj.storePath, p);
            if ((full.indexOf(obj.storePath) !== 0) || (full == obj.storePath) || (p.indexOf('..') >= 0)) { res.status(400).send('Bad path'); return; }
            parent.fs.stat(full, function (err, st) {
                if ((err != null) || (!st.isFile())) { res.status(404).send('Not found'); return; }
                res.setHeader('Content-Length', st.size);
                res.setHeader('Content-Type', 'application/octet-stream');
                parent.fs.createReadStream(full).pipe(res);
            });
        } catch (e) { try { res.status(500).send('Error'); } catch (e2) { } }
    };

    // POST: artifact upload (raw body = file bytes) and artifact delete.
    // Session-authenticated (cookie), FULL SITE ADMIN only.
    obj.handleStorePost = function (req, res) {
        try {
            var wu = ((obj.webRef != null) && (req.session != null) && (req.session.userid != null)) ? obj.webRef.users[req.session.userid] : null;
            if ((wu == null) || (wu.siteadmin !== 0xFFFFFFFF)) { res.status(403).json({ ok: false, error: 'Solo gli amministratori del server possono gestire gli artefatti.' }); return; }
            var p = String(req.query.p || '');
            var op = String(req.query.op || '');
            var full = parent.path.join(obj.storePath, p);
            if ((full.indexOf(obj.storePath) !== 0) || (full == obj.storePath) || (p.indexOf('..') >= 0)) { res.status(400).json({ ok: false, error: 'Percorso non valido.' }); return; }
            if (op == 'del') {
                parent.fs.stat(full, function (err, st) {
                    if ((err != null) || (!st.isFile())) { res.status(404).json({ ok: false, error: 'Artefatto non presente.' }); return; }
                    parent.fs.unlink(full, function (e2) {
                        if (e2 != null) { res.status(500).json({ ok: false, error: String(e2) }); return; }
                        console.log('pkgmanager[server]: artifact deleted: ' + p);
                        res.json({ ok: true });
                    });
                });
                return;
            }
            if (op != 'upload') { res.status(400).json({ ok: false, error: 'Operazione sconosciuta.' }); return; }
            var body = req.body;
            if (!(Buffer.isBuffer(body)) || (body.length == 0)) { res.status(400).json({ ok: false, error: 'Corpo vuoto.' }); return; }
            parent.fs.mkdir(parent.path.dirname(full), { recursive: true }, function (e3) {
                if (e3 != null) { res.status(500).json({ ok: false, error: String(e3) }); return; }
                parent.fs.writeFile(full, body, function (e4) {
                    if (e4 != null) { res.status(500).json({ ok: false, error: String(e4) }); return; }
                    var h = crypto.createHash('sha384').update(body).digest('hex');
                    console.log('pkgmanager[server]: artifact uploaded: ' + p + ' (' + body.length + ' bytes) by ' + wu._id);
                    res.json({ ok: true, sha384: h, size: body.length });
                });
            });
        } catch (e) { try { res.status(500).json({ ok: false, error: String(e) }); } catch (e2) { } }
    };

    // SHA-384 + size of a store artifact (cached by mtime); flags artifactMissing.
    obj.pkgArtifactInfo = function (pkgid, def, callback) {
        var key = pkgid + '/' + def.artifact;
        var full = parent.path.join(obj.storePath, pkgid, def.artifact);
        parent.fs.stat(full, function (err, st) {
            if ((err != null) || (!st.isFile())) { def.artifactMissing = true; delete def.sha384; callback(); return; }
            var c = obj.artifactCache[key];
            if ((c != null) && (c.mtime == st.mtimeMs)) { def.sha384 = c.sha384; def.artifactSize = st.size; def.artifactMissing = false; callback(); return; }
            parent.fs.readFile(full, function (err2, data) {
                if (err2 != null) { def.artifactMissing = true; delete def.sha384; callback(); return; }
                var h = crypto.createHash('sha384').update(data).digest('hex');
                obj.artifactCache[key] = { sha384: h, mtime: st.mtimeMs };
                def.sha384 = h; def.artifactSize = st.size; def.artifactMissing = false;
                callback();
            });
        });
    };

    // Sanitize one per-OS def coming from the management UI.
    obj.sanitizeDef = function (def) {
        if ((def == null) || (typeof def.cmd != 'string') || (def.cmd.trim() == '')) return null;
        var out = { type: ((def.type == 1) || (def.type == 2)) ? def.type : 3, cmd: def.cmd };
        var to = parseInt(def.timeout); if (to > 0) { out.timeout = to; }
        if ((typeof def.artifact == 'string') && (def.artifact.trim() != '') && (/^[a-zA-Z0-9._ -]+$/.test(def.artifact.trim()))) { out.artifact = def.artifact.trim(); }
        return out;
    };

    // Read catalog + enrich defs (artifact presence, sha384) + reply pkgList.
    obj.replyCatalog = function (session, opAck, err) {
        obj.fs.readFile(obj.catalogPath, function (err2, data) {
            var cat = null;
            try { cat = JSON.parse(data); } catch (e) { }
            console.log('pkgmanager[server]: catalog read ' + ((cat != null) ? 'ok (' + ((cat.packages != null) ? cat.packages.length : '?') + ' packages)' : 'FAILED: ' + err2));
            // Template dispatcher (case 'plugin' on message.action) calls
            // pluginHandler[message.plugin][message.method](server, message):
            // plugin and method must be at the TOP level, not nested in event.
            var send = function () {
                try { session.send({ action: 'plugin', plugin: 'pkgmanager', method: 'pkgList', catalog: cat, token: obj.dlToken, opAck: opAck, error: (err2 ? String(err2) : (err || null)) }); } catch (e) { console.log('pkgmanager: reply failed: ' + e); }
            };
            if ((cat == null) || (cat.packages == null)) { send(); return; }
            var oses = ['linux', 'windows', 'macos'];
            var work = [];
            for (var i = 0; i < cat.packages.length; i++) {
                var p = cat.packages[i];
                for (var k = 0; k < oses.length; k++) {
                    var def = p[oses[k]];
                    if ((def != null) && (def.artifact != null)) { work.push({ pkgid: p.id, def: def }); }
                }
            }
            if (work.length == 0) { send(); return; }
            var done = 0;
            for (var w = 0; w < work.length; w++) {
                (function (item) { obj.pkgArtifactInfo(item.pkgid, item.def, function () { done++; if (done == work.length) { send(); } }); })(work[w]);
            }
        });
    };

    obj.serveraction = function (command, session, parent2) {
        console.log('pkgmanager[server]: serveraction ' + command.pluginaction + ' from user ' + command.userid);
        var isAdmin = ((session != null) && (session.user != null) && (session.user.siteadmin === 0xFFFFFFFF));
        function deny() { try { session.send({ action: 'plugin', plugin: 'pkgmanager', method: 'pkgDenied', msg: 'Operazioni di gestione riservate agli amministratori del server.' }); } catch (e) { } }

        if (command.pluginaction == 'list') { obj.replyCatalog(session, null, null); return; }

        if ((command.pluginaction == 'save') || (command.pluginaction == 'delete')) {
            if (!isAdmin) { console.log('pkgmanager[server]: denied ' + command.pluginaction + ' for user ' + command.userid + ' (not full site admin)'); deny(); return; }
            if (command.pluginaction == 'save') {
                var pkg = command.pkg;
                if ((pkg == null) || (typeof pkg.id != 'string') || (!/^[a-zA-Z0-9._-]+$/.test(pkg.id))) { obj.replyCatalog(session, null, 'ID pacchetto non valido (usa lettere, numeri, . _ -).'); return; }
                if ((typeof pkg.name != 'string') || (pkg.name.trim() == '')) { obj.replyCatalog(session, null, 'Nome pacchetto mancante.'); return; }
                var clean = { id: pkg.id, name: pkg.name.trim() };
                if (typeof pkg.description == 'string') { clean.description = pkg.description; }
                var oses = ['linux', 'windows', 'macos'];
                for (var k = 0; k < oses.length; k++) {
                    var def = obj.sanitizeDef(pkg[oses[k]]);
                    if (def != null) { clean[oses[k]] = def; }
                }
                if ((clean.linux == null) && (clean.windows == null) && (clean.macos == null)) { obj.replyCatalog(session, null, 'Serve almeno un comando per OS.'); return; }
                obj.fs.readFile(obj.catalogPath, function (err, data) {
                    var cat = null;
                    try { cat = JSON.parse(data); } catch (e) { }
                    if (cat == null) { cat = { comment: 'Managed by the pkgmanager plugin.', packages: [] }; }
                    if (cat.packages == null) { cat.packages = []; }
                    var idx = -1;
                    for (var i = 0; i < cat.packages.length; i++) { if (cat.packages[i].id == clean.id) { idx = i; break; } }
                    if (idx >= 0) { cat.packages[idx] = clean; } else { cat.packages.push(clean); }
                    obj.fs.writeFile(obj.catalogPath, JSON.stringify(cat, null, 2), function (e2) {
                        if (e2 != null) { obj.replyCatalog(session, null, 'Scrittura catalogo fallita: ' + e2); return; }
                        console.log('pkgmanager[server]: package saved: ' + clean.id);
                        obj.replyCatalog(session, 'Pacchetto salvato: ' + clean.id, null);
                    });
                });
            } else {
                var delId = String(command.id || '');
                if (!/^[a-zA-Z0-9._-]+$/.test(delId)) { obj.replyCatalog(session, null, 'ID non valido.'); return; }
                obj.fs.readFile(obj.catalogPath, function (err, data) {
                    var cat = null;
                    try { cat = JSON.parse(data); } catch (e) { }
                    if ((cat == null) || (cat.packages == null)) { obj.replyCatalog(session, null, 'Catalogo non leggibile.'); return; }
                    var idx = -1;
                    for (var i = 0; i < cat.packages.length; i++) { if (cat.packages[i].id == delId) { idx = i; break; } }
                    if (idx < 0) { obj.replyCatalog(session, null, 'Pacchetto inesistente: ' + delId); return; }
                    cat.packages.splice(idx, 1);
                    obj.fs.writeFile(obj.catalogPath, JSON.stringify(cat, null, 2), function (e2) {
                        if (e2 != null) { obj.replyCatalog(session, null, 'Scrittura catalogo fallita: ' + e2); return; }
                        try { parent.fs.rmSync(parent.path.join(obj.storePath, delId), { recursive: true, force: true }); } catch (e3) { }
                        console.log('pkgmanager[server]: package deleted: ' + delId);
                        obj.replyCatalog(session, 'Pacchetto eliminato: ' + delId, null);
                    });
                });
            }
            return;
        }
    };

    return obj;
};