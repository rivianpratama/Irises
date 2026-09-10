#!/usr/bin/env bash
# Irises lifecycle end-to-end — install, update, repair, roll back, recover, uninstall, in a sandbox.
#
#   npm run e2e:lifecycle          # or: bash scripts/e2e/lifecycle-sandbox.sh
#   KEEP=1 npm run e2e:lifecycle   # leave the sandbox behind for inspection
#
# NOT part of `npm test`: it starts real servers, binds real ports and takes ~3 minutes (two stages
# deliberately sit out a wait budget in full). It is the battery that would have caught every bug the unit
# tests cannot see — the ones that only exist when the lifecycle stages run in sequence against each
# other: a rollback that leaves the box with no server, a repair that never repairs, a plugin
# refreshed for code that was then undone, a second uninstall that bounces an engine for nothing.
#
# OFFLINE BY CONSTRUCTION. The scratch PATH carries a stub `npm`:
#   ci    -> hard-link-copies THIS repo's node_modules into the sandbox clone
#   build -> runs the real node_modules/.bin/tsc + cpx + scripts/stamp-version.js
#   web   -> a logged no-op
# So there is no registry traffic, and the build is still a real compile: the two failure stages
# below publish commits that genuinely do not compile, and genuinely compile and then die at module
# load — the cases no unit test can stage.
#
# WHAT IT ASSERTS, in order:
#   1   install    — detached start, /health serving the sha that was built, plugin copied to the
#                    stub engine, engine .env carrying our keys, manifest written, engine CLI called
#   2   update      — a commit published to the fake origin is applied, the LIVE sha flips to it, the
#                    receipt is written, the plugin is refreshed, the engine CLI is called
#   2b  repair      — dist/version.json stamped from a sha nobody has: HEAD is current, so this is
#                    not an update but an unfinished build, and it is rebuilt and re-verified
#   3a  exit 3      — a commit that does not compile: the tree, dist and node_modules all go back,
#                    and the running server is never touched (same pid, same sha, still answering)
#   3   exit 4      — a commit that COMPILES and throws at module load: rolled back, the OLD build is
#                    serving again, and the engine's plugin was NOT refreshed for code that is gone
#   3b  recovery    — the box moves forward again after a rollback, and NOW the plugin is refreshed
#   3c  exit 5      — Irises is updated and live, but the engine's gateway cannot be verified back
#                    up: the update is not undone, and the run says so with its own exit code
#   4   uninstall   — the server stops, the plugin dir is gone, our keys are stripped from the engine
#                    .env while a pre-existing key survives, and $IRISES_HOME is KEPT
#   5   uninstall×2 — a second one in a row changes nothing: no fresh backup, no gateway bounce
#
# NOTHING OF YOURS IS TOUCHED. Every stage runs under a throwaway HOME, IRISES_HOME and HERMES_HOME,
# on two ephemeral ports, against a bare origin made from this clone's own objects. The scratch PATH
# is $BIN first, and the three service-manager probes on it are FAILING STUBS rather than absences:
# the library's augment_path re-appends /bin and /usr/bin on every run, so a tool cannot be kept off
# PATH by leaving it out of $BIN — and with the real ones visible, this box's own running engine
# gateway answers the library's service probe and stage 3c can never see its 90s budget expire.
# Stubs that log and exit 1 are how the sandbox stays blind to the machine it runs on.
set -euo pipefail

REPO="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
SANDBOX="$REPO/scripts/e2e/.sandbox"
PASS=0
FAIL=0
STARTED="$(date +%s)"

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
check_no_out() { # DESCRIPTION NEEDLE HAYSTACK
  if contains "$2" "$3"; then bad "$1 — found: $2"; else ok "$1"; fi
}
check_rc() { # DESCRIPTION WANT GOT
  if [ "$2" = "$3" ]; then ok "$1 (exit $2)"; else bad "$1 — exit $3, expected $2"; fi
}
present() { grep -q "$2" "$1" >/dev/null 2>&1; }          # FILE NEEDLE
absent()  { ! grep -q "$2" "$1" >/dev/null 2>&1; }        # FILE NEEDLE
say_sha() { printf '%s' "${1:0:7}"; }

