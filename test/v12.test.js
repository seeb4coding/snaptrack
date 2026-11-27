// 1.2 features in the core: pin / named checkpoints, auto-cleanup limits, recently deleted, line stats, blame, revert block.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { Store, lineHunks, revertAt, splitLines } = require('../out/core.js');
const mk = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'snap12-')); fs.writeFileSync(path.join(r, 'a.txt'), 'one\ntwo\nthree\n'); return r; };
const w = (r, f, t) => fs.writeFileSync(path.join(r, f), t);
const apply = (cur, e) => (e ? cur.slice(0, e.start) + e.text + cur.slice(e.end) : cur);

test('named checkpoints are pinned and saved even with nothing new; pinned entries survive prune', () => {
  const r = mk(), s = new Store(r); s.init();
  const n = s.checkpoint('before refactor', { named: true }); assert.ok(n.named && n.pinned && n.auto);
  w(r, 'a.txt', 'x\n'); const cp1 = s.checkpoint('cp1'); w(r, 'a.txt', 'y\n'); const cp2 = s.checkpoint('cp2'); w(r, 'a.txt', 'z\n'); const cp3 = s.checkpoint('cp3');
  s.setPinned(cp1.id, true);
  s.prune({ maxCheckpoints: 1 });          // keeps the newest unpinned checkpoint + every pinned one
  assert.deepEqual(s.commits().filter(c => c.auto).map(c => c.message), ['before refactor', 'cp1', 'cp3']);
  s.setPinned(cp1.id, false); s.prune({ allCheckpoints: true });
  assert.deepEqual(s.commits().filter(c => c.auto).map(c => c.message), ['before refactor']);
  assert.ok(cp2);
});

test('deletedFiles lists files from history that are gone from disk, with their last version', () => {
  const r = mk(), s = new Store(r); s.init(); w(r, 'b.txt', 'v1'); s.commit('add b'); w(r, 'b.txt', 'v2'); s.checkpoint('cp');
  fs.unlinkSync(path.join(r, 'b.txt')); fs.unlinkSync(path.join(r, 'a.txt'));
  const d = s.deletedFiles(); assert.deepEqual(d.map(x => x.path).sort(), ['a.txt', 'b.txt']);
  const b = d.find(x => x.path === 'b.txt'); assert.equal(s.readObject(b.sha).toString(), 'v2'); assert.equal(b.commit.message, 'cp');
  s.restoreFile('b.txt', b.commit.id); assert.equal(fs.readFileSync(path.join(r, 'b.txt'), 'utf8'), 'v2');
  assert.deepEqual(s.deletedFiles().map(x => x.path), ['a.txt']);
});

test('line stats count added / deleted lines and mark binary files', () => {
  const r = mk(), s = new Store(r); s.init();
  w(r, 'a.txt', 'one\nTWO\nthree\nfour\n'); w(r, 'bin.dat', Buffer.from([0, 1, 2])); const c = s.commit('edit');
  const st = Object.fromEntries(s.entryChanges(c).map(x => [x.path, s.lineStats(x)]));
  assert.deepEqual(st['a.txt'], { add: 2, del: 1 }); assert.ok(st['bin.dat'].binary);
  assert.deepEqual(s.entryStats(c), { add: 2, del: 1 });
});

test('blame: each line points at the snapshot that last changed it', () => {
  const r = mk(), s = new Store(r); const c0 = s.init();
  w(r, 'a.txt', 'one\nTWO\nthree\n'); const c1 = s.commit('caps');
  w(r, 'a.txt', 'one\nTWO\nthree\nfour\n'); const cp = s.checkpoint('cp');
  const b = s.blame('a.txt', 'one\nTWO\nthree\nfour\nfive\n');
  assert.deepEqual(b.map(x => x && x.message), ['Initial snapshot', 'caps', 'Initial snapshot', 'cp', null, 'Initial snapshot']);
  assert.ok(c0 && c1 && cp);
});

test('revertAt puts one changed block back, leaving the others alone', () => {
  const base = 'a\nb\nc\nd\ne\n', cur = 'a\nB\nc\nd\nE\nnew\n';
  assert.equal(apply(cur, revertAt(cur, base, 1)), 'a\nb\nc\nd\nE\nnew\n');
  assert.equal(apply(cur, revertAt(cur, base, 5)), 'a\nB\nc\nd\ne\n');
  assert.equal(revertAt(cur, base, 0), null);
  assert.equal(apply('a\r\nX\r\nc', revertAt('a\r\nX\r\nc', 'a\r\nb\r\nc', 1, '\r\n')), 'a\r\nb\r\nc');
  assert.equal(apply('a\nX', revertAt('a\nX', 'a', 1)), 'a');                // added last line, no trailing newline
  assert.equal(apply('a', revertAt('a', 'a\nX', 0)), 'a\nX');                // deleted last line comes back
  assert.deepEqual(lineHunks(splitLines('x\ny'), splitLines('x\ny')), []);
});

test('exportGit: commits (not checkpoints) become a Git repo with the same files and messages', (t) => {
  if (require('child_process').spawnSync('git', ['--version']).error) return t.skip('git not installed');
  const r = mk(), s = new Store(r); s.init(); w(r, 'b c.txt', 'space\n'); w(r, 'café menu.txt', 'q'); s.commit('add files');
  w(r, 'a.txt', 'changed\n'); s.checkpoint('cp'); fs.mkdirSync(path.join(r, 'sub')); w(r, 'sub/x.bin', Buffer.from([0, 1, 2])); fs.unlinkSync(path.join(r, 'b c.txt')); s.commit('second');
  assert.throws(() => s.exportGit(path.join(r, 'inside')), /outside this project/);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'snapgit-')), dest = path.join(out, 'repo');
  assert.deepEqual(s.exportGit(dest), { commits: 3 });
  const git = (...a) => require('child_process').execFileSync('git', a, { cwd: dest, encoding: 'utf8' }).trim();
  assert.deepEqual(git('log', '--format=%s').split('\n'), ['second', 'add files', 'Initial snapshot']);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main'); assert.equal(git('status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'changed\n'); assert.ok(!fs.existsSync(path.join(dest, 'b c.txt')));
  assert.deepEqual(fs.readFileSync(path.join(dest, 'sub', 'x.bin')), Buffer.from([0, 1, 2])); assert.equal(fs.readFileSync(path.join(dest, 'café menu.txt'), 'utf8'), 'q');
  assert.equal(git('show', 'HEAD~1:b c.txt'), 'space');
  assert.ok(!fs.existsSync(path.join(r, '.git')), 'the tracked folder gets no .git');
  assert.throws(() => s.exportGit(dest), /not empty/);
});
