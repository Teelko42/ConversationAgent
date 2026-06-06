/**
 * @aizen/server — the runnable app's entrypoint. An HTTP server (serves the
 * browser client) + a WebSocket endpoint (one live session per connection).
 *
 * Per connection: a `createSession` wiring is built; every bus envelope it
 * produces is relayed to the browser as a JSON `{type:'envelope'}` frame, and
 * every binary frame from the browser (PCM16LE 16 kHz mono mic audio) is fed into
 * the session's STT. The first frame sent to the client is a `{type:'status'}`
 * describing which real providers are active, so the UI can show "live" vs "demo".
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { loadConfig, providerStatus } from './config.js';
import { createSession, type SessionHandle } from './session.js';
import { buildAccountSystem, handleAccountRequest } from './accounts.js';
import type { UserSource } from '@aizen/contracts';

// Bounds on the BYO user-source context a client may attach to a request (F2 §6 /
// S0), mirroring `coerceArtifacts`' fail-safe posture: cap the count and each text
// size so a single frame can't carry an unbounded prompt. With S0's chunked
// retrieval each item is small (~600 chars) but there are MORE of them, so the
// count cap is raised (S0 "Server alignment") and an AGGREGATE byte ceiling bounds
// the whole array regardless of count. User text is conversation data (team-09) —
// it is passed through to the engine, never logged raw here.
const MAX_USER_SOURCES = 40;
const MAX_USER_SOURCE_TEXT = 4096;
const MAX_USER_SOURCE_TITLE = 512;
const MAX_USER_SOURCE_URL = 2048;
const MAX_USER_SOURCES_TOTAL_BYTES = 64 * 1024; // aggregate ceiling over all items' text
/** Provenance of a BYO source (S0 / F3 §4 polish). Unknown values drop to undefined. */
const USER_SOURCE_ORIGINS: ReadonlySet<string> = new Set(['paste', 'file', 'obsidian']);

/** Coerce a client-supplied `user_sources` list into validated, bounded sources. */
function coerceUserSources(input: unknown): UserSource[] {
  if (!Array.isArray(input)) return [];
  const out: UserSource[] = [];
  let totalBytes = 0;
  for (const s of input) {
    if (!s || typeof s !== 'object') continue;
    const text = (s as { text?: unknown }).text;
    if (typeof text !== 'string' || !text.trim()) continue; // text is required
    const clipped = text.slice(0, MAX_USER_SOURCE_TEXT);
    // Aggregate byte ceiling: stop once the whole array would exceed the budget
    // (UTF-8-ish via Buffer.byteLength) so one frame can't carry an unbounded prompt.
    const bytes = Buffer.byteLength(clipped, 'utf8');
    if (totalBytes + bytes > MAX_USER_SOURCES_TOTAL_BYTES) break;
    totalBytes += bytes;
    const id = (s as { id?: unknown }).id;
    const title = (s as { title?: unknown }).title;
    const url = (s as { url?: unknown }).url;
    const origin = (s as { origin?: unknown }).origin;
    out.push({
      id: typeof id === 'string' && id ? id : `us_${out.length}`,
      text: clipped,
      ...(typeof title === 'string' && title ? { title: title.slice(0, MAX_USER_SOURCE_TITLE) } : {}),
      ...(typeof url === 'string' && url ? { url: url.slice(0, MAX_USER_SOURCE_URL) } : {}),
      ...(typeof origin === 'string' && USER_SOURCE_ORIGINS.has(origin)
        ? { origin: origin as UserSource['origin'] }
        : {}),
    });
    if (out.length >= MAX_USER_SOURCES) break;
  }
  return out;
}

