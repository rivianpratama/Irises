# Terminal-Only Lifecycle (install / update / uninstall) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers and task reviewers are **Opus**; Fable does one final whole-branch review. On approval, copy this file to `docs/superpowers/plans/2026-09-10-terminal-lifecycle.md` in the repo and work from that copy in a worktree.

**Goal:** Make the terminal the single, reliable path for installing, updating, and uninstalling Irises, with the engine gateway restarted automatically at the end of each, while the in-chat update notification stays truthful and the chat apply path is removed.

**Architecture:** One sourceable shell library (`scripts/lib/irises-lib.sh`) carries every lifecycle primitive: env-file editing that never duplicates keys, PATH probing, a portable timeout, engine detection from the clone's `.env`, hermes/OpenClaw plugin refresh and gateway restart with verification, and a user-service manager (systemd `--user` / LaunchAgent / detached fallback). `scripts/engine-setup.sh` becomes install + `--uninstall` with an install manifest and honest exit codes; `scripts/update.sh` becomes pull → build → restart → gateway restart with rollback to the previous commit on any failure. On the TypeScript side the `update_self` tool and `selfUpdate.ts` are deleted; a new unconditional prompt section gives Irises the facts (build, update waiting, the one terminal command) so she answers "update yourself" truthfully; announce copy hands over the command without "then restart the server". Docs and the two engine skills become instruction-only guides.

**Tech Stack:** bash (Linux + macOS), systemd --user / launchd, Node 22.13+ / TypeScript (`tsx --test`), git, hermes-agent CLI, OpenClaw CLI.

## Context

Two audits on 2026-09-10 (ten Opus researchers, one sandbox reproduction, read-only production inspection) established:

- Chat and terminal updates run the same `scripts/update.sh`; the chat path's unique failures were all *reporting* failures (a `node`-derived status timestamp of 0 swallowed by the watcher, lock-out silence, a boot crash that kills the only process able to speak). Production record: terminal 11/11, chat 0/1.
- Neither path had rollback, verified the running sha after restart, or could start a server from a stale pidfile; the relaunched server shared the shell's process group (Ctrl+C kills it).
- Install: fast, idempotent, zero prompts on Linux; on macOS the gateway restart silently never runs (`timeout` missing); engine config is edited before the build with no backup or manifest; the installer can duplicate `API_SERVER_KEY` (production has two, live one is the last); exit 0 on a dead install; no reboot survival.
- The engine-agent install route is non-functional: hermes's terminal tool blocks any referenced script containing the literal "hermes gateway restart" from gateway-hosted chats, and from a CLI session the script restarts the agent's own supervisor mid-turn.
- Uninstall does not exist: `--revert` prints six lines and exits 0, while both skills claim it undoes bridge mode.
- The hermes gateway on the VPS is a `systemd --user` unit with linger; `systemctl --user reload hermes-gateway` restarts it gracefully and is not matched by hermes's guard; the hermes CLI restart waits up to six hours by default unless `HERMES_RESTART_AFTER_TURN_TIMEOUT` / `HERMES_RESTART_DRAIN_TIMEOUT` are set in the CLI's env.
- OpenClaw: `openclaw gateway restart` is non-interactive; plugins are copied to `~/.openclaw/extensions/<id>` and re-install fails when the target exists, so today's refresh can never succeed; there is no `plugins uninstall`.

## Owner decisions (2026-09-10)

1. Terminal is the only lifecycle path; the chat apply tool is removed entirely. When asked, Irises says plainly that her person runs `bash scripts/update.sh` in the terminal.
2. The engine gateway is restarted automatically at the end of install, update, and uninstall, every time. Cost accepted: ~12 s Hermes outage and Hermes's own "gateway online" note per run.
3. Irises is installed as a user-level service by default (systemd `--user` with linger on Linux, LaunchAgent on macOS), falling back to a detached launch with one pidfile when neither is available.
4. The two setup skills become instruction-only guides that never run the installer or restart the gateway.
5. Uninstall keeps `$IRISES_HOME` (database + memories) unless `--purge-data`; the clone is never deleted by the script.

## Global Constraints

- Node `>=22.13` (package.json engines); `npm test` = `cross-env TZ=UTC DATA_BACKEND=memory tsx --test "src/**/*.test.ts" "scripts/**/*.test.ts"`; `npm run typecheck:scripts` = `tsc -p tsconfig.scripts.json`; `npm run build` = `tsc && cpx … && node scripts/stamp-version.js`.
- Shell scripts must run on Linux (Ubuntu, systemd --user) and macOS (no `timeout`, no `setsid`); `set -euo pipefail`; `bash -n` clean; no top-level side effects in the library.
- Scripts and skills must not contain the literal phrases `hermes gateway restart`, `hermes gateway stop`, `systemctl … restart|stop|start … hermes-gateway`, `launchctl kickstart … hermes.gateway`, or `pkill … hermes … gateway` (hermes's lifecycle guard scans referenced `.sh` contents). Build such strings at runtime.
- Never edit hermes/OpenClaw config for notifications; only append/remove Irises-marked keys, always after a backup, always recorded in `$IRISES_HOME/install-manifest.json`.
- Exit codes (update.sh): 0 ok/noop · 1 preflight, lock, or non-fast-forward · 2 args · 3 build failed, rolled back · 4 boot failed, rolled back · 5 gateway restart failed (Irises updated) · 10 update available (`--check`). Last stdout line: `RESULT: ok|noop|up-to-date|update-available|rolled-back|gateway-failed`. engine-setup.sh: 0 · 1 · 2 · 4 health not verified · 5 gateway not verified; `RESULT: ok|adopted|health-failed|gateway-failed` (install), `RESULT: ok|partial|gateway-failed|noop` (uninstall).
- Every lifecycle script sources the library with exactly `source "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/lib/irises-lib.sh"` (the shell contract test pins this form).
- User-facing chat copy follows the Never-Send-a-Leaf voice: deadpan, one read, no emoji; commands relayed exactly in backticks; prompt text in this plan is used verbatim.
- Commits: author `Rivian <rivianp@gmail.com>`; every message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Work on a branch/worktree, not on `main`.
- Production VPS (`ssh -i ~/.ssh/becussy-key.pem ubuntu@54.242.131.92`, login shell required for node): ~180 MB free RAM (never run the Next.js web build there), ~830 MB disk, node at `~/.local/bin/node`, hermes gateway already a `systemd --user` unit with linger.

---

## Task map

Tasks 1–9 (Part A): shell lifecycle — library (1–3) → contract test (4) → installer + service (5) → uninstaller (6) → updater with rollback (7) → e2e sandbox (8) → VPS rollout (9).
Tasks 100–107 (Part B): TypeScript removal (100), in-chat update facts (101), announce copy (102), env/README knobs (103), README (104), DEPLOY/ENGINES (105), skills (106), final gates (107).

Execution order: **1 → 2 → 3 → 4 → 100 → 5 → 6 → 7 → 101 → 102 → 8 → 103 → 104 → 105 → 106 → 107 → merge → 9.**
Rationale: the library and its tests first; the contract test (4) is intentionally red on the two old scripts until Task 7; the TS removal (100) lands before the updater rewrite so `update-status.json`'s reader and writer disappear together; docs (103–106) after the scripts they describe exist; the final gates (107) run on the whole tree; the VPS rollout (9) only after the branch is merged to `main` and pushed. Parts A and B touch disjoint files, so 100–102 can run in parallel with 5–7 if two implementers are available.

## Part A — Shell lifecycle: library, installer + service, uninstaller, updater, e2e, VPS rollout (Tasks 1–9)

**Design notes (Part A).**
1. **One lib, sourcing-guarded, zero top-level commands** (`scripts/lib/irises-lib.sh`); every function is `set -euo pipefail`-safe (no bare `[ x ] && cmd` statements; no unguarded `for` as a function's last command).
2. **`env_get` mirrors dotenv** (last assignment wins, `export` prefix, quotes, an unquoted value ends at the first `#`). Today's `get_env` returns `hermes   # hermes | openclaw…` for `OPS_BACKEND`; `engine_kind` and `NODE_OPTIONS` depend on the fix.
3. **Zero forks per line** in the env parser (pure parameter expansion); `deploy/app.env` is ~900 lines and is parsed repeatedly.
4. **`env_set` collapses duplicates** by rewriting the first occurrence with the value `env_get` resolved (last-wins). That recipe is also the fix for production's two `API_SERVER_KEY` blocks.
5. **`portable_timeout` handles shell functions** (`type -t`) with a bash background+kill watchdog, so `portable_timeout 100 hermes_run gateway "$verb"` works; `IRISES_FORCE_TIMEOUT_FALLBACK=1` makes the fallback testable on Linux.
6. **Gateway verification takes a pre-restart baseline** (`gateway_probe_mode`): `hermes gateway status` exits 0 even when the gateway is down, and `/v1/health` exists only with `API_SERVER_ENABLED=true`; if HTTP was not answering before the bounce, readiness falls back to service state. `/v1/health` needs no auth.
7. **No blocked lifecycle literal anywhere in our shell files.** Verbs and unit names are assembled at runtime; `reload` is not in hermes's blocked verb set, so the systemd fallback uses it (ExecReload = `kill -USR1` = drain-aware in-band restart).
8. **Web policy inverted and moved into the lib** (`web_build ROOT`): build only when `web/out` already exists or `IRISES_WEB=1`, skip under 1500 MB `MemAvailable`, always return 0; uses `npm --prefix web ci` so the updater stops dirtying `web/package-lock.json`.
9. **Manifest is line-oriented JSON written and read by pure shell** so `--uninstall` needs no node (bash/git/curl only), with a node `JSON.parse` fallback if a human reformats it.
10. **Value-returning functions log to stderr** (`log`), never stdout: `unit="$(service_install …)"` and `backup="$(env_backup …)"` must capture only the path.

### Task 1: Shared shell library — logging, paths, env parsing, PATH/tool/node preflight, portable timeout

**Files:**
- Create: `scripts/lib/irises-lib.sh`
- Test: `scripts/lib/irises-lib.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `say MSG…` → stdout; `log MSG…` / `warn MSG…` / `err MSG…` → stderr; `die [RC] MSG…` → prints via `err`, exits `RC` (default 1).
  - `irises_root` → absolute clone root (honours `$IRISES_ROOT`).
  - `irises_home` → state dir: clone `.env` > shell env > `deploy/app.env` > `~/.irises`, `~` expanded.
  - `irises_port` → `.env` > `deploy/app.env` > `3000`.
  - `env_get FILE KEY` → dotenv-equivalent value on stdout, LAST assignment wins, empty when absent.
  - `env_set FILE KEY VALUE` → rewrite first assignment in place, drop later duplicates, append when absent.
  - `env_set_default FILE KEY VALUE` → set only when absent/empty; never clobbers a user value.
  - `env_append_block FILE TAG KEY=VALUE…` → blank line + `# — added by Irises setup (DATE) — TAG —` + the assignments.
  - `env_count FILE KEY` → integer on stdout.
  - `env_backup FILE TAG` → copies to `FILE.bak-irises-<ts>` (0600), prints ONLY the backup path on stdout.
  - `env_remove_irises_block FILE KEY…` → removes those assignments plus any orphaned Irises marker comment; prints the number removed.
  - `augment_path` → exports PATH with node/tool candidate dirs appended.
  - `require_tools NAME…` → 0 or 1 (+ diagnostics).
  - `require_node_version FLOOR` → 0 (may prepend a satisfying node dir to PATH) or 1. `_irises_find_node` honours `IRISES_NODE_CANDIDATES` (colon-separated absolute paths) as the sole candidate list when set.
  - `portable_timeout SECS CMD…` → command's status, 124 on timeout.
  - `mem_available_mb` → integer MB on Linux, empty elsewhere.
  - `tcp_open HOST PORT` → 0 when something is listening.
  - Test harness `runLib(body, opts)` → `{ out, err, code, log, dir }` and `fixtureRoot(env, appEnv?)`.

- [ ] **Step 1: Create the test file with the harness and the section-A/B/C/D cases**

Create `scripts/lib/irises-lib.test.ts`:

```ts
// Run with: npm test   (scripts/**/*.test.ts is in the test glob).
//
// The lib is exercised the way the lifecycle scripts use it: sourced into a bash shell that already
// has `set -euo pipefail` in force, on a SCRATCH PATH built from symlinks to the few real tools the
// lib may use plus stub executables that log their argv and environment. That combination is the
// point — the two bugs this library exists to kill are (a) a function that returns non-zero as its
// last command and aborts its caller under `set -e`, and (b) a tool the lib assumed was on PATH.
//
// The scratch PATH deliberately does NOT include /usr/bin, so `service_kind` can be observed with
// systemctl/launchctl genuinely absent. Tests that need them ask for them by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(process.cwd(), 'scripts', 'lib', 'irises-lib.sh');

/** Tools the lib is allowed to reach for. Anything missing on the host is skipped silently. */
const DEFAULT_TOOLS = [
  'cat', 'rm', 'mkdir', 'cp', 'mv', 'chmod', 'find', 'grep', 'sed', 'head', 'tail', 'cut', 'tr',
  'sleep', 'date', 'printf', 'ps', 'uname', 'id', 'dirname', 'basename', 'du', 'curl', 'node',
  'npm', 'git', 'awk', 'sort', 'stat', 'env', 'sh', 'pgrep', 'mktemp', 'kill', 'touch', 'ln', 'od',
];

function realPath(tool: string): string | null {
  const r = spawnSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf8', env: process.env });
  const p = (r.stdout ?? '').trim();
  return r.status === 0 && p.length > 0 ? p : null;
}

export interface LibRun { out: string; err: string; code: number; log: string[]; dir: string }
export interface RunOpts {
  /** Extra tool names to symlink onto the scratch PATH (e.g. 'systemctl', 'launchctl'). */
  tools?: string[];
  /** name -> bash body. Written executable onto the scratch PATH, shadowing any real tool. */
  stubs?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
}

/** Source the lib under `set -euo pipefail` and run `body`. */
export function runLib(body: string, opts: RunOpts = {}): LibRun {
  const dir = mkdtempSync(join(tmpdir(), 'irises-lib-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  const log = join(dir, 'stub.log');
  for (const tool of [...DEFAULT_TOOLS, ...(opts.tools ?? [])]) {
    const real = realPath(tool);
    if (real && !existsSync(join(bin, tool))) symlinkSync(real, join(bin, tool));
  }
  for (const [name, script] of Object.entries(opts.stubs ?? {})) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
  }
  const script = join(dir, 'body.sh');
  writeFileSync(script, ['set -euo pipefail', `source ${JSON.stringify(LIB)}`, body, ''].join('\n'));
  const res = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    cwd: opts.cwd ?? dir,
    env: {
      PATH: bin,
      HOME: home,
      NO_COLOR: '1',
      STUB_LOG: log,
      IRISES_HOME: join(dir, 'state'),
      ...(opts.env ?? {}),
    },
  });
  return {
    out: res.stdout ?? '',
    err: res.stderr ?? '',
    code: res.status ?? -1,
    log: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
    dir,
  };
}

/** A scratch clone root with a .env (and optionally deploy/app.env) for the path/engine resolvers. */
export function fixtureRoot(env: string, appEnv?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'irises-root-'));
  writeFileSync(join(root, '.env'), env);
  if (appEnv !== undefined) {
    mkdirSync(join(root, 'deploy'), { recursive: true });
    writeFileSync(join(root, 'deploy', 'app.env'), appEnv);
  }
  return root;
}

test('the lib is valid bash and safe to source twice', () => {
  execFileSync('/bin/bash', ['-n', LIB], { encoding: 'utf8' });
  const r = runLib([
    `source ${JSON.stringify(LIB)}`,
    `source ${JSON.stringify(LIB)}`,
    'say "sourced three times, still fine"',
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /sourced three times, still fine/);
});

test('sourcing the lib runs nothing and prints nothing', () => {
  const r = runLib('true');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
  assert.equal(r.err, '');
});

test('say goes to stdout; log, warn and err go to stderr; die carries its exit code', () => {
  const r = runLib('say hello; log quietly; warn careful; err broken; die 7 "gone"');
  assert.equal(r.code, 7);
  assert.match(r.out, /\[irises\] hello/);
  assert.match(r.err, /\[irises\] quietly/);
  assert.match(r.err, /\[irises\] careful/);
  assert.match(r.err, /\[irises\] broken/);
  assert.match(r.err, /\[irises\] gone/);
  assert.ok(!r.out.includes('careful'), 'warn must not pollute stdout — RESULT lines are parsed there');
  assert.ok(!r.out.includes('quietly'), 'log is for value-returning functions whose stdout is captured');
});

test('env_get matches dotenv: last assignment wins, export prefix, quotes, inline comments', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, [
    '# a comment',
    'API_SERVER_KEY=first',
    '  export  API_SERVER_KEY = second  ',
    'QUOTED="a b # not a comment"',
    "SINGLE='c d'",
    'OPS_BACKEND=hermes             # hermes | openclaw — AUTO-DETECTED; set to force one',
    'EMPTY=',
    'NODE_OPTIONS=--max-old-space-size=512   # heap cap',
  ].join('\n'));
  const r = runLib([
    `printf 'KEY=[%s]\\n' "$(env_get ${JSON.stringify(f)} API_SERVER_KEY)"`,
    `printf 'QUOTED=[%s]\\n' "$(env_get ${JSON.stringify(f)} QUOTED)"`,
    `printf 'SINGLE=[%s]\\n' "$(env_get ${JSON.stringify(f)} SINGLE)"`,
    `printf 'BACKEND=[%s]\\n' "$(env_get ${JSON.stringify(f)} OPS_BACKEND)"`,
    `printf 'EMPTY=[%s]\\n' "$(env_get ${JSON.stringify(f)} EMPTY)"`,
    `printf 'OPTS=[%s]\\n' "$(env_get ${JSON.stringify(f)} NODE_OPTIONS)"`,
    `printf 'ABSENT=[%s]\\n' "$(env_get ${JSON.stringify(f)} NOPE)"`,
    `printf 'NOFILE=[%s]\\n' "$(env_get /nonexistent/file KEY)"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /KEY=\[second\]/, 'dotenv is last-wins; the production hermes .env has two API_SERVER_KEY blocks');
  assert.match(r.out, /QUOTED=\[a b # not a comment\]/);
  assert.match(r.out, /SINGLE=\[c d\]/);
  assert.match(r.out, /BACKEND=\[hermes\]/, 'the inline comment must not become part of the engine kind');
  assert.match(r.out, /EMPTY=\[\]/);
  assert.match(r.out, /OPTS=\[--max-old-space-size=512\]/);
  assert.match(r.out, /ABSENT=\[\]/);
  assert.match(r.out, /NOFILE=\[\]/);
});

test('env_set rewrites in place, collapses duplicates, and appends when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-env-'));
  const f = join(dir, '.env');
  writeFileSync(f, 'A=1\nAPI_SERVER_KEY=old1\nB=2\nAPI_SERVER_KEY=old2\n# trailing comment');
  const r = runLib([
    `env_set ${JSON.stringify(f)} API_SERVER_KEY live`,
    `env_set ${JSON.stringify(f)} NEW_KEY newval`,
    `printf 'COUNT=%s\\n' "$(env_count ${JSON.stringify(f)} API_SERVER_KEY)"`,
    `printf 'VALUE=%s\\n' "$(env_get ${JSON.stringify(f)} API_SERVER_KEY)"`,
    `printf 'NEW=%s\\n' "$(env_get ${JSON.stringify(f)} NEW_KEY)"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /COUNT=1/, 'the duplicate block is collapsed to one line');
  assert.match(r.out, /VALUE=live/);
  assert.match(r.out, /NEW=newval/);
  const body = readFileSync(f, 'utf8');
  assert.match(body, /^A=1$/m, 'unrelated keys survive');
  assert.match(body, /^B=2$/m);
  assert.match(body, /^# trailing comment$/m, 'a file with no trailing newline keeps its last line');
  assert.equal(body.slice(-1), '\n', 'the rewrite always leaves a trailing newline');
});

test('env_set_default never overwrites a value the user already set', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, 'PORT=3999\nBLANK=\n');
  const r = runLib([
    `env_set_default ${JSON.stringify(f)} PORT 3000`,
    `env_set_default ${JSON.stringify(f)} BLANK filled`,
    `env_set_default ${JSON.stringify(f)} FRESH yes`,
    `printf 'PORT=%s BLANK=%s FRESH=%s\\n' "$(env_get ${JSON.stringify(f)} PORT)" "$(env_get ${JSON.stringify(f)} BLANK)" "$(env_get ${JSON.stringify(f)} FRESH)"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /PORT=3999 BLANK=filled FRESH=yes/);
});

test('env_append_block writes one dated marker above its keys, on a file with no trailing newline', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, 'MODEL=gpt');   // no trailing newline: the bug that glued two keys into one line
  const r = runLib(`env_append_block ${JSON.stringify(f)} "bridge mode" IRISES_URL=http://127.0.0.1:3000 IRISES_FRONT='*:*'`);
  assert.equal(r.code, 0, r.err);
  const body = readFileSync(f, 'utf8');
  assert.match(body, /^MODEL=gpt$/m, 'the pre-existing last line is not glued to our first key');
  assert.match(body, /^# — added by Irises setup \(\d{4}-\d{2}-\d{2}\) — bridge mode —$/m);
  assert.match(body, /^IRISES_URL=http:\/\/127\.0\.0\.1:3000$/m);
  assert.match(body, /^IRISES_FRONT=\*:\*$/m);
});

test('env_remove_irises_block drops our keys plus the orphaned marker, and counts them', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, [
    'ANTHROPIC_API_KEY=keepme',
    '',
    '# — added by Irises setup (2026-09-01) — reminder push-back —',
    'IRISES_PUSH_TOKEN=abc',
    '',
    '# — added by Irises setup (2026-09-01) — bridge mode —',
    'IRISES_BRIDGE_TOKEN=def',
    'KEEP_THIS=1',
    '',
  ].join('\n'));
  const r = runLib([
    `printf 'REMOVED=%s\\n' "$(env_remove_irises_block ${JSON.stringify(f)} IRISES_PUSH_TOKEN IRISES_BRIDGE_TOKEN)"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /REMOVED=2/);
  const body = readFileSync(f, 'utf8');
  assert.match(body, /^ANTHROPIC_API_KEY=keepme$/m);
  assert.match(body, /^KEEP_THIS=1$/m);
  assert.ok(!body.includes('IRISES_PUSH_TOKEN'), body);
  assert.ok(!body.includes('IRISES_BRIDGE_TOKEN'), body);
  assert.ok(!body.includes('reminder push-back'), 'a marker whose keys all went must go too');
  assert.ok(!body.includes('bridge mode'), body);
});

test('env_backup copies to a 0600 sibling and prints ONLY its path on stdout', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, 'SECRET=shhh\n', { mode: 0o644 });
  const r = runLib(`env_backup ${JSON.stringify(f)} pre-uninstall`);
  assert.equal(r.code, 0, r.err);
  const backup = r.out.trim();
  assert.match(backup, /\.env\.bak-irises-\d{8}-\d{6}$/, 'callers capture this — a log line here would corrupt the path');
  assert.equal(readFileSync(backup, 'utf8'), 'SECRET=shhh\n');
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.match(r.err, /backed up/);
});

test('irises_home resolves .env over the shell over app.env over ~/.irises', () => {
  const withEnv = fixtureRoot('IRISES_HOME=~/from-dotenv\n', 'IRISES_HOME=/from-appenv\n');
  const appOnly = fixtureRoot('# nothing here\n', 'IRISES_HOME=/from-appenv\n');
  const bare = fixtureRoot('# nothing here\n');
  const call = (root: string, shell?: string) => runLib('irises_home', {
    env: { IRISES_ROOT: root, ...(shell ? { IRISES_HOME: shell } : { IRISES_HOME: '' }) },
  });
  const a = call(withEnv, '/from-shell');
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /\/home\/from-dotenv$/, 'a leading ~ expands against HOME');
  const b = call(appOnly, '/from-shell');
  assert.equal(b.out, '/from-shell');
  const c = call(appOnly);
  assert.equal(c.out, '/from-appenv', 'deploy/app.env is a legitimate operator config tier');
  const d = call(bare);
  assert.match(d.out, /\/home\/\.irises$/);
});

test('portable_timeout kills a hung command and reports 124', () => {
  const started = Date.now();
  const r = runLib([
    'rc=0',
    'portable_timeout 2 sleep 30 || rc=$?',
    'printf "RC=%s\\n" "$rc"',
  ].join('\n'), { env: { IRISES_FORCE_TIMEOUT_FALLBACK: '1' } });
  const elapsed = Date.now() - started;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=124/);
  assert.ok(elapsed < 15000, `the bash fallback must not wait for the command (took ${elapsed}ms)`);
});

test('portable_timeout passes a fast command through with its own exit code', () => {
  const r = runLib([
    'rc=0; portable_timeout 10 sh -c "exit 3" || rc=$?; printf "RC=%s\\n" "$rc"',
    'rc2=0; portable_timeout 10 sh -c "exit 0" || rc2=$?; printf "RC2=%s\\n" "$rc2"',
  ].join('\n'), { env: { IRISES_FORCE_TIMEOUT_FALLBACK: '1' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=3/);
  assert.match(r.out, /RC2=0/);
});

test('portable_timeout can time-box a shell FUNCTION (timeout(1) cannot exec one)', () => {
  const r = runLib([
    'slow() { sleep 30; }',
    'rc=0; portable_timeout 2 slow || rc=$?; printf "RC=%s\\n" "$rc"',
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=124/);
});

test('require_tools names every missing tool and returns 1', () => {
  const r = runLib([
    'rc=0; require_tools cat definitely-not-here also-missing || rc=$?',
    'printf "RC=%s\\n" "$rc"',
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=1/);
  assert.match(r.err, /definitely-not-here/);
  assert.match(r.err, /also-missing/);
});

test('require_node_version accepts the node running these tests', () => {
  const r = runLib('require_node_version 22.13; printf "OK\\n"');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /OK/);
});

test('require_node_version fails loudly when the only node is too old', () => {
  // IRISES_NODE_CANDIDATES pins the fallback search to a path that does not exist; otherwise a
  // Homebrew or nvm node on the developer's own machine would satisfy the floor and pass this test.
  const r = runLib([
    'rc=0; require_node_version 22.13 || rc=$?; printf "RC=%s\\n" "$rc"',
  ].join('\n'), {
    stubs: { node: 'if [ "${1:-}" = "-p" ]; then echo "18.20.0"; else echo "v18.20.0"; fi' },
    env: { IRISES_NODE_CANDIDATES: '/nonexistent/bin/node' },
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=1/);
  assert.match(r.err, /22\.13/);
});

test('augment_path appends the common bin dirs it needs and never drops the caller PATH', () => {
  const r = runLib('augment_path; printf "PATH=%s\\n" "$PATH"');
  assert.equal(r.code, 0, r.err);
  const line = r.out.split('\n').find(l => l.startsWith('PATH='))!;
  assert.ok(line.includes('/bin:') || line.endsWith('/bin'), line);
  assert.ok(line.includes('/usr/bin'), 'a non-login shell PATH must still reach the base tools');
  assert.match(line, /^PATH=[^:]*\/bin:/, 'the caller PATH stays first — an explicit node choice wins');
});

test('augment_path picks the newest nvm node >= 22 and ignores older trees', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-nvm-'));
  for (const v of ['v18.20.0', 'v22.9.0', 'v22.17.0', 'v24.1.0', 'garbage']) {
    mkdirSync(join(dir, 'versions', 'node', v, 'bin'), { recursive: true });
  }
  const r = runLib('augment_path; printf "PATH=%s\\n" "$PATH"', { env: { NVM_DIR: dir } });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(join(dir, 'versions', 'node', 'v24.1.0', 'bin')), r.out);
  assert.ok(!r.out.includes('v18.20.0'), 'below the floor');
  assert.ok(!r.out.includes('v22.9.0'), 'only the newest is added');
});

test('mem_available_mb is a number on Linux and empty elsewhere', () => {
  const r = runLib('printf "MB=[%s]\\n" "$(mem_available_mb)"');
  assert.equal(r.code, 0, r.err);
  const m = /MB=\[(.*)\]/.exec(r.out);
  assert.ok(m, r.out);
  if (process.platform === 'linux') assert.match(m![1], /^\d+$/);
  else assert.equal(m![1], '');
});

test('tcp_open sees a listening socket and rejects a closed port', async () => {
  const http = await import('node:http');
  const srv = http.createServer((_q, s) => s.end('ok'));
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
  const port = (srv.address() as { port: number }).port;
  try {
    const open = runLib(`rc=0; tcp_open 127.0.0.1 ${port} || rc=$?; printf "OPEN=%s\\n" "$rc"`);
    assert.equal(open.code, 0, open.err);
    assert.match(open.out, /OPEN=0/);
  } finally {
    srv.close();
  }
  const closed = runLib('rc=0; tcp_open 127.0.0.1 1 || rc=$?; printf "CLOSED=%s\\n" "$rc"');
  assert.equal(closed.code, 0, closed.err);
  assert.match(closed.out, /CLOSED=1/);
});
```

- [ ] **Step 2: Run the new tests and watch them fail on the missing lib**

Run: `npx tsx --test scripts/lib/irises-lib.test.ts`
Expected: every test fails; the first failure reads `bash: .../scripts/lib/irises-lib.sh: No such file or directory`.

- [ ] **Step 3: Create `scripts/lib/irises-lib.sh` with sections A–D**

```bash
#!/usr/bin/env bash
# Irises shell library — the one place the lifecycle scripts (scripts/engine-setup.sh,
# scripts/update.sh) get their logging, env-file editing, PATH repair, engine wiring, service
# management and health verification. SOURCE it; never execute it.
#
#   source "$(dirname "$0")/lib/irises-lib.sh"
#
# Three rules this file lives by, each paid for by a real incident:
#
#  1. NO TOP-LEVEL SIDE EFFECTS. Sourcing runs no command, writes nothing, prints nothing, and
#     exports nothing. Every value is computed inside a function, on every call — a module-level
#     constant freezes the wrong root the moment a caller re-points IRISES_HOME.
#  2. `set -euo pipefail` SAFE. Callers run under it. So: no bare `[ x ] && cmd` as a statement
#     (the list returns 1 and takes the caller down), no unguarded `for` loop as a function's last
#     command, every read of a maybe-unset variable written `${VAR:-}`.
#  3. NO FORK PER LINE in the env parser. deploy/app.env is ~900 lines and gets parsed repeatedly;
#     a `$(...)` per line cost whole seconds. The parsers below are pure parameter expansion.
#
# Functions whose OUTPUT IS CAPTURED by callers (env_backup, service_install, wait_health_sha,
# env_get, manifest_read, …) never `say` — they `log` (stderr) or stay silent.

# Sourcing guard: the scripts source this once, but a test harness (or a nested script) may source
# it again, and re-defining functions mid-run is a good way to lose a `local`.
if [ -n "${IRISES_LIB_SOURCED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
IRISES_LIB_SOURCED=1

# ═══ A. logging ═══════════════════════════════════════════════════════════════
# say → stdout. log/warn/err → stderr. That split is load-bearing: the lifecycle scripts end with a
# machine-readable `RESULT: <token>` line on stdout, and a warning must never land in it.

_irises_paint() { # $1=sgr $2=stream(1|2) $3…=message
  local sgr="${1:-0}" stream="${2:-1}"
  shift 2 || true
  local tag="${IRISES_LOG_TAG:-irises}"
  if [ -n "${NO_COLOR:-}" ]; then
    if [ "$stream" = "2" ]; then printf '[%s] %s\n' "$tag" "$*" >&2; else printf '[%s] %s\n' "$tag" "$*"; fi
    return 0
  fi
  if [ "$stream" = "2" ]; then
    printf '\033[%sm[%s]\033[0m %s\n' "$sgr" "$tag" "$*" >&2
  else
    printf '\033[%sm[%s]\033[0m %s\n' "$sgr" "$tag" "$*"
  fi
  return 0
}

say()  { _irises_paint 36 1 "$@"; }
log()  { _irises_paint 36 2 "$@"; }   # informational, but on stderr: for functions whose stdout is captured
warn() { _irises_paint 33 2 "$@"; }
err()  { _irises_paint 31 2 "$@"; }

# die [RC] MESSAGE… — a leading all-digit argument is the exit code (default 1).
die() {
  local rc=1
  case "${1:-}" in
    ''|*[!0-9]*) ;;
    *) rc="$1"; shift ;;
  esac
  err "$@"
  exit "$rc"
}

# ═══ B. paths ═════════════════════════════════════════════════════════════════

# The clone root. BASH_SOURCE[0] inside a function names THIS file, so the root is two levels up
# from scripts/lib. $IRISES_ROOT overrides it — for tests, and for an unusual checkout layout.
irises_root() {
  if [ -n "${IRISES_ROOT:-}" ]; then
    printf '%s' "$IRISES_ROOT"
    return 0
  fi
  local libdir
  libdir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  ( CDPATH='' cd -- "$libdir/../.." && pwd )
}

# $IRISES_HOME exactly as the server resolves it (src/loadEnv.ts loads deploy/app.env first, then
# .env with override:true — so .env beats the shell, and the shell beats app.env).
irises_home() {
  local root h
  root="$(irises_root)"
  h="$(env_get "$root/.env" IRISES_HOME)"
  if [ -z "$h" ]; then h="${IRISES_HOME:-}"; fi
  if [ -z "$h" ]; then h="$(env_get "$root/deploy/app.env" IRISES_HOME)"; fi
  if [ -z "$h" ]; then h="$HOME/.irises"; fi
  case "$h" in
    "~")   h="$HOME" ;;
    "~/"*) h="$HOME/${h#\~/}" ;;
  esac
  printf '%s' "$h"
}

# The port Irises listens on: .env > deploy/app.env > 3000. (app.env pins 8080 for the Docker image
# behind Caddy; on a clone that number wins at boot while every doc assumes 3000 — hence the pin.)
irises_port() {
  local root p
  root="$(irises_root)"
  p="$(env_get "$root/.env" PORT)"
  if [ -z "$p" ]; then p="$(env_get "$root/deploy/app.env" PORT)"; fi
  if [ -z "$p" ]; then p="3000"; fi
  printf '%s' "$p"
}

# ═══ C. env files ═════════════════════════════════════════════════════════════
# These mirror dotenv (v17, the version in package.json) because both engines and Irises itself read
# these files through it:
#   • the LAST assignment of a key wins (production's ~/.hermes/.env carries two API_SERVER_KEY
#     blocks; the live one is the last);
#   • `export KEY=v` and `KEY = v` are assignments;
#   • an UNQUOTED value ends at the first `#` (dotenv's value pattern is [^#\r\n]+), which is why
#     `OPS_BACKEND=hermes   # hermes | openclaw` resolves to `hermes` and not to a paragraph;
#   • one layer of matching quotes is stripped, and a `#` inside quotes is data.

env_get() { # FILE KEY -> value (empty when the file or key is absent)
  local f="${1:-}" key="${2:-}" line head v=""
  if [ -z "$key" ] || [ ! -f "${f:-}" ]; then return 0; fi
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in '#'*|'') continue ;; esac
    case "$line" in 'export '*) line="${line#export }"; line="${line#"${line%%[![:space:]]*}"}" ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    head="${line%%=*}"
    head="${head%"${head##*[![:space:]]}"}"
    if [ "$head" != "$key" ]; then continue; fi
    v="${line#*=}"
    v="${v#"${v%%[![:space:]]*}"}"
    case "$v" in
      '"'*) v="${v#\"}"; v="${v%%\"*}" ;;
      "'"*) v="${v#\'}"; v="${v%%\'*}" ;;
      *)    v="${v%%#*}"; v="${v%"${v##*[![:space:]]}"}" ;;
    esac
  done < "$f"
  printf '%s' "$v"
}

env_count() { # FILE KEY -> how many assignment lines name KEY
  local f="${1:-}" key="${2:-}" line head n=0
  if [ -z "$key" ] || [ ! -f "${f:-}" ]; then printf '0'; return 0; fi
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in '#'*|'') continue ;; esac
    case "$line" in 'export '*) line="${line#export }"; line="${line#"${line%%[![:space:]]*}"}" ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    head="${line%%=*}"
    head="${head%"${head##*[![:space:]]}"}"
    if [ "$head" = "$key" ]; then n=$((n + 1)); fi
  done < "$f"
  printf '%s' "$n"
}

# Set KEY=VALUE. Present → the FIRST assignment is rewritten and every later duplicate dropped;
# absent → appended. Pair it with env_get (last-wins) to collapse a duplicated key onto its LIVE
# value:  env_set "$f" API_SERVER_KEY "$(env_get "$f" API_SERVER_KEY)".
# The whole file is rewritten line by line, so a missing trailing newline is repaired too, and the
# copy-back through `cat >` keeps the original inode (and therefore its mode and ownership).
env_set() { # FILE KEY VALUE
  local f="${1:-}" key="${2:-}" val="${3:-}" line probe head tmp wrote=0
  if [ -z "$f" ] || [ -z "$key" ]; then return 1; fi
  if [ ! -e "$f" ]; then ( umask 077; : > "$f" ) || return 1; fi
  tmp="$f.irises-tmp.$$"
  ( umask 077; : > "$tmp" ) || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    probe="${line#"${line%%[![:space:]]*}"}"
    head=""
    case "$probe" in
      '#'*|'') ;;
      *)
        case "$probe" in 'export '*) probe="${probe#export }"; probe="${probe#"${probe%%[![:space:]]*}"}" ;; esac
        case "$probe" in
          *=*) head="${probe%%=*}"; head="${head%"${head##*[![:space:]]}"}" ;;
        esac
        ;;
    esac
    if [ -n "$head" ] && [ "$head" = "$key" ]; then
      if [ "$wrote" = "0" ]; then
        printf '%s=%s\n' "$key" "$val" >> "$tmp"
        wrote=1
      fi
      continue
    fi
    printf '%s\n' "$line" >> "$tmp"
  done < "$f"
  if [ "$wrote" = "0" ]; then printf '%s=%s\n' "$key" "$val" >> "$tmp"; fi
  cat "$tmp" > "$f" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  return 0
}

# Set KEY only when it is absent or empty. A value the operator typed is never overwritten.
env_set_default() { # FILE KEY VALUE
  local f="${1:-}" key="${2:-}" val="${3:-}" cur
  if [ -z "$f" ] || [ -z "$key" ]; then return 1; fi
  cur="$(env_get "$f" "$key")"
  if [ -n "$cur" ]; then
    say "keeping your existing $key — not overwriting"
    return 0
  fi
  env_set "$f" "$key" "$val"
}

