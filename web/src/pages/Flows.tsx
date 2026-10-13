import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, jsonInit, type FlowSummary } from '../api';
import Badge from '../components/Badge';

type Mode = 'claude' | 'playwright';
type Scope = 'all' | 'unverified' | 'failed';

export default function Flows() {
  const navigate = useNavigate();
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>('unverified');
  const [newName, setNewName] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<FlowSummary[]>('/flows')
      .then(setFlows)
      .catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);

  const createFlow = async () => {
    if (newName.trim() === '') return;
    try {
      await api('/flows', jsonInit('POST', { name: newName.trim() }));
      setNewName('');
      setError(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const run = async (flowIds: number[], mode: Mode) => {
    setBusy(true);
    try {
      const { id } = await api<{ id: number }>('/runs', jsonInit('POST', { flowIds, mode, scope }));
      navigate(`/runs/${id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <section>
      <div className="row between">
        <h1>Flows</h1>
        <div className="row">
          <label className="inline">
            Scope
            <select value={scope} onChange={e => setScope(e.target.value as Scope)}>
              <option value="all">all</option>
              <option value="unverified">unverified</option>
              <option value="failed">failed</option>
            </select>
          </label>
        </div>
      </div>

      {error ? <div className="banner err-banner">{error}</div> : null}

      <div className="row">
        <input
          type="text"
          placeholder="New flow name"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') createFlow(); }}
        />
        <button type="button" onClick={createFlow}>New flow</button>
        <button
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => run([...selected], 'playwright')}
        >
          Run selected (Playwright)
        </button>
        <button
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => run([...selected], 'claude')}
        >
          Run selected (Claude)
        </button>
      </div>

      {flows.length === 0 ? (
        <p className="muted">No flows yet. Upload a test-case file to create some.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Flow</th>
              <th>Cases</th>
              <th>Steps</th>
              <th>Coverage</th>
              <th>Last run</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {flows.map(f => (
              <tr key={f.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(f.id)}
                    onChange={() => toggle(f.id)}
                    aria-label={`select ${f.name}`}
                  />
                </td>
                <td><Link to={`/flows/${f.id}`}>{f.name}</Link></td>
                <td>{f.caseCount}</td>
                <td>{f.stepCount}</td>
                <td>
                  <Badge status={f.coverage.status} />{' '}
                  <span className="muted">{f.coverage.status} {f.coverage.covered}/{f.coverage.total}</span>
                </td>
                <td>
                  {f.lastRun ? (
                    <Link to={`/runs/${f.lastRun.id}`}><Badge status={f.lastRun.status} /></Link>
                  ) : <span className="muted">—</span>}
                </td>
                <td className="actions">
                  <button type="button" disabled={busy} onClick={() => run([f.id], 'playwright')}>Run (Playwright)</button>
                  <button type="button" disabled={busy} onClick={() => run([f.id], 'claude')}>Run (Claude)</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
