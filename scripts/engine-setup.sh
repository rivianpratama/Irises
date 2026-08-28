#!/usr/bin/env bash
# Irises engine setup — wire this clone to an UNMODIFIED hermes-agent or OpenClaw engine.
#
#   bash ./scripts/engine-setup.sh --engine hermes             # or: openclaw (bridge mode is ON by default)
#   bash ./scripts/engine-setup.sh --engine hermes --yes        # never prompt, take every default
#   bash ./scripts/engine-setup.sh --engine hermes --no-bridge  # opt OUT: leave the engine fronting its own channels
#   bash ./scripts/engine-setup.sh --engine hermes --revert     # undo bridge mode (unfront / uninstall plugin)
#
# NON-INTERACTIVE BY DEFAULT when nobody is watching: if stdin is not a terminal — an agent running
# this for you — the script behaves as if --yes was passed, takes every default, and never blocks on
# (or dies at) a prompt. Bridge mode is ON by default (Irises fronts the engine's channels); opt out
# with --no-bridge.
#
# NOTE: Irises ALSO auto-detects the engine at boot (src/agents/ops/engineDiscovery.ts) — it sets
# OPS_BACKEND, reuses the engine's API key, and inherits its model with no .env. This script does the
# parts discovery can't: enabling the engine's API surface, generating the push token, pinning the
# port, building, and installing + enabling the bridge plugin (default) so Irises fronts the engine's
# channels out of the box. The .env values it writes are just
# made explicit — harmless and overrideable. So it's the "fuller wiring" path; plain boot-time
# discovery covers the basics alone.
#
# It finishes by STARTING Irises detached (nohup/setsid, stdin closed), so the server outlives this
# script and the shell — or agent session — that ran it. The pid lands in irises.pid and the boot log
# in irises.log, both in this clone's root. It is LEFT RUNNING on purpose.
#
# Idempotent: safe to re-run. Every config change is printed before it is made, the engine's config
# is only ever APPENDED to (the one exception: an Irises-owned IRISES_* line that has drifted out of
# sync is rewritten in place — never any other line), and nothing in either engine's code is touched.
set -euo pipefail

ENGINE=""
REVERT=0
ASSUME_YES=0
BRIDGE=1               # DEFAULT ON: 1 = bridge (front the engine's channels with Irises), 0 = --no-bridge
BRIDGE_TOKEN_SYNCED=0  # so the bridge secret is never re-reported when it was already put in step

usage() {
  cat <<'EOF'
usage: bash ./scripts/engine-setup.sh --engine hermes|openclaw [options]

  --engine hermes|openclaw   which engine this clone talks to (required)
  --yes, -y                  non-interactive: assume defaults, never prompt
  --bridge                   install + enable the bridge plugin (default; front the engine with Irises)
  --no-bridge                opt out: leave the engine answering its own channels
  --revert                   print how to undo bridge mode, then exit
  -h, --help                 this help

Stdin not a terminal implies --yes. Bridge mode is ON by default (opt out with --no-bridge).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --engine)     ENGINE="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --engine=*)   ENGINE="${1#--engine=}"; shift ;;
    --revert)     REVERT=1; shift ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    --bridge)     BRIDGE=1; shift ;;
    --no-bridge)  BRIDGE=0; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "unknown arg: $1 (try --help)"; exit 2 ;;
  esac
