#!/usr/bin/env bash
# Irises configure — change what the install chose, on a clone that is already installed: no wizard,
# no `npm ci`, no rebuild. One setting or several, previewed, applied, and then PROVEN by restarting
# Irises and reading the build back off /health — because .env is parsed once at boot (src/loadEnv.ts
# has no reload path), so a change nobody restarted into is a setting that silently did not take.
#
#   bash scripts/configure.sh --show                    # report only; changes nothing
#   bash scripts/configure.sh --tz Europe/Paris         # one setting, asks before writing
#   bash scripts/configure.sh --web off --yes           # no questions
#   bash scripts/configure.sh --port 3001               # moves the engine's IRISES_URL with it
#   bash scripts/configure.sh --front 'telegram:*'      # which chats Irises fronts (engine .env)
#   bash scripts/configure.sh --model-inherit           # hand the voice back to the engine's model
#   IRISES_SET_VALUE=… bash scripts/configure.sh --set OPENROUTER_API_KEY
#
# FLAGS
#   --show                 print every setting, one line each, with where the value came from.
#                          Read-only: no lock, no write, no restart
#   --port N               the port Irises listens on (1-65535)
#   --service on|off       run Irises as a user service, or detached
#   --front PATTERNS|none  which chats Irises fronts: comma-separated <platform>:<glob> items, or
#                          the word none to front nothing. It lives in the ENGINE's .env
#   --model-lane LANE      give Irises's own voice a model of its own: anthropic | openrouter |
#                          openai. Needs --model-slug (deep work still runs on the engine's model)
#   --model-slug ID        the model id, exactly as that provider spells it
#   --model-base-url URL   required with --model-lane openai; the OpenAI-compatible endpoint
#   --model-inherit        drop the override and go back to inheriting the engine's model
#   --web on|off           the browser/CLI debug chat this clone serves (WEB_ENABLED)
#   --tz ZONE|host         the IANA zone Irises reads the wall clock in (host = this machine's own)
#   --set KEY=VALUE        set any documented key in this clone's .env (repeatable)
#   --set KEY              …with the value taken from IRISES_SET_VALUE, which is how a key whose
#                          value is a secret is set. At most one bare KEY per run
#   --unset KEY            remove a key from this clone's .env (repeatable)
#   --allow-unknown        allow a --set of a key neither .env.example nor deploy/app.env documents
#   --yes, -y              non-interactive: no questions, take the obvious answer
#   --no-restart           write the settings, leave the running server on the old ones
#   --no-gateway-restart   skip the engine gateway bounce a --front or --port change would do
#   -h, --help             this text
#
# ENVIRONMENT. Secrets travel this way and never on argv: a command line is readable by every other
# process on the box (ps, /proc) and lands in shell history.
#   IRISES_MODEL_API_KEY       the API key for --model-lane. Without one it is ignored, with a
#                              warning — the same thing the installer does
#   IRISES_DASHBOARD_PASSWORD  the /dashboard admin password (DASHBOARD_PASSWORD). Its presence is
#                              itself the request: it needs no flag
#   IRISES_SET_VALUE           the value for a bare `--set KEY`
#
# THE GENERIC EDITOR (--set / --unset)
#   • a KEY is A-Z, 0-9 and _, starting with a letter
#   • a key whose name ends in _KEY, _TOKEN, _PASSWORD or _SECRET may not carry its value on argv:
#     pass the name alone and put the value in IRISES_SET_VALUE
#   • PORT, IRISES_FRONT, OPS_BACKEND, HERMES_API_KEY, OPENCLAW_TOKEN, ENGINE_PUSH_TOKEN and
#     IRISES_HOME are refused. Each is written in more places than this clone's .env — the engine's
#     .env, the install manifest, the service unit — and a flag or a re-install is what moves them
#     all together
#   • a --set key has to be one .env.example or deploy/app.env documents, so a typo cannot go in
#     silently and sit there doing nothing until someone reads the file. Some real keys are only
#     described in PROSE in those files and so do not match: CONVO_MODEL_OPENAI /
#     CLASSIFY_MODEL_OPENAI / FALLFIRM_MODEL_OPENAI, and ANTHROPIC_BASE_URL. Use --allow-unknown
#   • DATA_BACKEND and EMBEDDINGS_DIMENSIONS change WHAT is stored and WHERE; they are warned about
#     and then applied, and nothing already written is migrated
#
# STDIN: run from the menu, this script's stdin IS the menu's stdin. So under --yes (and with no
# TTY, which this treats as the same thing) nothing here reads a line, and anything it shells out to
# gets </dev/null. Eat one line and the menu loses its next answer.
#
# EXIT CODES
#   0   applied, nothing needed changing, or --show
#   1   a step failed or was refused
#   2   wrong usage (an unknown flag, a value that cannot be right, or nothing to configure)
#   4   Irises restarted but /health did not report the build this clone is on
#   5   Irises is configured and live, but its engine's gateway could not be verified back up
#   130/143  stopped mid-run by a signal (Ctrl+C / SIGTERM); RESULT: partial, read the messages
# Every run that gets past the flags ends its stdout with `RESULT: <token>`:
#   ok | noop | health-failed | gateway-failed | partial
# `partial` is a run that stopped before finishing — read the messages above to see how far it got.
# --show ends with `RESULT: ok` as well, so a wrapper always has one line to read. A usage error
# (exit 2) and this help text print none.
set -euo pipefail