// Max size of a single JSON control text-frame (explain/ask/stop). Binary audio is
// implicitly bounded by the capture pipeline, but a JSON control frame was not —
// mirror `readJsonBody`'s MAX_BODY_BYTES posture so a malformed/oversized frame is
// dropped rather than parsed. Comfortably fits 40 chunks + transcript context.
const MAX_WS_TEXT_BYTES = 512 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '../public');

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/client.js': { file: 'client.js', type: 'text/javascript; charset=utf-8' },
  // S0 source library + retrieval and the F4 Obsidian seam — loaded before client.js.
  '/sources.js': { file: 'sources.js', type: 'text/javascript; charset=utf-8' },
  '/obsidian.js': { file: 'obsidian.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

const vendorDir = resolve(publicDir, 'vendor');

/** Content-type for a vendored asset by extension (F3 — vendored pdf.js etc.). */
const VENDOR_TYPES: Record<string, string> = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.bcmap': 'application/octet-stream',
};

/**
 * Resolve a `/vendor/<path>` request to a real file under `public/vendor`, or null
 * if the path escapes the directory (traversal) or has no served extension. Lets the
 * client lazily `import('/vendor/pdf.mjs')` for PDF extraction (F3 §3) — see
 * `public/vendor/README.md`. Absent files simply 404 (the UI shows a clear message).
 */
