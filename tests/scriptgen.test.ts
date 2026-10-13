import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import { saveRecording, regenerateFlowScripts, regenerateStepsFile } from '../server/scriptgen.js';

const GEN = path.resolve('playwright', 'generated');

describe('scriptgen', () => {
  afterAll(() => {
    // Delete only the files this test generates (other test files may share the folder).
    for (const f of ['steps.ts', 'login.spec.ts']) fs.rmSync(path.join(GEN, f), { force: true });
  });

  it('generates steps and spec, skipping cases with missing recordings', () => {
    const flowId = Number(db.prepare("INSERT INTO flows (name) VALUES ('Login')").run().lastInsertRowid);
    const s1 = Number(db.prepare("INSERT INTO steps (key, canonical_text, mutability) VALUES ('open login page','Open login page','safe')").run().lastInsertRowid);
    const s2 = Number(db.prepare("INSERT INTO steps (key, canonical_text, mutability) VALUES ('click sign in','Click sign in','mutating')").run().lastInsertRowid);
    const s3 = Number(db.prepare("INSERT INTO steps (key, canonical_text, mutability) VALUES ('view extra','View extra','safe')").run().lastInsertRowid);

    const c1 = Number(db.prepare("INSERT INTO cases (flow_id, title, signature) VALUES (?, 'Valid login', '')").run(flowId).lastInsertRowid);
    db.prepare("INSERT INTO case_steps (case_id, position, step_id, params_json, expected) VALUES (?, 0, ?, '{}', NULL)").run(c1, s1);
    db.prepare("INSERT INTO case_steps (case_id, position, step_id, params_json, expected) VALUES (?, 1, ?, '{}', 'Dashboard shown')").run(c1, s2);

    const c2 = Number(db.prepare("INSERT INTO cases (flow_id, title, signature) VALUES (?, 'Missing recording', '')").run(flowId).lastInsertRowid);
    db.prepare("INSERT INTO case_steps (case_id, position, step_id, params_json, expected) VALUES (?, 0, ?, '{}', NULL)").run(c2, s1);
    db.prepare("INSERT INTO case_steps (case_id, position, step_id, params_json, expected) VALUES (?, 1, ?, '{}', NULL)").run(c2, s3);

    saveRecording(s1, 'action', 'await page.goto(new URL("/login", process.env.BASE_URL!).toString());');
    saveRecording(s2, 'action', 'await page.getByRole("button", { name: "Sign in" }).click();');
    saveRecording(s2, 'assert', 'await expect(page.getByText("Dashboard")).toBeVisible();', {}, 'Dashboard shown');
    saveRecording(s3, 'assert', 'await expect(page.locator("body")).toBeVisible();', {}, '');

    const result = regenerateFlowScripts(flowId);
    expect(result.coveredCases).toBe(1);
    expect(result.totalCases).toBe(2);
    expect(result.skipped.map(s => s.caseId)).toEqual([c2]);
    expect(result.skipped[0].missing).toContain(`step ${s3} action`);

    const spec = fs.readFileSync(result.specPath, 'utf8');
    expect(spec.split(`S.step_${s1}(page,`).length - 1).toBe(1);
    expect(spec.split(`S.step_${s2}(page,`).length - 1).toBe(1);
    expect(spec).toContain('await expect(page.getByText("Dashboard")).toBeVisible();');
    expect(spec).toContain(`// C${c2} skipped (missing recordings)`);

    const steps = fs.readFileSync(path.join(GEN, 'steps.ts'), 'utf8');
    expect(steps).toContain(`export async function step_${s1}(`);
    expect(steps).toContain(`export async function step_${s2}(`);
    expect(regenerateStepsFile()).toBe(path.join(GEN, 'steps.ts'));
  });
});