source "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/lib/irises-lib.sh"
IRISES_LOG_TAG="irises-configure"

# The report and the preview print with this, not with `say`: the menu shows both inline, and a log
# tag stamped on every line of a twelve-line report is noise around the thing being read.
ui() { printf '%s\n' "$*"; }

SHOW=0
PORT_FLAG=""
SERVICE_FLAG=""
FRONT_FLAG=""
FRONT_SET=0
MODEL_LANE=""
MODEL_SLUG=""
MODEL_BASE_URL=""
MODEL_INHERIT=0
WEB_FLAG=""
TZ_FLAG=""
SET_BARE=""
ALLOW_UNKNOWN=0
ASSUME_YES=0
DO_RESTART=1
DO_GATEWAY=1
# Parallel indexed arrays, because bash 3.2 (what macOS ships) has no associative ones and no `+=`.
SET_KEYS=()
SET_VALS=()
UNSET_KEYS=()

# `--set` is the one flag with two shapes, so the split lives in a function instead of twice in the
# case arm (once for `--set X` and once for `--set=X`).
push_set() { # KEY=VALUE | KEY
  local arg="${1:-}"
  if [ -z "$arg" ]; then
    err "--set takes KEY=VALUE, or a bare KEY whose value comes from IRISES_SET_VALUE (try --help)"
    exit 2
  fi
  case "$arg" in
    *=*)
      SET_KEYS[${#SET_KEYS[@]}]="${arg%%=*}"
      SET_VALS[${#SET_VALS[@]}]="${arg#*=}"
      ;;
    *)
      if [ -n "$SET_BARE" ]; then
        err "--set takes at most one bare KEY per run: the value comes from IRISES_SET_VALUE, and"
        err "one environment variable cannot carry two ('$SET_BARE' and '$arg')"
        exit 2
      fi
      SET_BARE="$arg"
      ;;
  esac
}

push_unset() { # KEY
  local arg="${1:-}"
  if [ -z "$arg" ]; then err "--unset takes a KEY (try --help)"; exit 2; fi
  UNSET_KEYS[${#UNSET_KEYS[@]}]="$arg"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --show)                SHOW=1; shift ;;
    --port)                PORT_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --port=*)              PORT_FLAG="${1#--port=}"; shift ;;
    --service)             SERVICE_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --service=*)           SERVICE_FLAG="${1#--service=}"; shift ;;
    --front)               FRONT_FLAG="${2:-}"; FRONT_SET=1; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --front=*)             FRONT_FLAG="${1#--front=}"; FRONT_SET=1; shift ;;
    --model-lane)          MODEL_LANE="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --model-lane=*)        MODEL_LANE="${1#--model-lane=}"; shift ;;
    --model-slug)          MODEL_SLUG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --model-slug=*)        MODEL_SLUG="${1#--model-slug=}"; shift ;;
    --model-base-url)      MODEL_BASE_URL="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --model-base-url=*)    MODEL_BASE_URL="${1#--model-base-url=}"; shift ;;
    --model-inherit)       MODEL_INHERIT=1; shift ;;
    --web)                 WEB_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --web=*)               WEB_FLAG="${1#--web=}"; shift ;;
    --tz)                  TZ_FLAG="${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --tz=*)                TZ_FLAG="${1#--tz=}"; shift ;;
    --set)                 push_set "${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --set=*)               push_set "${1#--set=}"; shift ;;
    --unset)               push_unset "${2:-}"; shift; if [ $# -gt 0 ]; then shift; fi ;;
    --unset=*)             push_unset "${1#--unset=}"; shift ;;
    --allow-unknown)       ALLOW_UNKNOWN=1; shift ;;
    --yes|-y)              ASSUME_YES=1; shift ;;
    --no-restart)          DO_RESTART=0; shift ;;
    --no-gateway-restart)  DO_GATEWAY=0; shift ;;
    -h|--help)             sed -n '2,77p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "unknown arg: $1 (try --help)"; exit 2 ;;
  esac
