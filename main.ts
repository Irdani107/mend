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

// ---- Section 5: the file model and matching lines at three tiers ----

interface Model {
  lines: string[];
  br: string;
  fin: boolean;
}

function toModel(text: string): Model {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, fin: false };
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function fromModel(m: Model): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.fin ? m.br : '');
}

const trail = (s: string): string => s.replace(/[ \t]+$/, '');
const bothEnds = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => s.match(/^[ \t]*/)![0];

function tierEq(a: string, b: string, tier: number): boolean {
  return tier === 0 ? a === b : tier === 1 ? trail(a) === trail(b) : bothEnds(a) === bothEnds(b);
}

/** Every position >= from at which O matches lines at the given tier (occurrences may overlap). */
function occAt(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(lines[i + j]!, O[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (tier 0 only when strict) at which O occurs at or after `from`, with its positions. */
function findOcc(lines: string[], O: string[], strict: boolean, from: number): { tier: number; at: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const at = occAt(lines, O, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of N: its text, and its index into O when it is a context line (else -1). */
interface NLine {
  text: string;
  ctx: number;
}

/** Replace lines[pos .. pos+O.length) by N: context lines keep the file's own text; at tier 2 the rest re-indent. */
function splice(lines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadOf(lines[pos]!);
    P = leadOf(O[0]!);
  }
  const mid = N.map((n) => {
    if (n.ctx >= 0) return lines[pos + n.ctx]!;
    if (tier !== 2) return n.text;
    if (n.text === '' || !/[^ \t]/.test(n.text)) return n.text;
    return n.text.startsWith(P) ? F + n.text.slice(P.length) : n.text;
  });
  return [...lines.slice(0, pos), ...mid, ...lines.slice(pos + O.length)];
}

/** The lines a body (unified hunk or V4A chunk) names: O (context + old) and N (context + new). */
interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  bs: boolean;
  raw: boolean;
}

function bodyON(body: BodyLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === '-') O.push(b.text);
    else N.push({ text: b.text, ctx: -1 });
  }
  return { O, N };
}

/** The body's last context-or-new entry, or its last new entry alone (the `\` no-newline rules look at these). */
function lastOf(body: BodyLine[], plusOnly: boolean): BodyLine | null {
  for (let i = body.length - 1; i >= 0; i--) {
    const b = body[i]!;
    if (b.kind === '+' || (!plusOnly && b.kind === ' ')) return b;
  }
  return null;
}

function dropTrailingRawEmpty(body: BodyLine[]): void {
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.raw && last.kind === ' ' && last.text === '' && !last.bs) body.pop();
    else break;
  }
}

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

// ---- Section 6: unified diffs ----

interface UHunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  diffOld?: string;
  diffNew?: string;
  pairOld?: string;
  pairNew?: string;
  renFrom?: string;
  renTo?: string;
  created: boolean;
  deleted: boolean;
  sawPair: boolean;
  hunks: UHunk[];
}

const hdrPath = (raw: string): string => {
  let p = raw.split('\t')[0]!.replace(/^ +| +$/g, '');
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
};

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const push = (): void => {
    if (cur) sections.push(cur);
    cur = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const ln = i + 1;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice(11);
      const idx = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
      if (idx < 0) throw new Exit2(`error: parse ${ln}`);
      push();
      cur = { created: false, deleted: false, sawPair: false, hunks: [], diffOld: rest.slice(2, idx), diffNew: rest.slice(idx + 3) };
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.sawPair || cur.hunks.length > 0) {
        push();
        cur = { created: false, deleted: false, sawPair: false, hunks: [] };
      }
      cur.pairOld = hdrPath(line.slice(4));
      cur.pairNew = hdrPath(lines[i + 1]!.slice(4));
      cur.sawPair = true;
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && line.startsWith('--- ')) throw new Exit2(`error: parse ${ln + 1}`);
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!m) throw new Exit2(`error: parse ${ln}`);
      const hunk: UHunk = { a: parseInt(m[1]!, 10), body: [] };
      cur.hunks.push(hunk);
      inHeader = false;
      i++;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          hunk.body.push({ kind: ' ', text: '', bs: false, raw: true });
          i++;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          hunk.body.push({ kind: c, text: bl.slice(1), bs: false, raw: false });
          i++;
          continue;
        }
        if (c === '\\') {
          const prev = hunk.body[hunk.body.length - 1];
          if (prev) prev.bs = true;
          i++;
          continue;
        }
        break;
      }
      dropTrailingRawEmpty(hunk.body);
      continue;
    }
    if (cur !== null && inHeader && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renFrom = line.slice(12);
      else if (line.startsWith('rename to ')) cur.renTo = line.slice(10);
      else if (line.startsWith('new file mode')) cur.created = true;
      else if (line.startsWith('deleted file mode')) cur.deleted = true;
    }
    i++;
  }
  push();
  return sections.map((s) => unifiedEdit(s, strict, moves));
}

