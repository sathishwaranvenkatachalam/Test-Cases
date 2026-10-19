# Plan: accept HTML test-case files (flowchart HTML) in ingest

Goal: Upload page and `/api/ingest/parse` must accept `.html`/`.htm` files like `C:\Repos\Test-Cases\test_case_flowchart_1 (1).html`. That file has a `<script>` containing `const RAW = [ { id:"EMP-001", module:"...", scenario:"...", objective:"...", priority:"High", type:"E2E", status:"Pass", evidence:"...", defects:"", steps:["...","..."] }, ... ];` (JS object-literal syntax, NOT JSON). We extract that array, evaluate it in a sandbox, and convert it to a `ParsedSheet` (same shape CSV/xlsx produce). Everything downstream (guessMapping, extractRawCases, Claude canonicalization) is unchanged.

## Scope boundaries (DO NOT)
- Do NOT edit `playwright/generated/*`, `server/ingest.ts`, `server/planner.ts`, `shared/types.ts`.
- Do NOT touch the user's HTML file.
- Do NOT add npm dependencies.
- Do NOT change `guessMapping`/`extractRawCases`/`splitSteps`.
- Do NOT use `eval` or `new Function`; use `node:vm` only.

## Step 1 — `server/parse.ts`
1a. Add imports at top (after the existing two imports):
```ts
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
```
1b. Make `parseWorkbook` dispatch by extension. Change:
```ts
export function parseWorkbook(filePath: string): ParsedSheet[] {
  const wb = XLSX.readFile(filePath, { cellDates: false });
```
to:
```ts
export function parseWorkbook(filePath: string): ParsedSheet[] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.htm') return parseHtml(filePath);
  const wb = XLSX.readFile(filePath, { cellDates: false });
```
1c. Append these functions at the END of the file (after `extractRawCases`):
```ts
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
        value = vm.runInNewContext('(' + src.slice(start, end) + ')', Object.create(null), { timeout: 1000 });
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
```
Behaviour (do not change): `steps` arrays become newline-joined cells, which `splitSteps` already handles; the sheet name is the HTML `<title>`; headers are the object keys capitalised (`ID, Module, Scenario, Objective, Priority, Type, Status, Evidence, Defects, Steps`), so `guessMapping` picks caseId=ID, title=Scenario, flow=Module, steps=Steps, mode=per-row-case.

## Step 2 — `server/routes/ingest.ts`
Change `const ALLOWED_EXT = ['.xlsx', '.xls', '.csv'];` to:
```ts
const ALLOWED_EXT = ['.xlsx', '.xls', '.csv', '.html', '.htm'];
```
Then read the `router.post('/ingest/parse', ...)` handler (around line 64). If `parseWorkbook(req.file.path)` is not already inside a try/catch that converts errors to an HTTP 400, wrap it: on a thrown Error, first `fs.rmSync(req.file.path, { force: true })`, then `throw new HttpError(400, (e as Error).message)`. If already handled, leave it. Keep the file's existing style.

## Step 3 — `web/src/pages/Upload.tsx`
Change `accept=".xlsx,.xls,.csv"` to `accept=".xlsx,.xls,.csv,.html,.htm"`. If visible text on that page lists file types ("xlsx/csv"), append "/html" in the same style. Nothing else.

## Step 4 — `README.md`
Line 7: change ``Upload `.xlsx` / `.csv` test-case files`` to ``Upload `.xlsx` / `.csv` / `.html` test-case files`` and append to that bullet: ``HTML files must embed the cases as a JS array of objects in a `<script>` (e.g. `const RAW = [{ id, module, scenario, steps: [...] }]`).``

## Step 5 — tests: append to `tests/parse.test.ts`
Add at the end of the file (reuse existing `writeTmp`, `parseWorkbook`, `guessMapping`, `extractRawCases`, `fs`, `path` imports already at top):
```ts
describe('parse html', () => {
  const html = `<!DOCTYPE html><html><head><title>Demo – Flowchart</title></head><body>
<script>
// comment with [ bracket
const RAW = [
  { id:"T-1", module:"Login", scenario:"Valid login", status:"Pass", steps:[
    "Open login page.",
    "Enter user, then ] click Sign in.",
  ]},
  {
    id:"T-2", module:"Login", scenario:"Bad login", steps:["Open login page.", "Enter wrong password."]
  },
];
const OTHER = [1, 2, 3];
</script></body></html>`;

  it('extracts the embedded case array and maps it', () => {
    const sheets = parseWorkbook(writeTmp('cases.html', html));
    expect(sheets.length).toBe(1);
    const sheet = sheets[0];
    expect(sheet.name).toBe('Demo – Flowchart');
    expect(sheet.rows.length).toBe(2);
    const mapping = guessMapping(sheet.headers, sheet.rows);
    expect(mapping.mode).toBe('per-row-case');
    expect(mapping.caseId).toBe('ID');
    expect(mapping.title).toBe('Scenario');
    expect(mapping.flow).toBe('Module');
    expect(mapping.steps).toBe('Steps');
    const cases = extractRawCases(sheet, mapping);
    expect(cases.length).toBe(2);
    expect(cases[0].externalId).toBe('T-1');
    expect(cases[0].steps.map(s => s.text)).toEqual(['Open login page.', 'Enter user, then ] click Sign in.']);
  });

  it('throws a clear error when no case data exists', () => {
    expect(() => parseWorkbook(writeTmp('none.html', '<html><script>const A = [1,2];</script></html>'))).toThrow(/No test-case data/);
  });

  it('parses the repo sample flowchart html when present', () => {
    const p = path.resolve('test_case_flowchart_1 (1).html');
    if (!fs.existsSync(p)) return;
    const sheet = parseWorkbook(p)[0];
    expect(sheet.rows.length).toBeGreaterThan(5);
    const mapping = guessMapping(sheet.headers, sheet.rows);
    expect(mapping.steps).toBe('Steps');
    expect(extractRawCases(sheet, mapping).every(c => c.steps.length > 0)).toBe(true);
  });
});
```

## Step 6 — verify (run from `C:\Repos\Test-Cases`)
1. `npm run typecheck` → exit 0, no errors.
2. `npm test` → all pass, including the new ones. If a new test fails, fix the implementation/test expectation to match the described behaviour; do NOT delete tests. If the `mapping.title` assertion fails because guessMapping chose another column, report it instead of altering guessMapping.
3. Run: `npx tsx -e "import('./server/parse.ts').then(m=>{const s=m.parseWorkbook('test_case_flowchart_1 (1).html')[0];const mp=m.guessMapping(s.headers,s.rows);console.log(s.name,s.rows.length,JSON.stringify(mp));console.log(m.extractRawCases(s,mp).length)})"` → prints title, row count, mapping (mode per-row-case), and the same number of cases.
Report: files changed, test results, and output of command 3.
