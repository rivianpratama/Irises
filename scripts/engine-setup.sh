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
# web/out · a systemd --user unit, a LaunchAgent, or a Task Scheduler task on Windows · the engine's
# .env (backed up first, every added key recorded in $IRISES_HOME/install-manifest.json) · the
# engine's plugin dir · the engine's gateway, which is ALWAYS bounced at the end because the plugin,
# IRISES_FRONT and API_SERVER_* are only read when it starts.
#
# EXIT CODES
#   0  installed (or uninstalled) and verified
#   1  a step failed — read the message; nothing is left half-started that we can tell you about
#   2  wrong usage (unknown flag, unknown engine, bad port)
#   4  Irises did not report the expected build on /health within the budget
#   5  Irises is fine, but its engine's gateway could not be verified back up
# The last line of stdout is `RESULT: <token>` for every run that gets past argument parsing
# (`--help` and usage errors print none) — that is the line for scripts that wrap this one.
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
every run that gets past argument parsing ends its stdout with: RESULT: <token>
(this help text and a usage error print none)
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

# Armed HERE, past every usage exit and before the first byte of real work: the guard releases the
# lock and prints `RESULT: partial` for the two paths that never reach `summary` — a `set -e` abort
# on some statement nobody guarded, and a Ctrl+C. A usage error (exit 2) stays a usage error.
trap 'lifecycle_exit_guard $?' EXIT

rand_token() { node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }

# A sha for a human: the first seven, or the word `unknown`. dist/version.json legitimately carries
# no sha on a tarball install, and `built:  — NOT confirmed live` reads like a truncation bug in the
# script rather than the one fact it is trying to report.
short_sha() { # [SHA]
  local s="${1:-}"
  if [ -z "$s" ]; then printf 'unknown'; return 0; fi
  printf '%s' "${s:0:7}"
}

# Is KEY one of the names a previous install recorded as ours? Whole-word match against the space
# separated keysAdded list, so IRISES_URL never matches IRISES_URL_EXTRA.
key_was_ours() { # KEY LIST
  local k="${1:-}" list=" ${2:-} "
  if [ -z "$k" ]; then return 1; fi
  case "$list" in *" $k "*) return 0 ;; esac
  return 1
}

# Three keys in THIS clone's .env are deliberately clobbered on every install — OPS_BACKEND, and the
# engine credentials (HERMES_API_KEY / OPENCLAW_TOKEN), because a credential the engine has since
# rotated is worse than useless: Irises 401s on every deep-work call and blames the engine, and
# nothing in either log says the clone is holding a dead key. The clobber is intended. The SILENCE
# was the bug — an operator who set one of these by hand saw no sign it had been replaced.
#
# A credential is reported by NAME ONLY: this script's output gets pasted into chats and issues.
# `show` is for the values that are not secrets (OPS_BACKEND is hermes|openclaw|off, and the script
# prints the engine it chose anyway), where seeing both sides is the whole point of the line.
announce_overwrite() { # KEY NEWVALUE [show]
  local key="${1:-}" new="${2:-}" show="${3:-}" cur
  cur="$(env_get "$ENV_FILE" "$key")"
  if [ -z "$cur" ] || [ "$cur" = "$new" ]; then return 0; fi
  if [ "$show" = "show" ]; then
    say "updating $key in .env: $cur → $new"
  else
    say "updating $key in .env to the engine's live value (the old one is replaced, not kept)"
  fi
}