# pgrep is deliberately NOT on the scratch PATH (see the header), so the sweep at exit keeps its own
# absolute handle on the one taken before the swap. It only ever matches paths inside the sandbox.
REAL_PGREP="$(command -v pgrep 2>/dev/null || true)"

cleanup() {
  local pid p
  if [ -n "${STATE:-}" ] && [ -f "$STATE/irises.pid" ]; then
    pid="$(cat "$STATE/irises.pid" 2>/dev/null || true)"
    case "${pid:-}" in ''|*[!0-9]*) ;; *) kill "$pid" 2>/dev/null || true ;; esac
  fi
  if [ -n "${CLONE:-}" ] && [ -n "$REAL_PGREP" ]; then
    for p in $("$REAL_PGREP" -f "$CLONE/dist/index.js" 2>/dev/null || true); do
      kill "$p" 2>/dev/null || true
    done
  fi
  engine_stub_stop
  if [ "${KEEP:-0}" != "1" ]; then rm -rf "$SANDBOX"; else printf '\nsandbox kept at %s\n' "$SANDBOX"; fi
}

rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"
HOME_DIR="$SANDBOX/home"
BIN="$SANDBOX/bin"
ORIGIN="$SANDBOX/origin.git"
CLONE="$SANDBOX/clone"
STATE="$SANDBOX/irises-home"
HERMES="$SANDBOX/engine"
UP="$SANDBOX/upstream"
STUB_LOG="$SANDBOX/stub.log"
mkdir -p "$HOME_DIR" "$BIN" "$STATE" "$HERMES/plugins"
: > "$STUB_LOG"

# Two free high ports, taken in ONE process so they cannot come back equal: a developer's own Irises
# on :3000 and their own engine on :8642 are never disturbed.
PORTS="$(node -e '
const net = require("net");
const a = net.createServer(), b = net.createServer();
a.listen(0, "127.0.0.1", () => b.listen(0, "127.0.0.1", () => {
  process.stdout.write(a.address().port + " " + b.address().port);
  a.close(); b.close();
}));
')"
SRV_PORT="${PORTS%% *}"
ENGINE_PORT="${PORTS##* }"

# The stub engine's health surface, so the library's gateway probe has something real to verify a
# bounce against. Started and stopped by name, because stage 3c takes it away on purpose.
HERMES_SRV=""
engine_stub_start() {
  node -e "
const http = require('http');
http.createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end('{\"status\":\"ok\"}'); })
  .listen($ENGINE_PORT, '127.0.0.1');
" &
  HERMES_SRV=$!
}
engine_stub_stop() {
  if [ -n "${HERMES_SRV:-}" ]; then
    kill "$HERMES_SRV" 2>/dev/null || true
    wait "$HERMES_SRV" 2>/dev/null || true
    HERMES_SRV=""
  fi
}
trap cleanup EXIT

step "sandbox at $SANDBOX (Irises :$SRV_PORT, stub engine :$ENGINE_PORT)"

# ── the scratch PATH ──────────────────────────────────────────────────────────
# nohup and setsid are what server_start_detached needs (setsid is absent on macOS and skipped by
# this loop). ls is here because the checks below shell out to it.
for tool in bash sh cat cp rm mv ls mkdir chmod find grep sed head tail cut tr sleep date printf ps \
            uname id dirname basename du curl node git awk sort stat env mktemp kill touch ln wc od \
            xargs nohup setsid; do
  real="$(command -v "$tool" 2>/dev/null || true)"
  if [ -n "$real" ] && [ ! -e "$BIN/$tool" ]; then ln -s "$real" "$BIN/$tool"; fi
done

# npm: offline, and a real compile. `ci` hard-links this repo's node_modules (cp -al where the
# filesystem allows it, cp -R otherwise); `build` runs the actual toolchain out of it.
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

# The engine CLIs: log argv and succeed. Every lifecycle claim about "the engine was told" is checked
# against this log.
for stub in hermes openclaw; do
  cat > "$BIN/$stub" <<EOF
#!/usr/bin/env bash
printf '$stub %s\n' "\$*" >> "$STUB_LOG"
exit 0
EOF
  chmod +x "$BIN/$stub"
done

