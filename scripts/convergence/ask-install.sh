#!/bin/zsh
# The ask-to-install pipeline test: send hermes (the engine) a user-voice chat message asking it
# to install Irises, exactly as a Telegram/iMessage user with a bridged hermes would. The transport
# differs; the agent path — skill discovery, clone, engine-setup.sh, health check — is identical.
# Sandboxed: fresh clone at ~/irises-sandbox, PORT=3105, no bridge; the live ~/irises stays alone.
RES="$HOME/Documents/GitHub/Irises/scripts/convergence/results"
KEY=$(grep '^HERMES_API_KEY=' ~/irises/.env | cut -d= -f2)
ASK='hey, can you install Irises for me? use your irises-setup-hermes skill. important: I already run an Irises at ~/irises on port 3000 for something else — leave that checkout and that process completely alone. this is a fresh separate install: clone into ~/irises-sandbox and make it listen on port 3105 (export PORT=3105 in the shell before you run the setup script, so it pins that port). no bridge mode. when you are done, tell me: the health check result, the exact web chat url, and anything you could not finish.'
jq -n --arg ask "$ASK" '{model:"hermes-agent",messages:[{role:"user",content:$ask}],stream:false}' > "$RES/install-ask-payload.json"
date > "$RES/install-ask.log"
curl -sS --max-time 1500 -X POST http://127.0.0.1:8642/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d @"$RES/install-ask-payload.json" >> "$RES/install-ask.log" 2>&1
echo "\n--- done $(date) ---" >> "$RES/install-ask.log"
# Post-verify from OUR side, independent of what the agent claims:
{ echo "--- verify ---";
  curl -sS -m 5 http://127.0.0.1:3105/health || echo "NO HEALTH on :3105";
  echo; ls ~/irises-sandbox 2>/dev/null | head -5;
  echo "live instance still ok:"; curl -sS -m 5 http://127.0.0.1:3000/health | head -c 80; } >> "$RES/install-ask.log" 2>&1
