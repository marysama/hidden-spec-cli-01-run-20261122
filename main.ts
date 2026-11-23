// main.ts is mend, the CLI SPEC.md specifies (version 1). Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md sections 1-10: command line, output and exit codes, safe
// paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE
// blocks, V4A patches, JSON edits and the all-or-nothing write.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

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
  readonly moves: [string, string][] = [];
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

// ---------------------------------------------------------------------------
// Section 3/5 helpers: file line breaks and three-tier matching
// ---------------------------------------------------------------------------

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function rtrimWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

interface FileParts {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}

function joinFile(lines: string[], br: string, finalBr: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBr ? br : '');
}

function findOccurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = findOccurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of N: text, and the index into O when it is a context line. */
interface NLine {
  text: string;
  oIdx: number | null;
}

/** Replace the matched lines at pos with N (section 5). Context lines are
 * written as the file's own matched lines; at tier 2 other lines are
 * re-indented from O's first line's indent to the file's. */
function applyReplace(lines: string[], o: string[], n: NLine[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(lines[pos]!);
    p = leadingWs(o[0]!);
  }
  for (const nl of n) {
    if (nl.oIdx !== null) {
      out.push(lines[pos + nl.oIdx]!);
      continue;
    }
    const t = nl.text;
    if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits (as in the starter)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface HunkItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNl: boolean;
}
interface Hunk {
  a: number;
  items: HunkItem[];
}

function hunkON(h: Hunk): { o: string[]; n: NLine[]; endNoNl: boolean } {
  const o: string[] = [];
  const n: NLine[] = [];
  let endNoNl = false;
  for (let i = h.items.length - 1; i >= 0; i--) {
    const it = h.items[i]!;
    if (it.kind === 'ctx' || it.kind === 'new') {
      endNoNl = it.noNl;
      break;
    }
  }
  h.items.forEach((it) => {
    if (it.kind === 'ctx') {
      const idx = o.length;
      o.push(it.text);
      n.push({ text: it.text, oIdx: idx });
    } else if (it.kind === 'old') o.push(it.text);
    else n.push({ text: it.text, oIdx: null });
  });
  return { o, n, endNoNl };
}

function applyHunk(cur: FileParts, h: Hunk, d: number, strict: boolean, path: string): FileParts {
  const { o, n, endNoNl } = hunkON(h);
  if (o.length > 0) {
    const found = findTier(cur.lines, o, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const rep = applyReplace(cur.lines, o, n, pos, found.tier);
    const lines = [...cur.lines.slice(0, pos), ...rep, ...cur.lines.slice(pos + o.length)];
    const endsAtEnd = pos + o.length === cur.lines.length;
    return { lines, br: cur.br, finalBr: endsAtEnd ? !endNoNl : cur.finalBr };
  }
  const at = Math.min(h.a + d, cur.lines.length);
  const lines = [...cur.lines.slice(0, at), ...n.map((x) => x.text), ...cur.lines.slice(at)];
  return { lines, br: cur.br, finalBr: at === cur.lines.length ? !endNoNl : cur.finalBr };
}

function applyUnifiedHunks(content: string, hunks: Hunk[], strict: boolean, path: string): string {
  let cur = fileParts(content);
  let d = 0;
  for (const h of hunks) {
    cur = applyHunk(cur, h, d, strict, path);
    const { o, n } = hunkON(h);
    d += n.length - o.length;
  }
  return joinFile(cur.lines, cur.br, cur.finalBr);
}

function diffPath(raw: string): string {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  renOld: string | null;
  renNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const secs: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const newSec = (dOld: string | null, dNew: string | null): USection => {
    const s: USection = { diffOld: dOld, diffNew: dNew, headOld: null, headNew: null, renOld: null, renNew: null, create: false, del: false, hunks: [] };
    secs.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      newSec(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)?$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const raw: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          raw.push(b);
          i++;
          continue;
        }
        break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const items: HunkItem[] = [];
      for (const r of raw) {
        if (r.startsWith('\\')) {
          if (items.length > 0) items[items.length - 1]!.noNl = true;
          continue;
        }
        if (r === '') items.push({ kind: 'ctx', text: '', noNl: false });
        else if (r[0] === ' ') items.push({ kind: 'ctx', text: r.slice(1), noNl: false });
        else if (r[0] === '-') items.push({ kind: 'old', text: r.slice(1), noNl: false });
        else items.push({ kind: 'new', text: r.slice(1), noNl: false });
      }
      cur.hunks.push({ a, items });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.headOld = diffPath(l.slice(4));
          cur.headNew = diffPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        cur.headNew = diffPath(l.slice(4));
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renOld = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renNew = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = newSec(null, null);
      s.headOld = diffPath(l.slice(4));
      s.headNew = diffPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    i++;
  }
  const edits: Edit[] = [];
  for (const s of secs) {
    const hasPair = s.headOld !== null || s.headNew !== null;
    let oldP: string | null = s.headOld ?? (hasPair ? null : s.renOld) ?? s.diffOld;
    let newP: string | null = s.headNew ?? (hasPair ? null : s.renNew) ?? s.diffNew;
    const isCreate = s.create || oldP === '/dev/null';
    const isDel = s.del || newP === '/dev/null';
    if (oldP === '/dev/null') oldP = null;
    if (newP === '/dev/null') newP = null;
    if (isCreate) {
      if (newP === null) throw new Exit2('error: parse 1');
      const path = newP;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        const plus: string[] = [];
        let endNoNl = false;
        for (const h of hunks) {
          for (const it of h.items) {
            if (it.kind === 'new') {
              plus.push(it.text);
              endNoNl = it.noNl;
            }
          }
        }
        tree.now.set(path, plus.length === 0 ? '' : plus.join('\n') + (endNoNl ? '' : '\n'));
      });
    } else if (isDel) {
      if (oldP === null) throw new Exit2('error: parse 1');
      const path = oldP;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else if (oldP !== null && newP !== null && oldP !== newP) {
      const oldPath = oldP;
      const newPath = newP;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const curText = tree.get(oldPath);
        if (curText === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const out = applyUnifiedHunks(curText, hunks, strict, oldPath);
        tree.now.set(newPath, out);
        tree.now.set(oldPath, null);
        tree.moves.push([oldPath, newPath]);
      });
    } else {
      const path = oldP ?? newP;
      if (path === null) throw new Exit2('error: parse 1');
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        const curText = tree.get(path);
        if (curText === null) throw new Fail('missing', path);
        tree.now.set(path, applyUnifiedHunks(curText, hunks, strict, path));
      });
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let lastEnd = 0;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let k = s - 1; k >= lastEnd; k--) {
      const t = lines[k]!;
      if (!blank(t) && !t.trim().startsWith('```')) {
        path = t.trim();
        break;
      }
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    prevPath = path;
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const curText = tree.get(p);
      if (curText === null) throw new Fail('missing', p);
      const fp = fileParts(curText);
      const found = findTier(fp.lines, oldLines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const n: NLine[] = newLines.map((t) => ({ text: t, oIdx: null }));
      const rep = applyReplace(fp.lines, oldLines, n, pos, found.tier);
      const out = [...fp.lines.slice(0, pos), ...rep, ...fp.lines.slice(pos + oldLines.length)];
      tree.now.set(p, joinFile(out, fp.br, fp.finalBr));
    });
    lastEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: { kind: 'ctx' | 'old' | 'new'; text: string }[];
}