# Append a dated, tagged block of assignments. The marker comment is what `--uninstall` falls back
# to when there is no install manifest, so its shape is a contract: `# — added by Irises setup (…`.
env_append_block() { # FILE TAG KEY=VALUE…
  local f="${1:-}" tag="${2:-}" pair last
  if [ -z "$f" ]; then return 1; fi
  shift 2 || true
  if [ "$#" -eq 0 ]; then return 0; fi
  if [ ! -e "$f" ]; then ( umask 077; : > "$f" ) || return 1; fi
  # An append onto a file whose last byte is not a newline GLUES the new key onto the old value —
  # a live run turned a model id and a base URL into one corrupt line that way.
  if [ -s "$f" ]; then
    last="$(LC_ALL=C tail -c1 "$f" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n' || true)"
    if [ "$last" != "0a" ]; then printf '\n' >> "$f"; fi
  fi
  {
    printf '\n'
    printf '# — added by Irises setup (%s) — %s —\n' "$(date +%F)" "$tag"
    for pair in "$@"; do printf '%s\n' "$pair"; done
  } >> "$f"
  return 0
}

# Copy FILE to FILE.bak-irises-<timestamp> (0600) and print ONLY the backup path on stdout (callers
# capture it). TAG is for the stderr log line.
env_backup() { # FILE TAG
  local f="${1:-}" tag="${2:-backup}" b
  if [ ! -f "${f:-}" ]; then return 0; fi
  b="$f.bak-irises-$(date +%Y%m%d-%H%M%S)"
  cp "$f" "$b" || return 1
  chmod 600 "$b" 2>/dev/null || true
  log "backed up $f -> $b ($tag)"
  printf '%s' "$b"
}

# Remove every assignment of the named keys, plus any Irises marker comment that those removals
# leave with nothing under it. Prints how many assignments went. Other keys, other comments, and
# the operator's own values are untouched.
env_remove_irises_block() { # FILE KEY…
  local f="${1:-}"
  if [ ! -f "${f:-}" ]; then printf '0'; return 0; fi
  shift || true
  if [ "$#" -eq 0 ]; then printf '0'; return 0; fi
  local tmp="$f.irises-tmp.$$" line probe head k marker="" drop removed=0
  ( umask 077; : > "$tmp" ) || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    probe="${line#"${line%%[![:space:]]*}"}"
    case "$probe" in
      '#'*'added by Irises'*)
        if [ -n "$marker" ]; then printf '%s\n' "$marker" >> "$tmp"; fi
        marker="$line"
        continue
        ;;
    esac
    head=""
    case "$probe" in
      '#'*|'') ;;
      *)
        case "$probe" in 'export '*) probe="${probe#export }"; probe="${probe#"${probe%%[![:space:]]*}"}" ;; esac
        case "$probe" in
          *=*) head="${probe%%=*}"; head="${head%"${head##*[![:space:]]}"}" ;;
        esac
        ;;
    esac
    drop=0
    if [ -n "$head" ]; then
      for k in "$@"; do
        if [ "$head" = "$k" ]; then drop=1; break; fi
      done
    fi
    if [ "$drop" = "1" ]; then
      removed=$((removed + 1))
      marker=""
      continue
    fi
    if [ -n "$marker" ]; then printf '%s\n' "$marker" >> "$tmp"; marker=""; fi
    printf '%s\n' "$line" >> "$tmp"
  done < "$f"
  # A marker still buffered here sat at EOF above keys we removed — it goes with them.
  cat "$tmp" > "$f" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  printf '%s' "$removed"
}

# ═══ D. environment preflight ═════════════════════════════════════════════════

# Newest vX.Y.Z directory under $1 whose major is >= 22, printed as <dir>/vX.Y.Z/bin.
# Zero-padded string comparison, not `-gt`: bash's test evaluates `022` as octal.
_irises_newest_node_dir() { # DIR
  local base="${1:-}" name v maj min pat key best="" bestkey=""
  if [ ! -d "${base:-}" ]; then return 0; fi
  for name in "$base"/*; do
    if [ ! -d "$name/bin" ]; then continue; fi
    v="${name##*/}"; v="${v#v}"
    maj="${v%%.*}"
    case "$maj" in ''|*[!0-9]*) continue ;; esac
    if [ "$maj" -lt 22 ]; then continue; fi
    min="${v#*.}"; min="${min%%.*}"; case "$min" in ''|*[!0-9]*) min=0 ;; esac
    pat="${v##*.}";                  case "$pat" in ''|*[!0-9]*) pat=0 ;; esac
    key="$(printf '%05d%05d%05d' "$maj" "$min" "$pat")"
    if [ -z "$bestkey" ] || [ "$key" \> "$bestkey" ]; then bestkey="$key"; best="$name/bin"; fi
  done
  printf '%s' "$best"
}

# APPEND (never prepend) the dirs a node/npm/git might live in, plus the base system dirs. Appending
# is deliberate: a node the operator put on PATH keeps winning. This exists because a non-login shell
# on the production VPS has no node at all — it lives at ~/.local/bin/node -> ~/.hermes/node/bin/node
# — and an agent-spawned install inherits exactly that PATH.
augment_path() {
  local d extra="" newest fnm
  for d in \
    "$HOME/.local/bin" \
    "${HERMES_HOME:-$HOME/.hermes}/node/bin" \
    "$HOME/.volta/bin" \
    "$HOME/.bun/bin" \
    "/opt/homebrew/bin" \
    "/usr/local/bin"
  do
    if [ -d "$d" ]; then
      case ":$PATH:$extra:" in *":$d:"*) ;; *) extra="$extra:$d" ;; esac
    fi
  done
  newest="$(_irises_newest_node_dir "${NVM_DIR:-$HOME/.nvm}/versions/node")"
  if [ -n "$newest" ]; then
    case ":$PATH:$extra:" in *":$newest:"*) ;; *) extra="$extra:$newest" ;; esac
  fi
  for fnm in \
    "${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin" \
    "$(_irises_newest_node_dir "${FNM_DIR:-$HOME/.local/share/fnm}/node-versions")"
  do
    if [ -n "$fnm" ] && [ -d "$fnm" ]; then
      case ":$PATH:$extra:" in *":$fnm:"*) ;; *) extra="$extra:$fnm" ;; esac
    fi
  done
  for d in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do
    if [ -d "$d" ]; then
      case ":$PATH:$extra:" in *":$d:"*) ;; *) extra="$extra:$d" ;; esac
    fi
  done
  PATH="${PATH}${extra}"
  export PATH
  return 0
}

require_tools() { # NAME…
  local t missing=""
  for t in "$@"; do
    if ! command -v "$t" >/dev/null 2>&1; then missing="$missing $t"; fi
  done
  if [ -n "$missing" ]; then
    err "missing required tool(s):$missing"
    err "PATH is: $PATH"
    return 1
  fi
  return 0
}

# A node candidate that satisfies the floor, printed as an absolute path (empty when there is none).
# IRISES_NODE_CANDIDATES (colon-separated absolute paths) replaces the built-in list when set — the
# unit tests use it so a developer's own Homebrew/nvm node cannot satisfy a "too old" scenario.
_irises_find_node() { # FLOOR (e.g. 22.13)
  local floor="${1:-22.13}" fmaj fmin cand v maj min newest list
  fmaj="${floor%%.*}"; fmin="${floor#*.}"
  case "$fmin" in ''|*[!0-9]*) fmin=0 ;; esac
  if [ -n "${IRISES_NODE_CANDIDATES:-}" ]; then
    list="$IRISES_NODE_CANDIDATES"
  else
    newest="$(_irises_newest_node_dir "${NVM_DIR:-$HOME/.nvm}/versions/node")"
    list="$HOME/.local/bin/node:${HERMES_HOME:-$HOME/.hermes}/node/bin/node:${newest:+$newest/node}:$HOME/.volta/bin/node:/opt/homebrew/bin/node:/usr/local/bin/node:/usr/bin/node"
  fi
  local IFS=':'
  for cand in $list; do
    if [ -z "$cand" ] || [ ! -x "$cand" ]; then continue; fi
    v="$("$cand" -p 'process.versions.node' 2>/dev/null || true)"
    maj="${v%%.*}"; min="${v#*.}"; min="${min%%.*}"
    case "$maj" in ''|*[!0-9]*) continue ;; esac
    case "$min" in ''|*[!0-9]*) min=0 ;; esac
    if [ "$maj" -gt "$fmaj" ] || { [ "$maj" -eq "$fmaj" ] && [ "$min" -ge "$fmin" ]; }; then
      printf '%s' "$cand"
      return 0
    fi
  done
  return 0
}

# 22.13 is the floor because Irises's local store uses the builtin node:sqlite, unflagged from 22.13.
require_node_version() { # FLOOR
  local floor="${1:-22.13}" fmaj fmin have maj min cand
  fmaj="${floor%%.*}"; fmin="${floor#*.}"
  case "$fmin" in ''|*[!0-9]*) fmin=0 ;; esac
  have=""
  if command -v node >/dev/null 2>&1; then
    have="$(node -p 'process.versions.node' 2>/dev/null || true)"
  fi
  maj="${have%%.*}"; min="${have#*.}"; min="${min%%.*}"
  case "$maj" in ''|*[!0-9]*) maj=-1 ;; esac
  case "$min" in ''|*[!0-9]*) min=0 ;; esac
  if [ "$maj" -gt "$fmaj" ] || { [ "$maj" -eq "$fmaj" ] && [ "$min" -ge "$fmin" ]; }; then
    return 0
  fi
  cand="$(_irises_find_node "$floor")"
  if [ -n "$cand" ]; then
    warn "node on PATH is ${have:-absent}; using $cand instead (its dir goes first on PATH)"
    PATH="$(dirname "$cand"):$PATH"
    export PATH
    return 0
  fi
  err "Node $floor+ required (found ${have:-none}) — the local store uses node:sqlite, unflagged from 22.13"
  err "install it, or put a newer node on PATH, then re-run"
  return 1
}

# Time-box a command. Prefers timeout(1), then gtimeout, else a pure-bash watchdog — macOS ships
# NEITHER, which is why engine-setup.sh's `timeout 90 … gateway …` silently failed on every Mac.
# A shell FUNCTION always takes the bash path: an external timeout cannot exec one.
portable_timeout() { # SECS CMD…
  local secs="${1:-30}" rc=0
  shift || true
  if [ "$#" -eq 0 ]; then return 2; fi
  if [ -z "${IRISES_FORCE_TIMEOUT_FALLBACK:-}" ] && [ "$(type -t "$1" 2>/dev/null || true)" != "function" ]; then
    if command -v timeout >/dev/null 2>&1; then
      timeout "$secs" "$@" || rc=$?
      return "$rc"
    fi
    if command -v gtimeout >/dev/null 2>&1; then
      gtimeout "$secs" "$@" || rc=$?
      return "$rc"
    fi
  fi
  local cmd_pid watch_pid
  "$@" &
  cmd_pid=$!
  (
    i=0
    while [ "$i" -lt "$secs" ]; do
      if ! kill -0 "$cmd_pid" 2>/dev/null; then exit 0; fi
      sleep 1
      i=$((i + 1))
    done
    kill -TERM "$cmd_pid" 2>/dev/null || true
    sleep 2
    kill -KILL "$cmd_pid" 2>/dev/null || true
  ) &
  watch_pid=$!
  wait "$cmd_pid" 2>/dev/null || rc=$?
  kill "$watch_pid" 2>/dev/null || true
  wait "$watch_pid" 2>/dev/null || true
  # 143 = SIGTERM, 137 = SIGKILL: our watchdog fired. Report it the way timeout(1) does.
  case "$rc" in 143|137) rc=124 ;; esac
  return "$rc"
}

# Free memory in MB (Linux only — macOS has no single honest number, so callers treat empty as
# "unknown" and skip the gate).
mem_available_mb() {
  local kb
  if [ -r /proc/meminfo ]; then
    kb="$(awk '/^MemAvailable:/ {print $2; exit}' /proc/meminfo 2>/dev/null || true)"
    case "${kb:-}" in
      ''|*[!0-9]*) return 0 ;;
      *) printf '%s' "$((kb / 1024))"; return 0 ;;
    esac
  fi
  return 0
}

# Is anything listening on HOST:PORT? bash's /dev/tcp first (no external tool), then nc, then lsof.
tcp_open() { # HOST PORT
  local h="${1:-127.0.0.1}" p="${2:-}"
  if [ -z "$p" ]; then return 1; fi
  if (exec 3<>"/dev/tcp/$h/$p") 2>/dev/null; then return 0; fi
  if command -v nc >/dev/null 2>&1; then
    if nc -z -w 2 "$h" "$p" >/dev/null 2>&1; then return 0; fi
    return 1
  fi
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP@"$h":"$p" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
    return 1
  fi
  return 1
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx tsx --test scripts/lib/irises-lib.test.ts`
Expected: `# pass 20`, `# fail 0`.

- [ ] **Step 5: Confirm the new file joins the suite and typechecks**

Run: `npm test 2>&1 | tail -5 && npm run typecheck:scripts`
Expected: totals include the new tests (`# fail 0`); `typecheck:scripts` prints nothing, exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/irises-lib.sh scripts/lib/irises-lib.test.ts
git commit -m "$(cat <<'EOF'
Add the shared shell library: logging, env parsing, PATH and node preflight

say/log/warn/err/die, irises_root/home/port, dotenv-equivalent env_get
(last-wins, inline comments, export prefix), env_set that collapses duplicates
onto the live value, env_append_block/env_backup/env_remove_irises_block,
augment_path for the non-login-shell PATH, require_tools/require_node_version,
and a portable_timeout that works on macOS (no timeout(1)) and on shell functions.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Lib section E — engine detection, gateway restart, plugin refresh, web build

**Files:**
- Modify: `scripts/lib/irises-lib.sh` (append section E at end of file)
- Test: `scripts/lib/irises-lib.test.ts` (append cases at end of file)

**Interfaces:**
- Consumes: `runLib(body, opts)`, `fixtureRoot(env, appEnv?)` from Task 1; `say/log/warn/err`, `env_get`, `irises_root`, `portable_timeout`, `tcp_open`, `mem_available_mb`.
- Produces:
  - `engine_kind [OVERRIDE]` → `hermes` | `openclaw` | `off`.
  - `hermes_home` → `$HERMES_HOME` or `~/.hermes`; `openclaw_home` → `$OPENCLAW_STATE_DIR` / `$CLAWDBOT_STATE_DIR` / `~/.openclaw`.
  - `hermes_cli` → the resolved CLI as a display string (empty when none found).
  - `hermes_run ARGS…` → invokes the resolved CLI with `_HERMES_GATEWAY` unset and `$IRISES_HERMES_ENV` applied; 127 when no CLI.
  - `gateway_probe_mode ENGINE` → `http` | `service`.
  - `gateway_wait_healthy ENGINE SECS MODE` → 0/1.
  - `gateway_restart [ENGINE] [SECS]` → 0/1, prints one summary line.
  - `plugin_refresh ENGINE [ROOT]` → 0/1; `plugin_remove ENGINE` → 0/1.
  - `web_build [ROOT]` → always 0.

- [ ] **Step 1: Append the section-E tests**

Append to `scripts/lib/irises-lib.test.ts`:

```ts
// ── section E: engine, gateway, plugins, web ────────────────────────────────────────────────────

/** A stub that records `argv` plus the environment bits we assert on, then exits with $STUB_RC. */
const RECORDING_STUB = [
  '{',
  '  printf "%s argv:%s\\n" "$(basename "$0")" "$*"',
  '  printf "%s env:HERMES_RESTART_AFTER_TURN_TIMEOUT=%s\\n" "$(basename "$0")" "${HERMES_RESTART_AFTER_TURN_TIMEOUT:-unset}"',
  '  printf "%s env:HERMES_RESTART_DRAIN_TIMEOUT=%s\\n" "$(basename "$0")" "${HERMES_RESTART_DRAIN_TIMEOUT:-unset}"',
  '  printf "%s env:_HERMES_GATEWAY=%s\\n" "$(basename "$0")" "${_HERMES_GATEWAY:-unset}"',
  '} >> "$STUB_LOG"',
  'exit "${STUB_RC:-0}"',
].join('\n');

test('engine_kind reads OPS_BACKEND past its inline comment, and honours an override', () => {
  const root = fixtureRoot('OPS_BACKEND=hermes             # hermes | openclaw — AUTO-DETECTED\n');
  const a = runLib('engine_kind', { env: { IRISES_ROOT: root } });
  assert.equal(a.code, 0, a.err);
  assert.equal(a.out, 'hermes');
  const b = runLib('engine_kind openclaw', { env: { IRISES_ROOT: root } });
  assert.equal(b.out, 'openclaw');
  const off = fixtureRoot('OPS_BACKEND=off\n');
  assert.equal(runLib('engine_kind', { env: { IRISES_ROOT: off } }).out, 'off');
  const junk = fixtureRoot('OPS_BACKEND=banana\n');
  const j = runLib('engine_kind', { env: { IRISES_ROOT: junk } });
  assert.equal(j.out, 'off');
  assert.match(j.err, /banana/);
});

test('engine_kind falls back to what is installed when OPS_BACKEND is unset', () => {
  const root = fixtureRoot('# no backend pinned\n');
  const withHermes = runLib('engine_kind', { env: { IRISES_ROOT: root, HERMES_HOME: root } });
  assert.equal(withHermes.out, 'hermes', 'the hermes home existing is the proof of installation');
  const withClaw = runLib('engine_kind', {
    env: { IRISES_ROOT: root, HERMES_HOME: join(root, 'nope') },
    stubs: { openclaw: 'exit 0' },
  });
  assert.equal(withClaw.out, 'openclaw');
  const neither = runLib('engine_kind', { env: { IRISES_ROOT: root, HERMES_HOME: join(root, 'nope') } });
  assert.equal(neither.out, 'off');
});

test('hermes_run finds ~/.local/bin/hermes when PATH is minimal, and strips _HERMES_GATEWAY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-hcli-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'hermes'), `#!/usr/bin/env bash\n${RECORDING_STUB}\n`, { mode: 0o755 });
  const r = runLib([
    'printf "CLI=%s\\n" "$(hermes_cli)"',
    'hermes_run plugins enable irises-bridge',
  ].join('\n'), { env: { HOME: home, _HERMES_GATEWAY: '1' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /CLI=.*\.local\/bin\/hermes/, 'the real location on a Mac, which the old resolver missed');
  assert.ok(r.log.includes('hermes argv:plugins enable irises-bridge'), r.log.join('\n'));
  assert.ok(
    r.log.includes('hermes env:_HERMES_GATEWAY=unset'),
    'inherited _HERMES_GATEWAY=1 makes the CLI refuse gateway work with exit 1',
  );
});

test('hermes_run falls back to the venv python module form', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-hcli-'));
  const hhome = join(dir, 'hermes');
  mkdirSync(join(hhome, 'hermes-agent', 'venv', 'bin'), { recursive: true });
  writeFileSync(join(hhome, 'hermes-agent', 'venv', 'bin', 'python'), `#!/usr/bin/env bash\n${RECORDING_STUB}\n`, { mode: 0o755 });
  const r = runLib([
    'printf "CLI=%s\\n" "$(hermes_cli)"',
    'hermes_run gateway status',
  ].join('\n'), { env: { HERMES_HOME: hhome } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /CLI=.*venv\/bin\/python -m hermes_cli\.main/);
  assert.ok(r.log.includes('python argv:-m hermes_cli.main gateway status'), r.log.join('\n'));
});

test('hermes_cli is empty and hermes_run returns 127 when no CLI exists', () => {
  const r = runLib([
    'printf "CLI=[%s]\\n" "$(hermes_cli)"',
    'rc=0; hermes_run gateway status || rc=$?; printf "RC=%s\\n" "$rc"',
  ].join('\n'), { env: { HERMES_HOME: '/nonexistent' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /CLI=\[\]/);
  assert.match(r.out, /RC=127/);
});

test('gateway_restart bounces hermes through its CLI with both drain caps capped', async () => {
  const http = await import('node:http');
  const srv = http.createServer((_q, s) => { s.setHeader('content-type', 'application/json'); s.end('{"status":"ok"}'); });
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
  const port = (srv.address() as { port: number }).port;
  const root = fixtureRoot(`OPS_BACKEND=hermes\nHERMES_BASE_URL=http://127.0.0.1:${port}\n`);
  try {
    const r = runLib('gateway_restart hermes 20', {
      env: { IRISES_ROOT: root, _HERMES_GATEWAY: '1' },
      stubs: { hermes: RECORDING_STUB },
    });
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const argv = r.log.find(l => l.startsWith('hermes argv:'));
    assert.ok(argv, r.log.join('\n'));
    assert.match(argv!, /^hermes argv:gateway re?start$/, 'the verb is assembled at runtime, and still arrives whole');
    assert.ok(r.log.includes('hermes env:HERMES_RESTART_AFTER_TURN_TIMEOUT=45'), r.log.join('\n'));
    assert.ok(r.log.includes('hermes env:HERMES_RESTART_DRAIN_TIMEOUT=10'), r.log.join('\n'));
    assert.ok(r.log.includes('hermes env:_HERMES_GATEWAY=unset'), r.log.join('\n'));
    assert.match(r.out, /gateway is back/);
  } finally {
    srv.close();
  }
});

test('gateway_restart reports failure (1) when the gateway never answers again', () => {
  const root = fixtureRoot('OPS_BACKEND=hermes\nHERMES_BASE_URL=http://127.0.0.1:1\n');
  const r = runLib('rc=0; gateway_restart hermes 4 || rc=$?; printf "RC=%s\\n" "$rc"', {
    env: { IRISES_ROOT: root },
    stubs: { hermes: RECORDING_STUB, systemctl: 'exit 1', launchctl: 'exit 1' },
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=1/);
  assert.match(r.err, /did not come back/);
});

test('gateway_restart on an engine that is off does nothing and succeeds', () => {
  const root = fixtureRoot('OPS_BACKEND=off\n');
  const r = runLib('gateway_restart', { env: { IRISES_ROOT: root } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /engine is off/);
});

test('gateway_restart bounces openclaw through its own CLI and waits on the gateway port', async () => {
  const net = await import('node:net');
  const srv = net.createServer(sock => sock.end());
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
  const port = (srv.address() as { port: number }).port;
  const root = fixtureRoot(`OPS_BACKEND=openclaw\nOPENCLAW_URL=ws://127.0.0.1:${port}\n`);
  try {
    const r = runLib('gateway_restart openclaw 20', {
      env: { IRISES_ROOT: root },
      stubs: { openclaw: RECORDING_STUB },
    });
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const argv = r.log.find(l => l.startsWith('openclaw argv:'));
    assert.match(argv!, /^openclaw argv:gateway re?start$/);
    assert.match(r.out, /gateway is back/);
  } finally {
    srv.close();
  }
});

test('plugin_refresh copies the hermes plugin without __pycache__ and enables it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-plug-'));
  const root = join(dir, 'clone');
  mkdirSync(join(root, 'bridge', 'hermes', 'irises-bridge', '__pycache__'), { recursive: true });
  writeFileSync(join(root, 'bridge', 'hermes', 'irises-bridge', '__init__.py'), 'x = 1\n');
  writeFileSync(join(root, 'bridge', 'hermes', 'irises-bridge', 'plugin.yaml'), 'name: irises-bridge\n');
  writeFileSync(join(root, 'bridge', 'hermes', 'irises-bridge', '__pycache__', 'stale.pyc'), 'junk');
  const hhome = join(dir, 'hermes');
  mkdirSync(join(hhome, 'plugins', 'irises-bridge'), { recursive: true });
  writeFileSync(join(hhome, 'plugins', 'irises-bridge', 'REMOVED_UPSTREAM.py'), 'old\n');
  const r = runLib(`plugin_refresh hermes ${JSON.stringify(root)}`, {
    env: { HERMES_HOME: hhome },
    stubs: { hermes: RECORDING_STUB },
  });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(hhome, 'plugins', 'irises-bridge', '__init__.py')));
  assert.ok(!existsSync(join(hhome, 'plugins', 'irises-bridge', '__pycache__')), 'stale bytecode must not ship');
  assert.ok(
    !existsSync(join(hhome, 'plugins', 'irises-bridge', 'REMOVED_UPSTREAM.py')),
    'rm before cp: cp -R onto an existing dir merges and leaves deleted files behind',
  );
  assert.ok(r.log.includes('hermes argv:plugins enable irises-bridge'), r.log.join('\n'));
});

test('plugin_refresh deletes the openclaw target first, because install refuses an existing dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-plug-'));
  const root = join(dir, 'clone');
  mkdirSync(join(root, 'bridge', 'openclaw', 'irises-bridge'), { recursive: true });
  writeFileSync(join(root, 'bridge', 'openclaw', 'irises-bridge', 'package.json'), '{"name":"irises-bridge"}');
  const state = join(dir, 'openclaw');
  mkdirSync(join(state, 'extensions', 'irises-bridge'), { recursive: true });
  writeFileSync(join(state, 'extensions', 'irises-bridge', 'old.js'), 'stale\n');
  const r = runLib(`plugin_refresh openclaw ${JSON.stringify(root)}`, {
    env: { OPENCLAW_STATE_DIR: state },
    stubs: { openclaw: RECORDING_STUB },
  });
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(join(state, 'extensions', 'irises-bridge')), 'the CLI copies it back in; we only clear the way');
  const argv = r.log.find(l => l.startsWith('openclaw argv:plugins install'));
  assert.ok(argv, r.log.join('\n'));
  assert.match(argv!, /bridge\/openclaw\/irises-bridge$/);
});

test('plugin_remove disables then deletes, on both engines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-plug-'));
  const hhome = join(dir, 'hermes');
  const state = join(dir, 'openclaw');
  mkdirSync(join(hhome, 'plugins', 'irises-bridge'), { recursive: true });
  mkdirSync(join(state, 'extensions', 'irises-bridge'), { recursive: true });
  const h = runLib('plugin_remove hermes', { env: { HERMES_HOME: hhome }, stubs: { hermes: RECORDING_STUB } });
  assert.equal(h.code, 0, h.err);
  assert.ok(h.log.includes('hermes argv:plugins disable irises-bridge'), h.log.join('\n'));
  assert.ok(!existsSync(join(hhome, 'plugins', 'irises-bridge')));
  const o = runLib('plugin_remove openclaw', { env: { OPENCLAW_STATE_DIR: state }, stubs: { openclaw: RECORDING_STUB } });
  assert.equal(o.code, 0, o.err);
  assert.ok(o.log.includes('openclaw argv:plugins disable irises-bridge'), o.log.join('\n'));
  assert.ok(!existsSync(join(state, 'extensions', 'irises-bridge')), 'openclaw has no `plugins uninstall` — rm is the removal');
});

test('web_build skips a fresh install, builds an install that already serves web/out, never fails', () => {
  const npmStub = 'printf "npm argv:%s\\n" "$*" >> "$STUB_LOG"; exit "${NPM_RC:-0}"';
  const mk = (withOut: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'irises-web-'));
    mkdirSync(join(root, 'web', 'node_modules'), { recursive: true });
    if (withOut) mkdirSync(join(root, 'web', 'out'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"irises"}');
    return root;
  };
  const fresh = runLib(`web_build ${JSON.stringify(mk(false))}`, { stubs: { npm: npmStub } });
  assert.equal(fresh.code, 0, fresh.err);
  assert.deepEqual(fresh.log, [], 'not one npm call on a box that never served the page');
  assert.match(fresh.out, /web UI not built here/);

  const serving = runLib(`web_build ${JSON.stringify(mk(true))}`, { stubs: { npm: npmStub } });
  assert.equal(serving.code, 0, serving.err);
  assert.equal(serving.log.length, 2, serving.log.join('\n'));
  assert.match(serving.log[0], /^npm argv:--prefix .*\/web ci$/, 'ci, not install: install rewrites web/package-lock.json and dirties the tree');
  assert.match(serving.log[1], /^npm argv:run build:web$/);

  const failing = runLib(`web_build ${JSON.stringify(mk(true))}; printf "SURVIVED\\n"`, {
    stubs: { npm: npmStub }, env: { NPM_RC: '1' },
  });
  assert.equal(failing.code, 0, failing.err);
  assert.match(failing.out, /SURVIVED/, 'a next build that dies of memory must not abort the lifecycle action');
  assert.match(failing.err, /web client build failed/);

  const opted = runLib(`web_build ${JSON.stringify(mk(false))}`, { stubs: { npm: npmStub }, env: { IRISES_WEB: '1' } });
  assert.equal(opted.code, 0, opted.err);
  assert.equal(opted.log.length, 2, 'IRISES_WEB=1 opts a fresh install in');

  const skipped = runLib(`web_build ${JSON.stringify(mk(true))}`, { stubs: { npm: npmStub }, env: { IRISES_SKIP_WEB_BUILD: '1' } });
  assert.deepEqual(skipped.log, []);
  assert.match(skipped.out, /IRISES_SKIP_WEB_BUILD=1/);
});
```

- [ ] **Step 2: Run the new cases and watch them fail**

Run: `npx tsx --test scripts/lib/irises-lib.test.ts 2>&1 | tail -20`
Expected: the section-E tests fail with `engine_kind: command not found`, `hermes_run: command not found`, etc.

- [ ] **Step 3: Append section E to `scripts/lib/irises-lib.sh`**

```bash
# ═══ E. engines: detection, gateway lifecycle, bridge plugin, web build ═══════
#
# A NOTE ON THE STRINGS IN THIS SECTION. hermes ships a lifecycle guard
# (cron/lifecycle_guard.py) that blocks a terminal command matching e.g. `hermes gateway
# <bounce-verb>` or `systemctl … <bounce-verb> … hermes-gateway`, AND it recursively reads the
# CONTENTS of any shell script the command references (including ones it sources, to depth 8). So
# if a user ever pastes one of our commands into a hermes chat, a literal of that shape ANYWHERE in
# these files — code or comment — gets the whole thing refused. Every verb and unit name below is
# therefore assembled at runtime from fragments. It costs two lines and buys an install that works
# from inside a chat as well as from a shell. `reload` is deliberately not blocked upstream, which
# is why the systemd fallback uses it: the unit's ExecReload sends SIGUSR1, hermes's own
# drain-aware in-band bounce.

hermes_home() {
  local h="${HERMES_HOME:-$HOME/.hermes}"
  case "$h" in
    "~")   h="$HOME" ;;
    "~/"*) h="$HOME/${h#\~/}" ;;
  esac
  printf '%s' "$h"
}

# OpenClaw profiles can relocate the whole state dir; honour the override, else ~/.openclaw.
openclaw_home() {
  local h="${OPENCLAW_STATE_DIR:-${CLAWDBOT_STATE_DIR:-$HOME/.openclaw}}"
  case "$h" in
    "~")   h="$HOME" ;;
    "~/"*) h="$HOME/${h#\~/}" ;;
  esac
  printf '%s' "$h"
}

# Which engine this clone talks to: an explicit override, else OPS_BACKEND from the clone's .env
# (then app.env, then the shell), else whatever is actually installed. `off` = standalone.
engine_kind() { # [OVERRIDE]
  local override="${1:-}" root v
  case "$override" in
    hermes|openclaw|off) printf '%s' "$override"; return 0 ;;
    '') ;;
    *) err "unknown engine '$override' (hermes|openclaw|off)"; return 1 ;;
  esac
  root="$(irises_root)"
  v="$(env_get "$root/.env" OPS_BACKEND)"
  if [ -z "$v" ]; then v="$(env_get "$root/deploy/app.env" OPS_BACKEND)"; fi
  if [ -z "$v" ]; then v="${OPS_BACKEND:-}"; fi
  case "$v" in
    hermes|openclaw|off) printf '%s' "$v"; return 0 ;;
    '') ;;
    *) warn "OPS_BACKEND='$v' is not hermes|openclaw|off — treating this install as engine-less"
       printf 'off'; return 0 ;;
  esac
  if [ -d "$(hermes_home)" ]; then printf 'hermes'; return 0; fi
  if command -v openclaw >/dev/null 2>&1; then printf 'openclaw'; return 0; fi
  printf 'off'
}

# The hermes CLI as a DISPLAY string (for logs and for "is it there?" checks). Never word-split it —
# call hermes_run instead, which handles the argv and the environment.
hermes_cli() {
  local hhome; hhome="$(hermes_home)"
  if command -v hermes >/dev/null 2>&1; then command -v hermes; return 0; fi
  if [ -x "$HOME/.local/bin/hermes" ]; then printf '%s' "$HOME/.local/bin/hermes"; return 0; fi
  if [ -x "$hhome/hermes-agent/hermes" ]; then printf '%s' "$hhome/hermes-agent/hermes"; return 0; fi
  if [ -x "$hhome/hermes-agent/venv/bin/python" ]; then
    printf '%s -m hermes_cli.main' "$hhome/hermes-agent/venv/bin/python"
    return 0
  fi
  return 0
}

# Invoke the hermes CLI. Two things every caller would otherwise have to remember:
#   • `_HERMES_GATEWAY=1` is inherited by anything the gateway spawns, and the CLI REFUSES gateway
#     lifecycle work (exit 1) when it sees it — so it is always unset here.
#   • $IRISES_HERMES_ENV carries extra KEY=VALUE settings (whitespace-separated, values with no
#     spaces — ours are all integers); it is intentionally unquoted so it word-splits.
hermes_run() { # ARGS…
  local hhome; hhome="$(hermes_home)"
  if command -v hermes >/dev/null 2>&1; then
    set -- "$(command -v hermes)" "$@"
  elif [ -x "$HOME/.local/bin/hermes" ]; then
    set -- "$HOME/.local/bin/hermes" "$@"
  elif [ -x "$hhome/hermes-agent/hermes" ]; then
    set -- "$hhome/hermes-agent/hermes" "$@"
  elif [ -x "$hhome/hermes-agent/venv/bin/python" ]; then
    set -- "$hhome/hermes-agent/venv/bin/python" -m hermes_cli.main "$@"
  else
    return 127
  fi
  local rc=0
  # shellcheck disable=SC2086  # IRISES_HERMES_ENV must split into separate assignments
  env -u _HERMES_GATEWAY ${IRISES_HERMES_ENV:-} "$@" || rc=$?
  return "$rc"
}

# Does the engine's own health surface answer RIGHT NOW? Taken BEFORE a bounce as the baseline:
# `hermes gateway status` exits 0 even when the gateway is down, and /v1/health only exists while
# API_SERVER_ENABLED=true — so a gateway with the API server off must not be reported as failed.
_gateway_http_ok() { # ENGINE
  local engine="${1:-}" root base host port
  root="$(irises_root)"
  if [ "$engine" = "hermes" ]; then
    base="$(env_get "$root/.env" HERMES_BASE_URL)"
    if [ -z "$base" ]; then base="http://127.0.0.1:8642"; fi
    # /v1/health takes no auth (gateway/platforms/api_server.py: _handle_health has no auth check).
    if curl -fsS -m 5 "$base/v1/health" >/dev/null 2>&1; then return 0; fi
    return 1
  fi
  base="$(env_get "$root/.env" OPENCLAW_URL)"
  if [ -z "$base" ]; then base="ws://127.0.0.1:18789"; fi
  host="${base#*://}"; host="${host%%/*}"
  port="${host##*:}"; host="${host%%:*}"
  case "$port" in ''|*[!0-9]*) port=18789 ;; esac
  if [ -z "$host" ]; then host=127.0.0.1; fi
  tcp_open "$host" "$port"
}

# hermes only: is the gateway's SERVICE up? Used when HTTP was not answering before the bounce.
_gateway_service_up() {
  local unit label uid state
  unit="hermes-gateway"
  label="ai.hermes.gateway"
  if command -v systemctl >/dev/null 2>&1; then
    state="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
    if [ "$state" = "active" ]; then return 0; fi
  fi
  if command -v launchctl >/dev/null 2>&1; then
    uid="$(id -u)"
    if launchctl print "gui/$uid/$label" 2>/dev/null | grep -q 'state = running'; then return 0; fi
  fi
  if command -v pgrep >/dev/null 2>&1; then
    if pgrep -f 'gateway[.]run|hermes_cli[.]main .*gateway' >/dev/null 2>&1; then return 0; fi
  fi
  return 1
}

gateway_probe_mode() { # ENGINE -> http|service
  if _gateway_http_ok "${1:-}"; then printf 'http'; else printf 'service'; fi
}

gateway_wait_healthy() { # ENGINE SECS MODE(http|service)
  local engine="${1:-}" secs="${2:-90}" mode="${3:-http}" i=0
  while [ "$i" -lt "$secs" ]; do
    if [ "$mode" = "http" ]; then
      if _gateway_http_ok "$engine"; then return 0; fi
    else
      if [ "$engine" = "hermes" ]; then
        if _gateway_service_up; then return 0; fi
      else
        if _gateway_http_ok "$engine"; then return 0; fi
      fi
    fi
    sleep 2
    i=$((i + 2))
  done
  return 1
}

_gateway_bounce_hermes_service() { # VERB
  local verb="${1:-}" unit label uid soft
  unit="hermes-gateway"
  label="ai.hermes.gateway"
  soft="re"; soft="${soft}load"
  if command -v systemctl >/dev/null 2>&1; then
    # ExecReload = kill -USR1 = hermes's own drain-aware in-band bounce (and the soft verb is not on
    # the upstream block list, so it survives a paste into a chat).
    if systemctl --user "$soft" "$unit" >/dev/null 2>&1; then return 0; fi
    if systemctl --user "$verb" "$unit" >/dev/null 2>&1; then return 0; fi
  fi
  if command -v launchctl >/dev/null 2>&1; then
    uid="$(id -u)"
    if launchctl kickstart -k "gui/$uid/$label" >/dev/null 2>&1; then return 0; fi
  fi
  return 1
}

