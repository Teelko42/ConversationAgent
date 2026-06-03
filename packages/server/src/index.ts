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
import { dirname, join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { loadConfig, providerStatus } from './config.js';
import { createSession, type SessionHandle } from './session.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '../public');

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/client.js': { file: 'client.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

async function main(): Promise<void> {
  const cfg = loadConfig();
  const status = providerStatus(cfg);

  const httpServer = createServer((req, res) => {
    const route = STATIC[req.url ?? '/'];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    readFile(join(publicDir, route.file))
      .then((buf) => {
        res.writeHead(200, { 'content-type': route.type });
        res.end(buf);
      })
      .catch(() => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('failed to read asset');
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
      };
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return; // ignore malformed control frames
      }
      if (msg.type === 'stop') {
        void session?.stop();
      } else if (msg.type === 'explain' && msg.segment_id && msg.text) {
        const { segment_id, text } = msg;
        session
          ?.explain(segment_id, text)
          .then((explanation) => send({ type: 'explanation', explanation }))
          .catch((err: unknown) =>
            send({ type: 'explain_error', segment_id, message: String((err as Error)?.message ?? err) }),
          );
      } else if (msg.type === 'ask' && msg.segment_id && msg.question && msg.ask_id) {
        const { segment_id, question, ask_id, sentence, transcript } = msg;
        // The client ships the sentence + recent transcript it's asking about, so a
        // follow-up is answerable even on a freshly (re)connected session whose own
        // context buffer is still empty. The session prefers this, falling back to
        // its rolling buffer when absent.
        session
          ?.ask(segment_id, question, ask_id, { sentence, transcript })
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
    if (status.stt !== 'deepgram' || status.llm !== 'anthropic') {
      console.log('');
      console.log('  Some providers are stubbed. Add keys to .env to go fully live.');
    }
    console.log('');
    /* eslint-enable no-console */
  });
}

void main();
