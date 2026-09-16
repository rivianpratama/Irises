# Configure Irises: a fourth lifecycle verb (change what the install set, without re-installing)

## Context

**Answer to the question:** no. The terminal lifecycle today is `scripts/irises.sh` (menu: Install or repair /
Update / Uninstall / Status / Advanced) composing flags for two scripts, `scripts/engine-setup.sh`
(install / `--uninstall` / `--detach-engine`) and `scripts/update.sh` (update / `--rollback-to`). There is no
configure / reconfigure / settings verb anywhere: no menu entry, no flag, no function, no doc section
(grepped scripts/, docs/, README.md, skills/). The only ways to change an install-time choice afterwards:

1. **Re-run "Install or repair"**: walks all 7 wizard steps again, runs `npm ci && npm run build`, restarts,
   refreshes the plugin, bounces the engine gateway (minutes on a small box), and STILL cannot change some things:
   - `IRISES_FRONT` (which chats Irises fronts) lives in the ENGINE's `.env` and "the file wins" on a re-install
     (`front_says_kept`, engine-setup.sh:299-307; the preview skips it at :400-401). The installer says "edit it by hand".
   - A model override cannot be undone: choosing "Inherit" on a re-run leaves `ENGINE_MODEL_INHERIT=off` and the
     `CONVO/CLASSIFY/FALLFIRM_*` keys in place (`model_override_write` only ever adds, :324-356). Because `.env`
     loads last with `override:true` (src/loadEnv.ts:40), a leftover line beats engine discovery, so "back to
     inheriting" must REMOVE those lines.
   - `IRISES_TZ` cannot be returned to "host zone"; `WEB_ENABLED`/`DASHBOARD_PASSWORD` can only be set.
2. **Hand-edit `.env` and restart**: the README "Configuration" section is the only documentation of changing
   settings, and it is manual; nothing verifies the restart took. `.env` is parsed once at boot; every change
   needs an Irises restart (no reload path exists).

**What the install sets** (three destinations; there is no `~/.irises/.env`):

| Setting | Where it lands | Install flag / env | Needs after a change |
|---|---|---|---|
| Port | clone `.env` `PORT`; engine `.env` `IRISES_URL`; manifest `port` | `--port N` | Irises restart + gateway bounce |
| Service yes/no | systemd unit / LaunchAgent / schtasks task | `--service` / `--no-service` | install or remove the unit |
| Chat front scope | engine `.env` `IRISES_FRONT` (hermes; OpenClaw is print-only) | `--front P` / `--no-bridge` | gateway bounce |
| Voice model | clone `.env` `{CONVO,CLASSIFY,FALLFIRM}_MODEL[_OPENROUTER\|_OPENAI]`, `*_PROVIDER`, `ENGINE_MODEL_INHERIT=off`, `OPENAI_BASE_URL`, `<LANE>_API_KEY` | `--model-lane/--model-slug/--model-base-url` + env `IRISES_MODEL_API_KEY` | Irises restart |
| Browser chat | clone `.env` `WEB_ENABLED` | `--web on\|off` | Irises restart |
| Timezone | clone `.env` `IRISES_TZ` | `--tz ZONE` | Irises restart |
| Dashboard password | clone `.env` `DASHBOARD_PASSWORD` | env `IRISES_DASHBOARD_PASSWORD` | Irises restart |

The service unit embeds `WorkingDirectory`, `PATH`, `IRISES_HOME`, `NODE_OPTIONS` and NOT the port
(irises-lib.sh `service_install` :1077-1175), so a port change needs no unit rewrite; `IRISES_HOME` cannot be
changed through `.env` alone. `deploy/app.env` is git-tracked (a dirty tree blocks `update.sh`): never write it.
House convention for secrets: name only, never a masked value (`<set>` / `not shown`).