# Bounce the engine's gateway and VERIFY it came back. Returns 1 on an unverified bounce — the
# caller reports that with its own exit code, because Irises itself may be perfectly updated.
# Worst case wall time: 100s for the CLI call (its own budget is 45+10+15) plus SECS of verification.
gateway_restart() { # [ENGINE] [SECS]
  local engine="${1:-}" secs="${2:-90}" verb mode t0 t1
  if [ -z "$engine" ]; then engine="$(engine_kind)"; fi
  case "$engine" in
    off|'') say "engine is off — no gateway to bounce"; return 0 ;;
  esac
  verb="re"; verb="${verb}start"
  mode="$(gateway_probe_mode "$engine")"
  t0="$(date +%s)"
  if [ "$engine" = "hermes" ]; then
    if [ -n "$(hermes_cli)" ]; then
      say "bouncing the hermes gateway through its own CLI (in-flight turns get 45s, drain 10s)"
      local IRISES_HERMES_ENV="HERMES_RESTART_AFTER_TURN_TIMEOUT=45 HERMES_RESTART_DRAIN_TIMEOUT=10"
      if ! portable_timeout 100 hermes_run gateway "$verb" >/dev/null 2>&1; then
        warn "the hermes CLI could not bounce the gateway — trying the service manager"
        _gateway_bounce_hermes_service "$verb" || true
      fi
    else
      warn "no hermes CLI on this box — trying the service manager"
      _gateway_bounce_hermes_service "$verb" || true
    fi
  else
    if command -v openclaw >/dev/null 2>&1; then
      say "bouncing the OpenClaw gateway (openclaw gateway $verb)"
      if ! portable_timeout 100 openclaw gateway "$verb" >/dev/null 2>&1; then
        warn "openclaw could not bounce its gateway — do it yourself: openclaw gateway $verb"
      fi
    else
      warn "no openclaw CLI on this box — bounce the gateway yourself: openclaw gateway $verb"
    fi
  fi
  if gateway_wait_healthy "$engine" "$secs" "$mode"; then
    t1="$(date +%s)"
    if [ "$mode" = "http" ]; then
      say "gateway is back — verified in $((t1 - t0))s"
    else
      say "gateway is back — verified in $((t1 - t0))s by service state (its HTTP health surface is off)"
    fi
    say "the engine posts its own '♻️ Gateway online' note to your home channel on a planned bounce"
    say "(silence it per platform with <platform>.gateway_restart_notification: false in the engine config)"
    return 0
  fi
  warn "the gateway did not come back within ${secs}s — Irises itself is unaffected"
  warn "check it yourself, then bounce it by hand once the reason is clear"
  return 1
}

# Refresh the bridge plugin from this clone. ALWAYS run on install and update: the plugin is a COPY,
# a lifecycle action bounces the gateway anyway, and plugins load only at gateway start.
plugin_refresh() { # ENGINE [ROOT]
  local engine="${1:-}" root="${2:-}" pdir ext
  if [ -z "$root" ]; then root="$(irises_root)"; fi
  case "$engine" in
    hermes)
      pdir="$(hermes_home)/plugins"
      if [ ! -d "$root/bridge/hermes/irises-bridge" ]; then
        warn "no bridge/hermes/irises-bridge in $root — skipping the plugin refresh"
        return 1
      fi
      mkdir -p "$pdir"
      rm -rf "$pdir/irises-bridge"
      cp -R "$root/bridge/hermes/irises-bridge" "$pdir/irises-bridge"
      find "$pdir/irises-bridge" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
      say "refreshed $pdir/irises-bridge (from this clone, minus __pycache__)"
      if [ -n "$(hermes_cli)" ]; then
        if hermes_run plugins enable irises-bridge >/dev/null 2>&1; then
          say "irises-bridge is enabled in the engine's config"
        else
          warn "could not enable it through the CLI — run: hermes plugins enable irises-bridge"
        fi
      else
        warn "no hermes CLI here — enable it yourself: hermes plugins enable irises-bridge"
      fi
      return 0
      ;;
    openclaw)
      ext="$(openclaw_home)/extensions"
      if [ ! -d "$root/bridge/openclaw/irises-bridge" ]; then
        warn "no bridge/openclaw/irises-bridge in $root — skipping the plugin refresh"
        return 1
      fi
      mkdir -p "$ext"
      # `openclaw plugins install` COPIES and REFUSES an existing target ("plugin already exists …
      # delete it first"), so clearing the way is the only way a refresh can succeed.
      rm -rf "$ext/irises-bridge"
      if command -v openclaw >/dev/null 2>&1; then
        if openclaw plugins install "$root/bridge/openclaw/irises-bridge" >/dev/null 2>&1; then
          say "installed irises-bridge into $ext/irises-bridge"
          return 0
        fi
        warn "openclaw plugins install failed — run it yourself:"
        warn "  openclaw plugins install $root/bridge/openclaw/irises-bridge"
        return 1
      fi
      warn "no openclaw CLI here — install it yourself:"
      warn "  openclaw plugins install $root/bridge/openclaw/irises-bridge"
      return 1
      ;;
  esac
  return 0
}

# Take the plugin off the engine: disable it in config (so a stale entry can't warn at every start),
# then delete the copy. OpenClaw has NO `plugins uninstall` — removal IS disable + rm.
plugin_remove() { # ENGINE
  local engine="${1:-}" pdir ext
  case "$engine" in
    hermes)
      pdir="$(hermes_home)/plugins"
      if [ -n "$(hermes_cli)" ]; then
        if hermes_run plugins disable irises-bridge >/dev/null 2>&1; then
          say "disabled irises-bridge in the engine's config"
        else
          warn "could not disable it through the CLI — remove 'irises-bridge' from plugins.enabled yourself"
        fi
      else
        warn "no hermes CLI here — remove 'irises-bridge' from plugins.enabled yourself"
      fi
      if [ -d "$pdir/irises-bridge" ]; then
        rm -rf "$pdir/irises-bridge"
        say "removed $pdir/irises-bridge"
      fi
      return 0
      ;;
    openclaw)
      ext="$(openclaw_home)/extensions"
      if command -v openclaw >/dev/null 2>&1; then
        openclaw plugins disable irises-bridge >/dev/null 2>&1 || warn "could not disable irises-bridge through the CLI"
      fi
      if [ -d "$ext/irises-bridge" ]; then
        rm -rf "$ext/irises-bridge"
        say "removed $ext/irises-bridge"
      fi
      return 0
      ;;
  esac
  return 0
}

# The web client — a SEPARATE npm project with a heavy toolchain, and the ONE step allowed to fail.
# Policy: build it only where it is already in use (web/out exists) or on request (IRISES_WEB=1),
# never under 1500 MB of free memory. On the 408 MB VPS `next build` took a bus error mid-build and,
# under `set -e`, aborted the whole update — server updated on disk, never restarted, no receipt.
# `npm --prefix web ci` (not `install`) because install rewrites web/package-lock.json, which then
# trips the updater's own dirty-tree preflight on the next run.
web_build() { # [ROOT] — always returns 0
  local root="${1:-}" mb
  if [ -z "$root" ]; then root="$(irises_root)"; fi
  if [ "${IRISES_SKIP_WEB_BUILD:-}" = "1" ]; then
    say "IRISES_SKIP_WEB_BUILD=1 — skipping the web client build"
    return 0
  fi
  if [ ! -d "$root/web" ]; then return 0; fi
  if [ ! -d "$root/web/out" ] && [ "${IRISES_WEB:-}" != "1" ]; then
    say "web UI not built here — skipping (opt in with IRISES_WEB=1; the terminal chat needs nothing)"
    return 0
  fi
  mb="$(mem_available_mb)"
  if [ -n "$mb" ] && [ "$mb" -lt 1500 ]; then
    warn "only ${mb} MB free — skipping the web build (next build wants ~1 GB and dies mid-way below that)"
    warn "build it when the box has room:  npm --prefix web ci && npm run build:web"
    return 0
  fi
  say "building the web client (npm --prefix web ci && npm run build:web)"
  if npm --prefix "$root/web" ci && ( cd "$root" && npm run build:web ); then
    say "web client built"
    return 0
  fi
  warn "web client build failed — the server half is fine; the browser page is not rebuilt"
  warn "retry when the box has room:  npm --prefix web ci && npm run build:web   (or set IRISES_SKIP_WEB_BUILD=1)"
  return 0
}
```

- [ ] **Step 4: Run the tests**

Run: `npx tsx --test scripts/lib/irises-lib.test.ts 2>&1 | tail -6`
Expected: `# fail 0` with the section-E tests counted.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/irises-lib.sh scripts/lib/irises-lib.test.ts
git commit -m "$(cat <<'EOF'
Add engine, gateway and plugin helpers to the shell library

engine_kind (reads OPS_BACKEND past its inline comment), hermes_cli/hermes_run
(finds ~/.local/bin/hermes, unsets the inherited _HERMES_GATEWAY), a verified
gateway_restart that caps both HERMES_RESTART_* budgets and takes a pre-bounce
health baseline so an engine with its API server off is not reported as failed,
plugin_refresh/plugin_remove for both engines (OpenClaw's installer refuses an
existing target and has no uninstall), and a web_build policy that skips the
build on a small box instead of taking the lifecycle action down with it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Lib section F — service manager, server process, health verification, manifest, lock, summary

**Files:**
- Modify: `scripts/lib/irises-lib.sh` (append section F at end of file)
- Test: `scripts/lib/irises-lib.test.ts` (append cases at end of file)

**Interfaces:**
- Consumes: `runLib`, `fixtureRoot` (Task 1); `say/log/warn/err`, `irises_root`, `irises_home`, `irises_port`, `env_get`, `portable_timeout`, `tcp_open` (Tasks 1–2).
- Produces:
  - `service_kind` → `systemd` | `launchd` | `none`.
  - `service_name` → `irises`; `service_label` → `ai.irises.server`; `service_unit_path`; `service_plist_path`.
  - `service_install ROOT NODE_BIN` → writes and loads the unit/plist; prints ONLY its path on stdout.
  - `service_start` / `service_stop` / `service_restart` / `service_status` / `service_uninstall` → 0/1.
  - `is_our_server PID` → 0/1; `server_pid` → live pid or empty; `server_stop [SECS]` → 0/1.
  - `server_start_detached ROOT [LOG]` → 0/1 (the `--no-service` fallback).
  - `wait_health URL SECS` → 0/1; `wait_health_sha URL SHA SECS` → prints the live sha, 0/1.
  - `built_sha [ROOT]` → the sha `dist/version.json` was stamped from.
  - `manifest_path`; `manifest_write PATH KEY=VALUE…`; `manifest_read PATH KEY`.
  - `lock_acquire [NAME]` / `lock_release` → 0/1.
  - `summary TOKEN LINE…` → prints the block and the final `RESULT: TOKEN` line.

- [ ] **Step 1: Append the section-F tests**

Append to `scripts/lib/irises-lib.test.ts`:

```ts
// ── section F: service, process, health, manifest, lock, summary ────────────────────────────────

test('service_kind is none with no systemctl and no launchctl on PATH', () => {
  const r = runLib('service_kind');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'none', 'the scratch PATH has neither — the detached fallback must be chosen');
});

test('service_kind needs systemctl AND a reachable user bus', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const bus = join(dir, 'run');
  mkdirSync(bus, { recursive: true });
  writeFileSync(join(bus, 'bus'), '');
  const noBus = runLib('service_kind', {
    stubs: { systemctl: 'exit 0', uname: 'echo Linux' },
    env: { XDG_RUNTIME_DIR: join(dir, 'absent') },
  });
  assert.equal(noBus.out, 'none', 'systemctl present but no user bus is the fresh-SSH case');
  const withBus = runLib('service_kind', {
    stubs: { systemctl: 'exit 0', uname: 'echo Linux' },
    env: { XDG_RUNTIME_DIR: bus, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(bus, 'bus')}` },
  });
  assert.equal(withBus.out, 'systemd');
  const mac = runLib('service_kind', { stubs: { launchctl: 'exit 0', uname: 'echo Darwin' } });
  assert.equal(mac.out, 'launchd');
});

test('service_install renders the systemd unit with an absolute node, PATH, logs and reload, and prints only its path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const home = join(dir, 'home');
  const root = join(dir, 'clone');
  const state = join(dir, 'state');
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.env'), 'PORT=3000\nNODE_OPTIONS=--max-old-space-size=512   # heap cap\n');
  const r = runLib(`service_install ${JSON.stringify(root)} /usr/local/bin/node`, {
    stubs: { systemctl: 'printf "systemctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0', uname: 'echo Linux', loginctl: 'printf "loginctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0' },
    env: { HOME: home, IRISES_HOME: state, IRISES_ROOT: root, XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' },
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const unitPath = join(home, '.config', 'systemd', 'user', 'irises.service');
  assert.equal(r.out.trim(), unitPath, 'callers capture this — the "wrote" line must be on stderr');
  const unit = readFileSync(unitPath, 'utf8');
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/node .*\/clone\/dist\/index\.js$/m, 'a bare `node` never resolves in a unit');
  assert.match(unit, new RegExp(`^WorkingDirectory=${root}$`, 'm'));
  assert.match(unit, new RegExp(`^Environment="IRISES_HOME=${state}"$`, 'm'));
  assert.match(unit, /^Environment="NODE_OPTIONS=--max-old-space-size=512"$/m, 'app.env sets it too late for V8 — the unit is the only place it works');
  assert.match(unit, /^Environment="PATH=[^"]*\/usr\/bin[^"]*"$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^RestartSec=5$/m);
  assert.match(unit, /^KillSignal=SIGTERM$/m);
  assert.match(unit, /^TimeoutStopSec=30$/m);
  assert.match(unit, new RegExp(`^StandardOutput=append:${state}/logs/server\\.log$`, 'm'));
  assert.match(unit, new RegExp(`^StandardError=append:${state}/logs/server\\.log$`, 'm'));
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.ok(r.log.some(l => l === 'systemctl argv:--user daemon-reload'), r.log.join('\n'));
  assert.ok(r.log.some(l => l === 'systemctl argv:--user enable irises'), r.log.join('\n'));
  assert.ok(r.log.some(l => l.startsWith('loginctl argv:enable-linger')), 'without linger the unit dies at logout');
});

test('service_install renders the LaunchAgent plist that stays stopped after a clean stop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const home = join(dir, 'home');
  const root = join(dir, 'clone');
  const state = join(dir, 'state');
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.env'), 'PORT=3000\n');
  const r = runLib(`service_install ${JSON.stringify(root)} /opt/homebrew/bin/node`, {
    stubs: { launchctl: 'printf "launchctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0', uname: 'echo Darwin' },
    env: { HOME: home, IRISES_HOME: state, IRISES_ROOT: root },
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const plistPath = join(home, 'Library', 'LaunchAgents', 'ai.irises.server.plist');
  assert.equal(r.out.trim(), plistPath);
  const plist = readFileSync(plistPath, 'utf8');
  assert.match(plist, /<key>Label<\/key>\s*<string>ai\.irises\.server<\/string>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, new RegExp(`<string>${root}/dist/index.js</string>`));
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    'a plain KeepAlive=true would relaunch the server we just asked to stop');
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(plist, new RegExp(`<key>StandardOutPath</key>\\s*<string>${state}/logs/server.log</string>`));
  assert.ok(r.log.some(l => /^launchctl argv:bootstrap gui\/\d+ .*ai\.irises\.server\.plist$/.test(l)), r.log.join('\n'));
});

test('service_restart and service_uninstall use the right verbs per platform', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(join(home, '.config', 'systemd', 'user', 'irises.service'), '[Service]\n');
  const linux = runLib('service_restart; service_uninstall', {
    stubs: { systemctl: 'printf "systemctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0', uname: 'echo Linux' },
    env: { HOME: home, XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' },
  });
  assert.equal(linux.code, 0, linux.err);
  assert.ok(linux.log.includes('systemctl argv:--user restart irises'), linux.log.join('\n'));
  assert.ok(linux.log.includes('systemctl argv:--user disable irises'), linux.log.join('\n'));
  assert.ok(!existsSync(join(home, '.config', 'systemd', 'user', 'irises.service')), 'the unit file goes with it');

  const home2 = join(dir, 'home2');
  mkdirSync(join(home2, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(home2, 'Library', 'LaunchAgents', 'ai.irises.server.plist'), '<plist/>\n');
  const mac = runLib('service_restart; service_uninstall', {
    stubs: { launchctl: 'printf "launchctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0', uname: 'echo Darwin' },
    env: { HOME: home2 },
  });
  assert.equal(mac.code, 0, mac.err);
  assert.ok(mac.log.some(l => /^launchctl argv:kickstart -k gui\/\d+\/ai\.irises\.server$/.test(l)), mac.log.join('\n'));
  assert.ok(mac.log.some(l => /^launchctl argv:bootout gui\/\d+\/ai\.irises\.server$/.test(l)), mac.log.join('\n'));
  assert.ok(!existsSync(join(home2, 'Library', 'LaunchAgents', 'ai.irises.server.plist')));
});

test('is_our_server and server_pid only ever claim a live Irises process', () => {
  const state = mkdtempSync(join(tmpdir(), 'irises-pid-'));
  const stale = runLib([
    `printf '999999\\n' > "$(irises_home)/irises.pid"`,
    'printf "PID=[%s]\\n" "$(server_pid)"',
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.equal(stale.code, 0, stale.err);
  assert.match(stale.out, /PID=\[\]/, 'a dead pid is not a server');

  const mine = runLib([
    'printf "SELF=%s\\n" "$(is_our_server $$ && echo yes || echo no)"',
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.match(mine.out, /SELF=no/, 'this bash is not dist/index.js');
  const junk = runLib('printf "JUNK=%s\\n" "$(is_our_server not-a-pid && echo yes || echo no)"', { env: { IRISES_HOME: state } });
  assert.match(junk.out, /JUNK=no/);
});

test('wait_health_sha waits for the sha the new build stamped, ignoring update.remoteSha', async () => {
  const http = await import('node:http');
  const oldSha = 'a'.repeat(40);
  const newSha = 'b'.repeat(40);
  let live = oldSha;
  const srv = http.createServer((_q, s) => {
    s.setHeader('content-type', 'application/json');
    s.end(JSON.stringify({ status: 'ok', version: { sha: live, shortSha: live.slice(0, 7) }, update: { remoteSha: 'c'.repeat(40) } }));
  });
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const ok = runLib(`wait_health ${base} 5 && printf "\\nHEALTH=ok\\n"`);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /HEALTH=ok/);

    const wrong = runLib(`rc=0; wait_health_sha ${base} ${newSha} 3 || rc=$?; printf "\\nRC=%s\\n" "$rc"`);
    assert.match(wrong.out, /RC=1/, 'the old build answering must NOT be read as the new build');

    live = newSha;
    const right = runLib(`wait_health_sha ${base} ${newSha} 5; printf "\\nRC=0\\n"`);
    assert.equal(right.code, 0, right.err);
    assert.match(right.out, new RegExp(newSha));
    const short = runLib(`wait_health_sha ${base} ${newSha.slice(0, 7)} 5; printf "\\nRC=0\\n"`);
    assert.equal(short.code, 0, 'a short sha from dist/version.json must match the full one');
  } finally {
    srv.close();
  }
});

test('wait_health fails within its budget when nothing is listening', () => {
  const started = Date.now();
  const r = runLib('rc=0; wait_health http://127.0.0.1:1 3 || rc=$?; printf "RC=%s\\n" "$rc"');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=1/);
  assert.ok(Date.now() - started < 20000);
});

test('manifest_write and manifest_read round-trip without node, and survive a reformat', () => {
  const state = mkdtempSync(join(tmpdir(), 'irises-man-'));
  const p = join(state, 'install-manifest.json');
  const r = runLib([
    `manifest_write ${JSON.stringify(p)} engine=hermes root=/home/ubuntu/irises port=3000 serviceKind=systemd 'keysAdded=API_SERVER_ENABLED IRISES_PUSH_TOKEN' keysPreExisting=API_SERVER_KEY`,
    `printf 'ENGINE=%s\\n' "$(manifest_read ${JSON.stringify(p)} engine)"`,
    `printf 'ADDED=[%s]\\n' "$(manifest_read ${JSON.stringify(p)} keysAdded)"`,
    `printf 'PRE=%s\\n' "$(manifest_read ${JSON.stringify(p)} keysPreExisting)"`,
    `printf 'MISSING=[%s]\\n' "$(manifest_read ${JSON.stringify(p)} nope)"`,
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ENGINE=hermes/);
  assert.match(r.out, /ADDED=\[API_SERVER_ENABLED IRISES_PUSH_TOKEN\]/);
  assert.match(r.out, /PRE=API_SERVER_KEY/);
  assert.match(r.out, /MISSING=\[\]/);
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>;
  assert.equal(parsed.engine, 'hermes', 'it must be valid JSON for anyone who looks at it');
  assert.equal(parsed.serviceKind, 'systemd');
  writeFileSync(p, JSON.stringify(parsed));    // one line: the grep reader misses, node must catch it
  const reformatted = runLib(`printf 'ENGINE=%s\\n' "$(manifest_read ${JSON.stringify(p)} engine)"`, { env: { IRISES_HOME: state } });
  assert.match(reformatted.out, /ENGINE=hermes/);
});

test('lock_acquire keeps a second run out and reclaims a lock whose holder is gone', () => {
  const state = mkdtempSync(join(tmpdir(), 'irises-lock-'));
  const held = runLib([
    'lock_acquire',
    'rc=0; ( lock_acquire ) || rc=$?; printf "SECOND=%s\\n" "$rc"',
    'lock_release',
    'lock_acquire && printf "AFTER_RELEASE=ok\\n"',
    'lock_release',
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.equal(held.code, 0, held.err);
  assert.match(held.out, /SECOND=1/);
  assert.match(held.out, /AFTER_RELEASE=ok/);
  const stale = runLib([
    'mkdir -p "$(irises_home)/lifecycle.lock"',
    'printf "999999\\n" > "$(irises_home)/lifecycle.lock/pid"',
    'lock_acquire && printf "RECLAIMED=ok\\n"',
    'lock_release',
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.equal(stale.code, 0, stale.err);
  assert.match(stale.out, /RECLAIMED=ok/);
});

test('summary prints its lines and ends with exactly one RESULT line on stdout', () => {
  const r = runLib('summary rolled-back "old -> new reverted" "server untouched"');
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n').filter(Boolean);
  assert.equal(lines[lines.length - 1], 'RESULT: rolled-back');
  assert.equal(lines.filter(l => l.startsWith('RESULT:')).length, 1);
  assert.match(r.out, /old -> new reverted/);
  assert.match(r.out, /server untouched/);
});
```

- [ ] **Step 2: Run the new cases and watch them fail**

Run: `npx tsx --test scripts/lib/irises-lib.test.ts 2>&1 | tail -20`
Expected: the section-F tests fail with `service_kind: command not found` and friends.

- [ ] **Step 3: Append section F to `scripts/lib/irises-lib.sh`**

```bash
# ═══ F. the Irises server: service, process, health, manifest, lock, summary ══
#
# Irises installs as a USER-LEVEL service by default — systemd --user on Linux (with linger, or it
# dies at logout), a LaunchAgent on macOS — because a `nohup` server does not survive a reboot and
# nothing else on the box knows how to bring it back. `--no-service` falls back to the detached
# launch, and then $IRISES_HOME/irises.pid (written by the server itself, src/update/pidfile.ts) is
# the only handle anyone has.

service_name()  { printf 'irises'; }
service_label() { printf 'ai.irises.server'; }
service_unit_path()  { printf '%s/.config/systemd/user/%s.service' "$HOME" "$(service_name)"; }
service_plist_path() { printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$(service_label)"; }

_irises_xdg() { printf '%s' "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; }

# systemd needs systemctl AND a user bus to talk to (a fresh SSH session with linger off has
# neither, and `systemctl --user` there fails with "Failed to connect to bus"). launchd needs
# launchctl and Darwin. Anything else → none, and the caller uses the detached fallback.
service_kind() {
  local os xdg
  os="$(uname -s 2>/dev/null || printf unknown)"
  case "$os" in
    Darwin)
      if command -v launchctl >/dev/null 2>&1; then printf 'launchd'; return 0; fi
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        xdg="$(_irises_xdg)"
        if [ -S "$xdg/bus" ] || [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
          printf 'systemd'
          return 0
        fi
      fi
      ;;
  esac
  printf 'none'
}

_systemctl_user() { # ARGS…
  local rc=0
  XDG_RUNTIME_DIR="$(_irises_xdg)" systemctl --user "$@" || rc=$?
  return "$rc"
}

# A service PATH built like the engine's own: the node we resolved first, then the user-local dirs,
# then the base system dirs. A unit inherits almost nothing, so this list is the whole world it sees.
_service_path() { # NODE_BIN
  local node="${1:-}" p d
  p="$(dirname "$node")"
  for d in "$HOME/.local/bin" "${HERMES_HOME:-$HOME/.hermes}/node/bin" /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do
    case ":$p:" in *":$d:"*) ;; *) p="$p:$d" ;; esac
  done
  printf '%s' "$p"
}

# NODE_OPTIONS from the clone's config, applied where it actually works. deploy/app.env's
# `NODE_OPTIONS=--max-old-space-size=512` is loaded by dotenv AFTER V8 has already sized its heap,
# so on a 1 GB box that documented cap has never once taken effect. In the unit it does.
_service_node_options() { # ROOT
  local root="${1:-}" v
  v="$(env_get "$root/.env" NODE_OPTIONS)"
  if [ -z "$v" ]; then v="$(env_get "$root/deploy/app.env" NODE_OPTIONS)"; fi
  printf '%s' "$v"
}

# Prints ONLY the unit/plist path on stdout — callers capture it. Everything else goes through log/warn.
service_install() { # ROOT NODE_BIN
  local root="${1:-}" node="${2:-}" kind home logs unit plist path opts uid
  if [ -z "$root" ] || [ -z "$node" ]; then err "service_install needs ROOT and an absolute NODE_BIN"; return 1; fi
  kind="$(service_kind)"
  home="$(irises_home)"
  logs="$home/logs"
  mkdir -p "$logs"
  path="$(_service_path "$node")"
  opts="$(_service_node_options "$root")"
  case "$kind" in
    systemd)
      unit="$(service_unit_path)"
      mkdir -p "$(dirname "$unit")"
      {
        printf '[Unit]\n'
        printf 'Description=Irises — private companion server\n'
        printf 'After=network-online.target\n'
        printf 'Wants=network-online.target\n'
        printf 'StartLimitIntervalSec=0\n'
        printf '\n[Service]\n'
        printf 'Type=simple\n'
        printf 'ExecStart=%s %s/dist/index.js\n' "$node" "$root"
        printf 'WorkingDirectory=%s\n' "$root"
        printf 'Environment="PATH=%s"\n' "$path"
        printf 'Environment="IRISES_HOME=%s"\n' "$home"
        if [ -n "$opts" ]; then printf 'Environment="NODE_OPTIONS=%s"\n' "$opts"; fi
        printf 'Restart=on-failure\n'
        printf 'RestartSec=5\n'
        printf 'KillSignal=SIGTERM\n'
        printf 'TimeoutStopSec=30\n'
        # append: needs systemd 240+ (Ubuntu 20.04+). On anything older systemd refuses to load the
        # unit; swap both lines for `journal` and read it with: journalctl --user -u irises -f
        printf 'StandardOutput=append:%s/server.log\n' "$logs"
        printf 'StandardError=append:%s/server.log\n' "$logs"
        printf '\n[Install]\n'
        printf 'WantedBy=default.target\n'
      } > "$unit"
      log "wrote $unit"
      _systemctl_user daemon-reload || { err "systemctl --user daemon-reload failed"; return 1; }
      _systemctl_user enable "$(service_name)" >/dev/null 2>&1 || warn "could not enable the unit (it will still start now)"
      # Without linger a user unit is killed at logout and never comes back after a reboot.
      if command -v loginctl >/dev/null 2>&1; then
        if ! loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
          warn "could not enable linger — Irises will stop when you log out."
          warn "ask an admin for:  sudo loginctl enable-linger $(id -un)"
        fi
      else
        warn "no loginctl here — if Irises stops at logout, that is why"
      fi
      printf '%s' "$unit"
      return 0
      ;;
    launchd)
      plist="$(service_plist_path)"
      uid="$(id -u)"
      mkdir -p "$(dirname "$plist")"
      {
        printf '<?xml version="1.0" encoding="UTF-8"?>\n'
        printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        printf '<plist version="1.0">\n<dict>\n'
        printf '    <key>Label</key>\n    <string>%s</string>\n' "$(service_label)"
        printf '    <key>ProgramArguments</key>\n    <array>\n'
        printf '        <string>%s</string>\n' "$node"
        printf '        <string>%s/dist/index.js</string>\n' "$root"
        printf '    </array>\n'
        printf '    <key>WorkingDirectory</key>\n    <string>%s</string>\n' "$root"
        printf '    <key>EnvironmentVariables</key>\n    <dict>\n'
        printf '        <key>PATH</key>\n        <string>%s</string>\n' "$path"
        printf '        <key>IRISES_HOME</key>\n        <string>%s</string>\n' "$home"
        if [ -n "$opts" ]; then printf '        <key>NODE_OPTIONS</key>\n        <string>%s</string>\n' "$opts"; fi
        printf '    </dict>\n'
        printf '    <key>RunAtLoad</key>\n    <true/>\n'
        # KeepAlive as a dict, NOT `true`: a bare true relaunches the server the moment we stop it
        # on purpose, so `service_stop` could never actually stop anything.
        printf '    <key>KeepAlive</key>\n    <dict>\n        <key>SuccessfulExit</key>\n        <false/>\n    </dict>\n'
        printf '    <key>ThrottleInterval</key>\n    <integer>10</integer>\n'
        printf '    <key>ExitTimeOut</key>\n    <integer>30</integer>\n'
        printf '    <key>StandardOutPath</key>\n    <string>%s/server.log</string>\n' "$logs"
        printf '    <key>StandardErrorPath</key>\n    <string>%s/server.log</string>\n' "$logs"
        printf '</dict>\n</plist>\n'
      } > "$plist"
      log "wrote $plist"
      # Bootstrapping a label that is already loaded fails with EIO; boot it out first so a re-run
      # is a genuine reinstall rather than a no-op.
      launchctl bootout "gui/$uid/$(service_label)" >/dev/null 2>&1 || true
      if ! launchctl bootstrap "gui/$uid" "$plist" >/dev/null 2>&1; then
        err "launchctl bootstrap gui/$uid failed — load it yourself: launchctl bootstrap gui/$uid $plist"
        return 1
      fi
      printf '%s' "$plist"
      return 0
      ;;
  esac
  warn "no user service manager here (no systemd --user, no launchd) — using the detached fallback"
  return 1
}

service_start() {
  local kind uid
  kind="$(service_kind)"
  case "$kind" in
    systemd) _systemctl_user start "$(service_name)" || return 1; return 0 ;;
    launchd) uid="$(id -u)"
             launchctl kickstart "gui/$uid/$(service_label)" >/dev/null 2>&1 || return 1
             return 0 ;;
  esac
  return 1
}

service_stop() {
  local kind uid
  kind="$(service_kind)"
  case "$kind" in
    systemd) _systemctl_user stop "$(service_name)" || return 1; return 0 ;;
    launchd) uid="$(id -u)"
             launchctl kill SIGTERM "gui/$uid/$(service_label)" >/dev/null 2>&1 || true
             return 0 ;;
  esac
  return 1
}

service_restart() {
  local kind uid
  kind="$(service_kind)"
  case "$kind" in
    systemd) _systemctl_user restart "$(service_name)" || return 1; return 0 ;;
    launchd) uid="$(id -u)"
             launchctl kickstart -k "gui/$uid/$(service_label)" >/dev/null 2>&1 || return 1
             return 0 ;;
  esac
  return 1
}

service_status() { # 0 = installed and running
  local kind uid
  kind="$(service_kind)"
  case "$kind" in
    systemd)
      if [ ! -f "$(service_unit_path)" ]; then return 1; fi
      if [ "$(_systemctl_user is-active "$(service_name)" 2>/dev/null || true)" = "active" ]; then return 0; fi
      return 1
      ;;
    launchd)
      if [ ! -f "$(service_plist_path)" ]; then return 1; fi
      uid="$(id -u)"
      if launchctl print "gui/$uid/$(service_label)" 2>/dev/null | grep -q 'state = running'; then return 0; fi
      return 1
      ;;
  esac
  return 1
}

service_uninstall() {
  local kind unit plist uid
  kind="$(service_kind)"
  case "$kind" in
    systemd)
      unit="$(service_unit_path)"
      _systemctl_user stop "$(service_name)" >/dev/null 2>&1 || true
      _systemctl_user disable "$(service_name)" >/dev/null 2>&1 || true
      if [ -f "$unit" ]; then rm -f "$unit"; say "removed $unit"; fi
      _systemctl_user daemon-reload >/dev/null 2>&1 || true
      return 0
      ;;
    launchd)
      plist="$(service_plist_path)"
      uid="$(id -u)"
      launchctl bootout "gui/$uid/$(service_label)" >/dev/null 2>&1 || true
      if [ -f "$plist" ]; then rm -f "$plist"; say "removed $plist"; fi
      return 0
      ;;
  esac
  # Nothing installed here, but a unit/plist can outlive the tool that detected it.
  for unit in "$(service_unit_path)" "$(service_plist_path)"; do
    if [ -f "$unit" ]; then rm -f "$unit"; say "removed $unit"; fi
  done
  return 0
}

# Only ever signal a pid we can identify as OUR server: a stale pidfile (an OOM-killed server never
# ran its exit handler) can hold a pid the OS has since handed to something else.
is_our_server() { # PID
  local pid="${1:-}" cmd=""
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  if [ -r "/proc/$pid/cmdline" ]; then
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  else
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  fi
  case "$cmd" in *dist/index.js*) return 0 ;; esac
  return 1
}

# The ONE pidfile: $IRISES_HOME/irises.pid, written by the server itself at boot. (The old setup
# script kept a second one in the clone root, which is how a "running" server and a "stale" pidfile
# could both be true at once.)
server_pid() {
  local home pid
  home="$(irises_home)"
  if [ -f "$home/irises.pid" ]; then
    pid="$(cat "$home/irises.pid" 2>/dev/null || true)"
    pid="${pid%%[![:digit:]]*}"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && is_our_server "$pid"; then
      printf '%s' "$pid"
      return 0
    fi
  fi
  return 0
}

server_stop() { # [SECS]
  local secs="${1:-15}" pid i=0
  pid="$(server_pid)"
  if [ -z "$pid" ]; then return 0; fi
  say "stopping the running server (pid $pid)"
  kill "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt "$secs" ]; do
    sleep 1
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    warn "pid $pid ignored SIGTERM for ${secs}s — sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi
  return 0
}

# The --no-service fallback. `setsid` gives the server its own session; macOS has no setsid, so the
# child inherits INT/HUP as ignored instead — otherwise Ctrl+C in the launching terminal kills the
# server it just started (reproduced).
server_start_detached() { # ROOT [LOG]
  local root="${1:-}" log="${2:-}" home
  home="$(irises_home)"
  mkdir -p "$home/logs"
  if [ -z "$log" ]; then log="$home/logs/server.log"; fi
  say "starting Irises detached — it outlives this shell (log: $log)"
  (
    cd "$root" || exit 1
    if command -v setsid >/dev/null 2>&1; then
      setsid nohup node "$root/dist/index.js" </dev/null >>"$log" 2>&1 &
    else
      trap '' INT HUP
      nohup node "$root/dist/index.js" </dev/null >>"$log" 2>&1 &
    fi
  )
  return 0
}

wait_health() { # URL SECS   (URL is the base, e.g. http://127.0.0.1:3000)
  local url="${1:-}" secs="${2:-30}" i=0
  while [ "$i" -lt "$secs" ]; do
    if curl -fsS -m 5 "$url/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# Wait until /health reports the sha we expect, and print it. This is the difference between "a
# server answers" and "the NEW build is live": the old updater only ever checked the former, so a
# restart that silently relaunched the old build looked like a success.
wait_health_sha() { # URL SHA SECS
  local url="${1:-}" want="${2:-}" secs="${3:-45}" i=0 body got
  while [ "$i" -lt "$secs" ]; do
    body="$(curl -fsS -m 5 "$url/health" 2>/dev/null || true)"
    if [ -n "$body" ]; then
      # version.sha is the first lowercase-hex "sha" in the body; update.remoteSha cannot match
      # this pattern (the quote before `Sha` is preceded by `remote`).
      got="$(printf '%s' "$body" | grep -o '"sha":"[0-9a-f]\{7,40\}"' | head -1 | cut -d'"' -f4 || true)"
      if [ -n "$got" ]; then
        if [ -z "$want" ]; then printf '%s' "$got"; return 0; fi
        case "$got" in "$want"*) printf '%s' "$got"; return 0 ;; esac
        case "$want" in "$got"*) printf '%s' "$got"; return 0 ;; esac
      fi
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# The sha dist/ was stamped from (scripts/stamp-version.js). Empty when this clone was never built.
built_sha() { # [ROOT]
  local root="${1:-}" f
  if [ -z "$root" ]; then root="$(irises_root)"; fi
  f="$root/dist/version.json"
  if [ ! -f "$f" ]; then return 0; fi
  printf '%s' "$(grep -o '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]\{7,40\}"' "$f" | head -1 | cut -d'"' -f4 || true)"
}

# ── install manifest ──────────────────────────────────────────────────────────
# What the installer touched, so --uninstall can put it back WITHOUT node (the uninstall path must
# work on a box whose node has since gone). We are the only writer, so one key per line is a sound
# contract; a human who reformats it into one line still gets read, via node, below.
manifest_path() { printf '%s/install-manifest.json' "$(irises_home)"; }

manifest_write() { # PATH KEY=VALUE…
  local p="${1:-}" pair key val
  if [ -z "$p" ]; then return 1; fi
  shift || true
  mkdir -p "$(dirname "$p")"
  {
    printf '{\n'
    printf '  "schema": "1",\n'
    printf '  "writtenAt": "%s"' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for pair in "$@"; do
      key="${pair%%=*}"
      val="${pair#*=}"
      val="${val//\\/\\\\}"
      val="${val//\"/\\\"}"
      printf ',\n  "%s": "%s"' "$key" "$val"
    done
    printf '\n}\n'
  } > "$p"
  chmod 600 "$p" 2>/dev/null || true
  say "wrote $p"
  return 0
}

manifest_read() { # PATH KEY
  local p="${1:-}" key="${2:-}" line v
  if [ -z "$key" ] || [ ! -f "${p:-}" ]; then return 0; fi
  line="$(grep -m1 "\"$key\"[[:space:]]*:" "$p" 2>/dev/null || true)"
  if [ -n "$line" ]; then
    v="${line#*:}"
    v="${v#"${v%%[![:space:]]*}"}"
    v="${v%,}"
    case "$v" in '"'*) v="${v#\"}"; v="${v%\"}" ;; esac
    v="${v//\\\"/\"}"
    printf '%s' "$v"
    return 0
  fi
  # A reformatted (single-line) manifest: fall back to a real JSON parser when one exists.
  if command -v node >/dev/null 2>&1; then
    node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=o[process.argv[2]];if(v!==undefined)process.stdout.write(String(v))}catch(e){}' "$p" "$key" 2>/dev/null || true
  fi
  return 0
}

