const express = require('express');
const path = require('path');
const app = express();

app.use(express.json({ limit: '512kb' }));

// everything lives under /ai2 externally
const r = express.Router();

// static files: GET /ai2/static/*
r.use('/static', express.static(path.join(__dirname, 'public')));

// health: GET /ai2/health
// compatibility: /ai2/health -> same as /ai2/_health
if (req.method === 'GET' && (p === '/ai2/health' || p === '/health')) {
  return sendJSON(res, 200, { ok:true, time: nowISO() });
}


// banner: GET /ai2/
r.get('/', (_req, res) => res.type('text/plain').send('Node OK (ai2)\n'));

// 404 for /ai2/*
r.use((_req, res) => res.status(404).type('text/plain').send('Not Found\n'));

// mount router at /ai2
app.use('/ai2', r);

// root tip: GET /
app.get('/', (_req, res) => res.type('text/plain').send('App mounted at /ai2\n'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`listening on :${PORT}`));