# The service managers: log argv and FAIL. See the header — this is what keeps the sandbox from
# reading (or driving) the real box's own services and processes.
for stub in systemctl launchctl pgrep; do
  cat > "$BIN/$stub" <<EOF
#!/usr/bin/env bash
printf 'STUB-$stub %s\n' "\$*" >> "$STUB_LOG"
exit 1
EOF
  chmod +x "$BIN/$stub"
done

# The engine's .env, with one key that was there BEFORE Irises — the uninstall must not remove it.
printf 'ANTHROPIC_API_KEY=engine-owned-key\nAPI_SERVER_KEY=pre-existing-engine-key\n' > "$HERMES/.env"

export PATH="$BIN"
export HOME="$HOME_DIR"
export IRISES_HOME="$STATE"
export HERMES_HOME="$HERMES"
export NO_COLOR=1
export STUB_LOG

engine_stub_start

# ── readers ───────────────────────────────────────────────────────────────────
health_sha() { # the sha /health reports, or empty
  local body got
  body="$(curl -fsS -m 5 "http://127.0.0.1:$SRV_PORT/health" 2>/dev/null || true)"
  got="$(printf '%s' "$body" | grep -o '"sha":"[0-9a-f]\{7,40\}"' | head -1 | cut -d'"' -f4 || true)"
  printf '%s' "$got"
}
expect_sha() { # DESCRIPTION WANT
  local desc="${1:-}" want="${2:-}" got
  got="$(health_sha)"
  if [ -n "$got" ] && [ "$got" = "$want" ]; then
    ok "$desc ($(say_sha "$want"))"
  else
    bad "$desc — /health serves '${got:-nothing}', expected $(say_sha "$want")"
  fi
}
dist_sha() { # the sha dist/ was stamped from, or empty
  local v
  v="$(grep -o '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]\{7,40\}"' "$CLONE/dist/version.json" 2>/dev/null \
       | head -1 | cut -d'"' -f4 || true)"
  printf '%s' "$v"
}
srv_pid() { cat "$STATE/irises.pid" 2>/dev/null || true; }
key_count() { # FILE KEY
  grep -c "^$2=" "$1" 2>/dev/null || true
}
backups() { ls "$HERMES"/.env.bak-irises-* 2>/dev/null || true; }

# ── the fake origin, the clone, and the upstream working copy ─────────────────
step "publishing a fake origin from $REPO"
git init --quiet --bare "$ORIGIN"
git clone --quiet --no-hardlinks "$REPO" "$CLONE" >/dev/null 2>&1
git -C "$CLONE" remote set-url origin "$ORIGIN"
git -C "$CLONE" config user.name "Irises E2E"
git -C "$CLONE" config user.email "e2e@example.invalid"
BRANCH="$(git -C "$CLONE" rev-parse --abbrev-ref HEAD)"
git -C "$CLONE" push --quiet origin "$BRANCH"
BASE_SHA="$(git -C "$CLONE" rev-parse HEAD)"
# `git init --bare` points HEAD at its own default name (master/main), which is NOT the branch this
# clone is on — so a clone of this origin would land on an unborn branch of the wrong name and every
# push below would fail with "src refspec does not match any". Say what the default branch is, and
# then ask for it by name as well.
git -C "$ORIGIN" symbolic-ref HEAD "refs/heads/$BRANCH"

git clone --quiet --branch "$BRANCH" "$ORIGIN" "$UP"
git -C "$UP" config user.name "Irises E2E"
git -C "$UP" config user.email "e2e@example.invalid"

# A harness that keeps going on a broken sandbox reports the lifecycle scripts as failing when it is
# the sandbox that failed. Every step that builds the fixture is guarded and stops the run instead.
fatal() { printf '\n\033[1;31mHARNESS ERROR\033[0m %s\n\nRESULT: failed\n' "$*"; exit 1; }