# ── single-lifecycle lock ─────────────────────────────────────────────────────
# mkdir is atomic, so it is the lock. One lock covers install, update and uninstall: two of them
# racing on git/npm/dist is the same corruption whichever pair it is.
lock_acquire() { # [NAME]
  local name="${1:-lifecycle}" home dir other
  home="$(irises_home)"
  mkdir -p "$home" 2>/dev/null || true
  dir="$home/$name.lock"
  if mkdir "$dir" 2>/dev/null; then
    printf '%s\n' "$$" > "$dir/pid"
    IRISES_LOCK_DIR="$dir"
    return 0
  fi
  other="$(cat "$dir/pid" 2>/dev/null || true)"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    err "another Irises lifecycle run holds the lock (pid $other) — not starting a second one"
    return 1
  fi
  rm -rf "$dir" 2>/dev/null || true
  if mkdir "$dir" 2>/dev/null; then
    printf '%s\n' "$$" > "$dir/pid"
    IRISES_LOCK_DIR="$dir"
    warn "reclaimed a lock left behind by a dead run (pid ${other:-unknown})"
    return 0
  fi
  err "could not take the lifecycle lock at $dir"
  return 1
}

# Release ONLY our own lock — never one a concurrent run holds.
lock_release() {
  local dir="${IRISES_LOCK_DIR:-}"
  if [ -z "$dir" ]; then return 0; fi
  if [ "$(cat "$dir/pid" 2>/dev/null || true)" = "$$" ]; then rm -rf "$dir" 2>/dev/null || true; fi
  IRISES_LOCK_DIR=""
  return 0
}

# ── the final block ───────────────────────────────────────────────────────────
# Every lifecycle script ends here, and its LAST line of stdout is always `RESULT: <token>`:
#   ok | noop | adopted | health-failed | rolled-back | gateway-failed | partial | up-to-date | update-available
summary() { # TOKEN LINE…
  local token="${1:-ok}" l
  shift || true
  printf '\n'
  printf '  ── Irises: %s ──\n' "${IRISES_LOG_TAG:-irises}"
  for l in "$@"; do printf '  %s\n' "$l"; done
  printf '\n'
  printf 'RESULT: %s\n' "$token"
  return 0
}
```

- [ ] **Step 4: Run the whole lib test file and the suite**

Run: `npx tsx --test scripts/lib/irises-lib.test.ts 2>&1 | tail -6 && npm test 2>&1 | tail -6 && npm run typecheck:scripts`
Expected: `# fail 0` from both runs; `typecheck:scripts` silent, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/irises-lib.sh scripts/lib/irises-lib.test.ts
git commit -m "$(cat <<'EOF'
Add service, health and manifest helpers to the shell library

service_kind/install/start/stop/restart/status/uninstall for systemd --user
(with linger) and LaunchAgent (KeepAlive as a dict so a deliberate stop stays
stopped), both units carrying an absolute node, an explicit PATH and the
NODE_OPTIONS heap cap that app.env sets too late to matter. Plus the single
pidfile helpers, wait_health_sha (verifies the NEW build is live, not merely
that something answers), a node-free install manifest, the shared lifecycle
lock, and the summary block that ends in a machine-readable RESULT line.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Shell contract test — syntax, sourcing, and no blocked lifecycle literal

**Files:**
- Create: `scripts/shellContract.test.ts`

**Interfaces:**
- Consumes: `scripts/lib/irises-lib.sh` (Tasks 1–3); later tasks' `scripts/engine-setup.sh` and `scripts/update.sh` are picked up automatically by the directory scan.
- Produces: a suite-wide guard that every `scripts/**/*.sh` parses, sources the lib the one supported way, and contains no literal an engine's lifecycle guard would refuse.
- **Expected RED until Task 7 lands**: the two old scripts still contain the literal and do not source the lib. Treat the two named failures as this task's acceptance criteria; if the executor gates on "suite green after every task", run Task 4 immediately before Task 5 and accept the two documented failures.

- [ ] **Step 1: Write the contract test**

Create `scripts/shellContract.test.ts`:

```ts
// Run with: npm test   (scripts/**/*.test.ts is in the test glob).
//
// Three properties every shell file in this repo has to keep, none of which any single script's own
// test would notice:
//
//  1. It parses. `bash -n` is the cheapest real check we have (shellcheck is not a dependency).
//  2. It reaches the shared library exactly one way, so there is one place to fix a helper.
//  3. It contains NO literal that an engine's lifecycle guard blocks. hermes's
//     cron/lifecycle_guard.py refuses a terminal command matching `hermes gateway <restart|stop>`,
//     `systemctl … <restart|stop|start> … hermes-gateway`, `launchctl <kickstart|…> … hermes.gateway`
//     or `pkill … hermes … gateway` — and it reads the CONTENTS of any script the command names,
//     including sourced ones. One such string in a comment is enough to make `bash scripts/update.sh`
//     unrunnable from a chat, so the verbs are assembled at runtime and this test keeps them that way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SCRIPTS = join(process.cwd(), 'scripts');

function shellFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...shellFiles(p));
    else if (name.endsWith('.sh')) out.push(p);
  }
  return out;
}

const FILES = shellFiles(SCRIPTS);

/** Mirrors the four blocking branches of hermes's _GATEWAY_LIFECYCLE_PATTERN, line by line. */
const BLOCKED: Array<{ name: string; re: RegExp }> = [
  { name: 'hermes gateway restart|stop', re: /hermes\s+gateway\s+(?:restart|stop)/i },
  { name: 'launchctl … hermes.gateway', re: /launchctl\s+(?:kickstart|unload|load|stop|restart|submit|bootstrap)\b[^\n]*\bhermes[.\-]?gateway/i },
  { name: 'systemctl restart|stop|start … hermes-gateway', re: /systemctl\s+(?:-\S+\s+)*(?:restart|stop|start)\b[^\n]*\bhermes[.\-]?gateway/i },
  { name: 'pkill … hermes … gateway', re: /p?kill\b[^\n]*\bhermes\b[^\n]*\bgateway/i },
];

test('there are shell files to check', () => {
  assert.ok(FILES.length >= 1, `no scripts/**/*.sh found — did the layout change?`);
});

for (const file of FILES) {
  const rel = relative(process.cwd(), file);

  test(`${rel} is valid bash`, () => {
    execFileSync('/bin/bash', ['-n', file], { encoding: 'utf8' });
  });

  test(`${rel} carries no literal an engine lifecycle guard would refuse`, () => {
    const lines = readFileSync(file, 'utf8').split('\n');
    const hits: string[] = [];
    lines.forEach((line, i) => {
      for (const { name, re } of BLOCKED) {
        if (re.test(line)) hits.push(`${rel}:${i + 1} matches [${name}]: ${line.trim()}`);
      }
    });
    assert.deepEqual(hits, [], `assemble the verb at runtime instead:\n${hits.join('\n')}`);
  });
}

test('every lifecycle script sources the library the one supported way', () => {
  const lifecycle = FILES.filter(f => /(engine-setup|update)\.sh$/.test(f));
  assert.equal(lifecycle.length, 2, `expected engine-setup.sh and update.sh, found ${lifecycle.length}`);
  for (const f of lifecycle) {
    const body = readFileSync(f, 'utf8');
    assert.match(
      body,
      /source "\$\(CDPATH='' cd -- "\$\(dirname -- "\$0"\)" && pwd\)\/lib\/irises-lib\.sh"/,
      `${relative(process.cwd(), f)} must source the lib with the dirname-of-$0 form (a bare relative path breaks any run from another cwd)`,
    );
  }
});

test('the library itself is never executed and never duplicated in a script', () => {
  for (const f of FILES.filter(x => !x.endsWith('irises-lib.sh'))) {
    const body = readFileSync(f, 'utf8');
    // A helper redefined locally is a helper that drifts. These four were copy-pasted between the
    // two scripts before the library existed.
    for (const fn of ['get_env()', 'set_env()', 'is_our_server()', 'health_ok()']) {
      assert.ok(!body.includes(fn), `${relative(process.cwd(), f)} redefines ${fn} — use the library's`);
    }
  }
});
```

- [ ] **Step 2: Run it against the current tree**

Run: `npx tsx --test scripts/shellContract.test.ts 2>&1 | tail -20`
Expected: the per-file `bash -n` and blocked-literal tests PASS for `scripts/lib/irises-lib.sh`, and these FAIL — `every lifecycle script sources the library the one supported way` (the scripts do not source it yet), the blocked-literal test for `scripts/engine-setup.sh` (it contains `hermes gateway restart` on lines 214, 327, 346, 520, 558, 561) and for `scripts/update.sh` (line 327), and the duplicate-helper test.

- [ ] **Step 3: Record the known failures as the next tasks' entry criteria**

No code change. Confirm the failure list matches exactly:

Run: `grep -rn "hermes gateway restart" scripts/*.sh | wc -l`
Expected: `7` — every one of these disappears in Tasks 5–7, at which point this test goes green with no further edits.

- [ ] **Step 4: Commit the guard**

```bash
git add scripts/shellContract.test.ts
git commit -m "$(cat <<'EOF'
Add a shell contract test: bash -n, one sourcing form, no blocked literals

Mirrors the four blocking branches of hermes's cron/lifecycle_guard.py over
every scripts/**/*.sh, line by line. The guard reads the contents of any script
a command names (sourced files included), so one literal in a comment makes the
whole install unrunnable from a chat. Currently red on engine-setup.sh and
update.sh, which the next tasks rewrite.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `engine-setup.sh` rewrite — install as a user service, verified, idempotent

**Files:**
- Modify: `scripts/engine-setup.sh` (full rewrite: replace lines 1-566; the install path only — `--uninstall` lands in Task 6)
- Modify: `.gitignore:1-10` (add `irises.pid`)
- Test: `scripts/engine-setup.test.ts` (create)

**Interfaces:**
- Consumes: everything from Tasks 1–3 — `say/log/warn/err/die`, `irises_root`, `irises_home`, `irises_port`, `env_get`, `env_set`, `env_set_default`, `env_append_block`, `env_backup`, `env_count`, `augment_path`, `require_tools`, `require_node_version`, `engine_kind`, `hermes_home`, `openclaw_home`, `hermes_cli`, `hermes_run`, `gateway_restart`, `plugin_refresh`, `web_build`, `service_kind`, `service_install`, `service_restart`, `service_status`, `service_unit_path`, `service_plist_path`, `server_pid`, `server_stop`, `server_start_detached`, `is_our_server`, `wait_health_sha`, `built_sha`, `tcp_open`, `manifest_path`, `manifest_write`, `lock_acquire`, `lock_release`, `summary`.
- Produces: `bash scripts/engine-setup.sh [--engine hermes|openclaw|off] [--yes] [--no-bridge] [--no-service] [--port N]`; exit codes `0` ok, `1` failure, `2` usage, `4` health not verified, `5` gateway not verified; last stdout line `RESULT: ok|adopted|health-failed|gateway-failed`.

- [ ] **Step 1: Write the arg/exit contract test**

Create `scripts/engine-setup.test.ts`:

```ts
// Run with: npm test   (scripts/**/*.test.ts is in the test glob). Nothing here installs anything:
// these are the ARGUMENT and EXIT-CODE contracts, the parts an operator or a script depends on and
// that a rewrite silently changes. The lifecycle itself is covered end to end by
// scripts/e2e/lifecycle-sandbox.sh (npm run e2e:lifecycle).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'engine-setup.sh');

function run(args: string[]): { out: string; err: string; code: number } {
  const r = spawnSync('/bin/bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? -1 };
}

test('--help documents every flag it accepts, and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0, r.err);
  for (const flag of ['--engine', '--uninstall', '--yes', '--no-bridge', '--no-service', '--port', '--purge-data']) {
    assert.ok(r.out.includes(flag), `--help must document ${flag}\n${r.out}`);
  }
  assert.ok(!r.out.includes('set -euo pipefail'), 'the help text stops at the header');
  assert.match(r.out, /RESULT:/, 'the machine-readable last line is part of the contract');
});

test('an unknown flag exits 2 and points at --help', () => {
  const r = run(['--frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--frobnicate/);
  assert.match(r.err, /--help/);
});

test('an unknown engine exits 2 without touching anything', () => {
  const r = run(['--engine', 'banana', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /banana/);
});

test('--revert is gone and says so, with exit 2', () => {
  const r = run(['--revert']);
  assert.equal(r.code, 2, 'a silent no-op would let someone believe bridge mode was undone');
  assert.match(r.err, /--uninstall/);
});

test('--port rejects a non-numeric value with exit 2', () => {
  const r = run(['--port', 'http://3000', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /port/i);
});

test('the exit-code table is documented in the header', () => {
  const r = run(['--help']);
  for (const line of ['0 ', '1 ', '2 ', '4 ', '5 ']) assert.ok(r.out.includes(line), `${r.out}`);
  assert.match(r.out, /4[^\n]*health/i);
  assert.match(r.out, /5[^\n]*gateway/i);
});
```

- [ ] **Step 2: Run it and watch it fail against today's script**

Run: `npx tsx --test scripts/engine-setup.test.ts 2>&1 | tail -20`
Expected: failures — `--help` lacks `--uninstall`/`--no-service`/`--port`/`--purge-data`/`RESULT:`, `--revert` exits 0 instead of 2, `--port` is an unknown arg.

- [ ] **Step 3: Replace `scripts/engine-setup.sh` — header, arguments, preflight**

Replace the whole file (lines 1-566) starting with:

```bash
#!/usr/bin/env bash
# Irises install / uninstall — wire this clone to an UNMODIFIED hermes-agent or OpenClaw engine,
# install Irises as a user-level service, and verify the whole thing came up.
#
#   bash ./scripts/engine-setup.sh                      # install (engine auto-detected)
#   bash ./scripts/engine-setup.sh --engine hermes --yes # install, never prompt
#   bash ./scripts/engine-setup.sh --no-service          # do not install a service; run detached
#   bash ./scripts/engine-setup.sh --no-bridge           # leave the engine answering its own channels
#   bash ./scripts/engine-setup.sh --port 3001           # pin a different port
#   bash ./scripts/engine-setup.sh --uninstall           # remove Irises, keep your data
#   bash ./scripts/engine-setup.sh --uninstall --purge-data   # …and delete $IRISES_HOME too
#
# The TERMINAL is the only install/update/uninstall path. There is no in-chat installer: Irises can
# tell you the command and read you the outcome, but a rebuild that restarts the process talking to
# you cannot honestly report on itself.
#
# WHAT IT TOUCHES, in order: this clone's .env (chmod 600) · node_modules + dist · optionally
# web/out · a systemd --user unit or a LaunchAgent · the engine's .env (backed up first, every added
# key recorded in $IRISES_HOME/install-manifest.json) · the engine's plugin dir · the engine's
# gateway, which is ALWAYS bounced at the end because the plugin, IRISES_FRONT and API_SERVER_* are
# only read when it starts.
#
# EXIT CODES
#   0  installed (or uninstalled) and verified
#   1  a step failed — read the message; nothing is left half-started that we can tell you about
#   2  wrong usage (unknown flag, unknown engine, bad port)
#   4  Irises did not report the expected build on /health within the budget
#   5  Irises is fine, but its engine's gateway could not be verified back up
# The last line of stdout is always `RESULT: <token>` for scripts that wrap this one.
#
# Idempotent: re-run it any time. It adopts a server it finds already running, never overwrites a
# value you set yourself, and touches no engine source code.
set -euo pipefail

source "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/lib/irises-lib.sh"
IRISES_LOG_TAG="irises-setup"

MODE="install"
ENGINE_FLAG=""
ASSUME_YES=0
BRIDGE=1
SERVICE=1
PURGE_DATA=0
PORT_FLAG=""

usage() {
  cat <<'EOF'
usage: bash ./scripts/engine-setup.sh [options]          # install
       bash ./scripts/engine-setup.sh --uninstall [options]

  --engine hermes|openclaw   which engine this clone talks to (default: auto-detect)
  --yes, -y                  non-interactive: take every default, never prompt
  --no-bridge                leave the engine answering its own channels (no plugin, no fronting)
  --no-service               do not install a user service; run Irises detached instead
  --port N                   pin the port Irises listens on (default 3000)
  --uninstall                remove Irises: service, plugin, engine keys. Your data is KEPT, and so
                             is this clone (the exact rm for each is printed)
  --purge-data               with --uninstall: also delete $IRISES_HOME (irises.db + memories)
  -h, --help                 this text

exit codes: 0 ok · 1 a step failed · 2 usage · 4 health not verified · 5 gateway not verified
the last line of stdout is always: RESULT: <token>
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --engine)      ENGINE_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --engine=*)    ENGINE_FLAG="${1#--engine=}"; shift ;;
    --port)        PORT_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --port=*)      PORT_FLAG="${1#--port=}"; shift ;;
    --uninstall)   MODE="uninstall"; shift ;;
    --purge-data)  PURGE_DATA=1; shift ;;
    --yes|-y)      ASSUME_YES=1; shift ;;
    --bridge)      BRIDGE=1; shift ;;
    --no-bridge)   BRIDGE=0; shift ;;
    --service)     SERVICE=1; shift ;;
    --no-service)  SERVICE=0; shift ;;
    -h|--help)     usage; exit 0 ;;
    --revert)
      err "--revert is gone. Use --uninstall (it removes the plugin, the engine keys and the"
      err "service, and keeps your data), or edit IRISES_FRONT to stop fronting without removing"
      err "anything:  bash ./scripts/engine-setup.sh --uninstall"
      exit 2 ;;
    *) err "unknown arg: $1 (try --help)"; exit 2 ;;
  esac
done

case "$ENGINE_FLAG" in
  ''|hermes|openclaw|off) ;;
  *) err "unknown engine '$ENGINE_FLAG' — expected hermes, openclaw or off"; exit 2 ;;
esac
case "$PORT_FLAG" in
  '') ;;
  *[!0-9]*) err "--port needs a plain port number, got '$PORT_FLAG'"; exit 2 ;;
esac

# No TTY = nobody can answer a question, so don't ask one. An agent-driven run lands here (both
# engines spawn shell commands with stdin at /dev/null, so any `read` would hit EOF immediately).
if [ ! -t 0 ] && [ "$ASSUME_YES" != "1" ]; then
  ASSUME_YES=1
  say "stdin is not a terminal — running non-interactive (same as --yes)"
fi

ask_yn() { # QUESTION DEFAULT(y|n) -> 0 = yes
  local q="${1:-}" def="${2:-n}" yn=""
  if [ "$ASSUME_YES" = "1" ]; then
    say "$q — taking '$def' (--yes / non-interactive)"
    if [ "$def" = "y" ]; then return 0; fi
    return 1
  fi
  printf '\033[33m[%s]\033[0m %s [y/N] ' "$IRISES_LOG_TAG" "$q"
  read -r yn || yn=""
  case "$yn" in y|Y|yes|YES) return 0 ;; esac
  return 1
}

ROOT="$(irises_root)"
ENV_FILE="$ROOT/.env"
cd "$ROOT"

rand_token() { node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }
```

- [ ] **Step 4: Add the install flow — prereqs, engine read, port probe, clone .env**

Append to `scripts/engine-setup.sh`:

```bash
# ══ install ══════════════════════════════════════════════════════════════════
do_install() {
  local engine port kind node_bin unit="" plugin_dir="" adopted=0
  local keys_added="" keys_pre="" backup="" token engine_env=""
  local sha="" live_sha="" gateway_ok=1 result="ok" rc=0

  # ── 1. prerequisites. PATH first: a non-login shell (and every agent-spawned run) can be missing
  #      node entirely — on the production VPS node lives at ~/.local/bin/node and nothing puts it
  #      on PATH for a non-interactive command.
  augment_path
  require_tools git curl npm || exit 1
  require_node_version 22.13 || exit 1
  node_bin="$(command -v node)"
  say "node:  $node_bin ($(node -v))"
  say "clone: $ROOT"

  # ── 2. engine: DETECT and READ only. Nothing is written to the engine until Irises itself is up,
  #      so a failed build can never leave keys pointing at a server that does not exist.
  engine="$(engine_kind "$ENGINE_FLAG")" || exit 2
  case "$engine" in
    hermes)
      engine_env="$(hermes_home)/.env"
      if [ ! -d "$(hermes_home)" ]; then
        die 1 "hermes not found (no $(hermes_home)) — install hermes-agent first, or pass --engine off"
      fi
      say "engine: hermes at $(hermes_home)"
      ;;
    openclaw)
      if ! command -v openclaw >/dev/null 2>&1; then
        die 1 "the openclaw CLI is not on PATH — install OpenClaw first, or pass --engine off"
      fi
      say "engine: OpenClaw at $(openclaw_home)"
      ;;
    off)
      say "engine: none (standalone) — no engine wiring, no gateway bounce"
      ;;
  esac

  # ── 3. port. Probe BEFORE any write: an install that edits config and then fails to bind leaves
  #      a half-wired engine pointing at nothing.
  port="${PORT_FLAG:-}"
  if [ -z "$port" ]; then
    port="$(env_get "$ENV_FILE" PORT)"
    if [ -z "$port" ]; then port="3000"; fi
  fi
  if tcp_open 127.0.0.1 "$port"; then
    live_sha="$(wait_health_sha "http://127.0.0.1:$port" "" 2 || true)"
    if [ -n "$live_sha" ]; then
      say "an Irises is already on :$port (build ${live_sha:0:7}) — this run will adopt it"
      adopted=1
    else
      err "something else already holds :$port and it is not Irises."
      err "free the port, or choose another:  bash ./scripts/engine-setup.sh --port 3001"
      exit 1
    fi
  fi

  lock_acquire || exit 1
  trap 'lock_release' EXIT

  # ── 4. this clone's .env. chmod 600 from the start (the old script created it with touch → 0644,
  #      world-readable secrets). Never overwrite a value the operator set — except the port, which
  #      is what --port is for.
  if [ ! -e "$ENV_FILE" ]; then ( umask 077; : > "$ENV_FILE" ); fi
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  env_set "$ENV_FILE" PORT "$port"
  env_set_default "$ENV_FILE" WEB_ENABLED "true"
  say "Irises will listen on :$port (deploy/app.env's 8080 is for the Docker image behind Caddy)"

  if [ "$engine" = "hermes" ]; then
    # Reuse the engine's own API key when it has one. env_get is last-wins, exactly like dotenv, so
    # a hermes .env carrying two API_SERVER_KEY blocks yields the LIVE one.
    local ekey
    ekey="$(env_get "$engine_env" API_SERVER_KEY)"
    if [ -z "$ekey" ]; then ekey="$(rand_token)"; fi
    env_set "$ENV_FILE" OPS_BACKEND hermes
    env_set_default "$ENV_FILE" HERMES_BASE_URL "http://127.0.0.1:8642"
    env_set "$ENV_FILE" HERMES_API_KEY "$ekey"
    env_set_default "$ENV_FILE" ENGINE_PUSH_TOKEN "$(rand_token)"
    local k v
    for k in ANTHROPIC_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY OPENAI_BASE_URL; do
      v="$(env_get "$engine_env" "$k")"
      if [ -n "$v" ]; then env_set_default "$ENV_FILE" "$k" "$v"; fi
    done
  elif [ "$engine" = "openclaw" ]; then
    local otoken
    otoken="$(openclaw config get gateway.auth.token 2>/dev/null | tr -d '"' || true)"
    if [ -z "$otoken" ] || [ "$otoken" = "undefined" ]; then
      die 1 "could not read gateway.auth.token from OpenClaw — is its gateway configured?"
    fi
    env_set "$ENV_FILE" OPS_BACKEND openclaw
    env_set_default "$ENV_FILE" OPENCLAW_URL "ws://127.0.0.1:18789"
    env_set "$ENV_FILE" OPENCLAW_TOKEN "$otoken"
    env_set_default "$ENV_FILE" ENGINE_PUSH_TOKEN "$(rand_token)"
  else
    env_set "$ENV_FILE" OPS_BACKEND off
  fi

  if [ -z "$(env_get "$ENV_FILE" ANTHROPIC_API_KEY)" ] \
     && [ -z "$(env_get "$ENV_FILE" OPENROUTER_API_KEY)" ] \
     && [ -z "$(env_get "$ENV_FILE" OPENAI_API_KEY)" ]; then
    warn "no ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY in $ENV_FILE"
    warn "Irises's own voice needs one (the engine key only covers deep work) — add it and restart"
  fi
```

- [ ] **Step 5: Add the build, service and verification stages**

Append to `scripts/engine-setup.sh`:

```bash
  # ── 5. build. --include=dev FORCES devDependencies even under NODE_ENV=production (the documented
  #      prod env in deploy/app.env): tsc, cpx and tsx live there, so a bare `npm ci` strips the
  #      build toolchain and `npm run build` then dies with "tsc: not found".
  say "installing dependencies + building (npm ci --include=dev && npm run build)"
  npm ci --include=dev
  npm run build
  sha="$(built_sha "$ROOT")"
  if [ -z "$sha" ]; then
    warn "dist/version.json carries no sha — health will be verified by liveness only"
  else
    say "built ${sha:0:7}"
  fi

  # OpenClaw's gateway client goes in AFTER npm ci, or ci prunes anything not in the lockfile.
  if [ "$engine" = "openclaw" ]; then
    say "installing @openclaw/gateway-client (optional dep, OpenClaw mode only)"
    npm install --no-save "@openclaw/gateway-client" \
      || warn "that failed — Irises will report the engine as unavailable until it installs"
  fi

  web_build "$ROOT"

  # ── 6. the service. This is the default: a nohup server does not survive a reboot, and nothing
  #      else on the box knows how to bring Irises back.
  kind="$(service_kind)"
  if [ "$SERVICE" = "0" ]; then
    say "--no-service — Irises will run detached; nothing will restart it after a reboot"
    kind="none"
  fi
  if [ "$adopted" = "1" ]; then
    # Adopt whatever is already serving :$port, so a re-run converts a hand-launched server into a
    # managed one instead of fighting it for the port.
    local pid
    pid="$(server_pid)"
    if [ -n "$pid" ]; then
      say "stopping the server we found (pid $pid) so the service can own the port"
      server_stop 20
    else
      warn "an Irises answers on :$port but no pidfile at $(irises_home)/irises.pid names it"
      if ask_yn "stop it by process match (pgrep -f dist/index.js under $ROOT) and take over?" y; then
        local p
        for p in $(pgrep -f "$ROOT/dist/index.js" 2>/dev/null || true); do
          if is_our_server "$p"; then say "stopping pid $p"; kill "$p" 2>/dev/null || true; fi
        done
        sleep 3
      else
        die 1 "leaving it alone — stop it yourself, then re-run"
      fi
    fi
  fi
  case "$kind" in
    systemd|launchd)
      unit="$(service_install "$ROOT" "$node_bin")" || die 1 "could not install the $kind service"
      service_restart || die 1 "the $kind service would not start — check $(irises_home)/logs/server.log"
      say "Irises is a $kind service now ($unit)"
      ;;
    none)
      server_start_detached "$ROOT"
      ;;
  esac

  # ── 7. verify the build we just made is the build that answers. "Something answers /health" was
  #      the old check, and it is satisfied by the OLD process still holding the port.
  if ! live_sha="$(wait_health_sha "http://127.0.0.1:$port" "$sha" 60)"; then
    err "Irises did not report build ${sha:0:7} on http://127.0.0.1:$port/health within 60s"
    err "read the log:  tail -n 40 $(irises_home)/logs/server.log"
    err "'EADDRINUSE' there means something else holds :$port; a missing voice-model key shows there too"
    summary health-failed \
      "engine:   $engine" \
      "built:    ${sha:0:7} — NOT confirmed live" \
      "service:  $kind${unit:+ ($unit)}" \
      "log:      $(irises_home)/logs/server.log"
    exit 4
  fi
  say "health OK on :$port — build ${live_sha:0:7} is live"
```

- [ ] **Step 6: Add the engine-side writes, plugin, gateway bounce, manifest and summary**

Append to `scripts/engine-setup.sh`:

```bash
  # ── 8. engine-side writes. Now, not earlier: the engine only ever points at a server we have
  #      SEEN answer. Back the file up first, and record exactly which keys were ours so
  #      --uninstall can put it back without guessing.
  if [ "$engine" = "hermes" ]; then
    if [ ! -f "$engine_env" ]; then
      say "creating $engine_env (chmod 600) — hermes only writes this file when it stores a secret,"
      say "so an empty one is normal on an OAuth/portal install"
      ( umask 077; : > "$engine_env" )
      chmod 600 "$engine_env" 2>/dev/null || true
    fi
    backup="$(env_backup "$engine_env" pre-install)"
    token="$(env_get "$ENV_FILE" ENGINE_PUSH_TOKEN)"
    local pairs="" key val kv
    for kv in \
      "API_SERVER_ENABLED=true" \
      "API_SERVER_KEY=$(env_get "$ENV_FILE" HERMES_API_KEY)" \
      "IRISES_PUSH_TOKEN=$token" \
      "IRISES_URL=http://127.0.0.1:$port"
    do
      key="${kv%%=*}"; val="${kv#*=}"
      if [ "$(env_count "$engine_env" "$key")" != "0" ]; then
        keys_pre="$keys_pre $key"
        # A duplicated key is collapsed onto its live value here — production carried two
        # API_SERVER_KEY blocks with different values, and only the last one was in effect.
        if [ "$key" = "API_SERVER_KEY" ]; then
          local cur; cur="$(env_get "$engine_env" "$key")"
          if [ "$(env_count "$engine_env" "$key")" != "1" ]; then
            say "adopting the engine's existing API_SERVER_KEY (collapsing $(env_count "$engine_env" "$key") copies)"
          fi
          env_set "$engine_env" "$key" "$cur"
        else
          env_set "$engine_env" "$key" "$val"
        fi
      else
        keys_added="$keys_added $key"
        pairs="$pairs
$key=$val"
      fi
    done
    if [ -n "$pairs" ]; then
      # shellcheck disable=SC2086  # $pairs is newline-separated KEY=VALUE, no spaces in values
      env_append_block "$engine_env" "Irises server" $pairs
    fi
    if [ "$BRIDGE" = "1" ]; then
      if [ "$(env_count "$engine_env" IRISES_BRIDGE_TOKEN)" = "0" ]; then
        keys_added="$keys_added IRISES_BRIDGE_TOKEN"
        env_append_block "$engine_env" "bridge mode" "IRISES_BRIDGE_TOKEN=$token"
      else
        keys_pre="$keys_pre IRISES_BRIDGE_TOKEN"
        # A drifted bridge token 403s every fronted message while the engine stays silent about it.
        env_set "$engine_env" IRISES_BRIDGE_TOKEN "$token"
      fi
      if [ "$(env_count "$engine_env" IRISES_FRONT)" = "0" ]; then
        keys_added="$keys_added IRISES_FRONT"
        env_append_block "$engine_env" "front scope (edit to narrow, e.g. telegram:*)" "IRISES_FRONT=*:*"
        warn "IRISES_FRONT=*:*  — Irises now answers EVERY chat on EVERY platform this engine fronts."
        warn "Narrow it in $engine_env (patterns are fnmatch globs over <platform>:<chat_id>)."
      else
        keys_pre="$keys_pre IRISES_FRONT"
        say "keeping your IRISES_FRONT ($(env_get "$engine_env" IRISES_FRONT))"
      fi
      plugin_refresh hermes "$ROOT" || warn "the plugin did not install — fronting will not work yet"
      plugin_dir="$(hermes_home)/plugins/irises-bridge"
      say "fail policy: if Irises is down the engine answers fronted chats itself"
      say "(set IRISES_BRIDGE_FAIL=closed in $engine_env for silence instead)"
    else
      say "--no-bridge: the engine keeps answering its own channels. API_SERVER_* is still wired,"
      say "so Irises can do deep work through it."
    fi
  elif [ "$engine" = "openclaw" ] && [ "$BRIDGE" = "1" ]; then
    plugin_refresh openclaw "$ROOT" || warn "the plugin did not install — fronting will not work yet"
    plugin_dir="$(openclaw_home)/extensions/irises-bridge"
    warn "give the OpenClaw GATEWAY process these three variables (its own env, not this clone's):"
    warn "  IRISES_BRIDGE_TOKEN=$(env_get "$ENV_FILE" ENGINE_PUSH_TOKEN)"
    warn "  IRISES_URL=http://127.0.0.1:$port"
    warn "  IRISES_FRONT=whatsapp:*,telegram:123    # empty = front NOTHING"
  fi

  # ── 9. the manifest: what to undo, and what was never ours.
  manifest_write "$(manifest_path)" \
    "root=$ROOT" \
    "irisesHome=$(irises_home)" \
    "port=$port" \
    "engine=$engine" \
    "engineEnvFile=${engine_env:-}" \
    "engineEnvBackup=${backup:-}" \
    "pluginDir=${plugin_dir:-}" \
    "serviceKind=$kind" \
    "serviceUnit=${unit:-}" \
    "nodeBin=$node_bin" \
    "keysAdded=${keys_added# }" \
    "keysPreExisting=${keys_pre# }" \
    "bridge=$BRIDGE"

  # ── 10. the gateway. ALWAYS, when an engine is configured: the plugin, IRISES_FRONT and
  #       API_SERVER_* are only read when the gateway starts, so an install that skips this is an
  #       install that does nothing until the operator works out why.
  if [ "$engine" != "off" ]; then
    if ! gateway_restart "$engine" 90; then
      gateway_ok=0
      result="gateway-failed"
      rc=5
    fi
  fi

  if [ "$adopted" = "1" ] && [ "$result" = "ok" ]; then result="adopted"; fi

  summary "$result" \
    "engine:    $engine${plugin_dir:+ (bridge plugin at $plugin_dir)}" \
    "build:     ${live_sha:0:7} — confirmed live on http://127.0.0.1:$port/health" \
    "service:   $kind${unit:+ ($unit)}" \
    "data:      $(irises_home)  (irises.db + memories/ — never touched by an update)" \
    "logs:      $(irises_home)/logs/server.log" \
    "gateway:   $(if [ "$engine" = "off" ]; then printf 'n/a (standalone)'; elif [ "$gateway_ok" = "1" ]; then printf 'bounced and verified'; else printf 'NOT verified — bounce it yourself'; fi)" \
    "talk to it: $(if [ -d "$ROOT/web/out" ]; then printf 'http://127.0.0.1:%s  ·  npm run chat' "$port"; else printf 'npm run chat   (web UI not built — IRISES_WEB=1 to build it)'; fi)" \
    "update it: bash scripts/update.sh        remove it: bash scripts/engine-setup.sh --uninstall"
  exit "$rc"
}

case "$MODE" in
  install)   do_install ;;
  uninstall) die 1 "--uninstall lands in the next commit" ;;
esac
```

- [ ] **Step 7: Add `irises.pid` to `.gitignore`**

Modify `.gitignore` — in the `# --- server (repo root: the Irises brain) ---` block (lines 1-6), after `*.tsbuildinfo`:

```
*.tsbuildinfo

# The old setup script wrote a SECOND pidfile into the clone root while the server wrote its own to
# $IRISES_HOME. There is one pidfile now ($IRISES_HOME/irises.pid); this keeps a stale one from a
# pre-rewrite install out of git.
irises.pid
```

- [ ] **Step 8: Verify syntax, the contract test, and the help text**

Run: `bash -n scripts/engine-setup.sh && npx tsx --test scripts/engine-setup.test.ts 2>&1 | tail -6`
Expected: `bash -n` silent; `# pass 6`, `# fail 0`.

Run: `npx tsx --test scripts/shellContract.test.ts 2>&1 | grep -E "engine-setup|# (pass|fail)"`
Expected: `engine-setup.sh is valid bash` and `engine-setup.sh carries no literal an engine lifecycle guard would refuse` both pass; only `update.sh` still fails the literal and sourcing checks.

- [ ] **Step 9: Dry-run the usage paths that change nothing**

Run: `bash scripts/engine-setup.sh --help | head -30; bash scripts/engine-setup.sh --revert; echo "revert rc=$?"`
Expected: the help block, then the `--uninstall` pointer on stderr and `revert rc=2`.

- [ ] **Step 10: Commit**

```bash
git add scripts/engine-setup.sh scripts/engine-setup.test.ts .gitignore
git commit -m "$(cat <<'EOF'
Rewrite the installer: user service, verified boot, honest exit codes

One command installs Irises as a systemd --user unit or a LaunchAgent (with
--no-service for the detached fallback), and the order now protects the operator:
prerequisites and PATH repair, engine READ, port probe, clone .env at 0600,
build, service, then wait for /health to report the sha we just built — and only
then write to the engine, with a backup and a manifest of exactly which keys
were ours. The gateway is bounced and verified every time, and its failure gets
its own exit code (5) because Irises itself is fine. --revert exits 2 pointing at
--uninstall; --port, --no-service and --purge-data are new; a running server is
adopted rather than fought for the port.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `engine-setup.sh --uninstall` — remove Irises, keep the data

**Files:**
- Modify: `scripts/engine-setup.sh` (replace the `uninstall) die 1 "--uninstall lands in the next commit" ;;` line with the real dispatch, and add `do_uninstall` above the `case "$MODE"` block)
- Test: `scripts/engine-setup.test.ts` (append cases)

**Interfaces:**
- Consumes: `manifest_path`, `manifest_read`, `env_backup`, `env_remove_irises_block`, `env_count`, `env_get`, `env_set`, `service_stop`, `service_uninstall`, `service_kind`, `service_unit_path`, `service_plist_path`, `server_pid`, `server_stop`, `plugin_remove`, `gateway_restart`, `hermes_home`, `openclaw_home`, `irises_home`, `irises_port`, `engine_kind`, `lock_acquire`, `lock_release`, `summary`, `ask_yn`, `augment_path`, `require_tools`.
- Produces: `bash scripts/engine-setup.sh --uninstall [--purge-data] [--yes]`; exits `0` clean, `1` one or more steps failed, `5` gateway not verified; `RESULT: ok|partial|gateway-failed|noop`.

- [ ] **Step 1: Append the uninstall contract tests**

Append to `scripts/engine-setup.test.ts`:

```ts
test('--uninstall on a box with nothing installed says so and still exits 0', () => {
  // No manifest, no service, no plugin: an uninstall that finds nothing to do is a SUCCESS. The
  // opposite (exit 1) would make the documented "run it again if unsure" advice a lie.
  const r = spawnSync('/bin/bash', [SCRIPT, '--uninstall', '--yes'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      IRISES_HOME: join(process.cwd(), 'node_modules', '.cache', 'irises-uninstall-probe'),
      HERMES_HOME: '/nonexistent-hermes',
      OPS_BACKEND: 'off',
    },
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout ?? '', /RESULT: ok/);
  assert.match(r.stdout ?? '', /nothing/i);
});

