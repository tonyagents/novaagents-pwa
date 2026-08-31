# TripPilot — autonomous travel-booking agent (Paylink demo)

A sales-collateral demo: an AI agent finds flights + hotels and **books them with a one-time, merchant-scoped virtual card** that's released only after you **approve with a passkey**. The agent never sees a real card number.

It's a small Node backend running the **Claude Agent SDK** wired to two MCP servers, plus a web chat frontend:

```
 Browser (desktop)
        │  https / SSE   (token-gated)
        ▼
 Node server ── Claude Agent SDK
                    ├── travel  (in-process: curated flight/hotel search)
                    └── paylink  (remote MCP @ api.paylink.sh/mcp, OAuth bearer)
```

The **travel** inventory is curated/static so the demo is reliable live and on video. The **real** artifacts are the Paylink card + passkey approval.

## One-time setup

```bash
cd ~/novaagents-pwa
npm install                 # if you haven't already
node paylink-auth.mjs        # opens a browser → approve Paylink access (OAuth 2.1 + PKCE)
```

`paylink-auth.mjs` registers a client, runs the OAuth flow, and saves an access + refresh token to `.paylink-token.json` (gitignored). You only do this once; the token auto-refreshes.

## Run it

```bash
./start.sh
```

`start.sh` loads the Paylink token, prints an **app access token**, and starts the server on `:8790`. Open **http://localhost:8790**, paste the token once. (If `cloudflared` is installed, it also opens a phone tunnel.)

## Demo script

1. **"Find flights SFO → JFK next Friday, 2 nights downtown NYC."** → agent renders flight + hotel cards.
2. Click **Book this flight** (or type "book the United flight"). → agent requests payment; a **passkey approval card** appears.
3. Click **🔐 Approve with passkey** → Paylink approval page → biometric. The card flips to **Approved ✓** and a **Booked** confirmation shows the masked one-time card.
4. Talking points: the agent never saw a card number; the card is **single-use + locked to that merchant**; **you** authorized it with a passkey.

## How the pieces map to Paylink tools

| Step | Paylink tool |
|---|---|
| Pick the card credential | `list_credentials` |
| Mint the merchant-scoped one-time card | `request_payment` → returns `approval_url` + `request_id` |
| Wait for the passkey approval | poll `get_request` until `success` |
| Reveal the usable card (single-use) | `claim_payment_credentials` |

## Files

| File | What |
|---|---|
| `server.mjs` | Express + Agent SDK; `travel` + `paylink` MCP servers; SSE forwards tool name/input/output |
| `travel-inventory.mjs` | Curated flights + hotels (merchant, url, price) |
| `paylink-auth.mjs` | One-time Paylink OAuth 2.1 + PKCE login; `--print` / `--refresh` helpers |
| `public/` | Web app: chat + flight/hotel cards, passkey approval card, booking confirmation |
| `start.sh` | Loads Paylink token, boots server (+ optional tunnel) |

## Notes

- **Claude auth**: the Agent SDK reuses your Claude Code login (macOS Keychain). No `ANTHROPIC_API_KEY` needed (set one to override).
- **Security**: `/api/chat` auto-approves tool calls (a chat UI can't show interactive prompts); the bearer token gates the endpoint. Keep it private.
- **Staging**: point at staging with `PAYLINK_MCP_URL=https://staging.api.paylink.sh/mcp PAYLINK_ISSUER=https://staging.api.paylink.sh` (re-run `paylink-auth.mjs`).
- No real airline checkout happens — booking is staged after the (real) card is issued.