done

# ── validation ───────────────────────────────────────────────────────────────
# ALL of it up here, before the exit guard is armed and before a single file is opened, so a typo is
# a usage error that changes nothing and prints no RESULT line (update.sh:83-105, same reason).

# A key a human may type, as `case` globs: nothing forks, so the same predicate is affordable in a
# loop over a whole .env later.
key_valid() { # KEY
  case "${1:-}" in
    ''|*[!A-Z0-9_]*) return 1 ;;
    [A-Z]*)          return 0 ;;
  esac
  return 1
}

# Keys the generic editor will not touch, each with the reason and the thing to use instead. They
# are not refused for being dangerous to the file: they are refused because this clone's .env is not
# the only place they are written, and editing one of them here leaves the engine's .env, the
# manifest or the service unit disagreeing with it.
reserved_key() { # KEY -> 0 when refused, and says why on stderr
  case "${1:-}" in
    PORT)
      err "PORT is --port's: a port move also rewrites the engine's IRISES_URL and the install"
      err "manifest, and verifies Irises back up on the new one. Use:  --port N"
      return 0 ;;
    IRISES_FRONT)
      err "IRISES_FRONT is --front's, and it lives in the ENGINE's .env, not this clone's — setting"
      err "it here would change nothing at all. Use:  --front 'telegram:*'  or  --front none"
      return 0 ;;
    OPS_BACKEND|HERMES_API_KEY|OPENCLAW_TOKEN|ENGINE_PUSH_TOKEN)
      err "$1 is engine wiring — which engine, and the credentials the two of them talk over. It is"
      err "set by the install, together with the plugin and the keys on the engine's side."
      err "Re-run the install:  bash scripts/engine-setup.sh"
      return 0 ;;
    IRISES_HOME)
      err "IRISES_HOME is where your data lives and the service unit embeds it, so a .env edit and"
      err "the running service would point at two different directories. Uninstall and re-install"
      err "with the new home:  bash scripts/engine-setup.sh --uninstall"
      return 0 ;;
  esac
  return 1
}

# Is KEY one that .env.example or deploy/app.env actually documents? A grep for the ASSIGNMENT —
# commented out or not — and never a word match: both files discuss engine-side keys in prose, and a
# key that only ever appears in a sentence must not become settable here on the strength of that.
documented_key() { # KEY
  local key="${1:-}" root ex app
  root="$(irises_root)"
  ex="$root/.env.example"
  app="$root/deploy/app.env"
  # A test sandbox — and any hand-set IRISES_ROOT — points the root at a directory holding a .env
  # and nothing else. Fall back to the clone this script is IN, which always carries both files.
  if [ ! -f "$ex" ] && [ ! -f "$app" ]; then
    root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
    ex="$root/.env.example"
    app="$root/deploy/app.env"
  fi
  if [ ! -f "$ex" ]; then ex=/dev/null; fi
  if [ ! -f "$app" ]; then app=/dev/null; fi
  grep -qE "^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?${key}=" "$ex" "$app"
}