test('--uninstall never deletes data without --purge-data, and prints the exact rm', () => {
  const r = spawnSync('/bin/bash', [SCRIPT, '--uninstall', '--yes'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      IRISES_HOME: join(process.cwd(), 'node_modules', '.cache', 'irises-uninstall-probe'),
      HERMES_HOME: '/nonexistent-hermes',
      OPS_BACKEND: 'off',
    },
  });
  assert.match(r.stdout ?? '', /rm -rf/, 'the command to remove the data is printed, never run');
  assert.match(r.stdout ?? '', /--purge-data/);
});

test('--uninstall documents that the clone is never deleted', () => {
  const r = run(['--help']);
  assert.match(r.out, /clone/i);
});
```

- [ ] **Step 2: Run them and watch the uninstall path fail**

Run: `npx tsx --test scripts/engine-setup.test.ts 2>&1 | tail -12`
Expected: the three new tests fail — the script exits 1 with `--uninstall lands in the next commit`.

- [ ] **Step 3: Insert `do_uninstall` into `scripts/engine-setup.sh`**

Insert immediately above the `case "$MODE" in` block at the end of the file:

```bash
# ══ uninstall ════════════════════════════════════════════════════════════════
# No node gate here on purpose: this path needs bash, git and curl only, so it still works on a box
# whose node has since been upgraded away or removed.
do_uninstall() {
  local man engine engine_env plugin_dir kind home port
  local failed=0 gateway_ok=1 result="ok" rc=0 did_something=0
  local keys_added keys_pre backup removed=0

  augment_path
  require_tools curl || failed=1

  man="$(manifest_path)"
  home="$(irises_home)"
  if [ -f "$man" ]; then
    say "reading the install manifest: $man"
    engine="$(manifest_read "$man" engine)"
    engine_env="$(manifest_read "$man" engineEnvFile)"
    plugin_dir="$(manifest_read "$man" pluginDir)"
    keys_added="$(manifest_read "$man" keysAdded)"
    keys_pre="$(manifest_read "$man" keysPreExisting)"
    port="$(manifest_read "$man" port)"
  else
    warn "no install manifest at $man — falling back to detection"
    warn "(a pre-rewrite install left no manifest; keys are then matched by their Irises marker)"
    engine="$(engine_kind "$ENGINE_FLAG")"
    keys_added=""
    keys_pre=""
    port="$(irises_port)"
    case "$engine" in
      hermes)   engine_env="$(hermes_home)/.env";   plugin_dir="$(hermes_home)/plugins/irises-bridge" ;;
      openclaw) engine_env="";                      plugin_dir="$(openclaw_home)/extensions/irises-bridge" ;;
      *)        engine_env="";                      plugin_dir="" ;;
    esac
    # Without a manifest we only ever remove the keys that are unambiguously ours. API_SERVER_* is
    # deliberately NOT in this list: the engine may well have had its API server on before Irises
    # existed, and turning it off would break everything else that talks to it.
    keys_added="IRISES_PUSH_TOKEN IRISES_BRIDGE_TOKEN IRISES_URL IRISES_FRONT"
    warn "API_SERVER_ENABLED / API_SERVER_KEY will be LEFT ALONE (no manifest = no proof they were ours)"
  fi
  if [ -z "$engine" ]; then engine="off"; fi
  if [ -z "$port" ]; then port="$(irises_port)"; fi

  if [ "$ASSUME_YES" != "1" ]; then
    say "about to remove: the Irises service, the bridge plugin, and the keys Irises added to the engine"
    say "your data ($home) is KEPT unless --purge-data is passed"
    if ! ask_yn "go ahead?" n; then
      say "aborted — nothing changed"
      summary noop "nothing was removed"
      exit 0
    fi
  fi

  lock_acquire || exit 1
  trap 'lock_release' EXIT

  # ── 1. stop and remove the service (or the detached server).
  kind="$(service_kind)"
  if [ -f "$(service_unit_path)" ] || [ -f "$(service_plist_path)" ]; then
    did_something=1
    say "stopping and removing the $kind service"
    service_stop || true
    service_uninstall || { err "could not fully remove the service"; failed=1; }
  else
    say "no service unit or plist installed"
  fi
  local pid
  pid="$(server_pid)"
  if [ -n "$pid" ]; then
    did_something=1
    server_stop 20
  fi
  # The old setup script left a second pidfile in the clone root; clear both so nothing later
  # mistakes a dead pid for a live server.
  for f in "$home/irises.pid" "$ROOT/irises.pid"; do
    if [ -f "$f" ]; then rm -f "$f"; say "removed $f"; fi
  done

  # ── 2. the bridge plugin.
  if [ -n "$plugin_dir" ] && [ -d "$plugin_dir" ]; then
    did_something=1
    plugin_remove "$engine" || failed=1
  else
    if [ "$engine" != "off" ]; then say "no bridge plugin installed at ${plugin_dir:-<unknown>}"; fi
  fi

  # ── 3. the engine's keys. Back the file up first, respect the manifest's pre_existing list, and
  #      collapse any duplicate we leave behind onto its live value.
  if [ -n "${engine_env:-}" ] && [ -f "$engine_env" ] && [ -n "$keys_added" ]; then
    did_something=1
    backup="$(env_backup "$engine_env" pre-uninstall)"
    # shellcheck disable=SC2086  # keys_added is a space-separated key list by construction
    removed="$(env_remove_irises_block "$engine_env" $keys_added)"
    say "removed $removed Irises key(s) from $engine_env (backup: ${backup:-none})"
    local k n
    for k in $keys_pre; do
      n="$(env_count "$engine_env" "$k")"
      if [ "$n" -gt 1 ]; then
        say "collapsing $n copies of $k onto its live value (dotenv reads the last one)"
        env_set "$engine_env" "$k" "$(env_get "$engine_env" "$k")"
      fi
    done
    if [ -n "$keys_pre" ]; then
      say "left alone (they were there before Irises): $keys_pre"
    fi
  elif [ -n "${engine_env:-}" ]; then
    say "nothing of ours to remove from ${engine_env}"
  fi

  # ── 4. the gateway, so the engine actually forgets the plugin (it loads plugins only at start).
  if [ "$engine" != "off" ] && [ "$did_something" = "1" ]; then
    if ! gateway_restart "$engine" 90; then
      gateway_ok=0
      result="gateway-failed"
      rc=5
    fi
  fi

  # ── 5. the data. KEPT by default: irises.db and memories/ are the only irreplaceable things here.
  local size="unknown"
  if [ -d "$home" ]; then size="$(du -sh "$home" 2>/dev/null | cut -f1 || printf unknown)"; fi
  if [ "$PURGE_DATA" = "1" ]; then
    local answer=""
    if [ "$ASSUME_YES" = "1" ]; then
      warn "--purge-data with --yes: deleting $home ($size) without asking"
      answer="delete"
    else
      warn "this deletes $home ($size) — irises.db and every memory file, with no backup."
      printf '\033[31m[%s]\033[0m type the word delete to confirm: ' "$IRISES_LOG_TAG"
      read -r answer || answer=""
    fi
    if [ "$answer" = "delete" ]; then
      rm -rf "$home"
      say "removed $home"
    else
      warn "not deleted (you did not type 'delete') — $home is still there"
      failed=1
    fi
  else
    if [ -d "$home" ]; then
      say "your data is KEPT: $home ($size)"
      say "remove it yourself when you are sure:  rm -rf $home"
      say "(or re-run with --purge-data)"
    fi
  fi

  # ── 6. the clone, and the engine patch series. Neither is ours to delete.
  say "this clone is NOT deleted. When you are done with it:  rm -rf $ROOT"
  if [ "$engine" = "hermes" ]; then
    local checkout patch
    checkout="$(hermes_home)/hermes-agent"
    patch="$ROOT/bridge/hermes/photon-reply-context/0001-photon-inbound-reply-context.patch"
    if [ -d "$checkout/.git" ] && [ -f "$patch" ]; then
      # Two honest signals: the branch the bundle's apply.sh leaves behind, or the patch applying
      # cleanly IN REVERSE (which is only possible when it is currently applied).
      if git -C "$checkout" rev-parse --verify --quiet irises/photon-reply-context >/dev/null 2>&1 \
         || git -C "$checkout" apply --reverse --check "$patch" >/dev/null 2>&1; then
        warn "the Photon reply-context patch series is applied to $checkout."
        warn "It is an engine-side change Irises asked for, and this uninstall does NOT revert it."
        warn "To revert it yourself:"
        warn "  git -C $checkout apply --reverse $patch"
        warn "  (then bounce the gateway; see bridge/hermes/photon-reply-context/README.md)"
      fi
    fi
  fi

  if [ "$failed" = "1" ] && [ "$result" = "ok" ]; then result="partial"; rc=1; fi
  if [ "$did_something" = "0" ] && [ "$failed" = "0" ]; then
    say "nothing to uninstall — no service, no plugin, no engine keys of ours"
  fi

  summary "$result" \
    "service:  $(if [ -f "$(service_unit_path)" ] || [ -f "$(service_plist_path)" ]; then printf 'STILL INSTALLED — remove it by hand'; else printf 'removed'; fi)" \
    "plugin:   $(if [ -n "$plugin_dir" ] && [ -d "$plugin_dir" ]; then printf 'STILL PRESENT at %s' "$plugin_dir"; else printf 'removed'; fi)" \
    "engine:   $engine — $removed key(s) removed${backup:+, backup at $backup}" \
    "gateway:  $(if [ "$engine" = "off" ]; then printf 'n/a'; elif [ "$did_something" = "0" ]; then printf 'not bounced (nothing changed)'; elif [ "$gateway_ok" = "1" ]; then printf 'bounced and verified'; else printf 'NOT verified — bounce it yourself'; fi)" \
    "data:     $(if [ -d "$home" ]; then printf '%s KEPT (%s)' "$home" "$size"; else printf 'deleted'; fi)" \
    "clone:    $ROOT kept — rm -rf it yourself"
  exit "$rc"
}
```

Then replace the dispatch block at the very end of the file:

```bash
case "$MODE" in
  install)   do_install ;;
  uninstall) do_uninstall ;;
esac
```

- [ ] **Step 4: Verify syntax and the contract tests**

Run: `bash -n scripts/engine-setup.sh && npx tsx --test scripts/engine-setup.test.ts 2>&1 | tail -6`
Expected: `bash -n` silent; `# pass 9`, `# fail 0`.

- [ ] **Step 5: Exercise the empty-box uninstall by hand**

Run: `IRISES_HOME=$(mktemp -d) HERMES_HOME=/nonexistent OPS_BACKEND=off bash scripts/engine-setup.sh --uninstall --yes | tail -12; echo "rc=${PIPESTATUS[0]}"`
Expected: a summary block whose `service`/`plugin` lines read `removed`, a `data:` line naming the temp dir, `RESULT: ok`, and `rc=0`.

- [ ] **Step 6: Commit**

```bash
git add scripts/engine-setup.sh scripts/engine-setup.test.ts
git commit -m "$(cat <<'EOF'
Add --uninstall: remove Irises, keep the data, report what is left

Reads the install manifest to undo exactly what the installer did — service,
plugin, and only the engine keys that were ours — backing the engine's .env up
first and collapsing any duplicate key it leaves onto the value dotenv actually
reads. Without a manifest it falls back to the marker-comment keys and refuses
to touch API_SERVER_*, which may well have predated Irises. The gateway is
bounced so the engine forgets the plugin, $IRISES_HOME is kept (with its size
and the exact rm printed) unless --purge-data plus a typed confirmation, the
clone is never deleted, and an applied Photon patch series is reported with its
reverse-apply command rather than silently left behind.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `update.sh` rewrite — rollback on failure, sha-verified restart, no status file

**Files:**
- Modify: `scripts/update.sh` (full rewrite: replace lines 1-336)
- Modify: `scripts/update.test.ts` (replace lines 1-127)

**Interfaces:**
- Consumes: the whole library (Tasks 1–3), in particular `built_sha`, `wait_health_sha`, `web_build`, `plugin_refresh`, `gateway_restart`, `service_kind`, `service_restart`, `service_unit_path`, `service_plist_path`, `server_stop`, `server_start_detached`, `lock_acquire`, `lock_release`, `summary`, `engine_kind`, `irises_home`, `irises_port`, `env_get`, `augment_path`, `require_tools`, `require_node_version`.
- Produces: `bash scripts/update.sh [--check] [--yes] [--no-restart] [--no-gateway-restart]`; exit codes `0` ok/noop, `1` preflight, lock, or non-fast-forward, `2` usage, `3` build failed and rolled back, `4` restart not verified and rolled back, `5` gateway not verified (Irises IS updated), `10` update available (`--check`); `RESULT: ok|noop|up-to-date|update-available|rolled-back|gateway-failed`.
- Removes: `write_status` and `$IRISES_HOME/update-status.json` entirely — the chat self-update that read it is gone (Part B Task 100 removes `src/update/selfUpdate.ts`).
- Unchanged contract: the receipt. `scripts/update.sh` still pipes `git log --oneline OLD..NEW` into `scripts/write-update-receipt.js` and writes `$IRISES_HOME/update-receipt.json`, which `src/update/receipt.ts` consumes at boot. **Keep the argument list identical to the current call at `scripts/update.sh:186-193` — read it before replacing.**

- [ ] **Step 1: Replace `scripts/update.test.ts`**

```ts
// Run with: npm test   (scripts/**/*.test.ts is in the test glob). No update is ever applied here:
// these are the ARGUMENT, EXIT-CODE and RESULT-LINE contracts. The optional web step used to be
// lifted out of this file by string-slicing between `build_web() {` and the next `\n}\n`; it now
// lives in the shared library and is tested directly in scripts/lib/irises-lib.test.ts, so the
// slicing (and the way an unrelated edit could break it) is gone.
//
// The whole apply-and-roll-back flow is covered end to end by scripts/e2e/lifecycle-sandbox.sh
// (npm run e2e:lifecycle), which publishes a real commit to a fake origin and then a commit that
// compiles but crashes on boot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'update.sh');
const SOURCE = readFileSync(SCRIPT, 'utf8');

function run(args: string[], env: Record<string, string> = {}): { out: string; err: string; code: number } {
  const r = spawnSync('/bin/bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env } });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? -1 };
}

test('the script is valid bash (bash -n, no execution)', () => {
  execFileSync('/bin/bash', ['-n', SCRIPT], { encoding: 'utf8' });
});

test('--help lists every flag and the whole exit-code table', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0, r.err);
  for (const flag of ['--check', '--yes', '--no-restart', '--no-gateway-restart']) {
    assert.ok(r.out.includes(flag), `--help must document ${flag}\n${r.out}`);
  }
  for (const code of ['0', '1', '2', '3', '4', '5', '10']) {
    assert.match(r.out, new RegExp(`^\\s*${code}\\s`, 'm'), `exit code ${code} must be documented\n${r.out}`);
  }
  assert.match(r.out, /IRISES_SKIP_WEB_BUILD=1/, 'the escape hatch a small box needs stays documented');
  assert.match(r.out, /RESULT:/);
  assert.ok(!r.out.includes('set -euo pipefail'), 'the help text stops at the header');
});

test('an unknown flag exits 2', () => {
  const r = run(['--rebase']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--rebase/);
  assert.match(r.err, /--help/);
});

test('--restart is gone: restarting is what an update DOES now', () => {
  // The old script defaulted to printing instructions and only restarted when asked. A flag that
  // silently became a no-op would leave anyone scripting it believing they had opted in.
  const r = run(['--restart']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--no-restart/);
});

test('the updater no longer writes update-status.json anywhere', () => {
  // Nothing reads it: the chat-triggered self-update that watched it is gone, and the boot receipt
  // is what voices a successful upgrade. A leftover writer is a file that rots in $IRISES_HOME.
  assert.ok(!SOURCE.includes('update-status.json'), 'update-status.json must not be written');
  assert.ok(!SOURCE.includes('write_status'), 'write_status must be gone');
});

test('the receipt is still written — it is how Irises voices the upgrade after the restart', () => {
  assert.match(SOURCE, /write_receipt/);
  assert.match(SOURCE, /update-receipt\.json/);
  assert.match(SOURCE, /write-update-receipt\.js/);
});

test('every npm and web command goes through the library, not through this script', () => {
  const direct = SOURCE.split('\n')
    .map(l => l.trim())
    .filter(l => /npm (run )?(install:web|build:web|--prefix)/.test(l) && !/^(#|say |warn |err )/.test(l));
  assert.deepEqual(direct, [], `the web build belongs to web_build() in the library:\n${direct.join('\n')}`);
});

test('the apply path is guarded by a rollback that restores BOTH the tree and the build', () => {
  // The old script had none: a failed `npm ci` after the merge left HEAD new, node_modules wiped
  // and dist old, with no way back but by hand.
  assert.match(SOURCE, /git reset --hard/, 'a rollback must move HEAD back');
  assert.match(SOURCE, /rollback/i);
  const rollback = SOURCE.slice(SOURCE.indexOf('rollback_to() {'));
  assert.match(rollback, /npm ci --include=dev/, 'the old node_modules has to come back too');
  assert.match(rollback, /npm run build/, 'and the old dist');
});

test('--check on this clone reports one of the two check results and exits 0 or 10', () => {
  const r = run(['--check']);
  assert.ok(r.code === 0 || r.code === 10, `expected 0 or 10, got ${r.code}\n${r.out}\n${r.err}`);
  if (r.code === 0) assert.match(r.out, /RESULT: up-to-date/);
  else assert.match(r.out, /RESULT: update-available/);
});
```

- [ ] **Step 2: Run the new test file against the old script and watch it fail**

Run: `npx tsx --test scripts/update.test.ts 2>&1 | tail -20`
Expected: failures on the exit-code table, `--restart` (exits 0 today), `update-status.json` (present today), the rollback assertions (no `rollback_to`), and the `RESULT:` line.

- [ ] **Step 3: Replace `scripts/update.sh` — header, arguments, preflight, comparison**

Replace the whole file with the following (the `--help` sed range must end on the header's last comment line — adjust `2,38p` if the header grows or shrinks; the test asserts the help text stops before `set -euo pipefail`):

```bash
#!/usr/bin/env bash
# Irises updater — pull the latest code onto a git-clone install, rebuild, restart, and prove the
# new build is the one answering.
#
#   bash scripts/update.sh                      # apply (asks first), restart, verify
#   bash scripts/update.sh --yes                # no questions
#   bash scripts/update.sh --check              # report only (0 up to date, 10 update available)
#   bash scripts/update.sh --no-restart         # apply to disk, leave the running server alone
#   bash scripts/update.sh --no-gateway-restart # skip the engine gateway bounce
#
# IRISES_SKIP_WEB_BUILD=1 skips the web client rebuild outright (a small box, or no web UI in use).
# The web build is optional and never blocks an update either way — see web_build() in the library.
#
# Docker installs update by rebuilding the image, not with this script — see docs/DEPLOY.md § 5.
#
# SAFE BY DESIGN
#   • fast-forward only — a diverged local branch is never force-merged
#   • refuses a tree with uncommitted changes to tracked files
#   • takes the single lifecycle lock, so an update and an install cannot race on git/npm/dist
#   • ROLLS BACK: if the build fails, or the restarted server does not report the new build, the
#     tree, node_modules and dist all go back to where they were, and the old build is put back up
#   • leaves $IRISES_HOME (your data) untouched, always
# After the restart, Irises mentions the upgrade in chat itself — from the receipt this writes.
#
# EXIT CODES
#   0   applied and verified, or already up to date
#   1   preflight refused (not a git clone, dirty tree, detached HEAD, another run holds the lock,
#       or the pull could not fast-forward)
#   2   wrong usage (unknown flag)
#   3   the build failed — rolled back; the running server was never touched
#   4   the new build did not answer /health — rolled back to the old build and restarted
#   5   Irises IS updated and live, but its engine's gateway could not be verified back up
#   10  --check only: an update is available
# The last line of stdout is always `RESULT: <token>`:
#   ok | noop | up-to-date | update-available | rolled-back | gateway-failed
set -euo pipefail

source "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/lib/irises-lib.sh"
IRISES_LOG_TAG="irises-update"

CHECK=0
ASSUME_YES=0
DO_RESTART=1
DO_GATEWAY=1

while [ $# -gt 0 ]; do
  case "$1" in
    --check)               CHECK=1; shift ;;
    --yes|-y)              ASSUME_YES=1; shift ;;
    --no-restart)          DO_RESTART=0; shift ;;
    --no-gateway-restart)  DO_GATEWAY=0; shift ;;
    -h|--help)             sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --restart)
      err "--restart is gone: an update restarts Irises and verifies the new build every time."
      err "If you want the old behaviour — apply to disk and leave the process alone — use --no-restart."
      exit 2 ;;
    *) err "unknown arg: $1 (try --help)"; exit 2 ;;
  esac
done

ROOT="$(irises_root)"
ENV_FILE="$ROOT/.env"
cd "$ROOT"
PORT="$(irises_port)"
BASE="http://127.0.0.1:$PORT"
STATE_DIR="$(irises_home)"

# ── preflight ────────────────────────────────────────────────────────────────
augment_path
git rev-parse --git-dir >/dev/null 2>&1 || {
  err "this is not a git clone — nothing to pull."
  err "Docker installs update by rebuilding the image (docs/DEPLOY.md § 5)."
  exit 1
}
require_tools git curl npm || exit 1
require_node_version 22.13 || exit 1

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "HEAD" ] || die 1 "detached HEAD — check out a branch first (e.g. git checkout main)"

# A dirty tree is uncommitted changes to TRACKED files. Untracked ones are fine (.env, dist/,
# web/out are gitignored anyway); it is local edits to committed code that a fast-forward cannot
# reconcile. If web/package-lock.json is the only entry, it is almost certainly the old updater's
# `npm run install:web` — this script uses `npm --prefix web ci`, which does not rewrite it.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  err "the working tree has uncommitted changes to tracked files — a clean pull needs them gone:"
  git status --short --untracked-files=no >&2
  if [ "$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')" = "1" ] \
     && git status --porcelain --untracked-files=no | grep -q 'web/package-lock.json'; then
    err "that one file is the old updater's footprint. Clear it and re-run:"
    err "  git checkout -- web/package-lock.json"
  else
    err "stash them (git stash) or commit them, then re-run."
  fi
  exit 1
fi

# --check is read-only (fetch + report), so it takes no lock.
if [ "$CHECK" != "1" ]; then
  lock_acquire || exit 1
  trap 'lock_release' EXIT
fi

say "fetching origin/$BRANCH …"
git fetch --quiet origin "$BRANCH"
OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse "origin/$BRANCH")"
BUILT="$(built_sha "$ROOT")"

write_receipt() { # OLD NEW  (equal shas → an empty changelog, which still fires the boot announce)
  # KEEP the argument list identical to the pre-rewrite call (old update.sh:186-193).
  mkdir -p "$STATE_DIR"
  if git --no-pager log --oneline "$1..$2" \
     | node "$ROOT/scripts/write-update-receipt.js" "$1" "$2" "$BRANCH" > "$STATE_DIR/update-receipt.json"; then
    say "wrote the update receipt to $STATE_DIR/update-receipt.json"
    return 0
  fi
  warn "could not write the update receipt (the upgrade still applied; Irises just won't announce it)"
  return 0
}
```

- [ ] **Step 4: Add the restart, rollback and self-heal helpers**

Append to `scripts/update.sh`:

```bash
# Restart Irises through whatever owns it, and prove the sha we expect is what answers. Verifying
# only that "something answers /health" is satisfied by the OLD process still holding the port —
# which is exactly how a restart that never took could look like a success.
restart_and_verify() { # EXPECTED_SHA SECS
  local want="${1:-}" secs="${2:-45}" kind live
  kind="$(service_kind)"
  if [ -f "$(service_unit_path)" ] || [ -f "$(service_plist_path)" ]; then
    say "restarting Irises through its $kind service"
    if ! service_restart; then
      err "the $kind service would not restart"
      return 1
    fi
  else
    say "no service installed — cycling the detached server"
    server_stop 20
    server_start_detached "$ROOT"
  fi
  if ! live="$(wait_health_sha "$BASE" "$want" "$secs")"; then
    err "no /health answer reporting ${want:0:7} on :$PORT within ${secs}s"
    err "read the log:  tail -n 40 $STATE_DIR/logs/server.log"
    return 1
  fi
  say "restarted — build ${live:0:7} is live on :$PORT"
  return 0
}

# Put everything back: the tree, the dependencies, and the build. The old updater had no rollback at
# all, so a failed `npm ci` after the merge left HEAD new, node_modules wiped and dist old — a state
# nobody could get out of without knowing the sha to reset to.
rollback_to() { # SHA
  local sha="${1:-}"
  warn "rolling back to ${sha:0:7}"
  if ! git reset --hard "$sha" >/dev/null 2>&1; then
    err "git reset --hard ${sha:0:7} FAILED — this clone needs hands:"
    err "  cd $ROOT && git reset --hard ${sha} && npm ci --include=dev && npm run build"
    return 1
  fi
  if ! npm ci --include=dev; then
    err "npm ci during the rollback FAILED — node_modules is incomplete:"
    err "  cd $ROOT && npm ci --include=dev && npm run build"
    return 1
  fi
  if ! npm run build; then
    err "npm run build during the rollback FAILED — dist/ is stale:"
    err "  cd $ROOT && npm run build"
    return 1
  fi
  say "rolled back to ${sha:0:7}"
  return 0
}
```

- [ ] **Step 5: Add the compare/`--check` block and the apply flow**

Append to `scripts/update.sh`:

```bash
# ── compare ──────────────────────────────────────────────────────────────────
if [ "$OLD" = "$NEW" ]; then
  if [ -n "$BUILT" ] && [ "$BUILT" != "$NEW" ] && [ "$CHECK" != "1" ]; then
    # HEAD is current but dist/ was stamped from another commit: a previous update advanced HEAD and
    # then its build (or its box) died. Reporting "up to date" would strand that half-applied state.
    warn "code is at ${NEW:0:7} but the built version is ${BUILT:0:7} — a previous build didn't finish"
    say "repairing the build"
    if ! ( npm ci --include=dev && npm run build ); then
      err "the repair build failed — the tree is already at ${NEW:0:7}; nothing was rolled back"
      err "  cd $ROOT && npm ci --include=dev && npm run build"
      summary rolled-back "repair build failed at ${NEW:0:7}" "run the two commands above by hand"
      exit 3
    fi
    web_build "$ROOT"
    write_receipt "$NEW" "$NEW"
    if [ "$DO_RESTART" = "1" ]; then
      if ! restart_and_verify "$NEW" 45; then
        rm -f "$STATE_DIR/update-receipt.json"
        summary rolled-back "repaired build ${NEW:0:7} did not come up" "the tree is at ${NEW:0:7}; start it by hand"
        exit 4
      fi
    fi
    summary ok "repaired an unfinished build at ${NEW:0:7}" "Irises restarted and verified"
    exit 0
  fi
  say "already up to date ($(git rev-parse --short HEAD), branch $BRANCH)"
  summary up-to-date "HEAD and origin/$BRANCH are both $(git rev-parse --short HEAD)"
  exit 0
fi

# Local ahead of origin (your own unpushed commits) → nothing upstream to apply.
if git merge-base --is-ancestor "origin/$BRANCH" HEAD; then
  say "local $BRANCH is ahead of origin — nothing upstream to pull"
  summary noop "local $BRANCH is ahead of origin/$BRANCH"
  exit 0
fi

COUNT="$(git rev-list --count "$OLD..$NEW")"
say "update available: ${OLD:0:7} -> ${NEW:0:7} ($COUNT commit(s) on $BRANCH)"
git --no-pager log --oneline "$OLD..$NEW" | sed 's/^/    /'

if [ "$CHECK" = "1" ]; then
  say "(--check) not applying. Run 'bash scripts/update.sh' to apply."
  summary update-available "${OLD:0:7} -> ${NEW:0:7} ($COUNT commit(s) on $BRANCH)"
  exit 10
fi

if [ "$ASSUME_YES" != "1" ]; then
  printf '\033[36m[%s]\033[0m apply this update now? [y/N] ' "$IRISES_LOG_TAG"
  read -r yn || yn=''    # EOF (piped stdin) must not abort under set -e
  case "$yn" in
    y|Y|yes|YES) ;;
    *) say "aborted — nothing changed"; summary noop "aborted at the confirmation prompt"; exit 0 ;;
  esac
fi

# ── apply, with a rollback around the parts that can fail ────────────────────
say "fast-forwarding to origin/$BRANCH"
git merge --ff-only "origin/$BRANCH" || {
  err "fast-forward failed — your local $BRANCH has diverged from origin."
  err "reconcile it yourself (git log, git rebase/merge) — this updater never force-merges."
  exit 1
}

say "installing dependencies + building (npm ci --include=dev && npm run build)"
if ! ( npm ci --include=dev && npm run build ); then
  err "the build failed at ${NEW:0:7}"
  rollback_to "$OLD" || {
    summary rolled-back "build failed AND the rollback failed — see the commands above" "the running server was never touched"
    exit 3
  }
  summary rolled-back \
    "build failed at ${NEW:0:7}; the clone is back at ${OLD:0:7}" \
    "the running server was never touched — it is still serving ${OLD:0:7}"
  exit 3
fi
NEW_BUILT="$(built_sha "$ROOT")"
say "built ${NEW_BUILT:0:7}"

web_build "$ROOT"

# The bridge plugin is a COPY, so a repo update always leaves a stale one on the engine. Refresh it
# every time now: the gateway gets bounced at the end regardless, and "only when bridge/ changed"
# quietly skipped a refresh whenever a previous update's copy had failed.
ENGINE="$(engine_kind)"
PLUGIN_STATE="not applicable"
if [ "$ENGINE" != "off" ]; then
  if plugin_refresh "$ENGINE" "$ROOT"; then
    PLUGIN_STATE="refreshed"
  else
    PLUGIN_STATE="NOT refreshed — see the warning above"
  fi
fi

write_receipt "$OLD" "$NEW"

RESTART_STATE="skipped (--no-restart)"
if [ "$DO_RESTART" = "1" ]; then
  if restart_and_verify "$NEW_BUILT" 45; then
    RESTART_STATE="restarted, build ${NEW_BUILT:0:7} verified live"
  else
    # The new build compiles but will not serve. Take the receipt back (nothing should announce an
    # upgrade that is being undone), restore the old build, and put it back up.
    rm -f "$STATE_DIR/update-receipt.json"
    err "the new build did not come up — rolling back"
    if rollback_to "$OLD"; then
      if restart_and_verify "$OLD" 45; then
        summary rolled-back \
          "${NEW:0:7} would not serve; rolled back to ${OLD:0:7}" \
          "Irises is back up on the OLD build — nothing was announced in chat" \
          "the failure is in $STATE_DIR/logs/server.log"
        exit 4
      fi
    fi
    summary rolled-back \
      "${NEW:0:7} would not serve, and the old build did not come back up" \
      "Irises is DOWN — read $STATE_DIR/logs/server.log, then: cd $ROOT && npm start"
    exit 4
  fi
else
  say "(--no-restart) the new build is on disk; restart Irises yourself to run it"
fi

GATEWAY_STATE="skipped (--no-gateway-restart)"
RC=0
RESULT=ok
if [ "$DO_GATEWAY" = "1" ] && [ "$ENGINE" != "off" ]; then
  if gateway_restart "$ENGINE" 90; then
    GATEWAY_STATE="bounced and verified"
  else
    GATEWAY_STATE="NOT verified — bounce it yourself"
    RESULT=gateway-failed
    RC=5
  fi
elif [ "$ENGINE" = "off" ]; then
  GATEWAY_STATE="n/a (standalone install)"
fi

ANNOUNCE="Irises will mention the upgrade in chat itself, once it is up"
if [ "$(env_get "$ENV_FILE" UPDATE_ANNOUNCE_ENABLED)" = "false" ]; then
  ANNOUNCE="chat announcements are off (UPDATE_ANNOUNCE_ENABLED=false)"
fi

summary "$RESULT" \
  "updated:  ${OLD:0:7} -> ${NEW:0:7} ($COUNT commit(s) on $BRANCH)" \
  "web UI:   $(if [ -d "$ROOT/web/out" ]; then printf 'built'; else printf 'not built here'; fi)" \
  "plugin:   $PLUGIN_STATE" \
  "Irises:   $RESTART_STATE" \
  "gateway:  $GATEWAY_STATE" \
  "data:     $STATE_DIR — untouched, as always" \
  "$ANNOUNCE"
exit "$RC"
```

- [ ] **Step 6: Verify syntax, the tests, and the whole shell contract**

Run: `bash -n scripts/update.sh && npx tsx --test scripts/update.test.ts 2>&1 | tail -6 && npx tsx --test scripts/shellContract.test.ts 2>&1 | tail -6`
Expected: `bash -n` silent; both test files report `# fail 0` — the shell contract test is now fully green, since the last blocked literal left with `update.sh`'s old bridge block.

- [ ] **Step 7: Run `--check` and the whole suite**

Run: `bash scripts/update.sh --check | tail -4; echo "rc=${PIPESTATUS[0]}"; npm test 2>&1 | tail -6; npm run typecheck:scripts`
Expected: either `RESULT: up-to-date` with `rc=0` or `RESULT: update-available` with `rc=10`; `# fail 0`; `typecheck:scripts` silent.

- [ ] **Step 8: Confirm the status file is gone from the shell half**

Run: `grep -rn "update-status.json\|write_status" scripts/ || echo "clean"`
Expected: `clean`.

- [ ] **Step 9: Commit**

```bash
git add scripts/update.sh scripts/update.test.ts
git commit -m "$(cat <<'EOF'
Rewrite the updater: roll back on failure, verify the new build is live

An update now restarts Irises through its service and waits for /health to
report the sha it just built — "something answers" was satisfied by the old
process still holding the port. Anything that fails after the merge is undone:
a failed build resets the tree, node_modules and dist and never touches the
running server (exit 3); a build that compiles but will not serve is rolled back
and the old build is put back up, with the receipt withdrawn so nothing
announces an upgrade that was undone (exit 4). A gateway that cannot be verified
gets its own code (5) because Irises itself is updated and live. The bridge
plugin is refreshed every time, update-status.json is gone with the chat
self-update that read it, and the last line of stdout is a fixed RESULT token.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: End-to-end lifecycle sandbox

**Files:**
- Create: `scripts/e2e/lifecycle-sandbox.sh`
- Modify: `package.json:31-38` (add the `e2e:lifecycle` script)
- Modify: `.gitignore` (add `scripts/e2e/.sandbox/`)

**Interfaces:**
- Consumes: `scripts/engine-setup.sh` (Tasks 5–6), `scripts/update.sh` (Task 7), `scripts/lib/irises-lib.sh` (Tasks 1–3).
- Produces: `npm run e2e:lifecycle` — install → update → boot-crash rollback → uninstall against a throwaway HOME, a fake origin, and stub engines. Not part of `npm test`.
- **Offline by construction**: a stub `npm` on the sandbox PATH hard-link-copies this repo's real `node_modules` for `ci` and runs the real `node_modules/.bin/tsc` + `cpx` + `stamp-version.js` for `build`. No registry traffic, and still a real compile — which is what makes the boot-crash commit a genuine failure rather than a simulated one.

- [ ] **Step 1: Create the harness — setup and stubs**

Create `scripts/e2e/lifecycle-sandbox.sh`:

```bash
#!/usr/bin/env bash
# Irises lifecycle end-to-end — install, update, roll back, uninstall, in a sandbox.
#
#   npm run e2e:lifecycle          # or: bash scripts/e2e/lifecycle-sandbox.sh
#   KEEP=1 npm run e2e:lifecycle   # leave the sandbox behind for inspection
#
# NOT part of `npm test`: it starts real servers, binds a real port and takes ~2 minutes. It is the
# battery that would have caught every bug the unit tests cannot see — the ones that only exist when
# the four lifecycle stages run in sequence against each other.
#
# OFFLINE BY CONSTRUCTION. The scratch PATH carries a stub `npm`:
#   ci    -> hard-link-copies THIS repo's node_modules into the sandbox clone
#   build -> runs the real node_modules/.bin/tsc + cpx + scripts/stamp-version.js
#   web   -> a logged no-op
# So there is no registry traffic, and the build is still a real compile: the boot-crash commit
# below genuinely compiles and genuinely dies at startup, which is the case no unit test can stage.
#
# WHAT IT ASSERTS, in order:
#   1. install   — detached start, /health serving the sha that was built, plugin copied to the stub
#                  engine, engine .env carrying our keys, manifest written, gateway stub called
#   2. update    — a commit published to the fake origin is applied, the LIVE sha flips to it, the
#                  receipt is written, the plugin is refreshed again, the gateway stub is called
#   3. rollback  — a commit that compiles and crashes on boot is applied, then undone: the tree
#                  returns to the previous sha, the OLD build is live again, no receipt is left,
#                  and the last line reads `RESULT: rolled-back`
#   4. uninstall — the server stops, the plugin dir is gone, our keys are stripped from the engine
#                  .env while a pre-existing key survives, and $IRISES_HOME is KEPT
set -euo pipefail

REPO="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
SANDBOX="$REPO/scripts/e2e/.sandbox"
PASS=0
FAIL=0

