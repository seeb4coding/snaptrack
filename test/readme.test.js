const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');

test('README "Command line" section lists every CLI command handled in src/cli.ts', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'cli.ts'), 'utf8');
  // first label of each `case 'x': case 'alias':` group is the command's main name
  const cmds = [...src.matchAll(/^\s*case '([^']+)':/gm)].map(m => m[1]);
  assert.ok(cmds.length >= 14, 'found the CLI switch');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const sec = readme.slice(readme.indexOf('## Command line'));
  const block = sec.split('```')[3] || '';   // the second code block: the command list
  const listed = new Set(block.split('\n').map(l => l.trim().split(/\s+/)[1]).filter(Boolean));
  const missing = cmds.filter(c => !listed.has(c));
  assert.deepEqual(missing, [], 'missing from README: ' + missing.join(', '));
  for (const k of ['patch', 'zip']) assert.match(block, new RegExp(`^snaptrack export ${k} `, 'm'));
});