# Publish a commit upstream and print its sha. TEXT is appended to src/index.ts, which every stage
# here needs anyway: it is the module whose compile and whose module-load are what fail below.
# Every step returns 1 on its own — errexit does not reliably leave a `$( )` used in an assignment.
publish() { # MESSAGE TEXT
  git -C "$UP" pull --quiet --ff-only origin "$BRANCH" || return 1
  printf '\n%s\n' "$2" >> "$UP/src/index.ts" || return 1
  git -C "$UP" commit --quiet -am "$1" || return 1
  git -C "$UP" push --quiet origin "$BRANCH" || return 1
  git -C "$UP" rev-parse HEAD
}
# Take a published commit back out, so the stages after it see an origin that builds and boots.
unpublish() { # SHA
  git -C "$UP" revert --no-edit "$1" >/dev/null || return 1
  git -C "$UP" push --quiet origin "$BRANCH" || return 1
  git -C "$UP" rev-parse HEAD
}

# The clone's own config: the stub engine, our high port, no web UI. The default data backend
# (SQLite under $IRISES_HOME) is what a real install uses, so it is left at its default here.
# UPDATE_CHECK_ENABLED=false is the one deliberate difference: the server's own checker fetches this
# clone every few minutes, and a background fetch racing the updater's fetch/merge/reset is neither
# what this battery is testing nor something it could tell apart from a real defect.
cat > "$CLONE/.env" <<EOF
OPS_BACKEND=hermes
HERMES_BASE_URL=http://127.0.0.1:$ENGINE_PORT
PORT=$SRV_PORT
ANTHROPIC_API_KEY=sandbox-not-a-real-key
UPDATE_CHECK_ENABLED=false
EOF
chmod 600 "$CLONE/.env"

# ── 1. install ────────────────────────────────────────────────────────────────
step "1/9  install"
set +e
INSTALL_OUT="$(cd "$CLONE" && bash scripts/engine-setup.sh --engine hermes --yes --no-service 2>&1)"
INSTALL_RC=$?
set -e
printf '%s\n' "$INSTALL_OUT" | sed 's/^/    | /'
check_out "install ends with a RESULT line" "RESULT:" "$INSTALL_OUT"
check_rc "install succeeded" 0 "$INSTALL_RC"
expect_sha "/health serves the sha that was built" "$BASE_SHA"
check "the bridge plugin was copied to the engine" test -f "$HERMES/plugins/irises-bridge/plugin.yaml"
check "no __pycache__ came with it" test ! -d "$HERMES/plugins/irises-bridge/__pycache__"
check "the plugin was enabled through the engine CLI" present "$STUB_LOG" "hermes plugins enable irises-bridge"
check "the gateway was bounced" grep -qE "hermes gateway re?start" "$STUB_LOG"
check "the engine .env was backed up" test -n "$(backups)"
check "IRISES_PUSH_TOKEN was added to the engine" present "$HERMES/.env" '^IRISES_PUSH_TOKEN='
check "IRISES_FRONT was added to the engine" present "$HERMES/.env" '^IRISES_FRONT='
if [ "$(key_count "$HERMES/.env" API_SERVER_KEY)" = "1" ]; then
  ok "the pre-existing engine key was NOT duplicated"
else
  bad "API_SERVER_KEY appears $(key_count "$HERMES/.env" API_SERVER_KEY) time(s) in the engine .env"
fi
check "the manifest was written" test -f "$STATE/install-manifest.json"
check "the manifest names the plugin dir" present "$STATE/install-manifest.json" 'pluginDir'
check "the server wrote exactly one pidfile" test -f "$STATE/irises.pid"
check "and none in the clone root" test ! -f "$CLONE/irises.pid"
check "no service was installed (detached fallback)" test ! -f "$HOME_DIR/Library/LaunchAgents/ai.irises.server.plist"

# ── 2. update ─────────────────────────────────────────────────────────────────
step "2/9  update — a real commit published upstream"
NEXT_SHA="$(publish "e2e: a harmless upstream change" "// e2e: a harmless upstream change")" \
  || fatal "could not publish the update commit to the fake origin"

set +e
CHECK_OUT="$(cd "$CLONE" && bash scripts/update.sh --check 2>&1)"
CHECK_RC=$?
set -e
check_rc "--check reports an available update by exit code" 10 "$CHECK_RC"
check_out "--check reports update-available" "RESULT: update-available" "$CHECK_OUT"
check "--check applied nothing" test "$(git -C "$CLONE" rev-parse HEAD)" = "$BASE_SHA"

