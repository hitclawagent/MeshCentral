/**
 * MeshCentral Package Manager plugin ("pkgmanager") — v0.5.0.
 *
 * Design: the catalog lives server-side (catalog.json next to this file).
 * A "Packages" entry in the LEFT SIDEBAR opens a DROPDOWN MENU:
 *   - "Installa sui dispositivi" (main page): package table + target machine
 *     checkboxes on the right; the list auto-filters by the OSes of the
 *     selected machines; installs run on EVERY selected machine and the
 *     output comes back into ONE results dialog (runcommands reply).
 *   - "Gestione pacchetti" (full site admins only): catalog management —
 *     add / edit / delete packages and upload / delete airgap artifacts
 *     straight from the UI.
 * The per-device "Plugins" tab (p19) keeps a single-device entry point.
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
    obj.version = '0.5.0';
    obj.fs = parent.fs;
    obj.path = parent.path;
    obj.catalogPath = parent.path.join(parent.parent.datapath, 'plugins', 'pkgmanager', 'catalog.json');

    // ---- Client-side (stringified into the browser) ----
    obj.exports = ['onWebUIStartupEnd', 'pkgSidebarInject', 'pkgRequestList', 'pkgList', 'pkgCompose', 'pkgTableHtml', 'pkgTargetOs', 'pkgDevToggle', 'pkgDevSelectAll', 'pkgSelectedNodes', 'pkgSidebarOpen', 'pkgSidebarRenderDevices', 'pkgSidebarRender', 'pkgSidebarInstall', 'pkgInstall', 'pkgRunOn', 'goPageStart', 'pkgMsg', 'pkgSidebarMenu', 'pkgMenuNav', 'pkgMenuClose', 'pkgAdminOpen', 'pkgAdminRender', 'pkgAdminAdd', 'pkgAdminEdit', 'pkgAdminForm', 'pkgAdminSave', 'pkgAdminDelete', 'pkgAdminUpload', 'pkgAdminUploadDo', 'pkgAdminArtifactDel', 'pkgAdminStatus', 'pkgAdminRefresh', 'pkgDenied'];

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
    // mobile has none, the injection skips there). Clicking it opens the DROPDOWN
    // MENU with the plugin pages. The per-device "Plugins" tab from
    // registerPluginTab keeps working as a second entry point.
    obj.pkgSidebarInject = function () {
        try {
            if (document.getElementById('LeftMenuPackages') != null) return;
            var lb = document.getElementById('page_leftbar');
            if (lb == null) { console.log('pkgmanager: no sidebar in this template, entry skipped'); return; }
            var b = document.createElement('div');
            b.id = 'LeftMenuPackages';
            b.className = 'lbbutton';
            b.title = 'Gestione pacchetti';
            b.setAttribute('tabindex', '0');
            b.setAttribute('onmouseup', 'pluginHandler.pkgmanager.pkgSidebarMenu()');
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
            console.log('pkgmanager: sidebar entry injected');
        } catch (e) { console.log('pkgmanager sidebar inject failed: ' + e); }
    };

    // Dropdown menu: "Installa sui dispositivi" for everyone,
    // "Gestione pacchetti" only for full site admins (userinfo.siteadmin).
    obj.pkgSidebarMenu = function () {
        try {
            pluginHandler.pkgmanager.pkgMenuClose();
            var b = document.getElementById('LeftMenuPackages');
            if (b == null) return;
            var r = b.getBoundingClientRect();
            var isAdmin = ((typeof userinfo != 'undefined') && (userinfo != null) && (userinfo.siteadmin === 0xFFFFFFFF));
            var m = document.createElement('div');
            m.id = 'pkgmanagerMenu';
            m.style.cssText = 'position:fixed;left:' + (r.right + 6) + 'px;top:' + r.top + 'px;background:#fff;border:1px solid #bbb;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:110000;min-width:240px;padding:4px 0;font-family:Arial,Helvetica,sans-serif';
            var items = [['install', 'Installa sui dispositivi']];
            if (isAdmin) { items.push(['admin', 'Gestione pacchetti']); }
            for (var i = 0; i < items.length; i++) {
                var it = document.createElement('div');
                it.style.cssText = 'padding:10px 18px;cursor:pointer;font-size:14px';
                it.innerText = items[i][1];
                it.setAttribute('onclick', "pluginHandler.pkgmanager.pkgMenuNav('" + items[i][0] + "')");
                m.appendChild(it);
            }
            document.body.appendChild(m);
            setTimeout(function () {
                var closer = function (ev) {
                    document.removeEventListener('mouseup', closer, true);
                    var t = ev.target;
                    while ((t != null) && (t.id != 'pkgmanagerMenu')) { t = t.parentElement; }
                    if (t == null) { pluginHandler.pkgmanager.pkgMenuClose(); }
                };
                document.addEventListener('mouseup', closer, true);
            }, 0);
        } catch (e) { console.log('pkgmanager menu failed: ' + e); }
    };

    obj.pkgMenuNav = function (which) {
        try {
            pluginHandler.pkgmanager.pkgMenuClose();
            if (which == 'admin') { pluginHandler.pkgmanager.pkgAdminOpen(); }
            else { pluginHandler.pkgmanager.pkgSidebarOpen(); }
        } catch (e) { console.log('pkgmanager menu nav failed: ' + e); }
    };

    obj.pkgMenuClose = function () {
        try { var m = document.getElementById('pkgmanagerMenu'); if (m != null) { m.remove(); } } catch (e) { }
    };

    // go() calls this hook on EVERY navigation (also on re-selecting the current
    // view): close the plugin pages and the menu there — the single restore point.
    obj.goPageStart = function (x, event) {
        try {
            window.pkgmanagerView = null;
            pluginHandler.pkgmanager.pkgMenuClose();
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
            var oses = [['linux', 'Linux'], ['windows', 'Windows'], ['macos', 'macOS']];
            for (var k = 0; k < oses.length; k++) {
                var os = oses[k][0];
                var def = (isNew ? null : pkg[os]);
                x += '<div style="margin-top:14px;border-top:1px solid #eee;padding-top:8px"><b>' + oses[k][1] + '</b></div>';
                x += '<div style="padding:2px 0">Tipo: <select id="pkgfType_' + os + '"><option value=3' + ((((def == null) || (def.type == 3)) ? ' selected' : '')) + '>Shell (Linux/macOS)</option><option value=1' + (((def != null) && (def.type == 1)) ? ' selected' : '') + '>cmd.exe (Windows)</option><option value=2' + (((def != null) && (def.type == 2)) ? ' selected' : '') + '>PowerShell (Windows)</option></select></div>';
                x += '<div style="padding:2px 0">Artefatto (file nello store): <input type=text id="pkgfArt_' + os + '" style=width:280px value="' + EscapeHtml(((def != null) && (def.artifact != null)) ? def.artifact : '') + '"> <input type=button value="Carica artefatto…" onclick="pluginHandler.pkgmanager.pkgAdminUpload(\'' + os + '\')"> <input type=button value="Elimina artefatto" onclick="pluginHandler.pkgmanager.pkgAdminArtifactDel(\'' + os + '\')"></div>';
                x += '<div style="padding:2px 0">Timeout (s): <input type=text id="pkgfTo_' + os + '" style=width:80px value="' + EscapeHtml(((def != null) && (def.timeout != null)) ? String(def.timeout) : '300') + '"></div>';
                x += '<div style="padding:2px 0">Comando (segnaposto {{url}} e {{sha384}}):<br><textarea id="pkgfCmd_' + os + '" style="width:640px;height:70px;font-family:monospace">' + EscapeHtml((def != null) ? String(def.cmd || '') : '') + '</textarea></div>';
            }
            x += '<div style="margin-top:10px"><input type=button value="Salva" onclick="pluginHandler.pkgmanager.pkgAdminSave(' + (isNew ? 'true' : 'false') + ')"> <input type=button value="Annulla" onclick="pluginHandler.pkgmanager.pkgAdminRender()"> <input type=file id="pkgfFile" style="display:none"></div>';
            x += '<div id="pkgadminStatus" style="margin-top:6px;color:#888"></div>';
            m.innerHTML = x;
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
            var art = Q('pkgfArt_' + os).value.trim();
            if (art == '') { art = f.files[0].name; Q('pkgfArt_' + os).value = art; }
            if (!/^[a-zA-Z0-9._-]+$/.test(pid) || !/^[a-zA-Z0-9._ -]+$/.test(art)) { pluginHandler.pkgmanager.pkgAdminStatus('ID o nome artefatto non validi.'); return; }
            var fname = f.files[0].name;
            f.files[0].arrayBuffer().then(function (buf) {
                fetch('/pkgstore.ashx?op=upload&p=' + encodeURIComponent(pid + '/' + art), { method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream' } })
                    .then(function (r) { return r.json(); })
                    .then(function (j) {
                        if (j.ok) { pluginHandler.pkgmanager.pkgAdminStatus('Artefatto caricato: ' + art + ' (' + j.size + ' byte, sha384 ' + String(j.sha384).slice(0, 12) + '…). Salva per aggiornare il catalogo.'); }
                        else { pluginHandler.pkgmanager.pkgAdminStatus('Upload negato: ' + EscapeHtml(String(j.error || '')) + ' (serve amministratore del server).'); }
                    })
                    .catch(function (e2) { pluginHandler.pkgmanager.pkgAdminStatus('Upload fallito: ' + e2); });
            });
        } catch (e) { pluginHandler.pkgmanager.pkgAdminStatus('Upload fallito: ' + e); }
    };

    obj.pkgAdminArtifactDel = function (os) {
        try {
            var pid = Q('pkgfId').value.trim();
            var art = Q('pkgfArt_' + os).value.trim();
            if (!/^[a-zA-Z0-9._-]+$/.test(pid) || !/^[a-zA-Z0-9._ -]+$/.test(art) || (art == '')) { pluginHandler.pkgmanager.pkgAdminStatus('ID o nome artefatto non validi.'); return; }
            fetch('/pkgstore.ashx?op=del&p=' + encodeURIComponent(pid + '/' + art), { method: 'POST' })
                .then(function (r) { return r.json(); })
                .then(function (j) { pluginHandler.pkgmanager.pkgAdminStatus(j.ok ? 'Artefatto eliminato dallo store: ' + art : 'Eliminazione fallita: ' + EscapeHtml(String(j.error || ''))); })
                .catch(function (e2) { pluginHandler.pkgmanager.pkgAdminStatus('Eliminazione fallita: ' + e2); });
        } catch (e) { }
    };

    obj.pkgAdminSave = function (isNew) {
        try {
            var pid = Q('pkgfId').value.trim();
            if (!/^[a-zA-Z0-9._-]+$/.test(pid)) { pluginHandler.pkgmanager.pkgAdminStatus('ID non valido (lettere, numeri, . _ -).'); return; }
            var pkg = { id: pid, name: Q('pkgfName').value.trim(), description: Q('pkgfDesc').value };
            if (pkg.name == '') { pluginHandler.pkgmanager.pkgAdminStatus('Nome mancante.'); return; }
            var oses = ['linux', 'windows', 'macos'];
            for (var k = 0; k < oses.length; k++) {
                var os = oses[k];
                var cmd = Q('pkgfCmd_' + os).value.trim();
                if (cmd == '') continue;
                var def = { type: parseInt(Q('pkgfType_' + os).value), cmd: cmd };
                var to = parseInt(Q('pkgfTo_' + os).value); if (to > 0) { def.timeout = to; }
                var art = Q('pkgfArt_' + os).value.trim();
                if (art != '') { def.artifact = art; }
                pkg[os] = def;
            }
            if ((pkg.linux == null) && (pkg.windows == null) && (pkg.macos == null)) { pluginHandler.pkgmanager.pkgAdminStatus('Serve almeno un comando per OS.'); return; }
            meshserver.send({ action: 'plugin', plugin: 'pkgmanager', pluginaction: 'save', pkg: pkg });
            pluginHandler.pkgmanager.pkgAdminStatus('Salvataggio…');
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
            else { pluginHandler.pkgmanager.pkgSidebarRender(); }
        } catch (e) { console.log('pkgmanager render failed: ' + e); }
    };

    // Server-side rejection of management ops from non-admins.
    obj.pkgDenied = function (server, message) {
        try {
            window.pkgmanagerAdminMsg = ((message != null) && (message.msg != null)) ? message.msg : 'Operazione negata.';
            if (window.pkgmanagerView == 'admin') { pluginHandler.pkgmanager.pkgAdminRender(); }
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