// SnapTrack VS Code extension: shows changes since the last snapshot in the Source Control view,
// opens Git-style diffs, and lets you Commit (confirm) or Discard them, without Git.
// 1.3: every workspace folder gets its own tracker (multi-root). Commands, views, hover and status bar are shared
// and work on the folder of the item you clicked, the Source Control row, or the file you have open.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Store, Change, Commit, LineStats, revertAt } from './core';

const SCHEME = 'snaptrack';
const EMPTY = 'empty';
const COLORS: Record<string, string> = { M: 'snaptrack.modifiedForeground', A: 'snaptrack.addedForeground', D: 'snaptrack.deletedForeground' };
const LABEL: Record<string, string> = { M: 'Modified', A: 'Added (new file)', D: 'Deleted' };
// baseline content: snaptrack:/rel/path?sha  (sha "empty" = empty file). Stored files are named by their hash, so any folder's store can serve them.
const baseUri = (rel: string, sha?: string) => vscode.Uri.from({ scheme: SCHEME, path: '/' + rel, query: sha || EMPTY });

interface Tracker {
  folder: vscode.WorkspaceFolder; root: string; name: string; key: string; store: Store;
  scm: vscode.SourceControl; group: vscode.SourceControlResourceGroup;
  current: Change[]; byPath: Map<string, Change>; size: number; sizeAt: number; lastCleanup: number;
  fileUri(rel: string): vscode.Uri; relOf(uri: vscode.Uri): string; say(m: string): void;
  refresh(): void; soon(): void; setupAuto(): void; checkpointNow(why: string): Commit | null; savedFile(name: string): void; dispose(): void;
}
type Node = { type: 'folder'; t: Tracker } | { type: 'commit'; t: Tracker; c: Commit } | { type: 'file'; t: Tracker; c: Commit; x: Change }
  | { type: 'version'; t: Tracker; c: Commit; rel: string; sha: string | null } | { type: 'info'; label: string }
  | { type: 'deletedRoot'; t: Tracker; n: number } | { type: 'deleted'; t: Tracker; rel: string; c: Commit; sha: string };

