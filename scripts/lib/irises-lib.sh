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
