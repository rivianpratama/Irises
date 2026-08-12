// irises chat — talk to Irises from the terminal (`npm run chat`). The CLI counterpart of the
// web debug page: same three endpoints (message / stream / cancel), same DEBUG_TOKEN auth, same
// per-clientId chat lane. The engine CLIs (`hermes`, `openclaw dashboard`) remain the way to talk
// to the ENGINE directly; this is how you talk to IRISES.
//
//   npm run chat                          # local server on PORT (default 3000)
//   npm run chat -- --url http://host:8080 --token <DEBUG_TOKEN> --client-id mylane
//
// In-chat commands: /cancel (stop in-flight deep work), /quit.
import readline from 'node:readline';

interface WebEvent {
  seq: number; ts: number;
  type: 'bubble' | 'typing' | 'reaction' | 'read' | 'hello';
  text?: string; reaction?: unknown;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = (arg('url', process.env.IRISES_URL || `http://127.0.0.1:${process.env.PORT || 3000}`) as string).replace(/\/$/, '');
const TOKEN = arg('token', process.env.DEBUG_TOKEN);
const CLIENT_ID = arg('client-id', 'terminal') as string;

function withAuth(path: string): string {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('clientId', CLIENT_ID);
  if (TOKEN) url.searchParams.set('token', TOKEN);
  return url.toString();
}

let typing = false;
function render(ev: WebEvent, rl: readline.Interface): void {
  if (ev.type === 'bubble' && ev.text) {
    if (typing) { process.stdout.write('\r\x1b[2K'); typing = false; }
    // Clear the prompt line, print the bubble, restore the prompt with any half-typed input.
    process.stdout.write(`\r\x1b[2K\x1b[36mirises>\x1b[0m ${ev.text}\n`);
    rl.prompt(true);
  } else if (ev.type === 'typing') {
    // Lightweight indicator only when idle at the prompt.
    if (!typing && (ev as { state?: string }).state !== 'stop') {
      typing = true;
      process.stdout.write('\r\x1b[2K\x1b[90m… typing\x1b[0m');
    } else if (typing) {
      typing = false;
      process.stdout.write('\r\x1b[2K');
      rl.prompt(true);
    }
  } else if (ev.type === 'reaction') {
    process.stdout.write(`\r\x1b[2K\x1b[36mirises>\x1b[0m [reaction] ${JSON.stringify(ev.reaction)}\n`);
    rl.prompt(true);
  }
}

async function stream(rl: readline.Interface): Promise<never> {
  let lastEventId = 0;
  for (;;) {
    try {
      const res = await fetch(withAuth('/api/web/stream'), {
        headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(lastEventId) },
      });
      if (res.status === 403) {
        console.error('\nforbidden — pass --token <DEBUG_TOKEN> (or run against localhost with it unset)');
        process.exit(1);
      }
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const data = frame.split('\n').find(l => l.startsWith('data: '))?.slice(6);
          if (!data) continue; // comments / pings
          try {
            const ev = JSON.parse(data) as WebEvent;
            if (typeof ev.seq === 'number') lastEventId = ev.seq;
            render(ev, rl);
          } catch { /* not JSON — ignore */ }
        }
      }
    } catch {
      // brief pause, then reconnect with Last-Event-ID resume
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function main(): Promise<void> {
  // Reachability first, so a wrong --url fails in one line instead of a silent prompt.
  try {
    const health = await fetch(`${BASE}/health`);
    if (!health.ok) throw new Error(String(health.status));
  } catch {
    console.error(`can't reach Irises at ${BASE} — is the server running? (npm run dev, or pass --url)`);
    process.exit(1);
  }

  console.log(`connected to ${BASE} (chat lane: ${CLIENT_ID}) — /cancel stops a lookup, /quit exits`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\x1b[33myou>\x1b[0m ' });
  void stream(rl);
  rl.prompt();
  rl.on('line', async line => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }
    if (text === '/quit' || text === '/exit') process.exit(0);
    if (text === '/cancel') {
      const res = await fetch(withAuth('/api/web/cancel'), { method: 'POST' });
      console.log(`cancelled: ${JSON.stringify(await res.json().catch(() => ({})))}`);
      rl.prompt(); return;
    }
    try {
      const res = await fetch(withAuth('/api/web/message'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, clientId: CLIENT_ID }),
      });
      if (res.status === 403) console.error('forbidden — pass --token <DEBUG_TOKEN>');
      else if (!res.ok) console.error(`send failed: ${res.status}`);
    } catch (err) {
      console.error('send failed:', (err as Error).message);
    }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}

void main();
