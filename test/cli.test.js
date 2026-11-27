const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'); const { execFileSync } = require('child_process');
const CLI = path.join(__dirname, '..', 'out', 'cli.js');
const run = (cwd, ...a) => execFileSync('node', [CLI, ...a], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
test('cli: init, status, diff, commit -y, log, discard', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'snapcli-'));
  fs.writeFileSync(path.join(d, 'app.py'), 'print("hi")\nx = 1\n');
  assert.match(run(d, 'init'), /Tracking 1 file/);
  fs.writeFileSync(path.join(d, 'app.py'), 'print("hello")\nx = 1\n'); fs.writeFileSync(path.join(d, 'new.txt'), 'n');
  assert.match(run(d, 'status'), /M {2}app\.py[\s\S]*A {2}new\.txt/);
  const diff = run(d, 'diff', 'app.py'); assert.match(diff, /-print\("hi"\)\n\+print\("hello"\)/);
  assert.match(run(d, 'commit', '-m', 'greeting', '-y'), /Committed [0-9a-f]{7} "greeting"/);
  assert.match(run(d, 'status'), /Nothing changed/);
  assert.match(run(d, 'log'), /greeting[\s\S]*Initial snapshot/);
  fs.writeFileSync(path.join(d, 'app.py'), 'oops'); run(d, 'discard', '--all', '-y');
  assert.equal(fs.readFileSync(path.join(d, 'app.py'), 'utf8'), 'print("hello")\nx = 1\n');
  fs.mkdirSync(path.join(d, 'sub')); assert.match(run(path.join(d, 'sub'), 'status'), /Nothing changed/);   // finds root from a subfolder
});
