#!/usr/bin/env bash
# Start/stop an ISOLATED Irises for latency benchmarks: the worktree's own build, its own port and
# its own empty IRISES_HOME, with the channel bridge pointed at a dead port so nothing it does can
# reach Telegram. The launchd instance on :3000 is never touched.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOME_DIR="${BENCH_HOME:-/private/tmp/claude-501/-Users-rivianpratama-Documents-GitHub-Irises/8a23a752-36d2-4665-8445-2670d39f9ce3/scratchpad/bench-home}"
PORT="${BENCH_PORT:-3100}"
PIDFILE="$HOME_DIR/bench.pid"
[ "$PORT" = 3000 ] && { echo refuse; exit 2; }
# CONVO_EFFORT passthrough: a phase round wants to run the SAME probes at a different reasoning
# effort without editing .env, e.g. `CONVO_EFFORT=medium scripts/convergence/bench-instance.sh start`.
# Forwarded conditionally, as an array rather than always setting the key: an unconditional
# `CONVO_EFFORT="$CONVO_EFFORT"` would hand the node process an EMPTY string whenever the caller left
# it unset, and src/loadEnv.ts's baseline layer (deploy/app.env, loaded without `override`) only fills
# in CONVO_EFFORT=high when the key is entirely ABSENT from process.env — present-but-empty already
# counts as "already set" and would silently blank out the default instead of leaving it alone.
CONV_ENV=()
[ -n "${CONVO_EFFORT:-}" ] && CONV_ENV=(CONVO_EFFORT="$CONVO_EFFORT")
case "${1:-}" in
  start)
    mkdir -p "$HOME_DIR"
    (cd "$ROOT" && npm run build >/dev/null)
    (cd "$ROOT" && env PORT="$PORT" IRISES_HOME="$HOME_DIR" HERMES_BRIDGE_URL="http://127.0.0.1:9" \
      "${CONV_ENV[@]}" \
      nohup node dist/index.js >"$HOME_DIR/server.log" 2>&1 & echo $! >"$PIDFILE")
    for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && { echo "up on :$PORT"; exit 0; }; sleep 1; done
    echo "bench instance failed to come up; see $HOME_DIR/server.log" >&2; exit 1 ;;
  stop)
    [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; echo stopped ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
