// main.ts: mend CLI specification implementation (Node 22, standard library only).
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

interface FileContent {
  lines: string[];
  br: string;
  hasFinalBreak: boolean;
}

function parseFile(text: string): FileContent {
  if (text === '') return { lines: [], br: '\n', hasFinalBreak: false };
  const firstLf = text.indexOf('\n');
  const crlf = firstLf > 0 && text[firstLf - 1] === '\r';
  const br = crlf ? '\r\n' : '\n';
  const hasFinalBreak = text.endsWith(br);
  const raw = text.split(br);
  if (hasFinalBreak) raw.pop();
  return { lines: raw, br, hasFinalBreak };
}

function assembleFile(lines: string[], br: string, hasFinalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (hasFinalBreak ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: { oldPath: string; newPath: string }[] = [];

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

// --- 3-Tier Match Engine ---
const stripTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingIndent = (s: string): string => {
  const m = s.match(/^[ \t]*/);
  return m ? m[0] : '';
};

interface MatchResult {
  tier: number;
  positions: number[];
}

function findOccurrences(
  fileLines: string[],
  targetLines: string[],
  strict: boolean,
  startFrom = 0
): MatchResult {
  if (targetLines.length === 0) {
    return { tier: 0, positions: [] };
  }
  const m = targetLines.length;
  const maxIdx = fileLines.length - m;
  if (maxIdx < startFrom) {
    return { tier: -1, positions: [] };
  }

  // Tier 0
  const tier0: number[] = [];
  for (let i = startFrom; i <= maxIdx; i++) {
    let match = true;
    for (let j = 0; j < m; j++) {
      if (fileLines[i + j] !== targetLines[j]) {
        match = false;
        break;
      }
    }
    if (match) tier0.push(i);
  }
  if (tier0.length > 0) return { tier: 0, positions: tier0 };
  if (strict) return { tier: -1, positions: [] };

  // Tier 1
  const t1Target = targetLines.map(stripTrailing);
  const tier1: number[] = [];
  for (let i = startFrom; i <= maxIdx; i++) {
    let match = true;
    for (let j = 0; j < m; j++) {
      if (stripTrailing(fileLines[i + j]!) !== t1Target[j]) {
        match = false;
        break;
      }
    }
    if (match) tier1.push(i);
  }
  if (tier1.length > 0) return { tier: 1, positions: tier1 };

  // Tier 2
  const t2Target = targetLines.map(stripBoth);
  const tier2: number[] = [];
  for (let i = startFrom; i <= maxIdx; i++) {
    let match = true;
    for (let j = 0; j < m; j++) {
      if (stripBoth(fileLines[i + j]!) !== t2Target[j]) {
        match = false;
        break;
      }
    }
    if (match) tier2.push(i);
  }
  if (tier2.length > 0) return { tier: 2, positions: tier2 };

  return { tier: -1, positions: [] };
}

// --- JSON Edits Parser ---
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

// --- SEARCH/REPLACE Parser ---
interface SearchReplaceBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  searchLineNum: number;
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchReplaceBlock[] = [];
  let prevReplaceIdx = -1;
  let prevPath: string | null = null;
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let foundPath: string | null = null;
      for (let k = i - 1; k > prevReplaceIdx; k--) {
        const trimmed = lines[k]!.trim();
        if (trimmed !== '' && !trimmed.startsWith('```')) {
          foundPath = trimmed;
          break;
        }
      }
      const path = foundPath ?? prevPath;
      if (path === null) {
        throw new Exit2(`error: parse ${searchLine}`);
      }

      let sepIdx = -1;
      let endIdx = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const lineEnd = lines[j]!.trimEnd();
        if (lineEnd === '<<<<<<< SEARCH') {
          break;
        }
        if (lineEnd === '=======' && sepIdx === -1) {
          sepIdx = j;
        } else if (lineEnd === '>>>>>>> REPLACE' && sepIdx !== -1) {
          endIdx = j;
          break;
        }
      }

      if (sepIdx === -1 || endIdx === -1) {
        throw new Exit2(`error: parse ${searchLine}`);
      }

      const oldLines = lines.slice(i + 1, sepIdx);
      const newLines = lines.slice(sepIdx + 1, endIdx);
      blocks.push({ path, oldLines, newLines, searchLineNum: searchLine });
      prevReplaceIdx = endIdx;
      prevPath = path;
      i = endIdx + 1;
    } else {
      i++;
    }
  }

  if (blocks.length === 0) {
    throw new Exit2('error: parse 1');
  }

  return blocks.map((block) => (tree: Tree) => {
    const p = block.path;
    if (!safe(p)) throw new Fail('unsafe', p);

    if (block.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const content = assembleFile(block.newLines, '\n', true);
      tree.now.set(p, content);
    } else {
      if (tree.get(p) === null) throw new Fail('missing', p);
      const before = tree.get(p)!;
      const file = parseFile(before);
      const res = findOccurrences(file.lines, block.oldLines, strict);
      if (res.tier === -1 || res.positions.length === 0) {
        throw new Fail('no-match', p);
      }
      if (res.positions.length > 1) {
        throw new Fail('ambiguous', p);
      }
      const pos = res.positions[0]!;
      let replacement = block.newLines;
      if (res.tier === 2) {
        const F = leadingIndent(file.lines[pos]!);
        const P = leadingIndent(block.oldLines[0]!);
        replacement = block.newLines.map((l) => {
          if (!/^[ \t]*$/.test(l) && l.startsWith(P)) {
            return F + l.slice(P.length);
          }
          return l;
        });
      }
      file.lines.splice(pos, block.oldLines.length, ...replacement);
      const content = assembleFile(file.lines, file.br, file.hasFinalBreak);
      tree.now.set(p, content);
    }
  });
}

