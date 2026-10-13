import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, jsonInit, type CdpStatus, type FlowDetailResponse, type FlowRow, type FlowSummary, type UpdateStepPayload } from '../api';
import Badge from '../components/Badge';
import FlowChart from '../components/FlowChart';

type Mode = 'claude' | 'playwright';
type Scope = 'all' | 'unverified' | 'failed';

export default function FlowDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const flowId = Number(id);

  const [data, setData] = useState<FlowDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [message, setMessage] = useState<string | null>(null);
  const [script, setScript] = useState<{ path: string; content: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [openCaseId, setOpenCaseId] = useState<number | null>(null);
  const [cdpStatus, setCdpStatus] = useState<CdpStatus | null>(null);
  const [launchingChrome, setLaunchingChrome] = useState(false);

  const load = () => {
    api<FlowDetailResponse>(`/flows/${flowId}`)
      .then(d => { setData(d); setNameDraft(d.flow.name); setError(null); })
      .catch((e: Error) => setError(e.message));
  };

  const checkCdp = () => {
    api<CdpStatus>('/system/cdp-status').then(setCdpStatus).catch(() => {});
  };

  useEffect(() => {
    load();
    checkCdp();
    api<FlowSummary[]>('/flows').then(setFlows).catch(() => setFlows([]));
    setScript(null);
    setMessage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId]);

  if (error) return <div className="banner err-banner">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;

  const { flow, cases, plan } = data;
  const covered = cases.filter(c => c.recorded).length;
  const total = cases.length;
  const coverageStatus = covered === 0 ? 'none' : covered === total && total > 0 ? 'complete' : 'partial';

  const renameFlow = async () => {
    const name = nameDraft.trim();
    if (name === '' || name === flow.name) { setNameDraft(flow.name); return; }
    try {
      await api<FlowRow>(`/flows/${flow.id}`, jsonInit('PATCH', { name }));
      setError(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const regenerate = async () => {
    try {
      const r = await api<{ coveredCases: number; totalCases: number; skipped: unknown[] }>(
        `/flows/${flow.id}/generate-scripts`, { method: 'POST' });
      setMessage(`Scripts regenerated: ${r.coveredCases}/${r.totalCases} cases covered, ${r.skipped.length} skipped.`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const viewScript = async () => {
    try {
      setScript(await api<{ path: string; content: string }>(`/flows/${flow.id}/script`));
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const run = async (mode: Mode) => {
    try {
      const { id: runId } = await api<{ id: number }>('/runs', jsonInit('POST', { flowIds: [flow.id], mode, scope }));
      navigate(`/runs/${runId}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const runCase = async (caseId: number) => {
    try {
      const { id: runId } = await api<{ id: number }>(
        '/runs',
        jsonInit('POST', { flowIds: [flow.id], mode: 'claude', scope: 'all', caseIds: [caseId] }),
      );
      navigate(`/runs/${runId}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const launchChrome = async () => {
    setLaunchingChrome(true);
    try {
      await api('/system/launch-chrome', { method: 'POST' });
      setMessage('Chrome launching…');
      let attempts = 0;
      const poll = () => {
        attempts++;
        api<CdpStatus>('/system/cdp-status').then(s => {
          setCdpStatus(s);
          if (s.reachable) {
            setMessage('Chrome is ready — you can now run Playwright tests.');
          } else if (attempts < 15) {
            setTimeout(poll, 1000);
          } else {
            setMessage('Chrome opened but remote debugging is not reachable on ' + s.cdpUrl + '. If another Chrome is already running on that port, close it and try again.');
          }
        }).catch(() => { if (attempts < 15) setTimeout(poll, 1000); });
      };
      setTimeout(poll, 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLaunchingChrome(false);
    }
  };

  const deleteCase = async (caseId: number) => {
    if (!window.confirm('Delete this case?')) return;
    try {
      await api(`/cases/${caseId}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const moveCase = async (caseId: number, flowId: number) => {
    try {
      await api(`/cases/${caseId}/move`, jsonInit('POST', { flowId }));
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveStep = async (caseId: number, position: number, patch: UpdateStepPayload) => {
    await api(`/cases/${caseId}/steps/${position}`, jsonInit('PATCH', patch));
    load();
  };

  const toggleExpanded = (caseId: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(caseId)) next.delete(caseId); else next.add(caseId);
      return next;
    });
  };

  return (
    <section>
      <p><Link to="/">← Flows</Link></p>
      <div className="row between">
        <div className="row">
          <input
            type="text"
            className="title-input"
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onBlur={renameFlow}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
          <Badge status={coverageStatus} />{' '}
          <span className="muted">{coverageStatus} {covered}/{total}</span>
        </div>
        <div className="row">
          <label className="inline">
            Scope
            <select value={scope} onChange={e => setScope(e.target.value as Scope)}>
              <option value="all">all</option>
              <option value="unverified">unverified</option>
              <option value="failed">failed</option>
            </select>
          </label>
          <button type="button" onClick={() => run('playwright')}>Run (Playwright)</button>
          {cdpStatus && !cdpStatus.reachable ? (
            <button type="button" className="warn" onClick={launchChrome} disabled={launchingChrome}>
              {launchingChrome ? 'Launching…' : 'Launch Chrome'}
            </button>
          ) : null}
          <button type="button" onClick={() => run('claude')}>Run (Claude)</button>
          <button type="button" onClick={regenerate}>Regenerate scripts</button>
          <button type="button" onClick={viewScript}>View script</button>
        </div>
      </div>

      {message ? <div className="banner">{message}</div> : null}
      {script ? (
        <div>
          <p className="muted">{script.path}</p>
          <pre className="code">{script.content}</pre>
        </div>
      ) : null}

      <h2>Plan</h2>
      <p className="muted">
        {plan.stats.originalSteps} steps → {plan.stats.plannedSteps} steps ({plan.stats.savedPct}% saved)
      </p>
      {plan.ops.length === 0 ? (
        <p className="muted">No steps.</p>
      ) : (
        <FlowChart
          flowId={flow.id}
          flowName={flow.name}
          ops={plan.ops}
          cases={cases.map(c => ({ id: c.id, externalId: c.externalId, title: c.title, lastStatus: c.lastStatus }))}
          onRunCase={runCase}
          onCaseClick={(caseId) => {
            setOpenCaseId(prev => prev === caseId ? null : caseId);
            const el = document.getElementById(`case-row-${caseId}`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }}
        />
      )}

      <h2>Cases</h2>
      {cases.length === 0 ? <p className="muted">No cases in this flow.</p> : (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>Last status</th>
              <th>Recorded</th>
              <th>Move to flow</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {cases.map(c => (
              <CaseRows
                key={c.id}
                c={c}
                open={expanded.has(c.id)}
                flows={flows}
                currentFlowId={flow.id}
                onToggle={() => toggleExpanded(c.id)}
                onDelete={() => deleteCase(c.id)}
                onMove={(fid) => moveCase(c.id, fid)}
                onSaveStep={saveStep}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface CaseRowsProps {
  c: FlowDetailResponse['cases'][number];
  open: boolean;
  flows: FlowSummary[];
  currentFlowId: number;
  onToggle: () => void;
  onDelete: () => void;
  onMove: (flowId: number) => void;
  onSaveStep: (caseId: number, position: number, patch: UpdateStepPayload) => Promise<void>;
}

function CaseRows({ c, open, flows, currentFlowId, onToggle, onDelete, onMove, onSaveStep }: CaseRowsProps) {
  const [editingPos, setEditingPos] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [editExpected, setEditExpected] = useState('');
  const [editMutability, setEditMutability] = useState<'safe' | 'mutating' | 'reset'>('safe');
  const [saving, setSaving] = useState(false);

  const startEdit = (s: FlowDetailResponse['cases'][number]['steps'][number]) => {
    setEditingPos(s.position);
    setEditText(s.text);
    setEditExpected(s.expected ?? '');
    setEditMutability(s.mutability);
  };

  const cancelEdit = () => setEditingPos(null);

  const saveEdit = async (position: number) => {
    setSaving(true);
    try {
      await onSaveStep(c.id, position, {
        text: editText.trim() || undefined,
        expected: editExpected.trim() || null,
        mutability: editMutability,
      });
      setEditingPos(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <tr id={`case-row-${c.id}`} className="clickable" onClick={onToggle}>
        <td>{c.externalId ?? `C${c.id}`}</td>
        <td>{c.title}</td>
        <td><Badge status={c.lastStatus} /></td>
        <td>{c.recorded ? '✓' : '✗'}</td>
        <td onClick={e => e.stopPropagation()}>
          <select defaultValue="" onChange={e => { if (e.target.value) onMove(Number(e.target.value)); }}>
            <option value="">move…</option>
            {flows.filter(f => f.id !== currentFlowId).map(f => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </td>
        <td onClick={e => e.stopPropagation()}>
          <button
            type="button"
            className="danger"
            onClick={onDelete}
          >
            Delete
          </button>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={6}>
            <ol className="steps">
              {c.steps.map(s => (
                <li key={`${s.position}-${s.stepId}`}>
                  {editingPos === s.position ? (
                    <div className="step-edit" onClick={e => e.stopPropagation()}>
                      <input
                        className="step-edit-text"
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Escape') cancelEdit(); }}
                        autoFocus
                      />
                      <input
                        className="step-edit-expected"
                        placeholder="expected (optional)"
                        value={editExpected}
                        onChange={e => setEditExpected(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Escape') cancelEdit(); }}
                      />
                      <select
                        value={editMutability}
                        onChange={e => setEditMutability(e.target.value as 'safe' | 'mutating' | 'reset')}
                      >
                        <option value="safe">safe</option>
                        <option value="mutating">mutating</option>
                        <option value="reset">reset</option>
                      </select>
                      <button type="button" disabled={saving} onClick={() => saveEdit(s.position)}>
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button type="button" onClick={cancelEdit}>Cancel</button>
                    </div>
                  ) : (
                    <span className="step-view">
                      {s.text} <Badge status={s.mutability} />
                      {s.expected ? <span className="muted"> → {s.expected}</span> : null}
                      <button
                        type="button"
                        className="step-edit-btn"
                        onClick={e => { e.stopPropagation(); startEdit(s); }}
                        title="Edit step"
                      >
                        ✎
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </td>
        </tr>
      ) : null}
    </>
  );
}
