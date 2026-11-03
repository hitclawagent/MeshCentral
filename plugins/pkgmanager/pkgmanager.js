/**
 * MeshCentral Package Manager plugin ("pkgmanager") — v0.3.0 multi-target.
 *
 * Design: the catalog lives server-side (catalog.json next to this file).
 * The plugin tab lists it and installs a package on the currently selected
 * device by composing the standard, rights-checked "runcommands" action with
 * reply+responseid: the device runs the per-OS command and the output comes
 * back into the pending/results dialog built by this fork (timeout, busy
 * replies and server-side error attribution included).
 *
 * Server surface: serveraction "list" only — it reads catalog.json and sends
 * it back to the requesting session. Installs are composed client-side and go
 * through the core runcommands path, which enforces device rights (131072).
 *
 * Client functions listed in obj.exports are stringified into the browser by
 * pluginHandler.prepExports() and run in page context: they must not reference
 * this closure — only page globals (meshserver, currentNode, Q, EscapeHtml,
 * d2runBegin...) and pluginHandler.pkgmanager.*.
 */
module.exports.pkgmanager = function (parent) {
    var obj = {};
    obj.version = '0.3.0';
    obj.fs = parent.fs;
    obj.path = parent.path;
    obj.catalogPath = parent.path.join(parent.parent.datapath, 'plugins', 'pkgmanager', 'catalog.json');

    // ---- Client-side (stringified into the browser) ----
    obj.exports = ['onWebUIStartupEnd', 'pkgSidebarInject', 'pkgRequestList', 'pkgList', 'pkgTableHtml', 'pkgTargetOs', 'pkgDevToggle', 'pkgDevSelectAll', 'pkgSelectedNodes', 'pkgSidebarOpen', 'pkgSidebarRenderDevices', 'pkgSidebarRender', 'pkgSidebarInstall', 'pkgInstall', 'pkgRunOn', 'goPageStart', 'pkgMsg'];

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
    // mobile has none, the injection skips there). The per-device "Plugins" tab
    // from registerPluginTab keeps working as a second entry point.
    obj.pkgSidebarInject = function () {
        try {
            if (document.getElementById('LeftMenuPackages') != null) return;
            var lb = document.getElementById('page_leftbar');
            if (lb == null) { console.log('pkgmanager: no sidebar in this template, entry skipped'); return; }
            var b = document.createElement('div');
            b.id = 'LeftMenuPackages';
            b.className = 'lbbutton';
            b.title = 'Packages';
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
            console.log('pkgmanager: sidebar entry injected');
        } catch (e) { console.log('pkgmanager sidebar inject failed: ' + e); }
    };

    // go() calls this hook on EVERY navigation (also on re-selecting the current
    // view): close the plugin page there — the single restore point.
    obj.goPageStart = function (x, event) {
        try {
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
            var b = document.getElementById('LeftMenuPackages');
            if (b != null) b.style.opacity = '1';
            pluginHandler.pkgmanager.pkgSidebarRenderDevices();
        } catch (e) { console.log('pkgmanager open failed: ' + e); }
    };

    // Page layout: packages on the left, TARGET MACHINES with checkboxes on the
    // right. The package list filters automatically to the OSes of the selected
    // machines (a package shows only if it has an install def for EVERY selected
    // OS, since Install runs on all of them).
    obj.pkgSidebarRenderDevices = function () {
        try {
            var m = document.getElementById('pkgmanagerMain');
            if (m == null) return;
            var devlist = [];
            try { for (var i in nodes) { if (nodes[i] && nodes[i]._id) devlist.push(nodes[i]); } } catch (e) { }
            var x = '<div style="margin-bottom:8px;font-size:16px"><b>Packages — remote install</b></div>';
            x += '<div id="pkgmanagerSelSummary" style="margin-bottom:8px;color:#888"></div>';
            x += '<div style="display:flex;gap:16px;align-items:flex-start">';
            x += '<div style="flex:1 1 60%;min-width:0"><div style="margin-bottom:4px"><b>Packages</b> <span id="pkgmanagerFilterNote" style="color:#888;font-weight:normal"></span></div><div id="pkgmanagerTableWrap"></div></div>';
            x += '<div style="flex:0 0 320px;border-left:1px solid #ddd;padding-left:12px">';
            x += '<div style="margin-bottom:4px"><b>Target machines</b> — <span style="font-size:12px"><a href=# onclick="pluginHandler.pkgmanager.pkgDevSelectAll(true);return false">all</a> / <a href=# onclick="pluginHandler.pkgmanager.pkgDevSelectAll(false);return false">none</a></span></div>';
            x += '<div id="pkgmanagerDeviceList" style="max-height:420px;overflow-y:auto">';
            if (devlist.length == 0) { x += '<div style="color:#888;padding:4px">No devices</div>'; }
            for (var i = 0; i < devlist.length; i++) {
                var n = devlist[i];
                var on = ((n.conn & 1) != 0);
                var os = pluginHandler.pkgmanager.pkgTargetOs(n);
                x += '<label style="display:block;padding:4px 2px;border-bottom:1px solid #eee;' + (on ? 'cursor:pointer' : 'color:#999;cursor:not-allowed') + '">';
                x += '<input type=checkbox class="pkgmanagerDevCb" value="' + EscapeHtml(n._id) + '"' + (on ? '' : ' disabled') + ' onchange="pluginHandler.pkgmanager.pkgDevToggle()"> ';
                x += '<b>' + EscapeHtml(n.name) + '</b> <span style="color:#888">· ' + os + (on ? ' · online' : ' · offline') + '</span></label>';
            }
            x += '</div><div style="margin-top:6px;color:#888;font-size:12px">Offline machines cannot be selected.</div>';
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

    obj.pkgMsg = function (t) {
        try {
            var m = document.getElementById('pkgmanagerMsg');
            if (m != null) { m.innerText = t; }
            var m2 = document.getElementById('pkgmanagerMsgTab');
            if (m2 != null) { m2.innerText = t; }
        } catch (e) { }
    };

    // Re-render ONLY the package table (the checkbox panel keeps its state):
    // a package is visible only if it has an install def for every OS selected.
    obj.pkgSidebarRender = function () {
        try {
            var w = document.getElementById('pkgmanagerTableWrap');
            if (w == null) return;
            var cat = window.pkgmanagerCatalog;
            if ((cat == null) || (cat.packages == null)) { w.innerHTML = '<div style="color:#888">Loading package catalog…</div>'; return; }
            var sel = pluginHandler.pkgmanager.pkgSelectedNodes();
            var oses = {}; for (var i = 0; i < sel.length; i++) { oses[pluginHandler.pkgmanager.pkgTargetOs(sel[i])] = 1; }
            var osList = Object.keys(oses);
            var shown = [], hidden = 0;
            for (var i = 0; i < cat.packages.length; i++) {
                var p = cat.packages[i]; var okp = true;
                for (var k = 0; k < osList.length; k++) { if (p[osList[k]] == null) { okp = false; break; } }
                if (okp) { shown.push(p); } else { hidden++; }
            }
            var note = document.getElementById('pkgmanagerFilterNote');
            if (note != null) { note.innerText = (osList.length ? ('(' + shown.length + ' of ' + cat.packages.length + ' shown — target OS: ' + osList.join(', ') + ')') : '(' + cat.packages.length + ' of ' + cat.packages.length + ' — select machines to filter by OS)'); }
            var sum = document.getElementById('pkgmanagerSelSummary');
            if (sum != null) { sum.innerText = (sel.length ? (sel.length + ' machine(s) selected — Install runs on ALL of them, grouped by OS.' ) : 'Select target machines on the right; the package list filters by their OS.'); }
            w.innerHTML = pluginHandler.pkgmanager.pkgTableHtml(shown, 'sidebar');
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
            var cat = window.pkgmanagerCatalog;
            var d = document.getElementById('pkgmanagerTab');
            if (d != null) {
                if ((cat == null) || (cat.packages == null)) {
                    d.innerHTML = '<div style="padding:12px;color:#888">Catalog unavailable.</div>';
                } else {
                    var x = '<div style="padding:12px;font-family:Arial,Helvetica,sans-serif">';
                    x += '<div style="margin-bottom:8px">Install a package on <b>this device</b> (standard remote-command channel, rights checked).</div>';
                    x += pluginHandler.pkgmanager.pkgTableHtml(cat.packages, 'tab');
                    x += '<div id="pkgmanagerMsgTab" style="margin-top:10px;color:#888"></div></div>';
                    d.innerHTML = x;
                }
            }
            pluginHandler.pkgmanager.pkgSidebarRender();
        } catch (e) { console.log('pkgmanager render failed: ' + e); }
    };

    obj.pkgTableHtml = function (pkgs, mode) {
        try {
            var click = ((mode == 'sidebar') ? 'pluginHandler.pkgmanager.pkgSidebarInstall' : 'pluginHandler.pkgmanager.pkgInstall');
            var x = '<table style="border-collapse:collapse;width:100%">';
            x += '<tr style="text-align:left;border-bottom:1px solid #ccc"><th style="padding:4px">Package</th><th style="padding:4px">OS</th><th style="padding:4px">Description</th><th style="padding:4px"></th></tr>';
            for (var i = 0; i < ((pkgs != null) ? pkgs.length : 0); i++) {
                var p = pkgs[i];
                var osl = [];
                if (p.linux != null) { osl.push('Linux'); }
                if (p.windows != null) { osl.push('Windows'); }
                if (p.macos != null) { osl.push('macOS'); }
                x += '<tr style="border-bottom:1px solid #eee"><td style="padding:4px"><b>' + EscapeHtml(p.name) + '</b></td><td style="padding:4px">' + EscapeHtml(osl.join(', ')) + '</td><td style="padding:4px">' + EscapeHtml(p.description || '') + '</td><td style="padding:4px"><input type=button value="Install" onclick="' + click + '(\'' + EscapeHtml(p.id) + '\')"></td></tr>';
            }
            x += '</table>';
            return x;
        } catch (e) { return '<div style="color:red">render error</div>'; }
    };

    // MULTI-TARGET install: run the package on ALL selected machines in ONE
    // pending/results dialog. Group the targets by OS, open a single d2runBegin
    // tracking every nodeid, then send one rights-checked runcommands per OS
    // group reusing that responseid — d2runResultReceive updates per-machine
    // rows inside the same dialog.
    obj.pkgSidebarInstall = function (pkgid) {
        try {
            var cat = window.pkgmanagerCatalog;
            if ((cat == null) || (cat.packages == null)) { pluginHandler.pkgmanager.pkgMsg('Catalog not loaded.'); return; }
            var pkg = null;
            for (var i = 0; i < cat.packages.length; i++) { if (cat.packages[i].id == pkgid) { pkg = cat.packages[i]; break; } }
            if (pkg == null) { pluginHandler.pkgmanager.pkgMsg('Unknown package.'); return; }
            var sel = pluginHandler.pkgmanager.pkgSelectedNodes();
            if (sel.length == 0) { pluginHandler.pkgmanager.pkgMsg('Select at least one target machine on the right.'); return; }
            var groups = {}, allids = [];
            for (var i = 0; i < sel.length; i++) {
                var n = sel[i];
                if ((n.conn & 1) == 0) { continue; }
                var os = pluginHandler.pkgmanager.pkgTargetOs(n);
                if (pkg[os] == null) { pluginHandler.pkgmanager.pkgMsg('"' + pkg.name + '" has no install for ' + os + ' (' + n.name + ').'); return; }
                if (groups[os] == null) { groups[os] = []; }
                groups[os].push(n._id); allids.push(n._id);
            }
            if (allids.length == 0) { pluginHandler.pkgmanager.pkgMsg('No connected machine selected.'); return; }
            var responseid = d2runBegin(allids);
            for (var os in groups) {
                var def = pkg[os];
                meshserver.send({ action: 'runcommands', nodeids: groups[os], type: def.type, cmds: def.cmd, runAsUser: 0, reply: true, responseid: responseid, timeout: (def.timeout || 300) });
            }
            pluginHandler.pkgmanager.pkgMsg('Install of "' + pkg.name + '" started on ' + allids.length + ' machine(s) — output in the results dialog.');
        } catch (e) { console.log('pkgmanager sidebar install failed: ' + e); }
    };

    // Compose the standard rights-checked runcommands action with reply: opens the
    // pending/results dialog (this fork) and the device output comes back into it.
    obj.pkgRunOn = function (n, pkgid) {
        try {
            var cat = window.pkgmanagerCatalog;
            if ((cat == null) || (cat.packages == null)) { pluginHandler.pkgmanager.pkgMsg('Catalog not loaded.'); return; }
            var pkg = null;
            for (var i = 0; i < cat.packages.length; i++) { if (cat.packages[i].id == pkgid) { pkg = cat.packages[i]; break; } }
            if (pkg == null) { pluginHandler.pkgmanager.pkgMsg('Unknown package.'); return; }
            if ((n == null) || ((n.conn & 1) == 0)) { pluginHandler.pkgmanager.pkgMsg('Target device not connected.'); return; }
            var os = pluginHandler.pkgmanager.pkgTargetOs(n);
            var def = pkg[os];
            if (def == null) { pluginHandler.pkgmanager.pkgMsg('This package has no install for this OS (' + os + ').'); return; }
            var responseid = d2runBegin([n._id]);
            meshserver.send({ action: 'runcommands', nodeids: [n._id], type: def.type, cmds: def.cmd, runAsUser: 0, reply: true, responseid: responseid, timeout: (def.timeout || 300) });
            pluginHandler.pkgmanager.pkgMsg('Install of "' + pkg.name + '" started on ' + n.name + ' — output in the results dialog.');
        } catch (e) { console.log('pkgmanager run failed: ' + e); }
    };

    // Per-device tab (p19 "Plugins") entry: single target, the current device.
    obj.pkgInstall = function (pkgid) {
        pluginHandler.pkgmanager.pkgRunOn((typeof currentNode != 'undefined') ? currentNode : null, pkgid);
    };

    // ---- Server-side ----
    obj.serveraction = function (command, session, parent2) {
        console.log('pkgmanager[server]: serveraction ' + command.pluginaction + ' from user ' + command.userid);
        if (command.pluginaction == 'list') {
            console.log('pkgmanager[server]: reading catalog at ' + obj.catalogPath);
            obj.fs.readFile(obj.catalogPath, function (err, data) {
                var cat = null;
                try { cat = JSON.parse(data); } catch (e) { }
                console.log('pkgmanager[server]: catalog read ' + ((cat != null) ? 'ok (' + (cat.packages != null ? cat.packages.length : '?') + ' packages)' : 'FAILED: ' + err));
                // Template dispatcher (case 'plugin' on message.action) calls
                // pluginHandler[message.plugin][message.method](server, message):
                // plugin and method must be at the TOP level, not nested in event.
                try { session.send({ action: 'plugin', plugin: 'pkgmanager', method: 'pkgList', catalog: cat, error: (err ? String(err) : null) }); } catch (e) { console.log('pkgmanager: reply failed: ' + e); }
            });
        }
    };

    return obj;
};
