import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../server/db.js';
import { parseWorkbook, guessMapping } from '../server/parse.js';
import { buildPreview, commitPreview } from '../server/ingest.js';

const GEN = path.resolve('playwright', 'generated');

function writeTmp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfm-ingest-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function createSession(filePath: string): number {
  return Number(db.prepare('INSERT INTO ingest_sessions (filename, file_path) VALUES (?, ?)')
    .run(path.basename(filePath), filePath).lastInsertRowid);
}

async function previewFile(filePath: string) {
  const sessionId = createSession(filePath);
  const sheet = parseWorkbook(filePath)[0];
  const mapping = guessMapping(sheet.headers, sheet.rows);
  const payload = await buildPreview(sessionId, sheet.name, mapping);
  return { sessionId, payload };
}

const CSV1 = [
  'ID,Title,Module,Steps,Expected',
  'TC-1,Valid login,Login,"Open login page\nLogin as admin\nOpen dashboard",Dashboard shown',
  'TC-2,Guest login,Login,"Open login page\nLogin as guest",',
  'TC-3,Logout,Login,"Open login page\nLogin as admin\nClick logout",Login page shown',
].join('\n');

const CSV2 = [
  'ID,Title,Module,Steps,Expected',
  'TC-1,Valid login,Login,"Open login page\nLogin as admin\nOpen dashboard",Dashboard shown',
  'TC-2,Guest login,Login,"Open login page\nLogin as guest\nClick sign in",',
  'TC-3,Logout,Login,"Open login page\nLogin as admin\nClick logout",Login page shown',
].join('\n');

describe('ingest', () => {
  afterAll(() => {
    for (const f of ['steps.ts', 'login.spec.ts']) fs.rmSync(path.join(GEN, f), { force: true });
  });

  it('previews new cases, commits shared steps once, then reports unchanged and changed', async () => {
    const file1 = writeTmp('set1.csv', CSV1);
    const first = await previewFile(file1);
    expect(first.payload.cases.length).toBe(3);
    expect(first.payload.cases.every(c => c.status === 'new')).toBe(true);
    expect(first.payload.summary.new).toBe(3);

    const committed = commitPreview(first.sessionId);
    expect(committed.createdCases).toBe(3);

    const sharedCount = (db.prepare("SELECT COUNT(*) AS n FROM steps WHERE key = 'open login page'").get() as { n: number }).n;
    expect(sharedCount).toBe(1);
    const caseSteps = (db.prepare('SELECT COUNT(*) AS n FROM case_steps').get() as { n: number }).n;
    expect(caseSteps).toBe(8);

    const again = await previewFile(file1);
    expect(again.payload.cases.length).toBe(3);
    expect(again.payload.cases.every(c => c.status === 'unchanged')).toBe(true);

    const file2 = writeTmp('set2.csv', CSV2);
    const changed = await previewFile(file2);
    expect(changed.payload.summary.changed).toBe(1);
    expect(changed.payload.summary.unchanged).toBe(2);
    const changedCase = changed.payload.cases.find(c => c.status === 'changed');
    expect(changedCase?.externalId).toBe('TC-2');
    expect(changedCase?.before?.length).toBe(2);
    expect(changedCase?.after.length).toBe(3);
  });
});