export function activate(ctx: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('SnapTrack'); ctx.subscriptions.push(log);
  const say = (m: string) => log.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`);
  const cfg = () => vscode.workspace.getConfiguration('snaptrack');
  const opts = () => ({ maxFileSizeMB: cfg().get('maxFileSizeMB', 20), exclude: cfg().get<string[]>('exclude', []) });
  const trackers: Tracker[] = [];
  const tracked = () => trackers.filter(t => t.store.exists());
  const multi = () => trackers.length > 1;

  const inside = (root: string, p: string) => { const r = path.relative(root, p); return !r.startsWith('..') && !path.isAbsolute(r); };
  /** the tracker whose folder holds `uri` (the innermost one if folders are nested) */
  const trackerFor = (uri?: vscode.Uri): Tracker | undefined => {
    if (!uri || uri.scheme !== 'file') return undefined; let best: Tracker | undefined;
    for (const t of trackers) if (inside(t.root, uri.fsPath) && (!best || t.root.length > best.root.length)) best = t;
    return best;
  };

  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent(uri) {
      if (uri.query === EMPTY) return '';
      for (const t of trackers) { try { if (t.store.hasObject(uri.query)) return t.store.readObject(uri.query).toString('utf8'); } catch { /* next */ } }
      return '';
    },
  }));

  // explorer badges M / A / D
  const decoEmitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  ctx.subscriptions.push(vscode.window.registerFileDecorationProvider({
    onDidChangeFileDecorations: decoEmitter.event,
    provideFileDecoration(uri) {
      const t = trackerFor(uri); const c = t?.byPath.get(t.relOf(uri)); if (!c) return undefined;
      return { badge: c.kind, tooltip: `SnapTrack: ${LABEL[c.kind]}`, color: new vscode.ThemeColor(COLORS[c.kind]) };
    },
  }));

  // status bar: follows the folder of the active file. Change count, time since the newest checkpoint, storage size in the tooltip.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50); ctx.subscriptions.push(status);
  const mb = (n: number) => (n / 1048576).toFixed(1) + ' MB';
  const ago = (t: string) => { const m = Math.floor((Date.now() - Date.parse(t)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; };
  const focused = () => trackerFor(vscode.window.activeTextEditor?.document.uri) ?? trackers[0];
  function updateStatus() {
    const t = focused(); if (!t) { status.hide(); return; }
    const tag = multi() ? ` (${t.name})` : '';
    if (!t.store.exists()) {
      status.text = `$(history) SnapTrack${tag}: Start`; status.tooltip = `SnapTrack is not tracking ${multi() ? `"${t.name}"` : 'this folder'} yet. Click to start.`;
      status.command = multi() ? { command: 'snaptrack.init', title: 'Start Tracking', arguments: [t.key] } : 'snaptrack.init'; status.show(); return;
    }
    if (Date.now() - t.sizeAt > 300000) { t.size = t.store.storageBytes(); t.sizeAt = Date.now(); }
    const cp = t.store.commits().filter(c => c.auto).pop(), n = t.current.length;
    status.text = `$(history) SnapTrack${tag}: ${n}` + (cp ? ` · $(save) ${ago(cp.time)}` : '');
    status.tooltip = `SnapTrack${tag}: ${n} change(s) since the last commit.` + (cp ? `\nLast checkpoint: ${new Date(cp.time).toLocaleString()} (${ago(cp.time)})` : '') + `\nStorage: ${mb(t.size)} in .snaptrack\nClick to open Source Control.`;
    status.command = 'workbench.view.scm'; status.show();
  }
  function setContexts() {
    const on = tracked();
    vscode.commands.executeCommand('setContext', 'snaptrack.initialized', on.length > 0);
    vscode.commands.executeCommand('setContext', 'snaptrack.trackedRoots', on.map(t => t.key));
    vscode.commands.executeCommand('setContext', 'snaptrack.untrackedRoots', trackers.filter(t => !t.store.exists()).map(t => t.key));
  }
  let refreshViews = () => { /* set once the views exist */ };
  const afterRefresh = () => { setContexts(); refreshViews(); };
  const refreshAll = () => { for (const t of trackers) t.refresh(); if (!trackers.length) afterRefresh(); };

  // ----- one tracker per workspace folder -----
  function createTracker(folder: vscode.WorkspaceFolder): Tracker {
    const root = folder.uri.fsPath, name = folder.name ?? path.basename(root), key = folder.uri.toString();
    const store = new Store(root, opts());
    const scm = vscode.scm.createSourceControl('snaptrack', 'SnapTrack', folder.uri);
    scm.acceptInputCommand = { command: 'snaptrack.commit', title: 'Commit', arguments: [key] };
    const group = scm.createResourceGroup('changes', 'Changes'); group.hideWhenEmpty = false;
    const fileUri = (rel: string) => vscode.Uri.file(path.join(root, rel));
    const relOf = (uri: vscode.Uri) => path.relative(root, uri.fsPath).split(path.sep).join('/');
    let timer: NodeJS.Timeout | undefined, auto: NodeJS.Timeout | undefined, saveTimer: NodeJS.Timeout | undefined;
    const toState = (c: Change): vscode.SourceControlResourceState => ({
      resourceUri: fileUri(c.path),
      command: { command: 'snaptrack.openDiff', title: 'Open Changes', arguments: [c, key] },
      contextValue: c.kind,
      decorations: { strikeThrough: c.kind === 'D', faded: false, tooltip: `${LABEL[c.kind]}: ${c.path}` },
    });
    const t: Tracker = {
      folder, root, name, key, store, scm, group, current: [], byPath: new Map(), size: 0, sizeAt: 0, lastCleanup: 0, fileUri, relOf,
      say: (m) => say(multi() ? `[${name}] ${m}` : m),
      refresh() {
        const on = store.exists(), old = [...t.byPath.keys()].map(fileUri);
        t.current = on ? store.status() : [];
        t.byPath.clear(); for (const c of t.current) t.byPath.set(c.path, c);
        group.resourceStates = t.current.map(toState); scm.count = t.current.length;
        decoEmitter.fire([...old, ...t.current.map(c => fileUri(c.path))]);
        group.label = on ? 'Changes' : 'Not tracking yet: click + above (or "SnapTrack: Start" in the status bar)';
        scm.inputBox.placeholder = on ? 'Message (Ctrl+Enter to commit / confirm changes)' : 'Click + (Start Tracking) above to begin';
        afterRefresh();
      },
      soon() { if (timer) clearTimeout(timer); timer = setTimeout(() => { try { t.refresh(); } catch (e: any) { t.say('Refresh failed: ' + (e?.stack ?? e)); } }, 400); },
      setupAuto() {
        if (auto) clearInterval(auto); auto = undefined; const m = cfg().get<number>('autoCheckpointMinutes', 10);
        if (m > 0) auto = setInterval(() => { try { if (store.exists() && t.checkpointNow('Auto checkpoint')) refreshViews(); } catch (e: any) { t.say('Auto checkpoint failed: ' + (e?.message ?? e)); } }, Math.max(1, m) * 60000);
        (auto as any)?.unref?.();
      },
      checkpointNow(why) { const c = store.checkpoint(why); if (c) t.say(`Checkpoint ${c.id} "${c.message}"`); return c; },
      savedFile(fname) {
        t.soon(); if (!cfg().get('checkpointOnSave', false) || !store.exists()) return;
        if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { if (t.checkpointNow(`Saved ${fname}`)) refreshViews(); } catch { /* */ } }, 1500);
      },
      dispose() { for (const x of [timer, saveTimer]) if (x) clearTimeout(x); if (auto) clearInterval(auto); watcher.dispose(); group.dispose(); scm.dispose(); },
    };
    // gutter markers in the editor (green/blue/red bars), like Git
    scm.quickDiffProvider = {
      provideOriginalResource(uri) {
        if (uri.scheme !== 'file' || !store.exists() || trackerFor(uri) !== t) return undefined;
        const s = store.head()?.files[relOf(uri)]; return s ? baseUri(relOf(uri), s) : undefined;
      },
    };
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
    const onFs = (u: vscode.Uri) => { if (!relOf(u).startsWith('.snaptrack')) t.soon(); };
    watcher.onDidChange(onFs); watcher.onDidCreate(onFs); watcher.onDidDelete(onFs);
    t.setupAuto();
    return t;
  }
  function addFolder(folder: vscode.WorkspaceFolder) {
    if (folder.uri.scheme !== 'file' || trackers.some(t => t.key === folder.uri.toString())) return;
    const t = createTracker(folder); trackers.push(t); t.say(`Activated for ${t.root}`);
    try { t.refresh(); } catch (e: any) { t.say('Initial refresh failed: ' + (e?.stack ?? e)); }
    try { autoCleanup(t); } catch (e: any) { t.say('Auto cleanup failed: ' + (e?.message ?? e)); }
    // first time in this folder: offer to start tracking (the 1.2 single-folder answer counts for the first folder)
    const askKey = 'snaptrack.asked:' + t.key, legacy = vscode.workspace.workspaceFolders?.[0]?.uri.toString() === t.key && ctx.workspaceState.get('snaptrack.asked');
    if (!t.store.exists() && !legacy && !ctx.workspaceState.get(askKey)) {
      ctx.workspaceState.update(askKey, true);
      vscode.window.showInformationMessage(`Track changes in "${t.name}" with SnapTrack (Git-style diffs, no Git needed)?`, 'Start Tracking', 'Not now')
        .then(a => { if (a === 'Start Tracking') vscode.commands.executeCommand('snaptrack.init', t.key); });
    }
  }

  // ----- which folder does a command act on? -----
  /** clicked tree node, Source Control row / group, our key, a file Uri or resource state */
  function fromArg(arg: any): Tracker | undefined {
    if (!arg) return undefined;
    if (arg.t && trackers.includes(arg.t)) return arg.t;
    const own = trackers.find(t => t.scm === arg || t.group === arg || t.key === arg || (arg.rootUri instanceof vscode.Uri && t.key === arg.rootUri.toString()));
    if (own) return own;
    const uri: vscode.Uri | undefined = arg.resourceUri ?? (arg instanceof vscode.Uri ? arg : undefined);
    return uri ? trackerFor(uri) : undefined;
  }
  /** the folder to act on: from the argument, else the active file's folder, else the only candidate, else ask */
  async function target(arg?: any, want: 'tracked' | 'untracked' = 'tracked'): Promise<Tracker | undefined> {
    const ok = (t: Tracker) => t.store.exists() === (want === 'tracked');
    const notTracked = (t?: Tracker) => vscode.window.showInformationMessage(`SnapTrack is not tracking ${t && multi() ? `"${t.name}"` : 'this folder'} yet.`, 'Start Tracking')
      .then(a => a && vscode.commands.executeCommand('snaptrack.init', t?.key));
    const a = fromArg(arg);
    if (a) { if (ok(a)) return a; if (want === 'tracked') notTracked(a); else vscode.window.showInformationMessage(`SnapTrack is already tracking ${multi() ? `"${a.name}"` : 'this folder'}.`); return; }
    const list = trackers.filter(ok);
    if (!list.length) {
      if (!trackers.length) vscode.window.showInformationMessage('SnapTrack: open a folder first.');
      else if (want === 'tracked') notTracked(focused()); else vscode.window.showInformationMessage(multi() ? 'SnapTrack is already tracking every folder.' : 'SnapTrack is already tracking this folder.');
      return;
    }
    const act = trackerFor(vscode.window.activeTextEditor?.document.uri);
    if (act && list.includes(act)) return act;
    if (list.length === 1) return list[0];
    return (await vscode.window.showQuickPick(list.map(t => ({ label: `$(root-folder) ${t.name}`, description: t.root, t })), { placeHolder: want === 'tracked' ? 'SnapTrack: which folder?' : 'SnapTrack: start tracking which folder?' }))?.t;
  }

  // ----- helpers -----
  const changeFrom = (t: Tracker, arg: any): Change | undefined => {
    if (!arg) return undefined;
    if (arg.kind && arg.path) return arg as Change;                    // from our own command arguments
    const uri: vscode.Uri | undefined = arg.resourceUri ?? (arg instanceof vscode.Uri ? arg : undefined);
    return uri ? t.byPath.get(t.relOf(uri)) : undefined;
  };
  async function doCommit(t: Tracker, paths?: string[]) {
    t.refresh();
    const list = paths ? t.current.filter(c => paths.includes(c.path)) : t.current;
    if (!list.length) { vscode.window.showInformationMessage('SnapTrack: nothing to commit.'); return; }
    let msg = t.scm.inputBox.value.trim();
    if (!msg) msg = (await vscode.window.showInputBox({ prompt: `Commit message for ${list.length} change(s)`, placeHolder: 'What did you change?', value: suggestMessage(list) }))?.trim() ?? '';
    if (!msg) return;
    if (cfg().get('confirmCommit', true)) {
      const sum = list.slice(0, 8).map(c => `${c.kind}  ${c.path}`).join('\n') + (list.length > 8 ? `\n…and ${list.length - 8} more` : '');
      const ok = await vscode.window.showInformationMessage(`Commit ${list.length} change(s)${multi() ? ` in "${t.name}"` : ''}?`, { modal: true, detail: `"${msg}"\n\n${sum}` }, 'Commit');
      if (ok !== 'Commit') return;
    }
    const c = t.store.commit(msg, paths); t.say(`Committed ${c.id} "${c.message}" (${list.length} change(s))`);
    if (!paths) t.scm.inputBox.value = '';
    t.refresh();
    vscode.window.setStatusBarMessage(`$(check) SnapTrack: committed ${list.length} change(s) as ${c.id.slice(0, 7)}`, 4000);
  }
  /** e.g. "Update index.php, style.css (+1 new, 1 deleted)" */
  function suggestMessage(list: Change[]): string {
    const names = (k: string) => list.filter(c => c.kind === k).map(c => path.basename(c.path));
    const M = names('M'), A = names('A'), D = names('D');
    const head = M.length ? `Update ${M.slice(0, 3).join(', ')}${M.length > 3 ? ` and ${M.length - 3} more` : ''}`
      : A.length ? `Add ${A.slice(0, 3).join(', ')}${A.length > 3 ? ` and ${A.length - 3} more` : ''}` : `Delete ${D.slice(0, 3).join(', ')}${D.length > 3 ? ` and ${D.length - 3} more` : ''}`;
    const extra = [M.length && A.length ? `+${A.length} new` : '', (M.length || A.length) && D.length ? `${D.length} deleted` : ''].filter(Boolean);
    return head + (extra.length ? ` (${extra.join(', ')})` : '');
  }
  async function pickCommit(placeHolder: string, commits: Commit[]): Promise<Commit | undefined> {
    const items = commits.map(c => ({ label: `$(git-commit) ${c.message}`, description: `${c.id.slice(0, 7)} · ${new Date(c.time).toLocaleString()}`, c }));
    return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.c;
  }
  /** a commit from a tree node, or picked from the folder's history */
  async function commitFrom(arg: any, placeHolder: string, keep?: (c: Commit) => boolean): Promise<{ t: Tracker; c: Commit } | undefined> {
    if ((arg?.type === 'commit' || arg?.type === 'version') && arg.t) return { t: arg.t, c: arg.c };
    const t = await target(arg?.id && arg?.files ? undefined : arg); if (!t) return;
    if (arg?.id && arg?.files) return { t, c: arg as Commit };
    const c = await pickCommit(placeHolder, keep ? t.store.log().filter(keep) : t.store.log()); return c && { t, c };
  }

  // ----- commands -----
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...a) => {
    try { await fn(...a); } catch (e: any) { say(`${id} failed: ${e?.stack ?? e}`); vscode.window.showErrorMessage(`SnapTrack: ${e?.message ?? e}`); }
  }));
  reg('snaptrack.init', async (arg?: any) => {
    const t = await target(arg, 'untracked'); if (!t) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `SnapTrack: saving the first snapshot${multi() ? ` of "${t.name}"` : ''}…` }, async () => { t.store.init(); });
    t.refresh();
    const n = Object.keys(t.store.head()!.files).length; t.say(`Started tracking: ${n} files, ${t.store.skipped.length} skipped (too big)`);
    vscode.window.showInformationMessage(`SnapTrack is tracking ${n} file(s)${multi() ? ` in "${t.name}"` : ''}.` + (t.store.skipped.length ? ` ${t.store.skipped.length} big file(s) skipped (limit: snaptrack.maxFileSizeMB).` : '') + ' Changes will appear in Source Control.');
  });
  reg('snaptrack.refresh', () => refreshAll());
  reg('snaptrack.showLog', () => log.show());
  reg('snaptrack.openDiff', async (c: Change, key?: string) => {
    const t = fromArg(key) ?? await target(); if (!t) return;
    const left = baseUri(c.path, c.oldSha), right = c.kind === 'D' ? baseUri(c.path) : t.fileUri(c.path);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(c.path)} (${LABEL[c.kind]}, last commit ↔ now)`);
  });
  reg('snaptrack.openFile', (arg) => { const t = fromArg(arg); const c = t && changeFrom(t, arg); if (t && c && c.kind !== 'D') return vscode.window.showTextDocument(t.fileUri(c.path)); });
  reg('snaptrack.commit', async (arg?: any) => { const t = await target(arg); if (t) await doCommit(t); });
  const selected = async (args: any[]) => {
    const raw = args[1] && Array.isArray(args[1]) ? args[1] : [args[0]];
    const t = fromArg(raw[0]) ?? await target(); if (!t) return;
    return { t, sel: raw.map(a => changeFrom(t, a)).filter(Boolean) as Change[] };
  };
  reg('snaptrack.commitFile', async (...args: any[]) => { const s = await selected(args); if (s?.sel.length) await doCommit(s.t, s.sel.map(c => c.path)); });
  reg('snaptrack.discard', async (...args: any[]) => {
    const s = await selected(args); if (!s?.sel.length) return; const { t, sel } = s;
    const what = sel.length === 1 ? `"${sel[0].path}"` : `${sel.length} files`;
    const detail = (sel.some(c => c.kind === 'A') ? 'New files will be deleted.' : 'Your current changes will be removed.') + ' A safety checkpoint is saved first (see SnapTrack History).';
    if ((await vscode.window.showWarningMessage(`Discard changes in ${what}?`, { modal: true, detail }, 'Discard')) !== 'Discard') return;
    t.checkpointNow(`Before discarding ${sel.length === 1 ? path.basename(sel[0].path) : sel.length + ' files'}`);
    for (const c of sel) t.store.restoreFile(c.path);
    t.refresh();
  });
  reg('snaptrack.discardAll', async (arg?: any) => {
    const t = await target(arg); if (!t) return;
    t.refresh(); if (!t.current.length) { vscode.window.showInformationMessage('SnapTrack: nothing to discard.'); return; }
    if ((await vscode.window.showWarningMessage(`Discard ALL ${t.current.length} change(s)${multi() ? ` in "${t.name}"` : ''}?`, { modal: true, detail: 'Every file goes back to the last commit. New files are deleted. A safety checkpoint is saved first (see SnapTrack History).' }, 'Discard All')) !== 'Discard All') return;
    t.checkpointNow('Before Discard All'); t.store.discardAll(); t.refresh();
  });
  reg('snaptrack.history', async (arg?: any) => {
    const t = await target(arg); if (!t) return;
    const c = await pickCommit('Pick a commit to see what it changed', t.store.log()); if (!c) return;
    const changes = t.store.commitChanges(c.id);
    if (!changes.length) return vscode.window.showInformationMessage(`${c.message}: no file changes (first snapshot of ${Object.keys(c.files).length} files).`);
    const f = await vscode.window.showQuickPick(changes.map(x => ({ label: `${x.kind}  ${x.path}`, x })), { placeHolder: `${c.message} (${c.id.slice(0, 7)}): pick a file to see its diff` });
    if (!f) return;
    const x = f.x;
    await vscode.commands.executeCommand('vscode.diff', baseUri(x.path, x.oldSha), baseUri(x.path, x.newSha), `${path.basename(x.path)} (${c.id.slice(0, 7)}: ${c.message})`);
  });
  reg('snaptrack.fileHistory', async (arg?: any) => {
    const uri: vscode.Uri | undefined = arg?.resourceUri ?? (arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri);
    const t = trackerFor(uri); if (!uri || !t) return;
    if (!t.store.exists()) return vscode.window.showInformationMessage('SnapTrack is not tracking this folder yet.');
    const rel = t.relOf(uri), hist = t.store.fileHistory(rel);
    if (!hist.length) return vscode.window.showInformationMessage(`SnapTrack: no history for ${rel} yet.`);
    const pick = await vscode.window.showQuickPick(hist.map(h => ({ label: `$(git-commit) ${h.commit.message}`, description: `${h.commit.id.slice(0, 7)} · ${new Date(h.commit.time).toLocaleString()}${h.sha ? '' : ' · deleted'}`, h })), { placeHolder: `History of ${rel}: pick a version` });
    if (!pick) return;
    const act = await vscode.window.showQuickPick(['Compare this version with the current file', 'Restore the file to this version'], { placeHolder: pick.label });
    if (act?.startsWith('Compare')) await vscode.commands.executeCommand('vscode.diff', baseUri(rel, pick.h.sha ?? undefined), uri, `${path.basename(rel)} (${pick.h.commit.id.slice(0, 7)} ↔ now)`);
    else if (act?.startsWith('Restore')) {
      if ((await vscode.window.showWarningMessage(`Restore ${rel} to "${pick.h.commit.message}"?`, { modal: true, detail: 'The current file is saved in an auto checkpoint first. You can still commit or discard it afterwards.' }, 'Restore')) !== 'Restore') return;
      t.checkpointNow(`Before restoring ${path.basename(rel)}`); t.store.restoreFile(rel, pick.h.commit.id); t.refresh();
    }
  });

  // ===== History sidebar and File History =====
  const statText = (s?: LineStats) => (!s ? '' : s.binary ? 'binary' : `+${s.add} −${s.del}`);
  const safe = <T>(f: () => T): T | undefined => { try { return f(); } catch { return undefined; } };
  const fmt = (c: Commit) => { const d = new Date(c.time), today = d.toDateString() === new Date().toDateString();
    return `${c.id.slice(0, 7)} · ${today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`; };
  let compareBase: { t: Tracker; c: Commit } | undefined;
  const showCheckpoints = () => cfg().get('showCheckpoints', true);
  function commitItem(t: Tracker, c: Commit): vscode.TreeItem {
    const head = t.store.head()?.id === c.id;
    const it = new vscode.TreeItem(c.message, vscode.TreeItemCollapsibleState.Collapsed);
    const st = c.parent ? statText(safe(() => t.store.entryStats(c))) : '';   // skipped for the first snapshot (every file would count as added)
    it.description = (head ? '● current · ' : '') + (c.pinned ? '📌 ' : '') + fmt(c) + (st ? ` · ${st}` : '') + (compareBase?.c.id === c.id && compareBase.t === t ? ' · selected for compare' : '');
    it.tooltip = `${c.named ? 'Named checkpoint' : c.auto ? 'Auto checkpoint' : 'Commit'} ${c.id}${c.pinned ? ' (pinned: kept by Clean Up)' : ''}\n${new Date(c.time).toLocaleString()}\n${Object.keys(c.files).length} file(s)` + (st ? `\nLines: ${st}` : '');
    it.iconPath = new vscode.ThemeIcon(c.named ? 'tag' : c.auto ? 'save' : head ? 'git-commit' : 'circle-outline', c.auto && !c.named ? new vscode.ThemeColor('descriptionForeground') : undefined);
    it.contextValue = (c.auto ? 'snaptrackCheckpoint' : 'snaptrackCommit') + (c.pinned ? 'Pinned' : '');
    return it;
  }
  function fileItem(n: { t: Tracker; c: Commit; x: Change }): vscode.TreeItem {
    const it = new vscode.TreeItem(path.basename(n.x.path)); const st = statText(safe(() => n.t.store.lineStats(n.x)));
    it.description = (path.dirname(n.x.path) === '.' ? n.x.kind : `${n.x.kind} · ${path.dirname(n.x.path)}`) + (st ? ` · ${st}` : '');
    it.resourceUri = n.t.fileUri(n.x.path); it.iconPath = new vscode.ThemeIcon(n.x.kind === 'M' ? 'diff-modified' : n.x.kind === 'A' ? 'diff-added' : 'diff-removed', new vscode.ThemeColor(COLORS[n.x.kind]));
    it.command = { command: 'snaptrack.diffEntry', title: 'Open Diff', arguments: [n] }; it.contextValue = 'snaptrackEntry'; return it;
  }
  // search: message, id, date, or a changed file's path
  let filter = '';
  const matches = (t: Tracker, c: Commit) => {
    if (!filter) return true; const q = filter.toLowerCase(), d = new Date(c.time);
    if (c.message.toLowerCase().includes(q) || c.id.startsWith(q) || d.toLocaleString().toLowerCase().includes(q) || d.toDateString().toLowerCase().includes(q) || c.time.startsWith(q)) return true;
    return (safe(() => t.store.entryChanges(c)) ?? []).some(x => x.path.toLowerCase().includes(q));
  };
  const folderEntries = (t: Tracker): Node[] => {
    const all = t.store.log().filter(c => (showCheckpoints() || !c.auto) && matches(t, c));
    const del = filter ? [] : t.store.deletedFiles();
    const out: Node[] = del.length ? [{ type: 'deletedRoot', t, n: del.length }] : [];
    out.push(...all.map(c => ({ type: 'commit', t, c } as Node)));
    return out.length ? out : filter ? [{ type: 'info', label: `Nothing matches "${filter}".` }] : [];
  };
  const histEmitter = new vscode.EventEmitter<Node | undefined>();
  const historyTree: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: histEmitter.event,
    getTreeItem(n) {
      if (n.type === 'folder') { const it = new vscode.TreeItem(n.t.name, vscode.TreeItemCollapsibleState.Expanded); it.iconPath = new vscode.ThemeIcon('root-folder'); it.description = `${n.t.current.length} change(s)`; it.tooltip = n.t.root; it.contextValue = 'snaptrackFolder'; return it; }
      if (n.type === 'commit') return commitItem(n.t, n.c);
      if (n.type === 'file') return fileItem(n);
      if (n.type === 'info') return new vscode.TreeItem(n.label);
      if (n.type === 'deletedRoot') { const it = new vscode.TreeItem(`Recently deleted (${n.n})`, vscode.TreeItemCollapsibleState.Collapsed); it.iconPath = new vscode.ThemeIcon('trash'); it.tooltip = 'Files that are in your history but no longer on disk. Click one to see it, or use Restore.'; return it; }
      if (n.type === 'deleted') {
        const it = new vscode.TreeItem(path.basename(n.rel)); it.description = (path.dirname(n.rel) === '.' ? '' : path.dirname(n.rel) + ' · ') + 'last seen ' + fmt(n.c);
        it.resourceUri = n.t.fileUri(n.rel); it.iconPath = new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor(COLORS.D)); it.contextValue = 'snaptrackDeleted';
        it.command = { command: 'vscode.open', title: 'Show', arguments: [baseUri(n.rel, n.sha)] }; return it;
      }
      return new vscode.TreeItem('');
    },
    getChildren(n) {
      if (!n) { const on = tracked(); return on.length > 1 ? on.map(t => ({ type: 'folder', t } as Node)) : on.length ? folderEntries(on[0]) : []; }
      if (n.type === 'folder') return folderEntries(n.t);
      if (n.type === 'deletedRoot') return n.t.store.deletedFiles().map(d => ({ type: 'deleted', t: n.t, rel: d.path, c: d.commit, sha: d.sha } as Node));
      if (n.type === 'commit') { const ch = n.t.store.entryChanges(n.c);
        return ch.length ? ch.map(x => ({ type: 'file', t: n.t, c: n.c, x } as Node)) : [{ type: 'info', label: n.c.parent ? '(no file changes)' : `First snapshot: ${Object.keys(n.c.files).length} file(s)` }]; }
      return [];
    },
  };
  // File History: versions of the file open in the editor (VS Code's Timeline API is not open to extensions yet)
  const fileEmitter = new vscode.EventEmitter<Node | undefined>();
  const active = () => { const u = vscode.window.activeTextEditor?.document.uri, t = trackerFor(u); return t && u && t.store.exists() ? { t, rel: t.relOf(u) } : undefined; };
  const fileTree: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: fileEmitter.event,
    getTreeItem(n) {
      if (n.type === 'info') return new vscode.TreeItem(n.label);
      if (n.type !== 'version') return new vscode.TreeItem('');
      const it = new vscode.TreeItem(n.c.message); it.description = fmt(n.c) + (n.sha ? '' : ' · deleted');
      it.iconPath = new vscode.ThemeIcon(n.c.auto ? 'save' : 'git-commit'); it.contextValue = 'snaptrackVersion';
      it.command = { command: 'snaptrack.compareVersion', title: 'Compare with current file', arguments: [n] }; return it;
    },
    getChildren(n) {
      if (n || !tracked().length) return []; const a = active(); if (!a) return [{ type: 'info', label: 'Open a file to see its versions.' }];
      const h = a.t.store.fileHistory(a.rel); return h.length ? h.map(v => ({ type: 'version', t: a.t, c: v.commit, rel: a.rel, sha: v.sha } as Node)) : [{ type: 'info', label: `No saved versions of ${path.basename(a.rel)} yet.` }];
    },
  };
  const historyView = vscode.window.createTreeView('snaptrack.historyView', { treeDataProvider: historyTree, showCollapseAll: true });
  const fileView = vscode.window.createTreeView('snaptrack.fileHistoryView', { treeDataProvider: fileTree });
  ctx.subscriptions.push(historyView, fileView, vscode.window.onDidChangeActiveTextEditor(() => {
    const a = active(); fileView.description = a ? path.basename(a.rel) : undefined; fileEmitter.fire(undefined); try { updateStatus(); } catch { /* */ }
  }));
  refreshViews = () => { histEmitter.fire(undefined); fileEmitter.fire(undefined); try { updateStatus(); } catch { /* */ } };

  async function showChanges(t: Tracker, changes: Change[], title: string, a: string, b: string, rightIsDisk = false) {
    if (!changes.length) { vscode.window.showInformationMessage(`SnapTrack: no differences between ${a} and ${b}.`); return; }
    const f = await vscode.window.showQuickPick(changes.map(x => ({ label: `${x.kind}  ${x.path}`, x })), { placeHolder: `${title}: ${changes.length} file(s) differ. Pick one to see the diff` });
    if (!f) return; const x = f.x;
    const right = rightIsDisk && x.kind !== 'D' ? t.fileUri(x.path) : baseUri(x.path, x.newSha);
    await vscode.commands.executeCommand('vscode.diff', baseUri(x.path, x.oldSha), right, `${path.basename(x.path)} (${a} ↔ ${b})`);
  }
  async function saveFile(t: Tracker, defName: string, data: Buffer | string, filters: Record<string, string[]>) {
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(path.dirname(t.root), defName)), filters });
    if (!uri) return; fs.writeFileSync(uri.fsPath, data); t.say(`Exported ${uri.fsPath}`);
    const a = await vscode.window.showInformationMessage(`SnapTrack: saved ${path.basename(uri.fsPath)}`, 'Reveal'); if (a === 'Reveal') vscode.commands.executeCommand('revealFileInOS', uri);
  }
  const safeName = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'snapshot';

  reg('snaptrack.diffEntry', (n: { c: Commit; x: Change }) => vscode.commands.executeCommand('vscode.diff', baseUri(n.x.path, n.x.oldSha), baseUri(n.x.path, n.x.newSha), `${path.basename(n.x.path)} (${n.c.id.slice(0, 7)}: ${n.c.message})`));
  reg('snaptrack.openEntryFile', (n: { t: Tracker; x: Change }) => n?.x && n.x.kind !== 'D' && vscode.window.showTextDocument(n.t.fileUri(n.x.path)));
  reg('snaptrack.compareVersion', (n: { t: Tracker; c: Commit; rel: string; sha: string | null }) =>
    vscode.commands.executeCommand('vscode.diff', baseUri(n.rel, n.sha ?? undefined), n.t.fileUri(n.rel), `${path.basename(n.rel)} (${n.c.id.slice(0, 7)} ↔ now)`));
  reg('snaptrack.restoreVersion', async (n: { t: Tracker; c: Commit; rel: string }) => {
    if ((await vscode.window.showWarningMessage(`Restore ${n.rel} to "${n.c.message}"?`, { modal: true, detail: 'The current file is saved in an auto checkpoint first, so you can get it back.' }, 'Restore')) !== 'Restore') return;
    n.t.checkpointNow(`Before restoring ${path.basename(n.rel)}`); n.t.store.restoreFile(n.rel, n.c.id); n.t.refresh();
  });
  reg('snaptrack.refreshHistory', () => refreshAll());
  reg('snaptrack.compareWithCurrent', async (arg?: any) => {
    const r = await commitFrom(arg, 'Compare which commit with the files on disk now?'); if (!r) return;
    await showChanges(r.t, r.t.store.compareWithWorking(r.c.id), r.c.message, r.c.id.slice(0, 7), 'now', true);
  });
  reg('snaptrack.selectForCompare', async (arg?: any) => {
    const r = await commitFrom(arg, 'Select a commit to compare'); if (!r) return; compareBase = r; refreshViews();
    vscode.window.setStatusBarMessage(`$(git-compare) SnapTrack: "${r.c.message}" selected. Right-click another commit → Compare with Selected`, 6000);
  });
  reg('snaptrack.compareWithSelected', async (arg?: any) => {
    if (!compareBase) return vscode.commands.executeCommand('snaptrack.compareCommits');
    const base = compareBase, r = await commitFrom(arg?.t ? arg : base.t.key, `Compare "${base.c.message}" with…`); if (!r) return;
    if (r.t !== base.t) return vscode.window.showInformationMessage(`SnapTrack: "${base.c.message}" is in "${base.t.name}". Pick an entry from the same folder.`);
    const [x, y] = Date.parse(base.c.time) <= Date.parse(r.c.time) ? [base.c, r.c] : [r.c, base.c];
    await showChanges(r.t, r.t.store.compareCommits(x.id, y.id), `${x.message} → ${y.message}`, x.id.slice(0, 7), y.id.slice(0, 7));
  });
  reg('snaptrack.compareCommits', async (arg?: any) => {
    const a = await commitFrom(arg?.type ? undefined : arg, 'Compare commits (1/2): pick the OLDER commit'); if (!a) return;
    const b = await pickCommit('Compare commits (2/2): pick the NEWER commit', a.t.store.log().filter(c => c.id !== a.c.id)); if (!b) return;
    await showChanges(a.t, a.t.store.compareCommits(a.c.id, b.id), `${a.c.message} → ${b.message}`, a.c.id.slice(0, 7), b.id.slice(0, 7));
  });
  reg('snaptrack.restoreProject', async (arg?: any) => {
    const r = await commitFrom(arg, 'Restore the WHOLE project to which commit?'); if (!r) return; const { t, c } = r;
    const diff = t.store.compareWithWorking(c.id);
    if (!diff.length) return vscode.window.showInformationMessage(`SnapTrack: the files already match "${c.message}".`);
    const sum = diff.slice(0, 8).map(x => `${x.kind === 'A' ? 'delete ' : x.kind === 'D' ? 'bring back ' : 'rewrite '} ${x.path}`).join('\n') + (diff.length > 8 ? `\n…and ${diff.length - 8} more` : '');
    if ((await vscode.window.showWarningMessage(`Restore the whole ${multi() ? `"${t.name}" folder` : 'project'} to "${c.message}" (${c.id.slice(0, 7)})?`, { modal: true,
      detail: `${diff.length} file(s) will change:\n${sum}\n\nYour current files are saved in an auto checkpoint first, so this can be undone.` }, 'Restore Project')) !== 'Restore Project') return;
    t.checkpointNow(`Before restoring project to ${c.id.slice(0, 7)}`);
    const res = t.store.restoreCommit(c.id); t.say(`Restored project to ${c.id}: ${res.written} written, ${res.deleted} deleted`); t.refresh();
    vscode.window.showInformationMessage(`SnapTrack: project restored to "${c.message}" (${res.written} file(s) written, ${res.deleted} removed). Commit to keep it, or restore the checkpoint to go back.`);
  });
  reg('snaptrack.undoLastCommit', async (arg?: any) => {
    const t = await target(arg); if (!t) return; const h = t.store.head(); if (!h) return;
    if (!h.parent) return vscode.window.showInformationMessage("SnapTrack: the first snapshot can't be undone.");
    if ((await vscode.window.showWarningMessage(`Undo the last commit "${h.message}"?`, { modal: true, detail: 'Your files stay exactly as they are. Its changes come back to the Changes list so you can edit and commit again.' }, 'Undo Commit')) !== 'Undo Commit') return;
    const c = t.store.undoLastCommit(); t.say(`Undid commit ${c.id} "${c.message}"`); t.scm.inputBox.value = c.message; t.refresh();
  });
  reg('snaptrack.checkpoint', async (arg?: any) => {
    const t = await target(arg); if (!t) return; const c = t.checkpointNow('Manual checkpoint'); t.refresh();
    vscode.window.setStatusBarMessage(c ? `$(save) SnapTrack: checkpoint ${c.id.slice(0, 7)} saved` : '$(save) SnapTrack: nothing new to checkpoint', 3000);
  });
  reg('snaptrack.exportPatch', async (arg?: any) => {
    let t: Tracker | undefined, changes: Change[], name: string;
    if (arg?.type === 'commit') { t = arg.t as Tracker; const c: Commit = arg.c; changes = t.store.entryChanges(c); name = `${c.id.slice(0, 7)}-${safeName(c.message)}.patch`; }
    else { t = await target(arg); if (!t) return; t.refresh(); changes = t.current; name = `snaptrack-changes-${new Date().toISOString().slice(0, 10)}.patch`; }
    if (!changes.length) return vscode.window.showInformationMessage('SnapTrack: nothing to export.');
    await saveFile(t, name, t.store.patch(changes), { Patch: ['patch', 'diff'] });
  });
  reg('snaptrack.exportZip', async (arg?: any) => {
    const r = await commitFrom(arg, 'Export which commit as a .zip?'); if (!r) return;
    const buf = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SnapTrack: building zip…' }, async () => r.t.store.zipCommit(r.c.id));
    await saveFile(r.t, `${path.basename(r.t.root)}-${r.c.id.slice(0, 7)}.zip`, buf, { Zip: ['zip'] });
  });
  reg('snaptrack.cleanup', async (arg?: any) => {
    const t = await target(arg); if (!t) return;
    const before = t.store.storageBytes(); const all = t.store.commits();
    const nAuto = all.filter(c => c.auto).length, nCommits = all.length - nAuto;
    const choices = [
      { label: '$(trash) Delete all auto checkpoints', description: `${nAuto} checkpoint(s)`, o: { allCheckpoints: true } },
      { label: '$(calendar) Delete checkpoints older than 7 days', o: { checkpointsOlderThanDays: 7 } },
      { label: '$(history) Keep only the last 20 commits', description: `${nCommits} commit(s) now`, o: { keepLastCommits: 20 } },
      { label: '$(sparkle) Only remove unused data', description: 'safe, keeps all history', o: {} },
    ];
    const p = await vscode.window.showQuickPick(choices, { placeHolder: `SnapTrack storage${multi() ? ` for "${t.name}"` : ''}: ${mb(before)} in .snaptrack. How do you want to clean up?` }); if (!p) return;
    if (Object.keys(p.o).length && (await vscode.window.showWarningMessage(`${p.label.replace(/\$\([^)]+\)\s*/, '')}?`, { modal: true, detail: 'Deleted history cannot be brought back. Your current files and the latest commit are never touched.' }, 'Clean Up')) !== 'Clean Up') return;
    const r = t.store.prune(p.o); const after = t.store.storageBytes(); t.sizeAt = 0; t.say(`Cleanup: ${r.commits} entries, ${r.objects} objects, ${mb(before)} → ${mb(after)}`); t.refresh();
    vscode.window.showInformationMessage(`SnapTrack cleanup: removed ${r.commits} history entr${r.commits === 1 ? 'y' : 'ies'} and ${r.objects} unused file(s). ${mb(before)} → ${mb(after)}.`);
  });

  // ===== 1.2: named checkpoints, pin, search, recently deleted, revert block, Git export, line hover =====
  reg('snaptrack.checkpointNamed', async (arg?: any) => {
    const t = await target(arg); if (!t) return;
    const name = (await vscode.window.showInputBox({ prompt: 'Name this checkpoint', placeHolder: 'e.g. before refactor' }))?.trim(); if (!name) return;
    const c = t.store.checkpoint(name, { named: true })!; t.say(`Named checkpoint ${c.id} "${name}"`); t.refresh();
    vscode.window.setStatusBarMessage(`$(tag) SnapTrack: checkpoint "${name}" saved`, 3000);
  });
  const pin = (on: boolean) => async (arg?: any) => {
    const r = await commitFrom(arg, on ? 'Pin which entry? (pinned entries are kept by Clean Up)' : 'Unpin which entry?', x => !!x.pinned !== on); if (!r) return;
    r.t.store.setPinned(r.c.id, on); r.t.say(`${on ? 'Pinned' : 'Unpinned'} ${r.c.id}`); refreshViews();
  };
  reg('snaptrack.pin', pin(true));
  reg('snaptrack.unpin', pin(false));
  const setFilter = (q: string) => { filter = q; historyView.description = q ? `filter: "${q}"` : undefined; vscode.commands.executeCommand('setContext', 'snaptrack.filtering', !!q); refreshViews(); };
  reg('snaptrack.searchHistory', async () => {
    const q = await vscode.window.showInputBox({ prompt: 'Search SnapTrack History by message, file name or date (e.g. 2026-11)', value: filter }); if (q === undefined) return;
    setFilter(q.trim());
  });
  reg('snaptrack.clearSearch', () => setFilter(''));
  reg('snaptrack.restoreDeleted', async (arg?: any) => {
    let d: { t: Tracker; rel: string; c: Commit } | undefined = arg?.type === 'deleted' ? arg : undefined;
    if (!d) {
      const t = await target(arg); if (!t) return; const list = t.store.deletedFiles();
      if (!list.length) return vscode.window.showInformationMessage('SnapTrack: no deleted files in your history.');
      const p = await vscode.window.showQuickPick(list.map(x => ({ label: `$(trash) ${x.path}`, description: `last seen ${fmt(x.commit)} · ${x.commit.message}`, x })), { placeHolder: 'Restore which deleted file?', matchOnDescription: true });
      if (!p) return; d = { t, rel: p.x.path, c: p.x.commit };
    }
    d.t.store.restoreFile(d.rel, d.c.id); d.t.say(`Restored deleted file ${d.rel} from ${d.c.id}`); d.t.refresh();
    await vscode.window.showTextDocument(d.t.fileUri(d.rel));
  });
  reg('snaptrack.revertChange', async () => {
    const ed = vscode.window.activeTextEditor, t = trackerFor(ed?.document.uri); if (!ed || !t || !t.store.exists()) return;
    const sha = t.store.head()?.files[t.relOf(ed.document.uri)];
    const base = sha ? t.store.readObject(sha).toString('utf8') : '';
    const e = revertAt(ed.document.getText(), base, ed.selection.active.line, ed.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    if (!e) return vscode.window.setStatusBarMessage('$(info) SnapTrack: no change on this line (compared with the last commit)', 3000);
    const we = new vscode.WorkspaceEdit(); we.replace(ed.document.uri, new vscode.Range(ed.document.positionAt(e.start), ed.document.positionAt(e.end)), e.text);
    await vscode.workspace.applyEdit(we);   // a normal edit: Ctrl+Z brings it back
  });
  reg('snaptrack.exportGit', async (arg?: any) => {
    const t = await target(arg); if (!t) return;
    const n = t.store.commits().filter(c => !c.auto).length;
    const parent = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(path.dirname(t.root)), openLabel: 'Create the Git repo in here', title: `Convert ${n} SnapTrack commit(s) to Git: pick where to put the new folder` }))?.[0]; if (!parent) return;
    const name = (await vscode.window.showInputBox({ prompt: 'Name of the new folder for the Git repository', value: `${path.basename(t.root)}-git`, validateInput: v => (!v.trim() || /[\\/:*?"<>|]/.test(v) ? 'Enter a folder name (no \\ / : * ? " < > |)' : undefined) }))?.trim(); if (!name) return;
    const dest = path.join(parent.fsPath, name);
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SnapTrack: converting history to Git…' }, async () => t.store.exportGit(dest));
    t.say(`Exported ${r.commits} commit(s) to Git repo ${dest}`);
    const a = await vscode.window.showInformationMessage(`SnapTrack: created a Git repository with ${r.commits} commit(s) in ${dest}. Checkpoints were not included. This folder was not changed.`, 'Open Folder', 'Reveal');
    if (a === 'Open Folder') vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest), { forceNewWindow: true });
    else if (a === 'Reveal') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dest));
  });
  // hover: which commit / checkpoint last changed this line (cached per document version)
  let blameCache: { key: string; lines: (Commit | null)[] } | undefined;
  ctx.subscriptions.push(vscode.languages.registerHoverProvider({ scheme: 'file' }, {
    provideHover(doc, pos) {
      const t = trackerFor(doc.uri);
      if (!t || !cfg().get('lineHistoryHover', true) || !t.store.exists() || doc.lineCount > 5000) return;
      const rel = t.relOf(doc.uri), key = `${t.key}|${rel}@${doc.version}@${t.store.latest()?.id}`;
      if (blameCache?.key !== key) { if (!t.store.fileHistory(rel).length) return; const lines = safe(() => t.store.blame(rel, doc.getText())); if (!lines) return; blameCache = { key, lines }; }
      const c = blameCache.lines[pos.line];
      const md = new vscode.MarkdownString(c ? `**SnapTrack:** line last changed in ${c.named ? 'checkpoint' : c.auto ? 'auto checkpoint' : 'commit'} **${c.message.replace(/[\\`*_[\]<>]/g, '\\$&')}** (\`${c.id.slice(0, 7)}\` · ${new Date(c.time).toLocaleString()})` : '**SnapTrack:** this line changed after the newest snapshot (not saved in history yet)');
      return new vscode.Hover(md);
    },
  }));

  // ----- auto cleanup (at most hourly per folder), status refresh, config / save / folder events -----
  function autoCleanup(t: Tracker) {
    const days = cfg().get<number>('autoCleanup.checkpointMaxAgeDays', 0), max = cfg().get<number>('autoCleanup.maxCheckpoints', 0);
    if ((!days && !max) || !t.store.exists() || Date.now() - t.lastCleanup < 3600000) return; t.lastCleanup = Date.now();
    const r = t.store.prune({ checkpointsOlderThanDays: days || undefined, maxCheckpoints: max || undefined });
    if (r.commits) { t.say(`Auto cleanup: removed ${r.commits} checkpoint(s), ${r.objects} unused file(s)`); t.sizeAt = 0; refreshViews(); }
  }
  const tick = setInterval(() => { try { updateStatus(); for (const t of trackers) autoCleanup(t); } catch (e: any) { say('Status/cleanup failed: ' + (e?.message ?? e)); } }, 60000); (tick as any).unref?.();
  ctx.subscriptions.push({ dispose: () => { clearInterval(tick); for (const t of trackers.splice(0)) t.dispose(); } },
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('snaptrack')) return;
      for (const t of trackers) { t.store.setOptions(opts()); t.soon(); if (e.affectsConfiguration('snaptrack.autoCheckpointMinutes')) t.setupAuto(); }
      if (e.affectsConfiguration('snaptrack.showCheckpoints')) refreshViews();
    }),
    vscode.workspace.onDidSaveTextDocument(d => { const t = trackerFor(d.uri); if (t) t.savedFile(path.basename(d.uri.fsPath)); }),
    vscode.workspace.onDidChangeWorkspaceFolders(e => {
      for (const f of e.removed) { const i = trackers.findIndex(t => t.key === f.uri.toString()); if (i >= 0) { trackers[i].say('Folder removed from the workspace'); trackers[i].dispose(); trackers.splice(i, 1); } }
      for (const f of e.added) addFolder(f);
      afterRefresh();
    }));

  for (const f of vscode.workspace.workspaceFolders ?? []) addFolder(f);
  afterRefresh();
}

export function deactivate() { /* nothing */ }
