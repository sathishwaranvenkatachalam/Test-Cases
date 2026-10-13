# Plan: Test Flow Manager (web app)

Working directory: `C:\Repos\Test-Cases` (currently empty, NOT a git repo — do NOT run `git init`). Platform: Windows 11, Node v24, npm 11. Shell: use PowerShell or Bash tool; `claude` CLI is installed (`claude.ps1` in npm global).

Execute the phases IN ORDER. After each phase run that phase's verification and fix failures before moving on. Do not add features not listed here. Do not refactor beyond what is written. If something here is impossible, make the smallest deviation and list it in your final report.

---------------------------------------------------------------------
## 0. WHAT THE APP DOES (decisions already made by the user — do not revisit)

- Single-user, local-only web app. No login on the tool itself. Stack: Node + TypeScript, Express API, React (Vite) UI, SQLite (better-sqlite3).
- User uploads `.xlsx` / `.csv` test-case files. App extracts **flow, case, steps, expected results**. File layout varies, so the UI has a column-mapping step (heuristic guess + optional "Detect with Claude").
- Claude (headless `claude -p`) canonicalizes steps: splits prose into atomic steps, writes a canonical text with `{placeholders}`, extracts params, tags each step `safe | mutating | reset`, and matches against existing canonical steps in the DB. Low-confidence matches go to a **review queue**; high-confidence ones are linked automatically.
- A **planner** merges all cases of a flow into a shared-prefix **trie** so common steps (login, navigate) run once. Mutating steps with multiple branches get a **replay** (re-establish state) rather than being shared.
- A **run** executes a plan in one of two modes:
  - `claude`: app spawns `claude -p --chrome --output-format stream-json` which drives the user's already-open, already-logged-in Chrome (Claude in Chrome / DevTools). Claude prints one `@@RESULT {json}@@` line per step; app parses and stores them, shows live status via SSE, and records **Playwright code** per step and **assertion code** per expected result.
  - `playwright`: runs generated specs against the user's running Chrome via CDP (`chromium.connectOverCDP`). Free, deterministic.
- After Claude runs, the app generates Playwright files: shared step functions in `playwright/generated/steps.ts` and one spec per flow `playwright/generated/<flow-slug>.spec.ts` (one `test()` per case, each calling the shared step functions in order).
- Cost control: UI offers scope `all | unverified | failed`. "Unverified" = cases lacking recordings. A failed Playwright run can be escalated to Claude with scope `failed`.
- Global **Base URL** input box in the app header (saved in DB settings). The target app is already open and logged in in Chrome; the tool never types credentials.
- Re-ingest: cases matched by external ID (else by lowercase title). Preview shows new / changed / unchanged with diff; commit applies only new+changed.

OUT OF SCOPE (do NOT build): user accounts, screenshots capture, Docker, CI config, i18n, dark mode, drag-and-drop trees, editing step text in UI, Postgres, deployment.

---------------------------------------------------------------------
## 1. PROJECT SCAFFOLD

### 1.1 Files to create at repo root

`package.json`:
```json
{
  "name": "test-flow-manager",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -k -n api,web \"tsx watch server/index.ts\" \"vite --config web/vite.config.ts\"",
    "build": "vite build --config web/vite.config.ts",
    "start": "tsx server/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "pw": "playwright test"
  }
}
```
Then install (run exactly):
```
npm install express@4 better-sqlite3 multer xlsx csv-parse zod
npm install -D typescript tsx vite @vitejs/plugin-react react react-dom react-router-dom @types/react @types/react-dom @types/express @types/better-sqlite3 @types/multer @types/node concurrently vitest @playwright/test supertest @types/supertest
```
(react, react-dom, react-router-dom are installed as devDependencies on purpose — Vite bundles them.) If `better-sqlite3` fails to install a prebuilt binary, report the error; do not switch libraries silently.

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["server", "shared", "web/src", "playwright", "tests"]
}
```

`.gitignore`: `node_modules`, `data`, `dist`, `web/dist`, `test-results`, `playwright-report`.

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], environment: 'node', env: { DB_PATH: ':memory:', CLAUDE_STUB: '1' } } });
```

`playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './playwright/generated',
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  retries: 0,
});
```

`web/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3001' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
```

`web/index.html`: standard Vite HTML with `<div id="root"></div>` and `<script type="module" src="/src/main.tsx"></script>`, title "Test Flow Manager".

Create directories: `server/`, `shared/`, `web/src/pages/`, `web/src/components/`, `playwright/generated/`, `tests/`, `samples/`, `data/` (runtime; created by code with `fs.mkdirSync(..., {recursive:true})`).

### 1.2 Verification for phase 1
`npx tsc --noEmit` may fail only because sources do not exist yet — that is OK. `node -e "require('better-sqlite3')"` must not throw (use `node -e "import('better-sqlite3').then(()=>console.log('ok'))"`).

---------------------------------------------------------------------
## 2. SHARED TYPES — `shared/types.ts`

Write exactly these exports:

```ts
export type Mutability = 'safe' | 'mutating' | 'reset';

export interface Settings { baseUrl: string; cdpUrl: string; claudeModel: string; claudeRunArgs: string; }
// defaults: baseUrl '', cdpUrl 'http://localhost:9222', claudeModel 'sonnet',
// claudeRunArgs '-p --chrome --output-format stream-json --verbose --allowedTools mcp__claude-in-chrome'

export interface RawStep { text: string; expected?: string | null; }
export interface RawCase {
  externalId: string | null;
  title: string;
  flowName: string | null;
  steps: RawStep[];            // heuristically split; Claude may re-split
  finalExpected: string | null; // overall expected result if provided
}

export interface ColumnMapping {
  mode: 'per-row-case' | 'per-row-step';
  caseId: string | null;     // header name or null
  title: string | null;
  flow: string | null;
  steps: string | null;      // per-row-case: cell holding all steps; per-row-step: the single step text
  expected: string | null;   // per-row-case: final expected; per-row-step: step expected
  stepNo: string | null;     // only used for ordering in per-row-step
}

export interface CanonStep {
  existingStepId: number | null;
  canonicalText: string;       // contains {placeholders}
  params: Record<string, string>;
  mutability: Mutability;
  expected: string | null;
  confidence: number;          // 0..1
}
export interface CanonCase { index: number; flow: string | null; steps: CanonStep[]; }

export interface PlanNodeRef { nodeId: string; stepId: number; text: string; params: Record<string,string>; }
export interface StepOp {
  type: 'step';
  nodeId: string; stepId: number; text: string; params: Record<string,string>;
  mutability: Mutability;
  ancestors: string[];          // nodeIds from root to parent
  caseIds: number[];            // every case that passes through this node
  checks: { caseId: number; expected: string }[];
  endsCases: number[];
}
export interface ReplayOp { type: 'replay'; fromBaseUrl: boolean; steps: PlanNodeRef[]; }
export type PlanOp = StepOp | ReplayOp;
export interface Plan {
  ops: PlanOp[];
  casePaths: Record<number, string[]>;   // caseId -> nodeIds in order
  emptyCases: number[];
  stats: { originalSteps: number; plannedSteps: number; savedPct: number }; // savedPct integer 0..100, floor((orig-planned)/orig*100), 0 if orig==0
}
```