# ══ install ══════════════════════════════════════════════════════════════════
do_install() {
  local engine port kind node_bin unit="" plugin_dir="" adopted=0
  local keys_added="" keys_pre="" prev_added="" backup="" token engine_env=""
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
      say "an Irises is already on :$port (build $(short_sha "$live_sha")) — this run will adopt it"
      adopted=1
    else
      err "something else already holds :$port and it is not Irises."
      err "free the port, or choose another:  bash ./scripts/engine-setup.sh --port 3001"
      exit 1
    fi
  fi

  lock_acquire || exit 1

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
    announce_overwrite OPS_BACKEND hermes show
    env_set "$ENV_FILE" OPS_BACKEND hermes
    env_set_default "$ENV_FILE" HERMES_BASE_URL "http://127.0.0.1:8642"
    announce_overwrite HERMES_API_KEY "$ekey"
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
    announce_overwrite OPS_BACKEND openclaw show
    env_set "$ENV_FILE" OPS_BACKEND openclaw
    env_set_default "$ENV_FILE" OPENCLAW_URL "ws://127.0.0.1:18789"
    announce_overwrite OPENCLAW_TOKEN "$otoken"
    env_set "$ENV_FILE" OPENCLAW_TOKEN "$otoken"
    env_set_default "$ENV_FILE" ENGINE_PUSH_TOKEN "$(rand_token)"
  else
    announce_overwrite OPS_BACKEND off show
    env_set "$ENV_FILE" OPS_BACKEND off
  fi

  if [ -z "$(env_get "$ENV_FILE" ANTHROPIC_API_KEY)" ] \
     && [ -z "$(env_get "$ENV_FILE" OPENROUTER_API_KEY)" ] \
     && [ -z "$(env_get "$ENV_FILE" OPENAI_API_KEY)" ]; then
    warn "no ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY in $ENV_FILE"
    warn "Irises's own voice needs one (the engine key only covers deep work) — add it and restart"
  fi

  # ── 5. build. --include=dev FORCES devDependencies even under NODE_ENV=production (the documented
  #      prod env in deploy/app.env): tsc, cpx and tsx live there, so a bare `npm ci` strips the
  #      build toolchain and `npm run build` then dies with "tsc: not found".
  #
  #      Both are guarded, and not for form's sake: bare, they exit this script with the TOOL's code,
  #      and tsc's 2 is `--port` usage while its 4 is "health not verified" — a build failure that
  #      reports itself as one of the two documented outcomes it is not.
  say "installing dependencies + building (npm ci --include=dev && npm run build)"
  npm ci --include=dev || die 1 "npm ci failed — see above"
  npm run build || die 1 "the build failed — see above"
  sha="$(built_sha "$ROOT")"
  if [ -z "$sha" ]; then
    warn "dist/version.json carries no sha — health will be verified by liveness only"
  else
    say "built $(short_sha "$sha")"
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
      if ! command -v pgrep >/dev/null 2>&1; then
        # No pgrep (Git Bash ships none), so there is no honest way to tell that server from any
        # other node on the box — and guessing here would end someone else's process.
        err "there is no pgrep on this box, so we cannot match it by command line either."
        die 1 "stop that server yourself, then re-run (its pidfile, when it writes one, is $(irises_home)/irises.pid)"
      fi
      if ask_yn "stop it by process match (pgrep -f dist/index.js under $ROOT) and take over?" y; then
        # Unix-only by the pgrep gate above: is_our_server confirms each candidate is OUR server
        # before anything is signalled.
        # server_stop_pid, not a bare kill: it WAITS for the pid to go and escalates to SIGKILL if it
        # does not. A bare kill plus a flat `sleep 3` was a guess, and a server that ignored SIGTERM
        # for four seconds took the port with it into the service install.
        local p
        for p in $(pgrep -f "$ROOT/dist/index.js" 2>/dev/null || true); do
          if is_our_server "$p"; then say "stopping pid $p"; server_stop_pid "$p" 10; fi
        done
      else
        die 1 "leaving it alone — stop it yourself, then re-run"
      fi
    fi
  fi
  case "$kind" in
    none)
      server_start_detached "$ROOT" \
        || die 1 "could not start Irises detached — see $(irises_home)/logs/server.log"
      ;;
    *)
      unit="$(service_install "$ROOT" "$node_bin")" || die 1 "could not install the $kind service"
      service_restart || die 1 "the $kind service would not start — check $(irises_home)/logs/server.log"
      say "Irises is a $kind service now ($unit)"
      ;;
  esac

  # ── 7. verify the build we just made is the build that answers. "Something answers /health" was
  #      the old check, and it is satisfied by the OLD process still holding the port.
  if ! live_sha="$(wait_health_sha "http://127.0.0.1:$port" "$sha" 60)"; then
    err "Irises did not report build $(short_sha "$sha") on http://127.0.0.1:$port/health within 60s"
    err "read the log:  tail -n 40 $(irises_home)/logs/server.log"
    err "'EADDRINUSE' there means something else holds :$port; a missing voice-model key shows there too"
    summary health-failed \
      "engine:   $engine" \
      "built:    $(short_sha "$sha") — NOT confirmed live" \
      "service:  $kind${unit:+ ($unit)}" \
      "log:      $(irises_home)/logs/server.log"
    exit 4
  fi
  say "health OK on :$port — build $(short_sha "$live_sha") is live"

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
    # What the LAST install recorded as ours. "Already in the file" is not the same question as "not
    # ours": on every re-run every key we added the first time is already there, and classifying by
    # presence alone made the second install record the whole set as pre-existing — so the manifest
    # forgot them, and a later --uninstall left API_SERVER_*, IRISES_PUSH_TOKEN, IRISES_URL,
    # IRISES_BRIDGE_TOKEN and IRISES_FRONT behind in the engine's .env while claiming a clean removal.
    prev_added="$(manifest_read "$(manifest_path)" keysAdded 2>/dev/null || true)"
    if [ -n "$prev_added" ]; then
      say "a previous install recorded these engine keys as ours: $prev_added"
    fi
    # One positional argument per pair, accumulated in an array. The old form built a
    # newline-separated string and word-split it at the call — which meant a value containing
    # whitespace (an IRISES_URL behind a proxy path, a key someone pasted with a trailing space)
    # split into bogus half-lines in the engine's .env. bash 3.2 has no `+=`, hence the index.
    local pairs_n=0 key val kv
    local pairs_arr=()
    for kv in \
      "API_SERVER_ENABLED=true" \
      "API_SERVER_KEY=$(env_get "$ENV_FILE" HERMES_API_KEY)" \
      "IRISES_PUSH_TOKEN=$token" \
      "IRISES_URL=http://127.0.0.1:$port"
    do
      key="${kv%%=*}"; val="${kv#*=}"
      if [ "$(env_count "$engine_env" "$key")" != "0" ]; then
        if key_was_ours "$key" "$prev_added"; then
          keys_added="$keys_added $key"
        else
          keys_pre="$keys_pre $key"
        fi
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
        pairs_arr[$pairs_n]="$key=$val"
        pairs_n=$((pairs_n + 1))
      fi
    done
    if [ "$pairs_n" -gt 0 ]; then
      env_append_block "$engine_env" "Irises server" "${pairs_arr[@]}"
    fi
    if [ "$BRIDGE" = "1" ]; then
      if [ "$(env_count "$engine_env" IRISES_BRIDGE_TOKEN)" = "0" ]; then
        keys_added="$keys_added IRISES_BRIDGE_TOKEN"
        env_append_block "$engine_env" "bridge mode" "IRISES_BRIDGE_TOKEN=$token"
      else
        if key_was_ours IRISES_BRIDGE_TOKEN "$prev_added"; then
          keys_added="$keys_added IRISES_BRIDGE_TOKEN"
        else
          keys_pre="$keys_pre IRISES_BRIDGE_TOKEN"
        fi
        # A drifted bridge token 403s every fronted message while the engine stays silent about it.
        env_set "$engine_env" IRISES_BRIDGE_TOKEN "$token"
      fi
      if [ "$(env_count "$engine_env" IRISES_FRONT)" = "0" ]; then
        keys_added="$keys_added IRISES_FRONT"
        env_append_block "$engine_env" "front scope (edit to narrow, e.g. telegram:*)" "IRISES_FRONT=*:*"
        warn "IRISES_FRONT=*:*  — Irises now answers EVERY chat on EVERY platform this engine fronts."
        warn "Narrow it in $engine_env (patterns are fnmatch globs over <platform>:<chat_id>)."
      elif key_was_ours IRISES_FRONT "$prev_added"; then
        # Ours from the last install, and left exactly as it stands — a scope narrowed by hand after
        # that install is the operator's, even though the line itself came from us.
        keys_added="$keys_added IRISES_FRONT"
        say "keeping the IRISES_FRONT this install already set ($(env_get "$engine_env" IRISES_FRONT))"
      else
        keys_pre="$keys_pre IRISES_FRONT"
        say "keeping your IRISES_FRONT ($(env_get "$engine_env" IRISES_FRONT))"
      fi
      # plugin_dir is set only when the refresh actually put the plugin there — the summary and the
      # manifest both read it, and neither may claim a plugin that is not on disk.
      if plugin_refresh hermes "$ROOT"; then
        plugin_dir="$(hermes_home)/plugins/irises-bridge"
      else
        warn "the plugin did not install — fronting will not work yet"
      fi
      say "fail policy: if Irises is down the engine answers fronted chats itself"
      say "(set IRISES_BRIDGE_FAIL=closed in $engine_env for silence instead)"
    else
      say "--no-bridge: the engine keeps answering its own channels. API_SERVER_* is still wired,"
      say "so Irises can do deep work through it."
    fi
  elif [ "$engine" = "openclaw" ] && [ "$BRIDGE" = "1" ]; then
    if plugin_refresh openclaw "$ROOT"; then
      plugin_dir="$(openclaw_home)/extensions/irises-bridge"
    else
      warn "the plugin did not install — fronting will not work yet"
    fi
    # The token is NOT printed. This script's output gets pasted into chats, issues and pastebins,
    # and IRISES_BRIDGE_TOKEN is the whole authentication between the gateway and Irises — so the
    # operator is told the key name and where to read the value from a 0600 file they already own.
    warn "give the OpenClaw GATEWAY process these three variables (its own env, not this clone's):"
    warn "  IRISES_BRIDGE_TOKEN   — the value is ENGINE_PUSH_TOKEN in $ENV_FILE (0600); copy it across"
    warn "  IRISES_URL=http://127.0.0.1:$port"
    warn "  IRISES_FRONT=whatsapp:*,telegram:123    # empty = front NOTHING"
  fi

  # ── 9. the manifest: what to undo, and what was never ours. It OVERWRITES the previous one, which
  #      is why keysAdded is carried forward above rather than recomputed from the engine .env alone.
  #      A warn, not a die: the engine is already wired and Irises is already answering, so aborting
  #      here would leave a working install reported as a failure. --uninstall has a fallback for a
  #      missing manifest.
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
    "bridge=$BRIDGE" \
    || warn "could not write the install manifest — --uninstall will have to fall back to the marker comments"

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
    "build:     $(short_sha "$live_sha") — confirmed live on http://127.0.0.1:$port/health" \
    "service:   $kind${unit:+ ($unit)}" \
    "data:      $(irises_home)  (irises.db + memories/ — never touched by an update)" \
    "logs:      $(irises_home)/logs/server.log" \
    "gateway:   $(if [ "$engine" = "off" ]; then printf 'n/a (standalone)'; elif [ "$gateway_ok" = "1" ]; then printf 'bounced and verified'; else printf 'NOT verified — bounce it yourself'; fi)" \
    "talk to it: $(if [ -d "$ROOT/web/out" ]; then printf 'http://127.0.0.1:%s  ·  npm run chat' "$port"; else printf 'npm run chat   (web UI not built — IRISES_WEB=1 to build it)'; fi)" \
    "update it: bash scripts/update.sh        remove it: bash scripts/engine-setup.sh --uninstall"
  exit "$rc"
}