done
[ "$ENGINE" = "hermes" ] || [ "$ENGINE" = "openclaw" ] || { usage; exit 2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
PIDFILE="$ROOT/irises.pid"
LOGFILE="$ROOT/irises.log"
say()  { printf '\033[36m[irises-setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[irises-setup]\033[0m %s\n' "$*"; }

# No TTY = nobody can answer a question, so don't ask one. (An agent-driven run lands here: hermes
# and OpenClaw both spawn shell commands with stdin at /dev/null, so any `read` would hit EOF.)
if [ ! -t 0 ] && [ "$ASSUME_YES" != "1" ]; then
  ASSUME_YES=1
  say "stdin is not a terminal — running non-interactive (same as --yes): defaults, no prompts"
fi

# ── helpers ──────────────────────────────────────────────────────────────────
rand_token() { node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }

# Read KEY= from an env file, the way dotenv does: tolerate leading whitespace, trim the value, and
# strip one layer of matching quotes (so API_SERVER_KEY="abc" resolves to abc, as the engine sees it).
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

# Appending to a file whose last byte is not a newline GLUES the new line onto the old one. A live run
# did exactly that and turned a model id + HERMES_BASE_URL into one corrupt line, breaking both — so
# every append in this script goes through here first.
ensure_trailing_newline() { # $1=file
  local f="$1" last
  [ -s "$f" ] || return 0
  last="$(LC_ALL=C tail -c1 "$f" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n' || true)"
  [ "$last" = "0a" ] || printf '\n' >> "$f"
}

# set KEY=VALUE in .env — replaces an existing empty/same-key line, never a user's non-empty value
set_env() {
  local key="$1" val="$2"
  touch "$ENV_FILE"
  local current; current="$(get_env "$key" "$ENV_FILE")"
  if [ -n "$current" ] && [ "$current" != "$val" ]; then
    say "keeping your existing ${key} (not overwriting)"
    return 0
  fi
  if grep -qE "^[[:space:]]*${key}=" "$ENV_FILE"; then
    # portable in-place edit (BSD/GNU sed differ; use a temp file). grep exits 1 when it drops the
    # only line in the file — that is a legitimately empty result, not a failure.
    grep -vE "^[[:space:]]*${key}=" "$ENV_FILE" > "$ENV_FILE.tmp" || true
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  fi
  say "setting ${key} in .env"
  ensure_trailing_newline "$ENV_FILE"
  printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
}

# Ask a [y/N] question. Returns the default without prompting when non-interactive (--yes or no TTY),
# and an EOF answer can never abort the script under `set -e` — the whole point: a prompt must never
# be able to cost someone their install.
ask_yn() { # $1=question  $2=default (y|n)
  local q="$1" def="${2:-n}" yn=""
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
    say "$q — assuming '$def' (no prompt: --yes / non-interactive stdin)"
    if [ "$def" = "y" ]; then return 0; fi
    return 1
  fi
  printf '\033[33m[irises-setup]\033[0m %s [y/N] ' "$q"
  read -r yn || yn=""    # EOF must not kill the script
  case "$yn" in y|Y|yes|YES) return 0 ;; esac
  return 1
}

# Rewrite ONE key's line in the engine's env file, leaving every other byte alone (BSD/GNU sed
# differ, so do it in the shell). Only ever used for a key Irises itself owns.
replace_line() { # $1=file $2=key $3=value
  local f="$1" key="$2" val="$3" tmp line trimmed
  tmp="$f.irises.tmp.$$"
  : > "$tmp" || return 1
  chmod 600 "$tmp" 2>/dev/null || true
  while IFS= read -r line || [ -n "$line" ]; do
    trimmed="${line#"${line%%[![:space:]]*}"}"
    case "$trimmed" in
      "$key="*) printf '%s=%s\n' "$key" "$val" ;;
      *)        printf '%s\n' "$line" ;;
    esac
  done < "$f" >> "$tmp"
  cat "$tmp" > "$f"    # same inode, so the file keeps its own permissions
  rm -f "$tmp"
}