// --- V4A Parser ---
interface V4aChunk {
  anchor: string | null;
  body: { kind: ' ' | '-' | '+'; text: string; isContext: boolean }[];
  isEof: boolean;
}

interface V4aSection {
  type: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  headerLine: number;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${first + 1}`);
  }

  let last = -1;
  for (let idx = lines.length - 1; idx >= 0; idx--) {
    if (!blank(lines[idx]!)) {
      last = idx;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const sections: V4aSection[] = [];
  let i = first + 1;

  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      const secLine = i + 1;
      i++;
      const fileLines: string[] = [];
      while (i < last) {
        const cur = lines[i]!;
        if (cur.startsWith('*** Add File: ') || cur.startsWith('*** Delete File: ') || cur.startsWith('*** Update File: ')) {
          break;
        }
        if (cur === '') {
          let onlyBlank = true;
          for (let k = i; k < last; k++) {
            if (lines[k]!.startsWith('*** Add File: ') || lines[k]!.startsWith('*** Delete File: ') || lines[k]!.startsWith('*** Update File: ')) {
              break;
            }
            if (lines[k]! !== '') {
              onlyBlank = false;
              break;
            }
          }
          if (onlyBlank) break;
          fileLines.push('');
          i++;
        } else if (cur.startsWith('+')) {
          fileLines.push(cur.slice(1));
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      sections.push({ type: 'add', path, moveTo: null, lines: fileLines, chunks: [], headerLine: secLine });
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      const secLine = i + 1;
      i++;
      while (i < last && blank(lines[i]!)) i++;
      if (i < last && !lines[i]!.startsWith('*** Add File: ') && !lines[i]!.startsWith('*** Delete File: ') && !lines[i]!.startsWith('*** Update File: ')) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push({ type: 'delete', path, moveTo: null, lines: [], chunks: [], headerLine: secLine });
    } else if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim();
      const secLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      while (i < last) {
        if (blank(lines[i]!)) {
          let onlyBlank = true;
          for (let k = i; k < last; k++) {
            if (lines[k]!.startsWith('*** Add File: ') || lines[k]!.startsWith('*** Delete File: ') || lines[k]!.startsWith('*** Update File: ')) {
              onlyBlank = false;
              break;
            }
            if (!blank(lines[k]!)) {
              onlyBlank = false;
              break;
            }
          }
          if (onlyBlank) {
            while (i < last && blank(lines[i]!)) i++;
            break;
          }
        }
        const cur = lines[i]!;
        if (cur.startsWith('*** Add File: ') || cur.startsWith('*** Delete File: ') || cur.startsWith('*** Update File: ')) {
          break;
        }
        let anchor: string | null = null;
        if (cur.startsWith('@@')) {
          const rest = cur.slice(2).trim();
          anchor = rest === '' ? null : rest;
          i++;
        }
        const chunkBody: { kind: ' ' | '-' | '+'; text: string; isContext: boolean }[] = [];
        let isEof = false;
        while (i < last) {
          const bLine = lines[i]!;
          if (bLine.startsWith('*** End of File')) {
            isEof = true;
            i++;
            break;
          }
          if (bLine.startsWith('@@') || bLine.startsWith('*** Add File: ') || bLine.startsWith('*** Delete File: ') || bLine.startsWith('*** Update File: ')) {
            break;
          }
          if (blank(bLine)) {
            let onlyBlank = true;
            for (let k = i; k < last; k++) {
              if (lines[k]!.startsWith('*** Add File: ') || lines[k]!.startsWith('*** Delete File: ') || lines[k]!.startsWith('*** Update File: ') || lines[k]!.startsWith('@@')) {
                onlyBlank = false;
                break;
              }
              if (!blank(lines[k]!)) {
                onlyBlank = false;
                break;
              }
            }
            if (onlyBlank) {
              while (i < last && blank(lines[i]!)) i++;
              break;
            }
            chunkBody.push({ kind: ' ', text: bLine.startsWith(' ') ? bLine.slice(1) : '', isContext: true });
            i++;
          } else if (bLine.startsWith(' ')) {
            chunkBody.push({ kind: ' ', text: bLine.slice(1), isContext: true });
            i++;
          } else if (bLine.startsWith('-')) {
            chunkBody.push({ kind: '-', text: bLine.slice(1), isContext: false });
            i++;
          } else if (bLine.startsWith('+')) {
            chunkBody.push({ kind: '+', text: bLine.slice(1), isContext: false });
            i++;
          } else {
            throw new Exit2(`error: parse ${i + 1}`);
          }
        }
        chunks.push({ anchor, body: chunkBody, isEof });
      }

      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${secLine}`);
      }
      sections.push({ type: 'update', path, moveTo, lines: [], chunks, headerLine: secLine });
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }

  if (sections.length === 0) {
    throw new Exit2('error: parse 1');
  }

  return sections.map((sec) => (tree: Tree) => {
    if (sec.type === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      const content = assembleFile(sec.lines, '\n', true);
      tree.now.set(sec.path, content);
    } else if (sec.type === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    } else if (sec.type === 'update') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);

      const before = tree.get(sec.path)!;
      const file = parseFile(before);
      let cursor = 0;

      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null) {
          const anchorRes = findOccurrences(file.lines, [chunk.anchor], strict, cursor);
          if (anchorRes.tier === -1 || anchorRes.positions.length === 0) {
            throw new Fail('no-match', sec.path);
          }
          cursor = anchorRes.positions[0]! + 1;
        }

        const O = chunk.body.filter((b) => b.kind === ' ' || b.kind === '-');
        const N = chunk.body.filter((b) => b.kind === ' ' || b.kind === '+');

        if (O.length > 0) {
          const oLines = O.map((b) => b.text);
          let matchPos = -1;
          let chosenTier = -1;

          if (chunk.isEof) {
            const candidatePos = file.lines.length - O.length;
            if (candidatePos >= cursor) {
              const res0 = findOccurrences(file.lines, oLines, true, candidatePos);
              if (res0.positions.includes(candidatePos)) {
                matchPos = candidatePos;
                chosenTier = 0;
              } else if (!strict) {
                const res = findOccurrences(file.lines, oLines, false, candidatePos);
                if (res.positions.includes(candidatePos)) {
                  matchPos = candidatePos;
                  chosenTier = res.tier;
                }
              }
            }
            if (matchPos === -1) {
              throw new Fail('no-match', sec.path);
            }
          } else {
            const res = findOccurrences(file.lines, oLines, strict, cursor);
            if (res.tier === -1 || res.positions.length === 0) {
              throw new Fail('no-match', sec.path);
            }
            matchPos = res.positions[0]!;
            chosenTier = res.tier;
          }

          const ctxFileLines: string[] = [];
          for (let m = 0; m < O.length; m++) {
            if (O[m]!.isContext) {
              ctxFileLines.push(file.lines[matchPos + m]!);
            }
          }

          const F = leadingIndent(file.lines[matchPos]!);
          const P = leadingIndent(oLines[0]!);
          let ctxIdx = 0;
          const replacement: string[] = [];
          for (const item of N) {
            if (item.isContext) {
              replacement.push(ctxFileLines[ctxIdx++]!);
            } else {
              if (chosenTier === 2) {
                if (!/^[ \t]*$/.test(item.text) && item.text.startsWith(P)) {
                  replacement.push(F + item.text.slice(P.length));
                } else {
                  replacement.push(item.text);
                }
              } else {
                replacement.push(item.text);
              }
            }
          }

          file.lines.splice(matchPos, O.length, ...replacement);
          cursor = matchPos + replacement.length;
        } else {
          const insertPos = chunk.isEof ? file.lines.length : cursor;
          const nLines = N.map((b) => b.text);
          file.lines.splice(insertPos, 0, ...nLines);
          cursor = insertPos + nLines.length;
        }
      }

      const content = assembleFile(file.lines, file.br, file.hasFinalBreak);
      if (sec.moveTo !== null) {
        tree.now.set(sec.path, null);
        tree.now.set(sec.moveTo, content);
        tree.moves.push({ oldPath: sec.path, newPath: sec.moveTo });
      } else {
        tree.now.set(sec.path, content);
      }
    }
  });
}

