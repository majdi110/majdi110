'use strict';

/**
 * BeloCloud Actions mini-server (no external deps).
 *
 * Endpoints:
 *   GET  /ai2/                 -> "AppJS ACTIVE"
 *   GET  /ai2/_health          -> { ok:true, time }
 *   GET  /ai2/health           -> alias of /ai2/_health
 *   GET  /ai2/version          -> { ok:true, version }
 *   GET  /ai2/static/<file>    -> serve ./public/<file> (json/text only)
 *   POST /ai2/echo             -> debug echo; shows headers/body + decoded preview
 *   POST /ai2/diff_submit      -> enqueue a Base64 (or base64url) unified diff
 *   POST /ai2/diff_dryrun      -> git-apply --check (no enqueue), against origin/<base_branch>
 *
 * Notes
 * - /ai2/diff_submit body (application/json):
 *     { base_branch:"main", message?: "...", diff_b64:"<base64>", idempotency_key? }
 * - Auth for /ai2/diff_submit:
 *     Header X-Api-Key must equal token in /home/genweb/agent/ACTION_TOKEN
 * - Idempotency:
 *     Header X-Idempotency-Key preferred (or body.idempotency_key). Creates
 *     .idem-<key> file pointing to queued job to dedupe replays.
 */

const http   = require('http');
const fs     = require('fs');
const fsp    = require('fs/promises');
const path   = require('path');
const crypto = require('crypto');
const url    = require('url');
const os     = require('os');
const { execFile } = require('child_process');

// --- config/paths ---
const TOKEN_FILE  = '/home/genweb/agent/ACTION_TOKEN';
const QUEUE_DIR   = '/home/genweb/agent/queue';
const IDEM_DIR    = QUEUE_DIR; // idempotency markers live alongside jobs
const DEBUG_LOG   = '/home/genweb/agent/last_action_debug.log';
const STATIC_ROOT = path.join(__dirname, 'public');
const VERSION_FILE = path.join(__dirname, 'VERSION.txt'); // <— define ONCE
const MAX_BYTES   = 512 * 1024;

// --- state/init ---
let ACTION_TOKEN = '';
try { ACTION_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
try { fs.mkdirSync(QUEUE_DIR, { recursive: true }); } catch {}

// --- helpers ---
const nowISO  = () => new Date().toISOString();
const ipOf    = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '');
const idemSan = (s) => String(s || '').replace(/[^A-Za-z0-9._:-]/g, '_');
const ts      = () => {
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};
const r4      = () => crypto.randomBytes(2).toString('hex');
const sha256S = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const logDbg  = (objOrStr) => {
  try {
    const line = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr);
    fs.appendFileSync(DEBUG_LOG, line + '\n');
  } catch {}
};

// tolerant Base64 -> utf8 (accepts base64url, whitespace, missing padding)
function fromAnyB64(s) {
  if (typeof s !== 'string') return '';
  s = s.replace(/\s+/g, '');                           // strip whitespace
  s = s.replace(/-/g, '+').replace(/_/g, '/');         // url-safe -> std
  while (s.length % 4) s += '=';                       // re-pad
  try { return Buffer.from(s, 'base64').toString('utf8'); }
  catch { return ''; }
}

