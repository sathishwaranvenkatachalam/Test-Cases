import XLSX from 'xlsx';
import type { ColumnMapping, RawCase, RawStep } from '../shared/types.js';
import fs from 'node:fs';
import path from 'node:path';

export interface ParsedSheet { name: string; headers: string[]; rows: Record<string, string>[]; }

export function parseWorkbook(filePath: string): ParsedSheet[] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.htm') return parseHtml(filePath);
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const out: ParsedSheet[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '', blankrows: false });
    if (aoa.length === 0) continue;

    // header row: first row (scan first 10) with at least 2 non-empty cells; else row 0
    let headerIdx = 0;
    for (let i = 0; i < Math.min(10, aoa.length); i++) {
      const nonEmpty = aoa[i].filter(c => String(c ?? '').trim() !== '').length;
      if (nonEmpty >= 2) { headerIdx = i; break; }
    }

    const rawHeaders = aoa[headerIdx].map(c => String(c ?? '').trim());
    const headers: string[] = [];
    const seen = new Map<string, number>();
    rawHeaders.forEach((h, idx) => {
      let base = h === '' ? `Column ${idx + 1}` : h;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      headers.push(count === 1 ? base : `${base} (${count})`);
    });

    const rows: Record<string, string>[] = [];
    for (let i = headerIdx + 1; i < aoa.length; i++) {
      const obj: Record<string, string> = {};
      let any = false;
      headers.forEach((h, j) => {
        const v = String(aoa[i][j] ?? '').trim();
        if (v !== '') any = true;
        obj[h] = v;
      });
      if (any) rows.push(obj);
    }
    if (rows.length === 0) continue;
    out.push({ name, headers, rows });
  }
  return out;
}

function findHeader(headers: string[], re: RegExp, used: Set<string>): string | null {
  for (const h of headers) {
    if (used.has(h)) continue;
    if (re.test(h)) { used.add(h); return h; }
  }
  return null;
}

export function guessMapping(headers: string[], rows: Record<string, string>[]): ColumnMapping {
  const used = new Set<string>();
  const caseId = findHeader(headers, /^(test\s*)?(case\s*)?(id|no\.?|number|#)$|^tc[\s_-]?id$|case\s*id/i, used);
  const title = findHeader(headers, /title|name|summary|scenario|description|test case$/i, used);
  const flow = findHeader(headers, /flow|module|feature|area|suite|component|epic/i, used);
  const steps = findHeader(headers, /^steps?$|step\s*(description|details|action)|actions?|procedure|test steps/i, used);
  const expected = findHeader(headers, /expected|result|outcome|verify|assertion/i, used);
  const stepNo = findHeader(headers, /^step\s*(no\.?|#|number)$|^seq/i, used);

  let mode: ColumnMapping['mode'] = 'per-row-case';
  if (stepNo !== null) {
    mode = 'per-row-step';
  } else if (caseId !== null) {
    const vals = rows.map(r => (r[caseId] ?? '').trim()).filter(v => v !== '');
    if (vals.length > 0) {
      const counts = new Map<string, number>();
      for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
      const dupRows = vals.filter(v => (counts.get(v) ?? 0) > 1).length;
      if (dupRows / vals.length > 0.2) mode = 'per-row-step';
    }
  }

  return { mode, caseId, title, flow, steps, expected, stepNo };
}

export function splitSteps(cell: string): string[] {
  const normalized = (cell ?? '').replace(/\r\n/g, '\n');
  let lines = normalized
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
    .map(l => l.replace(/^\s*(?:\d+[\.\)\:]|[-*•]|step\s*\d+[\.\:\)]?)\s*/i, '').trim())
    .filter(l => l !== '');

  if (lines.length === 1 && (/;/.test(lines[0]) || / -> /.test(lines[0]) || /→/.test(lines[0]))) {
    lines = lines[0]
      .split(/\s*;\s*|\s+->\s+|\s*→\s*/)
      .map(s => s.trim())
      .filter(s => s !== '');
  }
  return lines;
}

export function extractRawCases(sheet: ParsedSheet, mapping: ColumnMapping): RawCase[] {
  const get = (row: Record<string, string>, col: string | null): string =>
    col === null ? '' : (row[col] ?? '').trim();
  const sheetIsGeneric = /^sheet\d*$/i.test(sheet.name);
  const sheetFlow = sheetIsGeneric ? null : sheet.name;

  if (mapping.mode === 'per-row-case') {
    const cases: RawCase[] = [];
    for (const row of sheet.rows) {
      const stepTexts = splitSteps(get(row, mapping.steps));
      const title = get(row, mapping.title);
      if (stepTexts.length === 0 && title === '') continue;
      const flowName = get(row, mapping.flow) || sheetFlow;
      const externalId = get(row, mapping.caseId) || null;
      const finalExpected = get(row, mapping.expected) || null;
      cases.push({
        externalId,
        title: title || (stepTexts.length > 0 ? stepTexts[0].slice(0, 80) : `Untitled case ${cases.length + 1}`),
        flowName,
        steps: stepTexts.map(text => ({ text })),
        finalExpected,
      });
    }
    return cases;
  }

  // per-row-step
  const groupCol = mapping.caseId ?? mapping.title;
  interface Group { caseId: string; titles: string[]; flows: string[]; steps: { n: number; step: RawStep }[]; }
  const groups: Group[] = [];
  let current: Group | null = null;
  let currentVal = '';

  for (const row of sheet.rows) {
    const val = get(row, groupCol);
    if (current === null || (val !== '' && val !== currentVal)) {
      current = { caseId: '', titles: [], flows: [], steps: [] };
      groups.push(current);
      currentVal = val;
    }
    if (val !== '') current.caseId = current.caseId || val;
    const t = get(row, mapping.title);
    if (t !== '') current.titles.push(t);
    const f = get(row, mapping.flow);
    if (f !== '') current.flows.push(f);
    const text = get(row, mapping.steps);
    if (text !== '') {
      const n = mapping.stepNo ? Number(get(row, mapping.stepNo)) : NaN;
      current.steps.push({ n: Number.isNaN(n) ? Infinity : n, step: { text, expected: get(row, mapping.expected) || null } });
    }
  }

  const cases: RawCase[] = [];
  for (const g of groups) {
    const steps = g.steps.slice();
    if (mapping.stepNo) {
      steps.sort((a, b) => (a.n === b.n ? 0 : a.n < b.n ? -1 : 1));
    }
    const title = g.titles[0] || g.caseId || `Untitled case ${cases.length + 1}`;
    cases.push({
      externalId: g.caseId || null,
      title,
      flowName: g.flows[0] || sheetFlow,
      steps: steps.map(s => s.step),
      finalExpected: null,
    });
  }
  return cases;
}

// ---- HTML (embedded JS array of case objects) ----

/** Index just past the `]` matching the `[` at `start`, skipping strings and comments; -1 if unbalanced. */
function matchBracket(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
    } else if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Parses a JS literal (objects, arrays, strings, numbers, true/false/null, comments, trailing commas). Never executes code; throws on anything else. */
export function parseJsLiteral(src: string): unknown {
  let i = 0;
  const fail = (): never => { throw new Error(`Unsupported JS literal at ${i}`); };
  const ws = (): void => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; }
      else if (src[i] === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2);
        if (e === -1) fail();
        i = e + 2;
      } else return;
    }
  };
  const str = (): string => {
    const q = src[i++];
    let out = '';
    while (i < src.length && src[i] !== q) {
      const c = src[i++];
      if (c !== String.fromCharCode(92)) { out += c; continue; }
      const n = src[i++];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '\r';
      else if (n === 'b') out += '\b';
      else if (n === 'f') out += '\f';
      else if (n === 'v') out += '\v';
      else if (n === '0') out += '\0';
      else if (n === 'u') {
        const h = src.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(h)) fail();
        out += String.fromCharCode(parseInt(h, 16)); i += 4;
      } else if (n === 'x') {
        const h = src.slice(i, i + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(h)) fail();
        out += String.fromCharCode(parseInt(h, 16)); i += 2;
      } else if (n === '\n') { /* line continuation */ }
      else out += n;
    }
    if (src[i] !== q) fail();
    i++;
    return out;
  };
  const value = (): unknown => {
    ws();
    const c = src[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        ws();
        if (src[i] === ']') { i++; return arr; }
        arr.push(value());
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== ']') fail();
      }
    }
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = Object.create(null);
      for (;;) {
        ws();
        if (src[i] === '}') { i++; return { ...obj }; }
        let key: string;
        if (src[i] === '"' || src[i] === "'") key = str();
        else {
          const m = /^[A-Za-z_$][\w$]*|^\d+/.exec(src.slice(i));
          if (!m) return fail();
          key = m[0]; i += key.length;
        }
        ws();
        if (src[i] !== ':') fail();
        i++;
        const v = value();
        if (key !== '__proto__') obj[key] = v;
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== '}') fail();
      }
    }
    const m = /^(?:-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|true|false|null)/.exec(src.slice(i));
    if (!m) return fail();
    i += m[0].length;
    return m[0] === 'true' ? true : m[0] === 'false' ? false : m[0] === 'null' ? null : Number(m[0]);
  };
  const result = value();
  ws();
  if (i !== src.length) fail();
  return result;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(x => cellText(x)).filter(s => s !== '').join('\n');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).trim();
}

