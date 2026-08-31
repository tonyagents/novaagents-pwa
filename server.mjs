import express from "express";
import crypto from "node:crypto";
import os from "node:os";
import { z } from "zod";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { searchFlights, searchHotels } from "./travel-inventory.mjs";
import { createPaylinkSim, approvalPageHtml, approveRequest, denyRequest } from "./paylink-sim.mjs";

const PORT = process.env.PORT || 8790;
const PAYLINK_MCP_URL = process.env.PAYLINK_MCP_URL || "https://api.paylink.sh/mcp";
const PAYLINK_ACCESS_TOKEN = process.env.PAYLINK_ACCESS_TOKEN;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// Use real Paylink when a token is present (and sim isn't forced); otherwise simulate.
const USE_SIM = !PAYLINK_ACCESS_TOKEN || process.env.PAYLINK_SIM === "1";
const paylinkSim = USE_SIM ? createPaylinkSim({ baseUrl: PUBLIC_BASE_URL }) : null;

// --- Auth token for THIS app (gates the chat endpoint). ---
let TOKEN = process.env.NOVAAGENTS_TOKEN;
if (!TOKEN) {
  TOKEN = crypto.randomBytes(16).toString("hex");
  console.log("\n  No NOVAAGENTS_TOKEN set — generated one for this run:");
  console.log("  ┌──────────────────────────────────────────────┐");
  console.log(`  │  ${TOKEN}  │`);
  console.log("  └──────────────────────────────────────────────┘");
  console.log("  Enter it in the app the first time you open it.\n");
}

// --- In-process "travel" MCP server: curated flight/hotel search. ---
// Keeping inventory static makes the demo deterministic; the real moment is the
// Paylink card + passkey approval, which these tools feed (merchant/url/amount).
const travelServer = createSdkMcpServer({
  name: "travel",
  version: "1.0.0",
  tools: [
    tool(
      "search_flights",
      "Search available flights. Returns options with carrier, times, price, and the merchant + merchant_url to use when booking via Paylink.",
      { origin: z.string().optional(), destination: z.string().optional(), date: z.string().optional() },
      async (args) => {
        const results = searchFlights(args);
        return { content: [{ type: "text", text: JSON.stringify({ kind: "flights", results }) }] };
      }
    ),
    tool(
      "search_hotels",
      "Search available hotels. Returns options with nightly rate and the merchant + merchant_url to use when booking via Paylink.",
      { city: z.string().optional(), checkin: z.string().optional(), nights: z.number().optional() },
      async (args) => {
        const results = searchHotels(args);
        return { content: [{ type: "text", text: JSON.stringify({ kind: "hotels", results }) }] };
      }
    ),
  ],
});

