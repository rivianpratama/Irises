#!/usr/bin/env bash
# Irises updater — pull the latest code onto a git-clone install, rebuild, and (optionally) restart.
#
#   bash scripts/update.sh                 # pull + rebuild, then tell you to restart
#   bash scripts/update.sh --check         # report only (exit 0 up to date, 10 update available)
#   bash scripts/update.sh --yes           # skip the confirmation prompt
#   bash scripts/update.sh --restart       # also stop + relaunch the running server (uses the pidfile)
#   bash scripts/update.sh --no-restart    # never touch the running server (default is: instruct)
#
# IRISES_SKIP_WEB_BUILD=1 skips the optional web-client rebuild (a small box, or no web UI in use).
# That step never blocks an update either way: if it fails, you get a warning and the server half
# still lands — receipt written, restart offered.
#
# Docker installs update by rebuilding the image, not with this script — see docs/DEPLOY.md § 5.
#
# Safe by design: fast-forward only (never auto-merges divergent local commits), refuses a dirty
# tree, leaves $IRISES_HOME (your data) untouched, takes a single-updater lock (so two runs can't race
# on git/build), and by default only PRINTS how to restart rather than killing a process it doesn't
# own. After the restart, Irises mentions the upgrade in chat itself.
set -euo pipefail

CHECK=0; ASSUME_YES=0; DO_RESTART=-1   # -1 = ask/instruct, 0 = never, 1 = yes
while [ $# -gt 0 ]; do
  case "$1" in
    --check)      CHECK=1; shift ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    --restart)    DO_RESTART=1; shift ;;
    --no-restart) DO_RESTART=0; shift ;;
    -h|--help)    sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1 (try --help)"; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
cd "$ROOT"
say()  { printf '\033[36m[irises-update]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[irises-update]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[irises-update]\033[0m %s\n' "$*" >&2; }

# Read KEY= from an env file. Matches dotenv: trims surrounding whitespace and strips one layer of
# matching quotes, so IRISES_HOME="~/foo" resolves the same here as it does in the server.
get_env() {
  local v; v="$(grep -E "^[[:space:]]*${1}=" "${2}" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  v="${v#"${v%%[![:space:]]*}"}"   # ltrim
  v="${v%"${v##*[![:space:]]}"}"   # rtrim
  case "$v" in
    '"'*'"') v="${v#\"}"; v="${v%\"}" ;;
    "'"*"'") v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}

# $IRISES_HOME as the server resolves it (loadEnv.ts + stateDir.ts): .env > shell env > deploy/app.env
# > ~/.irises, with a leading ~ expanded. The app.env tier matters — it's the committed config file, so
# an operator can legitimately set IRISES_HOME there; miss it and we'd write the receipt/pidfile to a
# directory the server never reads.
irises_home() {
  local h; h="$(get_env IRISES_HOME "$ENV_FILE")"
  [ -z "$h" ] && h="${IRISES_HOME:-}"
  [ -z "$h" ] && h="$(get_env IRISES_HOME "$ROOT/deploy/app.env")"
  [ -z "$h" ] && h="$HOME/.irises"
  case "$h" in
    "~")   h="$HOME" ;;
    "~/"*) h="$HOME/${h#\~/}" ;;
  esac
  printf '%s' "$h"
}

# Server port: .env > deploy/app.env > 3000.
server_port() {
  local p; p="$(get_env PORT "$ENV_FILE")"
  [ -z "$p" ] && p="$(get_env PORT "$ROOT/deploy/app.env")"
  [ -z "$p" ] && p="3000"
  printf '%s' "$p"
}

# The git sha the current dist/ build was stamped from (empty if this clone was never built).
built_sha() { node -e "try{process.stdout.write(String(require('$ROOT/dist/version.json').sha||''))}catch(e){}" 2>/dev/null || true; }