/** Finds `const|let|var NAME = [ {...}, ... ]` in the HTML's <script> blocks; returns the first array of objects where at least one object has an array-valued property (the steps). */
export function extractHtmlCaseArray(html: string): Record<string, unknown>[] | null {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  for (const src of scripts) {
    for (const m of src.matchAll(/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\[/g)) {
      const start = (m.index ?? 0) + m[0].length - 1;
      const end = matchBracket(src, start);
      if (end === -1) continue;
      let value: unknown;
      try {
        value = parseJsLiteral(src.slice(start, end));
      } catch {
        continue;
      }
      if (!Array.isArray(value) || value.length === 0) continue;
      const objs = value.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x));
      if (objs.length !== value.length) continue;
      if (objs.some(o => Object.values(o).some(v => Array.isArray(v)))) return objs;
    }
  }
  return null;
}

export function parseHtml(filePath: string): ParsedSheet[] {
  const html = fs.readFileSync(filePath, 'utf8');
  const objs = extractHtmlCaseArray(html);
  if (objs === null) {
    throw new Error('No test-case data found in HTML (expected a <script> with an array of case objects that contain a steps array)');
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const name = (titleMatch?.[1] ?? '').replace(/\s+/g, ' ').trim() || path.basename(filePath, path.extname(filePath));

  const keys: string[] = [];
  for (const o of objs) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
  // Header = key with first letter capitalised; plain "id" -> "ID" so guessMapping finds it.
  const headerOf = (k: string): string => (k.toLowerCase() === 'id' ? 'ID' : k.charAt(0).toUpperCase() + k.slice(1));
  const headers = keys.map(headerOf);

  const rows: Record<string, string>[] = [];
  for (const o of objs) {
    const row: Record<string, string> = {};
    let any = false;
    keys.forEach((k, i) => {
      const v = cellText(o[k]);
      if (v !== '') any = true;
      row[headers[i]] = v;
    });
    if (any) rows.push(row);
  }
  if (rows.length === 0) throw new Error('No test-case data found in HTML');
  return [{ name, headers, rows }];
}