**Second request (the standing rule):** every future feature that adds an install-time setting must land in BOTH
the install wizard and Configure. Enforced by a contract test, on the precedent of `scripts/flagDocs.test.ts`
(runtime flags documented with their parser default) and `scripts/shellContract.test.ts`.

**User decision (this session):** scope = typed install-time settings PLUS a generic "any documented `.env` key"
editor under Advanced.

## Design

### D1. New script `scripts/configure.sh` (fourth lifecycle verb; not a mode of engine-setup.sh)
Same skeleton as `update.sh`: `set -euo pipefail`; sources the lib via the dirname-of-$0 form; `IRISES_LOG_TAG="irises-configure"`;
header comment (usage, flags, exit codes, RESULT tokens, generic-editor rules); flags → up-front validation (exit 2, no
RESULT line) → `--yes` plus no-TTY auto-yes (engine-setup.sh:230-237) → `IRISES_ASSUME_YES` → `ROOT`/`ENV_FILE`/`cd`/
`augment_path` → `trap 'lifecycle_exit_guard $?' EXIT` (+INT 130 / TERM 143 as update.sh:586-587) → plan → preview →
confirm → `lock_acquire` → backup → write → restart/verify → gateway → `summary TOKEN …`.
Exit codes: 0 ok/noop · 1 step failed or refused · 2 usage · 4 restarted but /health did not report the built sha ·
5 engine gateway not verified. RESULT: `ok | noop | health-failed | gateway-failed | partial`.

### D2. Flags (same spelling as engine-setup.sh where they overlap)
- `--show`: read-only report, one line per setting `label: value (source)`: port; service kind + installed + running;
  front scope (hermes + manifest `bridge=1` + `engineEnvApplied=true` → `IRISES_FRONT` from `engineEnvFile`, empty → "nothing", absent → "not set"; else `n/a`);
  voice model (`inherited` | slug on lane per role); web; tz or `host zone`; dashboard password `<set>` | `shipped default`;
  lane keys `<set>`/`<unset>` by name; build sha; manifest path or none. No lock, no restart; ends with `summary ok "report only"` so wrappers get a RESULT line.
  Must print (with empty fields) on a never-installed clone (`manifest_read`/`env_get` return empty on missing files).
- `--port N` · `--service on|off` · `--front PATTERNS|none` (`none` → `IRISES_FRONT=` empty = front nothing) ·
  `--model-lane L --model-slug S [--model-base-url U]` + env `IRISES_MODEL_API_KEY` (all-or-nothing validation copied from engine-setup.sh:185-206) ·
  `--model-inherit` (remove the 13 override keys: `{CONVO,CLASSIFY,FALLFIRM}_MODEL`, `_MODEL_OPENROUTER`, `_MODEL_OPENAI`, `_PROVIDER`, `ENGINE_MODEL_INHERIT`; KEEP lane keys and `OPENAI_BASE_URL`, said by name) ·
  `--web on|off` · `--tz ZONE|host` (`host` → unset `IRISES_TZ`) · dashboard password via env `IRISES_DASHBOARD_PASSWORD` only (presence = set, as install) ·
  `--set KEY=VALUE` (repeatable) · `--set KEY` (value from env `IRISES_SET_VALUE`, at most one per run) · `--unset KEY` (repeatable) · `--allow-unknown` ·
  `--yes` · `--no-restart` · `--no-gateway-restart` · `-h|--help`.
- Usage errors (exit 2): no setting flag, no `--show`, no `IRISES_DASHBOARD_PASSWORD` → "nothing to configure; try --show"; `--show` with any setting flag; `--model-inherit` with any `--model-*`.
  `IRISES_MODEL_API_KEY` present without `--model-lane` → warn and ignore (matches install; NOT an error).