// --- Unified Diff Parser ---
interface UnifiedHunk {
  a: number;
  c: number;
  body: { kind: ' ' | '-' | '+'; text: string; isContext: boolean }[];
  endsWithoutNewline: boolean;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreation: boolean;
  isDeletion: boolean;
  hunks: UnifiedHunk[];
  headerLine: number;
  hasPathsHeader: boolean;
}

function cleanDiffPath(p: string): string | null {
  const raw = p.split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let currentSection: UnifiedSection | null = null;
  let i = 0;

  while (i < lines.length) {
    const l = lines[i]!;

    if (l.startsWith('diff --git ')) {
      const m = l.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (!m) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      currentSection = {
        oldPath: m[1]!,
        newPath: m[2]!,
        isCreation: false,
        isDeletion: false,
        hunks: [],
        headerLine: i + 1,
        hasPathsHeader: false
      };
      sections.push(currentSection);
      i++;
      continue;
    }

    if (l.startsWith('--- ')) {
      if (i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
        if (currentSection !== null && currentSection.hunks.length === 0 && !currentSection.hasPathsHeader) {
          currentSection.oldPath = cleanDiffPath(l.slice(4));
          currentSection.newPath = cleanDiffPath(lines[i + 1]!.slice(4));
          currentSection.hasPathsHeader = true;
          i += 2;
          continue;
        } else {
          currentSection = {
            oldPath: cleanDiffPath(l.slice(4)),
            newPath: cleanDiffPath(lines[i + 1]!.slice(4)),
            isCreation: false,
            isDeletion: false,
            hunks: [],
            headerLine: i + 1,
            hasPathsHeader: true
          };
          sections.push(currentSection);
          i += 2;
          continue;
        }
      } else {
        if (currentSection !== null && currentSection.hunks.length === 0) {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        i++;
        continue;
      }
    }

    if (currentSection !== null && currentSection.hunks.length === 0) {
      if (l.startsWith('rename from ')) {
        currentSection.oldPath = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        currentSection.newPath = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        currentSection.isCreation = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        currentSection.isDeletion = true;
        i++;
        continue;
      }
    }

    if (l.startsWith('@@')) {
      if (currentSection === null) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)?$/);
      if (!m) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const a = parseInt(m[1]!, 10);
      const c = parseInt(m[2]!, 10);
      i++;

      const rawBody: { kind: ' ' | '-' | '+' | '\\'; text: string; lineNum: number }[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        if (cur.startsWith('diff --git ')) break;
        if (cur.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) break;
        if (cur.startsWith('@@')) break;
        if (cur.startsWith(' ')) {
          rawBody.push({ kind: ' ', text: cur.slice(1), lineNum: i + 1 });
          i++;
        } else if (cur === '') {
          rawBody.push({ kind: ' ', text: '', lineNum: i + 1 });
          i++;
        } else if (cur.startsWith('-')) {
          rawBody.push({ kind: '-', text: cur.slice(1), lineNum: i + 1 });
          i++;
        } else if (cur.startsWith('+')) {
          rawBody.push({ kind: '+', text: cur.slice(1), lineNum: i + 1 });
          i++;
        } else if (cur.startsWith('\\')) {
          rawBody.push({ kind: '\\', text: cur.slice(1), lineNum: i + 1 });
          i++;
        } else {
          break;
        }
      }

      while (rawBody.length > 0 && rawBody[rawBody.length - 1]!.kind === ' ' && rawBody[rawBody.length - 1]!.text === '') {
        rawBody.pop();
      }

      let lastNewOrCtxIdx = -1;
      for (let k = rawBody.length - 1; k >= 0; k--) {
        if (rawBody[k]!.kind === ' ' || rawBody[k]!.kind === '+') {
          lastNewOrCtxIdx = k;
          break;
        }
      }
      let endsWithoutNewline = false;
      if (lastNewOrCtxIdx >= 0 && lastNewOrCtxIdx + 1 < rawBody.length && rawBody[lastNewOrCtxIdx + 1]!.kind === '\\') {
        endsWithoutNewline = true;
      }

      const body = rawBody
        .filter((b) => b.kind !== '\\')
        .map((b) => ({
          kind: b.kind as ' ' | '-' | '+',
          text: b.text,
          isContext: b.kind === ' '
        }));

      currentSection.hunks.push({ a, c, body, endsWithoutNewline });
      continue;
    }

    i++;
  }

  if (sections.length === 0) {
    throw new Exit2('error: parse 1');
  }

  return sections.map((sec) => (tree: Tree) => {
    const isCreation = sec.isCreation || sec.oldPath === null;
    const isDeletion = sec.isDeletion || sec.newPath === null;

    if (isCreation) {
      const p = sec.newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plusLines: string[] = [];
      for (const hunk of sec.hunks) {
        for (const item of hunk.body) {
          if (item.kind === '+') plusLines.push(item.text);
        }
      }
      let endsWithBreak = true;
      if (sec.hunks.length > 0) {
        const lastHunk = sec.hunks[sec.hunks.length - 1]!;
        if (lastHunk.endsWithoutNewline) endsWithBreak = false;
      }
      const content = assembleFile(plusLines, '\n', endsWithBreak);
      tree.now.set(p, content);
      return;
    }

    if (isDeletion) {
      const p = sec.oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }

    const isMove = sec.oldPath !== sec.newPath;
    const oldP = sec.oldPath!;
    const newP = sec.newPath!;

    if (isMove) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);

      const before = tree.get(oldP)!;
      const file = parseFile(before);
      applyUnifiedHunks(file, sec.hunks, oldP, strict);
      const content = assembleFile(file.lines, file.br, file.hasFinalBreak);
      tree.now.set(oldP, null);
      tree.now.set(newP, content);
      tree.moves.push({ oldPath: oldP, newPath: newP });
    } else {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);

      const before = tree.get(oldP)!;
      const file = parseFile(before);
      applyUnifiedHunks(file, sec.hunks, oldP, strict);
      const content = assembleFile(file.lines, file.br, file.hasFinalBreak);
      tree.now.set(oldP, content);
    }
  });
}

