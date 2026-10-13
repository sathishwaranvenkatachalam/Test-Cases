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