# One gate for every key --set and --unset name, in the order that makes the FIRST message the most
# useful one: a reserved key is refused whether or not a value came with it, so someone who typed
# `--set PORT` is told about --port rather than about IRISES_SET_VALUE.
check_key() { # KEY MODE(set|unset) WITH_VALUE(1|0)
  local key="${1:-}" mode="${2:-set}" with_value="${3:-0}"
  if ! key_valid "$key"; then
    err "--$mode takes a KEY of A-Z, 0-9 and _ starting with a letter, got '$key'"
    exit 2
  fi
  if [ "$with_value" = "1" ] && is_secret_key "$key"; then
    err "--set $key=VALUE puts a secret on the command line (visible to every process on the box,"
    err "kept in shell history) — use:  IRISES_SET_VALUE=… bash scripts/configure.sh --set $key"
    exit 2
  fi
  if reserved_key "$key"; then exit 2; fi
  if [ "$mode" = "set" ] && [ "$ALLOW_UNKNOWN" != "1" ] && ! documented_key "$key"; then
    err "$key is not a key .env.example or deploy/app.env documents — a typo here is silent at boot."
    err "Pass --allow-unknown if you mean it"
    exit 2
  fi
  # Applied, not refused: someone asking for either of these usually means it. What they do not
  # always know is that the data already written stays in the shape the old value put it in.
  case "$key" in
    DATA_BACKEND|EMBEDDINGS_DIMENSIONS)
      warn "$key changes what Irises stores and where — nothing already written is migrated" ;;
  esac
  return 0
}

case "$PORT_FLAG" in
  '') ;;
  *[!0-9]*) err "--port takes a plain port number 1-65535, got '$PORT_FLAG'"; exit 2 ;;
  *)
    # Length first: bash's arithmetic would choke on a 30-digit "port" before the range test ran.
    if [ "${#PORT_FLAG}" -gt 5 ] || [ "$PORT_FLAG" -lt 1 ] || [ "$PORT_FLAG" -gt 65535 ]; then
      err "--port takes a port number 1-65535, got '$PORT_FLAG'"
      exit 2
    fi ;;
esac

case "$SERVICE_FLAG" in
  ''|on|off) ;;
  *) err "--service takes on or off, got '$SERVICE_FLAG'"; exit 2 ;;
esac

# Checked HERE rather than where it is used, because the engine fronts NOTHING for an IRISES_FRONT
# it cannot parse — which on the other end looks exactly like a configure run that did not work.
if [ "$FRONT_SET" = "1" ]; then
  case "$FRONT_FLAG" in
    none) ;;
    *)
      if ! front_pattern_valid "$FRONT_FLAG"; then
        err "--front takes comma-separated <platform>:<glob> items, or the word none, got '$FRONT_FLAG'"
        err "e.g. --front 'telegram:*'  ·  --front 'telegram:*,whatsapp:+1555*'  ·  --front '*:*'"
        exit 2
      fi ;;
  esac
fi

# The two halves of the model setting ask for opposite things, so one run cannot want both.
if [ "$MODEL_INHERIT" = "1" ]; then
  if [ -n "$MODEL_LANE" ] || [ -n "$MODEL_SLUG" ] || [ -n "$MODEL_BASE_URL" ]; then
    err "--model-inherit hands Irises's voice back to the engine's model; --model-lane/--model-slug/"
    err "--model-base-url pin one instead. Run whichever you meant, on its own."
    exit 2
  fi
