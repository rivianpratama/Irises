#!/usr/bin/env bash
#
# Apply the Photon inbound-reply-context patch series to a Hermes Agent checkout.
# Run this ON the Hermes host (the box that runs the gateway), not on the Irises host.
#
#   ./apply.sh [--check] [HERMES_CHECKOUT]
#
#   HERMES_CHECKOUT   defaults to $HERMES_AGENT_DIR, else ~/.hermes/hermes-agent
#   --check           dry run: report what would happen, change nothing
#
# Idempotent: a second run detects the series is already in the tree, says so, and
# still re-runs the (also idempotent) spectrum-ts dist patch, because `npm ci` wipes
# node_modules while leaving the git tree patched.
#
# What it will NOT do, by design: npm/pip installs, `git commit`, or restarting the
# gateway. It prints the restart command instead. Everything it changes is either a
# working-tree edit inside the checkout or the already-installed spectrum-ts dist.
set -euo pipefail

SELF=apply.sh
BUNDLE_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PATCH_FILE=$BUNDLE_DIR/0001-photon-inbound-reply-context.patch
DIST_PATCH_REL=plugins/platforms/photon/sidecar/patch-spectrum-reply-target.mjs
PHOTON_REL=plugins/platforms/photon

say() { printf '%s: %s\n' "$SELF" "$*"; }
die() { printf '%s: error: %s\n' "$SELF" "$*" >&2; exit 1; }

usage() {
	cat <<'EOF'
Apply the Photon inbound-reply-context patch series to a Hermes Agent checkout.
Run this ON the Hermes host.

  ./apply.sh [--check] [HERMES_CHECKOUT]

  HERMES_CHECKOUT   defaults to $HERMES_AGENT_DIR, else ~/.hermes/hermes-agent
  --check, -n       dry run: report what would happen, change nothing
  --help, -h        this text

Idempotent. Never runs npm, pip or git commit, and never restarts the gateway —
it prints the restart command instead.
EOF
}

CHECK=0
TARGET=

while [ "$#" -gt 0 ]; do
	case "$1" in
		--check|-n)
			CHECK=1
			;;
		-h|--help)
			usage
			exit 0
			;;
		--)
			shift
			if [ "$#" -gt 0 ]; then
				TARGET=$1
				shift
			fi
			break
			;;
		-*)
			die "unknown option: $1 (try --help)"
			;;
		*)
			if [ -n "$TARGET" ]; then
				die "expected at most one checkout path, got a second: $1"
			fi
			TARGET=$1
			;;
	esac
	shift
done

if [ "$#" -gt 0 ]; then
	die "unexpected extra arguments: $*"
fi

if [ -z "$TARGET" ]; then
	TARGET=${HERMES_AGENT_DIR:-$HOME/.hermes/hermes-agent}
fi

# ---------------------------------------------------------------- preflight --

[ -f "$PATCH_FILE" ] || die "patch series missing: $PATCH_FILE"
[ -s "$PATCH_FILE" ] || die "patch series is empty: $PATCH_FILE"

command -v git >/dev/null 2>&1 || die "git not found on PATH"

[ -d "$TARGET" ] || die "not a directory: $TARGET (pass the Hermes checkout, or set HERMES_AGENT_DIR)"
TARGET=$(CDPATH='' cd -- "$TARGET" && pwd)

if ! git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
	die "$TARGET is not a git checkout. This bundle is applied with 'git apply', so the
       Hermes agent must be a clone (it normally is: git clone of NousResearch/hermes-agent).
       Refusing to touch a non-git directory."
fi

# `git apply` resolves paths against the toplevel, so refuse a subdirectory of the
# checkout as loudly as a wrong directory: the paths would silently not line up.
TOPLEVEL=$(git -C "$TARGET" rev-parse --show-toplevel)
if [ "$TOPLEVEL" != "$TARGET" ]; then
	die "$TARGET is inside a git checkout rooted at $TOPLEVEL. Pass the root."
fi

if [ ! -d "$TARGET/$PHOTON_REL" ]; then
	die "$TARGET has no $PHOTON_REL — this does not look like a Hermes Agent checkout"
fi

say "checkout: $TARGET"
say "series:   $PATCH_FILE"
if [ "$CHECK" -eq 1 ]; then
	say "mode:     --check (dry run, nothing is written)"
fi