# ── state signal + single-updater lock ────────────────────────────────────────
# update-status.json is watched by a chat-triggered self-update (src/update/selfUpdate.ts) so it can
# voice the outcome back into chat: `true noop` = already current, `true restart` = applied but needs a
# restart, `false <phase>` = a genuine failure. The apply-and-restart SUCCESS path writes nothing here —
# the boot-time receipt voices it once the new build is up.
STATE_DIR="$(irises_home)"
LOCK_DIR="$STATE_DIR/update.lock"
PHASE="preflight"; IS_CHECK=0; USER_ABORTED=0; WROTE_STATUS=0; LOCKED_OUT=0
write_status() { # $1=ok(true|false) $2=phase
  local now; now="$(node -p 'Date.now()' 2>/dev/null || echo 0)"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  printf '{"ok":%s,"phase":"%s","at":%s}\n' "$1" "$2" "$now" > "$STATE_DIR/update-status.json" 2>/dev/null || true
  WROTE_STATUS=1
}
on_exit() {
  local rc="$1"
  # Release ONLY our own lock (never one a concurrent updater holds).
  if [ -f "$LOCK_DIR/pid" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null || echo)" = "$$" ]; then rm -rf "$LOCK_DIR" 2>/dev/null || true; fi
  if [ "$rc" -ne 0 ] && [ "$WROTE_STATUS" = "0" ] && [ "$IS_CHECK" = "0" ] && [ "$USER_ABORTED" = "0" ] && [ "$LOCKED_OUT" = "0" ]; then
    write_status false "$PHASE"   # a genuine apply error → let the chat watcher voice the failure
  fi
}
trap 'on_exit "$?"' EXIT

# mkdir is atomic, so it doubles as the lock. A lock left by a dead updater (holder pid gone) is reclaimed.
acquire_lock() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  if mkdir "$LOCK_DIR" 2>/dev/null; then echo "$$" > "$LOCK_DIR/pid"; return 0; fi
  local other; other="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo '')"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    LOCKED_OUT=1
    err "another update is already running (pid $other) — not starting a second one."
    exit 1
  fi
  rm -rf "$LOCK_DIR" 2>/dev/null || true            # stale lock (holder gone) → reclaim
  mkdir "$LOCK_DIR" 2>/dev/null && echo "$$" > "$LOCK_DIR/pid"
}

# ── restart + receipt helpers (defined up here so the self-heal path can reuse them) ──
PORT="$(server_port)"
PIDFILE="$STATE_DIR/irises.pid"
server_up() { curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; }

# Confirm a pid is actually OUR node server before signalling it — a stale pidfile (server SIGKILLed /
# OOM-killed, so its exit handler never ran) can hold a pid the OS later reused for something else.
is_our_server() { ps -p "$1" -o command= 2>/dev/null | grep -q "dist/index.js"; }

restart_now() {
  local pid=""
  [ -f "$PIDFILE" ] && pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    warn "no live pidfile at $PIDFILE — can't safely restart a process I didn't start."
    warn "restart it yourself: stop your 'npm start' (or 'npm run dev') and start it again."
    write_status true restart   # applied to disk; the chat watcher voices "grabbed it, needs a restart"
    return 0
  fi
  if ! is_our_server "$pid"; then
    warn "pid $pid (from $PIDFILE) isn't the Irises server — refusing to signal a process I can't identify."
    warn "restart it yourself: stop your 'npm start' (or 'npm run dev') and start it again."
    write_status true restart
    return 0
  fi
  say "stopping the running server (pid $pid)"
  kill "$pid" 2>/dev/null || true
  local i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 10 ]; do sleep 1; i=$((i+1)); done
  mkdir -p "$STATE_DIR/logs"
  say "relaunching (node dist/index.js -> $STATE_DIR/logs/server.log)"
  ( cd "$ROOT" && nohup node dist/index.js >> "$STATE_DIR/logs/server.log" 2>&1 & echo $! > "$PIDFILE" )
  i=0; while ! server_up && [ "$i" -lt 20 ]; do sleep 1; i=$((i+1)); done
  # Success: the new build is live and voices the receipt on boot (no status needed). Failure: the old
  # server is already down and can't voice — surface it in the log for a hands-on look.
  if server_up; then say "restarted — health OK on :$PORT"; else warn "server did not answer /health on :$PORT — check $STATE_DIR/logs/server.log"; fi
}

