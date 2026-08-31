#!/usr/bin/env bash
# Launches the TripPilot server. Desktop demo runs on localhost; a Cloudflare
# tunnel is opened too (if cloudflared is installed) for phone access.
set -e
cd "$(dirname "$0")"

PORT="${PORT:-8790}"
export PAYLINK_MCP_URL="${PAYLINK_MCP_URL:-https://api.paylink.sh/mcp}"

# Load the Paylink OAuth token if we've logged in before. If there's no token,
# the server runs in SIMULATION mode (full flow, offline) — no login required.
# To use REAL Paylink: run `node paylink-auth.mjs` once, then start again.
if [ -z "$PAYLINK_ACCESS_TOKEN" ] && [ -f .paylink-token.json ]; then
  PAYLINK_ACCESS_TOKEN="$(node paylink-auth.mjs --print 2>/dev/null)" || true
  export PAYLINK_ACCESS_TOKEN
fi
[ -n "$PAYLINK_ACCESS_TOKEN" ] && echo "Paylink: LIVE token loaded ✓" || echo "Paylink: SIMULATION mode (run 'node paylink-auth.mjs' to go live)"

# A stable app token so you only enter it once. Override by exporting NOVAAGENTS_TOKEN.
if [ -z "$NOVAAGENTS_TOKEN" ]; then
  if [ -f .token ]; then
    NOVAAGENTS_TOKEN="$(cat .token)"
  else
    NOVAAGENTS_TOKEN="$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")"
    echo "$NOVAAGENTS_TOKEN" > .token
  fi
  export NOVAAGENTS_TOKEN
fi

echo "────────────────────────────────────────────────"
echo " TripPilot — open http://localhost:$PORT"
echo " Access token (paste once in the app):"
echo "   $NOVAAGENTS_TOKEN"
echo "────────────────────────────────────────────────"

# Start the server in the background.
PORT="$PORT" node server.mjs &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

# Wait for it to come up.
for i in $(seq 1 30); do
  curl -sf "http://localhost:$PORT/api/health" >/dev/null && break
  sleep 0.3
done

# Optional Cloudflare tunnel for phone access. Skipped if cloudflared isn't installed.
if command -v cloudflared >/dev/null 2>&1; then
  echo; echo "Opening Cloudflare tunnel (for phone access)…"; echo
  cloudflared tunnel --protocol http2 --url "http://localhost:$PORT" 2>&1 | while IFS= read -r line; do
    echo "$line"
    url=$(printf '%s' "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1)
    if [ -n "$url" ]; then
      printf '%s\n' "$url" > .tunnel-url
      echo
      echo "╔════════════════════════════════════════════════════════════════╗"
      echo "║  Phone URL (changes each run):  $url"
      echo "║  Token:  $NOVAAGENTS_TOKEN"
      echo "╚════════════════════════════════════════════════════════════════╝"
    fi
  done
else
  echo; echo "cloudflared not found — staying on localhost only. Press Ctrl-C to stop."
  wait "$SERVER_PID"
fi
