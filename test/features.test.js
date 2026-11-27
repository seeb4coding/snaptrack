const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib'), cp = require('child_process');
const { Store } = require('../out/core.js');
const mk = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'snapf-')); fs.writeFileSync(path.join(r, 'a.txt'), 'one\n'); fs.writeFileSync(path.join(r, 'b.txt'), 'bee\n'); return r; };
const w = (r, f, t) => fs.writeFileSync(path.join(r, f), t);

test('checkpoint does not move the baseline; restoreCommit rolls the folder back', () => {
  const r = mk(), s = new Store(r); const c0 = s.init();
  w(r, 'a.txt', 'two\n'); const cp = s.checkpoint('cp'); assert.ok(cp.auto); assert.equal(s.head().id, c0.id); assert.equal(s.status().length, 1);
  assert.equal(s.checkpoint(), null, 'nothing new -> no checkpoint');
  w(r, 'c.txt', 'new'); fs.unlinkSync(path.join(r, 'b.txt')); const c1 = s.commit('more');
  assert.equal(c1.parent, c0.id); assert.deepEqual(s.commitChanges(c1.id).map(x => x.kind + x.path), ['M' + 'a.txt', 'D' + 'b.txt', 'A' + 'c.txt'].sort((a, b) => a.slice(1).localeCompare(b.slice(1))));
  const res = s.restoreCommit(c0.id); assert.deepEqual(res, { written: 2, deleted: 1 });
  assert.equal(fs.readFileSync(path.join(r, 'a.txt'), 'utf8'), 'one\n'); assert.ok(fs.existsSync(path.join(r, 'b.txt'))); assert.ok(!fs.existsSync(path.join(r, 'c.txt')));
  assert.equal(s.compareWithWorking(c0.id).length, 0); assert.equal(s.status().length, 3);
});
test('undoLastCommit keeps files, changes come back; first snapshot is protected', () => {
  const r = mk(), s = new Store(r); s.init(); w(r, 'a.txt', 'x\n'); s.commit('edit'); assert.equal(s.status().length, 0);
  const u = s.undoLastCommit(); assert.equal(u.message, 'edit'); assert.equal(s.status().length, 1); assert.equal(fs.readFileSync(path.join(r, 'a.txt'), 'utf8'), 'x\n');
  assert.throws(() => s.undoLastCommit(), /first snapshot/);
});
test('compareCommits, patch and zip export', () => {
  const r = mk(), s = new Store(r); const a = s.init(); w(r, 'a.txt', 'one\nmore\n'); const b = s.commit('b');
  assert.deepEqual(s.compareCommits(a.id, b.id).map(x => x.path), ['a.txt']);
  const p = s.patch(s.commitChanges(b.id)); assert.match(p, /^diff --snaptrack a\/a.txt b\/a.txt/); assert.match(p, /\n\+more/);
  const z = s.zipCommit(b.id); assert.equal(z.readUInt32LE(0), 0x04034b50);
  // check the first entry decompresses back
  const n = z.readUInt16LE(26), clen = z.readUInt32LE(18); const name = z.slice(30, 30 + n).toString(); const data = zlib.inflateRawSync(z.slice(30 + n, 30 + n + clen));
  assert.equal(data.toString(), fs.readFileSync(path.join(r, name), 'utf8'));
  try { const out = cp.execFileSync('unzip', ['-l', '-'], { input: z }).toString(); } catch { /* unzip may not read stdin */ }
});
test('prune removes checkpoints / old commits and garbage collects objects', () => {
  const r = mk(), s = new Store(r); s.init();
  for (let i = 0; i < 3; i++) { w(r, 'a.txt', 'v' + i + '\n'); s.checkpoint(); }
  w(r, 'big.txt', 'x'.repeat(5000)); s.checkpoint(); fs.unlinkSync(path.join(r, 'big.txt')); w(r, 'a.txt', 'final\n');
  const before = s.storageBytes(); const res = s.prune({ allCheckpoints: true }); assert.equal(res.commits, 4); assert.ok(res.objects >= 4); assert.ok(s.storageBytes() < before);
  for (let i = 0; i < 5; i++) { w(r, 'a.txt', 'c' + i + '\n'); s.commit('c' + i); }
  s.prune({ keepLastCommits: 2 }); const log = s.log(); assert.deepEqual(log.map(c => c.message), ['c4', 'c3']); assert.equal(log[1].parent, null);
  assert.equal(s.status().length, 0); assert.equal(s.readObject(s.head().files['a.txt']).toString(), 'c4\n');
});
test('CLI: checkpoint, undo, restore-all, export, prune', () => {
  const r = mk(); const run = (...a) => cp.execFileSync('node', [path.join(__dirname, '../out/cli.js'), ...a], { cwd: r, env: { ...process.env, NO_COLOR: '1' } }).toString();
  run('init'); w(r, 'a.txt', 'changed\n'); assert.match(run('checkpoint'), /Checkpoint/); run('commit', '-m', 'edit', '-y');
  const first = run('log').trim().split('\n').pop().split(' ')[0];
  assert.match(run('restore-all', first, '-y'), /Restored: 1 written/); assert.equal(fs.readFileSync(path.join(r, 'a.txt'), 'utf8'), 'one\n');
  assert.match(run('export', 'patch', '-o', 'x.patch'), /Wrote/); assert.match(fs.readFileSync(path.join(r, 'x.patch'), 'utf8'), /-changed/);
  assert.match(run('export', 'zip', first, '-o', path.join(os.tmpdir(), 'cli-' + Date.now() + '.zip')), /Wrote/);
  assert.match(run('undo', '-y'), /Undid/); assert.match(run('prune', '--checkpoints', '-y'), /Removed 1 entry/);
});