- Generic editor rules: KEY matches `^[A-Z][A-Z0-9_]*$`. `is_secret_key` (ends `_KEY|_TOKEN|_PASSWORD|_SECRET`, or `API_SERVER_KEY`) may NOT carry a value on argv → exit 2 pointing at `--set KEY` + `IRISES_SET_VALUE`.
  Reserved (exit 2 with reason + pointer): `PORT`→`--port`; `IRISES_FRONT`→`--front`; `OPS_BACKEND`/`HERMES_API_KEY`/`OPENCLAW_TOKEN`/`ENGINE_PUSH_TOKEN`→"engine wiring, re-run the install"; `IRISES_HOME`→"the service unit embeds it".
  `documented_key KEY` = `grep -qE "^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?KEY=" .env.example deploy/app.env` (a word match would accept engine-side keys); resolve the two files from `$ROOT`, falling back to the script's own clone (test sandboxes set `IRISES_ROOT` to a dir with only `.env`). Undocumented → exit 2 naming `--allow-unknown`. Known prose-only gaps to list in `--help`: `*_MODEL_OPENAI`, `ANTHROPIC_BASE_URL`.
  `DATA_BACKEND`, `EMBEDDINGS_DIMENSIONS` → one-line warn (data-affecting). Secret values never printed anywhere (`<set>`).

### D3. Apply semantics
Plan = parallel indexed arrays `P_FILE[] P_OP[] P_KEY[] P_VAL[]` (bash 3.2: append with `arr[${#arr[@]}]=x`, no `+=`).
Preview one line per real change: `+ KEY=val` (absent), `~ KEY=new (was old)` (differs or duplicated; secrets shown as `<set>`/`not shown`), `- KEY` (unset present); unchanged entries skipped.
Zero lines → `summary noop "nothing to change"`, exit 0, before lock/backup. Then `ask_yn "Apply?" y` unless `--yes` → declined → `summary noop`.
Apply: `lock_acquire || exit 1`; `env_backup "$ENV_FILE" configure` once before the first clone write; `env_backup ENGINE_FILE configure` before the first engine write; `chmod 600 "$ENV_FILE"` after.
- **Port:** preflight `tcp_open 127.0.0.1 NEW` → `err` + exit 1 before any write (guard prints `RESULT: partial`, the update.sh:571-579 precedent). Same as current → no entry. Plan clone `PORT`; if manifest `engineEnvApplied=true` and engine `IRISES_URL` is `http://127.0.0.1:OLD` (or `localhost:OLD`) → plan engine `IRISES_URL=http://127.0.0.1:NEW` (else warn "not ours to move"); if `IRISES_URL` is in `keysPreExisting` but not `keysRetargeted`, add it to `keysRetargeted`. `manifest_update port=NEW` (no manifest → say and continue). Verify on the NEW port; gateway bounce only if the engine file changed.
- **Service on:** `kind=$(service_kind)`; `none` → exit 1; already installed → noop. Else `server_stop 20` if `server_pid`, `unit=$(service_install "$ROOT" "$(command -v node)") || exit 1`, `service_restart || exit 1`, `manifest_update serviceKind=KIND serviceUnit=UNIT`, verify with `wait_health_sha` (not the restart routine, which would cycle twice). **Service off:** not installed → noop. Else `pid=$(server_pid)` FIRST, `service_uninstall` (stops before removing on all three backends, lib :1361-1380; launchd `bootout` can return before the port frees), then `[ -n "$pid" ] && server_stop_pid "$pid" 20`, `server_start_detached "$ROOT" || exit 1`, `manifest_update serviceKind=none serviceUnit=`, `wait_health_sha`. Windows arm stub-tested only; say so in the header.
- **Front:** `engine=$(engine_kind)`; `off` → exit 1 "no engine, nothing fronts"; `openclaw` → print the `IRISES_FRONT=…` line for the gateway process (engine-setup.sh:972-975 style), `summary ok "front: printed, not applied"`, no restart/gateway; `hermes` → require manifest `bridge=1` (else exit 1 "install with the bridge first") and `engineEnvApplied=true` (else exit 1 "the engine .env carries nothing of ours"); plan engine `IRISES_FRONT=PATTERN` (`front_pattern_valid` unless `none`); apply → `manifest_update frontPattern=…` → `gateway_restart hermes 90` unless `--no-gateway-restart` → fail → `RESULT: gateway-failed` exit 5. No Irises restart.
- **Model override:** the shared lib `model_override_write "$ENV_FILE" LANE SLUG URL` (moved from engine-setup.sh). **Model inherit:** `env_unset` the 13 keys; say which lane keys / `OPENAI_BASE_URL` are kept, by name.
- **Web / tz / dashboard / generic:** `env_set` / `env_unset`.
- **Restart** (any clone-.env change): `--no-restart` → say so; no service AND no `server_pid` → "Irises is not running, takes effect at her next start" (no failure); else `sha=$(built_sha "$ROOT")` (empty → warn, liveness-only) and `irises_restart_verify "$ROOT" "$(irises_port)" "$sha" 60` → failure → `summary health-failed` exit 4.
- `summary ok` lines: `changed: …` (key names; secrets by name), `backup: …`, `Irises: restarted, build X live | skipped (--no-restart) | not running`, `gateway: bounced and verified | n/a | skipped`.
- Stdin discipline: the menu's child shares the menu's pipe; under auto-yes nothing may `read` stdin and external commands get `</dev/null`, or the menu's next answer is eaten.

