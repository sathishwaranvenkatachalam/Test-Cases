# Test Flow Manager

A single-user, local web app that turns manual test-case spreadsheets into reusable UI test flows, runs them against your already-open Chrome, and generates Playwright specs.

## What it does

- Upload `.xlsx` / `.csv` / `.html` test-case files and map their columns (heuristic guess, or "Detect with Claude"). HTML files must embed the cases as a JS array of objects in a `<script>` (e.g. `const RAW = [{ id, module, scenario, steps: [...] }]`).
- Claude normalizes steps into atomic, reusable canonical steps with `{placeholders}`, and links them to existing steps. Low-confidence matches go to a merge-review queue.
- A planner merges each flow's cases into a shared-prefix trie so common steps (login, navigation) run once. Mutating branches are re-established with a replay.
- Runs execute in one of two modes:
  - **Claude mode**: drives your logged-in Chrome through Claude in Chrome. Records Playwright code per step and per expected result.
  - **Playwright mode**: runs the generated specs over CDP. Free and deterministic.
- Generated files: `playwright/generated/steps.ts` and one `playwright/generated/<flow-slug>.spec.ts` per flow.

## Prerequisites

- Node.js 20+
- Claude Code CLI installed and logged in (`claude` on the PATH)
- Chrome with the Claude in Chrome extension

## Chrome setup

Chrome 136+ refuses `--remote-debugging-port` on the default profile, so start a dedicated profile:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=C:\chrome-testprofile
```

In that window, install and enable the Claude in Chrome extension, then log into the target app once. Both Claude mode and Playwright mode use this same Chrome.

## Install and run

```
npm install
npm run dev
```

Open http://localhost:5173. The API runs on port 3001.

## Workflow

1. Set the **Target Base URL** in the header (saved in the database).
2. Upload a test-case file on the **Upload** page.
3. Map the columns (or use "Detect with Claude"), then analyze.
4. Review the preview and **Commit**.
5. Resolve merge suggestions on the **Reviews** page.
6. Run a flow with **Run (Claude)**. This also records the Playwright scripts.
7. Run with **Run (Playwright)** afterwards. Failed Playwright cases can be re-run with Claude.

Sample data: `samples/sample-cases.csv`.

## Dev and test commands

```
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run build        # vite build (web UI)
npm start            # API server only (set NODE_ENV=production to serve web/dist)
```

## Stub mode (no Claude calls)

Set `CLAUDE_STUB=1` to replace every Claude call with a deterministic fake. Use this to try the UI without API cost. Results are fake, so do not trust recordings made in stub mode.

```
set CLAUDE_STUB=1
npm run dev
```

## Known limitations

- No screenshots are captured.
- Replay re-runs ancestor steps, which may not be idempotent for every app.
- Claude's CLI flags may differ by version. Adjust "Claude run args" in the Advanced settings if a run fails to start.
- Runs that are interrupted by a server restart stay in `running` status and block new runs until the row is updated in the database.