# ══ uninstall ════════════════════════════════════════════════════════════════
# No node gate here on purpose: this path needs bash, git and curl only, so it still works on a box
# whose node has since been upgraded away or removed.
do_uninstall() {
  local man engine engine_env plugin_dir kind home port f
  local failed=0 gateway_ok=1 result="ok" rc=0 did_something=0
  local keys_added keys_pre backup removed=0 svc_found=0 plugin_found=0

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
    warn "(a pre-rewrite install left none. Keys are then matched by NAME — IRISES_PUSH_TOKEN,"
    warn "IRISES_BRIDGE_TOKEN, IRISES_URL, IRISES_FRONT — and orphaned Irises marker comments are"
    warn "removed with them, whoever wrote them.)"
    engine="$(engine_kind "$ENGINE_FLAG")"
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

  # ── 1. stop and remove the service (or the detached server). service_installed knows all three
  #      backends — a bare unit/plist check reports "not installed" on Windows, where the install is
  #      a Task Scheduler entry and no file of ours at all.
  kind="$(service_kind)"
  if service_installed; then
    did_something=1
    svc_found=1
    say "stopping and removing the $kind service"
    service_stop || true
    service_uninstall || { err "could not fully remove the service"; failed=1; }
  else
    say "no service installed (no unit, no plist, no scheduled task)"
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

  # ── 2. the bridge plugin. Run on the strength of the plugin_dir we KNOW about, not on the dir
  #      still being there: plugin_remove also DISABLES the plugin in the engine's own config, and
  #      that is the half that matters. Someone who deleted the directory by hand and then ran
  #      --uninstall was left with a gateway still configured to load a plugin that is gone.
  #      did_something, though, still tracks the DIRECTORY: a disable we cannot observe the result of
  #      is not evidence of a change, and treating it as one would make every repeat --uninstall
  #      bounce the gateway again (see the engine keys below for the same rule).
  if [ -n "$plugin_dir" ]; then
    if [ -d "$plugin_dir" ]; then
      did_something=1
      plugin_found=1
    else
      say "$plugin_dir is already gone — still disabling the plugin in the engine's config"
    fi
    plugin_remove "$engine" || failed=1
  else
    if [ "$engine" != "off" ]; then say "no bridge plugin to remove (nothing names one)"; fi
  fi

  # ── 3. the engine's keys. LOOK BEFORE TOUCHING: the second --uninstall in a row used to take a
  #      fresh backup of an already-clean .env and bounce the gateway for it, because did_something
  #      was set on the strength of the manifest listing keys rather than the file still holding any.
  #      So count first, and let `removed` be the only thing that says a change happened.
  local k n present=0
  if [ -n "${engine_env:-}" ] && [ -f "$engine_env" ] && [ -n "$keys_added" ]; then
    # shellcheck disable=SC2086  # keys_added is a space-separated key list by construction
    for k in $keys_added; do
      if [ "$(env_count "$engine_env" "$k")" != "0" ]; then present=1; fi
    done
  fi
  if [ "$present" = "1" ]; then
    backup="$(env_backup "$engine_env" pre-uninstall)"
    # shellcheck disable=SC2086  # keys_added is a space-separated key list by construction
    removed="$(env_remove_irises_block "$engine_env" $keys_added)"
    case "$removed" in ''|*[!0-9]*) removed=0 ;; esac
    say "removed $removed Irises key(s) from $engine_env (backup: ${backup:-none})"
    if [ "$removed" -gt 0 ]; then did_something=1; fi
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
      # Not a failure: --purge-data is a request to be ASKED, and declining is the answer. The
      # uninstall itself succeeded; exiting 1 here made "your data was kept" read as "something
      # broke", which is the one message an operator must not get wrong about their own database.
      say "your data was KEPT: $home ($size) — you did not type 'delete'"
      say "remove it yourself when you are sure:  rm -rf $home"
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
    "service:  $(if service_installed; then printf 'STILL INSTALLED — remove it by hand'; elif [ "$svc_found" = "1" ]; then printf 'removed'; else printf 'none was installed'; fi)" \
    "plugin:   $(if [ -n "$plugin_dir" ] && [ -d "$plugin_dir" ]; then printf 'STILL PRESENT at %s' "$plugin_dir"; elif [ "$plugin_found" = "1" ]; then printf 'removed'; else printf 'none was installed'; fi)" \
    "engine:   $engine — $removed key(s) removed${backup:+, backup at $backup}" \
    "gateway:  $(if [ "$engine" = "off" ]; then printf 'n/a'; elif [ "$did_something" = "0" ]; then printf 'not bounced (nothing changed)'; elif [ "$gateway_ok" = "1" ]; then printf 'bounced and verified'; else printf 'NOT verified — bounce it yourself'; fi)" \
    "data:     $(if [ -d "$home" ]; then printf '%s KEPT (%s)' "$home" "$size"; else printf 'deleted'; fi)" \
    "clone:    $ROOT kept — rm -rf it yourself"
  exit "$rc"
}

case "$MODE" in
  install)   do_install ;;
  uninstall) do_uninstall ;;
esac
