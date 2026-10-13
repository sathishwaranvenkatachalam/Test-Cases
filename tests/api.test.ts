import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from '../server/index.js';

const CSV = [
  'ID,Title,Module,Steps,Expected',
  'TC-1,Open product list,Shop,"Open login page\nLogin as admin\nOpen product list",Product list shown',
  'TC-2,Open cart,Shop,"Open login page\nLogin as admin\nOpen cart",Cart shown',
  'TC-3,Logout,Shop,"Open login page\nLogin as admin\nClick logout",Login page shown',
].join('\n');

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfm-api-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

describe('HTTP API', () => {
  afterAll(() => {
    fs.rmSync(path.resolve('data', 'uploads'), { recursive: true, force: true });
    for (const f of ['steps.ts', 'shop.spec.ts']) {
      fs.rmSync(path.resolve('playwright', 'generated', f), { force: true });
    }
  });

  it('GET /api/health', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('settings round trip', async () => {
    const put = await request(app).put('/api/settings').send({ baseUrl: 'http://example.test' });
    expect(put.status).toBe(200);
    const get = await request(app).get('/api/settings');
    expect(get.body.baseUrl).toBe('http://example.test');
    expect(get.body.cdpUrl).toBe('http://localhost:9222');
  });

  it('uploads, previews, commits and exposes the flow with plan savings', async () => {
    const file = tmpFile('shop.csv', CSV);
    const parsed = await request(app).post('/api/ingest/parse').attach('file', file);
    expect(parsed.status).toBe(200);
    const sheet = parsed.body.sheets[0];
    const sessionId = parsed.body.sessionId as number;

    const preview = await request(app)
      .post(`/api/ingest/${sessionId}/preview`)
      .send({ sheet: sheet.name, mapping: sheet.mapping });
    expect(preview.status).toBe(200);
    expect(preview.body.summary.new).toBe(3);

    const commit = await request(app).post(`/api/ingest/${sessionId}/commit`);
    expect(commit.status).toBe(200);
    expect(commit.body.createdCases).toBe(3);

    const flows = await request(app).get('/api/flows');
    expect(flows.status).toBe(200);
    const shop = flows.body.find((f: { name: string }) => f.name === 'Shop');
    expect(shop).toBeDefined();
    expect(shop.caseCount).toBe(3);

    const detail = await request(app).get(`/api/flows/${shop.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.plan.stats.savedPct).toBeGreaterThan(0);
    expect(detail.body.cases.length).toBe(3);
  });

  it('rejects unsupported file types with 400', async () => {
    const file = tmpFile('notes.txt', 'hello');
    const res = await request(app).post('/api/ingest/parse').attach('file', file);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported file type');
  });
});
