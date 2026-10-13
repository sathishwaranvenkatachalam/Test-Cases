import { useEffect, useState } from 'react';
import { api, type ReviewRow } from '../api';

export default function Reviews() {
  const [reviews, setReviews] = useState<ReviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api<ReviewRow[]>('/reviews?status=pending')
      .then(r => { setReviews(r); setError(null); })
      .catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);

  const act = async (id: number, action: 'approve' | 'reject') => {
    try {
      await api(`/reviews/${id}/${action}`, { method: 'POST' });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section>
      <h1>Merge reviews</h1>
      {error ? <div className="banner err-banner">{error}</div> : null}
      {reviews === null && !error ? <p className="muted">Loading…</p> : null}
      {reviews !== null && reviews.length === 0 ? <p className="muted">Nothing to review.</p> : null}

      {reviews?.map(r => (
        <div className="card" key={r.id}>
          <p>
            <strong>New step:</strong> {r.newStep.text}{' '}
            <span className="muted">(used by {r.newStep.usedBy} cases)</span>
          </p>
          <p>
            <strong>Existing step:</strong> {r.candidateStep.text}{' '}
            <span className="muted">(used by {r.candidateStep.usedBy} cases)</span>
          </p>
          <p className="muted">Confidence {Math.round(r.confidence * 100)}%</p>
          <div className="row">
            <button type="button" onClick={() => act(r.id, 'approve')}>Merge into existing</button>
            <button type="button" className="link" onClick={() => act(r.id, 'reject')}>Keep separate</button>
          </div>
        </div>
      ))}
    </section>
  );
}
