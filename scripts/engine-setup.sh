#!/usr/bin/env bash
# Irises engine setup — wire this clone to an UNMODIFIED hermes-agent or OpenClaw engine.
#
#   bash scripts/engine-setup.sh --engine hermes            # or: openclaw
#   bash scripts/engine-setup.sh --engine hermes --revert   # undo bridge mode (unfront / uninstall plugin)
#
# Idempotent: safe to re-run. Every config change is printed before it is made, engine config is
# only ever APPENDED to (hermes) or read (OpenClaw), and nothing in either engine's code is touched.
set -euo pipefail

ENGINE=""
REVERT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --engine) ENGINE="${2:-}"; shift 2 ;;
    --revert) REVERT=1; shift ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done
[ "$ENGINE" = "hermes" ] || [ "$ENGINE" = "openclaw" ] || { echo "usage: $0 --engine hermes|openclaw [--revert]"; exit 2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
say()  { printf '\033[36m[irises-setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[irises-setup]\033[0m %s\n' "$*"; }

# ── helpers ──────────────────────────────────────────────────────────────────
rand_token() { node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }

# set KEY=VALUE in .env — replaces an existing empty/same-key line, never a user's non-empty value
set_env() {
  local key="$1" val="$2"
  touch "$ENV_FILE"
  local current
  current="$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  if [ -n "$current" ] && [ "$current" != "$val" ]; then
    say "keeping your existing ${key} (not overwriting)"
    return 0
  fi
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # portable in-place edit (BSD/GNU sed differ; use a temp file)
    grep -vE "^${key}=" "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  fi
  say "setting ${key} in .env"
  printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
}

get_env() { grep -E "^${1}=" "${2}" 2>/dev/null | head -1 | cut -d= -f2- || true; }

# ── prerequisites ────────────────────────────────────────────────────────────
command -v node >/dev/null || { echo "node is required (22+)"; exit 1; }
command -v npm  >/dev/null || { echo "npm is required"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "Node 22+ required (found $(node -v))"; exit 1; }

# ══ Revert (bridge mode) ═════════════════════════════════════════════════════
HERMES_CONFIG="${HERMES_HOME:-$HOME/.hermes}/config.yaml"

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

[ "$REVERT" = "1" ] && bridge_revert

# ══ Bridge mode (front the engine's channels with Irises) ════════════════════
# The plugins ship in this repo (bridge/hermes, bridge/openclaw) and install via each engine's
# OFFICIAL plugin mechanism — engine code stays byte-for-byte untouched. Fronting is opt-in per
# chat/platform via IRISES_FRONT patterns; with it unset the plugin is inert and the engine
# answers everything itself, exactly as before.

bridge_offer_hermes() {
  printf '\033[33m[irises-setup]\033[0m front hermes channels (WhatsApp, Discord, Slack, …) with Irises? — bridge mode [y/N] '
  read -r yn; [ "$yn" = "y" ] || [ "$yn" = "Y" ] || { say "skipping bridge mode (add later: docs/ENGINES.md § Bridge mode)"; return 0; }
  local pdir="${HERMES_HOME:-$HOME/.hermes}/plugins"
  local henv="${HERMES_HOME:-$HOME/.hermes}/.env"
  say "installing the irises-bridge plugin: copying bridge/hermes/irises-bridge -> $pdir/"
  mkdir -p "$pdir"
  cp -R "$ROOT/bridge/hermes/irises-bridge" "$pdir/"
  local ptoken; ptoken="$(get_env ENGINE_PUSH_TOKEN "$ENV_FILE")"
  if ! grep -qE '^IRISES_BRIDGE_TOKEN=' "$henv" 2>/dev/null; then
    say "appending IRISES_BRIDGE_TOKEN to $henv (same secret as Irises's ENGINE_PUSH_TOKEN)"
    { echo ""; echo "# — added by Irises setup ($(date +%F)) — bridge mode —"; echo "IRISES_BRIDGE_TOKEN=$ptoken"; } >> "$henv"
  fi
  warn "manual steps (hermes config is yours — this script never edits config.yaml):"
  warn "  1. enable the plugin:  hermes plugins enable irises-bridge"
  warn "     (equivalent config.yaml form:  plugins:  /  enabled: [irises-bridge])"
  warn "  2. choose WHAT Irises fronts — append to $henv, e.g.:"
  warn "       IRISES_FRONT=telegram:*,whatsapp:+1555*     # patterns over <platform>:<chat_id>"
  warn "     unset/empty = front NOTHING (hermes behaves exactly as before)"
  warn "  3. restart:  hermes gateway restart"
  say "fail policy: if Irises is down, hermes answers fronted chats itself (set IRISES_BRIDGE_FAIL=closed for silence instead)"
}

bridge_offer_openclaw() {
  printf '\033[33m[irises-setup]\033[0m front OpenClaw channels (WhatsApp, Discord, Slack, …) with Irises? — bridge mode [y/N] '
  read -r yn; [ "$yn" = "y" ] || [ "$yn" = "Y" ] || { say "skipping bridge mode (add later: docs/ENGINES.md § Bridge mode)"; return 0; }
  say "installing the irises-bridge plugin via OpenClaw's own installer"
  if openclaw plugins install "$ROOT/bridge/openclaw/irises-bridge"; then
    openclaw plugins enable irises-bridge || warn "could not enable via CLI — set plugins.entries.irises-bridge.enabled: true yourself"
  else
    warn "install failed — run it yourself:  openclaw plugins install $ROOT/bridge/openclaw/irises-bridge"
    return 0
  fi
  warn "manual steps:"
  warn "  1. give the OpenClaw GATEWAY process two environment variables:"
  warn "       IRISES_BRIDGE_TOKEN=<the ENGINE_PUSH_TOKEN value from $ENV_FILE>"
  warn "       IRISES_FRONT=whatsapp:*,telegram:123        # patterns over <channel>:<conversation>"
  warn "     unset/empty IRISES_FRONT = front NOTHING (OpenClaw behaves exactly as before)"
  warn "  2. restart the OpenClaw gateway"
  say "fail policy: if Irises is down, OpenClaw answers fronted chats itself (set IRISES_BRIDGE_FAIL=closed for silence instead)"
}

# ══ hermes ═══════════════════════════════════════════════════════════════════
setup_hermes() {
  local henv="${HERMES_HOME:-$HOME/.hermes}/.env"
  [ -f "$henv" ] || { echo "hermes not found (expected $henv) — install hermes-agent first"; exit 1; }

  # 1. API server on the hermes side (append-only; hermes reads these at gateway start)
  local key
  key="$(get_env API_SERVER_KEY "$henv")"
  if [ -z "$key" ]; then
    key="$(rand_token)"
    say "enabling the hermes API server: appending API_SERVER_ENABLED + API_SERVER_KEY to $henv"
    { echo ""; echo "# — added by Irises setup ($(date +%F)) —"; echo "API_SERVER_ENABLED=true"; echo "API_SERVER_KEY=$key"; } >> "$henv"
    warn "restart the hermes gateway to pick this up:  hermes gateway restart"
  else
    say "hermes API server key found — reusing it"
    grep -qE '^API_SERVER_ENABLED=true' "$henv" || { echo "API_SERVER_ENABLED=true" >> "$henv"; warn "enabled API server; restart the hermes gateway"; }
  fi

  # 2. Irises .env
  set_env OPS_BACKEND "hermes"
  set_env HERMES_BASE_URL "http://127.0.0.1:8642"
  set_env HERMES_API_KEY "$key"
  set_env ENGINE_PUSH_TOKEN "$(rand_token)"
  set_env DATA_BACKEND "memory"
  set_env WEB_ENABLED "true"

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

  say "installing @openclaw/gateway-client into this clone (optional dep, OpenClaw mode only)"
  npm install --no-save "@openclaw/gateway-client" || warn "npm install of @openclaw/gateway-client failed (package may not be published yet) — Irises will report the engine as unavailable until it installs"

  set_env OPS_BACKEND "openclaw"
  set_env OPENCLAW_URL "ws://127.0.0.1:18789"
  set_env OPENCLAW_TOKEN "$token"
  set_env ENGINE_PUSH_TOKEN "$(rand_token)"
  set_env DATA_BACKEND "memory"
  set_env WEB_ENABLED "true"

  if [ -z "$(get_env ANTHROPIC_API_KEY "$ENV_FILE")" ] && [ -z "$(get_env OPENROUTER_API_KEY "$ENV_FILE")" ]; then
    warn "add an ANTHROPIC_API_KEY or OPENROUTER_API_KEY to .env before starting"
    warn "(Irises's own voice models need it; the gateway token only covers deep work)"
  fi
  warn "note: reminders via Irises are hermes-only for now (OpenClaw cron wiring pending — docs/ENGINES.md)"

  bridge_offer_openclaw
}

if [ "$ENGINE" = "hermes" ]; then setup_hermes; else setup_openclaw; fi

# ══ build + smoke ════════════════════════════════════════════════════════════
say "installing dependencies + building"
( cd "$ROOT" && npm ci && npm run build )

say "starting Irises for a smoke test (PORT=${PORT:-3000})"
( cd "$ROOT" && node dist/index.js & echo $! > /tmp/irises-setup.pid )
sleep 4
if curl -fsS "http://127.0.0.1:${PORT:-3000}/health" >/dev/null 2>&1; then
  say "health check OK — Irises is up at http://127.0.0.1:${PORT:-3000}"
  say "talk to it: open that URL, or run: npm run chat"
else
  warn "health check failed — start it manually with 'npm start' and check the logs"
fi
kill "$(cat /tmp/irises-setup.pid)" 2>/dev/null || true
rm -f /tmp/irises-setup.pid

say "done. Full docs: docs/ENGINES.md (security notes, bridge mode, troubleshooting)."