# Keep an Irises-OWNED key in the engine's env file in step with Irises. Absent → append it under a
# dated comment (append-only, like every other engine-side write here). Present but DIFFERENT → the
# two sides no longer share the secret, which fails silently (403 on every push), so rewrite that one
# line. Present and equal → say so and touch nothing.
sync_engine_key() { # $1=file $2=key $3=value $4=comment tag for a fresh append
  local f="$1" key="$2" val="$3" tag="$4" cur
  if grep -qE "^[[:space:]]*${key}=" "$f" 2>/dev/null; then
    cur="$(get_env "$key" "$f")"
    if [ "$cur" = "$val" ]; then
      say "$key in $f already matches Irises — leaving it"
      return 0
    fi
    say "updating $key in $f — it drifted from Irises's ENGINE_PUSH_TOKEN, and a mismatched token"
    say "makes the engine's posts back to Irises fail 403 with nothing said out loud"
    replace_line "$f" "$key" "$val"
    return 0
  fi
  say "appending $key to $f (same secret as Irises's ENGINE_PUSH_TOKEN)"
  ensure_trailing_newline "$f"
  { echo ""; echo "# — added by Irises setup ($(date +%F)) — $tag —"; printf '%s=%s\n' "$key" "$val"; } >> "$f"
}

# ── prerequisites ────────────────────────────────────────────────────────────
command -v node >/dev/null || { echo "node is required (22.13+)"; exit 1; }
command -v npm  >/dev/null || { echo "npm is required"; exit 1; }
# 22.13 is the floor: Irises's local store uses the builtin node:sqlite, unflagged since 22.13.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  echo "Node 22.13+ required (found $(node -v))"; exit 1
fi

# ══ Revert (bridge mode) ═════════════════════════════════════════════════════
HERMES_HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
HERMES_CONFIG="$HERMES_HOME_DIR/config.yaml"
HERMES_ENV="$HERMES_HOME_DIR/.env"

# Resolve the hermes CLI for the actions this script now takes for you (enable plugin, restart
# gateway). PATH first (an interactive shell has it), then the standard venv wrapper, then the module
# form — an agent-driven run often has none of hermes on PATH. Prints empty if it truly can't be found.
_hermes_cli() {
  if command -v hermes >/dev/null 2>&1; then printf 'hermes'; return 0; fi
  if [ -x "$HERMES_HOME_DIR/hermes-agent/hermes" ]; then printf '%s' "$HERMES_HOME_DIR/hermes-agent/hermes"; return 0; fi
  if [ -x "$HERMES_HOME_DIR/hermes-agent/venv/bin/python" ]; then printf '%s -m hermes_cli.main' "$HERMES_HOME_DIR/hermes-agent/venv/bin/python"; return 0; fi
  return 0
}

bridge_revert() {
  say "reverting bridge mode:"
  say "to stop fronting instantly, blank IRISES_FRONT in the engine's environment and restart its"
  say "gateway. To remove the plugin entirely:"
  if [ "$ENGINE" = "hermes" ]; then
    say "  hermes:   remove 'irises-bridge' from plugins.enabled in $HERMES_CONFIG"
    say "            (or: hermes plugins disable irises-bridge), delete ~/.hermes/plugins/irises-bridge,"
    say "            then: hermes gateway restart"
  else
    say "  openclaw: openclaw plugins disable irises-bridge   (uninstall: openclaw plugins uninstall irises-bridge)"
    say "            then restart the OpenClaw gateway"
  fi
  exit 0
}

if [ "$REVERT" = "1" ]; then bridge_revert; fi

# ══ Bridge mode (front the engine's channels with Irises) ════════════════════
# The plugins ship in this repo (bridge/hermes, bridge/openclaw) and install via each engine's
# OFFICIAL plugin mechanism — engine code stays byte-for-byte untouched. Fronting is opt-in per
# chat/platform via IRISES_FRONT patterns; with it unset the plugin is inert and the engine
# answers everything itself, exactly as before.

# Decide once: bridge is ON by default (BRIDGE=1); --no-bridge opts out. The ask branch below only
# runs if BRIDGE is set to -1 elsewhere — kept for anyone who wants the old interactive prompt.
want_bridge() { # $1=engine label for the question
  case "$BRIDGE" in
    1) return 0 ;;
    0) say "skipping bridge mode (--no-bridge)"; return 1 ;;
  esac
  if ask_yn "front $1 channels (WhatsApp, Discord, Slack, …) with Irises? — bridge mode" n; then
    return 0
  fi
  say "skipping bridge mode — add it later with --bridge (docs/ENGINES.md § Bridge mode)"
  return 1
}

