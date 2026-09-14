import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import apiRouter from './routes/api.js';

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api', requireApiKey, apiRouter);

app.use(
  '/outputs',
  requireApiKey,
  express.static(config.outputsDir, {
    index: false,
    dotfiles: 'deny',
    // Generated files (e.g. SVG) come from model output; never let them run scripts.
    setHeaders: (res) => {
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }),
);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.expose ? err.message : 'Internal server error' });
});

function requireApiKey(req, res, next) {
  if (!config.apiKey) return next();

  const authorization = req.get('authorization') ?? '';
  const provided = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : req.get('x-api-key') ?? '';

  const expected = Buffer.from(config.apiKey);
  const actual = Buffer.from(provided);
  if (actual.length === expected.length && timingSafeEqual(actual, expected)) return next();

  res.status(401).json({ error: 'Unauthorized' });
}

export default app;
