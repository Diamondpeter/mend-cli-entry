// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  readonly moves: { oldPath: string; newPath: string }[] = [];
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

// ---- Sections 5 to 8: line matching and the three text formats (my work in this session) ----

interface FileParts { lines: string[]; br: string; final: boolean }

function splitFile(text: string): FileParts {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

const leadOf = (s: string): string => /^[ \t]*/.exec(s)![0];
const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

function occAt(lines: string[], pos: number, o: string[], tier: number): boolean {
  for (let k = 0; k < o.length; k += 1) if (!lineMatches(lines[pos + k]!, o[k]!, tier)) return false;
  return true;
}

/** First tier (0 only when strict) at which o occurs, honouring a start cursor and an end-of-file rule. */
function findOcc(lines: string[], o: string[], strict: boolean, from = 0, eofOnly = false): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (eofOnly && i + o.length !== lines.length) continue;
      if (occAt(lines, i, o, tier)) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface NEntry { kind: 'context' | 'del' | 'add'; text: string; oIndex: number; noNL?: boolean; emptyLine?: boolean }

/** Build the replacement lines for a match: context from the file, tier-2 lines re-indented. */
function replacementLines(fileLines: string[], pos: number, o: string[], nEntries: NEntry[], tier: number): string[] {
  const f = o.length > 0 ? leadOf(fileLines[pos] ?? '') : '';
  const p = o.length > 0 ? leadOf(o[0]!) : '';
  return nEntries.map((e) => {
    if (e.kind === 'context') return fileLines[pos + e.oIndex]!;
    if (tier === 2) {
      const line = e.text;
      if (line === '' || line.trim() === '') return line;
      if (line.startsWith(p)) return f + line.slice(p.length);
      return line;
    }
    return e.text;
  });
}

function bodyEntry(kind: NEntry['kind'], text: string, oCount: number, emptyLine = false): NEntry {
  return { kind, text, oIndex: kind === 'add' ? -1 : oCount, emptyLine };
}

// ---- Section 6: unified diffs ----

interface Hunk { a: number; entries: NEntry[] }

interface USec {
  minus?: string; plus?: string; diffOld?: string; diffNew?: string;
  renameFrom?: string; renameTo?: string; isNew: boolean; isDel: boolean; hunks: Hunk[];
}

function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return t;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function applyUnified(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  if (hunks.length === 0) return before;
  const parts = splitFile(before);
  const fl = parts.lines;
  let final = parts.final;
  let d = 0;
  for (const hunk of hunks) {
    const oEntries = hunk.entries.filter((e) => e.kind !== 'add');
    const o = oEntries.map((e) => e.text);
    const nEntries = hunk.entries.filter((e) => e.kind !== 'del');
    if (o.length === 0) {
      let at = hunk.a + d;
      if (at < 0) at = 0;
      if (at > fl.length) at = fl.length;
      const atEnd = at === fl.length;
      const ins = nEntries.map((e) => e.text);
      fl.splice(at, 0, ...ins);
      if (atEnd && nEntries.length > 0) final = !nEntries[nEntries.length - 1]!.noNL;
      d += ins.length;
    } else {
      const found = findOcc(fl, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let best = found.positions[0]!;
      for (const pos of found.positions) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const repl = replacementLines(fl, best, o, nEntries, found.tier);
      const runsToEnd = best + o.length === fl.length;
      fl.splice(best, o.length, ...repl);
      if (runsToEnd) {
        if (nEntries.length > 0) final = !nEntries[nEntries.length - 1]!.noNL;
        else final = fl.length > 0;
      }
      d += nEntries.length - o.length;
    }
  }
  return joinFile(fl, parts.br, final);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USec[] = [];
  let cur: USec | null = null;
  let curHunk: Hunk | null = null;
  let inBody = false;
  const finishBody = (): void => {
    if (curHunk !== null) {
      while (curHunk.entries.length > 0 && curHunk.entries[curHunk.entries.length - 1]!.emptyLine) curHunk.entries.pop();
    }
    inBody = false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (inBody && curHunk !== null) {
      const endsHere = line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
      if (!endsHere && (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '')) {
        if (line.startsWith('\\')) {
          const prev = curHunk.entries[curHunk.entries.length - 1];
          if (prev !== undefined) prev.noNL = true;
        } else if (line === '') {
          const oCount = curHunk.entries.filter((e) => e.kind !== 'add').length;
          curHunk.entries.push(bodyEntry('context', '', oCount, true));
        } else {
          const kind = line[0] === ' ' ? 'context' : line[0] === '-' ? 'del' : 'add';
          const oCount = curHunk.entries.filter((e) => e.kind !== 'add').length;
          curHunk.entries.push(bodyEntry(kind as NEntry['kind'], line.slice(1), oCount));
        }
        i += 1;
        continue;
      }
      finishBody();
    }
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1]!, diffNew: m[2]!, isNew: false, isDel: false, hunks: [] };
      sections.push(cur);
      curHunk = null;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: .*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: parseInt(m[1]!, 10), entries: [] };
      cur.hunks.push(curHunk);
      inBody = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      const inHeader = cur !== null && cur.hunks.length === 0;
      if (!next.startsWith('+++ ')) {
        if (inHeader) throw new Exit2(`error: parse ${i + 2}`);
        i += 1;
        continue;
      }
      if (inHeader && cur !== null) {
        cur.minus = headerPath(line);
        cur.plus = headerPath(next);
      } else {
        cur = { minus: headerPath(line), plus: headerPath(next), isNew: false, isDel: false, hunks: [] };
        sections.push(cur);
      }
      curHunk = null;
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
    }
    i += 1;
  }
  finishBody();
  const edits: Edit[] = [];
  for (const sec of sections) {
    const oldP = sec.minus !== undefined ? sec.minus : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
    const newP = sec.plus !== undefined ? sec.plus : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
    edits.push((tree) => {
      const isCreate = oldP === '/dev/null' || sec.isNew;
      const isDelete = newP === '/dev/null' || sec.isDel;
      if (!isCreate && oldP !== undefined && oldP !== '/dev/null' && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (!isDelete && newP !== undefined && newP !== '/dev/null' && !safe(newP)) throw new Fail('unsafe', newP);
      if (isCreate) {
        const target = newP!;
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const plus: NEntry[] = [];
        for (const h of sec.hunks) for (const e of h.entries) if (e.kind === 'add') plus.push(e);
        const final = plus.length === 0 || !plus[plus.length - 1]!.noNL;
        tree.now.set(target, plus.length === 0 ? '' : plus.map((e) => e.text).join('\n') + (final ? '\n' : ''));
        return;
      }
      if (isDelete) {
        const target = oldP!;
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
        return;
      }
      const src = oldP!;
      const dst = newP !== undefined ? newP : src;
      const beforeText = tree.get(src);
      if (beforeText === null) throw new Fail('missing', src);
      if (dst !== src) {
        if (tree.get(dst) !== null) throw new Fail('exists', dst);
        const result = applyUnified(beforeText, sec.hunks, strict, src);
        tree.now.set(src, null);
        tree.now.set(dst, result);
        tree.moves.push({ oldPath: src, newPath: dst });
        return;
      }
      tree.now.set(src, applyUnified(beforeText, sec.hunks, strict, src));
    });
  }
  return edits;
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block { path: string; oldLines: string[]; newLines: string[] }
  const blocks: Block[] = [];
  let prevPath: string | undefined;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const at = i;
    let path: string | undefined;
    for (let j = at - 1; j >= searchFrom; j -= 1) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === undefined) {
      if (prevPath !== undefined) path = prevPath;
      else throw new Exit2(`error: parse ${at + 1}`);
    }
    let eq = -1;
    for (let k = at + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
      if (lines[k]!.trimEnd() === '=======') { eq = k; break; }
    }
    if (eq < 0) throw new Exit2(`error: parse ${at + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { rep = k; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    blocks.push({ path, oldLines: lines.slice(at + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const parts = splitFile(before);
    const found = findOcc(parts.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const nEntries: NEntry[] = b.newLines.map((t) => ({ kind: 'add' as const, text: t, oIndex: -1 }));
    const repl = replacementLines(parts.lines, pos, b.oldLines, nEntries, found.tier);
    parts.lines.splice(pos, b.oldLines.length, ...repl);
    tree.now.set(b.path, joinFile(parts.lines, parts.br, parts.final));
  });
}

// ---- Section 8: V4A patches ----

interface VChunk { anchor?: string; eof: boolean; closed?: boolean; entries: NEntry[] }
interface VSecParsed { type: 'add' | 'delete' | 'update'; path: string; lineNo: number; addLines: string[]; moveTo?: string; chunks: VChunk[] }

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) if (!blank(lines[k]!)) { last = k; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface RawSec { type: VSecParsed['type']; path: string; lineNo: number; raw: { text: string; lineNo: number }[] }
  const rawSecs: RawSec[] = [];
  let cur: RawSec | null = null;
  for (let k = first + 1; k < last; k += 1) {
    const line = lines[k]!;
    const heads: [string, VSecParsed['type']][] = [['*** Add File: ', 'add'], ['*** Delete File: ', 'delete'], ['*** Update File: ', 'update']];
    const head = heads.find(([h]) => line.startsWith(h));
    if (head !== undefined) {
      cur = { type: head[1], path: line.slice(head[0].length).trim(), lineNo: k + 1, raw: [] };
      rawSecs.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${k + 1}`);
    }
    cur.raw.push({ text: line, lineNo: k + 1 });
  }
  const secs: VSecParsed[] = [];
  for (const rs of rawSecs) {
    while (rs.raw.length > 0 && blank(rs.raw[rs.raw.length - 1]!.text)) rs.raw.pop();
    const parsed: VSecParsed = { type: rs.type, path: rs.path, lineNo: rs.lineNo, addLines: [], chunks: [] };
    if (rs.type === 'add') {
      for (const r of rs.raw) {
        if (r.text.startsWith('+')) parsed.addLines.push(r.text.slice(1));
        else if (r.text === '') parsed.addLines.push('');
        else throw new Exit2(`error: parse ${r.lineNo}`);
      }
    } else if (rs.type === 'delete') {
      if (rs.raw.length > 0) throw new Exit2(`error: parse ${rs.raw[0]!.lineNo}`);
    } else {
      let curChunk: VChunk | null = null;
      rs.raw.forEach((r, idx) => {
        const t = r.text;
        if (t.startsWith('*** Move to: ')) {
          if (idx !== 0) throw new Exit2(`error: parse ${r.lineNo}`);
          parsed.moveTo = t.slice('*** Move to: '.length).trim();
          return;
        }
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          curChunk = { anchor: anchor === '' ? undefined : anchor, eof: false, entries: [] };
          parsed.chunks.push(curChunk);
          return;
        }
        if (t.trimEnd() === '*** End of File') {
          if (curChunk === null) { curChunk = { eof: true, entries: [] }; parsed.chunks.push(curChunk); }
          curChunk.eof = true;
          curChunk.closed = true;
          return;
        }
        if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (curChunk === null || curChunk.closed) { curChunk = { eof: false, entries: [] }; parsed.chunks.push(curChunk); }
          const kind = t === '' || t[0] === ' ' ? 'context' : t[0] === '-' ? 'del' : 'add';
          const oCount = curChunk.entries.filter((e) => e.kind !== 'add').length;
          curChunk.entries.push(bodyEntry(kind as NEntry['kind'], t === '' ? '' : t.slice(1), oCount, t === ''));
          return;
        }
        throw new Exit2(`error: parse ${r.lineNo}`);
      });
      // Trailing empty context lines of the last chunk were section-end blanks in disguise if the section ended there;
      // they were already trimmed at section level, so chunk entries stand as written.
      if (parsed.chunks.length === 0 && parsed.moveTo === undefined) throw new Exit2(`error: parse ${rs.lineNo}`);
    }
    secs.push(parsed);
  }
  return secs.map((sec) => (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.type === 'update' && sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.type === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.type === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let result = before;
    if (sec.chunks.length > 0) {
      const parts = splitFile(before);
      const fl = parts.lines;
      let cursor = 0;
      for (const chunk of sec.chunks) {
        if (chunk.anchor !== undefined) {
          const foundA = findOcc(fl, [chunk.anchor], strict, cursor);
          if (foundA === null) throw new Fail('no-match', sec.path);
          cursor = foundA.positions[0]! + 1;
        }
        const o = chunk.entries.filter((e) => e.kind !== 'add').map((e) => e.text);
        const nEntries = chunk.entries.filter((e) => e.kind !== 'del');
        if (o.length === 0) {
          const at = chunk.eof ? fl.length : cursor;
          const ins = nEntries.map((e) => e.text);
          fl.splice(at, 0, ...ins);
          cursor = at + ins.length;
        } else {
          const found = findOcc(fl, o, strict, cursor, chunk.eof);
          if (found === null) throw new Fail('no-match', sec.path);
          const pos = found.positions[0]!;
          const repl = replacementLines(fl, pos, o, nEntries, found.tier);
          fl.splice(pos, o.length, ...repl);
          cursor = pos + repl.length;
        }
      }
      result = joinFile(fl, parts.br, parts.final);
    }
    if (sec.moveTo !== undefined) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, result);
      tree.moves.push({ oldPath: sec.path, newPath: sec.moveTo });
    } else {
      tree.now.set(sec.path, result);
    }
  });
}

function run(args: string[]): { code: number; out: string[] } {
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
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
  const byKey = new Map<string, string>();
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    byKey.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.oldPath);
    const wasNew = tree.original(mv.newPath);
    const nowOld = tree.now.has(mv.oldPath) ? tree.now.get(mv.oldPath)! : wasOld;
    const nowNew = tree.now.has(mv.newPath) ? tree.now.get(mv.newPath)! : wasNew;
    if (wasOld === null || nowOld !== null || wasNew !== null || nowNew === null) continue;
    if (!byKey.has(mv.oldPath) || !byKey.has(mv.newPath)) continue;
    byKey.delete(mv.oldPath);
    byKey.delete(mv.newPath);
    byKey.set(mv.newPath, `R ${mv.oldPath} -> ${mv.newPath}`);
  }
  const rows = [...byKey.entries()].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))).map(([, v]) => v);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
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
