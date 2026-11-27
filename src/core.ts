// SnapTrack core: Git-style snapshots without Git. No VS Code dependency (used by the extension and the CLI).
//
// Layout inside the tracked folder:
//   .snaptrack/objects/ab/cdef...   file contents, zlib-compressed, named by SHA-1 (like Git blobs)
//   .snaptrack/commits.json         list of commits { id, parent, message, time, files: { "rel/path": sha } }
//   .snaptrack/index.json           cache: rel/path -> [size, mtimeMs, sha] so unchanged files are not re-hashed
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import * as os from 'os';
import { spawnSync } from 'child_process';

export type FileMap = Record<string, string>;
export interface Commit { id: string; parent: string | null; message: string; time: string; files: FileMap; auto?: boolean; pinned?: boolean; named?: boolean; }
export interface LineStats { add: number; del: number; binary?: boolean; }
export type ChangeKind = 'M' | 'A' | 'D';
export interface Change { path: string; kind: ChangeKind; oldSha?: string; newSha?: string; }
export interface StoreOptions { maxFileSizeMB?: number; exclude?: string[]; }

export const DIR = '.snaptrack';
export const ALWAYS_IGNORE = ['.snaptrack/', '.git/', 'node_modules/', '.DS_Store', 'Thumbs.db', 'desktop.ini'];

// ---------- ignore patterns (.gitignore-style subset: *, **, ?, trailing / for folders, leading / to anchor) ----------
function globToRegex(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}
export class Ignore {
  private rules: { re: RegExp; dirOnly: boolean; neg: boolean }[] = [];
  constructor(patterns: string[]) {
    for (let raw of patterns) {
      let p = raw.trim(); if (!p || p.startsWith('#')) continue;
      const neg = p.startsWith('!'); if (neg) p = p.slice(1);
      const dirOnly = p.endsWith('/'); if (dirOnly) p = p.slice(0, -1);
      const anchored = p.startsWith('/') || p.includes('/'); if (p.startsWith('/')) p = p.slice(1);
      const body = globToRegex(p);
      const re = new RegExp(anchored ? `^${body}(/.*)?$` : `(^|/)${body}(/.*)?$`);
      this.rules.push({ re, dirOnly, neg });
    }
  }
  /** rel: posix path relative to root; isDir: whether rel is a folder */
  ignores(rel: string, isDir: boolean): boolean {
    let ignored = false;
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) {
        // a folder rule also ignores everything inside that folder
        const parts = rel.split('/'); let hit = false;
        for (let i = 1; i < parts.length; i++) if (r.re.test(parts.slice(0, i).join('/'))) { hit = true; break; }
        if (!hit) continue; ignored = !r.neg; continue;
      }
      if (r.re.test(rel)) ignored = !r.neg;
    }
    return ignored;
  }
}

export function sha1(buf: Buffer): string { return crypto.createHash('sha1').update(buf).digest('hex'); }
export function isBinary(buf: Buffer): boolean { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) if (buf[i] === 0) return true; return false; }
const toPosix = (p: string) => p.split(path.sep).join('/');

function writeAtomic(file: string, data: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data); fs.renameSync(tmp, file);
}

export class Store {
  readonly root: string; readonly dir: string;
  private opts: Required<StoreOptions>;
  skipped: string[] = [];          // files left out by the size limit in the last scan
  constructor(root: string, opts: StoreOptions = {}) {
    this.root = root; this.dir = path.join(root, DIR);
    this.opts = { maxFileSizeMB: opts.maxFileSizeMB ?? 20, exclude: opts.exclude ?? [] };
  }
  setOptions(opts: StoreOptions) { this.opts = { ...this.opts, ...opts } as Required<StoreOptions>; }
  exists(): boolean { return fs.existsSync(path.join(this.dir, 'commits.json')); }

  // ---------- objects ----------
  private objPath(sha: string) { return path.join(this.dir, 'objects', sha.slice(0, 2), sha.slice(2)); }
  hasObject(sha: string) { return fs.existsSync(this.objPath(sha)); }
  writeObject(buf: Buffer): string { const s = sha1(buf); if (!this.hasObject(s)) writeAtomic(this.objPath(s), zlib.deflateSync(buf)); return s; }
  readObject(sha: string): Buffer { return zlib.inflateSync(fs.readFileSync(this.objPath(sha))); }