ERRLOG=$(mktemp "${TMPDIR:-/tmp}/photon-reply-apply.XXXXXX")
cleanup() { rm -f "$ERRLOG"; }
trap cleanup EXIT INT TERM

# ------------------------------------------------------------- the series --
#
# Order matters. A forward --3way check SUCCEEDS on an already-patched tree (the
# three-way merge is a clean no-op), so the reverse probe has to come before the
# 3-way fallback or a re-run would look like fresh work.

STATE=
if git -C "$TARGET" apply --check "$PATCH_FILE" >"$ERRLOG" 2>&1; then
	STATE=apply
elif git -C "$TARGET" apply --check --reverse "$PATCH_FILE" >/dev/null 2>&1; then
	STATE=already
elif git -C "$TARGET" apply --check --3way "$PATCH_FILE" >"$ERRLOG" 2>&1; then
	STATE=apply3
else
	printf '%s: error: the series does not apply to %s\n' "$SELF" "$TARGET" >&2
	printf '%s: error: it is neither applicable nor already applied — the checkout has\n' "$SELF" >&2
	printf '%s: error: drifted from upstream 91e550b0, or is half-patched. git says:\n' "$SELF" >&2
	sed 's/^/    /' "$ERRLOG" >&2
	exit 1
fi

case "$STATE" in
	already)
		say "series: already applied (reverse check succeeds) — leaving the tree alone"
		;;
	apply|apply3)
		if [ "$STATE" = apply3 ]; then
			say "series: applies with a three-way merge (the checkout is not exactly at 91e550b0)"
		else
			say "series: applies cleanly"
		fi
		if [ "$CHECK" -eq 1 ]; then
			say "would run: git -C $TARGET apply --3way $PATCH_FILE"
		else
			if ! git -C "$TARGET" apply --3way "$PATCH_FILE" >"$ERRLOG" 2>&1; then
				printf '%s: error: git apply --3way failed after its own --check passed.\n' "$SELF" >&2
				printf '%s: error: the working tree may hold conflict markers; inspect with\n' "$SELF" >&2
				printf '%s: error: "git -C %s status" before re-running. git says:\n' "$SELF" "$TARGET" >&2
				sed 's/^/    /' "$ERRLOG" >&2
				exit 1
			fi
			say "series: applied (working tree and index — nothing is committed)"
		fi
		;;
esac

# ------------------------------------------------------------ the dist patch --
#
# The series ships the patch script; the spectrum-ts dist under node_modules is not
# in git, so it has to be rewritten separately. The script is idempotent and prints
# patched / ok (already patched) / skipped (upstream maps replyTargetGuid).

NODE=
if command -v node >/dev/null 2>&1; then
	NODE=$(command -v node)
else
	for candidate in "$HOME/.local/bin/node" "$HOME/.hermes/node/bin/node"; do
		if [ -x "$candidate" ]; then
			NODE=$candidate
			break
		fi
	done
fi

if [ -z "$NODE" ]; then
	die "no node found (PATH, ~/.local/bin/node, ~/.hermes/node/bin/node).
       The sidecar needs node >=18.17; install it or put it on PATH and re-run."
fi
say "node:     $NODE"

if [ "$CHECK" -eq 1 ]; then
	if [ -f "$TARGET/$DIST_PATCH_REL" ]; then
		say "would run: $NODE $TARGET/$DIST_PATCH_REL"
	else
		say "would run: $NODE $TARGET/$DIST_PATCH_REL (added by the series above)"
	fi
else
	[ -f "$TARGET/$DIST_PATCH_REL" ] || die "$DIST_PATCH_REL missing after applying the series"
	say "dist:     running the spectrum-ts reply-target patch"
	if ! "$NODE" "$TARGET/$DIST_PATCH_REL"; then
		die "the spectrum-ts reply-target patch failed (see its message above).
       If it could not find the dist, the sidecar's node_modules is not installed:
       run 'npm ci' in $PHOTON_REL/sidecar yourself — apply.sh never runs npm."
	fi
fi

# ------------------------------------------------------------------- finish --

say "done."
if [ "$CHECK" -eq 1 ]; then
	say "dry run: nothing was written. Re-run without --check to apply."
fi
say "restart the gateway yourself (apply.sh does not):"
printf '\n    %s/venv/bin/python -m hermes_cli.main gateway restart\n\n' "$TARGET"
say "then verify: grep 'inbound reply -> target' ~/.hermes/logs/gateway.log"
