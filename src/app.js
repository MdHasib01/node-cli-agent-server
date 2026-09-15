import { existsSync } from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import { config } from './config.js';
import { requireApiAccess } from './middleware/auth.js';
import apiRouter from './routes/api.js';
import authRouter from './routes/auth.js';
import dashboardRouter from './routes/dashboard.js';

const app = express();

app.disable('x-powered-by');
// Honour X-Forwarded-For only from a local reverse proxy (e.g. the Vite dev server).
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRouter);
app.use('/api', dashboardRouter);
app.use('/api', requireApiAccess, apiRouter);

app.use(
  '/outputs',
  (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  },
  express.static(config.outputsDir, {
    index: false,
    dotfiles: 'deny',
    // Generated files (e.g. SVG) come from model output; never let them run scripts.
    setHeaders: (res) => {
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  }),
);

// Serves the built dashboard (client/dist) when it exists; in development Vite serves it instead.
const clientIndex = path.join(config.clientDistDir, 'index.html');
if (existsSync(clientIndex)) {
  app.use(express.static(config.clientDistDir, { index: false }));
  app.get(/^\/(?!(api|outputs|health)(\/|$)).*/, (req, res) => res.sendFile(clientIndex));
}

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.expose ? err.message : 'Internal server error';

  if (err.name === 'ValidationError') {
    status = 400;
    message = Object.values(err.errors ?? {})[0]?.message ?? 'Invalid input';
  } else if (err.name === 'CastError') {
    status = 400;
    message = `Invalid value for "${err.path}"`;
  } else if (err.code === 11000) {
    status = 409;
    message = 'That value is already in use';
  }

  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
});

export default app;