function applyUnifiedHunks(
  file: FileContent,
  hunks: UnifiedHunk[],
  filePath: string,
  strict: boolean
): void {
  let d = 0;
  for (const hunk of hunks) {
    const O = hunk.body.filter((b) => b.kind === ' ' || b.kind === '-');
    const N = hunk.body.filter((b) => b.kind === ' ' || b.kind === '+');

    if (O.length > 0) {
      const oLines = O.map((b) => b.text);
      const res = findOccurrences(file.lines, oLines, strict);
      if (res.tier === -1 || res.positions.length === 0) {
        throw new Fail('no-match', filePath);
      }
      const targetPos = hunk.a - 1 + d;
      let bestPos = res.positions[0]!;
      let bestDist = Math.abs(bestPos - targetPos);
      for (let i = 1; i < res.positions.length; i++) {
        const p = res.positions[i]!;
        const dist = Math.abs(p - targetPos);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = p;
        } else if (dist === bestDist && p < bestPos) {
          bestPos = p;
        }
      }

      const matchedToEnd = bestPos + O.length === file.lines.length;

      const ctxFileLines: string[] = [];
      for (let m = 0; m < O.length; m++) {
        if (O[m]!.isContext) {
          ctxFileLines.push(file.lines[bestPos + m]!);
        }
      }

      const F = leadingIndent(file.lines[bestPos]!);
      const P = leadingIndent(oLines[0]!);
      let ctxIdx = 0;
      const replacement: string[] = [];
      for (const item of N) {
        if (item.isContext) {
          replacement.push(ctxFileLines[ctxIdx++]!);
        } else {
          if (res.tier === 2) {
            if (!/^[ \t]*$/.test(item.text) && item.text.startsWith(P)) {
              replacement.push(F + item.text.slice(P.length));
            } else {
              replacement.push(item.text);
            }
          } else {
            replacement.push(item.text);
          }
        }
      }

      file.lines.splice(bestPos, O.length, ...replacement);
      if (matchedToEnd) {
        file.hasFinalBreak = !hunk.endsWithoutNewline;
      }
    } else {
      const insertPos = Math.min(file.lines.length, Math.max(0, hunk.a + d));
      const atEnd = insertPos === file.lines.length;
      const nLines = N.map((b) => b.text);
      file.lines.splice(insertPos, 0, ...nLines);
      if (atEnd) {
        file.hasFinalBreak = !hunk.endsWithoutNewline;
      }
    }

    d += N.length - O.length;
  }
}