// read entire request body (size-guarded)
function readBody(req, cb) {
  let n = 0; const chunks = [];
  req.on('data', c => {
    n += c.length;
    if (n > MAX_BYTES) {
      const e = Object.assign(new Error('payload_too_large'), { code: 413 });
      cb(e); try { req.destroy(); } catch {}
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', cb);
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=UTF-8' });
  res.end(JSON.stringify(obj));
}
function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=UTF-8' });
  res.end(text);
}

// --- core validation for diffs ---
function validateBase64Chars(b64) {
  // allow std + url-safe: A-Za-z0-9+/_= and dash
  return /^[A-Za-z0-9+/_=-]+$/.test(b64);
}
function containsControlBytes(s) {
  // reject any control chars except \t \n \r
  return /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(s);
}

/**
 * Validate git-style unified diff (focus on NEW FILE additions).
 * Returns { ok:true } or { ok:false, error:'...' }
 */
function validateUnifiedDiff(diff) {
  if (!/^diff --git /m.test(diff)) return { ok:false, error:'diff_invalid_format' };

  // If this looks like a new file diff, enforce invariants.
  if (/(^|\n)new file mode \d+/.test(diff)) {
    if (!/(^|\n)new file mode 100644(\r?\n)/.test(diff)) {
      return { ok:false, error:'new_file_mode_must_be_100644' };
    }
    if (!/(^|\n)--- \/dev\/null(\r?\n)/.test(diff)) {
      return { ok:false, error:'new_file_requires_devnull' };
    }
    if (!/(^|\n)\+\+\+ b\/[^\n]+(\r?\n)/.test(diff)) {
      return { ok:false, error:'bad_plus_plus_plus_line' };
    }
    // Require at least one hunk with -0,0 +N
    const hunk = diff.match(/(^|\n)@@ -0,0 \+(\d+) @@/);
    if (!hunk) return { ok:false, error:'bad_hunk_header_for_new_file' };

    // Optional sanity—ensure we don't have fewer '+' lines than N
    const expected = parseInt(hunk[2], 10);
    const plusLines = diff.split('\n').filter(line => {
      if (!line.startsWith('+')) return false;
      return !/^\+\+\+ b\//.test(line); // exclude header
    }).length;
    if (Number.isFinite(expected) && expected > 0 && plusLines > 0 && plusLines < expected) {
      return { ok:false, error:'hunk_content_lines_mismatch' };
    }
  }
  return { ok:true };
}

// --- tiny static server: /ai2/static/* -> ./public/*  (read-only; json/text only) ---
function serveStatic(req, res, parsedPathname) {
  // Only allow GET or HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  // Accept /ai2/static/* and /static/* (second form helps local testing)
  if (!parsedPathname.startsWith('/ai2/static/') && !parsedPathname.startsWith('/static/')) return false;

  const rel = parsedPathname.replace(/^\/(ai2\/)?static\//, '');         // strip prefix
  // normalize: disallow path traversal
  const safeRel = rel.split('/').filter(seg => seg && seg !== '.' && seg !== '..').join('/');
  const file = path.join(STATIC_ROOT, safeRel);

  try {
    // must be under STATIC_ROOT
    const real = fs.realpathSync(file);
    if (!real.startsWith(STATIC_ROOT)) {
      sendText(res, 403, 'Forbidden\n'); return true;
    }
    if (!fs.existsSync(real) || !fs.statSync(real).isFile()) {
      sendText(res, 404, 'Not Found\n'); return true;
    }

    // Very small content-type map (json & text by default)
    let ct = 'text/plain; charset=UTF-8';
    if (/\.json$/i.test(real)) ct = 'application/json; charset=UTF-8';
    else if (/\.txt$/i.test(real)) ct = 'text/plain; charset=UTF-8';
    else if (/\.log$/i.test(real)) ct = 'text/plain; charset=UTF-8';
    else return sendText(res, 415, 'Unsupported Media Type\n');

    const data = fs.readFileSync(real);
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') { res.end(); } else { res.end(data); }
  } catch (e) {
    sendText(res, 500, 'Static error\n');
  }
  return true;
}

// --- handlers ---
function handleEcho(req, res) {
  readBody(req, (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    let body = null, decoded = '';
    try { if (ct.includes('json')) body = JSON.parse(buf.toString('utf8')); } catch {}
    if (body && typeof body.diff_b64 === 'string' && validateBase64Chars(body.diff_b64)) {
      decoded = fromAnyB64(body.diff_b64).slice(0, 200);
    }
    return sendJSON(res, 200, {
      ok: true,
      ct,
      raw_len: buf.length,
      headers: req.headers,
      body,
      decoded_preview: decoded
    });
  });
}

function handleDiffSubmit(req, res) {
  // --- auth ---
  const apiKey = req.headers['x-api-key'];
  if (!ACTION_TOKEN || apiKey !== ACTION_TOKEN) {
    return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  }

  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) {
    return sendJSON(res, 415, { ok:false, error:'unsupported_media_type' });
  }

  readBody(req, (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });

    // Log compact request info
    logDbg({ time: nowISO(), tag: 'REQ', path: req.url, method: req.method, ct, ip: ipOf(req), headers: req.headers });
    logDbg({ time: nowISO(), tag: 'REQ_BODY', raw_len: buf.length, json_head: buf.slice(0, 512).toString('utf8') });

    // --- parse JSON body ---
    let body = {};
    try { body = JSON.parse(buf.toString('utf8') || '{}'); }
    catch { return sendJSON(res, 400, { ok:false, error:'invalid_json' }); }

    // Extract fields
    const base         = String(body.base_branch || 'main');
    const rawMessage   = (typeof body.message === 'string' ? body.message.trim() : '');
    const diff_b64_raw = String(body.diff_b64 || '');
    const idemHeader   = String(req.headers['x-idempotency-key'] || '');
    const idemBody     = String(body.idempotency_key || '');
    const idemVal      = idemHeader || idemBody || '';

    // --- basic field checks ---
    if (base !== 'main') return sendJSON(res, 403, { ok:false, error:'branch_not_allowed' });
    if (!diff_b64_raw)   return sendJSON(res, 400, { ok:false, error:'diff_b64_required' });
    if (!validateBase64Chars(diff_b64_raw)) {
      return sendJSON(res, 400, { ok:false, error:'diff_b64_invalid_chars' });
    }

    // --- decode + validate diff ---
    const diff = fromAnyB64(diff_b64_raw);
    logDbg({ time: nowISO(), tag: 'DECODED_HEAD', preview: diff.slice(0, 200) });

    if (!diff)                        return sendJSON(res, 400, { ok:false, error:'diff_b64_decode_failed' });
    if (containsControlBytes(diff))   return sendJSON(res, 400, { ok:false, error:'diff_contains_control_bytes' });
    const v = validateUnifiedDiff(diff);
    if (!v.ok)                        return sendJSON(res, 400, { ok:false, error: v.error });

    // --- idempotency dedupe ---
    let idemPointerFile = '';
    if (idemVal) {
      const idemFile = path.join(IDEM_DIR, `.idem-${idemSan(idemVal)}`);
      idemPointerFile = idemFile;
      if (fs.existsSync(idemFile)) {
        const existing = (fs.readFileSync(idemFile) + '').trim();
        return sendJSON(res, 200, { ok:true, duplicate_of: path.basename(existing) });
      }
    }

    // --- enqueue job ---
    const id   = `job-${ts()}-${r4()}.json`;
    const file = path.join(QUEUE_DIR, id);
    const job  = {
      enqueued_at: nowISO(),
      from_endpoint: 'diff_submit_action_node',
      ip: ipOf(req),
      ua: String(req.headers['user-agent'] || ''),
      base_branch: base,
      message: (rawMessage || `ChatGPT change ${nowISO()}`),
      diff,
      sha256: sha256S(diff)
    };

    try {
      fs.writeFileSync(file, JSON.stringify(job));
      if (idemVal && idemPointerFile) fs.writeFileSync(idemPointerFile, file);
    } catch (e) {
      logDbg({ time: nowISO(), tag: 'QUEUE_WRITE_FAIL', error: String(e) });
      return sendJSON(res, 500, { ok:false, error:'queue_write_failed' });
    }

    logDbg({ time: nowISO(), tag: 'ENQUEUED', job: path.basename(file), sha256: job.sha256, msg: job.message, idem: idemVal || null });
    return sendJSON(res, 200, { ok:true, queued: path.basename(file), sha256: job.sha256 });
  });
}

