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
    obj.version = '0.1.0';
    obj.fs = parent.fs;
    obj.path = parent.path;
    obj.catalogPath = parent.path.join(parent.parent.datapath, 'plugins', 'pkgmanager', 'catalog.json');

    // ---- Client-side (stringified into the browser) ----
    obj.exports = ['onWebUIStartupEnd', 'pkgRequestList', 'pkgList', 'pkgInstall', 'pkgTargetOs'];

    obj.onWebUIStartupEnd = function () {
        try {
            pluginHandler.registerPluginTab({ tabId: 'pkgmanagerTab', tabTitle: 'Packages' });
            var d = document.getElementById('pkgmanagerTab');
            if (d != null) { d.innerHTML = '<div style="padding:12px;font-family:Arial,Helvetica,sans-serif">Loading package catalog…</div>'; }
            console.log('pkgmanager: startup hook');
            pluginHandler.pkgmanager.pkgRequestList();
        } catch (e) { console.log('pkgmanager startup failed: ' + e); }
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
            var d = document.getElementById('pkgmanagerTab');
            if (d == null) return;
            var x = '<div style="padding:12px;font-family:Arial,Helvetica,sans-serif">';
            x += '<div style="margin-bottom:8px">Install a package on the <b>currently selected device</b>. Installs run through the standard remote-command channel (device rights required, per-package timeout applies).</div>';
            x += '<table style="border-collapse:collapse;width:100%">';
            x += '<tr style="text-align:left;border-bottom:1px solid #ccc"><th style="padding:4px">Package</th><th style="padding:4px">OS</th><th style="padding:4px">Description</th><th style="padding:4px"></th></tr>';
            var pkgs = ((window.pkgmanagerCatalog != null) && (window.pkgmanagerCatalog.packages != null)) ? window.pkgmanagerCatalog.packages : [];
            for (var i = 0; i < pkgs.length; i++) {
                var p = pkgs[i];
                var osl = [];
                if (p.linux != null) { osl.push('Linux'); }
                if (p.windows != null) { osl.push('Windows'); }
                if (p.macos != null) { osl.push('macOS'); }
                x += '<tr style="border-bottom:1px solid #eee"><td style="padding:4px"><b>' + EscapeHtml(p.name) + '</b></td><td style="padding:4px">' + EscapeHtml(osl.join(', ')) + '</td><td style="padding:4px">' + EscapeHtml(p.description || '') + '</td><td style="padding:4px"><input type=button value="Install" onclick="pluginHandler.pkgmanager.pkgInstall(\'' + EscapeHtml(p.id) + '\')"></td></tr>';
            }
            x += '</table><div id="pkgmanagerMsg" style="margin-top:10px;color:#888"></div></div>';
            d.innerHTML = x;
        } catch (e) { console.log('pkgmanager render failed: ' + e); }
    };

    obj.pkgInstall = function (pkgid) {
        try {
            var m = document.getElementById('pkgmanagerMsg');
            var n = currentNode;
            if ((n == null) || ((n.conn & 1) == 0)) { if (m != null) { m.innerText = 'Select a connected device first.'; } return; }
            var cat = window.pkgmanagerCatalog;
            if (cat == null) { if (m != null) { m.innerText = 'Catalog not loaded.'; } return; }
            var pkg = null;
            for (var i = 0; i < cat.packages.length; i++) { if (cat.packages[i].id == pkgid) { pkg = cat.packages[i]; break; } }
            if (pkg == null) { if (m != null) { m.innerText = 'Unknown package.'; } return; }
            var os = pluginHandler.pkgmanager.pkgTargetOs(n);
            var def = pkg[os];
            if (def == null) { if (m != null) { m.innerText = 'This package has no install for this OS (' + os + ').'; } return; }
            // Standard rights-checked runcommands with reply: opens the pending/results dialog
            // (this fork) and the device output comes back into it.
            var responseid = d2runBegin([n._id]);
            meshserver.send({ action: 'runcommands', nodeids: [n._id], type: def.type, cmds: def.cmd, runAsUser: 0, reply: true, responseid: responseid, timeout: (def.timeout || 300) });
        } catch (e) { console.log('pkgmanager install failed: ' + e); }
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