### D4. Menu (`scripts/irises.sh`)
Top menu becomes `1) Install or repair · 2) Configure Irises · 3) Update · 4) Uninstall · 5) Status · 6) Advanced · q`. Renumber the section markers (`# ── N) name ──`), dispatch, the `warn "1, 2, …"` line, the header comment (four scripts; second exception to the double-prompt rule: configure's diff preview runs in the child, so NO `--yes` is passed), `eof_quit` (adds `bash scripts/configure.sh --help`), and the quit line (mention `--show`).
`CONFIGURE_SH`/`CONFIGURE_NAME` beside the other two. `run_child`: add `IRISES_SET_VALUE=<set>` to the prefix (one line, irises.sh:123-124 shape).
New section `# ── 2) configure ──` with `menu_configure()`: runs `bash "$CONFIGURE_SH" --show` first (verbatim, the `--check` pattern at :488-493), then:
```
Configure Irises
  1) Port and service              4) Browser chat UI
  2) Which chats Irises fronts     5) Timezone
  3) The model her voice runs on   6) Dashboard password
  7) Set or unset any .env key (advanced)          b) Back   [default b]
```
Each entry reuses the wizard's helpers/validators (`ask_choice/ask_text/ask_secret/ask_yn`, `port_valid/slug_valid/url_valid/front_pattern_valid`, `system_tz`), composes flags with `set --`, and calls `run_child "$CONFIGURE_SH" "$CONFIGURE_NAME" "$@"` WITHOUT `--yes`; secrets via env (`IRISES_MODEL_API_KEY`, `IRISES_DASHBOARD_PASSWORD`, `IRISES_SET_VALUE`), unset right after; `next_steps`; return.
(1) `ask_text "Port" "$(irises_port)" port_valid` + `ask_yn "Run Irises as a service…?"` → `--port N --service on|off`. (2) `ask_choice` every / named / nothing / back → `--front '*:*'|PATTERNS|none`. (3) `ask_choice` "Go back to inheriting" / "Pick a model" / back → `--model-inherit` or lane + slug + `ask_secret` key + (openai) `url_valid` base URL. (4) `ask_yn` → `--web on|off`. (5) `ask_text "Your timezone (type host to follow this machine)" "$(system_tz)"` → `--tz`. (6) `ask_secret` → env; blank → "nothing to change". (7) set/unset/back; `ask_text "KEY" "" key_valid` (menu-local validator); secret-pattern → `ask_secret` + `IRISES_SET_VALUE` + `--set KEY`, else `ask_text "value"` → `--set KEY=VALUE`; unset → `--unset KEY`; if the child exits 2 naming `--allow-unknown`, `ask_yn "re-run with --allow-unknown?" n` and re-run.
`do_status` (:201-217): replace the manifest-derived front/model lines with the `--show` output; keep `health_line`.

### D5. Lib additions / moves (`scripts/lib/irises-lib.sh`)
- `env_unset FILE KEY…`: thin wrapper over `env_remove_irises_block` (the clone `.env` has no marker blocks, and on a marker-less file that function removes exactly the named assignments and prints the count). Comment says why the name exists.
- `is_secret_key KEY` (pattern above).
- `model_override_write FILE LANE SLUG BASE_URL` (moved verbatim from engine-setup.sh:324-356, key from env `IRISES_MODEL_API_KEY`, same messages); `model_lane_key LANE`; `model_override_keys [LANE]` (with a lane: the keys that lane writes + `ENGINE_MODEL_INHERIT` (+`OPENAI_BASE_URL` for openai); without: the 13 removable keys, never the lane keys or `OPENAI_BASE_URL`).
- `irises_restart_verify ROOT PORT EXPECTED_SHA SECS`: update.sh:277-322 lifted verbatim with `$ROOT/$PORT/$BASE/$STATE_DIR` parameterized; keep every message string (e2e greps `"] started — build"` / `"restarted — build"`).
- `manifest_update PATH KEY=VALUE…`: `IRISES_MANIFEST_KEYS="root irisesHome port engine engineEnvFile engineEnvBackup pluginDir serviceKind serviceUnit nodeBin keysAdded keysPreExisting keysRetargeted bridge frontPattern engineEnvApplied modelLane engineEnvPending"` (the 18 keys at engine-setup.sh:984-1002); read each via `manifest_read`, overlay the args (unknown key → err, return 1; missing file → return 1), `manifest_write` the full list via `set --`. (`detach_manifest_step` :1042-1084 may adopt it; optional.)

### D6. The standing rule as a test: `scripts/settingsContract.test.ts` (new, modeled on flagDocs.test.ts)
Table rows `{ name, installHelp[], configureHelp[], installMenu[], configureMenu[] }`: `--port`; service (`installHelp: ['--no-service']` since engine-setup's usage lists only that, `configureHelp: ['--service']`, `installMenu: ['--service','--no-service']`, `configureMenu: ['--service']`); `--front`; `--model-lane`; `--model-slug`; `--model-base-url`; `--web`; `--tz`; env-only `IRISES_MODEL_API_KEY`, `IRISES_DASHBOARD_PASSWORD`.
Asserts: (a) each literal in `bash scripts/engine-setup.sh --help`; (b) each in `bash scripts/configure.sh --help`; (c) each composed inside irises.sh's `install` AND `configure` sections (split the file on `/^# ── \d+\) (\w+)/m`, map name → body, order-independent); (d) reverse: slice engine-setup.sh's parser `while [ $# -gt 0 ]; do … esac`, extract every `--flag)` arm (split `|`, strip `=*`), and every arm must be a table row or in `NON_SETTING = ['--engine','--yes','-y','--bridge','--no-bridge','--engine-env','--uninstall','--detach-engine','--purge-data','--archive-data','--revert','-h','--help']`; and every table flag must be an arm. So a new installer setting without a table row fails, and a row without configure/menu support fails.
Plus one README sentence under Configuration stating the rule and naming the test.

## Implementation tasks (ordered; TDD; one coding subagent per task, Opus per memory `delegate-code-to-opus`)

Work on a worktree branch (e.g. `configure-verb`), commits authored as Rivian <rivianp@gmail.com>. First commit: copy this plan to `docs/superpowers/plans/2026-09-17-configure-verb.md` (repo convention, cf. `2026-09-10-terminal-lifecycle.md`).

**A. Lib** (`scripts/lib/irises-lib.sh`, tests in `scripts/lib/irises-lib.test.ts` via `runLib`)
- A1 `is_secret_key` + `env_unset`. Tests: removes every assignment of each key and nothing else (duplicates, operator blank lines, trailing blank; byte-exact + count); missing file → 0; secret-key positives/negatives (`PORT`, `KEYBOARD`, `TOKENIZER` negative).
- A2 `model_override_write` / `model_lane_key` / `model_override_keys`. Tests: openrouter + openai variants write the three roles, provider, lane key from env, `ENGINE_MODEL_INHERIT=off`; key value in the file, never on stdout/stderr; warn path when the env key is unset; `model_override_keys` keeps lane keys out.
- A3 `irises_restart_verify`. Tests (extend the `startHealthServer` harness, irises-lib.test.ts:99-136): service path with a stub `systemctl` that flips the served sha on `restart` → 0 + "restarted — build"; no service, no pid, port held → 1 "something took"; nothing listening, SECS=2 → 1 "no /health answer".
- A4 `manifest_update`. Tests: one field changed, 17 carried forward, `schema`/`writtenAt` present; unknown key and missing file refused.

**B. `scripts/configure.sh` + `scripts/configure.test.ts`** (mirrors engine-setup.test.ts: `run()`, `sandbox()` with `.env` `OPS_BACKEND=off PORT=3999`, `SKIP_ON_WINDOWS`)
- B1 skeleton, parser, validation, `--help` (`sed -n` of the header like update.sh:75). Tests: help documents every flag + exit table + RESULT tokens; unknown flag 2; `--set OPENAI_API_KEY=x` 2; `--set NOT_DOCUMENTED=1` 2 without `--allow-unknown`; `--set PORT=1` 2 points at `--port`; `--unset IRISES_HOME` 2; `--port abc` 2; `--model-slug x` without lane 2; `--set KEY` without `IRISES_SET_VALUE` 2; no flags 2 pointing at `--show`; `--show --tz UTC` 2.
- B2 `--show`. Tests: sandbox `.env` with `OPENROUTER_API_KEY=zzz-not-a-key IRISES_TZ=UTC` prints port/WEB_ENABLED/IRISES_TZ lines, `OPENROUTER_API_KEY: <set>`, never the value, exit 0; no `.env`, no manifest → still prints, exit 0.
- B3 plan/preview/apply for clone settings + restart. Tests: `--tz Europe/Paris --no-restart --yes` writes, leaves `.bak-irises-*`, `RESULT: ok`; same again → `noop`, no second backup; `--tz host` removes; `--web off --yes` with nothing running → "not running" + ok; `--model-inherit` on a stage-8-shaped `.env` removes the 13 keys, keeps `OPENROUTER_API_KEY`; `--set CONVO_EFFORT=low`; `--set OPENROUTER_API_KEY` + `IRISES_SET_VALUE` writes, never prints; `--unset CONVO_EFFORT`; `IRISES_DASHBOARD_PASSWORD` alone writes `DASHBOARD_PASSWORD`, never printed.
- B4 `--port`. Tests: held port → exit 1 (spawn a node listener as irises-lib.test.ts:429 does); `--port 4001 --no-restart --yes` writes PORT, no manifest → says so; same port → noop.
- B5 `--service on|off`. Tests on a scratch PATH (configure.test.ts builds a bin dir of symlinks like `runLib`): `on` with no service manager → 1; `off` with none installed → noop; `on`/`off` transitions with stub `launchctl`/`systemctl` + fake `uname` asserting `bootstrap`/`bootout` in the argv log and the manifest fields.
- B6 `--front`. Tests: `OPS_BACKEND=off` → 1 "no engine"; bad pattern → 2; `none` accepted; hermes fixture (`OPS_BACKEND=hermes`, `HERMES_HOME` dir with `.env`, no manifest) → 1 "install with the bridge first".

**C. Callers**
- C1 engine-setup.sh: delete :309-356, call the lib `model_override_write "$ENV_FILE" "$MODEL_LANE" "$MODEL_SLUG" "$MODEL_BASE_URL"` at :596; `front_says_kept` :305 → `bash ./scripts/configure.sh --front $FRONT_PATTERN`. Test: engine-setup.test.ts greps the source for `configure.sh --front`; e2e stage 8 `.env` asserts unchanged.
- C2 update.sh: delete :274-322; four call sites (:440, :510, :633, :641) → `irises_restart_verify "$ROOT" "$PORT" SHA 45`. update.test.ts + e2e stages 2/3/3b green.

**D. Menu + contracts**
- D1 `scripts/shellContract.test.ts`: lifecycle regex `(engine-setup|update|irises|configure)\.sh$`, count 4.
- D2 `scripts/irises.sh` per D4.
- D3 `scripts/settingsContract.test.ts` per D6 (red before D2, green after).

**E. e2e** (`scripts/e2e/lifecycle-sandbox.sh`): stage `8a/12 configure from the menu` between stage 8 and 8b. Third free port `SRV_PORT2` from the node snippet at :140-149. Each action `: > "$STUB_LOG"; printf '%s\n' … q | bash scripts/irises.sh`, `check_rc 0`, literal command-line `check_out` (as stage 8 does), `check_no_out "$WIZ_KEY"`:
1. `2 5 Europe/Paris q` → `bash scripts/configure.sh --tz Europe/Paris`, `RESULT: ok`, `^IRISES_TZ=Europe/Paris$`, `expect_sha "$WIZ_HEAD"` (restart verified, same build).
2. `2 4 n q` → `--web off`, `^WEB_ENABLED=false$`.
3. `2 2 2 telegram:1 q` → `--front telegram:1`; engine `.env` `^IRISES_FRONT=telegram:1$` and not `telegram:\*`; `grep -qE "hermes gateway re?start" "$STUB_LOG"` (the `re?start` spelling dodges shellContract's literal scan); manifest `"frontPattern": "telegram:1"`; Irises pid unchanged.
4. `2 3 1 q` → `--model-inherit`; the three `*_MODEL_OPENROUTER`, `^CONVO_PROVIDER=`, `^ENGINE_MODEL_INHERIT=` absent; `^OPENROUTER_API_KEY=$WIZ_KEY$` present.
5. `2 7 1 CONVO_EFFORT low q` → `--set CONVO_EFFORT=low`, `^CONVO_EFFORT=low$`.
6. LAST: `2 1 $SRV_PORT2 n q` → `--port $SRV_PORT2 --service off` (service off is a noop on the `--no-service` install; `service_kind` is `launchd`/`systemd` in the sandbox because the stubs exist, so `--service on` is unit-test-only); then `SRV_PORT="$SRV_PORT2"`; `expect_sha "$WIZ_HEAD"`; old port closed; engine `^IRISES_URL=http://127.0.0.1:$SRV_PORT2$`; manifest `"port": "$SRV_PORT2"`; gateway restart logged.
7. `bash scripts/configure.sh --show` → `OPENROUTER_API_KEY` line says `<set>`, `check_no_out "$WIZ_KEY"`, new port shown.
Renumber 8b (:931) `3 2 y q` → `4 2 y q` and 8c (:955) `3 4 y delete q` → `4 4 y delete q`; header comment gains the 8a line. Stage 8b's byte-identical `cmp` still holds: `IRISES_FRONT` and `IRISES_URL` are in `keysAdded`, so detach removes them whatever their value.

**F. Docs**
- README.md: :193 menu comment and :239 "five entries" → six with **configure**; :218 replace the hand-edit "narrow the `IRISES_FRONT` glob list" advice with `bash ./scripts/configure.sh --front 'telegram:*'` (hand edit kept as fallback); new `### Changing settings after the install` before :340 (`--show`, the seven settings, generic-editor rules, secrets via env, restart semantics, the rule sentence naming `scripts/settingsContract.test.ts`); Build & run table :300 row; Configuration intro :399 pointer.
- docs/DEPLOY.md :145-150 list configure.sh among the flag scripts; after :212 its exit codes / RESULT tokens.
- docs/ENGINES.md :61-63 six entries; :476 `IRISES_FRONT` row and :563-565 "pause fronting" → `bash ./scripts/configure.sh --front none` (fallback kept).
- skills/irises-setup-hermes/SKILL.md and skills/irises-setup-openclaw/SKILL.md §6: a "Change a setting" block (`bash ./scripts/configure.sh --show`, `--tz`, `--front`, `--model-inherit`; guide-only; `./scripts/` spelling per skillRefs.test.ts).

## Gotchas
- bash 3.2 on macOS: no `+=`, no associative arrays, no `${var,,}`; indexed arrays OK; `set --` for arg lists; `[[ =~ ]]` only with an unquoted pattern.
- hermes guard literals: never write `hermes gateway restart|stop`, `launchctl kickstart … hermes.gateway`, `systemctl … restart … hermes-gateway`, `pkill … hermes … gateway` in ANY `.sh` (comments and e2e included); shellContract scans them all. configure.sh must not define `get_env()`, `set_env()`, `is_our_server()`, `health_ok()`.
- flagDocs tripwire: configure adds no runtime key; do not touch `.env.example` / `deploy/app.env`.
- `built_sha` empty (never built) → liveness-only verify with a warn, as install does. `server_pid` is port-agnostic (pidfile), so the detached cycle on a port change hits the right process; verification targets the NEW port.
- `--show` in Status prints a `RESULT: ok` block (accepted; the `--check` precedent).
- Every clone write ends with `chmod 600 "$ENV_FILE"`; `env_backup` copies are 0600.
- Documented-key lookup must fall back to the script's own clone when `IRISES_ROOT` points at a fixture dir.

## Verification
```bash
npm test                                   # unit + contract tests (incl. new configure/settingsContract/shellContract)
npm test -- scripts/lib/irises-lib.test.ts scripts/configure.test.ts scripts/settingsContract.test.ts scripts/shellContract.test.ts
bash -n scripts/configure.sh scripts/irises.sh scripts/engine-setup.sh scripts/update.sh scripts/lib/irises-lib.sh
npm run typecheck:scripts
npm run e2e:lifecycle                      # ~4-5 min sandboxed; must end RESULT: ok (KEEP=1 to inspect .sandbox)
# read-only on this Mac (real .env + manifest exist): no lock, no restart
bash scripts/configure.sh --show
bash scripts/configure.sh --set OPENAI_API_KEY=x; echo "exit $?"   # 2
bash scripts/configure.sh --set NOT_A_KEY=1; echo "exit $?"        # 2
bash scripts/configure.sh; echo "exit $?"                          # 2, points at --show
```
Manual TTY walk-through on a throwaway install: `bash scripts/irises.sh` → `2` shows the report + seven entries → `5` tz `UTC` → `+/~` preview → `y` → `RESULT: ok` + next steps → `2` `5` again → `noop` → `2` `3` `1` (inherit) → preview lists `-` lines and "keeping OPENROUTER_API_KEY" → `n` → `noop` → `2` `7` `1` `OPENROUTER_API_KEY` typed unseen → printed line shows `IRISES_SET_VALUE=<set> bash scripts/configure.sh --set OPENROUTER_API_KEY` → `n` → `5` Status shows the report → `q`; `Ctrl-D` at a prompt → exit 2 with three `--help` pointers.
After merge: VPS deploy is a separate step (`bash scripts/update.sh --yes` in a login shell on the VPS), then `bash scripts/configure.sh --show` there.
