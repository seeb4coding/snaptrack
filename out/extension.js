"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
// SnapTrack VS Code extension: shows changes since the last snapshot in the Source Control view,
// opens Git-style diffs, and lets you Commit (confirm) or Discard them, without Git.
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const core_1 = require("./core");
const SCHEME = 'snaptrack';
const EMPTY = 'empty';
function activate(ctx) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file')
        return;
    const root = folder.uri.fsPath;
    const log = vscode.window.createOutputChannel('SnapTrack');
    ctx.subscriptions.push(log);
    const say = (m) => log.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`);
    say(`Activated for ${root}`);
    const cfg = () => vscode.workspace.getConfiguration('snaptrack');
    const store = new core_1.Store(root, { maxFileSizeMB: cfg().get('maxFileSizeMB', 20), exclude: cfg().get('exclude', []) });
    // ----- source control provider -----
    const scm = vscode.scm.createSourceControl('snaptrack', 'SnapTrack', folder.uri);
    scm.inputBox.placeholder = 'Message (Ctrl+Enter to commit / confirm changes)';
    scm.acceptInputCommand = { command: 'snaptrack.commit', title: 'Commit' };
    const group = scm.createResourceGroup('changes', 'Changes');
    group.hideWhenEmpty = false;
    ctx.subscriptions.push(scm, group);
    // baseline content: snaptrack:/rel/path?sha  (sha "empty" = empty file)
    const baseUri = (rel, sha) => vscode.Uri.from({ scheme: SCHEME, path: '/' + rel, query: sha || EMPTY });
    const fileUri = (rel) => vscode.Uri.file(path.join(root, rel));
    const relOf = (uri) => path.relative(root, uri.fsPath).split(path.sep).join('/');
    ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        provideTextDocumentContent(uri) { if (uri.query === EMPTY)
            return ''; try {
            return store.readObject(uri.query).toString('utf8');
        }
        catch {
            return '';
        } },
    }));
    // gutter markers in the editor (green/blue/red bars), like Git
    scm.quickDiffProvider = {
        provideOriginalResource(uri) {
            if (uri.scheme !== 'file' || !store.exists())
                return undefined;
            const s = store.head()?.files[relOf(uri)];
            return s ? baseUri(relOf(uri), s) : undefined;
        },
    };
    // explorer badges M / A / D
    const decoEmitter = new vscode.EventEmitter();
    let current = [];
    const byPath = new Map();
    const COLORS = { M: 'snaptrack.modifiedForeground', A: 'snaptrack.addedForeground', D: 'snaptrack.deletedForeground' };
    const LABEL = { M: 'Modified', A: 'Added (new file)', D: 'Deleted' };
    ctx.subscriptions.push(vscode.window.registerFileDecorationProvider({
        onDidChangeFileDecorations: decoEmitter.event,
        provideFileDecoration(uri) {
            if (uri.scheme !== 'file')
                return undefined;
            const c = byPath.get(relOf(uri));
            if (!c)
                return undefined;
            return { badge: c.kind, tooltip: `SnapTrack: ${LABEL[c.kind]}`, color: new vscode.ThemeColor(COLORS[c.kind]) };
        },
    }));
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    ctx.subscriptions.push(status);
    const toState = (c) => ({
        resourceUri: fileUri(c.path),
        command: { command: 'snaptrack.openDiff', title: 'Open Changes', arguments: [c] },
        contextValue: c.kind,
        decorations: { strikeThrough: c.kind === 'D', faded: false, tooltip: `${LABEL[c.kind]}: ${c.path}` },
    });
    // status bar: change count, time since the newest checkpoint, storage size in the tooltip (size re-measured at most every 5 minutes)
    const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
    let sizeAt = 0, size = 0;
    const ago = (t) => { const m = Math.floor((Date.now() - Date.parse(t)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; };
    function updateStatus() {
        if (!store.exists())
            return;
        if (Date.now() - sizeAt > 300000) {
            size = store.storageBytes();
            sizeAt = Date.now();
        }
        const cp = store.commits().filter(c => c.auto).pop();
        status.text = `$(history) SnapTrack: ${current.length}` + (cp ? ` · $(save) ${ago(cp.time)}` : '');
        status.tooltip = `SnapTrack: ${current.length} change(s) since the last commit.` + (cp ? `\nLast checkpoint: ${new Date(cp.time).toLocaleString()} (${ago(cp.time)})` : '') + `\nStorage: ${mb(size)} in .snaptrack\nClick to open Source Control.`;
        status.command = 'workbench.view.scm';
    }
    const tick = setInterval(() => { try {
        updateStatus();
        autoCleanup();
    }
    catch (e) {
        say('Status/cleanup failed: ' + (e?.message ?? e));
    } }, 60000);
    tick.unref?.();
    ctx.subscriptions.push({ dispose: () => clearInterval(tick) });
    let refresh = function () {
        const on = store.exists();
        vscode.commands.executeCommand('setContext', 'snaptrack.initialized', on);
        const old = [...byPath.keys()].map(fileUri);
        current = on ? store.status() : [];
        byPath.clear();
        for (const c of current)
            byPath.set(c.path, c);
        group.resourceStates = current.map(toState);
        scm.count = current.length;
        decoEmitter.fire([...old, ...current.map(c => fileUri(c.path))]);
        if (on)
            updateStatus();
        else {
            status.text = '$(history) SnapTrack: Start';
            status.tooltip = 'SnapTrack is not tracking this folder yet. Click to start.';
            status.command = 'snaptrack.init';
        }
        status.show();
        group.label = on ? 'Changes' : 'Not tracking yet: click + above (or "SnapTrack: Start" in the status bar)';
        scm.inputBox.placeholder = on ? 'Message (Ctrl+Enter to commit / confirm changes)' : 'Click + (Start Tracking) above to begin';
    };
    let timer;
    const soon = () => { if (timer)
        clearTimeout(timer); timer = setTimeout(() => { try {
        refresh();
    }
    catch (e) {
        say('Refresh failed: ' + (e?.stack ?? e));
    } }, 400); };
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
    const onFs = (u) => { if (!relOf(u).startsWith('.snaptrack'))
        soon(); };
    watcher.onDidChange(onFs);
    watcher.onDidCreate(onFs);
    watcher.onDidDelete(onFs);
    ctx.subscriptions.push(watcher, vscode.workspace.onDidSaveTextDocument(soon), vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('snaptrack')) {
            store.setOptions({ maxFileSizeMB: cfg().get('maxFileSizeMB', 20), exclude: cfg().get('exclude', []) });
            soon();
        }
    }));
    // ----- helpers -----
    const changeFrom = (arg) => {
        if (!arg)
            return undefined;
        if (arg.kind && arg.path)
            return arg; // from our own command arguments
        const uri = arg.resourceUri ?? (arg instanceof vscode.Uri ? arg : undefined);
        return uri ? byPath.get(relOf(uri)) : undefined;
    };
    async function openDiff(c, title) {
        const left = baseUri(c.path, c.oldSha), right = c.kind === 'D' ? baseUri(c.path) : fileUri(c.path);
        await vscode.commands.executeCommand('vscode.diff', left, right, title ?? `${path.basename(c.path)} (${LABEL[c.kind]}, last commit ↔ now)`);
    }
    async function doCommit(paths) {
        if (!store.exists()) {
            vscode.window.showInformationMessage('SnapTrack is not tracking this folder yet.', 'Start Tracking').then(a => a && vscode.commands.executeCommand('snaptrack.init'));
            return;
        }
        refresh();
        const list = paths ? current.filter(c => paths.includes(c.path)) : current;
        if (!list.length) {
            vscode.window.showInformationMessage('SnapTrack: nothing to commit.');
            return;
        }
        let msg = scm.inputBox.value.trim();
        if (!msg)
            msg = (await vscode.window.showInputBox({ prompt: `Commit message for ${list.length} change(s)`, placeHolder: 'What did you change?', value: suggestMessage(list) }))?.trim() ?? '';
        if (!msg)
            return;
        if (cfg().get('confirmCommit', true)) {
            const sum = list.slice(0, 8).map(c => `${c.kind}  ${c.path}`).join('\n') + (list.length > 8 ? `\n…and ${list.length - 8} more` : '');
            const ok = await vscode.window.showInformationMessage(`Commit ${list.length} change(s)?`, { modal: true, detail: `"${msg}"\n\n${sum}` }, 'Commit');
            if (ok !== 'Commit')
                return;
        }
        const c = store.commit(msg, paths);
        say(`Committed ${c.id} "${c.message}" (${list.length} change(s))`);
        if (!paths)
            scm.inputBox.value = '';
        refresh();
        vscode.window.setStatusBarMessage(`$(check) SnapTrack: committed ${list.length} change(s) as ${c.id.slice(0, 7)}`, 4000);
    }
    /** e.g. "Update index.php, style.css (+1 new, 1 deleted)" */
    function suggestMessage(list) {
        const names = (k) => list.filter(c => c.kind === k).map(c => path.basename(c.path));
        const M = names('M'), A = names('A'), D = names('D');
        const head = M.length ? `Update ${M.slice(0, 3).join(', ')}${M.length > 3 ? ` and ${M.length - 3} more` : ''}`
            : A.length ? `Add ${A.slice(0, 3).join(', ')}${A.length > 3 ? ` and ${A.length - 3} more` : ''}` : `Delete ${D.slice(0, 3).join(', ')}${D.length > 3 ? ` and ${D.length - 3} more` : ''}`;
        const extra = [M.length && A.length ? `+${A.length} new` : '', (M.length || A.length) && D.length ? `${D.length} deleted` : ''].filter(Boolean);
        return head + (extra.length ? ` (${extra.join(', ')})` : '');
    }
    async function pickCommit(placeHolder, commits) {
        const items = commits.map(c => ({ label: `$(git-commit) ${c.message}`, description: `${c.id.slice(0, 7)} · ${new Date(c.time).toLocaleString()}`, c }));
        return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.c;
    }
    // ----- commands -----
    const reg = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...a) => {
        try {
            await fn(...a);
        }
        catch (e) {
            say(`${id} failed: ${e?.stack ?? e}`);
            vscode.window.showErrorMessage(`SnapTrack: ${e?.message ?? e}`);
        }
    }));
    reg('snaptrack.init', async () => {
        if (store.exists()) {
            vscode.window.showInformationMessage('SnapTrack is already tracking this folder.');
            return;
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SnapTrack: saving the first snapshot…' }, async () => { store.init(); });
        refresh();
        const n = Object.keys(store.head().files).length;
        say(`Started tracking: ${n} files, ${store.skipped.length} skipped (too big)`);
        vscode.window.showInformationMessage(`SnapTrack is tracking ${n} file(s).` + (store.skipped.length ? ` ${store.skipped.length} big file(s) skipped (limit: snaptrack.maxFileSizeMB).` : '') + ' Changes will appear in Source Control.');
    });
    reg('snaptrack.refresh', () => refresh());
    reg('snaptrack.showLog', () => log.show());
    reg('snaptrack.openDiff', (c) => openDiff(c));
    reg('snaptrack.openFile', (arg) => { const c = changeFrom(arg); if (c && c.kind !== 'D')
        return vscode.window.showTextDocument(fileUri(c.path)); });
    reg('snaptrack.commit', () => doCommit());
    reg('snaptrack.commitFile', (...args) => {
        const sel = (args[1] && Array.isArray(args[1]) ? args[1] : [args[0]]).map(changeFrom).filter(Boolean);
        return doCommit(sel.map(c => c.path));
    });
    reg('snaptrack.discard', async (...args) => {
        const sel = (args[1] && Array.isArray(args[1]) ? args[1] : [args[0]]).map(changeFrom).filter(Boolean);
        if (!sel.length)
            return;
        const what = sel.length === 1 ? `"${sel[0].path}"` : `${sel.length} files`;
        const detail = (sel.some(c => c.kind === 'A') ? 'New files will be deleted.' : 'Your current changes will be removed.') + ' A safety checkpoint is saved first (see SnapTrack History).';
        if ((await vscode.window.showWarningMessage(`Discard changes in ${what}?`, { modal: true, detail }, 'Discard')) !== 'Discard')
            return;
        checkpointNow(`Before discarding ${sel.length === 1 ? path.basename(sel[0].path) : sel.length + ' files'}`);
        for (const c of sel)
            store.restoreFile(c.path);
        refresh();
    });
    reg('snaptrack.discardAll', async () => {
        refresh();
        if (!current.length) {
            vscode.window.showInformationMessage('SnapTrack: nothing to discard.');
            return;
        }
        if ((await vscode.window.showWarningMessage(`Discard ALL ${current.length} change(s)?`, { modal: true, detail: 'Every file goes back to the last commit. New files are deleted. A safety checkpoint is saved first (see SnapTrack History).' }, 'Discard All')) !== 'Discard All')
            return;
        checkpointNow('Before Discard All');
        store.discardAll();
        refresh();
    });
    reg('snaptrack.history', async () => {
        if (!store.exists())
            return vscode.window.showInformationMessage('SnapTrack is not tracking this folder yet.');
        const c = await pickCommit('Pick a commit to see what it changed', store.log());
        if (!c)
            return;
        const changes = store.commitChanges(c.id);
        if (!changes.length)
            return vscode.window.showInformationMessage(`${c.message}: no file changes (first snapshot of ${Object.keys(c.files).length} files).`);
        const f = await vscode.window.showQuickPick(changes.map(x => ({ label: `${x.kind}  ${x.path}`, x })), { placeHolder: `${c.message} (${c.id.slice(0, 7)}): pick a file to see its diff` });
        if (!f)
            return;
        const x = f.x;
        await vscode.commands.executeCommand('vscode.diff', baseUri(x.path, x.oldSha), baseUri(x.path, x.newSha), `${path.basename(x.path)} (${c.id.slice(0, 7)}: ${c.message})`);
    });
    reg('snaptrack.fileHistory', async (arg) => {
        const uri = arg?.resourceUri ?? (arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri);
        if (!uri || uri.scheme !== 'file')
            return;
        const rel = relOf(uri);
        const hist = store.fileHistory(rel);
        if (!hist.length)
            return vscode.window.showInformationMessage(`SnapTrack: no history for ${rel} yet.`);
        const pick = await vscode.window.showQuickPick(hist.map(h => ({ label: `$(git-commit) ${h.commit.message}`, description: `${h.commit.id.slice(0, 7)} · ${new Date(h.commit.time).toLocaleString()}${h.sha ? '' : ' · deleted'}`, h })), { placeHolder: `History of ${rel}: pick a version` });
        if (!pick)
            return;
        const act = await vscode.window.showQuickPick(['Compare this version with the current file', 'Restore the file to this version'], { placeHolder: pick.label });
        if (act?.startsWith('Compare'))
            await vscode.commands.executeCommand('vscode.diff', baseUri(rel, pick.h.sha ?? undefined), uri, `${path.basename(rel)} (${pick.h.commit.id.slice(0, 7)} ↔ now)`);
        else if (act?.startsWith('Restore')) {
            if ((await vscode.window.showWarningMessage(`Restore ${rel} to "${pick.h.commit.message}"?`, { modal: true, detail: 'The current file is saved in an auto checkpoint first. You can still commit or discard it afterwards.' }, 'Restore')) !== 'Restore')
                return;
            checkpointNow(`Before restoring ${path.basename(rel)}`);
            store.restoreFile(rel, pick.h.commit.id);
            refresh();
        }
    });
    const statText = (s) => (!s ? '' : s.binary ? 'binary' : `+${s.add} −${s.del}`);
    const safeStats = (f) => { try {
        return f();
    }
    catch {
        return undefined;
    } };
    const fmt = (c) => {
        const d = new Date(c.time), today = d.toDateString() === new Date().toDateString();
        return `${c.id.slice(0, 7)} · ${today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    };
    let compareBase;
    const showCheckpoints = () => cfg().get('showCheckpoints', true);
    function commitItem(c, collapsible = true) {
        const head = store.head()?.id === c.id;
        const it = new vscode.TreeItem(c.message, collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        const st = c.parent ? statText(safeStats(() => store.entryStats(c))) : ''; // skipped for the first snapshot (every file would count as added)
        it.description = (head ? '● current · ' : '') + (c.pinned ? '📌 ' : '') + fmt(c) + (st ? ` · ${st}` : '') + (compareBase?.id === c.id ? ' · selected for compare' : '');
        it.tooltip = `${c.named ? 'Named checkpoint' : c.auto ? 'Auto checkpoint' : 'Commit'} ${c.id}${c.pinned ? ' (pinned: kept by Clean Up)' : ''}\n${new Date(c.time).toLocaleString()}\n${Object.keys(c.files).length} file(s)` + (st ? `\nLines: ${st}` : '');
        it.iconPath = new vscode.ThemeIcon(c.named ? 'tag' : c.auto ? 'save' : head ? 'git-commit' : 'circle-outline', c.auto && !c.named ? new vscode.ThemeColor('descriptionForeground') : undefined);
        it.contextValue = (c.auto ? 'snaptrackCheckpoint' : 'snaptrackCommit') + (c.pinned ? 'Pinned' : '');
        return it;
    }
    const diffBetween = (x, title) => vscode.commands.executeCommand('vscode.diff', baseUri(x.path, x.oldSha), baseUri(x.path, x.newSha), title);
    function fileItem(n) {
        const it = new vscode.TreeItem(path.basename(n.x.path));
        const st = statText(safeStats(() => store.lineStats(n.x)));
        it.description = (path.dirname(n.x.path) === '.' ? n.x.kind : `${n.x.kind} · ${path.dirname(n.x.path)}`) + (st ? ` · ${st}` : '');
        it.resourceUri = fileUri(n.x.path);
        it.iconPath = new vscode.ThemeIcon(n.x.kind === 'M' ? 'diff-modified' : n.x.kind === 'A' ? 'diff-added' : 'diff-removed', new vscode.ThemeColor(COLORS[n.x.kind]));
        it.command = { command: 'snaptrack.diffEntry', title: 'Open Diff', arguments: [n] };
        it.contextValue = 'snaptrackEntry';
        return it;
    }
    const histEmitter = new vscode.EventEmitter();
    const historyTree = {
        onDidChangeTreeData: histEmitter.event,
        getTreeItem(n) {
            if (n.type === 'commit')
                return commitItem(n.c);
            if (n.type === 'file')
                return fileItem(n);
            if (n.type === 'info')
                return new vscode.TreeItem(n.label);
            if (n.type === 'deletedRoot') {
                const it = new vscode.TreeItem(`Recently deleted (${n.n})`, vscode.TreeItemCollapsibleState.Collapsed);
                it.iconPath = new vscode.ThemeIcon('trash');
                it.tooltip = 'Files that are in your history but no longer on disk. Click one to see it, or use Restore.';
                return it;
            }
            if (n.type === 'deleted') {
                const it = new vscode.TreeItem(path.basename(n.rel));
                it.description = (path.dirname(n.rel) === '.' ? '' : path.dirname(n.rel) + ' · ') + 'last seen ' + fmt(n.c);
                it.resourceUri = fileUri(n.rel);
                it.iconPath = new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor(COLORS.D));
                it.contextValue = 'snaptrackDeleted';
                it.command = { command: 'vscode.open', title: 'Show', arguments: [baseUri(n.rel, n.sha)] };
                return it;
            }
            return new vscode.TreeItem('');
        },
        getChildren(n) {
            if (!store.exists())
                return [];
            if (!n) {
                const all = store.log().filter(c => (showCheckpoints() || !c.auto) && matches(c));
                const del = filter ? [] : store.deletedFiles();
                const out = del.length ? [{ type: 'deletedRoot', n: del.length }] : [];
                out.push(...all.map(c => ({ type: 'commit', c })));
                return out.length ? out : filter ? [{ type: 'info', label: `Nothing matches "${filter}".` }] : [];
            }
            if (n.type === 'deletedRoot')
                return store.deletedFiles().map(d => ({ type: 'deleted', rel: d.path, c: d.commit, sha: d.sha }));
            if (n.type === 'commit') {
                const ch = store.entryChanges(n.c);
                return ch.length ? ch.map(x => ({ type: 'file', c: n.c, x })) : [{ type: 'info', label: n.c.parent ? '(no file changes)' : `First snapshot: ${Object.keys(n.c.files).length} file(s)` }];
            }
            return [];
        },
    };
    // search: message, id, date, or a changed file's path
    let filter = '';
    const matches = (c) => {
        if (!filter)
            return true;
        const q = filter.toLowerCase(), d = new Date(c.time);
        if (c.message.toLowerCase().includes(q) || c.id.startsWith(q) || d.toLocaleString().toLowerCase().includes(q) || d.toDateString().toLowerCase().includes(q) || c.time.startsWith(q))
            return true;
        return (safeStats(() => store.entryChanges(c)) ?? []).some(x => x.path.toLowerCase().includes(q));
    };
    // File History: versions of the file open in the editor (VS Code's Timeline API is not open to extensions yet)
    const fileEmitter = new vscode.EventEmitter();
    const activeRel = () => { const u = vscode.window.activeTextEditor?.document.uri; return u && u.scheme === 'file' && u.fsPath.startsWith(root) ? relOf(u) : undefined; };
    const fileTree = {
        onDidChangeTreeData: fileEmitter.event,
        getTreeItem(n) {
            if (n.type === 'info')
                return new vscode.TreeItem(n.label);
            if (n.type !== 'version')
                return new vscode.TreeItem('');
            const it = new vscode.TreeItem(n.c.message);
            it.description = fmt(n.c) + (n.sha ? '' : ' · deleted');
            it.iconPath = new vscode.ThemeIcon(n.c.auto ? 'save' : 'git-commit');
            it.contextValue = 'snaptrackVersion';
            it.command = { command: 'snaptrack.compareVersion', title: 'Compare with current file', arguments: [n] };
            return it;
        },
        getChildren(n) {
            if (n || !store.exists())
                return [];
            const rel = activeRel();
            if (!rel)
                return [{ type: 'info', label: 'Open a file to see its versions.' }];
            const h = store.fileHistory(rel);
            return h.length ? h.map(v => ({ type: 'version', c: v.commit, rel, sha: v.sha })) : [{ type: 'info', label: `No saved versions of ${path.basename(rel)} yet.` }];
        },
    };
    const historyView = vscode.window.createTreeView('snaptrack.historyView', { treeDataProvider: historyTree, showCollapseAll: true });
    const fileView = vscode.window.createTreeView('snaptrack.fileHistoryView', { treeDataProvider: fileTree });
    ctx.subscriptions.push(historyView, fileView, vscode.window.onDidChangeActiveTextEditor(() => { const r = activeRel(); fileView.description = r ? path.basename(r) : undefined; fileEmitter.fire(undefined); }));
    const refreshViews = () => { histEmitter.fire(undefined); fileEmitter.fire(undefined); try {
        updateStatus();
    }
    catch { /* */ } };
    const baseRefresh = refresh;
    refresh = () => { baseRefresh(); refreshViews(); };
    const commitFrom = async (arg, placeHolder, list) => {
        if (arg?.type === 'commit' || arg?.type === 'version')
            return arg.c;
        if (arg?.id && arg?.files)
            return arg;
        if (!store.exists()) {
            vscode.window.showInformationMessage('SnapTrack is not tracking this folder yet.');
            return;
        }
        return pickCommit(placeHolder, list ?? store.log());
    };
    const checkpointNow = (why) => { const c = store.checkpoint(why); if (c)
        say(`Checkpoint ${c.id} "${c.message}"`); return c; };
    async function showChanges(changes, title, a, b, rightIsDisk = false) {
        if (!changes.length) {
            vscode.window.showInformationMessage(`SnapTrack: no differences between ${a} and ${b}.`);
            return;
        }
        const f = await vscode.window.showQuickPick(changes.map(x => ({ label: `${x.kind}  ${x.path}`, x })), { placeHolder: `${title}: ${changes.length} file(s) differ. Pick one to see the diff` });
        if (!f)
            return;
        const x = f.x;
        const right = rightIsDisk && x.kind !== 'D' ? fileUri(x.path) : baseUri(x.path, x.newSha);
        await vscode.commands.executeCommand('vscode.diff', baseUri(x.path, x.oldSha), right, `${path.basename(x.path)} (${a} ↔ ${b})`);
    }
    async function saveFile(defName, data, filters) {
        const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(path.dirname(root), defName)), filters });
        if (!uri)
            return;
        fs.writeFileSync(uri.fsPath, data);
        say(`Exported ${uri.fsPath}`);
        const a = await vscode.window.showInformationMessage(`SnapTrack: saved ${path.basename(uri.fsPath)}`, 'Reveal');
        if (a === 'Reveal')
            vscode.commands.executeCommand('revealFileInOS', uri);
    }
    const safeName = (s) => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'snapshot';
    reg('snaptrack.diffEntry', (n) => diffBetween(n.x, `${path.basename(n.x.path)} (${n.c.id.slice(0, 7)}: ${n.c.message})`));
    reg('snaptrack.openEntryFile', (n) => n?.x && n.x.kind !== 'D' && vscode.window.showTextDocument(fileUri(n.x.path)));
    reg('snaptrack.compareVersion', (n) => vscode.commands.executeCommand('vscode.diff', baseUri(n.rel, n.sha ?? undefined), fileUri(n.rel), `${path.basename(n.rel)} (${n.c.id.slice(0, 7)} ↔ now)`));
    reg('snaptrack.restoreVersion', async (n) => {
        if ((await vscode.window.showWarningMessage(`Restore ${n.rel} to "${n.c.message}"?`, { modal: true, detail: 'The current file is saved in an auto checkpoint first, so you can get it back.' }, 'Restore')) !== 'Restore')
            return;
        checkpointNow(`Before restoring ${path.basename(n.rel)}`);
        store.restoreFile(n.rel, n.c.id);
        refresh();
    });
    reg('snaptrack.refreshHistory', () => refresh());
    reg('snaptrack.compareWithCurrent', async (arg) => {
        const c = await commitFrom(arg, 'Compare which commit with the files on disk now?');
        if (!c)
            return;
        await showChanges(store.compareWithWorking(c.id), c.message, c.id.slice(0, 7), 'now', true);
    });
    reg('snaptrack.selectForCompare', async (arg) => {
        const c = await commitFrom(arg, 'Select a commit to compare');
        if (!c)
            return;
        compareBase = c;
        refreshViews();
        vscode.window.setStatusBarMessage(`$(git-compare) SnapTrack: "${c.message}" selected. Right-click another commit → Compare with Selected`, 6000);
    });
    reg('snaptrack.compareWithSelected', async (arg) => {
        if (!compareBase)
            return vscode.commands.executeCommand('snaptrack.compareCommits');
        const b = await commitFrom(arg, `Compare "${compareBase.message}" with…`);
        if (!b)
            return;
        const [x, y] = Date.parse(compareBase.time) <= Date.parse(b.time) ? [compareBase, b] : [b, compareBase];
        await showChanges(store.compareCommits(x.id, y.id), `${x.message} → ${y.message}`, x.id.slice(0, 7), y.id.slice(0, 7));
    });
    reg('snaptrack.compareCommits', async () => {
        const a = await commitFrom(undefined, 'Compare commits (1/2): pick the OLDER commit');
        if (!a)
            return;
        const b = await pickCommit('Compare commits (2/2): pick the NEWER commit', store.log().filter(c => c.id !== a.id));
        if (!b)
            return;
        await showChanges(store.compareCommits(a.id, b.id), `${a.message} → ${b.message}`, a.id.slice(0, 7), b.id.slice(0, 7));
    });
    reg('snaptrack.restoreProject', async (arg) => {
        const c = await commitFrom(arg, 'Restore the WHOLE project to which commit?');
        if (!c)
            return;
        const diff = store.compareWithWorking(c.id);
        if (!diff.length)
            return vscode.window.showInformationMessage(`SnapTrack: the files already match "${c.message}".`);
        const sum = diff.slice(0, 8).map(x => `${x.kind === 'A' ? 'delete ' : x.kind === 'D' ? 'bring back ' : 'rewrite '} ${x.path}`).join('\n') + (diff.length > 8 ? `\n…and ${diff.length - 8} more` : '');
        if ((await vscode.window.showWarningMessage(`Restore the whole project to "${c.message}" (${c.id.slice(0, 7)})?`, { modal: true,
            detail: `${diff.length} file(s) will change:\n${sum}\n\nYour current files are saved in an auto checkpoint first, so this can be undone.` }, 'Restore Project')) !== 'Restore Project')
            return;
        checkpointNow(`Before restoring project to ${c.id.slice(0, 7)}`);
        const r = store.restoreCommit(c.id);
        say(`Restored project to ${c.id}: ${r.written} written, ${r.deleted} deleted`);
        refresh();
        vscode.window.showInformationMessage(`SnapTrack: project restored to "${c.message}" (${r.written} file(s) written, ${r.deleted} removed). Commit to keep it, or restore the checkpoint to go back.`);
    });
    reg('snaptrack.undoLastCommit', async () => {
        const h = store.head();
        if (!h)
            return;
        if (!h.parent)
            return vscode.window.showInformationMessage("SnapTrack: the first snapshot can't be undone.");
        if ((await vscode.window.showWarningMessage(`Undo the last commit "${h.message}"?`, { modal: true, detail: 'Your files stay exactly as they are. Its changes come back to the Changes list so you can edit and commit again.' }, 'Undo Commit')) !== 'Undo Commit')
            return;
        const c = store.undoLastCommit();
        say(`Undid commit ${c.id} "${c.message}"`);
        scm.inputBox.value = c.message;
        refresh();
    });
    reg('snaptrack.checkpoint', () => {
        if (!store.exists())
            return;
        const c = checkpointNow('Manual checkpoint');
        refresh();
        vscode.window.setStatusBarMessage(c ? `$(save) SnapTrack: checkpoint ${c.id.slice(0, 7)} saved` : '$(save) SnapTrack: nothing new to checkpoint', 3000);
    });
    reg('snaptrack.exportPatch', async (arg) => {
        if (!store.exists())
            return;
        let changes, name;
        if (arg?.type === 'commit' || (arg?.id && arg?.files)) {
            const c = arg.c ?? arg;
            changes = c.auto ? store.compareCommits(c.parent ?? c.id, c.id) : store.commitChanges(c.id);
            name = `${c.id.slice(0, 7)}-${safeName(c.message)}.patch`;
        }
        else {
            refresh();
            changes = current;
            name = `snaptrack-changes-${new Date().toISOString().slice(0, 10)}.patch`;
        }
        if (!changes.length)
            return vscode.window.showInformationMessage('SnapTrack: nothing to export.');
        await saveFile(name, store.patch(changes), { Patch: ['patch', 'diff'] });
    });
    reg('snaptrack.exportZip', async (arg) => {
        const c = await commitFrom(arg, 'Export which commit as a .zip?');
        if (!c)
            return;
        const buf = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SnapTrack: building zip…' }, async () => store.zipCommit(c.id));
        await saveFile(`${path.basename(root)}-${c.id.slice(0, 7)}.zip`, buf, { Zip: ['zip'] });
    });
    reg('snaptrack.cleanup', async () => {
        if (!store.exists())
            return;
        const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
        const before = store.storageBytes();
        const all = store.commits();
        const nAuto = all.filter(c => c.auto).length, nCommits = all.length - nAuto;
        const opts = [
            { label: '$(trash) Delete all auto checkpoints', description: `${nAuto} checkpoint(s)`, o: { allCheckpoints: true } },
            { label: '$(calendar) Delete checkpoints older than 7 days', o: { checkpointsOlderThanDays: 7 } },
            { label: '$(history) Keep only the last 20 commits', description: `${nCommits} commit(s) now`, o: { keepLastCommits: 20 } },
            { label: '$(sparkle) Only remove unused data', description: 'safe, keeps all history', o: {} },
        ];
        const p = await vscode.window.showQuickPick(opts, { placeHolder: `SnapTrack storage: ${mb(before)} in .snaptrack. How do you want to clean up?` });
        if (!p)
            return;
        if (Object.keys(p.o).length && (await vscode.window.showWarningMessage(`${p.label.replace(/\$\([^)]+\)\s*/, '')}?`, { modal: true, detail: 'Deleted history cannot be brought back. Your current files and the latest commit are never touched.' }, 'Clean Up')) !== 'Clean Up')
            return;
        const r = store.prune(p.o);
        const after = store.storageBytes();
        say(`Cleanup: ${r.commits} entries, ${r.objects} objects, ${mb(before)} → ${mb(after)}`);
        refresh();
        vscode.window.showInformationMessage(`SnapTrack cleanup: removed ${r.commits} history entr${r.commits === 1 ? 'y' : 'ies'} and ${r.objects} unused file(s). ${mb(before)} → ${mb(after)}.`);
    });
    // ===== 1.2: named checkpoints, pin, search, recently deleted, revert block, line hover, auto cleanup =====
    reg('snaptrack.checkpointNamed', async () => {
        if (!store.exists())
            return;
        const name = (await vscode.window.showInputBox({ prompt: 'Name this checkpoint', placeHolder: 'e.g. before refactor' }))?.trim();
        if (!name)
            return;
        const c = store.checkpoint(name, { named: true });
        say(`Named checkpoint ${c.id} "${name}"`);
        refresh();
        vscode.window.setStatusBarMessage(`$(tag) SnapTrack: checkpoint "${name}" saved`, 3000);
    });
    const pin = (on) => async (arg) => {
        const c = await commitFrom(arg, on ? 'Pin which entry? (pinned entries are kept by Clean Up)' : 'Unpin which entry?', store.log().filter(x => !!x.pinned !== on));
        if (!c)
            return;
        store.setPinned(c.id, on);
        say(`${on ? 'Pinned' : 'Unpinned'} ${c.id}`);
        refreshViews();
    };
    reg('snaptrack.pin', pin(true));
    reg('snaptrack.unpin', pin(false));
    const setFilter = (q) => { filter = q; historyView.description = q ? `filter: "${q}"` : undefined; vscode.commands.executeCommand('setContext', 'snaptrack.filtering', !!q); refreshViews(); };
    reg('snaptrack.searchHistory', async () => {
        const q = await vscode.window.showInputBox({ prompt: 'Search SnapTrack History by message, file name or date (e.g. 2026-11)', value: filter });
        if (q === undefined)
            return;
        setFilter(q.trim());
    });
    reg('snaptrack.clearSearch', () => setFilter(''));
    reg('snaptrack.restoreDeleted', async (arg) => {
        let d = arg?.type === 'deleted' ? arg : undefined;
        if (!d) {
            if (!store.exists())
                return;
            const list = store.deletedFiles();
            if (!list.length)
                return vscode.window.showInformationMessage('SnapTrack: no deleted files in your history.');
            const p = await vscode.window.showQuickPick(list.map(x => ({ label: `$(trash) ${x.path}`, description: `last seen ${fmt(x.commit)} · ${x.commit.message}`, x })), { placeHolder: 'Restore which deleted file?', matchOnDescription: true });
            if (!p)
                return;
            d = { rel: p.x.path, c: p.x.commit };
        }
        store.restoreFile(d.rel, d.c.id);
        say(`Restored deleted file ${d.rel} from ${d.c.id}`);
        refresh();
        await vscode.window.showTextDocument(fileUri(d.rel));
    });
    reg('snaptrack.revertChange', async () => {
        const ed = vscode.window.activeTextEditor;
        if (!ed || ed.document.uri.scheme !== 'file' || !store.exists())
            return;
        const rel = relOf(ed.document.uri), sha = store.head()?.files[rel];
        const base = sha ? store.readObject(sha).toString('utf8') : '';
        const e = (0, core_1.revertAt)(ed.document.getText(), base, ed.selection.active.line, ed.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
        if (!e)
            return vscode.window.setStatusBarMessage('$(info) SnapTrack: no change on this line (compared with the last commit)', 3000);
        const we = new vscode.WorkspaceEdit();
        we.replace(ed.document.uri, new vscode.Range(ed.document.positionAt(e.start), ed.document.positionAt(e.end)), e.text);
        await vscode.workspace.applyEdit(we); // a normal edit: Ctrl+Z brings it back
    });
    reg('snaptrack.exportGit', async () => {
        if (!store.exists())
            return;
        const n = store.commits().filter(c => !c.auto).length;
        const parent = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(path.dirname(root)), openLabel: 'Create the Git repo in here', title: `Convert ${n} SnapTrack commit(s) to Git: pick where to put the new folder` }))?.[0];
        if (!parent)
            return;
        const name = (await vscode.window.showInputBox({ prompt: 'Name of the new folder for the Git repository', value: `${path.basename(root)}-git`, validateInput: v => (!v.trim() || /[\\/:*?"<>|]/.test(v) ? 'Enter a folder name (no \\ / : * ? " < > |)' : undefined) }))?.trim();
        if (!name)
            return;
        const target = path.join(parent.fsPath, name);
        const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SnapTrack: converting history to Git…' }, async () => store.exportGit(target));
        say(`Exported ${r.commits} commit(s) to Git repo ${target}`);
        const a = await vscode.window.showInformationMessage(`SnapTrack: created a Git repository with ${r.commits} commit(s) in ${target}. Checkpoints were not included. This folder was not changed.`, 'Open Folder', 'Reveal');
        if (a === 'Open Folder')
            vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
        else if (a === 'Reveal')
            vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
    });
    // hover: which commit / checkpoint last changed this line (cached per document version)
    let blameCache;
    ctx.subscriptions.push(vscode.languages.registerHoverProvider({ scheme: 'file' }, {
        provideHover(doc, pos) {
            if (!cfg().get('lineHistoryHover', true) || !store.exists() || !doc.uri.fsPath.startsWith(root) || doc.lineCount > 5000)
                return;
            const rel = relOf(doc.uri), key = `${rel}@${doc.version}@${store.latest()?.id}`;
            if (blameCache?.key !== key) {
                if (!store.fileHistory(rel).length)
                    return;
                const lines = safeStats(() => store.blame(rel, doc.getText()));
                if (!lines)
                    return;
                blameCache = { key, lines };
            }
            const c = blameCache.lines[pos.line];
            const md = new vscode.MarkdownString(c ? `**SnapTrack:** line last changed in ${c.named ? 'checkpoint' : c.auto ? 'auto checkpoint' : 'commit'} **${c.message.replace(/[\\`*_[\]<>]/g, '\\$&')}** (\`${c.id.slice(0, 7)}\` · ${new Date(c.time).toLocaleString()})` : '**SnapTrack:** this line changed after the newest snapshot (not saved in history yet)');
            return new vscode.Hover(md);
        },
    }));
    // ----- auto checkpoints -----
    let auto, lastCleanup = 0;
    const autoCleanup = () => {
        const days = cfg().get('autoCleanup.checkpointMaxAgeDays', 0), max = cfg().get('autoCleanup.maxCheckpoints', 0);
        if ((!days && !max) || !store.exists() || Date.now() - lastCleanup < 3600000)
            return;
        lastCleanup = Date.now();
        const r = store.prune({ checkpointsOlderThanDays: days || undefined, maxCheckpoints: max || undefined });
        if (r.commits) {
            say(`Auto cleanup: removed ${r.commits} checkpoint(s), ${r.objects} unused file(s)`);
            sizeAt = 0;
            refreshViews();
        }
    };
    const setupAuto = () => {
        if (auto)
            clearInterval(auto);
        auto = undefined;
        const m = cfg().get('autoCheckpointMinutes', 10);
        if (m > 0)
            auto = setInterval(() => { try {
                if (store.exists() && checkpointNow('Auto checkpoint'))
                    refreshViews();
            }
            catch (e) {
                say('Auto checkpoint failed: ' + (e?.message ?? e));
            } }, Math.max(1, m) * 60000);
        auto?.unref?.();
    };
    setupAuto();
    try {
        autoCleanup();
    }
    catch (e) {
        say('Auto cleanup failed: ' + (e?.message ?? e));
    }
    let saveTimer;
    ctx.subscriptions.push({ dispose: () => { if (auto)
            clearInterval(auto); } }, vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('snaptrack.autoCheckpointMinutes'))
        setupAuto(); if (e.affectsConfiguration('snaptrack.showCheckpoints'))
        refreshViews(); }), vscode.workspace.onDidSaveTextDocument(d => {
        if (!cfg().get('checkpointOnSave', false) || !store.exists() || d.uri.scheme !== 'file' || !d.uri.fsPath.startsWith(root))
            return;
        if (saveTimer)
            clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { try {
            if (checkpointNow(`Saved ${path.basename(d.uri.fsPath)}`))
                refreshViews();
        }
        catch { /* */ } }, 1500);
    }));
    try {
        refresh();
    }
    catch (e) {
        say('Initial refresh failed: ' + (e?.stack ?? e));
    }
    // first time in this folder: offer to start tracking
    if (!store.exists() && !ctx.workspaceState.get('snaptrack.asked')) {
        ctx.workspaceState.update('snaptrack.asked', true);
        vscode.window.showInformationMessage(`Track changes in "${folder.name}" with SnapTrack (Git-style diffs, no Git needed)?`, 'Start Tracking', 'Not now')
            .then(a => { if (a === 'Start Tracking')
            vscode.commands.executeCommand('snaptrack.init'); });
    }
}
function deactivate() { }