function execp(cmd, args, opts={}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16*1024*1024, ...(opts||{}) }, (err, stdout, stderr) => {
      if (err) { err.stdout = String(stdout||''); err.stderr = String(stderr||''); return reject(err); }
      resolve({ stdout: String(stdout||''), stderr: String(stderr||'') });
    });
  });
}

async function handleDiffDryrun(req, res) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) {
    return sendJSON(res, 415, { ok:false, error:'unsupported_media_type' });
  }

  readBody(req, async (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });
    let body = {};
    try { body = JSON.parse(buf.toString('utf8') || '{}'); }
    catch { return sendJSON(res, 400, { ok:false, error:'invalid_json' }); }

    const base_branch = body.base_branch ? String(body.base_branch) : 'main';
    const diff_b64 = body.diff_b64 ? String(body.diff_b64) : '';
    if (!diff_b64) return sendJSON(res, 400, { ok:false, error:'missing diff_b64' });

    // decode (accept url-safe)
    const patchText = fromAnyB64(diff_b64);
    if (!patchText) return sendJSON(res, 400, { ok:false, error:'diff_b64: decode error or empty' });
    const patchBuf = Buffer.from(patchText, 'utf8');
    if (patchBuf.length > 5 * 1024 * 1024) return sendJSON(res, 413, { ok:false, error:'patch too large (>5MB)' });

    // quick structural validation first
    const v = validateUnifiedDiff(patchText);
    if (!v.ok) return sendJSON(res, 400, { ok:false, error: v.error });

    const repo = __dirname;
    const tmpDir = path.join(os.tmpdir(), `ai2-dryrun-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await fsp.mkdir(tmpDir, { recursive:true });

      // make sure we have the latest base
      await execp('git', ['fetch', '--depth=1', 'origin', base_branch], { cwd: repo });

      // create a detached worktree at the remote branch tip (no changes to live tree)
      await execp('git', ['worktree', 'add', '--detach', '--force', tmpDir, `origin/${base_branch}`], { cwd: repo });

      const patchPath = path.join(tmpDir, 'incoming.patch');
      await fsp.writeFile(patchPath, patchBuf);

      try {
        // --check = no changes; --3way = tolerate small context drift
        await execp('git', ['apply', '--check', '--3way', '--unsafe-paths', patchPath], { cwd: tmpDir });
        return sendJSON(res, 200, { ok:true });
      } catch (e) {
        return sendJSON(res, 422, { ok:false, error:'git apply --check failed', detail: e.stderr || e.stdout || String(e) });
      } finally {
        try { await execp('git', ['worktree', 'remove', '--force', tmpDir], { cwd: repo }); } catch {}
      }
    } catch (e) {
      try { await execp('git', ['worktree', 'remove', '--force', tmpDir], { cwd: repo }); } catch {}
      return sendJSON(res, 500, { ok:false, error: e.message || String(e) });
    }
  });
}

// --- router ---
function handler(req, res) {
  const p = (url.parse(req.url).pathname || '');

  // static files first (cheap, no body read)
  if (serveStatic(req, res, p)) return;

  // health
  if (req.method === 'GET' && (p === '/ai2/_health' || p === '/_health')) {
    return sendJSON(res, 200, { ok:true, time: nowISO() });
  }
  if (req.method === 'GET' && (p === '/ai2/health' || p === '/health')) {
    return sendJSON(res, 200, { ok:true, time: nowISO() });
  }

  // version
  if (req.method === 'GET' && (p === '/ai2/version' || p === '/version')) {
    let rev = 'unknown';
    try { rev = fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch {}
    return sendJSON(res, 200, { ok:true, version: rev });
  }

  // echo
  if (req.method === 'POST' && (p === '/ai2/echo' || p === '/echo')) {
    return handleEcho(req, res);
  }

  // submit diff (auth required)
  if (req.method === 'POST' && (p === '/ai2/diff_submit' || p === '/diff_submit')) {
    return handleDiffSubmit(req, res);
  }

  // dryrun (no auth; it's safe validation only)
  if (req.method === 'POST' && (p === '/ai2/diff_dryrun' || p === '/diff_dryrun')) {
    return handleDiffDryrun(req, res);
  }

  // root banner (quick check)
  if (req.method === 'GET' && (p === '/ai2/' || p === '/')) {
    return sendText(res, 200, 'AppJS ACTIVE\n');
  }

  // fallback
  return sendText(res, 404, 'Not Found\n');
}

// --- start server (Passenger sets PORT) ---
const PORT = process.env.PORT || 3000;
http.createServer(handler).listen(PORT, () => {
  logDbg({ tag: 'boot', time: nowISO(), msg: `listening PORT=${PORT}` });
});
