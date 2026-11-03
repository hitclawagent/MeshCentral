/**
 * MeshCentral Package Manager plugin ("pkgmanager") — MVP.
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
    obj.version = '0.2.0';
    obj.fs = parent.fs;
    obj.path = parent.path;
    obj.catalogPath = parent.path.join(parent.parent.datapath, 'plugins', 'pkgmanager', 'catalog.json');

    // ---- Client-side (stringified into the browser) ----
    obj.exports = ['onWebUIStartupEnd', 'pkgSidebarInject', 'pkgRequestList', 'pkgList', 'pkgTableHtml', 'pkgTargetOs', 'pkgRunOn', 'pkgInstall', 'goPageStart', 'pkgSidebarOpen', 'pkgSidebarRenderDevices', 'pkgSidebarRender', 'pkgSidebarInstall', 'pkgMsg'];

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
            b.innerHTML = '<div style="position:absolute;top:16px;left:0;width:100%;text-align:center;font-size:30px;line-height:1">📦</div>';
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

    obj.pkgSidebarRenderDevices = function () {
        try {
            var m = document.getElementById('pkgmanagerMain');
            if (m == null) return;
            var devlist = [];
            try { for (var i in nodes) { if (nodes[i] && nodes[i]._id) devlist.push(nodes[i]); } } catch (e) { }
            var x = '<div style="margin-bottom:8px;font-size:16px"><b>Packages — remote install</b></div>';
            x += '<div style="margin-bottom:8px">Install on device: <select id="pkgmanagerDevSel">';
            for (var i = 0; i < devlist.length; i++) {
                var n = devlist[i];
                var conn = ((n.conn & 1) != 0);
                x += '<option value="' + EscapeHtml(n._id) + '"' + (conn ? '' : ' disabled') + '>' + EscapeHtml(n.name) + (conn ? '' : ' (offline)') + '</option>';
            }
            if (devlist.length == 0) { x += '<option value="">No devices</option>'; }
            x += '</select></div>';
            x += '<div style="margin-bottom:8px;color:#888">Installs run through the standard remote-command channel of the selected device (rights checked; output in the results dialog).</div>';
            x += '<div id="pkgmanagerTableWrap"></div>';
            x += '<div id="pkgmanagerMsg" style="margin-top:10px;color:#888"></div>';
            m.innerHTML = x;
            pluginHandler.pkgmanager.pkgSidebarRender();
        } catch (e) { console.log('pkgmanager device render failed: ' + e); }
    };

    obj.pkgSidebarRender = function () {
        try {
            var w = document.getElementById('pkgmanagerTableWrap');
            if (w == null) return;
            var cat = window.pkgmanagerCatalog;
            if ((cat == null) || (cat.packages == null)) { w.innerHTML = '<div style="color:#888">Loading package catalog…</div>'; return; }
            w.innerHTML = pluginHandler.pkgmanager.pkgTableHtml(cat.packages, 'sidebar');
        } catch (e) { console.log('pkgmanager sidebar table failed: ' + e); }
    };

    obj.pkgSidebarInstall = function (pkgid) {
        try {
            var sel = document.getElementById('pkgmanagerDevSel');
            if ((sel == null) || (sel.value == null) || (sel.value == '')) { pluginHandler.pkgmanager.pkgMsg('No target device selected.'); return; }
            var n = null;
            for (var i in nodes) { if (nodes[i] && (nodes[i]._id == sel.value)) { n = nodes[i]; break; } }
            pluginHandler.pkgmanager.pkgRunOn(n, pkgid);
        } catch (e) { console.log('pkgmanager sidebar install failed: ' + e); }
    };

    obj.pkgMsg = function (t) {
        try {
            var m = document.getElementById('pkgmanagerMsg');
            if (m != null) { m.innerText = t; }
            var m2 = document.getElementById('pkgmanagerMsgTab');
            if (m2 != null) { m2.innerText = t; }
        } catch (e) { }
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

    // Per-device tab (p19 "Plugins") entry: uses the currently selected device.
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
