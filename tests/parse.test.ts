import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWorkbook, guessMapping, extractRawCases, splitSteps } from '../server/parse.js';

function writeTmp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfm-parse-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

describe('parse', () => {
  it('per-row-case CSV maps and extracts cases', () => {
    const csv = [
      'ID,Title,Module,Steps,Expected',
      'TC-1,Valid login,Login,"1. Open login\n2. Enter user\n3. Click Sign in",Dashboard shown',
      'TC-2,Invalid login,Login,"1. Open login\n2. Enter wrong password",Error shown',
    ].join('\n');
    const sheets = parseWorkbook(writeTmp('cases.csv', csv));
    expect(sheets.length).toBe(1);
    const sheet = sheets[0];
    const mapping = guessMapping(sheet.headers, sheet.rows);
    expect(mapping.mode).toBe('per-row-case');
    const cases = extractRawCases(sheet, mapping);
    expect(cases.length).toBe(2);
    expect(cases[0].steps.length).toBe(3);
    expect(cases[0].steps[0].text).toBe('Open login');
    expect(cases[0].flowName).toBe('Login');
  });

  it('per-row-step CSV groups steps by case id', () => {
    const csv = [
      'Case ID,Title,Step No,Step,Expected',
      'TC1,Login,1,Open login,',
      ',,2,Click Sign in,Dashboard shown',
      'TC2,Logout,1,Click logout,Login page',
    ].join('\n');
    const sheets = parseWorkbook(writeTmp('steps.csv', csv));
    const sheet = sheets[0];
    const mapping = guessMapping(sheet.headers, sheet.rows);
    expect(mapping.mode).toBe('per-row-step');
    const cases = extractRawCases(sheet, mapping);
    expect(cases.length).toBe(2);
    expect(cases[0].steps.length).toBe(2);
    expect(cases[0].steps[1].expected).toBe('Dashboard shown');
  });

  it('splitSteps splits on semicolons', () => {
    expect(splitSteps('Open page; click login')).toEqual(['Open page', 'click login']);
  });
});

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

describe('parse html safety', () => {
  it('does not execute code embedded in the array', () => {
    const p = writeTmp('evil.html', `<script>const A = [{ id: [].constructor.constructor('globalThis.__pwned = 1')(), steps: ['x'] }];</script>`);
    expect(() => parseWorkbook(p)).toThrow(/No test-case data/);
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });
});
