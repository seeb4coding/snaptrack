// Smoke test of the VS Code wiring with a fake 'vscode' module (real VS Code can't run in this sandbox).
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'); const Module = require('module');
const calls = []; let answers = {};
function makeVscode(root) {
  class Uri { constructor(o) { Object.assign(this, o); } static file(p) { return new Uri({ scheme: 'file', fsPath: p, path: p }); } static from(o) { return new Uri({ ...o, fsPath: o.path }); } toString() { return `${this.scheme}:${this.path}${this.query ? '?' + this.query : ''}`; } }
  class EventEmitter { constructor() { this.l = []; this.event = f => this.l.push(f); } fire(v) { this.l.forEach(f => f(v)); } }
  const commands = {}; const ctxKeys = {};
  const scm = { group: null, ctrl: null };
  return {
    Uri, EventEmitter, TreeItem: class { constructor(l, s) { this.label = l; this.collapsibleState = s; } }, TreeItemCollapsibleState: { None: 0, Collapsed: 1 }, ThemeColor: class { constructor(id) { this.id = id; } }, ThemeIcon: class { constructor(id, c) { this.id = id; this.color = c; } },
    languages: { registerHoverProvider: (s, p) => { scm.hover = p; return { dispose() {} }; } }, EndOfLine: { LF: 1, CRLF: 2 }, Range: class { constructor(a, b) { this.start = a; this.end = b; } }, Hover: class { constructor(c) { this.contents = c; } }, MarkdownString: class { constructor(v) { this.value = v; } },
    WorkspaceEdit: class { constructor() { this.edits = []; } replace(u, r, t) { this.edits.push({ u, r, t }); } },
    RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 15 },
    workspace: { workspaceFolders: [{ uri: Uri.file(root) }], getConfiguration: () => ({ get: (k, d) => d }), registerTextDocumentContentProvider: (s, p) => { scm.content = p; return { dispose() {} }; },
      createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }), onDidSaveTextDocument: () => ({ dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }), applyEdit: async (we) => { scm.edits = we.edits; return true; } },
    scm: { createSourceControl: (id, label, uri) => { scm.ctrl = { id, label, inputBox: { value: '' }, dispose() {}, createResourceGroup: (gid, gl) => (scm.group = { id: gid, label: gl, resourceStates: [], dispose() {} }) }; return scm.ctrl; } },
    window: { registerFileDecorationProvider: p => { scm.deco = p; return { dispose() {} }; }, createStatusBarItem: () => (scm.status = { show() {}, hide() {}, dispose() {} }), createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      showInformationMessage: async (m, o, ...b) => { calls.push(['info', m]); return answers.info; }, showWarningMessage: async (m) => { calls.push(['warn', m]); return answers.warn; },
      showErrorMessage: async (m) => { calls.push(['error', m]); }, showInputBox: async () => answers.input, showQuickPick: async (items) => { const it = await items; return typeof answers.pick === 'function' ? answers.pick(it) : it[0]; },
      withProgress: async (o, f) => f(), createTreeView: (id, o) => { scm.views = scm.views || {}; scm.views[id] = o.treeDataProvider; return { dispose() {} }; }, onDidChangeActiveTextEditor: () => ({ dispose() {} }), showSaveDialog: async () => answers.save, setStatusBarMessage: () => {}, showTextDocument: async () => {}, activeTextEditor: undefined },
    commands: { registerCommand: (id, f) => { commands[id] = f; return { dispose() {} }; }, executeCommand: async (id, ...a) => { if (id === 'setContext') { ctxKeys[a[0]] = a[1]; return; } calls.push(['exec', id, a]); if (commands[id]) return commands[id](...a); } },
    _commands: commands, _scm: scm, _ctx: ctxKeys,
  };
}
test('extension: init via welcome command, shows M/A/D, diff, commit with confirm, discard, history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapext-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>Hi</h1>\n'); fs.writeFileSync(path.join(root, 'old.css'), 'a{}');
  const vs = makeVscode(root); const orig = Module._load; Module._load = function (r, ...a) { return r === 'vscode' ? vs : orig.call(this, r, ...a); };
  const ext = require('../out/extension.js'); const ctx = { subscriptions: [], workspaceState: { get: () => true, update() {} } }; ext.activate(ctx);
  assert.equal(vs._ctx['snaptrack.initialized'], false); assert.equal(vs._scm.status.command, 'snaptrack.init'); assert.match(vs._scm.group.label, /Not tracking/);
  await vs._commands['snaptrack.init'](); assert.equal(vs._ctx['snaptrack.initialized'], true); assert.equal(vs._scm.group.label, 'Changes'); assert.match(vs._scm.status.text, /SnapTrack: 0/); assert.equal(vs._scm.group.resourceStates.length, 0);
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>Hello</h1>\n'); fs.unlinkSync(path.join(root, 'old.css')); fs.writeFileSync(path.join(root, 'app.js'), 'go()');
  await vs._commands['snaptrack.refresh']();
  const st = vs._scm.group.resourceStates; assert.deepEqual(st.map(s => s.contextValue + path.basename(s.resourceUri.fsPath)), ['Aapp.js', 'Mindex.html', 'Dold.css']);
  assert.equal(vs._scm.ctrl.count, 3); assert.equal(vs._scm.deco.provideFileDecoration(vs.Uri.file(path.join(root, 'index.html'))).badge, 'M');
  // click a modified file -> vscode.diff with baseline content on the left
  await vs._commands['snaptrack.openDiff'](st[1].command.arguments[0]);
  const d = calls.filter(c => c[1] === 'vscode.diff').pop(); assert.equal(vs._scm.content.provideTextDocumentContent(d[2][0]), '<h1>Hi</h1>\n');
  // quick diff (gutter) baseline
  assert.ok(vs._scm.ctrl.quickDiffProvider.provideOriginalResource(vs.Uri.file(path.join(root, 'index.html'))));
  // commit only one file, confirm dialog answered "Commit"
  answers = { info: 'Commit', input: 'update title' };
  await vs._commands['snaptrack.commitFile'](st[1]); assert.deepEqual(vs._scm.group.resourceStates.map(s => s.contextValue), ['A', 'D']);
  // cancel confirm -> nothing committed
  answers = { info: undefined, input: 'nope' }; await vs._commands['snaptrack.commit'](); assert.equal(vs._scm.group.resourceStates.length, 2);
  // discard all, confirmed
  answers = { warn: 'Discard All' }; await vs._commands['snaptrack.discardAll']();
  assert.equal(vs._scm.group.resourceStates.length, 0); assert.ok(fs.existsSync(path.join(root, 'old.css'))); assert.ok(!fs.existsSync(path.join(root, 'app.js')));
  // history: first item = latest commit, pick its file -> diff between commits
  answers = { pick: items => items.find(i => /update title/.test(i.label)) || items[0] }; await vs._commands['snaptrack.history']();
  const h = calls.filter(c => c[1] === 'vscode.diff').pop(); assert.equal(vs._scm.content.provideTextDocumentContent(h[2][1]), '<h1>Hello</h1>\n');
  assert.ok(!calls.some(c => c[0] === 'error'), JSON.stringify(calls.filter(c => c[0] === 'error')));

  // ---- 1.1 features ----
  const H = vs._scm.views['snaptrack.historyView'];
  const commitsOnly = async () => (await H.getChildren()).filter(n => n.type === "commit");
  let top = await commitsOnly(); const labels = top.map(n => H.getTreeItem(n).label);
  assert.deepEqual(labels, ['Before Discard All', 'update title', 'Initial snapshot']);         // safety checkpoint was saved
  const kids = await H.getChildren(top[1]); assert.equal(H.getTreeItem(kids[0]).label, 'index.html');
  await vs._commands['snaptrack.diffEntry'](kids[0]);
  // the checkpoint still has app.js -> restore the whole project to it
  answers = { warn: 'Restore Project' }; await vs._commands['snaptrack.restoreProject'](top[0]);
  assert.ok(fs.existsSync(path.join(root, 'app.js'))); assert.ok(!fs.existsSync(path.join(root, 'old.css')));
  assert.deepEqual(vs._scm.group.resourceStates.map(s => s.contextValue).sort(), ['A', 'D']);
  // undo last commit -> index.html change is back in Changes, message restored in the box
  answers = { warn: 'Undo Commit' }; await vs._commands['snaptrack.undoLastCommit']();
  assert.equal(vs._scm.ctrl.inputBox.value, 'update title'); assert.equal(vs._scm.group.resourceStates.length, 3);
  // export current changes as a patch
  const pf = path.join(os.tmpdir(), 'st-' + Date.now() + '.patch'); answers = { save: vs.Uri.file(pf) }; await vs._commands['snaptrack.exportPatch']();
  const pt = fs.readFileSync(pf, 'utf8'); assert.match(pt, /\+<h1>Hello<\/h1>/); assert.match(pt, /new file/);
  // export zip of first commit
  const zf = path.join(os.tmpdir(), 'st-' + Date.now() + '.zip'); top = await commitsOnly(); answers = { save: vs.Uri.file(zf) };
  await vs._commands['snaptrack.exportZip'](top[top.length - 1]); assert.equal(fs.readFileSync(zf).readUInt32LE(0), 0x04034b50);
  // file history view follows the active editor
  vs.window.activeTextEditor = { document: { uri: vs.Uri.file(path.join(root, 'index.html')) } };
  const F = vs._scm.views['snaptrack.fileHistoryView']; const vers = await F.getChildren(); assert.ok(vers.length >= 1); assert.equal(F.getTreeItem(vers[0]).contextValue, 'snaptrackVersion');
  // manual checkpoint + cleanup of all checkpoints
  await vs._commands['snaptrack.checkpoint']();
  answers = { pick: items => items[0], warn: 'Clean Up' }; await vs._commands['snaptrack.cleanup']();
  top = await commitsOnly(); assert.deepEqual(top.map(n => H.getTreeItem(n).label), ['Initial snapshot']);
  assert.ok(!calls.some(c => c[0] === 'error'), JSON.stringify(calls.filter(c => c[0] === 'error')));
  Module._load = orig;
});