: > "$STUB_LOG"
set +e
UPDATE_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
UPDATE_RC=$?
set -e
printf '%s\n' "$UPDATE_OUT" | sed 's/^/    | /'
check_rc "update succeeded" 0 "$UPDATE_RC"
check_out "update reports ok" "RESULT: ok" "$UPDATE_OUT"
expect_sha "the LIVE sha flipped — the new build is what answers" "$NEXT_SHA"
check "the plugin was refreshed again" present "$STUB_LOG" "hermes plugins enable irises-bridge"
check "the gateway was bounced again" grep -qE "hermes gateway re?start" "$STUB_LOG"
# The server consumes the receipt at boot and archives it under updates/ — either state proves it
# was written; a missing pair proves it was not.
if [ -f "$STATE/update-receipt.json" ] || [ -n "$(ls "$STATE"/updates/applied-*.json 2>/dev/null || true)" ]; then
  ok "the update receipt was written (pending or already archived by the boot announce)"
else
  bad "no receipt anywhere — Irises would never mention the upgrade"
fi
check "no update-status.json was left behind" test ! -f "$STATE/update-status.json"

# ── 2b. repair ────────────────────────────────────────────────────────────────
# HEAD is current and origin has nothing new, but dist/ was stamped from a sha nobody has: a previous
# build (or its box) died half-way. Reporting "up to date" would strand that.
step "2b/9  repair — HEAD is current, dist/ was stamped from a sha that does not exist"
node -e '
const fs = require("fs"), f = process.argv[1];
const o = JSON.parse(fs.readFileSync(f, "utf8"));
o.sha = "0".repeat(40);
fs.writeFileSync(f, JSON.stringify(o, null, 2) + "\n");
' "$CLONE/dist/version.json"
: > "$STUB_LOG"
set +e
REPAIR_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
REPAIR_RC=$?
set -e
printf '%s\n' "$REPAIR_OUT" | sed 's/^/    | /'
check_rc "the repair succeeded" 0 "$REPAIR_RC"
check_out "the repair reports ok" "RESULT: ok" "$REPAIR_OUT"
check_out "and says what it repaired" "repaired an unfinished build" "$REPAIR_OUT"
check "dist/ was re-stamped from HEAD" test "$(dist_sha)" = "$NEXT_SHA"
expect_sha "the repaired build is the one answering" "$NEXT_SHA"
check "a repair leaves the engine's plugin alone" absent "$STUB_LOG" "plugins enable irises-bridge"

# ── 3a. a build that does not compile ─────────────────────────────────────────
step "3a/9  rollback (exit 3) — a commit that does NOT compile"
BADBUILD_SHA="$(publish "e2e: does not compile" 'const irisesE2E: number = "not a number";')" \
  || fatal "could not publish the uncompilable commit to the fake origin"
PID_BEFORE="$(srv_pid)"
: > "$STUB_LOG"
set +e
BUILD_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
BUILD_RC=$?
set -e
printf '%s\n' "$BUILD_OUT" | sed 's/^/    | /'
check_rc "a build that fails exits 3" 3 "$BUILD_RC"
check_out "and reports rolled-back" "RESULT: rolled-back" "$BUILD_OUT"
check "the tree went back to the previous sha" test "$(git -C "$CLONE" rev-parse HEAD)" = "$NEXT_SHA"
check "dist/ is still the previous build" test "$(dist_sha)" = "$NEXT_SHA"
check "node_modules survived the rollback" test -d "$CLONE/node_modules/typescript"
expect_sha "the running server still answers" "$NEXT_SHA"
if [ -n "$PID_BEFORE" ] && [ "$(srv_pid)" = "$PID_BEFORE" ]; then
  ok "the server was never touched (still pid $PID_BEFORE)"
else
  bad "the server pid changed ($PID_BEFORE -> $(srv_pid)) — a failed BUILD must not restart anything"
fi
check "no receipt was left for a build that never ran" test ! -f "$STATE/update-receipt.json"
check "and the engine was told nothing" absent "$STUB_LOG" "plugins enable irises-bridge"
REVERT_BUILD_SHA="$(unpublish "$BADBUILD_SHA")" \
  || fatal "could not revert the uncompilable commit upstream"

