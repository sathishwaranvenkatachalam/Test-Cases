import XLSX from 'xlsx';
import type { ColumnMapping, RawCase, RawStep } from '../shared/types.js';

export interface ParsedSheet { name: string; headers: string[]; rows: Record<string, string>[]; }

export function parseWorkbook(filePath: string): ParsedSheet[] {
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