  // ---------- commits ----------
  commits(): Commit[] { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'commits.json'), 'utf8')); } catch { return []; } }
  private saveCommits(list: Commit[]) { writeAtomic(path.join(this.dir, 'commits.json'), JSON.stringify(list, null, 1)); }
  /** last confirmed commit (auto checkpoints are not the baseline) */
  head(): Commit | null { const c = this.commits(); for (let i = c.length - 1; i >= 0; i--) if (!c[i].auto) return c[i]; return null; }
  /** newest entry of any kind */
  latest(): Commit | null { const c = this.commits(); return c.length ? c[c.length - 1] : null; }
  log(): Commit[] { return this.commits().slice().reverse(); }
  getCommit(id: string): Commit | undefined { return this.commits().find(c => c.id === id || c.id.startsWith(id)); }

  // ---------- working tree scan ----------
  ignore(): Ignore {
    let fileRules: string[] = [];
    try { fileRules = fs.readFileSync(path.join(this.root, '.snaptrackignore'), 'utf8').split(/\r?\n/); } catch { /* none */ }
    return new Ignore([...ALWAYS_IGNORE, ...this.opts.exclude, ...fileRules]);
  }
  private loadIndex(): Record<string, [number, number, string]> { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')); } catch { return {}; } }
  /** Returns rel path -> sha for every tracked file on disk (hashing only files whose size/mtime changed). */
  scan(): FileMap {
    const ig = this.ignore(), index = this.loadIndex(), next: typeof index = {}, out: FileMap = {};
    const maxBytes = this.opts.maxFileSizeMB * 1024 * 1024, now = Date.now(); this.skipped = [];
    const walk = (abs: string) => {
      let entries: fs.Dirent[]; try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(abs, e.name), rel = toPosix(path.relative(this.root, full));
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!ig.ignores(rel, true)) walk(full); continue; }
        if (!e.isFile() || ig.ignores(rel, false)) continue;
        let st: fs.Stats; try { st = fs.statSync(full); } catch { continue; }
        if (st.size > maxBytes) { this.skipped.push(rel); continue; }
        const cached = index[rel];
        let s: string;
        if (cached && cached[0] === st.size && cached[1] === st.mtimeMs) s = cached[2];
        else { try { s = sha1(fs.readFileSync(full)); } catch { continue; } }
        out[rel] = s;
        // only cache files whose mtime is safely in the past: a rewrite with the same size inside the same mtime tick would otherwise be missed
        if (now - st.mtimeMs > 3000) next[rel] = [st.size, st.mtimeMs, s];
      }
    };
    walk(this.root);
    if (fs.existsSync(this.dir)) { try { writeAtomic(path.join(this.dir, 'index.json'), JSON.stringify(next)); } catch { /* cache only */ } }
    return out;
  }

  // ---------- status / diff ----------
  static compare(base: FileMap, cur: FileMap): Change[] {
    const ch: Change[] = [];
    for (const p of Object.keys(cur)) { if (!(p in base)) ch.push({ path: p, kind: 'A', newSha: cur[p] }); else if (base[p] !== cur[p]) ch.push({ path: p, kind: 'M', oldSha: base[p], newSha: cur[p] }); }
    for (const p of Object.keys(base)) if (!(p in cur)) ch.push({ path: p, kind: 'D', oldSha: base[p] });
    return ch.sort((a, b) => a.path.localeCompare(b.path));
  }
  status(): Change[] { const h = this.head(); return h ? Store.compare(h.files, this.scan()) : []; }
  /** what a commit changed compared with its parent (the confirmed commit it was based on) */
  commitChanges(id: string): Change[] { const c = this.getCommit(id); if (!c) return []; const p = c.parent ? this.getCommit(c.parent) : undefined; return Store.compare(p ? p.files : {}, c.files); }
  compareCommits(a: string, b: string): Change[] { const A = this.getCommit(a), B = this.getCommit(b); if (!A || !B) throw new Error('Commit not found.'); return Store.compare(A.files, B.files); }
  /** current files on disk compared with a commit */
  compareWithWorking(id: string): Change[] { const c = this.getCommit(id); if (!c) throw new Error('Commit not found.'); return Store.compare(c.files, this.scan()); }

  // ---------- write operations ----------
  init(message = 'Initial snapshot'): Commit {
    if (this.exists()) throw new Error('This folder is already tracked by SnapTrack.');
    fs.mkdirSync(path.join(this.dir, 'objects'), { recursive: true });
    writeAtomic(path.join(this.dir, 'README.txt'), 'SnapTrack data (snapshots of this folder). Delete this folder to stop tracking.\n');
    this.saveCommits([]);
    return this.commit(message, undefined, true);
  }
  /** Commit all changes, or only `paths` when given. Returns the new commit. */
  commit(message: string, paths?: string[], allowEmpty = false): Commit {
    const list = this.commits(), head = this.head();
    const cur = this.scan(), base: FileMap = head ? { ...head.files } : {};
    const changes = Store.compare(base, cur).filter(c => !paths || paths.includes(c.path));
    if (!changes.length && !allowEmpty) throw new Error('Nothing to commit.');
    for (const c of changes) {
      if (c.kind === 'D') { delete base[c.path]; continue; }
      const buf = fs.readFileSync(path.join(this.root, c.path));
      const s = this.writeObject(buf);       // hash again from the bytes we store, in case the file changed after the scan
      base[c.path] = s;
    }
    const time = new Date().toISOString();
    const id = sha1(Buffer.from(JSON.stringify({ parent: head?.id ?? null, message, time, files: base }))).slice(0, 12);
    const commit: Commit = { id, parent: head?.id ?? null, message: message.trim() || '(no message)', time, files: base };
    list.push(commit); this.saveCommits(list);
    return commit;
  }
  /** Automatic safety snapshot of everything on disk. Does NOT change the baseline (your Changes list stays the same).
   *  Returns null when nothing changed since the newest snapshot. */
  checkpoint(message?: string, opts: { named?: boolean } = {}): Commit | null {
    if (!this.exists()) return null;
    const list = this.commits(), head = this.head(), latest = this.latest(), cur = this.scan();
    const diff = Store.compare(latest ? latest.files : {}, cur); if (!diff.length && !opts.named) return null;   // a named checkpoint is saved even with no new changes
    const files: FileMap = { ...(latest ? latest.files : {}) };
    for (const c of diff) { if (c.kind === 'D') { delete files[c.path]; continue; } try { files[c.path] = this.writeObject(fs.readFileSync(path.join(this.root, c.path))); } catch { delete files[c.path]; } }
    const time = new Date().toISOString();
    const msg = message || `Auto checkpoint ${new Date().toLocaleString()}`;
    const id = sha1(Buffer.from(JSON.stringify({ parent: head?.id ?? null, msg, time, files, auto: true }))).slice(0, 12);
    const c: Commit = { id, parent: head?.id ?? null, message: msg, time, files, auto: true };
    if (opts.named) { c.named = true; c.pinned = true; }        // named checkpoints are kept by Clean Up
    list.push(c); this.saveCommits(list); return c;
  }
  /** Pinned entries are never removed by prune / Clean Up. */
  setPinned(id: string, pinned: boolean): Commit {
    const list = this.commits(), c = list.find(x => x.id === id || x.id.startsWith(id)); if (!c) throw new Error('Commit not found.');
    if (pinned) c.pinned = true; else delete c.pinned;
    this.saveCommits(list); return c;
  }
  /** Files that are in some snapshot but no longer on disk, newest first, with the last saved version of each. */
  deletedFiles(): { path: string; commit: Commit; sha: string }[] {
    const cur = this.scan(), ig = this.ignore(), seen = new Set<string>(), out: { path: string; commit: Commit; sha: string }[] = [];
    for (const c of this.log()) for (const [p, s] of Object.entries(c.files)) {
      if (seen.has(p)) continue; seen.add(p);
      if (!(p in cur) && !ig.ignores(p, false) && !fs.existsSync(path.join(this.root, p))) out.push({ path: p, commit: c, sha: s });
    }
    return out;
  }
  /** Make the files on disk look exactly like `id` (tracked scope only). The baseline does not move: the differences show as Changes. */
  restoreCommit(id: string): { written: number; deleted: number } {
    const c = this.getCommit(id); if (!c) throw new Error('Commit not found.');
    const cur = this.scan(); let written = 0, deleted = 0;
    for (const [p, s] of Object.entries(c.files)) if (cur[p] !== s) { const full = path.join(this.root, p); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, this.readObject(s)); written++; }
    for (const p of Object.keys(cur)) if (!(p in c.files)) { try { fs.unlinkSync(path.join(this.root, p)); deleted++; } catch { /* gone */ } }
    return { written, deleted };
  }
  /** Remove the last confirmed commit. Files on disk are untouched, so its changes come back as Changes. */
  undoLastCommit(): Commit {
    const list = this.commits(); let i = list.length - 1; while (i >= 0 && list[i].auto) i--;
    if (i < 0) throw new Error('Nothing to undo.'); const c = list[i];
    if (!c.parent) throw new Error("The first snapshot can't be undone. Delete the .snaptrack folder to stop tracking.");
    list.splice(i, 1); for (const x of list) if (x.parent === c.id) x.parent = c.parent;
    this.saveCommits(list); return c;
  }
  /** Delete old history and unused stored files. The newest commit is always kept. */
  prune(o: { allCheckpoints?: boolean; checkpointsOlderThanDays?: number; keepLastCommits?: number; maxCheckpoints?: number }): { commits: number; objects: number; bytes: number } {
    const list = this.commits(), head = this.head(), now = Date.now();
    const confirmed = list.filter(c => !c.auto); const keepIds = new Set((o.keepLastCommits ? confirmed.slice(-o.keepLastCommits) : confirmed).map(c => c.id));
    const unpinnedCps = list.filter(c => c.auto && !c.pinned); const newestCps = new Set((o.maxCheckpoints ? unpinnedCps.slice(-o.maxCheckpoints) : unpinnedCps).map(c => c.id));
    const kept = list.filter(c => {
      if (c.id === head?.id || c.pinned) return true;
      if (c.auto) { if (o.allCheckpoints) return false; if (o.checkpointsOlderThanDays != null && now - Date.parse(c.time) > o.checkpointsOlderThanDays * 86400000) return false; return newestCps.has(c.id); }
      return keepIds.has(c.id);
    });
    const ids = new Set(kept.map(c => c.id));
    for (const c of kept) if (c.parent && !ids.has(c.parent)) { const prev = kept.slice(0, kept.indexOf(c)).reverse().find(x => !x.auto); c.parent = prev ? prev.id : null; }
    const removed = list.length - kept.length; this.saveCommits(kept);
    const g = this.gc(); return { commits: removed, objects: g.objects, bytes: g.bytes };
  }
  /** delete stored file contents that no commit uses any more */
  gc(): { objects: number; bytes: number } {
    const used = new Set<string>(); for (const c of this.commits()) for (const s of Object.values(c.files)) used.add(s);
    let objects = 0, bytes = 0; const od = path.join(this.dir, 'objects');
    for (const d of fs.existsSync(od) ? fs.readdirSync(od) : []) for (const f of fs.readdirSync(path.join(od, d))) {
      if (f.endsWith('.tmp') || !used.has(d + f)) { const p = path.join(od, d, f); try { bytes += fs.statSync(p).size; fs.unlinkSync(p); objects++; } catch { /* busy */ } }
    }
    return { objects, bytes };
  }
  storageBytes(): number { let n = 0; const walk = (d: string) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else try { n += fs.statSync(p).size; } catch { /* */ } } }; walk(this.dir); return n; }
  /** content of the "new" side of a change: from the store when saved, else from disk */
  newContent(c: Change): Buffer { if (c.kind === 'D') return Buffer.alloc(0); if (c.newSha && this.hasObject(c.newSha)) return this.readObject(c.newSha); return fs.readFileSync(path.join(this.root, c.path)); }
  /** Git-style .patch text for a list of changes */
  patch(changes: Change[], fromDisk = true): string {
    let out = '';
    for (const c of changes) {
      const a = c.oldSha ? this.readObject(c.oldSha) : Buffer.alloc(0);
      const b = c.kind === 'D' ? Buffer.alloc(0) : (fromDisk ? this.newContent(c) : (c.newSha ? this.readObject(c.newSha) : Buffer.alloc(0)));
      out += `diff --snaptrack a/${c.path} b/${c.path}\n`;
      if (c.kind === 'A') out += 'new file\n'; if (c.kind === 'D') out += 'deleted file\n';
      if (isBinary(a) || isBinary(b)) { out += `Binary files a/${c.path} and b/${c.path} differ\n`; continue; }
      out += unifiedDiff(a.toString('utf8'), b.toString('utf8'), c.kind === 'A' ? '/dev/null' : `a/${c.path}`, c.kind === 'D' ? '/dev/null' : `b/${c.path}`);
    }
    return out;
  }
  /** a .zip (Buffer) with every file of a commit */
  zipCommit(id: string): Buffer { const c = this.getCommit(id); if (!c) throw new Error('Commit not found.'); return makeZip(Object.entries(c.files).map(([name, s]) => ({ name, data: this.readObject(s), mtime: new Date(c.time) }))); }

  /** Put a file back to how it was in `commitId` (default: last commit). Files that did not exist there are deleted. */
  restoreFile(rel: string, commitId?: string) {
    const c = commitId ? this.getCommit(commitId) : this.head(); if (!c) throw new Error('No commit to restore from.');
    const full = path.join(this.root, rel), s = c.files[rel];
    if (s) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, this.readObject(s)); }
    else if (fs.existsSync(full)) fs.unlinkSync(full);
  }
  discardAll(): number { const ch = this.status(); for (const c of ch) this.restoreFile(c.path); return ch.length; }
  fileHistory(rel: string): { commit: Commit; sha: string | null }[] {
    const out: { commit: Commit; sha: string | null }[] = []; let prev: string | null | undefined;
    for (const c of this.commits()) { const s = c.files[rel] ?? null; if (s !== prev && !(prev === undefined && s === null)) out.push({ commit: c, sha: s }); prev = s; }
    return out.reverse();
  }

  // ---------- line stats (+added / −deleted), cached in .snaptrack/stats.json ----------
  private statCache?: Record<string, [number, number] | 'b'>; private statTimer?: NodeJS.Timeout;
  private text(sha?: string): string | null { if (!sha) return ''; if (!this.hasObject(sha)) return null; const b = this.readObject(sha); return isBinary(b) ? null : b.toString('utf8'); }
  lineStats(c: Change): LineStats | undefined {
    const key = `${c.oldSha ?? ''}:${c.newSha ?? ''}`;
    if (!this.statCache) { try { this.statCache = JSON.parse(fs.readFileSync(path.join(this.dir, 'stats.json'), 'utf8')); } catch { this.statCache = {}; } }
    let v = this.statCache![key];
    if (v === undefined) {
      if ((c.oldSha && !this.hasObject(c.oldSha)) || (c.newSha && !this.hasObject(c.newSha))) return undefined;
      const a = this.text(c.oldSha), b = this.text(c.newSha);
      if (a === null || b === null) v = 'b';
      else { const A = a ? splitLines(a) : [], B = b ? splitLines(b) : []; let add = 0, del = 0; for (const h of lineHunks(A, B)) { add += h.bN; del += h.aN; } v = [add, del]; }
      this.statCache![key] = v;
      if (!this.statTimer) { this.statTimer = setTimeout(() => { this.statTimer = undefined; try { writeAtomic(path.join(this.dir, 'stats.json'), JSON.stringify(this.statCache)); } catch { /* cache only */ } }, 1000); this.statTimer.unref?.(); }
    }
    return v === 'b' ? { add: 0, del: 0, binary: true } : { add: v[0], del: v[1] };
  }
  /** what an entry changed: a commit vs its parent commit, a checkpoint vs the commit it was based on */
  entryChanges(c: Commit): Change[] { return c.auto ? this.compareCommits(c.parent ?? c.id, c.id) : this.commitChanges(c.id); }
  entryStats(c: Commit): LineStats { const t = { add: 0, del: 0 }; for (const x of this.entryChanges(c)) { const s = this.lineStats(x); if (s && !s.binary) { t.add += s.add; t.del += s.del; } } return t; }

  /** Turn the commit history (not checkpoints) into a new Git repository in `target` (must be new or empty), on branch "main".
   *  Needs Git installed. This project folder and its .git (if any) are never touched. */
  exportGit(target: string, git = 'git'): { commits: number } {
    const run = (args: string[], o: { cwd?: string; stdin?: number } = {}) => {
      const r = spawnSync(git, args, { cwd: o.cwd, stdio: [o.stdin ?? 'ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true });
      if (r.error) throw new Error((r.error as any).code === 'ENOENT' ? 'Git is not installed (or not on PATH). Install it from https://git-scm.com and try again.' : r.error.message);
      if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
      return r.stdout.trim();
    };
    const list = this.commits().filter(c => !c.auto); if (!list.length) throw new Error('Nothing to export: no commits yet.');
    target = path.resolve(target); const rel = path.relative(this.root, target);
    if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('Pick a folder outside this project.');
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`${target} is not empty. Pick a new or empty folder.`);
    run(['--version']);
    fs.mkdirSync(target, { recursive: true }); run(['init', '-q', target]); run(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: target });
    const cfg = (k: string) => { try { return run(['config', '--get', k], { cwd: target }); } catch { return ''; } };
    const who = `${cfg('user.name') || 'SnapTrack'} <${cfg('user.email') || 'snaptrack@localhost'}>`;
    const q = (p: string) => (/^"|[\n"\\]/.test(p) ? '"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"' : p);
    // fast-import stream, written to a temp file so big histories never sit in memory
    const tmp = path.join(os.tmpdir(), `snaptrack-git-${process.pid}-${Date.now()}.fi`), fd = fs.openSync(tmp, 'w');
    try {
      const out = (s: string | Buffer) => fs.writeSync(fd, typeof s === 'string' ? Buffer.from(s, 'utf8') : s);
      const marks = new Map<string, number>(); let mark = 0;
      for (const c of list) for (const s of Object.values(c.files)) if (!marks.has(s)) { const b = this.readObject(s); marks.set(s, ++mark); out(`blob\nmark :${mark}\ndata ${b.length}\n`); out(b); out('\n'); }
      list.forEach((c, i) => {
        const msg = Buffer.from(c.message + '\n', 'utf8'), when = `${Math.floor(Date.parse(c.time) / 1000)} +0000`;
        out(`commit refs/heads/main\nmark :${++mark}\nauthor ${who} ${when}\ncommitter ${who} ${when}\ndata ${msg.length}\n`); out(msg);
        if (i) out(`from :${mark - 1}\n`);
        out('deleteall\n'); for (const [p, s] of Object.entries(c.files)) out(`M 100644 :${marks.get(s)} ${q(p)}\n`); out('\n');
      });
      out('done\n'); fs.closeSync(fd);
      const inFd = fs.openSync(tmp, 'r'); try { run(['fast-import', '--quiet', '--done'], { cwd: target, stdin: inFd }); } finally { fs.closeSync(inFd); }
    } finally { try { fs.closeSync(fd); } catch { /* closed */ } try { fs.unlinkSync(tmp); } catch { /* */ } }
    run(['config', 'core.autocrlf', 'false'], { cwd: target });   // check out byte-for-byte what SnapTrack saved (no line-ending conversion)
    run(['reset', '--hard', '-q'], { cwd: target });     // put the newest commit's files in the folder
    return { commits: list.length };
  }

  /** For each line of `curText`, the snapshot that last changed it (null = changed since the newest snapshot). Looks back at most `max` versions. */
  blame(rel: string, curText: string, max = 50): (Commit | null)[] {
    let newer = splitLines(curText), newerC: Commit | null = null;
    const out: (Commit | null | undefined)[] = new Array(newer.length).fill(undefined), at = newer.map((_, i) => i);
    for (const v of this.fileHistory(rel).slice(0, max)) {
      const t = v.sha ? this.text(v.sha) : null;
      if (t === null) break;                                    // file did not exist (or was binary) before this: open lines come from `newerC`
      const older = splitLines(t), toOld = new Int32Array(newer.length).fill(-1); let ai = 0, bi = 0;
      for (const h of lineHunks(older, newer)) { while (bi < h.b0) toOld[bi++] = ai++; bi += h.bN; ai += h.aN; }
      while (bi < newer.length) toOld[bi++] = ai++;
      for (let k = 0; k < out.length; k++) if (out[k] === undefined) { const o = toOld[at[k]]; if (o < 0) out[k] = newerC; else at[k] = o; }
      newer = older; newerC = v.commit;
    }
    return out.map(x => (x === undefined ? newerC : x));
  }
}