bridge_offer_hermes() {
  want_bridge "hermes" || return 0
  local pdir="$HERMES_HOME_DIR/plugins"
  local henv="$HERMES_ENV"
  say "installing the irises-bridge plugin: copying bridge/hermes/irises-bridge -> $pdir/"
  mkdir -p "$pdir"
  cp -R "$ROOT/bridge/hermes/irises-bridge" "$pdir/"
  local ptoken; ptoken="$(get_env ENGINE_PUSH_TOKEN "$ENV_FILE")"
  # (already done above when the key was there before this run — don't say it twice)
  [ "$BRIDGE_TOKEN_SYNCED" = "1" ] || sync_engine_key "$henv" IRISES_BRIDGE_TOKEN "$ptoken" "bridge mode"
  # The plugin dials IRISES_URL (its own default is :3000). We pinned the port above, so say where.
  local iurl; iurl="$(get_env IRISES_URL "$henv")"
  if [ -z "$iurl" ]; then
    say "appending IRISES_URL=http://127.0.0.1:$PORT_PINNED to $henv (where the plugin forwards to)"
    ensure_trailing_newline "$henv"
    { echo ""; echo "# — added by Irises setup ($(date +%F)) — bridge target —"; echo "IRISES_URL=http://127.0.0.1:$PORT_PINNED"; } >> "$henv"
  elif [ "$iurl" != "http://127.0.0.1:$PORT_PINNED" ]; then
    warn "leaving your IRISES_URL ($iurl) alone — but Irises listens on :$PORT_PINNED, so make sure it points there"
  fi
  # Enable the plugin through hermes's OWN CLI (the supported way to flip plugins.enabled — this
  # script still never hand-edits config.yaml).
  local hcli; hcli="$(_hermes_cli)"
  if [ -n "$hcli" ]; then
    say "enabling the irises-bridge plugin (hermes plugins enable irises-bridge)"
    $hcli plugins enable irises-bridge >/dev/null 2>&1 \
      || warn "could not enable irises-bridge via CLI — enable it yourself: hermes plugins enable irises-bridge"
  else
    warn "hermes CLI not found — enable the plugin yourself: hermes plugins enable irises-bridge"
  fi

  # Front EVERYTHING by default so Irises actually takes over out of the box. This is the crux of a
  # seamless install: with IRISES_FRONT empty the plugin is INERT and hermes keeps answering (the #1
  # "why is the engine still replying?" gotcha). Narrow it later by editing this one line, e.g.
  # IRISES_FRONT=telegram:*,whatsapp:+1555*  — patterns are fnmatch globs over <platform>:<chat_id>.
  local ifront; ifront="$(get_env IRISES_FRONT "$henv")"
  if [ -z "$ifront" ]; then
    say "setting IRISES_FRONT=*:* in $henv — Irises fronts every chat on every platform (edit to narrow)"
    ensure_trailing_newline "$henv"
    { echo ""; echo "# — added by Irises setup ($(date +%F)) — front scope (edit to narrow, e.g. telegram:*) —"; echo "IRISES_FRONT=*:*"; } >> "$henv"
  else
    say "keeping your existing IRISES_FRONT ($ifront) — leaving it alone"
  fi
  say "fail policy: if Irises is down, hermes answers fronted chats itself (set IRISES_BRIDGE_FAIL=closed for silence instead)"
  say "the gateway restart at the end of this script loads the plugin + IRISES_FRONT (they are read at start)"
}

