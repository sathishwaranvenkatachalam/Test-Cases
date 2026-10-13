import type { ColumnMapping, CanonStep, Settings } from '../../shared/types';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body !== undefined && !(init.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error;
    throw new Error(msg || res.statusText);
  }
  return data as T;
}

export const jsonInit = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export type { Settings };

export interface FlowSummary {
  id: number;
  name: string;
  caseCount: number;
  stepCount: number;
  coverage: { total: number; covered: number; status: 'none' | 'partial' | 'complete' };
  lastRun: { id: number; status: string; finished_at: string | null } | null;
}

export interface FlowRow { id: number; name: string; created_at: string; }

export interface CaseStepView {
  position: number;
  stepId: number;
  text: string;
  mutability: 'safe' | 'mutating' | 'reset';
  expected: string | null;
}

export interface CaseDetail {
  id: number;
  externalId: string | null;
  title: string;
  lastStatus: string | null;
  recorded: boolean;
  steps: CaseStepView[];
}

export type PlanOpView =
  | { type: 'step'; nodeId: string; text: string; mutability: string; ancestors: string[] }
  | { type: 'replay'; fromBaseUrl: boolean; steps: { nodeId: string; text: string }[] };

export interface FlowDetailResponse {
  flow: FlowRow;
  cases: CaseDetail[];
  plan: { stats: { originalSteps: number; plannedSteps: number; savedPct: number }; ops: PlanOpView[] };
}

export interface ParsedSheetView {
  name: string;
  headers: string[];
  rowCount: number;
  sample: Record<string, string>[];
  mapping: ColumnMapping;
}

export interface ParseResponse { sessionId: number; filename: string; sheets: ParsedSheetView[]; }

export interface PreviewCaseView {
  idx: number;
  externalId: string | null;
  title: string;
  flowName: string;
  steps: CanonStep[];
  status: 'new' | 'changed' | 'unchanged';
  matchedCaseId: number | null;
  before: string[] | null;
  after: string[];
}

export interface IngestPayloadView {
  cases: PreviewCaseView[];
  summary: { new: number; changed: number; unchanged: number; reviewNeeded: number; newSteps: number; reusedSteps: number };
}

export interface CommitResult { createdCases: number; updatedCases: number; newSteps: number; reviews: number; affectedFlowIds: number[]; }

export interface StepRow { id: number; text: string; mutability: 'safe' | 'mutating' | 'reset'; usedBy: number; hasRecording: boolean; }

export interface ReviewRow {
  id: number;
  confidence: number;
  status: string;
  newStep: { id: number; text: string; usedBy: number };
  candidateStep: { id: number; text: string; usedBy: number };
}

export interface RunRecord {
  id: number;
  mode: 'claude' | 'playwright';
  scope: string;
  flow_ids: number[];
  base_url: string;
  status: string;
  error: string | null;
  stats: unknown;
  started_at: string;
  finished_at: string | null;
}

export interface RunListItem extends RunRecord {}

export interface RunDetailPayload {
  run: RunRecord;
  caseResults: { caseId: number; title: string | null; status: string; note: string | null }[];
  stepResults: { id: number; flowId: number; nodeId: string; text: string; status: string; observed: string | null; note: string | null }[];
  logs: string[];
}