---------------------------------------------------------------------
## 3. DATABASE — `server/db.ts`

- `import Database from 'better-sqlite3'`. Path = `process.env.DB_PATH || 'data/app.db'`. If not `:memory:`, `fs.mkdirSync('data',{recursive:true})` first.
- `export const db = new Database(path); db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');`
- Run this schema with `db.exec` on import (idempotent `IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,            -- normalizeKey(canonical_text)
  canonical_text TEXT NOT NULL,
  mutability TEXT NOT NULL DEFAULT 'mutating' CHECK (mutability IN ('safe','mutating','reset')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  external_id TEXT, title TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS case_steps (
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  step_id INTEGER NOT NULL REFERENCES steps(id),
  params_json TEXT NOT NULL DEFAULT '{}',
  expected TEXT,
  PRIMARY KEY (case_id, position));
CREATE TABLE IF NOT EXISTS merge_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  new_step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  candidate_step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('action','assert')),
  params_hash TEXT NOT NULL DEFAULT '',   -- '' for kind=action
  expected_hash TEXT NOT NULL DEFAULT '', -- '' for kind=action
  code TEXT NOT NULL,
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (step_id, kind, params_hash, expected_hash));
CREATE TABLE IF NOT EXISTS ingest_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, file_path TEXT NOT NULL,
  payload_json TEXT, status TEXT NOT NULL DEFAULT 'parsed' CHECK (status IN ('parsed','previewed','committed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL CHECK (mode IN ('claude','playwright')),
  scope TEXT NOT NULL CHECK (scope IN ('all','unverified','failed')),
  flow_ids TEXT NOT NULL, base_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','passed','failed','cancelled','error')),
  error TEXT, stats_json TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT);
CREATE TABLE IF NOT EXISTS run_case_results (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass','fail','skipped','error')),
  note TEXT,
  PRIMARY KEY (run_id, case_id));
CREATE TABLE IF NOT EXISTS run_step_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  flow_id INTEGER NOT NULL, node_id TEXT NOT NULL, step_text TEXT NOT NULL,
  status TEXT NOT NULL, observed TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  line TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
```

### 3.1 `server/util.ts` — exact helpers
```ts
import crypto from 'node:crypto';
export function normalizeKey(text: string): string { return text.toLowerCase().replace(/\s+/g, ' ').trim(); }
export function stableStringify(v: unknown): string {
  // JSON.stringify with object keys sorted recursively; arrays keep order
}
export function sha1(s: string): string { return crypto.createHash('sha1').update(s).digest('hex'); }
export function slugify(s: string): string { // lowercase, non [a-z0-9] -> '-', collapse, trim '-', fallback 'flow'
}
export function renderStep(text: string, params: Record<string,string>): string {
  // replace each {name} in text with params[name] when present. For every param key NOT present as {key} in text,
  // append ` [key=value]` to the end. Return the string.
}
export function caseSignature(title: string, steps: { key: string; params: Record<string,string>; expected: string | null }[]): string {
  return sha1(stableStringify({ title: normalizeKey(title), steps: steps.map(s => ({ k: s.key, p: s.params, e: s.expected ? normalizeKey(s.expected) : null })) }));
}
export function getSettings(): Settings  // reads settings table, fills defaults from shared/types doc above
export function setSettings(patch: Partial<Settings>): Settings
```
`getSettings`/`setSettings` live in `server/settings.ts` (needs db), the rest in `util.ts`.

### 3.2 Verification
`npx tsc --noEmit` passes for these files.

---------------------------------------------------------------------
## 4. FILE PARSING — `server/parse.ts`

Exports:

```ts
export interface ParsedSheet { name: string; headers: string[]; rows: Record<string,string>[]; }
export function parseWorkbook(filePath: string): ParsedSheet[];
export function guessMapping(headers: string[], rows: Record<string,string>[]): ColumnMapping;
export function extractRawCases(sheet: ParsedSheet, mapping: ColumnMapping): RawCase[];
export function splitSteps(cell: string): string[];
```

### parseWorkbook
- Use `xlsx` package: `XLSX.readFile(filePath, { cellDates: false })`. Works for `.xlsx`, `.xls` and `.csv` (SheetJS reads CSV too). For each sheet: `XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false })` → array of arrays.
- First row with at least 2 non-empty cells is the header row (scan the first 10 rows; if none, use row 0). Headers = trimmed strings; empty header → `Column N` (1-based index). Duplicate headers → append ` (2)`, ` (3)`.
- Rows = remaining rows as objects keyed by header; all values `String(v).trim()`. Drop rows where all values are empty.
- Skip sheets with zero rows. Return `ParsedSheet[]`.
- If the file does not exist or SheetJS throws, let the error propagate (route turns it into 400).

### guessMapping (case-insensitive header matching, first match wins, each header used at most once)
- caseId: header matches /^(test\s*)?(case\s*)?(id|no\.?|number|#)$|^tc[\s_-]?id$|case\s*id/i
- title: /title|name|summary|scenario|description|test case$/i (not already used)
- flow: /flow|module|feature|area|suite|component|epic/i
- steps: /^steps?$|step\s*(description|details|action)|actions?|procedure|test steps/i
- expected: /expected|result|outcome|verify|assertion/i
- stepNo: /^step\s*(no\.?|#|number)$|^seq/i
- mode = 'per-row-step' if there is a `stepNo` match OR the caseId column has duplicate non-empty values in more than 20% of non-empty rows; else 'per-row-case'.
- Unmatched fields = null.

### splitSteps(cell)
1. Normalize `\r\n` → `\n`.
2. Split on newlines; trim each; drop empty.
3. Strip leading numbering/bullets from each line via regex `^\s*(?:\d+[\.\)\:]|[-*•]|step\s*\d+[\.\:\)]?)\s*` (case-insensitive).
4. If after this there is exactly 1 line and it contains `;` or the pattern ` -> ` or `→`, split on those separators.
5. Return non-empty trimmed lines. (If still 1 line, return it as-is; Claude will do deeper splitting later.)

### extractRawCases
**per-row-case**: each row → one RawCase. `externalId` = row[caseId] || null; `title` = row[title] || first 80 chars of first step || `Untitled case N`; `flowName` = row[flow] || null (if the flow column is null/empty AND the sheet name is not like /^sheet\d*$/i, use the sheet name as flowName); `steps` = `splitSteps(row[steps])` mapped to `{text}`; `finalExpected` = row[expected] || null. Skip rows with no steps AND no title.
**per-row-step**: iterate rows in order; current case id = row[caseId] if non-empty else the previous row's case id (fill-down for merged cells; if there is no caseId column, group by title; if neither, one case per sheet). A new RawCase begins when the case id value changes. Each row adds a step `{ text: row[steps], expected: row[expected] || null }` (skip if text empty). Title = first non-empty title cell in the group, else the case id, else `Untitled case N`. flowName as above (first non-empty in group). `finalExpected` = null. If `stepNo` column exists, sort each case's steps by Number(stepNo) ascending (stable, NaN last).

### Tests `tests/parse.test.ts` (vitest)
Write CSV fixtures to a temp dir (`os.tmpdir()`) inside the test:
1. per-row-case CSV: headers `ID,Title,Module,Steps,Expected`, 2 rows, Steps cell with `1. Open login\n2. Enter user\n3. Click Sign in`. Assert guessMapping.mode==='per-row-case', extractRawCases gives 2 cases, first has 3 steps with numbering stripped, flowName from Module.
2. per-row-step CSV: headers `Case ID,Title,Step No,Step,Expected`, rows: (TC1,Login,1,Open login,), (,,2,Click Sign in,Dashboard shown), (TC2,Logout,1,Click logout,Login page). Assert mode 'per-row-step', 2 cases, case 1 has 2 steps, second step expected 'Dashboard shown'.
3. `splitSteps('Open page; click login')` → `['Open page','click login']`.

---------------------------------------------------------------------
## 5. CLAUDE WRAPPER — `server/claude.ts` and `server/stub.ts`

### 5.1 `claudeJson`
```ts
export async function claudeJson<T>(kind: 'canonicalize' | 'detect-mapping', prompt: string, stubInput?: unknown): Promise<T>
```
- If `process.env.CLAUDE_STUB === '1'` → `return stubJson(kind, stubInput) as T` (see 5.3). Do NOT spawn anything.
- Otherwise spawn: `spawn('claude', ['-p', '--output-format', 'json', '--model', settings.claudeModel], { shell: true, windowsHide: true })`. Write `prompt` to child stdin then `end()`. Collect stdout/stderr. Timeout 300000 ms → kill with `taskkill /pid <pid> /T /F` on win32 (`spawn('taskkill', ['/pid', String(pid), '/T', '/F'])`) and reject `Error('claude timed out')`.
- Non-zero exit → reject `Error('claude exited N: <stderr first 500 chars>')`.
- stdout is JSON with a `result` string field. `const outer = JSON.parse(stdout); const text = typeof outer.result === 'string' ? outer.result : stdout;` Then extract JSON: strip ```` ```json ```` fences; take substring from first `{` to last `}`; `JSON.parse`. If any step fails reject `Error('claude returned invalid JSON: <first 300 chars>')`.
- Export `extractJson(text: string): unknown` separately and unit test it with fenced and unfenced input.

### 5.2 `spawnClaudeRun`
```ts
export function spawnClaudeRun(prompt: string, onLine: (line: string) => void): { done: Promise<number>; kill: () => void }
```
- Args = `settings.claudeRunArgs.split(/\s+/)` plus `['--model', settings.claudeModel]`. `spawn('claude', args, { shell: true, windowsHide: true })`; write prompt to stdin and end.
- Buffer stdout by lines (split on `\n`, keep trailing partial). Each complete line is passed to `onLine` verbatim (the runner interprets stream-json). stderr lines are passed prefixed with `[stderr] `.
- `done` resolves with exit code. `kill()` uses taskkill as above (non-win32: `child.kill('SIGTERM')`).
- If `CLAUDE_STUB === '1'`: do not spawn; instead `done` resolves 0 after calling `onLine` for each line produced by `stubRunLines(prompt)` (5.3), synchronously in order.

### 5.3 `server/stub.ts` (deterministic, used by tests and for trying the UI with no API cost)
`stubJson(kind, input)`:
- `kind==='detect-mapping'`: return `guessMapping`-equivalent: input is `{headers, rows}`; return `guessMapping(input.headers, input.rows)`.
- `kind==='canonicalize'`: input is `{ cases: RawCase[], existing: {id:number,text:string,key:string}[] }`. For each case index i return `{ index:i, flow: case.flowName ?? 'General', steps }` where each raw step `s` becomes: `canonicalText = s.text.trim()`, `params = {}`, `mutability` = `'safe'` if `/^(open|go to|navigate|visit|login|log in|sign in|view|check|verify)/i` matches else `'mutating'`, `expected = s.expected ?? null`, `existingStepId` = id of an existing step whose `key === normalizeKey(s.text)` else null, `confidence = 1`. If the case has `finalExpected` and the last step has no expected, set last step expected = finalExpected. Return `{ cases: [...] }`.

`stubRunLines(prompt)`: parse the plan JSON from the prompt — the prompt contains the plan between lines `<<<PLAN` and `PLAN>>>`. For each `step` op, produce a line **as a stream-json assistant event** so the runner parsing path is exercised:
`JSON.stringify({type:'assistant', message:{content:[{type:'text', text:'@@RESULT ' + JSON.stringify({nodeId, status:'pass', actionCode:'await page.getByText(' + JSON.stringify(op.text) + ').click();', checks: op.checks.map(c => ({caseId:c.caseId, status:'pass', observed:'stub', assertCode:'await expect(page.locator("body")).toBeVisible();'})), note:''}) + '@@'}]}})`
Finally the line for `@@DONE@@` wrapped the same way.

---------------------------------------------------------------------
## 6. INGEST — `server/ingest.ts`

```ts
export interface PreviewCase {
  idx: number; externalId: string | null; title: string; flowName: string;
  steps: CanonStep[];
  status: 'new' | 'changed' | 'unchanged';
  matchedCaseId: number | null;
  before: string[] | null;   // rendered old steps (changed only)
  after: string[];           // rendered new steps
}
export interface IngestPayload { cases: PreviewCase[]; summary: { new: number; changed: number; unchanged: number; reviewNeeded: number; newSteps: number; reusedSteps: number }; }

export async function buildPreview(sessionId: number, sheet: string, mapping: ColumnMapping): Promise<IngestPayload>;
export function commitPreview(sessionId: number): { createdCases: number; updatedCases: number; newSteps: number; reviews: number; affectedFlowIds: number[] };
```

### buildPreview
1. Load session row, `parseWorkbook(file_path)`, find sheet by name (400-style `Error('sheet not found')` if missing), `extractRawCases(sheet, mapping)`. If 0 cases → `Error('no test cases found with this mapping')`.
2. Load existing steps: `SELECT id, canonical_text AS text, key FROM steps`. To limit prompt size, if > 300 steps, for each batch of cases pre-filter to the 60 existing steps with highest word overlap (lowercase word set intersection count) with the batch's step text; union them.
3. Batch raw cases in groups of **15**. For each batch call `claudeJson<{cases: CanonCase[]}>('canonicalize', prompt, { cases: batch, existing })`. Run batches **sequentially**. Map returned `index` back to global index (`batchStart + index`). If a returned case is missing, throw `Error('claude omitted case <index>')`.
4. Validate each CanonCase with zod (`steps` min length 1, `mutability` enum, `confidence` number 0..1 default 1, `params` record of strings — coerce values with `String`, `expected` nullable optional→null, `existingStepId` nullable optional→null). If an `existingStepId` doesn't exist in the DB set it to null.
5. Canonicalization prompt text (use verbatim, substituting JSON):

```
You normalize manual QA test cases into atomic, reusable UI test steps. Respond with ONLY a JSON object, no prose, no markdown fences, and do not use any tools.

Rules:
1. Split each case into atomic steps (one user action each). Keep the original order. You may split or merge the raw steps provided.
2. Write each step as a short imperative canonicalText. Replace variable data (usernames, passwords, emails, quantities, names, search text, amounts) with {placeholders} (snake_case) and put the actual values in "params". Never put real secrets in canonicalText.
3. Two steps that mean the same action must have IDENTICAL canonicalText and the same placeholder names. Prefer reusing an existing step from the list EXISTING_STEPS: set existingStepId to its id, and key "params" by THAT step's placeholders. Only set existingStepId when the meaning is the same; set "confidence" (0..1) = how sure you are that it is the same step. If nothing fits, existingStepId = null and confidence = 1.
4. mutability: "safe" = read-only or idempotent setup (open page, navigate, login with an already-logged-in session, view, search); "mutating" = changes app data/state (create, edit, delete, submit, add to cart); "reset" = returns the app to a known baseline (navigate home/dashboard, logout, clear cart, close dialog).
5. expected: the expected result that should be observable right AFTER that step, or null. If the case only has an overall expected result, attach it to the last step.
6. flow: the functional flow/feature name for the case. If the case has flowName use it unchanged; otherwise infer a short Title Case name, preferring names from EXISTING_FLOWS.

Output schema: {"cases":[{"index":<number>,"flow":<string>,"steps":[{"existingStepId":<number|null>,"canonicalText":<string>,"params":{<name>:<string>},"mutability":"safe|mutating|reset","expected":<string|null>,"confidence":<number>}]}]}

EXISTING_FLOWS: <json array of flow names>
EXISTING_STEPS: <json array of {id,text}>
CASES: <json array of {index,externalId,title,flowName,steps,finalExpected}>
```
6. For each case compute `flowName = canon.flow?.trim() || raw.flowName || 'General'`; if raw.flowName is non-empty it overrides canon.flow.
7. Determine status:
   - Find existing case: if `externalId` non-null → `SELECT id, flow_id, title, signature FROM cases WHERE external_id = ?` (first). Else `WHERE lower(title) = lower(?)`.
   - Not found → `new`, matchedCaseId null.
   - Found: compute the new signature using `caseSignature(title, steps.map(s => ({key: normalizeKey(s.canonicalText), params: s.params, expected: s.expected})))`. Equal to stored `signature` → `unchanged`; else `changed`, `before` = rendered old steps via `renderStep` from DB (join case_steps+steps).
   - `after` = `steps.map(s => renderStep(s.canonicalText, s.params))` for all.
8. Summary: `reviewNeeded` = count of steps (all cases) with `existingStepId != null && confidence >= 0.5 && confidence < 0.85`. `reusedSteps` = steps with existingStepId and confidence >= 0.85 or whose normalizeKey equals an existing step key. `newSteps` = number of distinct keys not existing (excluding reused).
9. Save payload JSON into `ingest_sessions.payload_json`, status `'previewed'`. Return payload.

### commitPreview
Single `db.transaction`. Session must have status `'previewed'` else `Error('session not previewed')`. For each case with status `new` or `changed` (skip `unchanged`):
1. Resolve flow: `SELECT id FROM flows WHERE name = ? COLLATE NOCASE`, else INSERT. Track `affectedFlowIds` (also the old flow if the case moved).
2. Resolve each step:
   - `key = normalizeKey(canonicalText)`.
   - If `existingStepId != null && confidence >= 0.85` → use it.
   - Else look up `steps` by key → use it if found.
   - Else INSERT step (key, canonical_text, mutability); `newSteps++`. If `existingStepId != null && confidence >= 0.5` (medium confidence) and no `merge_reviews` row exists with (new_step_id, candidate_step_id, status 'pending') → INSERT merge_review(new_step_id, candidate_step_id=existingStepId, confidence); `reviews++`. If confidence < 0.5 ignore the candidate.
   - If a found/linked step has different mutability than Claude's, keep the DB value (do not overwrite).
3. If case `new`: INSERT into cases(flow_id, external_id, title, signature). If `changed`: UPDATE cases SET flow_id, title, signature, updated_at=datetime('now'); `DELETE FROM case_steps WHERE case_id=?`.
4. INSERT case_steps rows with position starting at 0, params_json = `JSON.stringify(params)`, expected.
5. Signature stored = `caseSignature(...)` computed from the resolved step keys (the key of the resolved step row, not Claude's text).
After the loop set session status `'committed'`. Return counts. Finally (outside transaction, after commit) call `regenerateFlowScripts(flowId)` from `server/scriptgen.ts` for each affected flow (wrap each in try/catch and ignore errors).

### Tests `tests/ingest.test.ts`
Using the in-memory DB (`DB_PATH=:memory:` set by vitest config) and stub Claude. Write a CSV (per-row-case) with 3 cases that all start with step lines `Open login page` and `Login as admin`, then differ. Create an ingest_sessions row manually (file_path to the temp CSV), call `buildPreview`, assert 3 `new` cases; `commitPreview`; assert `steps` table has the shared steps only once (count of rows with key `open login page` = 1) and `case_steps` has the right total. Ingest the same file again: preview must report 3 `unchanged`. Modify one case's step in a second CSV with the same IDs: preview reports 1 `changed`.

---------------------------------------------------------------------
## 7. PLANNER — `server/planner.ts`

```ts
export interface PlannerCase { caseId: number; nodes: { stepId: number; text: string; params: Record<string,string>; mutability: Mutability; expected: string | null }[]; }
export function buildPlan(cases: PlannerCase[]): Plan;
export function loadPlannerCases(caseIds: number[]): PlannerCase[]; // reads DB, text = canonical_text (NOT rendered; rendering happens when building prompt), ordered by position
```

### buildPlan algorithm (implement exactly)
1. Cases with zero nodes → `emptyCases`, excluded from the trie.
2. For each remaining case compute `keys[i] = stepId + '|' + stableStringify(params)`. Sort cases by `keys.join('\u0001')` ascending (ties by caseId) so similar prefixes are adjacent.
3. Trie node: `{ nodeId, key, stepId, text, params, mutability, parent, children: TrieNode[], caseIds: number[], checks: {caseId,expected}[], endsCases: number[] }`. Create a root with no step. Insert each case: walk from root; for each node-in-case find the child with equal `key`, else create it with `nodeId = 'n' + (++counter)` (counter starts at 0 → first id `n1`). On the walk, push `caseId` to that trie node's `caseIds`; if `expected` is non-empty push `{caseId, expected}` to `checks`. At the last node push caseId to `endsCases`. Record `casePaths[caseId]` = the list of nodeIds.
4. Flatten with recursive DFS `emit(node, pathFromRoot: TrieNode[])` where `pathFromRoot` excludes root and **includes `node`** when node is not root:
   - For non-root node push a `StepOp` with `ancestors` = nodeIds of `pathFromRoot` excluding the node itself.
   - For each child with index `i`:
     - If node is non-root AND `node.mutability === 'mutating'` AND `i >= 1`: first push a `ReplayOp`: find the index `r` of the LAST node in `pathFromRoot` whose mutability is `'reset'`. If found: `steps = pathFromRoot.slice(r)`, `fromBaseUrl=false`. Else `steps = pathFromRoot`, `fromBaseUrl=true`. `steps` map to `PlanNodeRef {nodeId, stepId, text, params}`.
     - then `emit(child, [...pathFromRoot, child])`.
   - Start with each child of root: `emit(child, [child])` (no replay at the root level).
5. Stats: `originalSteps` = sum of node counts over non-empty cases; `plannedSteps` = number of StepOps + total `steps.length` over ReplayOps; `savedPct = originalSteps === 0 ? 0 : Math.max(0, Math.floor((originalSteps - plannedSteps) / originalSteps * 100))`.

### Tests `tests/planner.test.ts` (construct PlannerCase objects directly)
1. Shared safe prefix: A=[login(safe), cart(safe), add(mutating)], B=[login, cart, remove(mutating)], C=[login, profile(safe)] with distinct stepIds (login=1, cart=2, add=3, remove=4, profile=5), empty params. Expect 5 step ops, 0 replay ops, `originalSteps=8`, `plannedSteps=5`, `savedPct=37`.
2. Mutating fork: A=[login(1,safe), add(2,mutating), checkout(3,mutating)], B=[login, add, view(4,safe)]. Expect ops: step n1(login), step n2(add), step n3(checkout) or n4 in sorted order, then one replay op with `fromBaseUrl=true` and steps `[login, add]`, then the last step op. `plannedSteps=6`, `originalSteps=6`, `savedPct=0`.
3. Reset checkpoint: A=[login(1,safe), home(2,reset), add(3,mutating), x(4,mutating)], B=[login, home, add, y(5,mutating)]. Replay op must have `fromBaseUrl=false` and steps `[home, add]`.
4. Failure semantics helper is in runner (section 9), not here.

---------------------------------------------------------------------
## 8. SCRIPT GENERATION — `server/scriptgen.ts`

```ts
export function regenerateFlowScripts(flowId: number): { specPath: string; coveredCases: number; totalCases: number; skipped: { caseId: number; missing: string[] }[] };
export function regenerateStepsFile(): string; // writes playwright/generated/steps.ts, returns path
export function flowCoverage(flowId: number): { total: number; covered: number; status: 'none' | 'partial' | 'complete' };
export function saveRecording(stepId: number, kind: 'action' | 'assert', code: string, params?: Record<string,string>, expected?: string): void;
export function caseIsFullyRecorded(caseId: number): { ok: boolean; missing: string[] };
```

- `paramsHash(params) = sha1(stableStringify(params))`; `expectedHash(e) = sha1(normalizeKey(e))`.
- `saveRecording` UPSERT: `INSERT ... ON CONFLICT(step_id,kind,params_hash,expected_hash) DO UPDATE SET code=excluded.code, verified_at=datetime('now')`. For `kind='action'` hashes are `''`. For `'assert'` they are `paramsHash(params ?? {})` and `expectedHash(expected ?? '')`. Reject (ignore silently) empty/whitespace `code`.
- `caseIsFullyRecorded`: for each case_step row: action recording for step_id must exist (missing label `step <id> action`); if `expected` non-empty: assert recording for (step_id, paramsHash, expectedHash) must exist (missing label `step <id> assert`).
- `flowCoverage`: counts over cases of the flow; `none` if covered=0 (including total=0), `complete` if covered===total && total>0, else `partial`.
- `regenerateStepsFile()`: write `playwright/generated/steps.ts` (create dir). Content:
```ts
// AUTO-GENERATED by Test Flow Manager. Do not edit.
import { expect, type Page } from '@playwright/test';
export type P = Record<string, string>;

// <rendered canonical text of step>
export async function step_<id>(page: Page, p: P): Promise<void> {
<code lines indented by 2 spaces>
}
// ... one per step that has an 'action' recording, ordered by id
```
  Replace any `*/` in comments; the comment line uses `step.canonical_text` with newlines replaced by spaces. Because `expect` and `p` may be unused add `void expect; void p;` as the first line inside each function.
- `regenerateFlowScripts(flowId)`:
  1. call `regenerateStepsFile()`.
  2. For each case in the flow (ordered by id): `caseIsFullyRecorded`. Covered cases get a `test()`; others are listed in `skipped` and emitted as a comment line `// C<id> skipped (missing recordings): <missing joined ", ">` inside the describe.
  3. Write `playwright/generated/<slugify(flow name)>.spec.ts`:
```ts
// AUTO-GENERATED by Test Flow Manager. Do not edit.
import { test, expect } from '../support';
import * as S from './steps';

test.describe(<JSON.stringify(flow name)>, () => {
  test(<JSON.stringify(`C${caseId} ${title}`)>, async ({ page }) => {
    await S.step_<id>(page, <JSON.stringify(params)>);
    // after a step with expected:
    // expected: <expected text with newlines->spaces>
    <assert code lines>
  });
});
```
  If the flow has zero covered cases, still write the file with a describe containing only the skipped comments and a `test.skip` is NOT needed (Playwright errors on a file with no tests, so when covered==0 DELETE the spec file if it exists instead of writing it).
  4. Return the result object.
- Also create the hand-written (not generated) `playwright/support.ts`:
```ts
import { test as base, chromium, type Page } from '@playwright/test';
export const test = base.extend<{ page: Page }>({
  page: async ({}, use) => {
    const browser = await chromium.connectOverCDP(process.env.CDP_URL || 'http://localhost:9222');
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    if (process.env.BASE_URL) await page.goto(process.env.BASE_URL);
    await use(page);
    await page.close();
    await browser.close();
  },
});
export { expect } from '@playwright/test';
```

### Tests `tests/scriptgen.test.ts`
Insert a flow, two steps, one case using both (with expected on step 2), call `saveRecording` for both actions and the assert, call `regenerateFlowScripts`; read the spec file and assert it contains `step_<id>(page,` twice and the assert code, and the steps file contains both function names. Then a second case missing a recording appears in `skipped`. Delete generated files in `afterAll` (use `fs.rmSync('playwright/generated', {recursive:true,force:true})` and re-create the dir; keep `.gitkeep`).

---------------------------------------------------------------------
## 9. RUNNER — `server/runner.ts`

```ts
export const bus: EventEmitter;                       // emits `run:<id>` events with RunEvent
export type RunEvent = { type: 'status'; status: string } | { type: 'step'; flowId: number; nodeId: string; text: string; status: string; observed?: string; note?: string }
                     | { type: 'case'; caseId: number; status: string; note?: string } | { type: 'log'; line: string } | { type: 'done' };
export function startRun(opts: { flowIds: number[]; mode: 'claude' | 'playwright'; scope: 'all' | 'unverified' | 'failed' }): number; // returns run id; throws Error('a run is already in progress') if any runs row has status='running'
export function cancelRun(runId: number): boolean;
export function selectCases(flowId: number, scope: string): number[];
export function buildClaudePrompt(baseUrl: string, plan: Plan, resolveText: (op: StepOp) => string): string;
export function parseResultLine(line: string): ParsedEvent | null;
export function deriveCaseStatuses(plan: Plan, nodeResults: Map<string, 'pass'|'fail'>, checkResults: Map<string, 'pass'|'fail'>): Map<number, {status: 'pass'|'fail'|'skipped'|'error'; note?: string}>;
```

### selectCases(flowId, scope)
- `all`: every case id in the flow.
- `unverified`: cases where `caseIsFullyRecorded(id).ok === false`.
- `failed`: cases whose most recent `run_case_results` row (highest run_id for that case_id) has status `'fail'`, `'error'` or `'skipped'`. If none, empty array.

### startRun
1. Throw if base URL is empty (`Error('set the Base URL first')`) — read from `getSettings().baseUrl`.
2. Insert `runs` row (status running, flow_ids JSON, base_url). Return id immediately; run work asynchronously (`void execute(runId)`), catching all errors into `runs.status='error'`, `error=message`.
3. `execute` for each flow in order:
   - `caseIds = selectCases(flowId, scope)`; if empty, log `no cases selected for flow <name>` and continue.
   - **claude mode**: `plan = buildPlan(loadPlannerCases(caseIds))`. Log plan stats. Build prompt (below). `spawnClaudeRun(prompt, onLine)` where `onLine` first pushes the raw line to `run_logs` (truncate to 2000 chars; cap 2000 log rows per run) and emits a `log` event, then calls `parseResultLine`. Track `nodeResults` (Map nodeId → 'pass'|'fail'), `checkResults` (Map `${nodeId}:${caseId}` → status). On each parsed RESULT: insert a `run_step_results` row (step_text = rendered text of the op), emit `step` event; if status pass and `actionCode` non-empty → `saveRecording(op.stepId,'action',actionCode)`; for each check with status pass and `assertCode` → `saveRecording(op.stepId,'assert',assertCode, op.params, check.expected)`. Look up the op by nodeId in a Map built from `plan.ops` (ignore unknown nodeIds).
   - After `done` resolves (or cancel): `deriveCaseStatuses(...)`, insert `run_case_results` (INSERT OR REPLACE) for every case, emit `case` events. Then `regenerateFlowScripts(flowId)` in try/catch (log failures).
   - **playwright mode**: `regenerateFlowScripts(flowId)`; if spec file doesn't exist log and mark all selected cases `error` with note `no generated script — run in Claude mode first`. Else spawn `npx playwright test playwright/generated/<slug>.spec.ts --reporter=json` with `shell:true`, env `BASE_URL`, `CDP_URL`, capture stdout fully, parse JSON, call `parsePlaywrightJson(json)` (export it) which returns `Map<caseId, {status:'pass'|'fail', note?:string}>` by reading `suites[].suites[].specs[]` recursively (flatten any nesting), spec `title` matching `/^C(\d+) /` → caseId, `ok` true → pass, else fail with note = first `tests[0].results[0].error.message` (strip ANSI codes, first 500 chars). Selected cases missing from the result (e.g., not covered by script) → `error` note `not in generated script`. Only keep results for cases in `caseIds`.
4. Final run status: if cancelled → `cancelled`; else if any case in the run is not `pass` → `failed`; else `passed`. Set `finished_at`, `stats_json` = JSON of `{ flows: [{flowId, stats}], totals: {pass, fail, skipped, error} }`. Emit `status` and `done`.

### cancelRun
Keeps a module-level `Map<runId, {kill: () => void}>`. If found: set a cancelled flag, kill child, return true; else false.

### buildClaudePrompt (exact text; substitute `<BASE_URL>` and `<PLAN_JSON>`; each op's `text` field in the JSON must be the RENDERED text, i.e. `renderStep(op.text, op.params)`; for replay ops also render each step text)
```
You are executing a UI test plan in the user's ALREADY OPEN, ALREADY LOGGED-IN Chrome using your Claude in Chrome browser tools.

Rules:
- Open a NEW tab and go to <BASE_URL>. Do NOT log in, sign up, or type any credentials. If you hit a login wall, report the current step as failed with note "login required".
- Execute "ops" in order. Do nothing that is not in the plan.
- op.type "step": perform op.text in the browser (op.params has the exact values to use). Then look at the page and judge each item in op.checks (expected result for a specific caseId).
- op.type "replay": the application state was changed by a previous branch. If fromBaseUrl is true, navigate to <BASE_URL> first. Then re-perform the listed steps quickly, in order. Do not print results for replay steps unless one fails (then print a RESULT with that step's nodeId and status "fail").
- If a step cannot be performed, or the page is not in the state the step needs, mark that step "fail" with a short note and CONTINUE. Skip every later op whose "ancestors" array contains a nodeId that failed, and do not print results for skipped ops.
- After each step op print exactly ONE line, on its own line, in this exact format (single line JSON, no line breaks inside):
@@RESULT {"nodeId":"<nodeId>","status":"pass|fail","actionCode":"<TypeScript>","checks":[{"caseId":<number>,"status":"pass|fail","observed":"<short text>","assertCode":"<TypeScript>"}],"note":"<short text>"}@@
- actionCode: Playwright TypeScript statements (no imports, no function wrapper) that repeat this step using the variables `page` (Playwright Page) and `p` (Record<string,string> of this step's params; reference values as p["name"]). Prefer getByRole / getByLabel / getByText / getByTestId over CSS. For navigation use `await page.goto(new URL("/path", process.env.BASE_URL!).toString());`. Include any waits needed (e.g. `await page.waitForLoadState()`). Only include actions you actually performed.
- assertCode: one or more `await expect(...)` statements (variables `page`, `p` and `expect` available) that verify that check's expected result against what you observed. Keep them robust (prefer visible text / URL patterns over exact pixels).
- All string values must be valid JSON strings (escape quotes and newlines as \n).
- When every op is finished print a final line: @@DONE@@
- Do not print any other line that contains "@@".

<<<PLAN
<PLAN_JSON>
PLAN>>>
```
`<PLAN_JSON>` = `JSON.stringify({ ops }, null, 0)` where each step op is reduced to `{type,nodeId,text,params,ancestors,checks}` (+ `fromBaseUrl`,`steps:[{nodeId,text}]` for replay).

### parseResultLine(line)
1. Try `JSON.parse(line)`. If it is an object with `type==='assistant'` and `message.content` array → concatenate every `{type:'text'}` item's `.text`. If parsing fails, treat the raw `line` as text.
2. Within that text, for every line (split `\n`) find ones matching `/^\s*@@RESULT (\{.*\})@@\s*$/` → JSON.parse group 1 inside try/catch (on failure skip). Return `{ kind: 'result', result }`; if a line is `@@DONE@@` return `{ kind: 'done' }`. Because one assistant message may contain several lines, return an ARRAY: `ParsedEvent[]` (change the return type to `ParsedEvent[]`; empty array when nothing matched).
3. Also tolerate messages split across stream chunks: no buffering is required beyond per-line.

### deriveCaseStatuses(plan, nodeResults, checkResults)
For each `caseId` in `plan.casePaths`:
- Walk the path nodes in order. If a node has result `'fail'` → status `'fail'`, note `step failed at <nodeId>`; stop.
- Else if a node has NO result in `nodeResults`: if any of its ancestors (use the matching StepOp in `plan.ops`) failed → status `'skipped'`, note `blocked by failed step`; else status `'error'`, note `no result reported for <nodeId>`; stop.
- Else if any check for this case (`${nodeId}:${caseId}` in checkResults) is `'fail'` → `'fail'`, note `expected result not met at <nodeId>`; stop.
- A check key with no result is treated as error: status `'error'`, note `check not reported at <nodeId>`.
- Otherwise `'pass'`.
Cases in `plan.emptyCases` → `error`, note `case has no steps`.

### Tests `tests/runner.test.ts`
1. `parseResultLine` with a raw `@@RESULT {...}@@` line, with a stream-json assistant wrapper containing two RESULT lines, with garbage (→ `[]`), and `@@DONE@@`.
2. `deriveCaseStatuses` using the "mutating fork" plan from planner test 2: fail node n2 → both cases `fail` (path walk hits n2 for both); fail node n3 only → case A fails, case B passes.
   (Skipped-case path: construct a plan where case B's path contains a node that has no result and an ancestor failed → `skipped`.)
3. Full stub run: ingest a CSV via the ingest functions (stub), call `startRun({flowIds, mode:'claude', scope:'all'})` with settings baseUrl `http://example.test`, poll `SELECT status FROM runs` until not `running` (max 5 s), expect `passed`, `run_case_results` all `pass`, recordings exist, and `playwright/generated/<slug>.spec.ts` exists. Clean up generated files after.
4. `parsePlaywrightJson` with a small hand-written JSON fixture (one passing, one failing spec).

---------------------------------------------------------------------
## 10. HTTP API — `server/index.ts` + `server/routes/*.ts`

`server/index.ts`: express app, `express.json({limit:'5mb'})`, mounts routers under `/api`, `GET /api/health` → `{ok:true}`. Export `app` (for supertest) and only call `app.listen(Number(process.env.PORT || 3001))` when `process.env.VITEST` is not set. Error middleware: respond `{error: err.message}` with status `err.status || 400` for known `Error`s thrown from routes (just use 400 default; 404 for not-found; 409 for conflicts). In production (`NODE_ENV=production`) also serve `web/dist` statically with SPA fallback.

Uploads: multer to `data/uploads/` (create dir), limit 10 MB, accept extensions `.xlsx .xls .csv` only (else 400 `unsupported file type`).

| Method & path | Body / query | Response |
|---|---|---|
| GET `/api/settings` | — | `Settings` |
| PUT `/api/settings` | partial Settings | `Settings` |
| GET `/api/flows` | — | `[{id,name,caseCount,stepCount,coverage:{total,covered,status},lastRun:{id,status,finished_at}|null}]` (stepCount = distinct step_ids in the flow's cases; lastRun = latest run whose flow_ids includes the flow) |
| POST `/api/flows` | `{name}` | flow row; 409 on duplicate name |
| PATCH `/api/flows/:id` | `{name}` | flow row |
| DELETE `/api/flows/:id` | — | `{ok:true}` (also delete its spec file if exists) |
| GET `/api/flows/:id` | — | `{flow, cases:[{id,externalId,title,lastStatus,recorded:boolean,steps:[{position,stepId,text(rendered),mutability,expected}]}], plan: {stats, ops}}` where plan = `buildPlan(loadPlannerCases(all case ids))` with each op `text` rendered; `lastStatus` from latest `run_case_results` or null |
| POST `/api/cases/:id/move` | `{flowId}` | `{ok:true}` |
| DELETE `/api/cases/:id` | — | `{ok:true}` |
| GET `/api/steps` | — | `[{id,text,mutability,usedBy:number,hasRecording:boolean}]` |
| PATCH `/api/steps/:id` | `{mutability}` | step row (validate enum) |
| POST `/api/ingest/parse` | multipart field `file` | `{sessionId, filename, sheets:[{name, headers, rowCount, sample: first 5 rows, mapping: guessMapping(...)}]}` |
| POST `/api/ingest/:id/detect-mapping` | `{sheet}` | `ColumnMapping` via `claudeJson('detect-mapping', ...)`; prompt: "Given spreadsheet headers and sample rows, return ONLY a JSON ColumnMapping object {mode:'per-row-case'|'per-row-step', caseId,title,flow,steps,expected,stepNo: header name or null}. Headers: <json>. Sample rows: <json first 5>." Validate that each non-null value is an actual header, otherwise set it to null |
| POST `/api/ingest/:id/preview` | `{sheet, mapping}` | `IngestPayload` |
| POST `/api/ingest/:id/commit` | — | commit result |
| GET `/api/reviews` | `?status=pending` (default pending) | `[{id,confidence,status,newStep:{id,text,usedBy},candidateStep:{id,text,usedBy}}]` |
| POST `/api/reviews/:id/approve` | — | `{ok:true}` — merge: `UPDATE case_steps SET step_id=candidate WHERE step_id=new`; delete the `new` step (cascades its recordings and other reviews pointing at it); set review `approved`; then `regenerateFlowScripts` for flows of affected cases (try/catch) |
| POST `/api/reviews/:id/reject` | — | `{ok:true}` sets `rejected` |
| POST `/api/runs` | `{flowIds, mode, scope}` | `{id}`; 409 if running |
| GET `/api/runs` | — | latest 50 runs |
| GET `/api/runs/:id` | — | `{run, caseResults:[{caseId,title,status,note}], stepResults:[...], logs:[last 200]}` |
| GET `/api/runs/:id/events` | — | SSE (`text/event-stream`); on connect first send `event: snapshot` with the same payload as GET `/api/runs/:id`, then forward bus events as `data: <json>\n\n`; send `: ping\n\n` every 15 s; remove listener on `req.on('close')` |
| POST `/api/runs/:id/cancel` | — | `{cancelled:boolean}` |
| POST `/api/flows/:id/generate-scripts` | — | `regenerateFlowScripts` result |
| GET `/api/flows/:id/script` | — | `{path, content}` or 404 |

### API test `tests/api.test.ts` (supertest, stub Claude, in-memory DB)
`GET /api/health`; settings round trip; upload a CSV via `.attach('file', path)` → parse → preview → commit → `GET /api/flows` shows the flow with correct `caseCount`; `GET /api/flows/:id` returns `plan.stats.savedPct > 0` for a CSV where 3 cases share a 2-step safe prefix; upload `.txt` → 400.

### Verification for phases 2–10
```
npx tsc --noEmit
npx vitest run
```
Both must pass with zero errors. Fix issues; do not delete or weaken tests to pass.

---------------------------------------------------------------------
## 11. WEB UI — `web/src`

No UI library. Plain CSS in `web/src/styles.css` (simple: system font, max-width 1100px container, tables with borders, buttons, badges: green pass, red fail, grey skipped, amber error/partial). Use `react-router-dom` v6/7 `BrowserRouter`.

`web/src/api.ts`: `export async function api<T>(path: string, init?: RequestInit): Promise<T>` — prefix `/api`, JSON in/out (don't set Content-Type for FormData), on non-2xx throw `Error(body.error || res.statusText)`.

`web/src/App.tsx`: header with nav links (Flows, Upload, Reviews (badge with pending count, fetched on mount), Steps, Runs) and the **BaseUrlBar** component on the right. Routes: `/` Flows, `/flows/:id` FlowDetail, `/upload` Upload, `/reviews` Reviews, `/steps` Steps, `/runs` Runs, `/runs/:id` RunDetail.

**components/BaseUrlBar.tsx**: label "Target Base URL", text input bound to `settings.baseUrl`, Save on blur or Enter via `PUT /api/settings`; small "saved ✓" text for 1.5 s. Below/next to it a collapsible "Advanced" showing CDP URL and Claude model inputs (same save logic).

**pages/Flows.tsx**: table of flows (name link, cases, distinct steps, coverage badge `complete 3/3`, last run status badge). Per-row buttons: "Run (Playwright)" and "Run (Claude)" — each POSTs `/api/runs` with `{flowIds:[id], mode, scope}` where scope comes from a page-level `<select>` (`all`, `unverified`, `failed`) default `unverified`; then navigate to `/runs/<id>`; show errors (e.g., "set the Base URL first") in a red banner. A "New flow" input+button. Checkbox per row + "Run selected" buttons for multi-flow runs.

**pages/FlowDetail.tsx**: header with flow name (rename inline via PATCH), coverage badge, buttons: "Regenerate scripts", "View script" (shows content in a `<pre>`), Run Playwright / Run Claude with the scope select. Section "Plan": text "N steps → M steps (X% saved)" and an indented tree view built from `plan.ops`: render step ops with indentation = `ancestors.length`, replay ops as an italic amber row "↻ replay from <base URL | reset>: step1 → step2". Section "Cases": table with ID, title, last status badge, recorded ✓/✗, expandable row (click toggles) listing steps `position+1. text [mutability badge] → expected`. Per-case delete button (confirm) and a "Move to flow" select.

**pages/Upload.tsx**: 3-step wizard (state machine `step: 'upload'|'map'|'preview'|'done'`):
1. File input (`accept=".xlsx,.xls,.csv"`) + Upload button → POST parse (FormData).
2. Sheet `<select>` (if >1) and mapping form: mode select; for each of caseId/title/flow/steps/expected/stepNo a select of headers + "(none)", prefilled from server guess. Button "Detect with Claude" → POST detect-mapping and fill the form. A sample-rows table (first 5 rows). Button "Analyze with Claude" → POST preview (show spinner text "Analyzing… this can take a minute").
3. Preview: summary chips (new / changed / unchanged / review needed / new steps / reused steps). Table of cases with status badge, flow, and rendered `after` steps; `changed` rows show before vs after side by side (two `<pre>` columns). Buttons "Commit" (POST commit) and "Back".
4. Done: show commit counts and links to `/flows` and `/reviews`.

**pages/Reviews.tsx**: list of pending reviews, each card shows "New step: <text> (used by N cases)" vs "Existing step: <text> (used by N)", confidence %, buttons "Merge into existing" (approve) and "Keep separate" (reject). Empty state "Nothing to review".

**pages/Steps.tsx**: table of the step library: text, mutability `<select>` (PATCH on change), usedBy, recorded ✓/✗. Simple text filter input.

**pages/Runs.tsx**: table of runs (id link, mode, scope, status badge, started, finished).

**pages/RunDetail.tsx**: loads `GET /api/runs/:id` and opens `EventSource('/api/runs/:id/events')` while status is `running`. Applies `snapshot` (replace state) then incremental events: `step` → append to the steps list, `case` → update case row, `log` → append to log pane (cap 500 lines), `status`/`done` → refetch via GET. Layout: status badge + Cancel button (POST cancel; shown only when running); case results table (title, status badge, note); live step list (status badge, text, observed/note); collapsible raw log `<pre>` (max-height 300px, scroll). When finished and mode is `playwright` and any case failed/error show a button "Re-run failed with Claude" → POST `/api/runs` `{flowIds, mode:'claude', scope:'failed'}`.

### Verification
`npx tsc --noEmit` and `npx vite build --config web/vite.config.ts` must succeed.

---------------------------------------------------------------------
## 12. SAMPLE DATA + DOCS

`samples/sample-cases.csv` (UTF-8, exactly these lines):
```
Case ID,Title,Module,Steps,Expected Result
TC-001,Valid login,Login,"1. Open the login page
2. Enter username admin and password secret
3. Click Sign in",Dashboard is displayed
TC-002,Invalid password,Login,"1. Open the login page
2. Enter username admin and password wrong
3. Click Sign in",Error message 'Invalid credentials' is shown
TC-003,Add item to cart,Cart,"1. Open the login page
2. Enter username admin and password secret
3. Click Sign in
4. Open the product list
5. Click Add to cart on the first product",Cart badge shows 1
TC-004,Remove item from cart,Cart,"1. Open the login page
2. Enter username admin and password secret
3. Click Sign in
4. Open the cart
5. Click Remove on the first item",Cart is empty
```

`README.md` (concise, sections): What it does; Prerequisites (Node 20+, Claude Code CLI logged in, Chrome with the Claude in Chrome extension); **Chrome setup** — Chrome 136+ refuses `--remote-debugging-port` on the default profile, so start a dedicated profile:
```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=C:\chrome-testprofile
```
then in that window install/enable the Claude in Chrome extension and log into the target app once. State clearly: Claude mode and Playwright mode both use this same Chrome. Then: Install & run (`npm install`, `npm run dev`, open http://localhost:5173), Workflow (1 set Base URL, 2 upload, 3 map columns, 4 preview/commit, 5 review merges, 6 Run with Claude (records scripts), 7 Run with Playwright afterwards), Dev/test commands, `CLAUDE_STUB=1` mode (no Claude calls, deterministic fake results — for trying the UI), Known limitations (list: no screenshots; replay re-runs ancestors which may not be idempotent; Claude flags may differ by CLI version — adjust the "Claude run args" in Advanced settings).

---------------------------------------------------------------------
## 13. FINAL VERIFICATION (all must pass; report actual output)

1. `npx tsc --noEmit` → no errors.
2. `npx vitest run` → all tests pass; report the count.
3. `npx vite build --config web/vite.config.ts` → succeeds.
4. Smoke test the live API with the stub (PowerShell; run the server in the background using `$env:CLAUDE_STUB='1'; $env:PORT='3055'; npx tsx server/index.ts` via run_in_background, wait until `GET http://localhost:3055/api/health` returns ok):
   - Upload `samples/sample-cases.csv` via `curl.exe -F "file=@samples/sample-cases.csv" http://localhost:3055/api/ingest/parse`, then POST preview with the returned mapping, then commit, then `GET /api/flows` and `GET /api/flows/1`. Expect 2 flows (Login, Cart), 4 cases, and `plan.stats` showing fewer planned steps than original for the Login and Cart flows.
   - Set base URL `PUT /api/settings {"baseUrl":"http://example.test"}`, `POST /api/runs {"flowIds":[1,2],"mode":"claude","scope":"all"}`, poll `GET /api/runs/1` until status not running → expect `passed`, then confirm `playwright/generated/login.spec.ts` and `playwright/generated/steps.ts` exist and look correct.
   - Stop the server process afterward. Delete `data/` and `playwright/generated/*.ts` created by the smoke test (keep `playwright/generated/.gitkeep`).
5. Do NOT run real Claude or Chrome; do not run `npx playwright test`.

## 14. REPORT BACK
List: files created, test count/results, any deviations from this plan, anything you could not verify (explicitly: real `claude --chrome` run flags, `connectOverCDP` run), and any errors encountered.