const SYSTEM_PROMPT = `You are TripPilot, an autonomous travel-booking agent. You help the user find flights and hotels and book them — paying with a secure one-time virtual card minted by Paylink, which the user approves with a passkey. You never see or handle a real card number.

# Tools
- travel (search_flights, search_hotels): curated inventory. Each result includes "merchant", "merchant_url", and a price ("price_cents" / "nightly_cents"). ALWAYS use those exact values when booking — never invent merchants, prices, or card data.
- paylink (list_credentials, request_payment, get_request, claim_payment_credentials): the payment broker.

# How to handle a trip
1. Use search_flights / search_hotels to find options. Present the options briefly; the UI renders rich cards from the tool results, so DO NOT re-list every field in prose — just give a one-line summary and ask which to book (or, if the user already said what to book, proceed).

# How to book ONE item (repeat per item the user confirms)
1. Call list_credentials once and pick a credential whose kind is "card". Reuse it across items.
2. Call request_payment with: credential_id (the card), merchant + merchant_url (from the chosen option), amount_cents (price_cents for a flight; nightly_cents × nights for a hotel), currency "USD".
3. request_payment returns "pending_approval" with an "approval_url" and a "request_id". Tell the user, in one short line, that you've requested approval — e.g. "Requested approval to charge $384 to United — approve with your passkey." The UI shows the approval button; do NOT paste the raw approval_url into your text.
4. Poll get_request with that request_id until status is "success". Call it patiently — the user needs a few seconds to approve. If status is "denied", stop and tell the user it was declined (include the reason). If "error", report the message.
5. Once success, call claim_payment_credentials for that request to obtain the one-time card. The UI renders the masked card + a "Booked" confirmation from this result — so just give a one-line confirmation like "Booked your United flight ✓". Never print full card numbers, CVC, or expiry in your text.

# Style
- Concise. Lead with the answer. Short lines, no walls of text.
- If multiple items are booked, do them in sequence (each needs its own approval) and confirm each.
- If PAYLINK tools error with an auth problem, tell the user to re-run \`node paylink-auth.mjs\`.`;

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, _res, next) => {
  const auth = req.get("authorization");
  const tok = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const tokInfo = tok ? `token(len=${tok.length}, …${tok.slice(-4)})` : "no-token";
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} | ${req.ip} | ${tokInfo}`);
  next();
});

app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});

app.use(express.static("public"));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/ping", authed, (_req, res) => res.json({ ok: true }));

// --- Simulated passkey approval page (stands in for the Paylink-hosted page). ---
if (USE_SIM) {
  app.get("/approve", (req, res) => res.type("html").send(approvalPageHtml(String(req.query.rid || ""))));
  app.post("/api/sim/approve", (req, res) => res.json({ ok: approveRequest(String(req.query.rid || "")) }));
  app.post("/api/sim/deny", (req, res) => res.json({ ok: denyRequest(String(req.query.rid || "")) }));
}
app.get("/api/diag", (req, res) => {
  console.log(`[DIAG] ${JSON.stringify(req.query)}`);
  res.set("Access-Control-Allow-Origin", "*").json({ ok: true });
});

function authed(req, res, next) {
  const h = req.get("authorization") || "";
  const token = (h.startsWith("Bearer ") ? h.slice(7) : "") || (req.query.token ? String(req.query.token) : "");
  const a = Buffer.from(token);
  const b = Buffer.from(TOKEN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: "unauthorized" });
}

// Pull a clean JSON object out of an MCP tool_result's content (array of blocks or string).
function parseToolOutput(content) {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.map((b) => (typeof b === "string" ? b : b?.text || "")).join("\n");
  else if (content && typeof content === "object") text = content.text || "";
  text = text.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { text }; }
}

app.post("/api/chat", authed, async (req, res) => {
  const { message, sessionId } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message required" });
  }

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });

  // Map tool_use id → tool name so we can label tool_result outputs.
  const toolNames = new Map();
  const shortName = (n) => String(n || "").replace(/^mcp__/, "");

  let resolvedSession = sessionId || null;
  try {
    const q = query({
      prompt: message,
      options: {
        model: "claude-opus-4-8",
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: {
          travel: travelServer,
          paylink: USE_SIM
            ? paylinkSim
            : {
                type: "http",
                url: PAYLINK_MCP_URL,
                headers: { Authorization: `Bearer ${PAYLINK_ACCESS_TOKEN}` },
                alwaysLoad: true,
                timeout: 60000,
              },
        },
        // Headless: auto-approve every tool. The endpoint is gated by the bearer token.
        canUseTool: async (_toolName, input) => ({ behavior: "allow", updatedInput: input }),
        settingSources: [],
        includePartialMessages: true,
        maxTurns: 40,
        abortController: abort,
        ...(sessionId ? { resume: sessionId } : {}),
      },
    });

    for await (const m of q) {
      if (m.session_id) resolvedSession = m.session_id;

      if (m.type === "stream_event") {
        const e = m.event;
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
          send({ type: "text", delta: e.delta.text });
        }
      } else if (m.type === "assistant") {
        for (const block of m.message?.content || []) {
          if (block.type === "tool_use") {
            toolNames.set(block.id, block.name);
            send({ type: "tool", phase: "start", name: shortName(block.name), input: block.input });
          }
        }
      } else if (m.type === "user") {
        const content = Array.isArray(m.message?.content) ? m.message.content : [];
        for (const block of content) {
          if (block.type === "tool_result") {
            const fullName = toolNames.get(block.tool_use_id) || "";
            send({
              type: "tool",
              phase: "result",
              name: shortName(fullName),
              isError: !!block.is_error,
              output: parseToolOutput(block.content),
            });
          }
        }
      } else if (m.type === "result") {
        send({ type: "done", sessionId: resolvedSession, subtype: m.subtype, cost: m.total_cost_usd });
      }
    }
  } catch (err) {
    send({ type: "error", message: String(err?.message || err) });
  }
  res.end();
});

app.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address;
  console.log(`TripPilot server running:`);
  console.log(`  local:  http://localhost:${PORT}`);
  if (lan) console.log(`  LAN:    http://${lan}:${PORT}`);
  console.log(`  Paylink: ${USE_SIM ? "SIMULATION mode (no token) — full flow runs offline" : `LIVE ✓ (${PAYLINK_MCP_URL})`}`);
});