// --- Main CLI Execution ---
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;

  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const val = a.slice(9);
        if (format !== null || !FORMATS.includes(val)) {
          return { code: 2, out: ['error: usage'] };
        }
        format = val;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
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
    if (kind === 'json') {
      edits = jsonEdits(text, lines);
    } else if (kind === 'search-replace') {
      edits = parseSearchReplace(lines, strict);
    } else if (kind === 'v4a') {
      edits = parseV4a(lines, strict);
    } else if (kind === 'unified') {
      edits = parseUnified(lines, strict);
    } else {
      return { code: 2, out: ['error: format'] };
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];

  for (const edit of edits) {
    const beforeState = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeState) tree.now.set(k, v);
      tree.moves = [...beforeMoves];
      fails.push(e);
    }
  }

  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`
      ]
    };
  }

  // Determine qualified moves (R <old> -> <new>)
  const qualifiedMoves: { oldPath: string; newPath: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const m of tree.moves) {
    if (
      tree.original(m.oldPath) !== null &&
      tree.now.get(m.oldPath) === null &&
      tree.original(m.newPath) === null &&
      tree.now.get(m.newPath) !== null
    ) {
      qualifiedMoves.push(m);
      movedOld.add(m.oldPath);
      movedNew.add(m.newPath);
    }
  }

  interface Row {
    sortKey: string;
    line: string;
  }
  const rows: Row[] = [];

  for (const m of qualifiedMoves) {
    rows.push({
      sortKey: m.newPath,
      line: `R ${m.oldPath} -> ${m.newPath}`
    });
  }

  for (const p of tree.now.keys()) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && now !== null) {
      rows.push({ sortKey: p, line: `A ${p}` });
    } else if (was !== null && now === null) {
      rows.push({ sortKey: p, line: `D ${p}` });
    } else if (was !== null && now !== null) {
      rows.push({ sortKey: p, line: `M ${p}` });
    }
  }

  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey, 'utf8'), Buffer.from(b.sortKey, 'utf8')));

  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }

  const fileCount = rows.length;
  const countMsg = fileCount === 1 ? 'ok: 1 file' : `ok: ${fileCount} files`;

  return {
    code: 0,
    out: [...rows.map((r) => r.line), countMsg]
  };
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
