// Paylink SIMULATION mode.
//
// An in-process MCP server that mimics the real Paylink tools — same tool names
// (mcp__paylink__*), same result shapes — plus a local passkey-style approval page.
// Lets the whole booking flow run end-to-end with zero external dependencies, so
// the demo is 100% reliable. Swap in the real Paylink MCP just by providing a token.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const requests = new Map(); // request_id -> { status, merchant, merchant_url, amount_cents, currency, card }

const rid = () => "req_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const SIM_CARD = {
  credential_id: "cred_demo_card",
  kind: "card",
  name: "TripPilot Demo Card",
  approval_mode: "always_approve",
  brand: "Visa",
  last4: "4242",
};

function mintOneTimeCard(merchant) {
  const last4 = String(1000 + Math.floor(Math.random() * 9000));
  const now = new Date();
  const exp_month = ((now.getMonth() + 1) % 12) + 1;
  const exp_year = now.getFullYear() + 3;
  return {
    brand: "Visa",
    last4,
    exp_month,
    exp_year,
    expiry: `${String(exp_month).padStart(2, "0")}/${String(exp_year).slice(-2)}`,
    merchant,
    single_use: true,
  };
}

export function getRequest(id) { return requests.get(id) || null; }
export function approveRequest(id) {
  const r = requests.get(id);
  if (!r || r.status !== "pending_approval") return false;
  r.status = "success";
  r.approved_at = Date.now();
  return true;
}
export function denyRequest(id, reason = "Declined by user") {
  const r = requests.get(id);
  if (!r || r.status !== "pending_approval") return false;
  r.status = "denied";
  r.reason = reason;
  return true;
}

export function createPaylinkSim({ baseUrl }) {
  return createSdkMcpServer({
    name: "paylink",
    version: "1.0.0-sim",
    tools: [
      tool(
        "list_credentials",
        "List the credentials this connector may use (cards, wallets, secrets). Call first to get a credential_id.",
        {},
        async () => ({ content: [{ type: "text", text: JSON.stringify({ credentials: [SIM_CARD] }) }] })
      ),
      tool(
        "request_payment",
        "Authorize a merchant-scoped one-time virtual card. Returns pending_approval with an approval_url and request_id. Does not charge the merchant; you use the returned card at checkout after approval.",
        {
          credential_id: z.string(),
          merchant: z.string(),
          merchant_url: z.string().optional(),
          amount_cents: z.number(),
          currency: z.string().default("USD"),
        },
        async (a) => {
          const id = rid();
          requests.set(id, {
            request_id: id,
            status: "pending_approval",
            merchant: a.merchant,
            merchant_url: a.merchant_url,
            amount_cents: a.amount_cents,
            currency: a.currency || "USD",
            card: mintOneTimeCard(a.merchant),
          });
          const approval_url = `${baseUrl}/approve?rid=${encodeURIComponent(id)}`;
          return {
            content: [{ type: "text", text: JSON.stringify({
              status: "pending_approval",
              request_id: id,
              approval_url,
              merchant: a.merchant,
              amount_cents: a.amount_cents,
              currency: a.currency || "USD",
            }) }],
          };
        }
      ),
      tool(
        "get_request",
        "Poll the status of a previously-issued request (pending_approval → success/denied).",
        { request_id: z.string() },
        async (a) => {
          const r = requests.get(a.request_id);
          if (!r) return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: "unknown request_id" }) }] };
          // After approval, the real Paylink redacts the card here.
          const body = { status: r.status, request_id: r.request_id };
          if (r.status === "denied") body.reason = r.reason;
          return { content: [{ type: "text", text: JSON.stringify(body) }] };
        }
      ),
      tool(
        "claim_payment_credentials",
        "Claim the usable one-time card after a human-approved card payment reaches success. Single-use.",
        { request_id: z.string() },
        async (a) => {
          const r = requests.get(a.request_id);
          if (!r) return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: "unknown request_id" }) }] };
          if (r.status !== "success") return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: `not approved (status: ${r.status})` }) }] };
          if (r.claimed) return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: "card already claimed (single-use)" }) }] };
          r.claimed = true;
          return { content: [{ type: "text", text: JSON.stringify({ status: "success", card: r.card }) }] };
        }
      ),
    ],
  });
}