# ── 3. a build that compiles and dies at boot ────────────────────────────────
step "3/9  rollback (exit 4) — a commit that COMPILES and crashes on boot"
# A top-level throw compiles cleanly and dies while the module is being loaded, before the listener
# ever runs: exactly the failure that used to leave the box with no server at all.
CRASH_SHA="$(publish "e2e: compiles fine, dies at boot" 'throw new Error("e2e boot crash");')" \
  || fatal "could not publish the boot-crash commit to the fake origin"
: > "$STUB_LOG"
set +e
ROLL_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
ROLL_RC=$?
set -e
printf '%s\n' "$ROLL_OUT" | sed 's/^/    | /'
check_rc "a build that will not serve exits 4" 4 "$ROLL_RC"
check_out "and reports rolled-back" "RESULT: rolled-back" "$ROLL_OUT"
# Back to where the CLONE was, which is not the same thing as "one commit back": stage 3a left this
# clone at $NEXT_SHA, so the revert and the crash commit both arrive in this one update, and the only
# build there is to return to is the one that was on disk.
check "the tree went back to the sha this clone was on" test "$(git -C "$CLONE" rev-parse HEAD)" = "$NEXT_SHA"
check "dist/ was re-stamped from the sha it went back to" test "$(dist_sha)" = "$NEXT_SHA"
check "the bad sha is not what dist was stamped from" absent "$CLONE/dist/version.json" "$CRASH_SHA"
expect_sha "the OLD build is serving again — the box is not left down" "$NEXT_SHA"
check "the receipt for the failed build was withdrawn" test ! -f "$STATE/update-receipt.json"
check "node_modules survived the rollback" test -d "$CLONE/node_modules/typescript"
# The refresh runs only AFTER a verified restart. Before that fix a rollback left the engine loading
# the NEW plugin against code that had just been undone, and neither summary mentioned it.
check "the engine still has its plugin" test -f "$HERMES/plugins/irises-bridge/plugin.yaml"
check "the plugin was NOT refreshed for code that was undone" absent "$STUB_LOG" "plugins enable irises-bridge"

# ── 3b. forward again ─────────────────────────────────────────────────────────
step "3b/9  recovery — the box moves forward again after a rollback"
RECOVER_SHA="$(unpublish "$CRASH_SHA")" \
  || fatal "could not revert the boot-crash commit upstream"
: > "$STUB_LOG"
set +e
RECOVER_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
RECOVER_RC=$?
set -e
printf '%s\n' "$RECOVER_OUT" | sed 's/^/    | /'
check_rc "the next update succeeds" 0 "$RECOVER_RC"
check_out "and reports ok" "RESULT: ok" "$RECOVER_OUT"
expect_sha "the LIVE sha is the recovered one" "$RECOVER_SHA"
check "NOW the plugin is refreshed" present "$STUB_LOG" "hermes plugins enable irises-bridge"
check "and the gateway is bounced" grep -qE "hermes gateway re?start" "$STUB_LOG"

# ── 3c. the engine's gateway never comes back ────────────────────────────────
# Irises IS updated and live; it is the ENGINE that cannot be verified. That is exit 5, not a
# rollback: undoing a perfectly good update because someone else's service is down would be worse
# than saying so. This stage sits out the library's 90s budget once, on purpose.
step "3c/9  exit 5 — Irises updates, the engine's gateway cannot be verified"
GW_SHA="$(publish "e2e: another harmless upstream change" "// e2e: another harmless upstream change")" \
  || fatal "could not publish the last update commit to the fake origin"
engine_stub_stop
: > "$STUB_LOG"
set +e
GW_OUT="$(cd "$CLONE" && bash scripts/update.sh --yes 2>&1)"
GW_RC=$?
set -e
printf '%s\n' "$GW_OUT" | sed 's/^/    | /'
check_rc "an unverifiable gateway exits 5" 5 "$GW_RC"
check_out "and reports gateway-failed" "RESULT: gateway-failed" "$GW_OUT"
check_out "the summary says the bounce was not verified" "NOT verified" "$GW_OUT"
expect_sha "Irises itself IS updated and live" "$GW_SHA"
check "the tree is at the new sha" test "$(git -C "$CLONE" rev-parse HEAD)" = "$GW_SHA"
check_no_out "nothing was rolled back" "RESULT: rolled-back" "$GW_OUT"
check "the bounce was attempted through the engine CLI" grep -qE "hermes gateway re?start" "$STUB_LOG"
check "and the service-manager probe was blind, as the sandbox intends" present "$STUB_LOG" "STUB-"
engine_stub_start