function isV4aSection(l: string): 'add' | 'delete' | 'update' | null {
  if (l.startsWith('*** Add File:')) return 'add';
  if (l.startsWith('*** Delete File:')) return 'delete';
  if (l.startsWith('*** Update File:')) return 'update';
  return null;
}

function applyV4aChunks(content: string, chunks: VChunk[], strict: boolean, path: string): string {
  const fp = fileParts(content);
  let lines = [...fp.lines];
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null && ch.anchor !== '') {
      const f = findTier(lines, [ch.anchor], strict, cursor);
      if (!f) throw new Fail('no-match', path);
      cursor = f.positions[0]! + 1;
    }
    const o: string[] = [];
    const n: NLine[] = [];
    ch.items.forEach((it) => {
      if (it.kind === 'ctx') {
        const idx = o.length;
        o.push(it.text);
        n.push({ text: it.text, oIdx: idx });
      } else if (it.kind === 'old') o.push(it.text);
      else n.push({ text: it.text, oIdx: null });
    });
    if (o.length > 0) {
      let pos: number | null = null;
      let tier = 0;
      if (ch.eof) {
        const max = strict ? 0 : 2;
        for (let t = 0; t <= max; t++) {
          const cand = lines.length - o.length;
          if (cand >= cursor) {
            let ok = true;
            for (let k = 0; k < o.length; k++) {
              if (!lineEq(lines[cand + k]!, o[k]!, t)) {
                ok = false;
                break;
              }
            }
            if (ok) {
              pos = cand;
              tier = t;
              break;
            }
          }
        }
        if (pos === null) throw new Fail('no-match', path);
      } else {
        const f = findTier(lines, o, strict, cursor);
        if (!f) throw new Fail('no-match', path);
        pos = f.positions[0]!;
        tier = f.tier;
      }
      const rep = applyReplace(lines, o, n, pos, tier);
      lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + o.length)];
      cursor = pos + rep.length;
    } else {
      const at = ch.eof ? lines.length : cursor;
      const ins = n.map((x) => x.text);
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      cursor = at + ins.length;
    }
  }
  return joinFile(lines, fp.br, fp.finalBr);
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = isV4aSection(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = l.slice(l.indexOf(':') + 1).trim();
    if (kind === 'add') {
      const fl: string[] = [];
      let j = i + 1;
      while (j < last) {
        const b = lines[j]!;
        if (isV4aSection(b) !== null || b.trim() === '*** End Patch') break;
        if (b.startsWith('+')) {
          fl.push(b.slice(1));
          j++;
          continue;
        }
        if (b === '') {
          fl.push('');
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      while (fl.length > 0 && fl[fl.length - 1] === '') fl.pop();
      const p = path;
      const f = fl;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, f.length === 0 ? '' : f.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (kind === 'delete') {
      const j = i + 1;
      if (j < last && !blank(lines[j]!) && isV4aSection(lines[j]!) === null && lines[j]!.trim() !== '*** End Patch') {
        throw new Exit2(`error: parse ${j + 1}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = j;
      continue;
    }
    // update
    let j = i + 1;
    let moveTo: string | null = null;
    if (j < last && lines[j]!.startsWith('*** Move to:')) {
      moveTo = lines[j]!.slice(lines[j]!.indexOf(':') + 1).trim();
      j++;
    }
    const chunks: VChunk[] = [];
    while (j < last) {
      const b = lines[j]!;
      if (isV4aSection(b) !== null || b.trim() === '*** End Patch') break;
      if (blank(b)) {
        j++;
        continue;
      }
      if (b.startsWith('@@') || (chunks.length === 0 && (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')))) {
        let anchor: string | null = null;
        if (b.startsWith('@@')) {
          anchor = b.slice(2).trim();
          j++;
        }
        const items: { kind: 'ctx' | 'old' | 'new'; text: string }[] = [];
        let eof = false;
        let endedBySection = false;
        while (j < last) {
          const c = lines[j]!;
          if (c === '*** End of File') {
            eof = true;
            j++;
            break;
          }
          if (c.startsWith('@@')) break;
          if (isV4aSection(c) !== null || c.trim() === '*** End Patch') {
            endedBySection = true;
            break;
          }
          if (c.startsWith(' ')) {
            items.push({ kind: 'ctx', text: c.slice(1) });
            j++;
            continue;
          }
          if (c.startsWith('-')) {
            items.push({ kind: 'old', text: c.slice(1) });
            j++;
            continue;
          }
          if (c.startsWith('+')) {
            items.push({ kind: 'new', text: c.slice(1) });
            j++;
            continue;
          }
          if (c === '') {
            items.push({ kind: 'ctx', text: '' });
            j++;
            continue;
          }
          throw new Exit2(`error: parse ${j + 1}`);
        }
        // The loop also ends at the patch's last non-blank line (*** End
        // Patch): that is the end of the section too.
        if (j >= last) endedBySection = true;
        if (endedBySection) {
          while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.text === '') items.pop();
        }
        if (!(items.length === 0 && anchor === null && !eof)) chunks.push({ anchor, eof, items });
        continue;
      }
      throw new Exit2(`error: parse ${j + 1}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
    const p = path;
    const m = moveTo;
    const chs = chunks;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (m !== null && !safe(m)) throw new Fail('unsafe', m);
      const curText = tree.get(p);
      if (curText === null) throw new Fail('missing', p);
      if (m !== null && tree.get(m) !== null) throw new Fail('exists', m);
      const out = applyV4aChunks(curText, chs, strict, p);
      if (m !== null) {
        tree.now.set(m, out);
        tree.now.set(p, null);
        tree.moves.push([p, m]);
      } else {
        tree.now.set(p, out);
      }
    });
    i = j;
    continue;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 1/2/10: invocation, output, exit codes, atomicity
// ---------------------------------------------------------------------------

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...movesBefore);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: R lines for moves sort by the new path; the rest by path.
  const rPairs: [string, string][] = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.original(n) === null && tree.now.get(o) === null && tree.now.get(n) !== null) rPairs.push([o, n]);
  }
  const rOld = new Set(rPairs.map((p) => p[0]));
  const rNew = new Set(rPairs.map((p) => p[1]));
  const rowList: { key: string; line: string }[] = [];
  for (const [o, n] of rPairs) rowList.push({ key: n, line: `R ${o} -> ${n}` });
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowList.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowList.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowList.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