fi
# The override is all-or-nothing (engine-setup.sh's rule, and it has to stay the same rule): a lane
# with no slug names no model, and a slug with no lane cannot be written at all, because the three
# lanes use three different key names.
case "$MODEL_LANE" in
  '')
    if [ -n "$MODEL_SLUG" ] || [ -n "$MODEL_BASE_URL" ]; then
      err "--model-slug / --model-base-url need --model-lane anthropic|openrouter|openai"
      exit 2
    fi ;;
  anthropic|openrouter|openai)
    if [ -z "$MODEL_SLUG" ]; then
      err "--model-lane $MODEL_LANE needs --model-slug (the model id, exactly as that provider spells it)"
      exit 2
    fi
    if [ "$MODEL_LANE" = "openai" ] && [ -z "$MODEL_BASE_URL" ]; then
      err "--model-lane openai needs --model-base-url — an OpenAI-compatible lane is a URL plus a key,"
      err "and guessing api.openai.com for a host that is not it fails at the first call"
      exit 2
    fi
    if [ "$MODEL_LANE" != "openai" ] && [ -n "$MODEL_BASE_URL" ]; then
      err "--model-base-url only applies to --model-lane openai"
      exit 2
    fi ;;
  *) err "unknown --model-lane '$MODEL_LANE' — expected anthropic, openrouter or openai"; exit 2 ;;
esac
# Warned about and ignored, NOT refused — the installer behaves the same way. A shell that exported
# the key once, for one command, must still be able to run every other configure command in it.
if [ -n "${IRISES_MODEL_API_KEY:-}" ] && [ -z "$MODEL_LANE" ]; then
  warn "IRISES_MODEL_API_KEY is set in the environment and ignored — it only applies with --model-lane"
fi

case "$WEB_FLAG" in
  ''|on|off) ;;
  *) err "--web takes on or off, got '$WEB_FLAG'"; exit 2 ;;
esac
# A zone is checked for SHAPE only. Whether the name is one this box's tzdata knows is the server's
# question (src/pipeline/zonedTime.ts warns and falls back to the host zone), and a script that
# refused a zone a newer tzdata does know would be the worse failure of the two.
case "$TZ_FLAG" in
  '') ;;
  *[[:space:]]*) err "--tz takes one IANA zone name, or the word host, got '$TZ_FLAG'"; exit 2 ;;
esac

i=0
while [ "$i" -lt "${#SET_KEYS[@]}" ]; do
  check_key "${SET_KEYS[$i]}" set 1
  i=$((i + 1))
done
if [ -n "$SET_BARE" ]; then
  check_key "$SET_BARE" set 0
  if [ -z "${IRISES_SET_VALUE:-}" ]; then
    err "--set $SET_BARE takes its value from IRISES_SET_VALUE, and that is unset or empty."
    err "Use:  IRISES_SET_VALUE=… bash scripts/configure.sh --set $SET_BARE"
    err "(to remove the key instead:  bash scripts/configure.sh --unset $SET_BARE)"
    exit 2
  fi
fi
i=0
while [ "$i" -lt "${#UNSET_KEYS[@]}" ]; do
  # An UNSET of a key nothing documents is fine: the whole point is to take out a line that should
  # not be there, and a key already in the file is proof enough that it exists.
  check_key "${UNSET_KEYS[$i]}" unset 0
  i=$((i + 1))
done

HAVE_SETTING=0
if [ -n "$PORT_FLAG" ] || [ -n "$SERVICE_FLAG" ] || [ "$FRONT_SET" = "1" ] ||
   [ -n "$MODEL_LANE" ] || [ "$MODEL_INHERIT" = "1" ] || [ -n "$WEB_FLAG" ] || [ -n "$TZ_FLAG" ] ||
   [ "${#SET_KEYS[@]}" -gt 0 ] || [ -n "$SET_BARE" ] || [ "${#UNSET_KEYS[@]}" -gt 0 ]; then
  HAVE_SETTING=1
fi

# A report of the OLD values followed by a write of new ones is not what anybody asking for both
# wanted, and there is no ordering of the two that is.
if [ "$SHOW" = "1" ] && [ "$HAVE_SETTING" = "1" ]; then
  err "--show reports and changes nothing; a setting flag changes something. Run them separately:"
  err "  bash scripts/configure.sh --show"
  exit 2