test('extension 1.2: auto message, named checkpoint, pin, search, recently deleted, revert block, hover, status bar', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapext12-'));
  fs.writeFileSync(path.join(root, 'index.php'), 'a\nb\nc\n'); fs.writeFileSync(path.join(root, 'gone.css'), 'x{}');
  const vs = makeVscode(root); const orig = Module._load; Module._load = function (r, ...a) { return r === 'vscode' ? vs : orig.call(this, r, ...a); };
  delete require.cache[require.resolve('../out/extension.js')];
  const ext = require('../out/extension.js'); ext.activate({ subscriptions: [], workspaceState: { get: () => true, update() {} } });
  await vs._commands['snaptrack.init']();
  const H = vs._scm.views['snaptrack.historyView'];
  // #10 auto commit message is offered when the box is empty
  fs.writeFileSync(path.join(root, 'index.php'), 'a\nB\nc\n'); fs.writeFileSync(path.join(root, 'new.js'), '1'); await vs._commands['snaptrack.refresh']();
  let offered; vs.window.showInputBox = async (o) => { offered = o.value; return o.value; }; answers = { info: 'Commit' };
  await vs._commands['snaptrack.commit'](); assert.equal(offered, 'Update index.php (+1 new)'); assert.equal(vs._scm.group.resourceStates.length, 0);
  // #6 line stats on the commit row
  let top = (await H.getChildren()).filter(n => n.type === 'commit'); assert.match(H.getTreeItem(top[0]).description, /\+2 −1/);
  // #3 named checkpoint (tag icon, pinned) and #4 pin / unpin
  vs.window.showInputBox = async () => 'before refactor'; await vs._commands['snaptrack.checkpointNamed']();
  top = (await H.getChildren()).filter(n => n.type === 'commit'); let it = H.getTreeItem(top[0]);
  assert.equal(it.label, 'before refactor'); assert.equal(it.iconPath.id, 'tag'); assert.equal(it.contextValue, 'snaptrackCheckpointPinned');
  await vs._commands['snaptrack.pin'](top[1]); assert.equal(H.getTreeItem((await H.getChildren()).filter(n => n.type === 'commit')[1]).contextValue, 'snaptrackCommitPinned');
  await vs._commands['snaptrack.unpin'](top[1]); assert.equal(H.getTreeItem((await H.getChildren()).filter(n => n.type === 'commit')[1]).contextValue, 'snaptrackCommit');
  // #5 search by file name
  vs.window.showInputBox = async () => 'new.js'; await vs._commands['snaptrack.searchHistory']();
  assert.deepEqual((await H.getChildren()).map(n => H.getTreeItem(n).label), ['Update index.php (+1 new)']); assert.equal(vs._ctx['snaptrack.filtering'], true);
  await vs._commands['snaptrack.clearSearch'](); assert.equal(vs._ctx['snaptrack.filtering'], false);
  // #2 recently deleted node + restore
  fs.unlinkSync(path.join(root, 'gone.css'));
  top = await H.getChildren(); assert.equal(top[0].type, 'deletedRoot'); const del = await H.getChildren(top[0]);
  assert.equal(H.getTreeItem(del[0]).label, 'gone.css'); await vs._commands['snaptrack.restoreDeleted'](del[0]);
  assert.equal(fs.readFileSync(path.join(root, 'gone.css'), 'utf8'), 'x{}'); assert.notEqual((await H.getChildren())[0].type, 'deletedRoot');
  // #1 revert the block under the cursor (edit goes through WorkspaceEdit, so Ctrl+Z works)
  const text = 'a\nB\nX\nc\n'; const uri = vs.Uri.file(path.join(root, 'index.php'));
  const doc = { uri, eol: 1, lineCount: 5, version: 7, getText: () => text, positionAt: (o) => o };
  vs.window.activeTextEditor = { document: doc, selection: { active: { line: 2 } } };
  await vs._commands['snaptrack.revertChange'](); const e = vs._scm.edits[0];
  assert.equal(text.slice(0, e.r.start) + e.t + text.slice(e.r.end), 'a\nB\nc\n');
  // #8 hover tells which snapshot last changed a line
  const hv = (line) => vs._scm.hover.provideHover(doc, { line });
  assert.match(hv(1).contents.value, /Update index\.php/); assert.match(hv(0).contents.value, /Initial snapshot/); assert.match(hv(2).contents.value, /after the newest snapshot/);
  // #9 status bar: change count + last checkpoint + storage
  await vs._commands['snaptrack.refresh'](); assert.match(vs._scm.status.text, /SnapTrack: \d+ · \$\(save\) just now/); assert.match(vs._scm.status.tooltip, /Storage: [\d.]+ MB/);
  assert.ok(!calls.some(c => c[0] === 'error'), JSON.stringify(calls.filter(c => c[0] === 'error')));
  Module._load = orig;
});