# The web client rebuild — the ONE optional step, and the only one allowed to fail.
#
# It is a separate npm project with its own (heavy) toolchain, and on a small box `next build` dies
# of memory rather than of anything wrong with this update: on the 408 MB VPS it took a bus error
# mid-build, and under `set -e` that aborted the whole updater — server updated on disk, never
# restarted, no receipt, nothing voiced in chat. The server half is what people run Irises for, so a
# failure here warns and the update carries on to the receipt + restart. Always returns 0.
#
# IRISES_SKIP_WEB_BUILD=1 skips it outright, for a box that cannot afford the build at all.
build_web() {
  if [ "${IRISES_SKIP_WEB_BUILD:-}" = "1" ]; then
    say "IRISES_SKIP_WEB_BUILD=1 — skipping the web client rebuild"
    return 0
  fi
  # Rebuild only if this install actually serves it.
  if [ ! -d "$ROOT/web/node_modules" ] && [ ! -d "$ROOT/web/out" ]; then
    say "web client not installed here — skipping (enable it later: npm run install:web && npm run build:web)"
    return 0
  fi
  PHASE="web"
  say "rebuilding the web client (npm run install:web && npm run build:web)"
  # One `if`, so neither command's failure trips set -e: the whole point is that this step cannot
  # take the update down with it.
  if npm run install:web && npm run build:web; then
    return 0
  fi
  warn "web client build failed — server updated; web UI not rebuilt"
  warn "rebuild it when the box has room:  npm run install:web && npm run build:web   (or skip it: IRISES_SKIP_WEB_BUILD=1)"
  return 0
}

write_receipt() { # $1=OLD $2=NEW  (OLD==NEW for a rebuild-only heal → empty changelog)
  PHASE="receipt"; mkdir -p "$STATE_DIR"
  if git --no-pager log --oneline "$1..$2" | node "$ROOT/scripts/write-update-receipt.js" "$1" "$2" "$BRANCH" > "$STATE_DIR/update-receipt.json"; then
    say "wrote update receipt to $STATE_DIR/update-receipt.json"
  else
    warn "could not write the update receipt (the upgrade still applied; Irises just won't announce it)"
  fi
}

# Restart-or-instruct, shared by the normal apply and the self-heal rebuild.
finish() {
  echo
  if [ "$OLD" = "$NEW" ]; then say "rebuilt at ${NEW:0:7} (repaired an unfinished build)."
  else say "updated: ${OLD:0:7} -> ${NEW:0:7} (${COUNT:-?} commit(s))."; fi
  if [ "$DO_RESTART" = "0" ]; then
    say "(--no-restart) restart Irises yourself to run the new build."
    write_status true restart
  elif [ "$DO_RESTART" = "1" ]; then
    restart_now
  elif server_up; then
    # A server is running the OLD build. Default is to instruct (don't kill a process we don't own),
    # but offer the pidfile restart interactively when we can actually do it.
    if [ -f "$PIDFILE" ] && [ "$ASSUME_YES" != "1" ]; then
      printf '\033[36m[irises-update]\033[0m a server is running the old build — restart it now? [y/N] '
      read -r yn || yn=''   # EOF (piped stdin) must not abort under set -e
      if [ "$yn" = "y" ] || [ "$yn" = "Y" ]; then restart_now; else say "restart it when ready to run the new build (stop + start your npm start)."; write_status true restart; fi
    else
      say "a server is running the old build — restart it to finish (stop + start your 'npm start', or re-run with --restart)."
      write_status true restart
    fi
  else
    say "start the server to run the new build:  npm start   (or: npm run dev)"
    write_status true restart
  fi
  [ "$(get_env UPDATE_ANNOUNCE_ENABLED "$ENV_FILE")" = "false" ] || say "once restarted, Irises will mention the upgrade in chat itself."
  say "done."
}

# ── preflight ────────────────────────────────────────────────────────────────
git rev-parse --git-dir >/dev/null 2>&1 || {
  err "this is not a git clone — nothing to pull."
  err "Docker installs update by rebuilding the image (docs/DEPLOY.md § 5)."
  exit 1
}
command -v node >/dev/null || { err "node is required (22.13+)"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  err "Node 22.13+ required (found $(node -v))"; exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "HEAD" ] || { err "detached HEAD — check out a branch first (e.g. git checkout main)"; exit 1; }

# Dirty tree = uncommitted changes to TRACKED files. Untracked files are fine (.env, dist/, web/out
# are gitignored anyway); it's local edits to committed code that a fast-forward can't reconcile.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  err "working tree has uncommitted changes to tracked files — a clean pull needs them stashed:"
  git status --short --untracked-files=no >&2
  err "stash them (git stash) or commit them, then re-run."
  exit 1
fi

# Take the lock before any git/build mutation. --check is read-only (fetch + report), so it skips it.
[ "$CHECK" = "1" ] || acquire_lock