// ---------- line diff (common prefix/suffix + LCS on the middle) ----------
export interface Hunk { a0: number; aN: number; b0: number; bN: number; }   // lines a0..a0+aN of A became lines b0..b0+bN of B (0-based)
export const splitLines = (t: string) => t.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
export function lineHunks(A: string[], B: string[]): Hunk[] {
  const n = A.length, m = B.length; let p = 0, s = 0;
  while (p < n && p < m && A[p] === B[p]) p++;
  while (s < n - p && s < m - p && A[n - 1 - s] === B[m - 1 - s]) s++;
  const a = A.slice(p, n - s), b = B.slice(p, m - s), N = a.length, M = b.length;
  if (!N && !M) return [];
  if (!N || !M || N * M > 4_000_000) return [{ a0: p, aN: N, b0: p, bN: M }];   // too big for a line-by-line match: one block
  const W = M + 1, L = new Uint32Array((N + 1) * W);
  for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
  const out: Hunk[] = []; let i = 0, j = 0, cur: Hunk | null = null;
  while (i < N || j < M) {
    if (i < N && j < M && a[i] === b[j]) { if (cur) out.push(cur); cur = null; i++; j++; continue; }
    if (!cur) cur = { a0: p + i, aN: 0, b0: p + j, bN: 0 };
    if (j >= M || (i < N && L[(i + 1) * W + j] >= L[i * W + j + 1])) { cur.aN++; i++; } else { cur.bN++; j++; }
  }
  if (cur) out.push(cur);
  return out;
}
/** The edit (character offsets in `cur`) that puts the changed block at `line` back to how it is in `base`, or null if that line is unchanged. */
export function revertAt(cur: string, base: string, line: number, eol = '\n'): { start: number; end: number; text: string } | null {
  const raw = cur.split('\n'), C = raw.map(l => (l.endsWith('\r') ? l.slice(0, -1) : l)), B = splitLines(base);
  const h = lineHunks(B, C).find(h => (h.bN ? line >= h.b0 && line < h.b0 + h.bN : line === h.b0 || line === h.b0 - 1));
  if (!h) return null;
  const off = (i: number) => { let o = 0; for (let k = 0; k < i; k++) o += raw[k].length + 1; return o; };
  const lines = B.slice(h.a0, h.a0 + h.aN);
  if (h.b0 + h.bN < raw.length) return { start: off(h.b0), end: off(h.b0 + h.bN), text: lines.map(l => l + eol).join('') };
  // the block runs to the end of the file, whose last line has no line break after it
  const start = h.b0 > 0 ? off(h.b0 - 1) + C[h.b0 - 1].length : 0;
  return { start, end: cur.length, text: (h.b0 > 0 && lines.length ? eol : '') + lines.join(eol) };
}