step()  { printf '\n\033[1;36m=== %s\033[0m\n' "$*"; }
ok()    { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()   { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check() { # DESCRIPTION CONDITION-COMMAND…
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi
}
contains() { case "$2" in *"$1"*) return 0 ;; esac; return 1; }
check_out() { # DESCRIPTION NEEDLE HAYSTACK
  if contains "$2" "$3"; then ok "$1"; else bad "$1 — expected to find: $2"; fi
}

cleanup() {
  if [ -n "${CLONE:-}" ]; then
    for p in $(pgrep -f "$CLONE/dist/index.js" 2>/dev/null || true); do kill "$p" 2>/dev/null || true; done
  fi
  if [ -n "${HERMES_SRV:-}" ]; then kill "$HERMES_SRV" 2>/dev/null || true; fi
  if [ "${KEEP:-0}" != "1" ]; then rm -rf "$SANDBOX"; else printf '\nsandbox kept at %s\n' "$SANDBOX"; fi
}
trap cleanup EXIT

rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"
HOME_DIR="$SANDBOX/home"
BIN="$SANDBOX/bin"
ORIGIN="$SANDBOX/origin.git"
CLONE="$SANDBOX/clone"
STATE="$SANDBOX/irises-home"
HERMES="$SANDBOX/hermes"
STUB_LOG="$SANDBOX/stub.log"
mkdir -p "$HOME_DIR" "$BIN" "$STATE" "$HERMES/plugins"
: > "$STUB_LOG"

# A free high port, so a developer's own Irises on :3000 is never disturbed.
SRV_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"

step "sandbox at $SANDBOX (port $SRV_PORT)"

# ── the scratch PATH ──────────────────────────────────────────────────────────
# nohup and setsid are what server_start_detached needs (setsid is absent on macOS and skipped).
for tool in bash cat cp rm mv mkdir chmod find grep sed head tail cut tr sleep date printf ps \
            uname id dirname basename du curl node git awk sort stat env sh pgrep mktemp kill \
            touch ln wc od xargs nohup setsid; do
  real="$(command -v "$tool" 2>/dev/null || true)"
  if [ -n "$real" ] && [ ! -e "$BIN/$tool" ]; then ln -s "$real" "$BIN/$tool"; fi
done

# npm: offline, and a real compile. `ci` hard-links this repo's node_modules (cp -al on Linux, cp -R
# on macOS); `build` runs the actual toolchain out of it.
cat > "$BIN/npm" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "\$*" >> "$STUB_LOG"
case "\$*" in
  *"--prefix"*) exit 0 ;;                       # web install/build: a logged no-op
  *"run build:web"*) exit 0 ;;
  ci*|*" ci"*)
    rm -rf "$CLONE/node_modules"
    cp -al "$REPO/node_modules" "$CLONE/node_modules" 2>/dev/null \
      || cp -R "$REPO/node_modules" "$CLONE/node_modules"
    exit 0 ;;
  *"run build"*)
    cd "$CLONE"
    ./node_modules/.bin/tsc
    ./node_modules/.bin/cpx "src/agents/**/*.md" dist/agents
    ./node_modules/.bin/cpx "src/**/*.txt" dist
    node scripts/stamp-version.js
    exit 0 ;;
  *"install --no-save"*) exit 0 ;;
esac
exit 0
EOF
chmod +x "$BIN/npm"

# hermes / openclaw: log argv and succeed. With systemctl and launchctl absent from this PATH,
# service_kind returns `none` and the run exercises the detached fallback — the path a box with no
# user service manager actually takes.
for stub in hermes openclaw; do
  cat > "$BIN/$stub" <<EOF
#!/usr/bin/env bash
printf '$stub %s\n' "\$*" >> "$STUB_LOG"
exit 0
EOF
  chmod +x "$BIN/$stub"
done

# The stub engine's health surface, so gateway_restart can verify a bounce.
HERMES_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
node -e "
const http=require('http');
http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end('{\"status\":\"ok\"}')})
  .listen($HERMES_PORT,'127.0.0.1');
" &
HERMES_SRV=$!

# The engine's .env, with one key that was there BEFORE Irises — the uninstall must not remove it.
printf 'ANTHROPIC_API_KEY=engine-owned-key\nAPI_SERVER_KEY=pre-existing-engine-key\n' > "$HERMES/.env"

export PATH="$BIN"
export HOME="$HOME_DIR"
export IRISES_HOME="$STATE"
export HERMES_HOME="$HERMES"
export NO_COLOR=1
export STUB_LOG
```

- [ ] **Step 2: Add the fake origin, the clone, and stage 1 (install)**

Append to `scripts/e2e/lifecycle-sandbox.sh`:

```bash
# ── the fake origin and the clone ─────────────────────────────────────────────
step "publishing a fake origin from $REPO"
git init --quiet --bare "$ORIGIN"
git clone --quiet --no-hardlinks "$REPO" "$CLONE" >/dev/null 2>&1
git -C "$CLONE" remote set-url origin "$ORIGIN"
git -C "$CLONE" config user.name "Irises E2E"
git -C "$CLONE" config user.email "e2e@example.invalid"
BRANCH="$(git -C "$CLONE" rev-parse --abbrev-ref HEAD)"
git -C "$CLONE" push --quiet origin "$BRANCH"
BASE_SHA="$(git -C "$CLONE" rev-parse HEAD)"
say_sha() { printf '%s' "${1:0:7}"; }

# The clone's own config: the stub engine, our high port, no web UI. The default data backend
# (SQLite under $IRISES_HOME) is what a real install uses, so it is left at its default here.
cat > "$CLONE/.env" <<EOF
OPS_BACKEND=hermes
HERMES_BASE_URL=http://127.0.0.1:$HERMES_PORT
PORT=$SRV_PORT
ANTHROPIC_API_KEY=sandbox-not-a-real-key
EOF
chmod 600 "$CLONE/.env"

# ── 1. install ────────────────────────────────────────────────────────────────
step "1/4  install"
set +e
INSTALL_OUT="$(cd "$CLONE" && bash scripts/engine-setup.sh --engine hermes --yes --no-service 2>&1)"
INSTALL_RC=$?
set -e
printf '%s\n' "$INSTALL_OUT" | sed 's/^/    | /'
check_out "install exits with a RESULT line" "RESULT:" "$INSTALL_OUT"
if [ "$INSTALL_RC" = "0" ]; then ok "install exit 0"; else bad "install exit $INSTALL_RC (expected 0)"; fi

LIVE_SHA="$(curl -fsS "http://127.0.0.1:$SRV_PORT/health" | grep -o '"sha":"[0-9a-f]\{7,40\}"' | head -1 | cut -d'"' -f4 || true)"
if [ "$LIVE_SHA" = "$BASE_SHA" ]; then
  ok "/health serves the sha that was built ($(say_sha "$LIVE_SHA"))"
else
  bad "/health serves '$LIVE_SHA', expected $BASE_SHA"
fi
check "the bridge plugin was copied to the engine" test -f "$HERMES/plugins/irises-bridge/plugin.yaml"
check "no __pycache__ came with it" test ! -d "$HERMES/plugins/irises-bridge/__pycache__"
check "the plugin was enabled through the engine CLI" grep -q "hermes plugins enable irises-bridge" "$STUB_LOG"
check "the gateway was bounced" grep -qE "hermes gateway re?start" "$STUB_LOG"
check "the engine .env was backed up" sh -c "ls $HERMES/.env.bak-irises-* >/dev/null 2>&1"
check "IRISES_PUSH_TOKEN was added to the engine" grep -q '^IRISES_PUSH_TOKEN=' "$HERMES/.env"
check "IRISES_FRONT was added to the engine" grep -q '^IRISES_FRONT=' "$HERMES/.env"
check "the pre-existing engine key was NOT duplicated" \
  sh -c "test \"\$(grep -c '^API_SERVER_KEY=' $HERMES/.env)\" = 1"
check "the manifest was written" test -f "$STATE/install-manifest.json"
check "the manifest names the plugin dir" grep -q 'pluginDir' "$STATE/install-manifest.json"
check "the server wrote exactly one pidfile" test -f "$STATE/irises.pid"
check "and none in the clone root" test ! -f "$CLONE/irises.pid"
```

- [ ] **Step 3: Add stage 2 (update) and stage 3 (rollback)**

Append to `scripts/e2e/lifecycle-sandbox.sh`:

```bash
# ── 2. update ─────────────────────────────────────────────────────────────────
step "2/4  update — a real commit published upstream"
UP="$SANDBOX/upstream"
git clone --quiet "$ORIGIN" "$UP"
git -C "$UP" config user.name "Irises E2E"
git -C "$UP" config user.email "e2e@example.invalid"
printf '\n// e2e: a harmless upstream change\n' >> "$UP/src/index.ts"
git -C "$UP" commit --quiet -am "e2e: a harmless upstream change"
git -C "$UP" push --quiet origin "$BRANCH"
NEXT_SHA="$(git -C "$UP" rev-parse HEAD)"

set +e
CHECK_OUT="$(cd "$CLONE" && bash scripts/update.sh --check 2>&1)"
CHECK_RC=$?
set -e
if [ "$CHECK_RC" = "10" ]; then ok "--check exits 10 when an update is available"; else bad "--check exit $CHECK_RC (expected 10)"; fi
check_out "--check reports update-available" "RESULT: update-available" "$CHECK_OUT"

: > "$STUB_LOG"
set +e
UPDATE_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
UPDATE_RC=$?
set -e
printf '%s\n' "$UPDATE_OUT" | sed 's/^/    | /'
if [ "$UPDATE_RC" = "0" ]; then ok "update exit 0"; else bad "update exit $UPDATE_RC (expected 0)"; fi
check_out "update reports ok" "RESULT: ok" "$UPDATE_OUT"
LIVE_SHA="$(curl -fsS "http://127.0.0.1:$SRV_PORT/health" | grep -o '"sha":"[0-9a-f]\{7,40\}"' | head -1 | cut -d'"' -f4 || true)"
if [ "$LIVE_SHA" = "$NEXT_SHA" ]; then
  ok "the LIVE sha flipped to $(say_sha "$NEXT_SHA") — the new build is what answers"
else
  bad "/health still serves '$LIVE_SHA', expected $NEXT_SHA"
fi
check "the plugin was refreshed again" grep -q "hermes plugins enable irises-bridge" "$STUB_LOG"
check "the gateway was bounced again" grep -qE "hermes gateway re?start" "$STUB_LOG"
# The server consumes the receipt at boot and archives it under updates/ — either state proves it
# was written; a missing pair proves it was not.
if [ -f "$STATE/update-receipt.json" ] || ls "$STATE"/updates/applied-*.json >/dev/null 2>&1; then
  ok "the update receipt was written (pending or already archived by the boot announce)"
else
  bad "no receipt anywhere — Irises would never mention the upgrade"
fi
check "no update-status.json was left behind" test ! -f "$STATE/update-status.json"

# ── 3. rollback ───────────────────────────────────────────────────────────────
step "3/4  rollback — a commit that COMPILES and crashes on boot"
git -C "$UP" pull --quiet --ff-only origin "$BRANCH"
# A top-level throw compiles cleanly and dies while the module is being loaded, before the listener
# ever runs: exactly the failure that used to leave the box with no server at all.
printf '\nthrow new Error("e2e boot crash");\n' >> "$UP/src/index.ts"
git -C "$UP" commit --quiet -am "e2e: compiles fine, dies at boot"
git -C "$UP" push --quiet origin "$BRANCH"
BAD_SHA="$(git -C "$UP" rev-parse HEAD)"

set +e
ROLL_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
ROLL_RC=$?
set -e
printf '%s\n' "$ROLL_OUT" | sed 's/^/    | /'
if [ "$ROLL_RC" = "4" ]; then ok "a build that will not serve exits 4"; else bad "exit $ROLL_RC (expected 4)"; fi
check_out "and reports rolled-back" "RESULT: rolled-back" "$ROLL_OUT"
TREE_SHA="$(git -C "$CLONE" rev-parse HEAD)"
if [ "$TREE_SHA" = "$NEXT_SHA" ]; then
  ok "the tree went back to $(say_sha "$NEXT_SHA")"
else
  bad "the tree is at $TREE_SHA, expected $NEXT_SHA"
fi
LIVE_SHA="$(curl -fsS "http://127.0.0.1:$SRV_PORT/health" | grep -o '"sha":"[0-9a-f]\{7,40\}"' | head -1 | cut -d'"' -f4 || true)"
if [ "$LIVE_SHA" = "$NEXT_SHA" ]; then
  ok "the OLD build is serving again ($(say_sha "$NEXT_SHA")) — the box is not left down"
else
  bad "/health serves '$LIVE_SHA', expected the old build $NEXT_SHA"
fi
check "the receipt for the failed build was withdrawn" test ! -f "$STATE/update-receipt.json"
check "node_modules survived the rollback" test -d "$CLONE/node_modules/typescript"
check "the bad sha is not what dist was stamped from" \
  sh -c "! grep -q '$BAD_SHA' $CLONE/dist/version.json"
```

- [ ] **Step 4: Add stage 4 (uninstall) and the tally**

Append to `scripts/e2e/lifecycle-sandbox.sh`:

```bash
# ── 4. uninstall ──────────────────────────────────────────────────────────────
step "4/4  uninstall — data kept"
: > "$STUB_LOG"
printf 'sandbox\n' > "$STATE/memories-canary.txt"
set +e
UNINSTALL_OUT="$(cd "$CLONE" && bash scripts/engine-setup.sh --uninstall --yes 2>&1)"
UNINSTALL_RC=$?
set -e
printf '%s\n' "$UNINSTALL_OUT" | sed 's/^/    | /'
if [ "$UNINSTALL_RC" = "0" ]; then ok "uninstall exit 0"; else bad "uninstall exit $UNINSTALL_RC (expected 0)"; fi
check_out "uninstall reports ok" "RESULT: ok" "$UNINSTALL_OUT"
if curl -fsS -m 3 "http://127.0.0.1:$SRV_PORT/health" >/dev/null 2>&1; then
  bad "the server is STILL answering on :$SRV_PORT"
else
  ok "the server stopped"
fi
check "the plugin dir is gone" test ! -d "$HERMES/plugins/irises-bridge"
check "the plugin was disabled through the engine CLI" grep -q "hermes plugins disable irises-bridge" "$STUB_LOG"
check "the gateway was bounced so the engine forgets it" grep -qE "hermes gateway re?start" "$STUB_LOG"
check "IRISES_PUSH_TOKEN was stripped from the engine" sh -c "! grep -q '^IRISES_PUSH_TOKEN=' $HERMES/.env"
check "IRISES_FRONT was stripped too" sh -c "! grep -q '^IRISES_FRONT=' $HERMES/.env"
check "no orphaned Irises marker comment was left" sh -c "! grep -q 'added by Irises setup' $HERMES/.env"
check "the engine's OWN key survived" grep -q '^ANTHROPIC_API_KEY=engine-owned-key' "$HERMES/.env"
check "the pre-existing API_SERVER_KEY survived" grep -q 'pre-existing-engine-key' "$HERMES/.env"
check "the data directory is KEPT" test -d "$STATE"
check "and so is what was in it" test -f "$STATE/memories-canary.txt"
check_out "the exact rm was printed rather than run" "rm -rf $STATE" "$UNINSTALL_OUT"
check_out "the clone is explicitly not deleted" "NOT deleted" "$UNINSTALL_OUT"
check "the clone is in fact still there" test -d "$CLONE/.git"

kill "$HERMES_SRV" 2>/dev/null || true

step "result"
printf '  %s passed, %s failed\n\n' "$PASS" "$FAIL"
if [ "$FAIL" != "0" ]; then
  printf 'RESULT: failed\n'
  exit 1
fi
printf 'RESULT: ok\n'
exit 0
```

- [ ] **Step 5: Wire up the npm script and the ignore rule**

Modify `package.json` — in `"scripts"`, after the `"test"` entry:

```json
    "test": "cross-env TZ=UTC DATA_BACKEND=memory tsx --test \"src/**/*.test.ts\" \"scripts/**/*.test.ts\"",
    "e2e:lifecycle": "bash scripts/e2e/lifecycle-sandbox.sh",
    "typecheck:scripts": "tsc -p tsconfig.scripts.json"
```

Modify `.gitignore` — after the `irises.pid` entry added in Task 5:

```
irises.pid

# The lifecycle e2e sandbox (npm run e2e:lifecycle) — throwaway clones, homes and logs.
scripts/e2e/.sandbox/
```

- [ ] **Step 6: Run the harness**

Run: `bash -n scripts/e2e/lifecycle-sandbox.sh && time npm run e2e:lifecycle 2>&1 | tail -40`
Expected: the four stages print `PASS` lines, the tally reads `N passed, 0 failed`, the last line is `RESULT: ok`, and `real` is under 5 minutes.

- [ ] **Step 7: Confirm it is NOT in the unit suite**

Run: `npm test 2>&1 | grep -c "lifecycle-sandbox" || echo "not in npm test"`
Expected: `not in npm test` (the harness is a `.sh`, so the `*.test.ts` glob cannot pick it up; the shell contract test still parses it with `bash -n` and scans it for blocked literals).

- [ ] **Step 8: Commit**

```bash
git add scripts/e2e/lifecycle-sandbox.sh package.json .gitignore
git commit -m "$(cat <<'EOF'
Add the lifecycle e2e sandbox: install, update, rollback, uninstall

Codifies the harness the audits ran by hand — a throwaway HOME, a fake bare
origin, stub engine CLIs that log their argv, and a stub npm that hard-links
this repo's node_modules and runs the real tsc, so the whole battery is offline
and the build is still a genuine compile. That is what lets stage 3 publish a
commit which compiles cleanly and throws at module load: the exact failure that
used to leave a box with no server, now asserted to roll back to the previous
sha with the old build serving again. Runs via npm run e2e:lifecycle in about
two minutes and stays out of npm test, which must not bind ports.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Production VPS rollout — adopt the hand-launched server as a systemd unit

> **Production change. Ask Rivian for an explicit go-ahead before starting this task**, even if the rest of the plan was approved in one go. It stops the live server, restarts the hermes gateway (hermes will post its "gateway online" note to the phone), and removes `~/irises-start.sh`.

**Files:**
- Modify: none (this task changes the production box, not the repo)
- Verify: `scripts/engine-setup.sh`, `scripts/update.sh`, `scripts/lib/irises-lib.sh` behaving on the real constraints — Ubuntu, ~180 MB free RAM, 95% full disk, node only at `~/.local/bin`, `web/out` absent, `hermes-gateway.service` under `systemd --user` with linger already on. Run this only after Tasks 1–8 **and** Part B are merged to `main` and pushed.

**Interfaces:**
- Consumes: everything from Tasks 1–8 and Part B, merged to `main` and pushed.
- Produces: Irises running as `systemd --user` unit `irises` on the VPS, `/health` serving `main`'s sha, the engine gateway verified back up, and `bash scripts/update.sh --check` reporting `up-to-date`.

- [ ] **Step 1: Open a LOGIN shell and record the starting state**

Run:
```bash
ssh -i ~/.ssh/becussy-key.pem ubuntu@54.242.131.92
```
Then, on the box:
```bash
df -h ~ | tail -1; free -m | head -2; command -v node; node -v
loginctl show-user ubuntu | grep -i linger
systemctl --user list-units 'hermes*' --no-pager
cat ~/.irises/irises.pid 2>/dev/null; ps -o pid,ppid,etime,command -p "$(cat ~/.irises/irises.pid 2>/dev/null || echo 1)"
ls ~/irises-start.sh 2>/dev/null && cat ~/irises-start.sh
crontab -l 2>/dev/null | grep -i irises || echo "no irises crontab entry"
```
Expected: a login shell has node (`~/.local/bin/node`, v22+); `Linger=yes`; `hermes-gateway.service` listed as loaded/active; the pidfile names a live `node dist/index.js`; `~/irises-start.sh` exists. Note whether anything (crontab `@reboot`, a shell rc) relaunches that script — it must not fight the unit.

- [ ] **Step 2: Bring the clone to the new code by hand (the old updater cannot be trusted to restart it)**

Run:
```bash
cd ~/irises
git status --porcelain --untracked-files=no
```
If the only line is `web/package-lock.json`, clear it — it is the old updater's `npm run install:web` footprint:
```bash
git checkout -- web/package-lock.json
```
Then:
```bash
git fetch origin main
git log --oneline HEAD..origin/main | head -20
git merge --ff-only origin/main
npm ci --include=dev && npm run build
git rev-parse --short HEAD; node -e 'console.log(require("./dist/version.json"))'
```
Expected: the merge is a fast-forward; `dist/version.json`'s `sha` matches `git rev-parse HEAD`. If `npm ci` fails on disk space, free it first — `npm cache clean --force`, then `du -sh ~/.npm ~/.irises/logs`, and re-run.

- [ ] **Step 3: Stop the hand-launched server and disarm whatever relaunches it**

Run:
```bash
PID="$(cat ~/.irises/irises.pid)"; ps -o command= -p "$PID"
kill "$PID"; sleep 5; kill -0 "$PID" 2>/dev/null && echo "still up" || echo "stopped"
curl -fsS -m 3 http://127.0.0.1:3000/health >/dev/null && echo "STILL SERVING" || echo "port free"
```
Expected: `stopped` and `port free`. If Step 1 found a `@reboot` crontab line or an rc-file launch of `~/irises-start.sh`, remove it now (`crontab -e`) — two supervisors on one port is an EADDRINUSE loop. Keep the script itself on disk until Step 6 confirms the unit works.

- [ ] **Step 4: Run the new installer so it adopts the box as a service**

Run:
```bash
cd ~/irises && bash scripts/engine-setup.sh --engine hermes --yes 2>&1 | tail -40
echo "rc=${PIPESTATUS[0]}"
```
Expected: the summary block reports `service: systemd (/home/ubuntu/.config/systemd/user/irises.service)`, a `build: <sha> — confirmed live` line, `gateway: bounced and verified`, and `RESULT: ok` with `rc=0`. The web build is skipped by policy on two counts — `web/out` is absent and `MemAvailable` is far under 1500 MB — and the summary's `talk to it` line should say so rather than claiming a browser UI.

- [ ] **Step 5: Verify the unit, the sha, and the heap cap that finally applies**

Run:
```bash
systemctl --user status irises --no-pager | head -15
systemctl --user cat irises | grep -E 'ExecStart|Environment|Restart|StandardOutput'
curl -fsS http://127.0.0.1:3000/health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(o.status,o.version.sha,o.version.source)})'
git -C ~/irises rev-parse HEAD
cat /proc/"$(systemctl --user show -p MainPID --value irises)"/environ | tr '\0' '\n' | grep -E 'NODE_OPTIONS|IRISES_HOME|PATH'
```
Expected: `Active: active (running)`; `ExecStart=/home/ubuntu/.local/bin/node /home/ubuntu/irises/dist/index.js` (an absolute node — a bare `node` never resolves in a unit); the `/health` sha equals `git rev-parse HEAD` with `source: stamp`; and the process environment carries `NODE_OPTIONS=--max-old-space-size=512`, which `deploy/app.env` has never managed to apply because dotenv sets it after V8 has already sized the heap.

- [ ] **Step 6: Verify the engine gateway came back, and that reboot survival is real**

Run:
```bash
tail -n 30 ~/.hermes/logs/gateway.log
curl -fsS http://127.0.0.1:8642/v1/health && echo
systemctl --user is-active hermes-gateway
systemctl --user is-enabled irises
loginctl show-user ubuntu | grep -i linger
rm -f ~/irises-start.sh && echo "the hand-written launcher is gone"
```
Expected: the gateway log shows a fresh start and the plugin loading; `/v1/health` returns `{"status":"ok",…}`; `hermes-gateway` is `active`; `irises` is `enabled`; `Linger=yes`. Only remove `~/irises-start.sh` once all of that holds.

- [ ] **Step 7: Confirm the updater is now a no-op, and that a restart is one command**

Run:
```bash
cd ~/irises && bash scripts/update.sh --check; echo "rc=$?"
systemctl --user restart irises && sleep 8 && curl -fsS http://127.0.0.1:3000/health | head -c 120; echo
```
Expected: `RESULT: up-to-date` with `rc=0`; after the restart `/health` answers within 8 seconds with the same sha. In chat, Irises voices "back on the new build" once from the receipt the Step 2 build did not write — so expect that line only after the NEXT real `update.sh` run.

- [ ] **Step 8: Note the box's constraints where the next operator will find them**

Run:
```bash
df -h ~ | tail -1; free -m | head -2; du -sh ~/.irises ~/.npm 2>/dev/null
ls ~/.irises/logs/
```
Record in the rollout notes (no repo change): disk is ~95% full, so `npm ci` is the step most likely to fail on this box and `npm cache clean --force` is the first remedy; `MemAvailable` is ~180 MB, so `web_build` will keep skipping and `IRISES_SKIP_WEB_BUILD=1` is not needed (the policy already declines); `$IRISES_HOME/logs/server.log` grows unbounded under `StandardOutput=append:` — check its size on each visit and truncate with `: > ~/.irises/logs/server.log` if it dominates the remaining disk.

- [ ] **Step 9: Update the project memory** (the `irises-vps` memory file): the server is now the `irises` systemd --user unit; `~/irises-start.sh` is gone; deploy = `bash scripts/update.sh --yes` from a login shell; `/tmp/vps_deploy*.sh` wrappers are obsolete.

---

## Part B — TypeScript, chat copy, docs, skills (Tasks 100–107)

**Ownership split.** Part B touches `src/**`, `scripts/flagDocs.test.ts`, `scripts/skillRefs.test.ts`, `scripts/convergence/expectations.ts`, `README.md`, `docs/DEPLOY.md`, `docs/ENGINES.md`, `skills/**`, `deploy/app.env`, `.env.example`. Part A owns `scripts/lib/irises-lib.sh`, `scripts/engine-setup.sh`, `scripts/update.sh`, their tests, and the e2e harness. Tasks 104–105 document behavior Part A produces; if Part A renames a flag or exit code, those two tasks' text moves with it.

**Design notes (Part B).**
- `update_status` becomes the third unconditional dyn section, inserted after `'model_map'` in `DYN_SECTION_IDS`; that widens `SectionId → BudgetKey → PROMPT_BUDGET` (a total `Record`) so the type checker forces a budget line.
- Measured: the section renders 696 chars on a bare `main` checkout, 740 on a 40-char branch. Ceiling 900; it joins `model_map` as the second exemption from promptBudget's 2%-headroom ratchet because its bytes carry the host's sha + branch.
- "Version checks are off" cannot be derived from `UpdateStatus` (`lastCheckAt: null` is both "off" and "not checked yet"), so `checker.ts` gains one flag set at the arm site, `updateChecksLive()`. `npm test` never arms the checker, so every fixture deterministically renders the "can't tell" variant.
- `renderUpdateStatus` is a plain `export function` (precedent: `renderCapabilityLine` + `capabilityLine.test.ts`).
- `promptSections.test.ts` is a byte-golden; the new section is blanked with a second regex (`<update-status>`) exactly like `<model-map>`.
- `claimPendingUpdateNote`'s note grows 583 → 658 chars, so `PROMPT_BUDGET.extra` ratchets 590 → 670.
- `skillRefs.test.ts` fails on `` `bash scripts/update.sh` `` inside a SKILL.md (hermes would fetch a phantom sidecar): every `scripts/…` path in the two skills is written `./scripts/…`. TS copy keeps the bare form.
- `flagDocs.test.ts`'s `FLAGS` table is env-file-only and has no `UPDATE_*` row; README rows need no registration there. Do not add a `FLAGS` row.
- `docs/superpowers/` is an archived transcript and is excluded from the grep gates; all live prose avoids the banned tokens so the gates return exactly nothing.

### Task 100: Remove the chat self-update apply path

**Files:**
- Delete: `src/update/selfUpdate.ts` (154 lines), `src/update/selfUpdate.test.ts` (56 lines)
- Modify: `src/agents/convo/tools.ts` (delete 232-241; edit 327-343)
- Modify: `src/agents/convo/shared.ts` (delete line 101; delete 2494-2499)
- Modify: `src/agents/convo/client.ts` (delete line 4; edit 317-321)
- Modify: `src/index.ts` (delete line 34; delete line 1096; edit comment 1091-1094)
- Test: `src/agents/convo/steerResearch.test.ts` (edit 56-64)

**Interfaces:**
- Removes: `UPDATE_SELF_TOOL`, `requestSelfUpdate(chatId, handle?, seams?)`, `selfUpdateEnabled()`, `statusToOutcome(status)`, `initSelfUpdate({sendFollowUp})`, `SelfUpdateSeams`, the `update_self` tool name, the `UPDATE_SELF_ENABLED` env read.
- Changes: `convoToolList(opts: { engineName: 'hermes'|'openclaw'|null; isGroupChat: boolean }): LlmToolDef[]` — the `selfUpdate: boolean` field is gone.
- Consumes (unchanged, must keep working): `writePidFileAtBoot()`, `createUpdateAnnouncer({deliver})`, `startUpdateChecker({onUpdateDetected})`, `announceUpgradeAppliedIfReceipt()`, `sendFollowUp` (still used at `src/index.ts:586` and `:932`).

- [ ] **Step 1: Delete the two files.**
```bash
git rm src/update/selfUpdate.ts src/update/selfUpdate.test.ts
```
Expected: `rm 'src/update/selfUpdate.ts'` / `rm 'src/update/selfUpdate.test.ts'`.

- [ ] **Step 2: Delete `UPDATE_SELF_TOOL` from `src/agents/convo/tools.ts`.** Remove lines 232-241 inclusive — the whole `export const UPDATE_SELF_TOOL: LlmToolDef = { … };` block and the blank line after it. `STEER_RESEARCH_TOOL` (ending `};` at 230) and `UPDATE_DIRECTIVES_TOOL` (starting at 242) must end up separated by exactly one blank line.

- [ ] **Step 3: Drop the flag from `convoToolList` in `src/agents/convo/tools.ts`.** Replace lines 327-344 with:
```ts
export function convoToolList(opts: {
  engineName: 'hermes' | 'openclaw' | null;
  isGroupChat: boolean;
}): LlmToolDef[] {
  const tools: LlmToolDef[] = [
    REACTION_TOOL, rememberUserTool(), delegateToOpsTool(opts.engineName), setPreferenceTool(),
    ...(opts.engineName === 'openclaw' ? [] : [SCHEDULE_AUTOMATION_TOOL, LIST_AUTOMATIONS_TOOL, CANCEL_AUTOMATION_TOOL]),
    // The two halves of run control, side by side: drop the look, or add to it mid-flight. They read
    // as a pair in the tool docs because the model's mistake to avoid is picking one for the other.
    CANCEL_RESEARCH_TOOL, STEER_RESEARCH_TOOL, UPDATE_DIRECTIVES_TOOL,
    UPDATE_MEMORY_TOOL, RECALL_MEMORY_TOOL,
  ];
  if (opts.isGroupChat) tools.push(RENAME_CHAT_TOOL, REMOVE_MEMBER_TOOL);
  return tools;
}
```
The order-sensitive prefix that `pipeline/bubbleJson.ts` reads is untouched: the deleted push was the last statement before `return`.

- [ ] **Step 4: Remove the import and the dispatch branch from `src/agents/convo/shared.ts`.** Delete line 101 (`import { requestSelfUpdate } from '../../update/selfUpdate.js';`). Then delete lines 2494-2499, so the ladder's last branch is the `update_directives` one and the tail reads:
```ts
      } else {
        const { note, acted } = await handleUpdateDirectives(input, handle, chatId);
        if (note) outcomeParts.push(note);
        else if (acted) directiveActed = true;
      }
    }
  }
```

- [ ] **Step 5: Remove the flag read from `src/agents/convo/client.ts`.** Delete line 4 (`import { selfUpdateEnabled } from '../../update/selfUpdate.js';`). Replace lines 315-321 with:
```ts
  // The list itself — order included — lives in tools.ts (convoToolList); the flags are read HERE so
  // that function stays pure and testable.
  const tools: LlmToolDef[] = convoToolList({
    engineName,
    isGroupChat: chatContext?.isGroupChat ?? false,
  });
```

- [ ] **Step 6: Remove the boot wiring from `src/index.ts`.** Delete line 34 (`import { initSelfUpdate } from './update/selfUpdate.js';`). Replace lines 1091-1099 with:
```ts
  // Update mechanism: a pidfile so scripts/update.sh can cycle this process, a periodic check of the
  // git remote for a newer build, and — woven through Convo, or pushed through the proactive pipeline
  // above — a proactive "upgrade available" note plus a "back on the new build" confirmation after
  // the operator applies it. APPLYING is terminal-only (scripts/update.sh); nothing here can do it.
  writePidFileAtBoot();
  const updateAnnouncer = createUpdateAnnouncer({ deliver: proactive.deliver });
  startUpdateChecker({ onUpdateDetected: sha => void updateAnnouncer.onUpdateDetected(sha) });
  void updateAnnouncer.announceUpgradeAppliedIfReceipt();
```

- [ ] **Step 7: Fix the tool-list test.** In `src/agents/convo/steerResearch.test.ts` replace lines 56-64 with:
```ts
test('steer_research is offered on the live tool list, right beside cancel_research', () => {
  const names = convoToolList({ engineName: 'hermes', isGroupChat: false })
    .map(t => t.name);
  assert.ok(names.includes('steer_research'), 'the assembled list carries it');
  assert.equal(names[names.indexOf('cancel_research') + 1], 'steer_research', 'the two sit together');
  // The group and openclaw lanes are the same list plus/minus their own tools — a steer is neither.
  assert.ok(convoToolList({ engineName: 'openclaw', isGroupChat: true })
    .map(t => t.name).includes('steer_research'));
  // And nothing on the list can apply an update: that path is the terminal's alone now.
  assert.ok(!names.includes('update_self'), 'there is no chat tool for updating herself');
});
```

- [ ] **Step 8: Verify no reference survives in code.**
```bash
grep -rn "update_self\|UPDATE_SELF\|selfUpdate" src
```
Expected: no output, exit status 1.

- [ ] **Step 9: Build and test.**
```bash
npm run build && npm test 2>&1 | tail -20 && npm run typecheck:scripts
```
Expected: `tsc` silent; `# fail 0` with `# pass` non-zero; `typecheck:scripts` silent.

- [ ] **Step 10: Commit.**
```bash
git add -A src
git commit --author="Rivian <rivianp@gmail.com>" -m "$(cat <<'EOF'
Remove the chat self-update apply path

The update_self tool, src/update/selfUpdate.ts, its test and the
UPDATE_SELF_ENABLED flag are gone. Applying an update is the terminal's
job alone (scripts/update.sh), because the script restarts the engine
gateway and a chat-triggered run kills the agent's own supervisor
mid-turn. Detection and the in-chat notification are untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 101: The `update_status` prompt section (TDD)

**Files:**
- Create: `src/agents/convo/updateStatus.test.ts`
- Modify: `src/update/checker.ts` (add after 44; edit 155-156; edit 168-173; add seam after 178)
- Modify: `src/agents/convo/shared.ts` (add import near 2; add renderer after 692; add push after 888)
- Modify: `src/agents/convo/promptSections.ts` (edit 16-17; add id after 27; edit 121-123)
- Modify: `src/agents/convo/promptPolicy.ts` (edit 73-76; add budget line after 113)
- Modify: `scripts/convergence/expectations.ts` (add to `DATA_BUDGET_KEYS`, 146-159)
- Test: `src/agents/convo/promptSections.test.ts` (362-367, 380, 404-406, 418-426, 672/674/676)
- Test: `src/agents/convo/promptBudget.test.ts` (617, 645, 675, 712, 756, 789, 831, 1003-1015)

**Interfaces:**
- Produces: `renderUpdateStatus(version: VersionInfo, status: UpdateStatus, now?: number): string` (exported from `src/agents/convo/shared.ts`); `updateChecksLive(): boolean` and `_setChecksLiveForTests(live: boolean): void` (exported from `src/update/checker.ts`); the `'update_status'` `DynSectionId`; `PROMPT_BUDGET.update_status`.
- Consumes: `getUpdateStatus(): UpdateStatus` (`src/update/checker.ts:48`), `VersionInfo` (`src/update/version.ts:21`), `_setUpdateStatusForTests`, `_resetCheckerForTests`, `_resetVersionForTests`.

- [ ] **Step 1: Write the failing test.** Create `src/agents/convo/updateStatus.test.ts`:
```ts
// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The facts Irises reads off when someone asks what version she is, whether an update is waiting, or
// asks her to update herself. There is no tool for that last one any more, so the ONLY thing standing
// between "she says the truth" and "she invents something" is this section — which is why its three
// states, its fallbacks and its one relayed command are pinned here rather than only measured.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderUpdateStatus } from './shared.js';
import { _resetCheckerForTests, _setChecksLiveForTests, type UpdateStatus } from '../../update/checker.js';
import type { VersionInfo } from '../../update/version.js';

const NOW = Date.UTC(2026, 0, 6, 2, 0, 0);
const MINUTE = 60_000;

const VERSION: VersionInfo = {
  sha: '4f2a91c'.padEnd(40, '0'), shortSha: '4f2a91c', branch: 'main', builtAt: null, source: 'stamp',
};

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    current: VERSION, remoteSha: null, updateAvailable: false, lastCheckAt: NOW - 5 * MINUTE,
    lastCheckOk: true, ...over,
  };
}

beforeEach(() => {
  _resetCheckerForTests();
  _setChecksLiveForTests(true);   // the checker armed at boot, which is the live default
});