function applyHunks(model: Model, hunks: UHunk[], strict: boolean, path: string): Model {
  let lines = model.lines;
  let fin = model.fin;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    if (O.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const adds = N.map((n) => n.text);
      lines = [...lines.slice(0, pos), ...adds, ...lines.slice(pos)];
      if (pos === lines.length - adds.length && adds.length > 0) {
        // inserted at the end: the final break follows the hunk's last + line's `\` mark
        const lp = lastOf(h.body, true);
        fin = !(lp !== null && lp.bs);
      } else if (pos === lines.length && adds.length === 0) {
        // nothing inserted; the break stays as it was
      }
      d += adds.length;
      continue;
    }
    const found = findOcc(lines, O, strict, 0);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.at[0]!;
    for (const p of found.at) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    const toEnd = pos + O.length === lines.length;
    lines = splice(lines, pos, O, N, found.tier);
    if (toEnd) {
      const lp = lastOf(h.body, false);
      fin = !(lp !== null && lp.bs);
    }
    d += N.length - O.length;
  }
  return { lines, br: model.br, fin };
}

function unifiedEdit(s: USection, strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    const oldRaw = s.pairOld !== undefined ? s.pairOld : s.renFrom !== undefined ? s.renFrom : s.diffOld;
    const newRaw = s.pairNew !== undefined ? s.pairNew : s.renTo !== undefined ? s.renTo : s.diffNew;
    const oldPath = oldRaw === '/dev/null' ? null : oldRaw;
    const newPath = newRaw === '/dev/null' ? null : newRaw;
    if (oldPath != null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath != null && !safe(newPath)) throw new Fail('unsafe', newPath);
    const isCreate = oldRaw === '/dev/null' || s.created;
    const isDelete = newRaw === '/dev/null' || s.deleted;
    if (isCreate && !isDelete) {
      const p = newPath!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const made: string[] = [];
      let lastPlus: BodyLine | null = null;
      for (const h of s.hunks) {
        for (const b of h.body) {
          if (b.kind === '+') {
            made.push(b.text);
            lastPlus = b;
          }
        }
      }
      tree.now.set(p, fromModel({ lines: made, br: '\n', fin: !(lastPlus !== null && lastPlus.bs) }));
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldPath !== newPath) {
      const o = oldPath!;
      const n = newPath!;
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const out = applyHunks(toModel(before), s.hunks, strict, o);
      tree.now.set(n, fromModel(out));
      tree.now.set(o, null);
      moves.push([o, n]);
      return;
    }
    const p = (newPath ?? oldPath)!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const out = applyHunks(toModel(before), s.hunks, strict, p);
    tree.now.set(p, fromModel(out));
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLn = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLn}`);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLn}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fromModel({ lines: newLines, br: '\n', fin: newLines.length > 0 }));
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const model = toModel(text);
    const found = findOcc(model.lines, oldLines, strict, 0);
    if (!found) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const N: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    model.lines = splice(model.lines, found.at[0]!, oldLines, N, found.tier);
    tree.now.set(path, fromModel(model));
  };
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  closed: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  ln: number;
  moveTo?: string;
  body: Array<{ text: string; raw: boolean }>;
  chunks: VChunk[];
}

const vPath = (raw: string): string => raw.replace(/^ +| +$/g, '');

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;
  const closeSection = (): void => {
    if (cur === null) return;
    if (cur.kind === 'add') {
      while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.raw) cur.body.pop();
    }
    if (cur.kind === 'upd' && cur.chunks.length > 0) {
      // Section 8: blank lines at the end of a section are not part of it (blank = empty or only whitespace).
      const body = cur.chunks[cur.chunks.length - 1]!.body;
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === ' ' && /^[ \t]*$/.test(last.text)) body.pop();
        else break;
      }
    }
    if (cur.kind === 'upd' && cur.chunks.length === 0 && cur.moveTo === undefined) {
      throw new Exit2(`error: parse ${cur.ln}`);
    }
    sections.push(cur);
    cur = null;
    chunk = null;
  };
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    const ln = i + 1;
    if (line.startsWith('*** Add File: ')) {
      closeSection();
      cur = { kind: 'add', path: vPath(line.slice(14)), ln, body: [], chunks: [] };
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      closeSection();
      cur = { kind: 'del', path: vPath(line.slice(17)), ln, body: [], chunks: [] };
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      closeSection();
      cur = { kind: 'upd', path: vPath(line.slice(17)), ln, body: [], chunks: [] };
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${ln}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.body.push({ text: line.slice(1), raw: false });
      else if (line === '') cur.body.push({ text: '', raw: true });
      else throw new Exit2(`error: parse ${ln}`);
      continue;
    }
    if (cur.kind === 'del') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${ln}`);
    }
    // update section
    if (line.startsWith('*** Move to: ') && cur.moveTo === undefined && cur.chunks.length === 0 && chunk === null) {
      cur.moveTo = vPath(line.slice(13));
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${ln}`);
      chunk.eof = true;
      chunk.closed = true;
      chunk = null;
      continue;
    }
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).replace(/^ +| +$/g, '');
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, closed: false, body: [] };
      cur.chunks.push(chunk);
      continue;
    }
    const c = line[0];
    if (line === '' || c === ' ' || c === '-' || c === '+') {
      if (chunk === null) {
        if (cur.chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
        chunk = { anchor: null, eof: false, closed: false, body: [] };
        cur.chunks.push(chunk);
      }
      if (line === '') chunk.body.push({ kind: ' ', text: '', bs: false, raw: true });
      else chunk.body.push({ kind: c, text: line.slice(1), bs: false, raw: false });
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  closeSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict, moves));
}

function v4aEdit(s: VSection, strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const made = s.body.map((b) => b.text);
      tree.now.set(s.path, fromModel({ lines: made, br: '\n', fin: made.length > 0 }));
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== undefined && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== undefined && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const model = toModel(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        let at = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let j = cursor; j < model.lines.length; j++) {
            if (tierEq(model.lines[j]!, ch.anchor, tier)) { at = j; break; }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const { O, N } = bodyON(ch.body);
      if (O.length === 0) {
        const pos = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        const adds = N.map((n) => n.text);
        model.lines = [...model.lines.slice(0, pos), ...adds, ...model.lines.slice(pos)];
        cursor = pos + adds.length;
        continue;
      }
      const found = findOcc(model.lines, O, strict, cursor);
      if (!found) throw new Fail('no-match', s.path);
      const cands = ch.eof ? found.at.filter((p) => p + O.length === model.lines.length) : found.at;
      if (cands.length === 0) throw new Fail('no-match', s.path);
      const pos = cands[0]!;
      model.lines = splice(model.lines, pos, O, N, found.tier);
      cursor = pos + N.length;
    }
    if (s.moveTo !== undefined) {
      tree.now.set(s.moveTo, fromModel(model));
      tree.now.set(s.path, null);
      moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, fromModel(model));
    }
  };
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
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    edits = kind === 'json'
      ? jsonEdits(text, lines)
      : kind === 'unified'
        ? unifiedEdits(lines, strict, moves)
        : kind === 'search-replace'
          ? srEdits(lines, strict)
          : v4aEdits(lines, strict, moves);
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
  const consumed = new Set<string>();
  for (const [o, n] of moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    const wasO = tree.original(o);
    const nowO = tree.now.has(o) ? tree.now.get(o)! : wasO;
    const wasN = tree.original(n);
    const nowN = tree.now.has(n) ? tree.now.get(n)! : wasN;
    if (wasO !== null && nowO === null && wasN === null && nowN !== null) {
      byKey.set(n, `R ${o} -> ${n}`);
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    byKey.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  const rows = [...byKey.entries()]
    .sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
    .map(([, text]) => text);
  if (!check) {
    for (const p of tree.now.keys()) {
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