# ── 4. uninstall ──────────────────────────────────────────────────────────────
step "4/9  uninstall — data kept"
: > "$STUB_LOG"
printf 'sandbox\n' > "$STATE/memories-canary.txt"
set +e
UNINSTALL_OUT="$(cd "$CLONE" && bash scripts/engine-setup.sh --uninstall --yes 2>&1)"
UNINSTALL_RC=$?
set -e
printf '%s\n' "$UNINSTALL_OUT" | sed 's/^/    | /'
check_rc "uninstall succeeded" 0 "$UNINSTALL_RC"
check_out "uninstall reports ok" "RESULT: ok" "$UNINSTALL_OUT"
if curl -fsS -m 3 "http://127.0.0.1:$SRV_PORT/health" >/dev/null 2>&1; then
  bad "the server is STILL answering on :$SRV_PORT"
else
  ok "the server stopped"
fi
check "the plugin dir is gone" test ! -d "$HERMES/plugins/irises-bridge"
check "the plugin was disabled through the engine CLI" present "$STUB_LOG" "hermes plugins disable irises-bridge"
check "the gateway was bounced so the engine forgets it" grep -qE "hermes gateway re?start" "$STUB_LOG"
check "IRISES_PUSH_TOKEN was stripped from the engine" absent "$HERMES/.env" '^IRISES_PUSH_TOKEN='
check "IRISES_FRONT was stripped too" absent "$HERMES/.env" '^IRISES_FRONT='
check "no orphaned Irises marker comment was left" absent "$HERMES/.env" 'added by Irises setup'
check "the engine's OWN key survived" present "$HERMES/.env" '^ANTHROPIC_API_KEY=engine-owned-key'
check "the pre-existing API_SERVER_KEY survived" present "$HERMES/.env" 'pre-existing-engine-key'
check "the pidfile is gone" test ! -f "$STATE/irises.pid"
check "the data directory is KEPT" test -d "$STATE"
check "and so is what was in it" test -f "$STATE/memories-canary.txt"
check_out "the exact rm was printed rather than run" "rm -rf $STATE" "$UNINSTALL_OUT"
check_out "the clone is explicitly not deleted" "NOT deleted" "$UNINSTALL_OUT"
check "the clone is in fact still there" test -d "$CLONE/.git"

# ── 5. the same uninstall again ───────────────────────────────────────────────
# The second one in a row used to take a fresh backup of an already-clean .env and bounce the engine
# for it, because "the manifest lists keys" was being read as "something changed".
step "5/9  uninstall again — nothing changed, so nothing is done"
BAKS_BEFORE="$(backups)"
: > "$STUB_LOG"
set +e
AGAIN_OUT="$(cd "$CLONE" && bash scripts/engine-setup.sh --uninstall --yes 2>&1)"
AGAIN_RC=$?
set -e
printf '%s\n' "$AGAIN_OUT" | sed 's/^/    | /'
check_rc "a repeat uninstall succeeds" 0 "$AGAIN_RC"
check_out "and reports ok" "RESULT: ok" "$AGAIN_OUT"
if [ "$(backups)" = "$BAKS_BEFORE" ]; then
  ok "no fresh backup of an already-clean engine .env"
else
  bad "a repeat uninstall backed the engine .env up again"
fi
check "the engine's gateway was NOT bounced for nothing" absent "$STUB_LOG" "gateway"
check_out "and the summary says so" "not bounced (nothing changed)" "$AGAIN_OUT"
check "the data directory is still KEPT" test -f "$STATE/memories-canary.txt"

engine_stub_stop

step "result"
printf '  %s passed, %s failed  (%ss wall)\n\n' "$PASS" "$FAIL" "$(( $(date +%s) - STARTED ))"
if [ "$FAIL" != "0" ]; then
  printf 'RESULT: failed\n'
  exit 1
fi
printf 'RESULT: ok\n'
exit 0
