#!/bin/zsh
# Cancel-proof finisher for the convergence loop: runs round 5 detached from any CC session,
# copies all round artifacts to the durable results/ dir, and writes STATUS.md with the verdict.
# Safe to re-run: skips the round if its JSON already exists.
export PATH="$HOME/.nvm/versions/node/v22.17.0/bin:$PATH"
REPO="$HOME/Documents/GitHub/Irises"
RES="$REPO/scripts/convergence/results"
SCRATCH="/private/tmp/claude-501/-Users-rivianpratama-Documents-GitHub-Irises/cf601e2b-1a0e-42d9-8370-c3ec7ef51598/scratchpad"
mkdir -p "$RES"
cd "$REPO" || exit 1

# preserve round 4 durably
cp -f "$SCRATCH/loop-round-4.json" "$RES/" 2>/dev/null
cp -f "$SCRATCH/round4.log" "$RES/" 2>/dev/null

# round 5 (skip if already done)
if [ ! -f "$RES/loop-round-5.json" ]; then
  sleep 30   # let the instance settle after round 4
  npx tsx scripts/convergence/loopBattery.ts --round 5 --out "$RES/loop-round-5.json" > "$RES/round5.log" 2>&1
fi

# verdict
node -e "
const fs = require('fs');
const load = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const r4 = load('$RES/loop-round-4.json'), r5 = load('$RES/loop-round-5.json');
const line = r => r ? \`PASS \${r.counts.pass ?? '?'} · LATE \${r.counts.late ?? 0} · SILENT \${r.counts.silent ?? 0} · FALSE_REFUSAL \${r.counts.falseRefusal ?? r.counts.false_refusal ?? 0} · OVER_DELEGATION \${r.counts.overDelegation ?? r.counts.over_delegation ?? 0} — \${r.clean ? 'CLEAN' : 'DIRTY'}\` : 'missing';
const converged = !!(r4 && r5 && r4.clean && r5.clean);
const md = ['# Convergence loop status', '', 'Round 4: ' + line(r4), 'Round 5: ' + line(r5), '',
  converged ? 'CONVERGED: two consecutive clean rounds. Loop complete.' : 'NOT CONVERGED YET — see round JSONs for failures.', ''].join('\n');
fs.writeFileSync('$RES/STATUS.md', md);
console.log(md);
" >> "$RES/round5.log" 2>&1
