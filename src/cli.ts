#!/usr/bin/env node
// SnapTrack CLI: same engine as the VS Code extension.
//   snaptrack init | status | diff [file] | commit -m "msg" [files...] | log | show <id> | discard <file...|--all> | restore <file> <id>
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { Store, unifiedDiff, isBinary, Change } from './core';

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m' };
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c: string, s: string) => (color ? c + s + C.x : s);
const KCOL: Record<string, string> = { M: C.y, A: C.g, D: C.r };

function findRoot(start: string): string { let d = start; for (;;) { if (fs.existsSync(path.join(d, '.snaptrack', 'commits.json'))) return d; const p = path.dirname(d); if (p === d) return start; d = p; } }
function ask(q: string): Promise<boolean> { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); return new Promise(r => rl.question(q + ' [y/N] ', a => { rl.close(); r(/^y(es)?$/i.test(a.trim())); })); }
function printDiff(store: Store, c: Change) {
  const old = c.oldSha ? store.readObject(c.oldSha) : Buffer.alloc(0);
  const cur = c.kind === 'D' ? Buffer.alloc(0) : c.newSha && store.hasObject(c.newSha) ? store.readObject(c.newSha) : fs.readFileSync(path.join(store.root, c.path));
  console.log(paint(C.b, `snaptrack diff ${c.path}`));
  if (isBinary(old) || isBinary(cur)) { console.log(`Binary file ${c.kind === 'A' ? 'added' : c.kind === 'D' ? 'deleted' : 'changed'}\n`); return; }
  for (const line of unifiedDiff(old.toString('utf8'), cur.toString('utf8'), c.kind === 'A' ? '/dev/null' : `a/${c.path}`, c.kind === 'D' ? '/dev/null' : `b/${c.path}`).split('\n')) {
    console.log(line.startsWith('+') && !line.startsWith('+++') ? paint(C.g, line) : line.startsWith('-') && !line.startsWith('---') ? paint(C.r, line) : line.startsWith('@@') ? paint(C.c, line) : line);
  }
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const store = new Store(findRoot(process.cwd()));
  const need = () => { if (!store.exists()) { console.error('Not tracked yet. Run: snaptrack init'); process.exit(1); } };
  switch (cmd) {
    case 'init': { const c = store.init(); console.log(`Tracking ${Object.keys(c.files).length} file(s) in ${store.root}` + (store.skipped.length ? ` (${store.skipped.length} big file(s) skipped)` : '')); break; }
    case 'status': case 'st': { need(); const ch = store.status(); if (!ch.length) { console.log('Nothing changed since the last commit.'); break; }
      console.log(`${ch.length} change(s) since "${store.head()!.message}":`); for (const c of ch) console.log('  ' + paint(KCOL[c.kind], `${c.kind}  ${c.path}`)); break; }
    case 'diff': { need(); const ch = store.status().filter(c => !rest.length || rest.some(r => c.path === r.split(path.sep).join('/'))); if (!ch.length) console.log('No changes.'); for (const c of ch) printDiff(store, c); break; }
    case 'commit': case 'ci': { need(); const mi = rest.indexOf('-m'); const msg = mi >= 0 ? rest[mi + 1] : ''; const files = rest.filter((f, i) => i !== mi && i !== mi + 1 && f !== '-y').map(f => f.split(path.sep).join('/'));
      if (!msg) { console.error('Usage: snaptrack commit -m "message" [files...]'); process.exit(1); }
      const ch = store.status().filter(c => !files.length || files.includes(c.path)); if (!ch.length) { console.log('Nothing to commit.'); break; }
      for (const c of ch) console.log('  ' + paint(KCOL[c.kind], `${c.kind}  ${c.path}`));
      if (!rest.includes('-y') && !(await ask(`Commit these ${ch.length} change(s)?`))) { console.log('Cancelled.'); break; }
      const c = store.commit(msg, files.length ? files : undefined); console.log(`Committed ${c.id.slice(0, 7)} "${c.message}"`); break; }
    case 'log': { need(); const hid = store.head()?.id; for (const c of store.log()) console.log(`${paint(C.y, c.id.slice(0, 7))} ${paint(C.d, new Date(c.time).toLocaleString())}  ${c.auto ? paint(C.d, '[checkpoint] ') : ''}${c.message}${c.id === hid ? paint(C.g, '  (HEAD)') : ''}`); break; }
    case 'show': { need(); const c = store.getCommit(rest[0] || ''); if (!c) { console.error('Commit not found.'); process.exit(1); }
      console.log(paint(C.b, `${c.id.slice(0, 7)} ${c.message}`)); for (const x of store.commitChanges(c.id)) printDiff(store, x); break; }
    case 'discard': { need(); const want = rest.map(f => f.split(path.sep).join('/')); const ch = rest.includes('--all') ? store.status() : store.status().filter(c => want.includes(c.path)); if (!ch.length) { console.log('Nothing to discard.'); break; }
      for (const c of ch) console.log('  ' + paint(KCOL[c.kind], `${c.kind}  ${c.path}`));
      if (!rest.includes('-y') && !(await ask(`Discard these ${ch.length} change(s)? This cannot be undone.`))) { console.log('Cancelled.'); break; }
      for (const c of ch) store.restoreFile(c.path); console.log('Discarded.'); break; }
    case 'restore': { need(); if (rest.length < 2) { console.error('Usage: snaptrack restore <file> <commit-id>'); process.exit(1); } store.restoreFile(rest[0], rest[1]); console.log(`Restored ${rest[0]}.`); break; }
    case 'checkpoint': case 'cp': { need(); const c = store.checkpoint(rest.join(' ') || undefined); console.log(c ? `Checkpoint ${c.id.slice(0, 7)} saved` : 'Nothing new to checkpoint.'); break; }
    case 'compare': { need(); if (!rest[0]) { console.error('Usage: snaptrack compare <id> [<id2>]   (one id = compare with the files now)'); process.exit(1); }
      const ch = rest[1] ? store.compareCommits(rest[0], rest[1]) : store.compareWithWorking(rest[0]); if (!ch.length) { console.log('No differences.'); break; }
      for (const c of ch) console.log('  ' + paint(KCOL[c.kind], `${c.kind}  ${c.path}`)); break; }
    case 'restore-all': case 'reset': { need(); const c = store.getCommit(rest[0] || ''); if (!c) { console.error('Usage: snaptrack restore-all <commit-id>'); process.exit(1); }
      const ch = store.compareWithWorking(c.id); if (!ch.length) { console.log('Files already match.'); break; }
      for (const x of ch) console.log('  ' + paint(KCOL[x.kind], `${x.kind}  ${x.path}`));
      if (!rest.includes('-y') && !(await ask(`Restore the whole project to "${c.message}"? (${ch.length} file(s) change; a checkpoint is saved first)`))) { console.log('Cancelled.'); break; }
      const cp = store.checkpoint(`Before restoring project to ${c.id.slice(0, 7)}`); const r = store.restoreCommit(c.id);
      console.log(`Restored: ${r.written} written, ${r.deleted} removed.` + (cp ? ` Undo with: snaptrack restore-all ${cp.id.slice(0, 7)}` : '')); break; }
    case 'undo': { need(); const h = store.head()!; if (!rest.includes('-y') && !(await ask(`Undo commit "${h.message}"? Files stay as they are.`))) { console.log('Cancelled.'); break; }
      const c = store.undoLastCommit(); console.log(`Undid ${c.id.slice(0, 7)} "${c.message}". Its changes are back in: snaptrack status`); break; }
    case 'export': { need(); const oi = rest.indexOf('-o'); const out = oi >= 0 ? rest[oi + 1] : ''; const args = rest.filter((_, i) => i !== oi && i !== oi + 1);
      const kind = args[0]; const id = args[1];
      if (kind === 'zip') { const c = store.getCommit(id || store.head()!.id); if (!c) { console.error('Commit not found.'); process.exit(1); } const f = out || `${path.basename(store.root)}-${c.id.slice(0, 7)}.zip`; fs.writeFileSync(f, store.zipCommit(c.id)); console.log(`Wrote ${f}`); break; }
      if (kind === 'patch') { const ch = id ? store.commitChanges(id) : store.status(); if (!ch.length) { console.log('Nothing to export.'); break; } const txt = store.patch(ch); if (out) { fs.writeFileSync(out, txt); console.log(`Wrote ${out}`); } else process.stdout.write(txt); break; }
      console.error('Usage: snaptrack export patch [id] [-o file.patch] | export zip [id] [-o file.zip]'); process.exit(1); }
    case 'prune': case 'gc': { need(); const o: any = {}; if (rest.includes('--checkpoints')) o.allCheckpoints = true; const di = rest.indexOf('--older'); if (di >= 0) o.checkpointsOlderThanDays = +rest[di + 1]; const ki = rest.indexOf('--keep'); if (ki >= 0) o.keepLastCommits = +rest[ki + 1];
      const b = store.storageBytes(); if (Object.keys(o).length && !rest.includes('-y') && !(await ask('Delete this history? It cannot be brought back.'))) { console.log('Cancelled.'); break; }
      const r = store.prune(o); console.log(`Removed ${r.commits} entr${r.commits === 1 ? 'y' : 'ies'}, ${r.objects} unused object(s). ${(b / 1048576).toFixed(2)} MB → ${(store.storageBytes() / 1048576).toFixed(2)} MB`); break; }
    default: console.log('SnapTrack: Git-style change tracking without Git\n\n  snaptrack init                      start tracking this folder\n  snaptrack status                    list changed files (M / A / D)\n  snaptrack diff [file]               show Git-style diffs\n  snaptrack commit -m "msg" [files]   confirm changes as a new snapshot\n  snaptrack discard <file|--all>      throw changes away\n  snaptrack log                       list commits\n  snaptrack show <id>                 diffs of one commit\n  snaptrack restore <file> <id>       bring back an old version of one file\n  snaptrack restore-all <id>          roll the whole project back (checkpoint first)\n  snaptrack undo                      undo the last commit, keep the changes\n  snaptrack checkpoint [msg]          save a checkpoint (does not move the baseline)\n  snaptrack compare <id> [id2]        list differences (with now, or between commits)\n  snaptrack export patch [id] -o f    write a .patch (current changes or a commit)\n  snaptrack export zip [id] -o f      write a .zip of a commit\n  snaptrack prune [--checkpoints] [--older D] [--keep N]   clean up storage');
  }
}
main(process.argv.slice(2)).catch(e => { console.error('snaptrack: ' + (e?.message ?? e)); process.exit(1); });