// ---------- unified diff (for the CLI and tests; VS Code uses its own diff editor) ----------
export function unifiedDiff(a: string, b: string, nameA = 'a', nameB = 'b', ctx = 3): string {
  const A = a.split('\n'), B = b.split('\n'), n = A.length, m = B.length;
  if (n * m > 25_000_000) return `--- ${nameA}\n+++ ${nameB}\n(file too large for a line diff)\n`;
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops: [string, string][] = []; let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) ops.push(['-', A[i++]]); else ops.push(['+', B[j++]]); }
  while (i < n) ops.push(['-', A[i++]]); while (j < m) ops.push(['+', B[j++]]);
  const out = [`--- ${nameA}`, `+++ ${nameB}`]; let k = 0, ai = 1, bi = 1;
  while (k < ops.length) {
    if (ops[k][0] === ' ') { k++; ai++; bi++; continue; }
    let s = Math.max(0, k - ctx); const sa = ai - (k - s), sb = bi - (k - s); let e = k, last = k;
    while (e < ops.length) { if (ops[e][0] !== ' ') last = e; else if (e - last > ctx * 2) break; e++; }
    e = Math.min(ops.length, last + ctx + 1);
    const hunk = ops.slice(s, e); const ca = hunk.filter(o => o[0] !== '+').length, cb = hunk.filter(o => o[0] !== '-').length;
    out.push(`@@ -${sa},${ca} +${sb},${cb} @@`); for (const [o, l] of hunk) out.push(o + l);
    for (let x = k; x < e; x++) { if (ops[x][0] !== '+') ai++; if (ops[x][0] !== '-') bi++; }
    k = e;
  }
  return out.join('\n') + '\n';
}

// ---------- minimal ZIP writer (deflate), no dependencies ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b: Buffer): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function makeZip(entries: { name: string; data: Buffer; mtime: Date }[]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), comp = zlib.deflateRawSync(e.data), crc = crc32(e.data), d = e.mtime;
    const dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(dt, 10); h.writeUInt16LE(dd, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(e.data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, name, comp);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(dt, 12); c.writeUInt16LE(dd, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(e.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
