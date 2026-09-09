# Photon tapped-reply context — Hermes patch series

Tap **Reply** on an older iMessage bubble and Apple sends the linkage (`replyTargetGuid`,
`threadOriginatorGuid`) all the way down to the Hermes Photon plugin's Node sidecar, which
throws it away — so Irises answers as if the text were about the *latest* message. Irises's
own side has been ready the whole time: the bridge contract already carries `reply_to_id` /
`reply_to_text`, and `src/state/replyResolution.ts` + the `tapped_reply` prompt section
already do the right thing when they arrive. This bundle is the fix one hop below anything
Irises owns: six commits against a Hermes Agent checkout (upstream `91e550b0`), plus an
idempotent `apply.sh` so a re-provisioned Hermes box gets the behavior back. **No Irises code
changes** — the bundle is stored here only because Irises is what depends on it.

## Where the linkage was lost

| Hop | Before | With this bundle |
| --- | --- | --- |
| Photon gRPC client — `@photon-ai/advanced-imessage@0.12.0` `mapMessage(proto)` | carries `replyTargetGuid`, `threadOriginatorGuid`, `threadOriginatorPart` | unchanged |
| Spectrum imessage provider — `@spectrum-ts/imessage@8.0.0` `buildMessageBase(...)` | **dropped it** — builds `{direction, sender, space, timestamp}` only | adds `replyTo` (**patched anchor 1**) |
| Spectrum core `messageSchema` | zod strips keys it does not declare, so `replyTo` died in `extractExtras` | declares `replyTo` (**patched anchor 2**) |
| sidecar `index.mjs` `normalizeEvent()` | no reply key on the event | emits `replyTo {id, threadRootId, part, direction, text, src}` |
| `adapter.py` `_dispatch_inbound()` | `reply_to_*` set on the *reaction* path only | sets `reply_to_message_id` / `reply_to_text` / `reply_to_is_own_message` |
| `~/.hermes/plugins/irises-bridge/__init__.py` `on_inbound` | already reads those fields | unchanged |
| Irises `src/channels/bridge/contract.ts` → `resolveTappedReply` → `tapped_reply` | already implemented, tested | unchanged |

Both patched anchors live under `node_modules`, which is not in git. That is why `apply.sh`
runs the dist patch script as a second step and not just `git apply`.

## Contents

- `0001-photon-inbound-reply-context.patch` — the six-commit series (`git format-patch`, base
  `91e550b0`, the same commits as the VPS branch `irises/photon-reply-context`), touching
  `adapter.py`, `sidecar/index.mjs`, the new `sidecar/reply-context.mjs` and
  `sidecar/patch-spectrum-reply-target.mjs`, `sidecar/package.json` and three test modules.
- `apply.sh` — run it **on the Hermes host**.

## Apply

```sh
./apply.sh --check                 # dry run: reports what it would do, changes nothing
./apply.sh                         # apply
./apply.sh /some/other/checkout    # or set HERMES_AGENT_DIR; default ~/.hermes/hermes-agent
~/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway restart
```

It refuses anything that is not the root of a git checkout. It is idempotent: on a second run
the reverse check succeeds, it reports `already applied`, leaves the tree alone, and still
re-runs the dist patch — `npm ci` wipes `node_modules` while leaving the git tree patched, so
those two states drift apart. It resolves `node` from `PATH`, else `~/.local/bin/node`, else
`~/.hermes/node/bin/node`. It never runs npm, pip or `git commit`, and it never restarts the
gateway — it prints the restart command for you.

The patch series is applied to the working tree (with `--3way`, which also stages it). Nothing
is committed; on the production box the same commits live on the branch
`irises/photon-reply-context`.

## Verify

```sh
grep 'inbound reply -> target' ~/.hermes/logs/gateway.log
# [photon-sidecar] photon-sidecar: inbound reply -> target spc-msg-… dir=outbound text=y src=cache raw={…}
```

`src` says how the target was resolved: `12x` (already hydrated by a ≥12.x provider), `cache`
(inbound/outbound LRU), `fetch` (one `space.getMessage`), `none`. No line at all means the
linkage never arrived — check the dist patch first; run by hand it prints
`ok (already patched)` when it is in place.

On the Irises side the trace event `turn:reply` says how it resolved: `assistant` (replied to
an Irises bubble), `own-thread` (their own earlier message), `quoted` (older than the local
index — hydrated text, authorship unknown), `unresolved`. A plain message emits no
`tapped_reply` section at all.

The series ships its own tests:

```sh
~/.hermes/hermes-agent/venv/bin/python -m pytest \
  tests/plugins/platforms/photon/test_reply_context.py \
  tests/plugins/platforms/photon/test_spectrum_reply_patch.py \
  tests/plugins/platforms/photon/test_inbound.py
```

## `PHOTON_REPLY_HYDRATE_MS`

Set it in `~/.hermes/.env`. Budget in milliseconds for the single `space.getMessage` the
sidecar makes when the reply target is in neither LRU; default **1500**, `0` disables the
fetch entirely. The id is forwarded regardless — disabling only costs the quoted *text* on a
cache miss, and Irises still resolves the id against its own index. The call is raced against
the budget and never throws, so inbound delivery cannot stall behind it.

## Remove

```sh
cd ~/.hermes/hermes-agent
git apply -R <this-dir>/0001-photon-inbound-reply-context.patch
git clean -nd plugins/platforms/photon tests/plugins/platforms/photon   # inspect, then -fd
cd plugins/platforms/photon/sidecar && npm ci                           # restores the dist
```

`git apply -R` reverses the tracked edits but leaves behind the two added files that a later
commit in the series also touches (`sidecar/patch-spectrum-reply-target.mjs` and
`tests/.../test_spectrum_reply_patch.py`); `git clean` on those two paths removes them and
does not touch `node_modules` (gitignored). The `npm ci` restores a pristine spectrum-ts dist,
and with the series gone `postinstall` is back to the mixed-attachments patch alone, so the
reply-target rewrite is not re-applied. Restart the gateway.

## When upgrading Hermes or spectrum-ts

Re-run `apply.sh` after any Hermes pull and after any `npm ci` in the sidecar. If the checkout
has moved off `91e550b0` the script falls back to a three-way merge and says so.

The design is upgrade-proof in both directions. The dist patch script stands down on its own
once upstream maps the linkage — it looks for `replyTargetGuid(` / `const replyTargetGuid` in
the dist and prints `skipped (upstream maps replyTargetGuid)` — and the sidecar already
understands the ≥12.x `reply` content shape (`content.type === "reply"`, taking
`content.target` as the pre-hydrated target and unwrapping the inner content), so the sidecar
and adapter plumbing survives a spectrum-ts major. Idempotency is tracked per anchor, not by a
single marker, so a dist patched by an earlier release still gets the schema rewrite. An
anchor that has *drifted*, though, is fatal by design: the script throws rather than silently
shipping a sidecar that drops every reply target. Re-derive it — do not skip it.
