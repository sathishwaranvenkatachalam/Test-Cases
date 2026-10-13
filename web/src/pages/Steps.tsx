import { useEffect, useState } from 'react';
import { api, jsonInit, type StepRow } from '../api';

type Mutability = StepRow['mutability'];

export default function Steps() {
  const [steps, setSteps] = useState<StepRow[] | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<StepRow[]>('/steps')
      .then(setSteps)
      .catch((e: Error) => setError(e.message));
  }, []);

  const changeMutability = async (id: number, mutability: Mutability) => {
    try {
      await api(`/steps/${id}`, jsonInit('PATCH', { mutability }));
      setSteps(prev => prev?.map(s => (s.id === id ? { ...s, mutability } : s)) ?? prev);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const visible = (steps ?? []).filter(s => s.text.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <section>
      <h1>Step library</h1>
      {error ? <div className="banner err-banner">{error}</div> : null}
      <input
        type="text"
        placeholder="Filter steps"
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      {steps === null && !error ? <p className="muted">Loading…</p> : null}
      {steps !== null && (
        <table>
          <thead>
            <tr><th>Step</th><th>Mutability</th><th>Used by</th><th>Recorded</th></tr>
          </thead>
          <tbody>
            {visible.map(s => (
              <tr key={s.id}>
                <td>{s.text}</td>
                <td>
                  <select value={s.mutability} onChange={e => changeMutability(s.id, e.target.value as Mutability)}>
                    <option value="safe">safe</option>
                    <option value="mutating">mutating</option>
                    <option value="reset">reset</option>
                  </select>
                </td>
                <td>{s.usedBy}</td>
                <td>{s.hasRecording ? '✓' : '✗'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