bridge_offer_openclaw() {
  want_bridge "OpenClaw" || return 0
  say "installing the irises-bridge plugin via OpenClaw's own installer"
  if openclaw plugins install "$ROOT/bridge/openclaw/irises-bridge"; then
    openclaw plugins enable irises-bridge || warn "could not enable via CLI — set plugins.entries.irises-bridge.enabled: true yourself"
  else
    warn "install failed — run it yourself:  openclaw plugins install $ROOT/bridge/openclaw/irises-bridge"
    return 0
  fi
  warn "manual steps:"
  warn "  1. give the OpenClaw GATEWAY process three environment variables:"
  warn "       IRISES_BRIDGE_TOKEN=<the ENGINE_PUSH_TOKEN value from $ENV_FILE>"
  warn "       IRISES_URL=http://127.0.0.1:$PORT_PINNED        # where Irises listens"
  warn "       IRISES_FRONT=whatsapp:*,telegram:123        # patterns over <channel>:<conversation>"
  warn "     unset/empty IRISES_FRONT = front NOTHING (OpenClaw behaves exactly as before)"
  warn "  2. restart the OpenClaw gateway"
  say "fail policy: if Irises is down, OpenClaw answers fronted chats itself (set IRISES_BRIDGE_FAIL=closed for silence instead)"
}

# ── the port, pinned ─────────────────────────────────────────────────────────
# deploy/app.env (COMMITTED, and loaded first by src/loadEnv.ts) pins PORT=8080 for the Docker image
# behind Caddy. On a clone that number wins at boot while every doc, `npm run chat` and the bridge
# plugin's IRISES_URL all assume 3000 — so the server ends up somewhere nobody looks. Pin it in .env
# (which overrides app.env) and use that ONE resolved value for the start, the health check, every
# URL printed, and the bridge target.
pin_port() {
  set_env PORT "${PORT:-3000}"
  PORT_PINNED="$(get_env PORT "$ENV_FILE")"
  [ -n "$PORT_PINNED" ] || PORT_PINNED="${PORT:-3000}"
  say "Irises will listen on :$PORT_PINNED (deploy/app.env's 8080 is for the Docker image)"
}
PORT_PINNED="${PORT:-3000}"