fi
if [ "$SHOW" = "0" ] && [ "$HAVE_SETTING" = "0" ] && [ -z "${IRISES_DASHBOARD_PASSWORD:-}" ]; then
  err "nothing to configure — see what is set with:  bash scripts/configure.sh --show   (or --help)"
  exit 2
fi

# No TTY = nobody can answer a question, so don't ask one. An agent-driven run lands here (both
# engines spawn shell commands with stdin at /dev/null, so any `read` would hit EOF immediately).
if [ ! -t 0 ] && [ "$ASSUME_YES" != "1" ]; then
  ASSUME_YES=1
  say "stdin is not a terminal — running non-interactive (same as --yes)"
fi
# The library's prompt helpers read THIS, never the terminal: whether a run may ask a question is a
# decision this script has already made, above, out of --yes and the no-TTY case.
IRISES_ASSUME_YES="$ASSUME_YES"

ROOT="$(irises_root)"
ENV_FILE="$ROOT/.env"
cd "$ROOT"
augment_path

# Armed HERE, past every usage exit and before the first byte of real work: the guard releases the
# lock and leaves ONE machine-readable line on stdout (`RESULT: partial`) for the paths that never
# reach `summary` — a `set -e` abort on some statement nobody guarded, and a Ctrl+C. It never
# changes the exit code, and it is harmless on a --show run, which takes no lock.
trap 'lifecycle_exit_guard $?' EXIT