say "fetching origin/$BRANCH …"
git fetch --quiet origin "$BRANCH"
OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse "origin/$BRANCH")"

if [ "$OLD" = "$NEW" ]; then
  BUILT="$(built_sha)"
  if [ -n "$BUILT" ] && [ "$BUILT" != "$NEW" ] && [ "$CHECK" != "1" ]; then
    # HEAD is current but dist/ was stamped from a different commit — a previous update advanced HEAD
    # and then its build failed. A plain "up to date" would strand that half-applied state; rebuild and
    # go through the normal restart/announce path so the healed build actually gets loaded.
    warn "code is at ${NEW:0:7} but the built version is ${BUILT:0:7} — a previous build didn't finish. rebuilding."
    PHASE="build"; npm ci --include=dev; npm run build
    build_web
    write_receipt "$NEW" "$NEW"   # empty changelog; lets the boot announce fire once the restart lands
    COUNT=0
    finish
    exit 0
  fi
  say "already up to date ($(git rev-parse --short HEAD), branch $BRANCH)."
  write_status true noop
  exit 0
fi
# Local ahead of origin (your own unpushed commits) → not an update to apply.
if git merge-base --is-ancestor "origin/$BRANCH" HEAD; then
  say "local $BRANCH is ahead of origin — nothing upstream to pull."
  write_status true noop
  exit 0
fi

COUNT="$(git rev-list --count "$OLD..$NEW")"
say "update available: ${OLD:0:7} -> ${NEW:0:7} ($COUNT commit(s) on $BRANCH)"
git --no-pager log --oneline "$OLD..$NEW" | sed 's/^/    /'

if [ "$CHECK" = "1" ]; then
  IS_CHECK=1
  say "(--check) not applying. Run 'bash scripts/update.sh' to apply."
  exit 10
fi

if [ "$ASSUME_YES" != "1" ]; then
  printf '\033[36m[irises-update]\033[0m apply this update now? [y/N] '
  read -r yn || yn=''   # EOF (piped stdin) must not abort under set -e
  [ "$yn" = "y" ] || [ "$yn" = "Y" ] || { USER_ABORTED=1; say "aborted — nothing changed."; exit 0; }
fi

# ── apply ────────────────────────────────────────────────────────────────────
PHASE="pull"
say "fast-forwarding to origin/$BRANCH"
git merge --ff-only "origin/$BRANCH" || {
  err "fast-forward failed — your local $BRANCH has diverged from origin."
  err "reconcile it yourself (git log, git rebase/merge) — this updater never force-merges."
  exit 1
}

PHASE="build"
# --include=dev FORCES devDependencies even when NODE_ENV=production (the documented prod env in
# deploy/app.env): tsc/cpx/tsx live in devDependencies, so a bare `npm ci` under that env strips the
# build toolchain and `npm run build` then fails with "tsc: not found" — after HEAD already advanced.
say "installing dependencies + building (npm ci --include=dev && npm run build)"
npm ci --include=dev
npm run build

# Web client: a separate npm project, and the one step allowed to fail (see build_web).
build_web

# Bridge plugin is COPIED out of the repo at setup, so a repo update leaves a stale copy on the engine.
# Refresh it only when bridge/ actually changed between old and new.
PHASE="bridge"
if git diff --name-only "$OLD" "$NEW" -- bridge/ | grep -q .; then
  say "bridge/ changed in this update — refreshing the engine plugin"
  HERMES_PLUGINS="${HERMES_HOME:-$HOME/.hermes}/plugins"
  if [ -d "$HERMES_PLUGINS/irises-bridge" ]; then
    rm -rf "$HERMES_PLUGINS/irises-bridge"   # rm first: cp -R onto an existing dir merges + leaves stale files
    cp -R "$ROOT/bridge/hermes/irises-bridge" "$HERMES_PLUGINS/"
    warn "refreshed the hermes plugin — restart the gateway to load it:  hermes gateway restart"
  fi
  if command -v openclaw >/dev/null 2>&1 && openclaw plugins list 2>/dev/null | grep -q irises-bridge; then
    openclaw plugins install "$ROOT/bridge/openclaw/irises-bridge" || warn "openclaw plugin refresh failed — re-run: openclaw plugins install $ROOT/bridge/openclaw/irises-bridge"
    warn "refreshed the OpenClaw plugin — restart the OpenClaw gateway to load it"
  fi
fi

write_receipt "$OLD" "$NEW"
finish