# ══ hermes ═══════════════════════════════════════════════════════════════════
setup_hermes() {
  local hhome="$HERMES_HOME_DIR" henv="$HERMES_ENV"
  # Presence of the hermes HOME is the real proof of installation. ~/.hermes/.env is not: hermes only
  # writes it when it stores a secret, so an OAuth/portal login (or keys in the shell) leaves a
  # perfectly working hermes with no .env at all. Create it and carry on — never claim hermes is
  # missing while we are very likely running inside it.
  [ -d "$hhome" ] || { echo "hermes not found (no $hhome) — install hermes-agent first"; exit 1; }
  if [ ! -f "$henv" ]; then
    say "creating $henv (chmod 600) — hermes only writes this file when it stores a secret, so an"
    say "empty one is normal on an OAuth/portal install; Irises's keys go here"
    ( umask 077; touch "$henv" )
    chmod 600 "$henv" 2>/dev/null || true
  fi

  # 1. API server on the hermes side (append-only; hermes reads these at gateway start)
  local key
  key="$(get_env API_SERVER_KEY "$henv")"
  if [ -z "$key" ]; then
    key="$(rand_token)"
    say "enabling the hermes API server: appending API_SERVER_ENABLED + API_SERVER_KEY to $henv"
    ensure_trailing_newline "$henv"
    { echo ""; echo "# — added by Irises setup ($(date +%F)) —"; echo "API_SERVER_ENABLED=true"; echo "API_SERVER_KEY=$key"; } >> "$henv"
    warn "restart the hermes gateway to pick this up:  hermes gateway restart"
  else
    say "hermes API server key found — reusing it"
    grep -qE '^[[:space:]]*API_SERVER_ENABLED=true' "$henv" || { say "appending API_SERVER_ENABLED=true to $henv"; ensure_trailing_newline "$henv"; echo "API_SERVER_ENABLED=true" >> "$henv"; warn "enabled API server; restart the hermes gateway"; }
  fi

  # 2. Irises .env
  set_env OPS_BACKEND "hermes"
  set_env HERMES_BASE_URL "http://127.0.0.1:8642"
  set_env HERMES_API_KEY "$key"
  set_env ENGINE_PUSH_TOKEN "$(rand_token)"
  set_env WEB_ENABLED "true"
  pin_port
  if [ -n "$key" ] && [ "$(get_env HERMES_API_KEY "$ENV_FILE")" != "$key" ]; then
    warn "your .env HERMES_API_KEY is not hermes's current API_SERVER_KEY — deep work will 401 until"
    warn "they match (clear the .env line and re-run to adopt hermes's key)"
  fi

  # 2b. The same secret on the hermes side, under the name its cron jobs reference. The reminder job
  # prompt tells hermes to POST back with "x-engine-token: $IRISES_PUSH_TOKEN" — without that
  # variable in hermes's environment every fired reminder is rejected 403 and the user never hears it.
  local ptoken; ptoken="$(get_env ENGINE_PUSH_TOKEN "$ENV_FILE")"
  sync_engine_key "$henv" IRISES_PUSH_TOKEN "$ptoken" "reminder push-back"

  # 2c. If bridge mode was set up on some earlier run, keep ITS copy of the secret in step too —
  # whatever the answer to the bridge question below is. A stale IRISES_BRIDGE_TOKEN 403s every
  # fronted message while hermes stays quiet, so it must not depend on saying yes again.
  if grep -qE '^[[:space:]]*IRISES_BRIDGE_TOKEN=' "$henv" 2>/dev/null; then
    sync_engine_key "$henv" IRISES_BRIDGE_TOKEN "$ptoken" "bridge mode"
    BRIDGE_TOKEN_SYNCED=1
  fi

  # 3. Voice-model keys: reuse what hermes already has (never overwrite user-set values)
  local k
  for k in ANTHROPIC_API_KEY OPENROUTER_API_KEY; do
    local v; v="$(get_env "$k" "$henv")"
    [ -n "$v" ] && set_env "$k" "$v"
  done
  if [ -z "$(get_env ANTHROPIC_API_KEY "$ENV_FILE")" ] && [ -z "$(get_env OPENROUTER_API_KEY "$ENV_FILE")" ]; then
    warn "no ANTHROPIC_API_KEY or OPENROUTER_API_KEY found to reuse — add one to .env before starting"
    warn "(Irises's own voice models need it; the engine key only covers deep work)"
  fi

  bridge_offer_hermes
}

# ══ OpenClaw ═════════════════════════════════════════════════════════════════
setup_openclaw() {
  command -v openclaw >/dev/null || { echo "openclaw CLI not found — install OpenClaw first"; exit 1; }
  local token
  token="$(openclaw config get gateway.auth.token 2>/dev/null | tr -d '"' || true)"
  [ -n "$token" ] && [ "$token" != "undefined" ] || { echo "could not read gateway.auth.token — is the OpenClaw gateway configured?"; exit 1; }

  set_env OPS_BACKEND "openclaw"
  set_env OPENCLAW_URL "ws://127.0.0.1:18789"
  set_env OPENCLAW_TOKEN "$token"
  set_env ENGINE_PUSH_TOKEN "$(rand_token)"
  set_env WEB_ENABLED "true"
  pin_port
  # @openclaw/gateway-client is installed AFTER the build — `npm ci` deletes anything that isn't in
  # the lockfile, so installing it here (as this script used to) quietly wiped it again.

  if [ -z "$(get_env ANTHROPIC_API_KEY "$ENV_FILE")" ] && [ -z "$(get_env OPENROUTER_API_KEY "$ENV_FILE")" ]; then
    warn "add an ANTHROPIC_API_KEY or OPENROUTER_API_KEY to .env before starting"
    warn "(Irises's own voice models need it; the gateway token only covers deep work)"
  fi
  warn "note: reminders via Irises are hermes-only for now (OpenClaw cron wiring pending — docs/ENGINES.md)"

  bridge_offer_openclaw
}

if [ "$ENGINE" = "hermes" ]; then setup_hermes; else setup_openclaw; fi