# ── --show ───────────────────────────────────────────────────────────────────
# One line per setting, `label: value (source)`, and never a secret VALUE — a key is disclosed by
# NAME plus <set>/<unset>, which is the whole house rule in one place.
#
# It has to render on a clone that was never installed, because that is the moment the report is
# most wanted. Nothing here guards for a missing file: env_get, env_count, manifest_read and
# built_sha all return empty on one, and an extra `[ -f ]` per line would only fork more.
show_report() {
  local man v w src kind installed running sha engine reason
  local ef front lane slug role out key

  man="$(manifest_path)"

  v="$(irises_port)"
  if [ -n "$(env_get "$ENV_FILE" PORT)" ]; then
    src=".env"
  elif [ -n "$(env_get "$ROOT/deploy/app.env" PORT)" ]; then
    src="deploy/app.env"
  else
    src="default"
  fi
  ui "  port:               $v  ($src)"

  kind="$(service_kind)"
  if service_installed; then installed="yes"; else installed="no"; fi
  if [ "$installed" = "yes" ]; then
    # Installed: ask the service manager. Not installed: the pidfile is the only liveness there is,
    # because a detached run has no unit to query.
    if service_status; then running="yes"; else running="no"; fi
  else
    if [ -n "$(server_pid)" ]; then running="yes"; else running="no"; fi
  fi
  ui "  service:            $kind  (installed $installed · running $running)"

  sha="$(built_sha "$ROOT")"
  if [ -n "$sha" ]; then
    ui "  build:              $(printf '%.7s' "$sha")  (dist/version.json)"
  else
    ui "  build:              not built  (npm run build)"
  fi

  if [ -f "$man" ]; then
    ui "  manifest:           $man  (present)"
  else
    ui "  manifest:           $man  (none)"
  fi

  engine="$(engine_kind 2>/dev/null || printf off)"
  ui "  engine:             $engine  (.env OPS_BACKEND)"

  # IRISES_FRONT is the ENGINE's key, so it is only readable when this install actually put it
  # there: a bridge plugin, and an engine .env we were allowed to write.
  ef="$(manifest_read "$man" engineEnvFile)"
  if [ "$engine" = "hermes" ] && [ "$(manifest_read "$man" bridge)" = "1" ] &&
     [ "$(manifest_read "$man" engineEnvApplied)" = "true" ]; then
    if [ "$(env_count "$ef" IRISES_FRONT)" = "0" ]; then
      ui "  fronts:             not set  (engine .env)"
    else
      front="$(env_get "$ef" IRISES_FRONT)"
      if [ -z "$front" ]; then
        ui "  fronts:             nothing (IRISES_FRONT is empty)  (engine .env)"
      else
        ui "  fronts:             $front  (engine .env)"
      fi
    fi
  else
    if [ "$engine" = "off" ]; then
      reason="no engine"
    elif [ "$(manifest_read "$man" bridge)" != "1" ]; then
      reason="no bridge plugin"
    else
      reason="the engine .env carries nothing of ours"
    fi
    ui "  fronts:             n/a ($reason)"
  fi

  # Inheritance is the default and it is wide: with it on, boot-time engine discovery supplies the
  # model AND the key and base URL under it. A CONVO_PROVIDER in this clone's .env is the other
  # tell — it beats discovery whatever ENGINE_MODEL_INHERIT says.
  v="$(env_get "$ENV_FILE" ENGINE_MODEL_INHERIT)"
  case "$v" in
    off|false|0|no) w="off" ;;
    *)              w="on" ;;
  esac
  if [ "$w" = "on" ] && [ -z "$(env_get "$ENV_FILE" CONVO_PROVIDER)" ]; then
    ui "  voice model:        inherited from the engine  (ENGINE_MODEL_INHERIT is not off)"
  else
    out=""
    for role in CONVO CLASSIFY FALLFIRM; do
      lane="$(env_get "$ENV_FILE" "${role}_PROVIDER")"
      case "$lane" in
        openrouter) slug="$(env_get "$ENV_FILE" "${role}_MODEL_OPENROUTER")" ;;
        openai)     slug="$(env_get "$ENV_FILE" "${role}_MODEL_OPENAI")" ;;
        *)          slug="$(env_get "$ENV_FILE" "${role}_MODEL")" ;;
      esac
      if [ -z "$lane" ]; then lane="the shipped lane"; fi
      if [ -z "$slug" ]; then slug="not set"; fi
      out="$out · ${role}: $slug on $lane"
    done
    ui "  voice model:        ${out# · }  (.env)"
  fi

  v="$(env_get "$ENV_FILE" WEB_ENABLED)"
  if [ "$v" = "false" ]; then w="off"; else w="on"; fi
  if [ -n "$v" ]; then src=".env"; else src="default"; fi
  ui "  browser chat:       $w  ($src)"

  v="$(env_get "$ENV_FILE" IRISES_TZ)"
  if [ -n "$v" ]; then
    ui "  timezone:           $v  (.env)"
  else
    ui "  timezone:           host zone  (IRISES_TZ unset)"
  fi

  if [ -n "$(env_get "$ENV_FILE" DASHBOARD_PASSWORD)" ]; then
    ui "  dashboard password: <set>  (.env)"
  else
    ui "  dashboard password: shipped default  (.env carries none)"
  fi

  out=""
  for key in ANTHROPIC_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY; do
    if [ -n "$(env_get "$ENV_FILE" "$key")" ]; then
      out="$out · $key <set>"
    else
      out="$out · $key <unset>"
    fi
  done
  ui "  lane keys:          ${out# · }  (.env, by name only)"

  ui "  data:               $(irises_home)"

  summary ok "report only — nothing was changed"
  return 0
}

if [ "$SHOW" = "1" ]; then
  show_report
  exit 0
fi

# A signal trap's `exit` fires the EXIT trap as well, and the RESULT line is latched there, so the
# two overlap by design: exactly one line, whichever got to it first. 130/143 are the codes a shell
# reports for Ctrl+C and SIGTERM, and a caller reading them must not see a different number here.
trap 'lifecycle_exit_guard 130' INT
trap 'lifecycle_exit_guard 143' TERM

# Every flag above is validated and every setting is known; what is missing is the part that plans
# the writes, previews them, takes the lock and restarts Irises into them. It exits 1 on purpose:
# a script that accepted the flags and quietly did nothing is the failure this whole verb exists to
# stop, and `partial` says exactly that — nothing has been changed yet.
summary partial "configure: applying settings is not built yet"
exit 1
