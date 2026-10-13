# Test Flow Manager

Single-user local web app: ingests xlsx/csv test cases, dedupes steps via Claude, plans shared-prefix runs, executes via headless `claude -p --chrome` or Playwright (CDP), and generates Playwright specs. See README.md for user-facing docs.

## Stack
Node 24 + TypeScript (ESM, run with `tsx`), Express 4, better-sqlite3, React + Vite (`web/`), Vitest, Playwright.

## Commands
- `npm run dev` — API (3001) + Vite UI (5173)
- `npm run typecheck` · `npm test` · `npm run build`
- `CLAUDE_STUB=1` — replaces all Claude calls with deterministic fakes (`server/stub.ts`). Tests set it automatically and use `DB_PATH=:memory:`.

## Layout
- `shared/types.ts` — types shared by server and web (Plan, CanonStep, ColumnMapping, ...)
- `server/parse.ts` — workbook parsing, column mapping guess, raw case extraction
- `server/ingest.ts` — Claude canonicalization, preview (new/changed/unchanged), commit
- `server/planner.ts` — trie-based plan; mutating nodes with >1 child emit a `replay` op
- `server/runner.ts` — run orchestration, `@@RESULT {json}@@` parsing, SSE bus, case status derivation
- `server/scriptgen.ts` — recordings → `playwright/generated/steps.ts` + `<flow>.spec.ts`
- `server/claude.ts` — spawns the `claude` CLI (JSON mode and stream-json run mode)
- `server/routes/*` — HTTP API under `/api`
- `web/src/pages/*` — UI pages; `playwright/support.ts` — CDP fixture (hand-written)

## Conventions and gotchas
- Never edit `playwright/generated/*` by hand; it is regenerated from the `recordings` table.
- Step identity = `normalizeKey(canonical_text)`; variable data lives in `{placeholders}` + per-case params.
- Step mutability is `safe | mutating | reset`; planner behaviour depends on it.
- Import `xlsx` as a default import (namespace import breaks under native ESM).
- Tests share `playwright/generated`, so Vitest runs files serially (`fileParallelism: false`).
- Real `claude --chrome` flags are unverified; they are configurable in settings (`claudeRunArgs`).
- Never type credentials into the target app; the user's Chrome session is already logged in.
- Not a git repo yet.
