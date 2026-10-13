import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type RunListItem } from '../api';
import Badge from '../components/Badge';

export default function Runs() {
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<RunListItem[]>('/runs')
      .then(setRuns)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <section>
      <h1>Runs</h1>
      {error ? <div className="banner err-banner">{error}</div> : null}
      {runs === null && !error ? <p className="muted">Loading…</p> : null}
      {runs !== null && runs.length === 0 ? <p className="muted">No runs yet.</p> : null}
      {runs !== null && runs.length > 0 && (
        <table>
          <thead>
            <tr><th>Run</th><th>Mode</th><th>Scope</th><th>Status</th><th>Started</th><th>Finished</th></tr>
          </thead>
          <tbody>
            {runs.map(r => (
              <tr key={r.id}>
                <td><Link to={`/runs/${r.id}`}>#{r.id}</Link></td>
                <td>{r.mode}</td>
                <td>{r.scope}</td>
                <td><Badge status={r.status} /></td>
                <td>{r.started_at}</td>
                <td>{r.finished_at ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