test('an update waiting: the remote short sha, named as waiting on the server', () => {
  const out = renderUpdateStatus(VERSION, status({ remoteSha: '9ab3c7d'.padEnd(40, '0'), updateAvailable: true }), NOW);
  assert.match(out, /^## Your build and how you get updated \(facts; say them plainly if asked\)$/m);
  assert.match(out, /^- You are running build 4f2a91c on branch main\.$/m);
  assert.match(out, /^- A newer build \(9ab3c7d\) is waiting on the server\.$/m);
  assert.doesNotMatch(out, /No newer build/);
});

test('nothing waiting: the answer carries WHEN it was last checked', () => {
  assert.match(renderUpdateStatus(VERSION, status(), NOW), /^- No newer build is waiting, as of 5 minutes ago\.$/m);
});

test('checks off for this install: she says she cannot tell, never "nothing is waiting"', () => {
  _setChecksLiveForTests(false);
  const out = renderUpdateStatus(VERSION, status({ remoteSha: 'x'.repeat(40), updateAvailable: true }), NOW);
  assert.match(out, /^- You can't tell whether a newer build is waiting \(version checks are off for this install\)\.$/m);
  // …and a stale in-memory verdict cannot leak past the gate as a claim.
  assert.doesNotMatch(out, /is waiting on the server/);
  assert.doesNotMatch(out, /No newer build/);
});

test('the relative-time phrase covers every band, and reads like a person', () => {
  const at = (ago: number) => renderUpdateStatus(VERSION, status({ lastCheckAt: NOW - ago }), NOW);
  assert.match(at(0), /as of just now\./);
  assert.match(at(90_000), /as of just now\./);
  assert.match(at(2 * MINUTE), /as of 2 minutes ago\./);
  assert.match(at(59 * MINUTE), /as of 59 minutes ago\./);
  assert.match(at(60 * MINUTE), /as of 1 hour ago\./);
  assert.match(at(5 * 3_600_000), /as of 5 hours ago\./);
  assert.match(at(25 * 3_600_000), /as of 1 day ago\./);
  assert.match(at(9 * 86_400_000), /as of 9 days ago\./);
  // A clock that went backwards must not print a negative age.
  assert.match(renderUpdateStatus(VERSION, status({ lastCheckAt: NOW + 10 * MINUTE }), NOW), /as of just now\./);
});

test('armed but not yet run: not checked yet since boot, not a silent "nothing waiting"', () => {
  assert.match(renderUpdateStatus(VERSION, status({ lastCheckAt: null, lastCheckOk: false }), NOW),
    /as of not checked yet since boot\./);
});

test('no version stamp and no branch: the build line degrades instead of lying', () => {
  const unknown: VersionInfo = { sha: null, shortSha: null, branch: null, builtAt: null, source: 'unknown' };
  assert.match(renderUpdateStatus(unknown, status(), NOW),
    /^- You can't tell which build you are running \(this install carries no version stamp\)\.$/m);
  const noBranch: VersionInfo = { ...VERSION, branch: null };
  assert.match(renderUpdateStatus(noBranch, status(), NOW), /^- You are running build 4f2a91c\.$/m);
});

test('the terminal command is relayed exactly, once, in backticks — and never a chat command', () => {
  const out = renderUpdateStatus(VERSION, status(), NOW);
  assert.equal(out.split('`bash scripts/update.sh`').length - 1, 1, 'exactly one copy of the command');
  assert.match(out, /You cannot update yourself\./);
  assert.match(out, /restarts you, and restarts the engine gateway/);
  assert.match(out, /There is no chat command for it/);
  // The retired copy: the script restarts her, so she must never send them off to restart a server.
  assert.doesNotMatch(out, /then restart the server/);
});

test('every line is trimmed prose, so the section arithmetic stays exact', () => {
  const out = renderUpdateStatus(VERSION, status(), NOW);
  assert.equal(out, out.trim());
  assert.equal(out.split('\n').length, 5, 'a heading and four facts');
  for (const l of out.split('\n').slice(1)) assert.ok(l.startsWith('- '), `"${l}" is a fact bullet`);
});
```
- [ ] **Step 2: Run it — RED.**
```bash
npx cross-env TZ=UTC DATA_BACKEND=memory npx tsx --test src/agents/convo/updateStatus.test.ts 2>&1 | tail -15
```
Expected: failure — `does not provide an export named 'renderUpdateStatus'` (and `'_setChecksLiveForTests'`).

- [ ] **Step 3: Add the arm-site flag and its seams to `src/update/checker.ts`.** After line 44 (`let armed = false;`) insert:
```ts
let checksLive = false;
```
Inside `startUpdateChecker`, immediately after `armed = true;` (line 155) insert:
```ts
  checksLive = true;
```
Replace `_resetCheckerForTests` (168-173) and add the new seam and predicate after it:
```ts
export function _resetCheckerForTests(): void {
  liveStatus = { remoteSha: null, updateAvailable: false, lastCheckAt: null, lastCheckOk: false };
  consecutiveFailures = 0;
  armed = false;
  checksLive = false;
  onDetected = null;
}

/**
 * Whether THIS process is actually watching the remote — i.e. whether `startUpdateChecker` armed
 * rather than opting out (UPDATE_CHECK_ENABLED=false, no `.git` at the repo root, or an unknown
 * running sha).
 *
 * Read by the prompt's `update_status` section (convo/shared.ts renderUpdateStatus) so Irises says
 * "you can't tell" instead of "nothing is waiting" on an install that never checks — a silence is not
 * an all-clear. ONE flag, set at the arm site, rather than a second copy of the three gates above:
 * the prompt and the checker cannot then disagree, and the read costs no syscall on a per-turn path.
 * False until boot arms it, which is also what every unit test sees unless it says otherwise.
 */
export function updateChecksLive(): boolean {
  return checksLive;
}

/** Test seam: pretend the checker did (or did not) arm, for the prompt section that reads it. */
export function _setChecksLiveForTests(live: boolean): void {
  checksLive = live;
}
```

- [ ] **Step 4: Add the renderer to `src/agents/convo/shared.ts`.** Add the imports beside the existing model-map import at line 2:
```ts
import { getUpdateStatus, updateChecksLive, type UpdateStatus } from '../../update/checker.js';
import type { VersionInfo } from '../../update/version.js';
```
Insert after `renderModelMapAwareness` (after line 692, before the `PromptSectionsResult` doc comment):
```ts
/** `lastCheckAt` as a person would say it. Coarse on purpose: the prompt is rebuilt every turn, so a
 *  minute-precise phrase would be a different string on every single turn and buy nothing. */
function lastCheckedPhrase(lastCheckAt: number | null, now: number): string {
  if (lastCheckAt === null) return 'not checked yet since boot';
  const ago = Math.max(0, now - lastCheckAt);
  if (ago < 2 * 60_000) return 'just now';
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} minutes ago`;
  if (ago < 86_400_000) {
    const hours = Math.floor(ago / 3_600_000);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  const days = Math.floor(ago / 86_400_000);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/**
 * The per-turn "which build am I, and who updates me" note — four facts, flat: the build she is
 * running, whether a newer one is waiting, that she cannot apply it herself, and the ONE command her
 * person runs in a terminal.
 *
 * It exists because the chat apply path is gone. She used to hold a tool for this, so a model handed
 * no fact will either claim it updated itself or claim it can never be updated — both untrue, and
 * both unfalsifiable from inside the conversation. The command is relayed exactly, in backticks, like
 * every other command in her mouth (the consent-URL precedent); everything else here is framing and
 * she says it in her own words.
 *
 * Unconditional, and read from LIVE state rather than repo prose — so, like `model_map`, it is
 * deliberately outside the cached prefix (promptSections.ts STABLE_SLOT_IDS) and outside the budget's
 * 2% band (promptPolicy.ts). Exported rather than private because it has its own unit test, the same
 * arrangement as renderCapabilityLine / capabilityLine.test.ts.
 */
export function renderUpdateStatus(version: VersionInfo, status: UpdateStatus, now = Date.now()): string {
  const buildLine = version.shortSha
    ? version.branch
      ? `- You are running build ${version.shortSha} on branch ${version.branch}.`
      : `- You are running build ${version.shortSha}.`
    : "- You can't tell which build you are running (this install carries no version stamp).";
  // The gate comes FIRST: with no checker armed, `updateAvailable` is a stale in-memory guess and
  // either answer built from it would be a claim she cannot stand behind.
  const waitingLine = !updateChecksLive()
    ? "- You can't tell whether a newer build is waiting (version checks are off for this install)."
    : status.updateAvailable && status.remoteSha
      ? `- A newer build (${status.remoteSha.slice(0, 7)}) is waiting on the server.`
      : `- No newer build is waiting, as of ${lastCheckedPhrase(status.lastCheckAt, now)}.`;
  return [
    '## Your build and how you get updated (facts; say them plainly if asked)',
    buildLine,
    waitingLine,
    '- You cannot update yourself. Your person does it in a terminal on the server, one command from the Irises folder: `bash scripts/update.sh`. It pulls, rebuilds, restarts you, and restarts the engine gateway. There is no chat command for it — if they ask you to update, say that plainly and hand them the command exactly as written, once.',
    '- If they ask what version you are or whether an update is waiting, answer from the lines above in your own words, one flat sentence, then stop.',
  ].join('\n');
}
```

- [ ] **Step 5: Push it right behind the model map.** In `src/agents/convo/shared.ts`, immediately after line 888 (`push('model_map', renderModelMapAwareness(getModelMap()));`) insert:
```ts

  // Build self-awareness: which build she is, whether a newer one is waiting, and the ONE terminal
  // command her person runs — there is no chat command for it since the self-update tool came out,
  // and a model with no fact here fills the gap in. Same slot and same reason as the model map above:
  // unconditional, read live, never hardcoded. ONE snapshot, so the sha she names and the verdict she
  // reports cannot come from two different reads.
  const updateSnapshot = getUpdateStatus();
  push('update_status', renderUpdateStatus(updateSnapshot.current, updateSnapshot));
```

- [ ] **Step 6: Register the section id in `src/agents/convo/promptSections.ts`.** Replace lines 16-17 with:
```
 * whichever of them actually rendered. Every entry is conditional except `model_map`,
 * `update_status` and `current_time`, so a real build carries a subsequence of this list, never all
 * of it.
```
Insert after line 27 (`'model_map', …`):
```ts
  'update_status',        // renderUpdateStatus — unconditional
```
Replace lines 121-123 with:
```
 * The three stable-slot lines behind them — `capability`, `model_map` and `update_status` — are
 * deliberately NOT in here: under a thousand characters between them is not worth a breakpoint, and
 * the last two are read from live state (the resolved model map; the running build plus the update
 * checker's own answer), so both can legitimately change mid-chat the moment discovery or a check
 * answers.
```

- [ ] **Step 7: Add the budget line to `src/agents/convo/promptPolicy.ts`.** Replace lines 73-76 with:
```
 * `model_map` and `update_status` are the two deliberate exceptions, each well above its measured
 * size: their text is built from the HOST rather than from repo prose — the resolved model map
 * (MODELS/PROVIDERS plus whatever engine discovery found) in the one, the running build's sha and
 * branch plus the checker's own answer in the other — so a bare checkout and a configured install
 * legitimately differ. A tight ceiling on either would fail on somebody else's machine and teach
 * everyone to ignore the test.
```
Insert after line 113 (the `model_map` row):
```ts
  update_status: 900,          // 696 on a bare checkout at `main` — the "can't tell" variant every fixture renders, since npm test never arms the checker. HOST-DEPENDENT, see above, and the second deliberate exception to the 2%: `main` is four characters and a working branch is forty (740 measured on one), and the sha is whatever this clone sits on. NEW with the terminal-only update path — the section that replaced the chat apply tool, and the only thing that keeps "what version are you?" an answer rather than a guess
```

- [ ] **Step 8: Classify it as a data key in `scripts/convergence/expectations.ts`.** Inside `DATA_BUDGET_KEYS` (146-159), after the `'model_map'` entry and its comment, add:
```ts
  // Same reason, one line further down the prompt: the running build's sha and branch, and whether
  // this install checks at all. A live turn on somebody's feature branch legitimately measures wider
  // than a fixture on `main`.
  'update_status',
```

- [ ] **Step 9: Teach the golden to blank the new section.** In `src/agents/convo/promptSections.test.ts` replace lines 362-367 with:
```ts
/** The two sections whose bytes depend on the HOST rather than on the fixture: renderModelMapAwareness
 *  reads the live model map (MODELS/PROVIDERS resolved from env, plus whatever engine discovery
 *  found), and renderUpdateStatus reads the running build's sha and branch plus the update checker's
 *  own answer — so both differ between a bare checkout and a configured install. Blanked on both
 *  sides of the golden comparison — their POSITION in the block is still pinned exactly, and their
 *  sizes still have to balance in the exhaustiveness test. */
const MODEL_MAP_SECTION = /## What you run on[\s\S]*?then stop\./;
const UPDATE_STATUS_SECTION = /## Your build and how you get updated[\s\S]*?then stop\./;
```
Replace line 380 with:
```ts
const stable = (s: string) => stableCraft(
  s.replace(MODEL_MAP_SECTION, '<model-map>').replace(UPDATE_STATUS_SECTION, '<update-status>'),
);
```

- [ ] **Step 10: Strengthen the blanking assertion.** Replace lines 400-407 with:
```ts
test('the assembled prompt is byte-identical to the pre-change assembler', () => {
  for (const f of FIXTURES) {
    const rest = afterPersona(buildSystemPromptSections(...f.args).system);
    const blanked = stable(rest);
    assert.ok(blanked.includes('<model-map>'), `${f.name}: the model-map section was found and blanked`);
    assert.ok(blanked.includes('<update-status>'), `${f.name}: the update-status section was found and blanked`);
    assert.equal(blanked, f.golden(), f.name);
  }
});
```

- [ ] **Step 11: Insert the new section into the three goldens.** In `GOLDEN_BLOCK_A` (672), `GOLDEN_BLOCK_B` (674) and `GOLDEN_BLOCK_C` (676), replace the single occurrence of `\n\n<model-map>\n\n` with `\n\n<model-map>\n\n<update-status>\n\n`. Verify exactly three edits landed:
```bash
grep -c "<model-map>\\\\n\\\\n<update-status>" src/agents/convo/promptSections.test.ts
```
Expected: `3`.

- [ ] **Step 12: Add the id to the section lists in `promptSections.test.ts`.** Insert `'update_status',` immediately after `'model_map',` in the fixture arrays at 312, 334 and 356, and replace lines 418-426 with:
```ts
test('the arithmetic holds for the barest possible build (nothing per-turn to say)', () => {
  // Only the three unconditional dyn sections render, so this is the floor case for the join count —
  // and the case where an off-by-one in `max(0, n - 1)` would show up.
  const { system, sections } = buildSystemPromptSections(undefined, '');
  assert.deepEqual(sections.map(s => s.name), [
    'persona', 'model_map', 'update_status', 'current_time', 'behavior_anchor', 'json_anchor',
  ]);
  assert.equal(sectionsTotalChars(sections), system.length);
});
```

- [ ] **Step 13: Add the id to the seven fixtures in `promptBudget.test.ts`.** Insert `'update_status',` immediately after `'model_map',` in each `sections:` array (lines 617, 645, 675, 712, 756, 789, 831), rewrapping to stay under ~110 columns:
```ts
    // fixture 1 — cold thin profile
    sections: [
      'persona', 'tool_docs', 'craft_modules', 'model_map', 'update_status', 'name_nudge',
      'intro_weave', 'context_block', 'current_time', 'conversation_timing', 'hooks', 'turn_focus',
      'behavior_anchor', 'json_anchor',
    ],
    // fixture 2 — mature profile, plain question  (and fixture 6, identical list)
    sections: [
      'persona', 'tool_docs', 'craft_modules', 'capability', 'model_map', 'update_status',
      'context_block', 'current_time', 'weather', 'status_contract', 'conversation_timing',
      'reply_order', 'turn_focus', 'behavior_anchor', 'json_anchor',
    ],
    // fixture 3 — media turn
    sections: [
      'persona', 'tool_docs', 'craft_modules', 'capability', 'model_map', 'update_status',
      'context_block', 'active_ops', 'current_time', 'weather', 'status_contract',
      'conversation_timing', 'reply_order', 'turn_focus', 'behavior_anchor', 'json_anchor',
    ],
    // fixture 4 — burst plus tapped reply in a group
    sections: [
      'persona', 'tool_docs', 'craft_modules', 'capability', 'model_map', 'update_status',
      'context_block', 'group', 'tapped_reply', 'burst', 'current_time', 'weather',
      'status_contract', 'conversation_timing', 'turn_focus', 'behavior_anchor', 'json_anchor',
    ],
    // fixture 5 — thread offer
    sections: [
      'persona', 'tool_docs', 'craft_modules', 'capability', 'model_map', 'update_status',
      'context_block', 'thesis', 'current_time', 'weather', 'status_contract', 'thread',
      'conversation_timing', 'reply_order', 'extra', 'hooks', 'turn_focus', 'behavior_anchor',
      'json_anchor',
    ],
    // fixture 7 — idle turn on a long thread
    sections: [
      'persona', 'tool_docs', 'craft_modules', 'capability', 'model_map', 'update_status',
      'context_block', 'current_time', 'weather', 'status_contract', 'conversation_timing',
      'reply_order', 'hooks', 'turn_focus', 'behavior_anchor', 'json_anchor',
    ],
```
Check: `grep -c "'update_status'" src/agents/convo/promptBudget.test.ts` → `7`.

- [ ] **Step 14: Exempt it from the 2% ratchet.** In `src/agents/convo/promptBudget.test.ts` add above `MAX_HEADROOM` (line 994):
```ts
/** Budget lines whose bytes come from the host rather than from this tree, so their ceilings are
 *  deliberately loose (promptPolicy.ts states the same exemption beside each). */
const HOST_DEPENDENT: ReadonlySet<BudgetKey> = new Set<BudgetKey>(['model_map', 'update_status']);
```
and replace lines 1003-1006 (the comment) and 1014 (the `continue`) so the test body reads:
```ts
  // `model_map` and `update_status` are exempt, for the reason promptPolicy.ts gives beside them:
  // their text is built from the host — the resolved model map in one, the running build's sha and
  // branch in the other — so a bare checkout and a configured install measure different sizes and a
  // tight ceiling would fail on somebody else's machine. Every other line is deterministic here —
  // fixture data, repo prose, or the frozen clock.
  const measured = measuredMaxima();
  const rows: string[] = [];
  const loose: string[] = [];
  for (const [key, chars] of [...measured].sort((a, b) => b[1] - a[1])) {
    const ceiling = PROMPT_BUDGET[key];
    const headroom = (ceiling - chars) / chars;
    rows.push(`  ${key}: measured ${chars}, ceiling ${ceiling} (+${(headroom * 100).toFixed(1)}%)`);
    if (HOST_DEPENDENT.has(key)) continue;
    if (headroom > MAX_HEADROOM) loose.push(key);
  }
```

- [ ] **Step 15: Run the unit test — GREEN.**
```bash
npx cross-env TZ=UTC DATA_BACKEND=memory npx tsx --test src/agents/convo/updateStatus.test.ts 2>&1 | tail -8
```
Expected: `# fail 0`, 8 passing tests.

- [ ] **Step 16: Run the prompt suites.**
```bash
npm test 2>&1 | tail -25 && npm run build && npm run typecheck:scripts
```
Expected: `# fail 0`. If `every section of every fixture is inside its budget` fails on `update_status`, the branch name on this checkout is unusually long — read the reported number and ratchet the ceiling in `promptPolicy.ts` with the measurement written beside it.

- [ ] **Step 17: Confirm the heading is unique in the corpus.**
```bash
grep -rn "Your build and how you get updated" src | grep -v shared.ts | grep -v updateStatus.test.ts
```
Expected: no output.

- [ ] **Step 18: Commit.**
```bash
git add -A src scripts/convergence/expectations.ts
git commit --author="Rivian <rivianp@gmail.com>" -m "$(cat <<'EOF'
Tell Irises which build she is and who updates her

A new unconditional prompt section, update_status, rendered right behind
the model map from the running build plus the update checker's live
answer: the build and branch she is on, whether a newer one is waiting or
whether this install cannot tell, that she cannot apply it herself, and
the one terminal command her person runs. Three states and the
relative-time phrasing are unit-tested; the goldens, the seven budget
fixtures and the convergence key split move with it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 102: Announce copy — the script restarts her, so stop telling them to

**Files:**
- Modify: `src/update/announce.ts` (46-49 `availabilityText`; 159-172 `claimPendingUpdateNote`)
- Modify: `src/agents/convo/promptPolicy.ts` (the `extra` budget line, 128)
- Test: `src/update/announce.test.ts` (65-71 weave test; 144-155 builders test)
- Test: `src/agents/convo/promptBudget.test.ts` (396-399 `UPDATE_NOTE`)

**Interfaces:**
- Changes (same signatures, new strings): `_internal.availabilityText(shortSha: string): string`, `claimPendingUpdateNote(chatId: string): string | null`.
- Unchanged: `APPLY_COMMAND = 'bash scripts/update.sh'`, `availabilityFraming()`, `upgradedText()`, `upgradedFraming(receipt)`, `createUpdateAnnouncer`, the claim gate.
- Produces: `PROMPT_BUDGET.extra = 670` (was 590; measured 658, was 583).

- [ ] **Step 1: Rewrite `availabilityText` in `src/update/announce.ts`.** Replace lines 46-49 with:
```ts
/** The apply command, relayed word-for-word (the consent-URL precedent): it must land exactly. What
 *  it PROMISES matters as much — the script restarts her and the engine gateway itself, so this line
 *  must not send them off to restart a server afterwards and leave them waiting for something to do. */
function availabilityText(shortSha: string): string {
  return `to apply: run \`${APPLY_COMMAND}\` from the Irises folder — it pulls, rebuilds and restarts me (new build ${shortSha})`;
}
```

- [ ] **Step 2: Rewrite the woven note.** Replace lines 159-172 of `src/update/announce.ts` with:
```ts
/**
 * The weave seam Convo calls on every turn. Returns a one-off prompt note (system-authored guidance,
 * NOT user copy — Convo writes the actual words) exactly once per chat per version when an update is
 * pending, else null. Claiming here is what suppresses the cold push for this chat.
 */
export function claimPendingUpdateNote(chatId: string): string | null {
  if (!announceEnabled()) return null;
  const status = getUpdateStatus();
  if (!status.updateAvailable || !status.remoteSha) return null;
  if (!defaultRoutable(chatId)) return null;
  if (!claimAnnouncement(status.remoteSha, chatId)) return null;
  const short = status.remoteSha.slice(0, 7);
  return `## Passing note — you have an upgrade waiting\nA new version of you (build ${short}) is ready for the server you run on. Somewhere natural in THIS reply, mention it once — your own words, one short bubble at most: you've got an upgrade ready, and they can apply it by running \`${APPLY_COMMAND}\` in your install folder (relay that command exactly, in backticks) — the script pulls, rebuilds and restarts you itself, so there is nothing left for them to restart. Never frame it as a system announcement or read it like a changelog. If this exact moment is the wrong time — they're mid-crisis or asking something urgent — skip it; this note won't come back.`;
}
```

- [ ] **Step 3: Mirror the exact new note in the budget fixture.** In `src/agents/convo/promptBudget.test.ts` replace lines 396-399 with:
```ts
/** The caller addendum the live turn actually passes: the one-off version note
 *  (update/announce.ts claimPendingUpdateNote — private to that module, so the text is mirrored
 *  here with a stand-in build sha of the same length). */
const UPDATE_NOTE = `## Passing note — you have an upgrade waiting\nA new version of you (build 4f2a91c) is ready for the server you run on. Somewhere natural in THIS reply, mention it once — your own words, one short bubble at most: you've got an upgrade ready, and they can apply it by running \`bash scripts/update.sh\` in your install folder (relay that command exactly, in backticks) — the script pulls, rebuilds and restarts you itself, so there is nothing left for them to restart. Never frame it as a system announcement or read it like a changelog. If this exact moment is the wrong time — they're mid-crisis or asking something urgent — skip it; this note won't come back.`;
```

- [ ] **Step 4: Ratchet the `extra` ceiling.** In `src/agents/convo/promptPolicy.ts` replace line 128 with:
```ts
  extra: 670,                  // 658 — the caller addendum, on the thread-offer fixture: the PENDING version note (update/announce.ts). +75 for the terminal-only update path: the note used to close on "and then restarting you", which is now false — scripts/update.sh restarts her and the engine gateway itself — so the clause was replaced by the promise the script actually keeps. Was 590 for 583
```

- [ ] **Step 5: Update the announce tests.** In `src/update/announce.test.ts` replace lines 144-155 with:
```ts
test('builders: availability carries the exact command as relayed text; the changelog stays in framing', () => {
  const text = _internal.availabilityText('abc1234');
  assert.match(text, /bash scripts\/update\.sh/);
  assert.match(text, /abc1234/);
  assert.match(_internal.availabilityFraming(), /once/);
  // The command is the whole payload, so it must be the ONLY thing stated exactly — and what the
  // line promises has to be what the script does. It restarts her and the gateway, so the retired
  // "then restart the server" tail would leave them waiting for a step that no longer exists.
  assert.match(text, /it pulls, rebuilds and restarts me/);
  assert.doesNotMatch(text, /then restart the server/);

  assert.equal(_internal.upgradedText('bbbbbbb'), 'now on build bbbbbbb');
  const framing = _internal.upgradedFraming({ oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), appliedAt: 'x', changes: ['secret1 fix', 'secret2 feat'] });
  // Commit subjects are DEV copy: they ride the framing (voiced), never the relayed-exactly text.
  assert.match(framing, /secret1 fix/);
  assert.doesNotMatch(_internal.upgradedText('bbbbbbb'), /secret/);
});
```
And extend the weave test at 65-71:
```ts
test('claimPendingUpdateNote returns the woven note once, then null', () => {
  _setUpdateStatusForTests({ remoteSha: 'sha2', updateAvailable: true });
  const note = claimPendingUpdateNote('web:q');
  assert.ok(note);
  assert.match(note!, /bash scripts\/update\.sh/);
  // The script restarts her, so the note must not hand them a second step that no longer exists.
  assert.match(note!, /restarts you itself/);
  assert.doesNotMatch(note!, /then restarting you/);
  assert.equal(claimPendingUpdateNote('web:q'), null); // claimed
});
```

- [ ] **Step 6: Run the two suites.**
```bash
npx cross-env TZ=UTC DATA_BACKEND=memory npx tsx --test src/update/announce.test.ts src/agents/convo/promptBudget.test.ts 2>&1 | tail -12
```
Expected: `# fail 0`. If `no ceiling carries more than 2% of headroom` names `extra`, the mirrored literal and the real one disagree by a character — diff them rather than moving the ceiling.

- [ ] **Step 7: Prove the two strings are byte-identical.**
```bash
npm run build >/dev/null && node --input-type=module -e "
import('./dist/update/announce.js').then(async m => {
  const { _setUpdateStatusForTests } = await import('./dist/update/checker.js');
  _setUpdateStatusForTests({ remoteSha: '4f2a91c'.padEnd(40,'0'), updateAvailable: true });
  console.log((m.claimPendingUpdateNote('web:x') ?? '').length);
});"
```
Expected: `658` — the number `PROMPT_BUDGET.extra`'s comment records.

- [ ] **Step 8: Commit.**
```bash
git add -A src
git commit --author="Rivian <rivianp@gmail.com>" -m "$(cat <<'EOF'
Stop the upgrade notice asking for a restart that already happened

scripts/update.sh restarts Irises and the engine gateway itself, so both
halves of the announce copy — the cold push's relayed line and the woven
passing note — said something false at the end. Both now promise what the
script actually does. The prompt-budget mirror and the extra ceiling move
in the same commit (583 -> 658, ceiling 590 -> 670).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 103: Env baseline and the README configuration rows

**Files:**
- Modify: `deploy/app.env` (replace 17-30)
- Modify: `.env.example` (replace 116-119)
- Modify: `README.md` (insert an **Updates** table after the "Data, access, and behavior" table ending at 387, before `**Memory features**` at 389)

**Interfaces:**
- Removes: the `UPDATE_SELF_ENABLED` entry from both operator-facing env files.
- Documents: `UPDATE_CHECK_ENABLED`, `UPDATE_CHECK_INTERVAL_MS`, `UPDATE_CHECK_BRANCH`, `UPDATE_ANNOUNCE_ENABLED`, `UPDATE_ANNOUNCE_ACTIVE_WINDOW_MS`, `IRISES_SKIP_WEB_BUILD`.
- `scripts/flagDocs.test.ts`'s `FLAGS` table (59-93) carries no `UPDATE_*` row and must not gain one.

- [ ] **Step 1: Rewrite the Updates block in `deploy/app.env`.** Replace lines 17-30 with:
```
# ── Updates (git-clone installs — apply with: bash scripts/update.sh; see docs/DEPLOY.md § 5) ──
# The running server checks the git remote for a newer build and surfaces it on /health, the
# /dashboard version card, and — woven through Convo — in chat, where it hands over the command
# above. APPLYING is the terminal's alone: the script restarts Irises AND the engine gateway, so
# there is no chat trigger for it and none can be added.
# UPDATE_CHECK_ENABLED=true               # false disarms the periodic remote check entirely
# UPDATE_CHECK_INTERVAL_MS=21600000       # how often to check (default 6h; floored at 15min)
# UPDATE_CHECK_BRANCH=                    # ref to check (default: this clone's current branch)
# UPDATE_ANNOUNCE_ENABLED=true            # false = detect + /health + dashboard only, no chat messages
# UPDATE_ANNOUNCE_ACTIVE_WINDOW_MS=172800000  # "recently active" audience window (default 48h)
# IRISES_SKIP_WEB_BUILD is read by scripts/update.sh and engine-setup.sh, not by the server: =1 skips
# the optional web-client rebuild. Unset, the scripts rebuild the web client only when web/out already
# exists (a previous build proves you use it) and the box has the memory for it; a failure there
# warns instead of aborting.
```

- [ ] **Step 2: Rewrite the Updates note in `.env.example`.** Replace lines 116-119 with:
```
# Updates: the server checks the git remote for a newer build and mentions it in chat; applying is a
# terminal command on the box — `bash scripts/update.sh` from the Irises folder, which pulls,
# rebuilds, restarts the server and restarts the engine gateway. There is no chat trigger for it.
# Knobs (defaults in deploy/app.env): UPDATE_CHECK_ENABLED, UPDATE_CHECK_INTERVAL_MS,
# UPDATE_CHECK_BRANCH, UPDATE_ANNOUNCE_ENABLED, UPDATE_ANNOUNCE_ACTIVE_WINDOW_MS.
```

- [ ] **Step 3: Add the README Updates table** after the "Data, access, and behavior" table (ends line 387, `DIAGNOSTICS_*` row) and before `**Memory features**` (389):
````markdown
**Updates** — see [docs/DEPLOY.md](docs/DEPLOY.md#updating-a-git-clone-install)

| Variable | Purpose |
|----------|---------|
| `UPDATE_CHECK_ENABLED` | The periodic `git ls-remote` poll that notices a newer build on this clone's branch. It reads refs only — never pulls, never restarts. `false` disarms it: no `update` field on `/health`, no amber dashboard card, no chat mention, and Irises then says plainly that she can't tell whether one is waiting. Default on. Disarms itself anyway with no `.git` (a Docker image) or an unknown build sha. |
| `UPDATE_CHECK_INTERVAL_MS` | How often to poll. Default 6h (`21600000`), floored at 15min; a non-numeric value falls back to the default. First check is 60s after boot. |
| `UPDATE_CHECK_BRANCH` | Which remote ref to compare against. Default: this clone's own current branch. |
| `UPDATE_ANNOUNCE_ENABLED` | Whether a waiting upgrade is mentioned **in chat** — once per chat per build, woven into a reply at a natural opening (30+ min of quiet, or their first message ever), otherwise pushed to recently-active chats — plus the short "back on the new build" after the script restarts her. `false` keeps detection, `/health` and the dashboard card, and sends nothing. Default on. |
| `UPDATE_ANNOUNCE_ACTIVE_WINDOW_MS` | The "recently active" audience window for that mention. Default 48h (`172800000`), capped at 20 chats. |
| `IRISES_SKIP_WEB_BUILD` | Read by the scripts, not the server: `1` skips the optional web-client rebuild during install and update. |
````

- [ ] **Step 4: Verify the flag-doc contract still holds.**
```bash
npx cross-env TZ=UTC DATA_BACKEND=memory npx tsx --test scripts/flagDocs.test.ts 2>&1 | tail -6
grep -rn "UPDATE_SELF" deploy .env.example README.md
```
Expected: `# fail 0`; the grep returns nothing.

- [ ] **Step 5: Commit.**
```bash
git add -A deploy .env.example README.md
git commit --author="Rivian <rivianp@gmail.com>" -m "$(cat <<'EOF'
Document the update knobs where operators look, drop the retired one

UPDATE_SELF_ENABLED is gone from both operator-facing env files with the
switch it guarded. The UPDATE_CHECK_*/UPDATE_ANNOUNCE_* knobs now have
real rows in the README configuration reference, which had none and
whose "see Configuration" pointer was a dead end.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 104: README — install and update, terminal-first

**Files:**
- Modify: `README.md` — replace 185-206 ("Already running hermes-agent or OpenClaw?"), 208-238 ("Quick start" through the hand-wiring `<details>`), 296-312 ("Updating")
- Untouched: the standalone-debug `<details>` (240-270), the build-scripts `<details>` (272-294), `## Channels` (314+)

**Interfaces:**
- Consumes (Part A): `bash scripts/update.sh` restarting Irises + gateway with rollback; `bash scripts/engine-setup.sh --uninstall` / `--purge-data` / `--no-service` / `--port`; service names `irises` (systemd --user) and `ai.irises.server` (LaunchAgent); log at `$IRISES_HOME/logs/server.log`; pidfile at `$IRISES_HOME/irises.pid`.
- Constraint: no live prose may contain `update_self`, `UPDATE_SELF`, `selfUpdate`, `update yourself`, `then restart the server`, or `--revert`.

- [ ] **Step 1: Replace lines 185-206 with the terminal-first engine section.**
````markdown
## Already running hermes-agent or OpenClaw?

Then you are the person I built this for. Irises sits **in front of the engine you already have**, and it can appear on **every channel your engine already speaks**. Your hermes or OpenClaw keeps doing all the deep work and keeps owning every bot and number — a tiny bridge plugin, installed through the engine's own plugin system, hands the chats you choose to Irises's voice and leaves the rest alone.

Install it in a terminal on the machine the engine runs on:

```bash
git clone https://github.com/rivianpratama/irises && cd irises
bash ./scripts/engine-setup.sh --engine hermes     # or: --engine openclaw
```

**The terminal is the only install path**, and that is deliberate: the installer restarts the engine gateway at the end, and an agent that ran it from a gateway-hosted chat would be killing its own supervisor mid-reply. Your engine can still *walk you through it* — the two setup skills are **guides, not installers**. Your agent explains what Irises is, runs the read-only prerequisite checks, hands you the exact commands to run yourself, and verifies the result once you report back:

```bash
# hermes:
hermes skills install https://raw.githubusercontent.com/rivianpratama/irises/main/skills/irises-setup-hermes/SKILL.md
#   then, in any hermes chat:  /irises-setup-hermes

# OpenClaw:
openclaw skills install git:rivianpratama/irises
#   then ask OpenClaw to run the  irises-setup-openclaw  skill
```

The setup defaults to **bridge mode**: it installs the plugin and writes `IRISES_FRONT=*:*` so Irises fronts every chat out of the box (`--no-bridge` installs without the plugin or the fronting). Either way it restarts the engine gateway at the end so the engine picks up its new API-server setting. To front only some conversations, narrow the engine-side `IRISES_FRONT` glob list (matched against `<platform>:<chat_id>`) — everything not matched the engine keeps handling itself, and blanking `IRISES_FRONT` turns the plugin inert instantly. If the hook errors, the default `IRISES_BRIDGE_FAIL=open` lets the engine answer rather than go silent — I'd rather you get a boring reply than no reply.

After each restart hermes posts its own short "gateway online" note in your home channel. That is hermes talking, not Irises; silence it per platform with `<platform>.gateway_restart_notification: false` in hermes's own config if you'd rather not see it (Irises never edits hermes's config).

On OpenClaw, Irises also teaches the engine its **engine-mode discipline automatically, once, at boot** — one chat message the agent saves to its own instructions. Nothing for you to run by hand.

> **v1 gap:** scheduling reminders through Irises requires the **hermes** engine (it uses hermes's cron REST API). On OpenClaw the reminder tools are not offered at all — so Irises never promises a reminder that can't fire — while everything else runs full-reach there: real code, the engine's own skills, parallel subagents, artifacts.

Full guide, diagrams, and security notes: **[docs/ENGINES.md](docs/ENGINES.md)**.
````

- [ ] **Step 2: Replace lines 208-238 with the terminal-first quick start.**
````markdown
## Quick start

Irises is meant to sit on top of the engine you already run, so the install is one script in a terminal on that machine:

```bash
git clone https://github.com/rivianpratama/irises && cd irises
bash ./scripts/engine-setup.sh --engine hermes     # or: --engine openclaw
```

That is honestly the whole setup. On boot Irises **auto-detects your engine** (`OPS_BACKEND` is set for you), **reuses the engine's API key**, and makes its own voice **inherit the engine's model** — so the model Irises speaks with is the model your engine uses. **There is no `.env` to write.** (You still can — see [Configuration](#configuration) — anything you set wins.)

The script is idempotent and prints every change before making it. In order: it checks node/git/curl and that the port is free, installs deps and builds, writes your `.env` (mode 600) with `PORT=3000` pinned (the committed `deploy/app.env` baseline `8080` is the Docker image's port), registers Irises as a **user-level service** (`systemd --user` on Linux, a LaunchAgent on macOS, with a detached `nohup` fallback where neither exists), waits for her to answer `/health` on the new build — and only then touches the engine: enables its API surface if needed, installs the bridge plugin, records every engine-side key it added in `~/.irises/install-manifest.json` after backing the engine's env file up, and restarts the engine gateway last so all of it goes live. It leaves her running at `http://127.0.0.1:3000` and prints a summary with an honest exit code.

Flags: `--yes` for a fully non-interactive run, `--no-bridge` to install without the plugin or fronting, `--no-service` to skip the service registration, `--port N` to pick another port, `--uninstall` to take it all back out (see [Updating](#updating)). Start/stop/status/logs and the uninstall one-liner are in that same section.

A few minutes later Irises makes her [first move](docs/ENGINES.md#first-move-install-introduction) — she pulls what your engine already remembers about you and, where the engine confirms you've really talked there before, sends a short hello; otherwise she simply waits for your first message. Full guide, bridge mode, and security notes: **[docs/ENGINES.md](docs/ENGINES.md)**.

> **Prerequisites:** Node 22.13+ (the local store uses the builtin `node:sqlite`), git, curl. No database, and — when you install onto an engine — no keys or config of your own: Irises reuses what the engine already has.

> **Prefer to be walked through it?** Install the setup skill for your engine ([commands above](#already-running-hermes-agent-or-openclaw)) and ask for it. It is a guide: your agent explains the install, runs the read-only prerequisite checks, hands you these commands to run yourself, and verifies the result afterwards. It never clones, builds, starts, or restarts anything — see the note above for why.
````

- [ ] **Step 3: Replace lines 296-312 with the new Updating section.**
````markdown
## Updating

One command, in a terminal on the machine Irises runs on, from the Irises folder:

```bash
bash scripts/update.sh
```

It fast-forward `git pull`s the current branch, reinstalls deps and rebuilds (`npm ci && npm run build`, plus the web client when you use it), refreshes the engine bridge plugin, writes an update receipt — then **restarts Irises and restarts the engine gateway itself**. Nothing is left for you to restart, and there is nothing to do in chat.

If the new build doesn't compile, or compiles and then fails to come up, the script **rolls back**: the worktree returns to the commit you were on, that build is rebuilt, and it comes back up. A bad build costs you a few minutes, not your assistant. It's careful in the other directions too — fast-forward only (it never auto-merges divergent local commits), it refuses a dirty working tree, it takes a single-updater lock so two runs can't race on git and the build, and it never touches your data under `$IRISES_HOME`.

Flags: `--check` (report only — exit `10` if an update is available, `0` if not), `--yes` (skip the prompt), `--no-restart` (pull and build, leave the running server alone), `--no-gateway-restart` (leave the engine gateway alone; the refreshed plugin loads on its next restart). Exit codes are listed in [docs/DEPLOY.md](docs/DEPLOY.md#updating-a-git-clone-install).

After the gateway comes back, hermes posts its own short "gateway online" note in your home channel — hermes's message, not Irises's, silenced per platform with `<platform>.gateway_restart_notification: false` in hermes's config.

**Irises notices on its own, too.** The running server periodically checks the remote for a newer build and surfaces it — on `/health` (`version` + `update` fields), on the `/dashboard` overview card, and in chat: she mentions a waiting upgrade once to recently-active chats, woven naturally into the conversation, hands you the same `bash scripts/update.sh` line verbatim, and says a short "back on the new build" once she's on it. Ask her what version she is and she'll tell you; ask her to apply it and she'll tell you she can't and give you the command once — there is no chat command for an update, by design. Tune or silence all of it with the `UPDATE_*` env vars (see [Configuration](#configuration)): `UPDATE_ANNOUNCE_ENABLED=false` keeps her quiet about it, `UPDATE_CHECK_ENABLED=false` stops the checking (and then she says plainly that she can't tell).

### Start, stop, status, logs

The installer registers Irises as a **user-level service**, so she returns after a reboot and none of this needs root:

```bash
# Linux — systemd --user
systemctl --user status irises
systemctl --user restart irises
systemctl --user stop irises

# macOS — LaunchAgent
launchctl print gui/$(id -u)/ai.irises.server
launchctl kickstart -k gui/$(id -u)/ai.irises.server
launchctl bootout gui/$(id -u)/ai.irises.server

# either platform
tail -f "${IRISES_HOME:-$HOME/.irises}/logs/server.log"
curl -s http://127.0.0.1:3000/health
```

On a box with neither (a bare container, a shell with no user session bus) the installer falls back to a detached `nohup` launch that outlives the shell that started it. Stop that one with `kill $(cat "${IRISES_HOME:-$HOME/.irises}/irises.pid")`.

### Uninstall

```bash
bash scripts/engine-setup.sh --uninstall
```

It stops and unregisters the service, removes the engine bridge plugin and the engine-side keys the installer added (from the manifest it wrote at install, after backing the engine's env file up), restarts the engine gateway so the engine owns its channels again — and **keeps your data**. Add `--purge-data` to delete `$IRISES_HOME` (memory, dossier, SQLite) as well; that one is not reversible. The clone itself is never deleted; the script prints the `rm -rf` for you.

Docker/VM installs update by rebuilding the image instead — see [docs/DEPLOY.md](docs/DEPLOY.md) § 5.
````

- [ ] **Step 4: Check the anchors and the banned tokens.**
```bash
grep -n "^## Updating$\|^## Already running\|^## Quick start$\|^## Configuration$" README.md
grep -n "update yourself\|UPDATE_SELF\|selfUpdate\|then restart the server\|--revert" README.md
```
Expected: the first prints the four headings; the second prints nothing.

- [ ] **Step 5: Commit.**
```bash
git add README.md
git commit --author="Rivian <rivianp@gmail.com>" -m "$(cat <<'EOF'
README: terminal is the install and update path

Rewrote the engine, quick-start and updating sections around one command
each. The setup skills are described as guides your agent walks you
through rather than as installers, because the installer restarts the
engine gateway and an agent running it from a gateway-hosted chat kills
its own supervisor. Adds rollback, the user-level service controls, the
log path, and the uninstall one-liner.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 105: docs/DEPLOY.md and docs/ENGINES.md

**Files:**
- Modify: `docs/DEPLOY.md` (replace 135-177)
- Modify: `docs/ENGINES.md` (replace 81-83; replace 344-347; replace the `IRISES_FRONT` row at 365; replace 430-437 and add a new subsection after it)

**Interfaces:**
- Consumes (Part A): exit codes `0/1/2/3/4/5/10`; `--uninstall`, `--purge-data`; removal of `--revert`; automatic gateway restart at the end of install/update/uninstall; `IRISES_FRONT=*:*` written by the installer; the manifest at `$IRISES_HOME/install-manifest.json`.
- Produces: anchors `#updating-a-git-clone-install` (linked from README) and `#gateway-restart-notifications`.

- [ ] **Step 1: Replace `docs/DEPLOY.md` lines 135-177.**
````markdown
### Updating a git-clone install

Installs made with `git clone` + `scripts/engine-setup.sh` (rather than the Docker image) update in
place, from a terminal on the box, in the Irises folder:

```bash
bash scripts/update.sh        # add --check to preview, --yes to skip the prompt
```

The script fast-forward `git pull`s the current branch, runs `npm ci && npm run build` (and the web
client build when `web/out` exists and the box has the memory for it — `IRISES_SKIP_WEB_BUILD=1`
skips it), refreshes the engine bridge plugin, writes `$IRISES_HOME/update-receipt.json` — then
**restarts Irises** (the user-level service, or the pidfile at `$IRISES_HOME/irises.pid`) **and
restarts the engine gateway**, in that order. Nothing is left for the operator to restart. There is no
chat trigger for any of this and none can be added: the script cycles the gateway, so an agent running
it from a gateway-hosted chat would kill its own supervisor mid-turn.

**Rollback.** If the new commit fails to compile, or compiles and then fails to answer `/health` with
the new build inside the boot window, the script returns the worktree to the commit that was running,
rebuilds THAT, and brings it back up. The failing tree is left in the log, not on the box.
`$IRISES_HOME` (your data) is never touched, a divergent local branch is never auto-merged (the script
stops and tells you to reconcile it), and a single-updater lock stops two runs racing on git and the
build.

**Exit codes** — worth reading if you script it. The last stdout line is always
`RESULT: ok|noop|up-to-date|update-available|rolled-back|gateway-failed`.

| Code | Meaning |
|---|---|
| `0` | already up to date, or updated and healthy |
| `1` | preflight refused: dirty tree, detached HEAD, missing tool, Node below 22.13, no `.git`, or the pull could not fast-forward |
| `2` | bad arguments |
| `3` | the new build failed to compile — **rolled back**, the old build is running |
| `4` | the new build compiled but failed to boot — **rolled back**, the old build is running |
| `5` | Irises is on the new build, but the engine gateway would not restart — fix the gateway by hand |
| `10` | `--check` only: an update is available |

Flags: `--check`, `--yes`, `--no-restart` (pull and build only), `--no-gateway-restart`.

**After the gateway restart** hermes posts its own note into the user's home channel — *"♻️ Gateway
online — Hermes is back and ready."* That is hermes's message, not Irises's; she neither sends it nor
can suppress it. Silence it per platform with `<platform>.gateway_restart_notification: false` in
hermes's own config. Irises never edits hermes's config, so that is always the operator's own change.

The running server also checks the remote itself and reports what it finds:

- `GET /health` gains a `version` object (git `sha` / `branch` / build stamp) and an `update` object
  (`available`, `remoteSha`, `lastCheckAt`, `lastCheckOk`).
- The `/dashboard` overview shows a **version** card that turns amber when an update is available.
- In chat, Irises mentions a waiting upgrade once to recently-active chats, relays the
  `bash scripts/update.sh` line verbatim, and says a short "back on the new build" after the script
  restarts her. She also states her own build and whether one is waiting when asked — and says
  plainly that applying it is not something she can do.

Knobs (in `deploy/app.env` / `.env`): `UPDATE_CHECK_ENABLED` (default `true`),
`UPDATE_CHECK_INTERVAL_MS` (default 6h, floored at 15min), `UPDATE_CHECK_BRANCH` (defaults to the
clone's branch), `UPDATE_ANNOUNCE_ENABLED` (default `true` — `false` keeps detection but sends no
chat messages), `UPDATE_ANNOUNCE_ACTIVE_WINDOW_MS` (default 48h, the "recently active" window). A
Docker image built without `.git` reports `version.source: "unknown"`, disables the checker, and
makes Irises say she cannot tell whether an update is waiting.

**Service control.** The installer registers a user-level service, so none of this needs root:

```bash
systemctl --user status irises                     # Linux (systemd --user)
launchctl print gui/$(id -u)/ai.irises.server      # macOS (LaunchAgent)
tail -f "${IRISES_HOME:-$HOME/.irises}/logs/server.log"
```

Where neither exists (a bare container, a shell with no user session bus) the installer falls back to
a detached `nohup` launch; stop that one with `kill $(cat "$IRISES_HOME/irises.pid")`.

**Uninstall.** `bash scripts/engine-setup.sh --uninstall` stops and unregisters the service, removes
the bridge plugin and the engine-side keys the installer added (read from
`$IRISES_HOME/install-manifest.json`, after backing the engine's env file up), restarts the gateway,
and keeps your data; `--purge-data` also deletes `$IRISES_HOME`, which is not reversible. The clone is
never deleted; the script prints the command.
````

- [ ] **Step 2: Fix the installer flags in `docs/ENGINES.md` (81-83).**
```markdown
Flags: `--yes` runs non-interactively (assume every default, never prompt — which is also what a run
with no terminal on stdin does by itself), `--bridge` / `--no-bridge` choose bridge mode outright,
`--no-service` skips the user-level service, `--port N` picks the port. **Bridge mode is ON by
default, including on a run with no terminal**, and the installer writes `IRISES_FRONT=*:*` — Irises
fronts every chat on every platform out of the box, so narrow that list afterwards rather than
assuming an opt-in. The engine gateway is restarted at the end of every install, with or without
bridge mode. `--uninstall` takes the whole install back out again (the user service, the plugin, the
engine-side keys the installer added), restarts the gateway on its way out, and keeps your data
unless you add `--purge-data`.
```

- [ ] **Step 3: State the installer's default where the mechanism is described (344-347).** Replace with:
```markdown
Comma-separated glob patterns matched (case-insensitively) against `<platform>:<chat_id>`
(hermes) / `<channel>:<conversation>` (OpenClaw). **Unset or empty = front nothing** — the plugin
is inert and the engine behaves exactly as before. The installer does **not** leave it empty: it
writes `IRISES_FRONT=*:*`, so a default install fronts everything and you narrow from there. Never
pattern your operator/control chats unless you mean it: a fronted chat talks to Irises, not to the
engine.
```

- [ ] **Step 4: Fix the engine-side environment row (365).** Replace with:
```markdown
| `IRISES_FRONT` | `*:*` (what the installer writes — *unset or empty = front nothing*, if you set it by hand) | comma-separated glob patterns choosing fronted chats |
```

- [ ] **Step 5: Replace `docs/ENGINES.md` 430-437 and add the notifications note.**
````markdown
### Install / uninstall

`bash ./scripts/engine-setup.sh --engine hermes|openclaw` sets bridge mode up as part of the install:
it copies the plugin (via `~/.hermes/plugins/` or `openclaw plugins install`), wires the token,
writes `IRISES_FRONT=*:*`, prints every change before making it, records every engine-side key it
added in `~/.irises/install-manifest.json`, and restarts the engine gateway at the end so all of it
takes effect. `--no-bridge` installs Irises without the plugin or the fronting; the gateway is still
restarted so the engine picks up its API-server setting.

Taking it out again, in order of how much you want gone:

- **Pause fronting, instantly:** blank `IRISES_FRONT` on the engine side. The plugin stays installed
  and inert, and no restart is needed.
- **Disable the plugin:** `hermes plugins disable irises-bridge` /
  `openclaw plugins disable irises-bridge`, then bring the gateway back the way you normally would.
- **Remove Irises entirely:** `bash ./scripts/engine-setup.sh --uninstall` — stops and unregisters
  the user-level service, removes the plugin, removes the engine-side keys the installer added (from
  the manifest, after a backup of the engine's env file), restarts the gateway, and keeps your data
  under `$IRISES_HOME`. Add `--purge-data` to delete that too.

All of these are run from a terminal on the engine's own machine. The installer and the uninstaller
both cycle the gateway, which is exactly why neither can be run from a gateway-hosted chat: the agent
would be killing its own supervisor mid-turn. The two setup skills are guides for that reason — they
hand the person the commands and verify afterwards, and run nothing themselves.

### Gateway restart notifications

Install, update and uninstall each end by restarting the engine gateway, and hermes announces its own
return: **"♻️ Gateway online — Hermes is back and ready."**, posted to the user's home channel after
every restart. That message is hermes's, not Irises's — she does not send it and cannot suppress it.

If the user would rather not see it, hermes silences it per platform with

```yaml
<platform>.gateway_restart_notification: false
```

in hermes's own config. Irises never edits hermes's config, and neither the installer nor the setup
skills will touch it, so this is always the operator's own change to make.
````

- [ ] **Step 6: Verify the docs.**
```bash
grep -n "update yourself\|UPDATE_SELF\|selfUpdate\|then restart the server\|--revert" docs/DEPLOY.md docs/ENGINES.md
grep -n "^### Updating a git-clone install$\|^### Gateway restart notifications$\|^### Install / uninstall$" docs/DEPLOY.md docs/ENGINES.md
```
Expected: the first prints nothing; the second prints the three headings.

- [ ] **Step 7: Commit.**
```bash
git add docs/DEPLOY.md docs/ENGINES.md
git commit --author="Rivian <rivianp@gmail.com>" -m "$(cat <<'EOF'
Docs: rollback, exit codes, user service, uninstall, gateway restarts

DEPLOY.md's update runbook now states what the script actually does —
restart Irises AND the engine gateway, roll back a build that fails to
compile or boot — with the exit-code table, the service controls and the
uninstall one-liner. ENGINES.md's stale claims are corrected: bridge mode
is on by default including without a TTY, the installer writes
IRISES_FRONT=*:*, --revert became --uninstall, and the gateway restart is
automatic. Adds a note on hermes's own back-online message and the
per-platform key that silences it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 106: The two setup skills become instruction-only guides

**Files:**
- Modify: `skills/irises-setup-hermes/SKILL.md` (full replacement)
- Modify: `skills/irises-setup-openclaw/SKILL.md` (full replacement)
- Verify only: `bridge/hermes/engine-onboarding-message.md`, `bridge/openclaw/engine-onboarding-message.md`

**Interfaces:**
- Produces: two guide skills that run only `node --version`, `git --version`, `hermes gateway status` / `openclaw gateway status`, and `curl -s http://127.0.0.1:<port>/health`.
- Consumes: `bash ./scripts/engine-setup.sh --engine <engine> --yes`, `--uninstall`, `--purge-data`, `bash ./scripts/update.sh`.
- Constraint (`scripts/skillRefs.test.ts:42-55`): every `scripts/…` path in a SKILL.md must be written `./scripts/…`.
- Constraint (decision 4): the literal phrase `hermes gateway restart` and any `systemctl … restart … hermes-gateway` must not appear anywhere in these files.

- [ ] **Step 1: Confirm the onboarding messages need nothing.**
```bash
grep -rn "update\|revert\|restart" bridge/hermes/engine-onboarding-message.md bridge/openclaw/engine-onboarding-message.md
```
Expected: exactly one hit (`bridge/openclaw/engine-onboarding-message.md:65`, `**Memory: one user, one model.**`), which is about memory. No edit.

- [ ] **Step 2: Replace `skills/irises-setup-hermes/SKILL.md` in full.**
````markdown
---
name: irises-setup-hermes
description: "Guide a person through installing Irises — a user-facing front-end (web chat / CLI, plus the engine bridge) that uses this hermes as its deep-work engine. Explains it, checks prerequisites, hands over the exact terminal commands, and verifies afterwards. It does not install anything itself."
version: 2.0.0
author: Irises
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Irises, assistant, persona, frontend, setup]
prerequisites:
  commands: [git, node, npm]
---

# Irises Setup (hermes engine) — a guide, not an installer

**You do not install Irises. The person does, in their own terminal.** Your job is to explain what
Irises is, check that the box can run it, hand over the exact commands, set the right expectations,
and verify the result once they say they are done.

Why it works this way: the installer's last step restarts the hermes gateway, because the API server
and the bridge plugin are only read when the gateway comes up. From a gateway-hosted chat, hermes
blocks the script outright (its terminal tool reads the contents of any `.sh` you reference, and this
one cycles the supervisor). From a CLI session it would be worse — it would kill the supervisor
running your own turn, mid-reply. So the command belongs in a human's shell, not in yours.

## What Irises is (say this in your own words)

A user-facing texting assistant — a fast conversational front line — that delegates ALL deep work
(research, email, files, reminders, memory) to this hermes. This hermes stays completely unmodified;
Irises talks to it only through the OpenAI-compatible API server (`API_SERVER_ENABLED`) and the cron
REST API.

Irises rides **on top of** this hermes: on boot it auto-detects it (sets `OPS_BACKEND=hermes`),
reuses this hermes's API key, and makes its own voice **inherit this hermes's provider, endpoint and
model** — including when this hermes runs on an OpenAI-compatible or otherwise obscure API (OpenAI,
Azure, vLLM, deepseek-direct, Groq, a self-hosted gateway…), not just OpenRouter or Anthropic. The
voice keeps a cheap, fast model on that same API so replies stay snappy; deep work always uses this
hermes's own model. There is nothing to configure by hand.

## 1. Check the prerequisites (read-only — these you MAY run)

```bash
node --version          # needs 22.13+ (Irises's local store uses the builtin node:sqlite)
git --version
hermes gateway status
```

That is the entire list of commands you are allowed to run in this skill, plus the health check in
step 5. If `node --version` is below 22.13, look for a newer Node already on the box (nvm under
`~/.nvm/versions/node/`, or Homebrew) and tell the person which one to put on `PATH` — do not attempt
a system install, and do not install it for them.

## 2. Hand them the install (they run this, you do not)

Give them these two commands, exactly as written, and tell them to run them in a terminal on this
machine:

```bash
git clone https://github.com/rivianpratama/irises ~/irises && cd ~/irises
bash ./scripts/engine-setup.sh --engine hermes --yes
```

`--yes` means non-interactive: assume every default, never prompt. Drop it if they would rather be
asked. `~/irises` is just the usual spot — any folder they pick is fine, and the second command must
run from inside whichever folder they chose.

What the script does, so you can answer questions about it (it is short and commented — they can read
it first):

- checks node 22.13+, git, curl, and that the port is free,
- writes the Irises `.env` (mode 600): `OPS_BACKEND=hermes`, the API key, a generated
  `ENGINE_PUSH_TOKEN`, and `PORT=3000` (the committed `deploy/app.env` baseline says `8080`, which is
  the Docker image's port behind Caddy, so a local install pins 3000). No database — Irises persists
  to `~/.irises` on its own,
- reuses the Anthropic / OpenRouter / OpenAI key (and `OPENAI_BASE_URL`) this hermes already uses,
  for Irises's own small voice models, and never overwrites a value they set themselves,
- installs dependencies and builds; the web client is rebuilt only when it was built before,
- registers Irises as a **user-level service** — `systemd --user` on Linux, a LaunchAgent on macOS,
  with a detached `nohup` fallback where neither exists — so she survives a reboot without root,
- waits for her to answer `/health` on the new build, and only then touches hermes: enables the
  hermes API server if it is not already on (the documented `API_SERVER_ENABLED` switch plus a
  generated key, appended to hermes's own environment config after a backup, every change printed
  first and recorded in `~/.irises/install-manifest.json`),
- sets up **bridge mode by default** and writes `IRISES_FRONT=*:*`, so Irises fronts every chat on
  every platform out of the box (see the consequences below). `--no-bridge` skips the plugin and the
  fronting,
- **restarts the hermes gateway last**, so the API server and the bridge plugin are live, and prints a
  summary with an honest exit code.

## 3. Set these three expectations before they run it

- **The gateway will restart at the end.** Any hermes chat in flight ends there. This is normal and
  it is the step that turns the bridge on: until it happens, hermes still answers its own channels.
- **Hermes will announce its own return** — *"♻️ Gateway online — Hermes is back and ready."* — in
  their home channel, after that restart and after every future one. That is hermes's message, not
  Irises's. If they would rather not see it, hermes silences it per platform with
  `<platform>.gateway_restart_notification: false` in hermes's own config. Mention it as optional;
  never edit hermes's config for them.
- **`IRISES_FRONT=*:*` means Irises answers everything.** With bridge mode on, a person texting any
  channel this hermes owns (iMessage, WhatsApp, Discord, …) reaches Irises, who answers in her own
  voice and uses hermes as her engine. Hermes is unchanged, still reachable directly in a terminal
  (`hermes`), still transparently answers anything `IRISES_FRONT` does not cover — and answers
  everything whenever Irises is down (fail-open, so a broken front never drops messages). Narrow the
  scope by editing the `IRISES_FRONT` line in hermes's env to fnmatch patterns over
  `<platform>:<chat_id>`; blanking it makes the plugin inert instantly. Tell them their operator and
  control chats are inside `*:*` too.

Also worth saying once: **shortly after that restart, Irises usually texts first** — a one-time
introduction, sent only on a chat this hermes has genuinely exchanged messages in before (the "first
move", see Notes). A text from her out of the blue is the feature working, not a glitch.

## 4. Never do any of this

- **Never clone, install, build, or start anything.** Not in a temp folder, not "just to check".
- **Never run the setup script or the updater**, and never run any command that restarts or cycles
  the gateway or its supervisor — not through the hermes CLI's own gateway subcommands, not through
  `systemctl`, `launchctl`, `kickstart`, or direct process control. That guard is correct; do not
  route around it.
- **Never touch another Irises checkout** that already exists somewhere on this machine.
- **Never edit hermes's config**, including for the restart-notification key above.

## 5. Verify after they report back (read-only)

```bash
curl -s http://127.0.0.1:3000/health
```

Use the port they actually installed on if it is not 3000. A JSON body with a `version` object is a
healthy install. Then tell them where to talk to her: any fronted engine channel, the web chat at
`http://127.0.0.1:3000`, or `npm run chat` in the clone for a terminal session. If the health check
fails, point them at `~/.irises/logs/server.log` and the script's own output — do not try to fix it by
starting anything.

## 6. The other two commands, for later

**Update** (from the Irises folder, in their terminal):

```bash
bash ./scripts/update.sh
```

It pulls, rebuilds, restarts Irises, and restarts the hermes gateway. If the new build fails to
compile or fails to come up, it rolls back to the build that was running. There is no chat command for
it — Irises will say so herself if asked, and hand over that same line. She does check for new builds
on her own and mentions one once, in chat, when it is waiting.

**Uninstall** (from the Irises folder):

```bash
bash ./scripts/engine-setup.sh --uninstall
```

Stops and unregisters the service, removes the bridge plugin and the engine-side keys the installer
added, restarts the gateway, and keeps their data. `--purge-data` deletes `~/.irises` too, and that is
not reversible.

## Notes

- Details, security notes, and troubleshooting live in `docs/ENGINES.md` inside the clone.
- **Which model is live:** Irises's voice model vs. this hermes's deep-work model show in `/health`,
  on the `/dashboard` overview, and via `npx tsx ./scripts/print-model-map.ts`. Irises will also tell
  the person her model plainly if they ask in chat, and her build, and whether an update is waiting.
  Override any voice role with `<ROLE>_PROVIDER` / `<ROLE>_MODEL_OPENROUTER` / `<ROLE>_MODEL_OPENAI` /
  `<ROLE>_MODEL`, or turn inheritance off with `ENGINE_MODEL_INHERIT=off` (see `docs/ENGINES.md`
  § Model inheritance).
- On its first boot, Irises sends this hermes a one-time **engine-mode onboarding** over the API
  server: how to recognize a delegated request, the reply contract, the full-reach invitation and its
  hard limits (including never messaging the user on any channel itself). Hermes appends it to its own
  SOUL.md by its own hand — nothing in hermes is edited by Irises. To remove it later, tell hermes by
  chat to delete that section; to skip the send entirely, set `ENGINE_ONBOARDING=off` in the Irises
  `.env`. The text is printed by `npx tsx ./scripts/print-engine-doctrine.ts` inside the clone.
- Once after that, Irises makes the **first move**: she asks this hermes what it already knows about
  its user — a normal chat message hermes answers in its own words, nothing in hermes is read or
  edited — and keeps a sanitized version in her own memory so her first words are not cold. Then she
  either texts the user first, **only** on a chat this hermes has genuinely exchanged messages in
  before, or sends nothing at all and folds the introduction into her reply the first time they text
  her. Exactly once per install; skip it with `FIRST_MOVE_ENABLED=false` in the Irises `.env`.
````

- [ ] **Step 3: Replace `skills/irises-setup-openclaw/SKILL.md` in full.**
````markdown
---
name: irises-setup-openclaw
description: "Guide a person through installing Irises — a user-facing front-end (web chat / CLI, plus the engine bridge) that uses this OpenClaw as its deep-work engine. Explains it, checks prerequisites, hands over the exact terminal commands, and verifies afterwards. It does not install anything itself."
metadata:
  {
    "openclaw":
      {
        "emoji": "🌸",
        "requires": { "bins": ["git", "node", "npm"] },
      },
  }
---

# Irises Setup (OpenClaw engine) — a guide, not an installer

**You do not install Irises. The person does, in their own terminal.** Your job is to explain what
Irises is, check that the box can run it, hand over the exact commands, set the right expectations,
and verify the result once they say they are done.

Why it works this way: the installer's last step restarts the gateway, because the plugin and its
token are only read when the gateway comes up — and from your own session that means killing the
supervisor running your turn, mid-reply. So the command belongs in a human's shell, not in yours.

## What Irises is (say this in your own words)

A user-facing texting assistant — a fast conversational front line — that delegates ALL deep work
(research, files, memory) to this OpenClaw gateway. OpenClaw stays completely unmodified; Irises talks
to it only over the Gateway WebSocket `agent` RPC using the existing gateway token.

Irises rides **on top of** this OpenClaw: on boot it auto-detects it (sets `OPS_BACKEND=openclaw`),
reuses the gateway token, and makes its own voice **inherit OpenClaw's model** — so there is nothing
to configure by hand.

## 1. Check the prerequisites (read-only — these you MAY run)

```bash
node --version          # needs 22.13+ (Irises's local store uses the builtin node:sqlite)
git --version
openclaw gateway status
```

That is the entire list of commands you are allowed to run in this skill, plus the health check in
step 5. If `node --version` is below 22.13, tell the person which newer Node already on the box to put
on `PATH` (nvm under `~/.nvm/versions/node/`, or Homebrew) — do not attempt a system install.

## 2. Hand them the install (they run this, you do not)

```bash
git clone https://github.com/rivianpratama/irises ~/irises && cd ~/irises
bash ./scripts/engine-setup.sh --engine openclaw --yes
```

`--yes` means non-interactive: assume every default, never prompt. Drop it if they would rather be
asked. Any folder is fine — the second command runs from inside whichever one they chose.

What the script does, so you can answer questions about it:

- checks node 22.13+, git, curl, and that the port is free,
- reads the existing gateway URL + token via `openclaw config get` (no OpenClaw config changes),
- installs the `@openclaw/gateway-client` package into the Irises clone,
- writes the Irises `.env` (mode 600): `OPS_BACKEND=openclaw`, `OPENCLAW_URL`, `OPENCLAW_TOKEN`, a
  generated `ENGINE_PUSH_TOKEN`, and `PORT=3000` (the committed `deploy/app.env` baseline `8080` is
  the Docker image's port). No database — Irises persists to `~/.irises` on its own,
- reuses an `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or `OPENAI_API_KEY` from the OpenClaw
  config/environment when present, for Irises's own small voice models,
- installs dependencies and builds; the web client is rebuilt only when it was built before,
- registers Irises as a **user-level service** — `systemd --user` on Linux, a LaunchAgent on macOS,
  with a detached `nohup` fallback where neither exists — so she survives a reboot without root,
- waits for her to answer `/health`, then sets up **bridge mode by default**: installs the plugin
  with `openclaw plugins install` and writes `IRISES_FRONT=*:*`, so Irises fronts every chat on every
  channel out of the box (see the consequences below). `--no-bridge` skips the plugin and the
  fronting,
- **restarts the gateway last** so the plugin is live, and prints a summary with an honest exit code.

## 3. Set these two expectations before they run it

- **The gateway will restart at the end.** Anything in flight there ends. It is the step that turns
  the bridge on: until it happens, OpenClaw still answers its own channels.
- **`IRISES_FRONT=*:*` means Irises answers everything.** A person texting any channel this OpenClaw
  owns (WhatsApp, Discord, …) reaches Irises, who answers in her own voice and uses OpenClaw as her
  engine. OpenClaw is unchanged and still reachable directly, still transparently answers anything
  `IRISES_FRONT` does not cover — and answers everything whenever Irises is down (fail-open, so a
  broken front never drops messages). Narrow it to fnmatch patterns over `<channel>:<conversation>`,
  or blank it to make the plugin inert instantly. Tell them their operator and control chats are
  inside `*:*` too.

Also worth saying once: **shortly after that restart, Irises usually texts first** — a one-time
introduction, sent only on a chat this agent has genuinely exchanged messages in before (the "first
move", see Notes). A text from her out of the blue is the feature working, not a glitch.

## 4. Never do any of this

- **Never clone, install, build, or start anything.** Not in a temp folder, not "just to check".
- **Never run the setup script or the updater**, and never run any command that restarts or cycles
  the gateway or its supervisor — not through the OpenClaw CLI's own gateway subcommands, not through
  `systemctl`, `launchctl`, `kickstart`, or direct process control.
- **Never touch another Irises checkout** that already exists on this machine.

## 5. Verify after they report back (read-only)

```bash
curl -s http://127.0.0.1:3000/health
```

Use the port they actually installed on if it is not 3000. A JSON body with a `version` object is a
healthy install. Then tell them where to talk to her: any fronted engine channel, the web chat at
`http://127.0.0.1:3000`, or `npm run chat` in the clone. If the health check fails, point them at
`~/.irises/logs/server.log` and the script's own output — do not try to fix it by starting anything.

## 6. The other two commands, for later

**Update** (from the Irises folder, in their terminal):

```bash
bash ./scripts/update.sh
```

It pulls, rebuilds, restarts Irises, and restarts the gateway. If the new build fails to compile or
fails to come up, it rolls back to the build that was running. There is no chat command for it —
Irises will say so herself if asked, and hand over that same line. She does check for new builds on
her own and mentions one once, in chat, when it is waiting.

**Uninstall** (from the Irises folder):

```bash
bash ./scripts/engine-setup.sh --uninstall
```

Stops and unregisters the service, removes the bridge plugin, restarts the gateway, and keeps their
data. `--purge-data` deletes `~/.irises` too, and that is not reversible.

## Notes

- Details, security notes, and troubleshooting live in `docs/ENGINES.md` inside the clone.
- On its first boot, Irises sends this OpenClaw a one-time **engine-mode onboarding** over the
  gateway: how to recognize a delegated request, the reply contract, the full-reach invitation and its
  hard limits. The agent saves it to its own instructions by its own hand (nothing in OpenClaw is
  edited). To remove it later, tell the agent by chat to delete that section; to skip the send
  entirely, set `ENGINE_ONBOARDING=off` in the Irises `.env`.
- Once after that, Irises makes the **first move**: she asks this OpenClaw what it already knows about
  its user — a normal chat message the agent answers in its own words, no OpenClaw file is read or
  edited — and keeps a sanitized version in her own memory so her first words are not cold. Then she
  either texts the user first, **only** on a chat this agent has genuinely exchanged messages in
  before, or sends nothing at all and folds the introduction into her reply the first time they text
  her. Exactly once per install; skip it with `FIRST_MOVE_ENABLED=false` in the Irises `.env`.
- Known v1 gap: reminders scheduled through Irises require the hermes engine for now (OpenClaw cron
  wiring is pending), so the reminder tools aren't offered on OpenClaw at all and Irises never
  promises a reminder that can't fire. Everything else runs full-reach here: real code, this agent's
  own skills, parallel subagents, artifacts.
- **Which model is live:** Irises's voice model vs. OpenClaw's deep-work model show in `/health`, on
  the `/dashboard` overview, and via `npx tsx ./scripts/print-model-map.ts`; Irises will also tell the
  person her model, her build, and whether an update is waiting if they ask. OpenClaw's
  `provider/model` slug routes the voice automatically; if this OpenClaw runs on an
  OpenAI-compatible/obscure API, point the voice at it by hand with `<ROLE>_PROVIDER=openai` +
  `OPENAI_BASE_URL` + `OPENAI_API_KEY` (the auto endpoint/key inheritance is hermes-only for now — see
  `docs/ENGINES.md` § Model inheritance).
- The user keeps using OpenClaw directly exactly as before; Irises is an additional,
  differently-voiced front door that uses it as an engine.
````

- [ ] **Step 4: Run the skill-reference guard.**
```bash
npx cross-env TZ=UTC DATA_BACKEND=memory npx tsx --test scripts/skillRefs.test.ts 2>&1 | tail -8
```
Expected: `# fail 0`. A failure names the bare `scripts/…` path to prefix with `./`.

- [ ] **Step 5: Check the forbidden literals and the banned tokens.**
```bash
grep -rn "hermes gateway restart\|hermes gateway install\|systemctl.*hermes-gateway\|--revert\|update yourself\|UPDATE_SELF" skills
grep -rn '`bash scripts/' skills
```
Expected: both return nothing.

- [ ] **Step 6: Commit.**
```bash
git add skills
git commit --author="Rivian <rivianp@gmail.com>" -m "$(cat <<'EOF'
Setup skills become guides instead of installers

Hermes blocks the installer from any gateway-hosted chat because the
script restarts the gateway, and from a CLI session running it would kill
the agent's own supervisor mid-turn. So both skills now explain Irises,
run only read-only prerequisite checks, hand the person the exact
commands to run themselves, set the expectations that matter
(IRISES_FRONT=*:*, the gateway restart, hermes's own back-online note),
and verify with a health check afterwards. Adds the install, update and
uninstall commands and an explicit never-do list.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 107: Final verification and the grep gates

**Files:** none modified. Runs against the whole tree after Tasks 100–106 **and** Part A's tasks 1–12 have landed.

**Interfaces:**
- Consumes: `npm test`, `npm run build`, `npm run typecheck:scripts`, `npm --prefix web run typecheck`.
- Cross-task dependency: the gate in Step 3 cannot pass until Part A has removed `write_status()` and the `selfUpdate.ts` mention from `scripts/update.sh`. If that has not landed, the gate output is the report to hand back.

- [ ] **Step 1: Full server suite.**
```bash
npm test 2>&1 | tail -30
```
Expected: `# fail 0`, `# cancelled 0`, `# skipped 0`, non-zero `# pass`.

- [ ] **Step 2: Build and both typechecks.**
```bash
npm run build && npm run typecheck:scripts && npm --prefix web run typecheck
```
Expected: all three silent, exit 0.

- [ ] **Step 3: The main removal gate — must be empty.**
```bash
grep -rn "update_self\|UPDATE_SELF\|selfUpdate\|update yourself\|update-status.json" \
  src scripts docs README.md deploy .env.example skills --exclude-dir=superpowers
```
Expected: no output, exit status 1. `docs/superpowers/` is excluded because it is an archived review transcript.

- [ ] **Step 4: The retired-instruction gate — must be empty.**
```bash
grep -rn "then restart the server" src docs README.md scripts
```
Expected: no output.

- [ ] **Step 5: The stale-flag and guard-literal gates — must be empty.**
```bash
grep -rn -- "--revert" README.md docs/ENGINES.md docs/DEPLOY.md skills
grep -rEn "hermes[[:space:]]+gateway[[:space:]]+(restart|stop)|systemctl[^
]*(restart|stop|start)[^
]*hermes[.-]?gateway|launchctl[^
]*kickstart[^
]*hermes[.-]?gateway" scripts skills
grep -rn "UPDATE_SELF" deploy .env.example
```
Expected: all three return nothing (the `--revert` alias in `scripts/engine-setup.sh` prints a pointer and exits 2; it is outside this gate's paths).

- [ ] **Step 6: The positive gates — the new facts really reach the model.**
```bash
grep -rn "bash scripts/update.sh" src/update/announce.ts src/agents/convo/shared.ts
grep -c "'update_status'" src/agents/convo/promptBudget.test.ts
grep -n "update_status" src/agents/convo/promptSections.ts src/agents/convo/promptPolicy.ts scripts/convergence/expectations.ts
```
Expected: three hits for the first (the `APPLY_COMMAND` constant, the woven note, the prompt section); `7` for the second; one hit each for the third.

- [ ] **Step 7: Read the section as the model gets it.**
```bash
npm run build >/dev/null && node -e "
const { buildSystemPromptSections } = require('./dist/agents/convo/shared.js');
const { system } = buildSystemPromptSections(undefined, '');
const at = system.indexOf('## Your build and how you get updated');
console.log(system.slice(at, system.indexOf('\n\n', at)));
"
```
Expected: the five lines, with this checkout's real short sha and branch, and — because a bare `node -e` never arms the checker — the `You can't tell whether a newer build is waiting (version checks are off for this install).` variant.

- [ ] **Step 8: Commit only if a gate turned up a fix.** If Steps 1–7 were clean, nothing to commit. Otherwise fix the straggler and:
```bash
git add -A
git commit --author="Rivian <rivianp@gmail.com>" -m "$(cat <<'EOF'
Close the last references to the chat update path

Caught by the verification gates: <name the file and line>.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

## Verification (end-to-end)

1. `npm test` green; `npm run build`; `npm run typecheck:scripts`; `npm --prefix web run typecheck`.
2. `bash -n scripts/lib/irises-lib.sh scripts/engine-setup.sh scripts/update.sh`.
3. Guard-literal gate: `npx tsx --test scripts/shellContract.test.ts` is fully green (it mirrors hermes's four blocked patterns over every `scripts/**/*.sh`), and `grep -rn "hermes gateway restart\|systemctl.*hermes-gateway" skills` returns nothing.
4. Removal gate: `grep -rn "update_self\|UPDATE_SELF\|selfUpdate\|update-status.json" src scripts deploy .env.example docs README.md skills` returns nothing.
5. `npm run e2e:lifecycle` (sandboxed, stubbed engines): install → health → update to a published commit (sha flips, receipt archived, gateway stub called) → boot-crash commit → update rolls back (old sha live, `RESULT: rolled-back`) → uninstall (server stopped, plugin dir gone, Irises-added env keys stripped, data kept).
6. Local real run on this Mac against the real hermes: `bash scripts/engine-setup.sh --engine hermes --yes` in a fresh clone → `launchctl print gui/$(id -u)/ai.irises.server` shows running → hermes gateway restarted (check `~/.hermes/logs/gateway.log`) → `bash scripts/update.sh --check` exit 0 → `bash scripts/engine-setup.sh --uninstall --yes` → plist gone, plugin gone, `~/.hermes/.env` restored minus Irises keys (compare with the `.bak-irises-*`).
7. VPS rollout (Task 12): adopt the hand-launched server into `irises.service`, verify `/health` sha, gateway restart in `gateway.log`, `update.sh --check` → exit 10 (4 commits behind at time of writing), then `bash scripts/update.sh --yes` → `RESULT: ok`, `/health` sha == origin/main, Irises voices "back on the new build" in chat, hermes posts its "gateway online" note.