# ══ build ════════════════════════════════════════════════════════════════════
# --include=dev: the build itself needs devDeps (tsc, cpx), which npm would skip in an environment
# that exports NODE_ENV=production.
say "installing dependencies + building (npm ci --include=dev, then npm run build)"
( cd "$ROOT" && npm ci --include=dev && npm run build )

# The browser chat under web/ is a SEPARATE npm project (no workspaces, no postinstall), so the ci
# above never touches it and web/out — what the server serves at / — stays absent, leaving a bare
# "Cannot GET /". Optional: if it fails, that costs the browser page, not the install.
WEB_OK=0
say "building the web chat client (web/ — optional; npm run chat works without it)"
if ( cd "$ROOT" && npm run install:web ) && ( cd "$ROOT" && npm run build:web ); then
  WEB_OK=1
else
  warn "web client build failed — Irises still runs; talk to it with 'npm run chat' instead"
  warn "(retry any time:  npm run install:web && npm run build:web)"
fi

# OpenClaw's gateway client goes in AFTER npm ci, or ci prunes it right back out.
if [ "$ENGINE" = "openclaw" ]; then
  say "installing @openclaw/gateway-client into this clone (optional dep, OpenClaw mode only)"
  ( cd "$ROOT" && npm install --no-save "@openclaw/gateway-client" ) \
    || warn "npm install of @openclaw/gateway-client failed (package may not be published yet) — Irises will report the engine as unavailable until it installs"
fi

# ══ start + verify ═══════════════════════════════════════════════════════════
BASE="http://127.0.0.1:$PORT_PINNED"

# No pipeline (a `curl | grep -q` can return grep's early exit as a curl write error under pipefail).
health_ok() {
  local body; body="$(curl -fsS -m 5 "$BASE/health" 2>/dev/null || true)"
  case "$body" in *'"status":"ok"'*) return 0 ;; esac
  return 1
}

# Only ever signal/record a pid we can identify as this server (a stale pid gets reused by the OS).
is_our_server() {
  local cmd
  [ -n "${1:-}" ] || return 1
  cmd="$(ps -p "$1" -o command= 2>/dev/null || true)"
  case "$cmd" in *dist/index.js*) return 0 ;; esac
  return 1
}

# `setsid` forks when its caller is already a process-group leader, so $! can name setsid rather than
# node. Walk one level down to record node's OWN pid — the old script's `kill $!` killed a wrapper
# subshell instead, leaving an untracked server holding the port.
child_server_pid() {
  local p
  for p in $(ps -A -o pid=,ppid= 2>/dev/null | awk -v pp="$1" '$2==pp {print $1}'); do
    if is_our_server "$p"; then printf '%s' "$p"; return 0; fi
  done
  return 1
}

SRV_PID=""
if health_ok; then
  say "Irises already running on :$PORT_PINNED and answering /health — leaving it alone"
  if [ -f "$PIDFILE" ]; then SRV_PID="$(cat "$PIDFILE" 2>/dev/null || true)"; fi
else
  cd "$ROOT"    # node resolves deploy/app.env and web/out relative to the cwd
  say "starting Irises detached on :$PORT_PINNED — it stays up after this script exits"
  say "  log:  $LOGFILE"
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid node dist/index.js </dev/null >>"$LOGFILE" 2>&1 &
  else
    nohup node dist/index.js </dev/null >>"$LOGFILE" 2>&1 &
  fi
  CAND=$!
  disown 2>/dev/null || true    # belt-and-braces: no SIGHUP when this shell goes away
  say "waiting for /health on :$PORT_PINNED (up to 30s — boot asks the engine a few questions first)"
  i=0
  while [ "$i" -lt 30 ] && ! health_ok; do sleep 1; i=$((i+1)); done
  SRV_PID="$CAND"
  if ! is_our_server "$SRV_PID"; then SRV_PID="$(child_server_pid "$CAND" || printf '%s' "$CAND")"; fi
  printf '%s\n' "$SRV_PID" > "$PIDFILE"
  if health_ok; then
    say "health OK — Irises is up (pid $SRV_PID)"
  else
    warn "no /health answer on :$PORT_PINNED after 30s — Irises may still be booting, or it never got up."
    warn "read the tail of the log:  tail -n 40 $LOGFILE"
    warn "'EADDRINUSE' there means something else holds :$PORT_PINNED (an older Irises? kill \$(cat $PIDFILE))"
    warn "a missing voice-model key or a bad build shows up there too."
  fi