function resolveVendor(path: string): { file: string; type: string } | null {
  const rel = decodeURIComponent(path.slice('/vendor/'.length));
  if (!rel || rel.includes('\0')) return null;
  const abs = resolve(vendorDir, rel);
  if (abs !== vendorDir && !abs.startsWith(vendorDir + sep)) return null; // no traversal
  const ext = abs.slice(abs.lastIndexOf('.'));
  const type = VENDOR_TYPES[ext];
  if (!type) return null;
  return { file: abs, type };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const status = providerStatus(cfg);
  const accounts = await buildAccountSystem(cfg);

  const httpServer = createServer((req, res) => {
    // Account routes (sign-in, session, saved-resource CRUD) get first refusal;
    // they fall through (return false) for anything that isn't theirs. Static
    // assets are matched only by path (ignore any query string the OAuth flow adds).
    void handleAccountRequest(req, res, accounts)
      .then((handled) => {
        if (handled) return;
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        // Vendored, lazily-imported assets (e.g. /vendor/pdf.mjs for F3 PDF parsing)
        // are served from public/vendor with a traversal-safe resolver; an absent
        // file 404s (the UI then shows a clear "vendor pdf.js" message).
        const vendor = path.startsWith('/vendor/') ? resolveVendor(path) : null;
        const route = STATIC[path];
        if (!vendor && !route) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
          return;
        }
        const filePath = vendor ? vendor.file : join(publicDir, route!.file);
        const type = vendor ? vendor.type : route!.type;
        readFile(filePath)
          .then((buf) => {
            // No-store: the client (index.html / client.js / styles.css) is served
            // straight from disk and iterated often, so never let a browser keep a
            // stale copy — a plain refresh always gets the latest UI.
            res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
            res.end(buf);
          })
          .catch(() => {
            // A missing vendor file (not yet dropped in) is a 404, not a 500.
            if (vendor) {
              res.writeHead(404, { 'content-type': 'text/plain' });
              res.end('not found');
            } else {
              res.writeHead(500, { 'content-type': 'text/plain' });
              res.end('failed to read asset');
            }
          });
      })
      .catch((err: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('internal error');
        }
        // eslint-disable-next-line no-console
        console.error('[server] request handling failed:', err);
      });
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    let session: SessionHandle | undefined;
    let closed = false;

    const send = (obj: unknown): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    createSession(cfg, status, (env) => send({ type: 'envelope', env }))
      .then((s) => {
        if (closed) {
          // socket closed before wiring finished — tear the session down.
          void s.stop();
          return;
        }
        session = s;
        send({ type: 'status', sessionId: s.sessionId, mode: s.mode, providers: status });
      })
      .catch((err: unknown) => {
        send({ type: 'error', message: String((err as Error)?.message ?? err) });
        ws.close();
      });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        session?.sendAudio(new Uint8Array(data));
        return;
      }
      // Bound a JSON control frame the same way readJsonBody bounds an HTTP body —
      // a single oversized text frame is dropped rather than parsed (S0 alignment).
      if (data.length > MAX_WS_TEXT_BYTES) return;
      // text control frames: stop, explain-this-sentence (F03 click), or ask a
      // typed follow-up about an explained sentence (F1).
      let msg: {
        type?: string;
        segment_id?: string;
        text?: string;
        question?: string;
        ask_id?: string;
        sentence?: string;
        transcript?: string[];
        user_sources?: unknown;
      };
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return; // ignore malformed control frames
      }
      if (msg.type === 'stop') {
        void session?.stop();
      } else if (msg.type === 'explain' && msg.segment_id && msg.text) {
        const { segment_id, text, transcript } = msg;
        const userSources = coerceUserSources(msg.user_sources);
        // The client ships the surrounding transcript it's looking at, so a sentence
        // a long pause split across lines is explained in the context of its
        // neighbours — and so that context survives a WS reconnect (a fresh server
        // session's own buffer starts empty). The session prefers this, falling back
        // to its rolling buffer when absent.
        // Stream the answer in (#1): the explanation+breakdown paints as soon as hop 1
        // lands (`explanation_partial`), then the grounded answer arrives token-by-token
        // (`answer_delta`), then the final `explanation` frame reconciles answer+sources.
        session
          ?.explain(
            segment_id,
            text,
            { transcript },
            userSources,
            (delta) => send({ type: 'answer_delta', segment_id, text: delta }),
            (partial) => send({ type: 'explanation_partial', explanation: partial }),
          )
          .then((explanation) => send({ type: 'explanation', explanation }))
          .catch((err: unknown) =>
            send({ type: 'explain_error', segment_id, message: String((err as Error)?.message ?? err) }),
          );
      } else if (msg.type === 'ask' && msg.segment_id && msg.question && msg.ask_id) {
        const { segment_id, question, ask_id, sentence, transcript } = msg;
        const userSources = coerceUserSources(msg.user_sources);
        // The client ships the sentence + recent transcript it's asking about, so a
        // follow-up is answerable even on a freshly (re)connected session whose own
        // context buffer is still empty. The session prefers this, falling back to
        // its rolling buffer when absent. `user_sources` rides along the same way,
        // so BYO context survives a reconnect too (F2 §6). The answer streams in via
        // `answer_delta` frames (#1), with the final `answer` frame reconciling sources.
        session
          ?.ask(
            segment_id,
            question,
            ask_id,
            { sentence, transcript },
            userSources,
            (delta) => send({ type: 'answer_delta', ask_id, text: delta }),
          )
          .then((answer) => send({ type: 'answer', ask_id, answer }))
          .catch((err: unknown) =>
            send({ type: 'answer_error', ask_id, message: String((err as Error)?.message ?? err) }),
          );
      }
    });

    ws.on('close', () => {
      closed = true;
      void session?.stop();
    });
    ws.on('error', () => {
      closed = true;
      void session?.stop();
    });
  });

  httpServer.listen(cfg.port, () => {
    /* eslint-disable no-console -- startup banner is this process's job */
    console.log('');
    console.log('  Aizen is running.');
    console.log(`  →  http://localhost:${cfg.port}`);
    console.log('');
    console.log('  Providers:');
    console.log(`    speech-to-text : ${status.stt === 'deepgram' ? 'Deepgram (live mic)' : 'stub (demo clip)'}`);
    console.log(`    explanations   : ${status.llm === 'anthropic' ? 'Anthropic (real)' : 'stub (canned)'}`);
    console.log(`    web search     : ${status.search === 'tavily' ? 'Tavily (real)' : 'off'}`);
    console.log(
      `    sign-in        : ${
        accounts.authMode === 'real' ? `OAuth (${accounts.auth.enabled.join(', ')})` : 'stub (demo accounts)'
      } · store: ${
        accounts.dbBackend === 'postgres'
          ? 'PostgreSQL'
          : accounts.dbBackend === 'sqlite'
            ? 'SQLite'
            : 'in-memory'
      }`,
    );
    if (status.stt !== 'deepgram' || status.llm !== 'anthropic') {
      console.log('');
      console.log('  Some providers are stubbed. Add keys to .env to go fully live.');
    }
    console.log('');
    /* eslint-enable no-console */
  });
}

void main();
