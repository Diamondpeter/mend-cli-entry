// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the three-tier line matching of section 5, unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// of section 10. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// How it is put together: each format's reader turns the patch into a list of edits (section 10's order), and an
// edit is a closure that either rewrites its paths in the in-memory tree or throws Fail with the section 2 code for
// the path it concerns. Readers throw Exit2 for the exit-2 lines, which are all decided before any file is looked
// at. Nothing reaches the disk unless every edit succeeded, and the lines printed on success are computed from the
// tree's before-and-after states, with a successful move's D and A lines folded into its R line.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Successful move edits, for the `R` lines of section 2. Reset by run(). */
const moves: { old: string; neo: string }[] = [];

// ---------- files and lines (section 3) ----------

interface WorkFile {
  lines: string[];
  br: string;
  final: boolean;
}

function fileModel(text: string): WorkFile {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, final: fin };
}

function serialize(w: WorkFile): string {
  return w.lines.length === 0 ? '' : w.lines.join(w.br) + (w.final ? w.br : '');
}

// ---------- matching lines (section 5) ----------

const trimEndWT = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWT = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

function eqLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWT(a) === trimEndWT(b);
  return trimWT(a) === trimWT(b);
}

function tierList(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

function occurrences(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!eqLine(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  for (const tier of tierList(strict)) {
    const positions = occurrences(lines, O, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

type BodyLine = { kind: ' ' | '-' | '+' | '\\'; text: string };
type NEnt = { ctx: number } | { lit: string };

function buildON(body: BodyLine[]): { O: string[]; N: NEnt[] } {
  const O: string[] = [];
  const N: NEnt[] = [];
  for (const e of body) {
    if (e.kind === ' ') {
      O.push(e.text);
      N.push({ ctx: O.length - 1 });
    } else if (e.kind === '-') O.push(e.text);
    else if (e.kind === '+') N.push({ lit: e.text });
  }
  return { O, N };
}

function buildReplacement(lines: string[], pos: number, O: string[], N: NEnt[], tier: number): string[] {
  const F = leadWS(lines[pos] ?? '');
  const P = leadWS(O[0] ?? '');
  return N.map((n) => {
    if ('ctx' in n) return lines[pos + n.ctx]!;
    if (tier !== 2) return n.lit;
    if (n.lit === '' || trimWT(n.lit) === '') return n.lit;
    return n.lit.startsWith(P) ? F + n.lit.slice(P.length) : n.lit;
  });
}

/** Whether a `\` line follows the body's last context or `+` line. */
function noBreakAfter(body: BodyLine[]): boolean {
  for (let j = body.length - 1; j >= 0; j--) {
    const k = body[j]!.kind;
    if (k === ' ' || k === '+') return body[j + 1]?.kind === '\\';
  }
  return false;
}

// ---------- detecting the format (section 4) ----------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- JSON edits (section 9) ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- unified diffs (section 6) ----------

interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  gitOld?: string;
  gitNew?: string;
  minus?: string;
  plus?: string;
  renOld?: string;
  renNew?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function applyHunk(w: WorkFile, h: Hunk, d: number, strict: boolean, path: string): number {
  const { O, N } = buildON(h.body);
  const nb = noBreakAfter(h.body);
  if (O.length === 0) {
    const idx = Math.max(0, Math.min(h.a + d, w.lines.length));
    const ins = N.map((n) => ('lit' in n ? n.lit : ''));
    const atEnd = idx === w.lines.length;
    w.lines.splice(idx, 0, ...ins);
    if (atEnd) w.final = !nb;
    return d + ins.length;
  }
  const target = h.a - 1 + d;
  for (const tier of tierList(strict)) {
    const positions = occurrences(w.lines, O, tier);
    if (positions.length === 0) continue;
    let best = positions[0]!;
    for (const p of positions) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    const repl = buildReplacement(w.lines, best, O, N, tier);
    const atEnd = best + O.length === w.lines.length;
    w.lines.splice(best, O.length, ...repl);
    if (atEnd) w.final = !nb;
    return d + N.length - O.length;
  }
  throw new Fail('no-match', path);
}

// The reader walks the patch once. A section opens at a `diff --git` line or at a `--- `/`+++ ` pair; lines before
// its first hunk are its header (paths, rename and mode lines), and each `@@` line opens a hunk whose body is eaten
// greedily — a body ends at the first line that cannot be in one, at a `diff --git` line, or at a `--- ` line that
// a `+++ ` line follows, and empty lines at its end are not part of it. Everything else is prose and is ignored.
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const headerPath = (line: string): string => {
    let t = line.slice(4);
    const tab = t.indexOf('\t');
    if (tab >= 0) t = t.slice(0, tab);
    return stripPrefix(t.trim());
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { gitOld: m[1], gitNew: m[2], newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && cur.minus === undefined) {
        cur.minus = headerPath(line);
        cur.plus = headerPath(lines[i + 1]!);
      } else {
        cur = { newFile: false, delFile: false, hunks: [], minus: headerPath(line), plus: headerPath(lines[i + 1]!) };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        const c = bl[0];
        if (bl === '') body.push({ kind: ' ', text: '' });
        else if (c === ' ' || c === '-' || c === '+' || c === '\\') body.push({ kind: c as BodyLine['kind'], text: bl.slice(1) });
        else break;
        i += 1;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === ' ' && last.text === '') body.pop();
        else break;
      }
      cur.hunks.push({ a: parseInt(m[1]!, 10), body });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renOld = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renNew = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    const creation = s.newFile || s.minus === '/dev/null';
    const deletion = s.delFile || s.plus === '/dev/null';
    const oldRaw = s.minus !== undefined && s.minus !== '/dev/null' ? s.minus : (s.renOld ?? s.gitOld);
    const newRaw = s.plus !== undefined && s.plus !== '/dev/null' ? s.plus : (s.renNew ?? s.gitNew);
    if (creation) {
      const p = newRaw!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const flat: BodyLine[] = [];
        for (const h of s.hunks) flat.push(...h.body);
        const content: string[] = [];
        let lastPlus = -1;
        flat.forEach((e, idx) => {
          if (e.kind === '+') {
            content.push(e.text);
            lastPlus = idx;
          }
        });
        const nb = lastPlus >= 0 && flat[lastPlus + 1]?.kind === '\\';
        tree.now.set(p, serialize({ lines: content, br: '\n', final: !nb }));
      });
    } else if (deletion) {
      const p = oldRaw!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const oldP = oldRaw!;
      const newP = newRaw!;
      const isMove = oldP !== newP;
      edits.push((tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
        const text = tree.get(oldP);
        if (text === null) throw new Fail('missing', oldP);
        if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
        const w = fileModel(text);
        let d = 0;
        for (const h of s.hunks) d = applyHunk(w, h, d, strict, oldP);
        tree.now.set(newP, serialize(w));
        if (isMove) {
          tree.now.set(oldP, null);
          moves.push({ old: oldP, neo: newP });
        }
      });
    }
  }
  return edits;
}

// ---------- SEARCH/REPLACE blocks (section 7) ----------

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let p: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      p = l.trim();
      break;
    }
    if (p === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      p = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const path = p;
    edits.push((tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, serialize({ lines: [...newLines], br: '\n', final: true }));
        return;
      }
      const text = tree.get(path);
      if (text === null) throw new Fail('missing', path);
      const w = fileModel(text);
      const found = findTier(w.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const pos = found.positions[0]!;
      const repl = buildReplacement(w.lines, pos, oldLines, newLines.map((l) => ({ lit: l })), found.tier);
      w.lines.splice(pos, oldLines.length, ...repl);
      tree.now.set(path, serialize(w));
    });
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------- V4A patches (section 8) ----------

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'del' : 'upd';
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const startLine = i + 1;
    const raw: { text: string; no: number }[] = [];
    i += 1;
    while (i < last && !isSectionStart(lines[i]!)) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();

    if (kind === 'add') {
      const content: string[] = [];
      for (const r of raw) {
        if (r.text === '') content.push('');
        else if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      for (; idx < raw.length; idx++) {
        const r = raw[idx]!;
        const l = r.text;
        if (l.startsWith('@@')) {
          curChunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), body: [], eof: false };
          chunks.push(curChunk);
        } else if (l.trim() === '*** End of File') {
          if (curChunk === null) {
            curChunk = { anchor: null, body: [], eof: true };
            chunks.push(curChunk);
          } else curChunk.eof = true;
          curChunk = null;
        } else if (l.startsWith('*** Move to: ')) {
          throw new Exit2(`error: parse ${r.no}`);
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (curChunk === null) {
            curChunk = { anchor: null, body: [], eof: false };
            chunks.push(curChunk);
          }
          curChunk.body.push({ kind: l === '' ? ' ' : (l[0] as BodyLine['kind']), text: l === '' ? '' : l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      const mv = moveTo;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const text = tree.get(path);
        if (text === null) throw new Fail('missing', path);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const w = fileModel(text);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            let at = -1;
            for (const tier of tierList(strict)) {
              const positions = occurrences(w.lines, [chunk.anchor], tier).filter((x) => x >= cursor);
              if (positions.length > 0) {
                at = positions[0]!;
                break;
              }
            }
            if (at < 0) throw new Fail('no-match', path);
            cursor = at + 1;
          }
          const { O, N } = buildON(chunk.body);
          if (O.length === 0) {
            const at = chunk.eof ? w.lines.length : Math.min(cursor, w.lines.length);
            const ins = N.map((n) => ('lit' in n ? n.lit : ''));
            w.lines.splice(at, 0, ...ins);
            cursor = at + ins.length;
            continue;
          }
          let placed = false;
          for (const tier of tierList(strict)) {
            const positions = occurrences(w.lines, O, tier).filter((x) => x >= cursor && (!chunk.eof || x + O.length === w.lines.length));
            if (positions.length === 0) continue;
            const pos = positions[0]!;
            const repl = buildReplacement(w.lines, pos, O, N, tier);
            w.lines.splice(pos, O.length, ...repl);
            cursor = pos + repl.length;
            placed = true;
            break;
          }
          if (!placed) throw new Fail('no-match', path);
        }
        tree.now.set(mv ?? path, serialize(w));
        if (mv !== null) {
          tree.now.set(path, null);
          moves.push({ old: path, neo: mv });
        }
      });
    }
  }
  return edits;
}

// ---------- invocation, output and exit codes (sections 1, 2 and 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  moves.length = 0;
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSR(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: { key: string; line: string }[] = [];
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const mv of moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.now.has(mv.old) ? tree.now.get(mv.old)! : wasOld;
    const wasNew = tree.original(mv.neo);
    const nowNew = tree.now.has(mv.neo) ? tree.now.get(mv.neo)! : wasNew;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      const io = entries.findIndex((e) => e.key === mv.old);
      const inew = entries.findIndex((e) => e.key === mv.neo);
      if (io >= 0 && inew >= 0) {
        entries.splice(Math.max(io, inew), 1);
        entries.splice(Math.min(io, inew), 1);
        entries.push({ key: mv.neo, line: `R ${mv.old} -> ${mv.neo}` });
      }
    }
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows = entries.map((e) => e.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
