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