fi

# ══ engine round-trip ════════════════════════════════════════════════════════
# Irises's own /health says nothing about the engine, and the engine's API server only exists while
# its gateway RUNS — with the key we just appended only read at gateway start. So ask the engine
# directly. Never fatal: Irises retries the connection by itself once the gateway comes up.
if [ "$ENGINE" = "hermes" ]; then
  HBASE="$(get_env HERMES_BASE_URL "$ENV_FILE")"; [ -n "$HBASE" ] || HBASE="http://127.0.0.1:8642"
  HKEY="$(get_env HERMES_API_KEY "$ENV_FILE")"
  if curl -fsS -m 5 -H "Authorization: Bearer $HKEY" "$HBASE/v1/capabilities" >/dev/null 2>&1; then
    say "engine round-trip OK — hermes answered $HBASE/v1/capabilities with Irises's key"
  else
    warn "hermes's API server did not answer at $HBASE — normal right after this setup, because the"
    warn "gateway only reads API_SERVER_ENABLED / API_SERVER_KEY when it starts. Bring it up:"
    warn "  already installed as a service:  hermes gateway restart"
    warn "  never installed yet:             hermes gateway install    (then: hermes gateway start)"
    say "not a failure — Irises connects on its own once the gateway is up; deep work (research,"
    say "email, files, reminders) stays unavailable until then, and chat works regardless."
  fi
fi

# ══ where to talk to it ══════════════════════════════════════════════════════
echo
if health_ok; then
  say "talk to Irises:"
  if [ "$WEB_OK" = "1" ]; then
    say "  web chat:   $BASE"
  else
    say "  web chat:   $BASE   (page not built — run: npm run install:web && npm run build:web)"
  fi
  say "  terminal:   npm run chat        (from $ROOT)"
  say "  log:        $LOGFILE"
  if [ -n "$SRV_PID" ]; then say "  stop it:    kill \$(cat $PIDFILE)"; fi
  say "  re-run this script any time — it is idempotent, and it won't start a second server."
else
  warn "Irises is not answering on :$PORT_PINNED — start it by hand once the log tells you why:"
  warn "  cd $ROOT && npm start"
fi

# ══ load the bridge (restart the engine gateway) ═════════════════════════════
# The plugin, IRISES_FRONT, and API_SERVER_* are only read when the gateway STARTS, so a fresh install
# won't front anything until the gateway is bounced. Do it here so the experience is seamless — you
# shouldn't have to restart by hand. Best-effort and time-boxed; the printed command is the fallback.
# NOTE: if an AGENT running INSIDE the gateway invokes this script, this restart ends that agent's turn
# mid-reply (it is restarting the very process it runs in). Prefer running installs from a shell.
if [ "$ENGINE" = "hermes" ] && [ "$BRIDGE" != "0" ]; then
  hcli_r="$(_hermes_cli)"
  if [ -n "$hcli_r" ]; then
    say "restarting the hermes gateway to load the bridge (irises-bridge + IRISES_FRONT)"
    if timeout 90 $hcli_r gateway restart >/dev/null 2>&1; then
      say "hermes gateway restarted — bridge is live; message the engine's channels and Irises answers"
    else
      warn "could not restart the gateway automatically — do it yourself:  hermes gateway restart"
    fi
  else
    warn "restart the hermes gateway to load the bridge:  hermes gateway restart"
  fi
fi

say "done. Full docs: docs/ENGINES.md (security notes, bridge mode, troubleshooting)."