// The local passkey-style approval page (stands in for the Paylink-hosted page).
export function approvalPageHtml(id) {
  const r = requests.get(id);
  if (!r) return `<!doctype html><meta charset=utf8><body style="font:16px -apple-system;background:#0e0b1a;color:#ece9f6;display:grid;place-items:center;height:100vh;margin:0">Unknown request.</body>`;
  const amt = `$${(r.amount_cents / 100).toFixed(2)}`;
  const done = r.status !== "pending_approval";
  return `<!doctype html><html><head><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve payment · Paylink</title>
<style>
  :root{--accent:#7b61ff;--accent2:#a78bfa;--card:#1b1636;--bg:#0e0b1a;--text:#ece9f6;--muted:#9a93b8}
  *{box-sizing:border-box} html,body{margin:0;height:100%}
  body{background:radial-gradient(120% 80% at 50% 0%,#1a1438,var(--bg) 60%);color:var(--text);
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center}
  .card{background:var(--card);border:1px solid rgba(123,97,255,.35);border-radius:20px;padding:28px;width:min(380px,92vw);
    box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);border:1px solid rgba(255,255,255,.1);border-radius:999px;padding:3px 10px}
  .amt{font-size:40px;font-weight:800;margin:16px 0 2px} .merch{color:var(--muted)}
  .note{color:var(--muted);font-size:13px;margin:16px 0 22px}
  .btn{width:100%;border:none;border-radius:14px;padding:15px;font:inherit;font-weight:700;color:#fff;cursor:pointer;
    background:linear-gradient(135deg,var(--accent),var(--accent2))}
  .btn:disabled{opacity:.5} .deny{background:none;color:var(--muted);border:none;width:100%;padding:12px;margin-top:8px;cursor:pointer;font:inherit}
  .ok{text-align:center} .bigcheck{width:72px;height:72px;border-radius:50%;background:#3ddc84;color:#06351c;display:grid;place-items:center;font-size:38px;margin:6px auto 14px}
  .scan{width:72px;height:72px;border-radius:50%;border:2px solid var(--accent2);display:grid;place-items:center;font-size:34px;margin:6px auto 14px;animation:pulse 1.1s infinite}
  @keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(167,139,250,.5)}50%{box-shadow:0 0 0 14px rgba(167,139,250,0)}}
  h2{margin:.2em 0}
</style></head>
<body><div class="card" id="card">
  ${done ? okBlock(r) : `
  <span class="pill">🛡️ Paylink · passkey approval</span>
  <div class="amt">${amt}</div>
  <div class="merch">to ${escapeHtml(r.merchant)}</div>
  <div class="note">You're approving a <b>single-use virtual card</b> locked to ${escapeHtml(r.merchant)}. The agent never sees the card number.</div>
  <button class="btn" id="go">🔐 Approve with passkey</button>
  <button class="deny" id="deny">Decline</button>`}
</div>
<script>
  const rid=${JSON.stringify(id)};
  const card=document.getElementById('card');
  const go=document.getElementById('go');
  if(go){
    go.addEventListener('click',async()=>{
      go.disabled=true;
      card.innerHTML='<div class="ok"><div class="scan">☝️</div><h2>Verifying…</h2><p style="color:#9a93b8">Touch ID / passkey</p></div>';
      await new Promise(r=>setTimeout(r,1100));
      await fetch('/api/sim/approve?rid='+encodeURIComponent(rid),{method:'POST'});
      card.innerHTML='<div class="ok"><div class="bigcheck">✓</div><h2>Approved</h2><p style="color:#9a93b8">Card released. You can close this tab.</p></div>';
    });
  }
  const deny=document.getElementById('deny');
  if(deny){deny.addEventListener('click',async()=>{
    await fetch('/api/sim/deny?rid='+encodeURIComponent(rid),{method:'POST'});
    card.innerHTML='<div class="ok"><div class="bigcheck" style="background:#ff8080;color:#3a0d0d">✕</div><h2>Declined</h2><p style="color:#9a93b8">You can close this tab.</p></div>';
  });}
</script></body></html>`;
}

function okBlock(r) {
  if (r.status === "success") return `<div class="ok"><div class="bigcheck">✓</div><h2>Approved</h2><p style="color:#9a93b8">Card released. You can close this tab.</p></div>`;
  return `<div class="ok"><div class="bigcheck" style="background:#ff8080;color:#3a0d0d">✕</div><h2>Declined</h2><p style="color:#9a93b8">You can close this tab.</p></div>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
