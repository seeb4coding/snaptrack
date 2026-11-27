const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { Store, Ignore, unifiedDiff } = require('../out/core.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
const w = (d, f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };

test('init, modify, add, delete, commit cycle', () => {
  const d = tmp(); w(d, 'a.txt', 'one\ntwo\n'); w(d, 'src/b.js', 'x=1\n'); w(d, 'gone.txt', 'bye');
  const s = new Store(d); const c0 = s.init();
  assert.equal(Object.keys(c0.files).length, 3); assert.deepEqual(s.status(), []);
  w(d, 'a.txt', 'one\nTWO\n'); w(d, 'new.md', '# hi'); fs.unlinkSync(path.join(d, 'gone.txt'));
  assert.deepEqual(s.status().map(c => c.kind + c.path), ['Ma.txt', 'Dgone.txt', 'Anew.md']);
  const c1 = s.commit('my change'); assert.equal(c1.parent, c0.id); assert.deepEqual(s.status(), []);
  assert.deepEqual(s.commitChanges(c1.id).map(c => c.kind + c.path).sort(), ['Anew.md', 'Dgone.txt', 'Ma.txt']);
  assert.equal(s.log()[0].message, 'my change');
  assert.throws(() => s.commit('again'), /Nothing to commit/);
});
test('commit only selected paths keeps the rest as changes', () => {
  const d = tmp(); w(d, 'a', '1'); w(d, 'b', '1'); const s = new Store(d); s.init();
  w(d, 'a', '2'); w(d, 'b', '2'); s.commit('only a', ['a']);
  assert.deepEqual(s.status().map(c => c.path), ['b']);
});
test('discard restores modified, recreates deleted, deletes added', () => {
  const d = tmp(); w(d, 'm', 'orig'); w(d, 'del', 'keep'); const s = new Store(d); s.init();
  w(d, 'm', 'changed'); fs.unlinkSync(path.join(d, 'del')); w(d, 'added', 'x');
  assert.equal(s.discardAll(), 3);
  assert.equal(fs.readFileSync(path.join(d, 'm'), 'utf8'), 'orig'); assert.equal(fs.readFileSync(path.join(d, 'del'), 'utf8'), 'keep'); assert.ok(!fs.existsSync(path.join(d, 'added')));
  assert.deepEqual(s.status(), []);
});
test('history + restore old version of a file', () => {
  const d = tmp(); w(d, 'f.txt', 'v1'); const s = new Store(d); const c0 = s.init();
  w(d, 'f.txt', 'v2'); s.commit('v2'); w(d, 'f.txt', 'v3'); s.commit('v3');
  const h = s.fileHistory('f.txt'); assert.deepEqual(h.map(x => x.commit.message), ['v3', 'v2', 'Initial snapshot']);
  s.restoreFile('f.txt', c0.id); assert.equal(fs.readFileSync(path.join(d, 'f.txt'), 'utf8'), 'v1');
  assert.deepEqual(s.status().map(c => c.kind), ['M']);
});
test('ignores: .snaptrack, .git, node_modules, size limit, .snaptrackignore, folder rules', () => {
  const d = tmp(); w(d, 'keep.txt', 'k'); w(d, '.git/HEAD', 'x'); w(d, 'node_modules/p/i.js', 'x'); w(d, 'build/out.bin', 'x'); w(d, 'logs/a.log', 'x'); w(d, 'deep/x/tmp.log', 'x');
  w(d, 'big.mp4', Buffer.alloc(2 * 1024 * 1024)); w(d, '.snaptrackignore', 'build/\n*.log\n');
  const s = new Store(d, { maxFileSizeMB: 1 }); const c = s.init();
  assert.deepEqual(Object.keys(c.files).sort(), ['.snaptrackignore', 'keep.txt']); assert.deepEqual(s.skipped, ['big.mp4']);
  const ig = new Ignore(['src/*.tmp', '!src/keep.tmp']); assert.ok(ig.ignores('src/a.tmp', false)); assert.ok(!ig.ignores('src/keep.tmp', false)); assert.ok(!ig.ignores('other/a.tmp', false));
});
test('binary files and objects are deduplicated + compressed', () => {
  const d = tmp(); w(d, 'img.bin', Buffer.from([0, 1, 2, 3, 0])); w(d, 'copy.txt', 'same'); w(d, 'copy2.txt', 'same');
  const s = new Store(d); const c = s.init(); assert.equal(c.files['copy.txt'], c.files['copy2.txt']);
  assert.deepEqual([...s.readObject(c.files['img.bin'])], [0, 1, 2, 3, 0]);
});
test('unified diff output looks like git', () => {
  const out = unifiedDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n', 'a/f', 'b/f');
  assert.match(out, /^--- a\/f\n\+\+\+ b\/f\n@@ -1,5 \+1,6 @@\n a\n-b\n\+B\n c\n d\n\+e\n/);
});
test('index cache: unchanged files are not re-read', () => {
  const d = tmp(); w(d, 'x', '1'); const s = new Store(d); s.init();
  const t = new Date(Date.now() - 100000); fs.utimesSync(path.join(d, 'x'), t, t); s.scan();
  w(d, 'x', '2'); assert.deepEqual(s.status().map(c => c.kind), ['M']);   // content + mtime changed -> detected
});
test('index cache: a same-size rewrite right after a scan is still detected', () => {
  const d = tmp(); w(d, 'f.txt', 'v1'); const s = new Store(d); s.init();
  const p = path.join(d, 'f.txt'), t = new Date();
  w(d, 'f.txt', 'v2'); fs.utimesSync(p, t, t); s.scan();          // cache sees v2 at mtime t
  w(d, 'f.txt', 'v3'); fs.utimesSync(p, t, t);                    // same size, same mtime
  assert.equal(s.readObject(s.commit('v3').files['f.txt']).toString(), 'v3');
});
