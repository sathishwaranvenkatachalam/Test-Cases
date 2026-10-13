import express from 'express';
import path from 'node:path';
import settingsRouter from './routes/settings.js';
import flowsRouter from './routes/flows.js';
import stepsRouter from './routes/steps.js';
import ingestRouter from './routes/ingest.js';
import reviewsRouter from './routes/reviews.js';
import runsRouter from './routes/runs.js';

export const app = express();

app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api', settingsRouter, flowsRouter, stepsRouter, ingestRouter, reviewsRouter, runsRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve('web', 'dist');
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });
}

// Error middleware: { error: message } with err.status (default 400).
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const e = err as { status?: number; message?: string };
  const status = typeof e.status === 'number' ? e.status : 400;
  res.status(status).json({ error: e.message ?? 'bad request' });
});

if (!process.env.VITEST) {
  const port = Number(process.env.PORT || 3001);
  app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`);
  });
}
