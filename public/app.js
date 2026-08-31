const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const resetBtn = document.getElementById("reset");
const gate = document.getElementById("gate");
const tokenInput = document.getElementById("token");
const gateErr = document.getElementById("gate-err");

let token = "";
let sessionId = null;
try { token = localStorage.getItem("ma_token") || ""; } catch (_) {}
try { sessionId = sessionStorage.getItem("ma_session") || null; } catch (_) {}
let busy = false;

function showGate(show, msg) {
  gate.hidden = !show;
  gateErr.textContent = msg || "";
}
if (!token) showGate(true);
else welcome();

function welcome() {
  if (chat.querySelector(".welcome")) return;
  if (chat.children.length === 0) {
    const w = document.createElement("div");
    w.className = "welcome";
    w.innerHTML = `<div class="w-logo">✈</div>
      <h1>TripPilot</h1>
      <p>Your travel agent that books with a one-time card — approved by your passkey.</p>
      <div class="w-chips">
        <button class="w-chip">Find flights SFO → JFK next Friday</button>
        <button class="w-chip">2 nights at a hotel in downtown NYC</button>
        <button class="w-chip">Plan a trip to Chicago and book it</button>
      </div>`;
    chat.appendChild(w);
    w.querySelectorAll(".w-chip").forEach((b) =>
      b.addEventListener("click", () => sendText(b.textContent))
    );
  }
}

function clearWelcome() {
  const w = chat.querySelector(".welcome");
  if (w) w.remove();
}

function addMsg(role, text = "") {
  clearWelcome();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  chat.appendChild(el);
  scrollDown();
  return el;
}

function scrollDown() { chat.scrollTop = chat.scrollHeight; }

const TOOL_LABELS = {
  "travel__search_flights": "Searching flights",
  "travel__search_hotels": "Searching hotels",
  "paylink__list_credentials": "Checking payment methods",
  "paylink__request_payment": "Requesting approval",
  "paylink__get_request": "Checking approval",
  "paylink__claim_payment_credentials": "Issuing one-time card",
};

let lastChip = null;
function addChip(label) {
  clearWelcome();
  // dedupe consecutive identical chips (e.g. repeated approval polling)
  if (lastChip && lastChip.dataset.label === label) return;
  const el = document.createElement("div");
  el.className = "tool";
  el.dataset.label = label;
  el.textContent = `⚙︎ ${label}`;
  chat.appendChild(el);
  lastChip = el;
  scrollDown();
}

const fmtMoney = (cents) => (cents == null ? null : `$${(cents / 100).toFixed(2)}`);

// --- rich card renderers ---------------------------------------------------

function flightCard(f) {
  const el = document.createElement("div");
  el.className = "tcard";
  el.innerHTML = `
    <div class="tc-head">
      <div class="tc-title">${esc(f.carrier)} · ${esc(f.flight_no || "")}</div>
      <div class="tc-price">${esc(f.price || fmtMoney(f.price_cents) || "")}</div>
    </div>
    <div class="tc-route">
      <span class="tc-code">${esc(f.origin)}</span>
      <span class="tc-line">— ${esc(f.stops || "")} · ${esc(f.duration || "")} →</span>
      <span class="tc-code">${esc(f.destination)}</span>
    </div>
    <div class="tc-sub">${esc(f.depart || "")} – ${esc(f.arrive || "")} · ${esc(f.cabin || "")}</div>
    <button class="tc-book">Book this flight</button>`;
  el.querySelector(".tc-book").addEventListener("click", () =>
    sendText(`Book the ${f.carrier} flight ${f.flight_no || ""} (${f.origin}→${f.destination}) for ${f.price || fmtMoney(f.price_cents)}.`)
  );
  return el;
}

function hotelCard(h) {
  const el = document.createElement("div");
  el.className = "tcard";
  el.innerHTML = `
    <div class="tc-head">
      <div class="tc-title">${esc(h.name)}</div>
      <div class="tc-price">${esc(h.nightly || (fmtMoney(h.nightly_cents) ? fmtMoney(h.nightly_cents) + "/night" : ""))}</div>
    </div>
    <div class="tc-sub">${esc(h.city || "")}${h.area ? " · " + esc(h.area) : ""}${h.rating ? " · ★ " + esc(h.rating) : ""}</div>
    <button class="tc-book">Book this hotel</button>`;
  el.querySelector(".tc-book").addEventListener("click", () =>
    sendText(`Book ${h.name} for ${h.nightly || fmtMoney(h.nightly_cents) + "/night"}.`)
  );
  return el;
}

function renderCards(items, makeCard) {
  clearWelcome();
  const wrap = document.createElement("div");
  wrap.className = "tcards";
  items.forEach((it) => wrap.appendChild(makeCard(it)));
  chat.appendChild(wrap);
  scrollDown();
}

// Track in-flight payments so get_request / claim can update the right card.
const payments = {};       // request_id -> { merchant, amount_cents, el, statusEl }
let lastPaymentInput = null;
let lastReqId = null;      // most recent request_id seen on a get_request/claim call

function approvalCard({ request_id, approval_url, merchant, amount_cents }) {
  clearWelcome();
  const el = document.createElement("div");
  el.className = "approval-card";
  const amt = fmtMoney(amount_cents);
  el.innerHTML = `
    <div class="ap-head"><span class="ap-shield">🛡️</span> Approval required</div>
    <div class="ap-body">
      <div class="ap-amt">${amt ? esc(amt) : ""}</div>
      <div class="ap-merch">to ${esc(merchant || "merchant")}</div>
      <div class="ap-note">A single-use virtual card, locked to this merchant. Approve with your passkey to release it.</div>
    </div>
    <a class="ap-btn" target="_blank" rel="noopener">🔐 Approve with passkey</a>
    <div class="ap-status"><span class="ap-dot"></span> Waiting for your approval…</div>`;
  const btn = el.querySelector(".ap-btn");
  if (approval_url) btn.href = approval_url;
  else { btn.textContent = "Approval link unavailable"; btn.classList.add("disabled"); }
  chat.appendChild(el);
  scrollDown();
  if (request_id) payments[request_id] = { merchant, amount_cents, el, statusEl: el.querySelector(".ap-status") };
}

function setApprovalStatus(request_id, state, reason) {
  const p = payments[request_id];
  if (!p) return;
  const s = p.statusEl;
  if (state === "success") {
    s.innerHTML = `<span class="ap-check">✓</span> Approved`;
    s.classList.add("ok");
    p.el.classList.add("approved");
  } else if (state === "denied") {
    s.innerHTML = `<span class="ap-x">✕</span> Declined${reason ? " — " + esc(reason) : ""}`;
    s.classList.add("bad");
  } else if (state === "error") {
    s.innerHTML = `<span class="ap-x">✕</span> Error${reason ? " — " + esc(reason) : ""}`;
    s.classList.add("bad");
  }
}

function bookingCard({ merchant, card }) {
  clearWelcome();
  const el = document.createElement("div");
  el.className = "booking-card";
  const brand = card.brand ? String(card.brand).toUpperCase() : "CARD";
  const last4 = card.last4 || "••••";
  const expiry = card.expiry ? ` · exp ${esc(card.expiry)}` : "";
  el.innerHTML = `
    <div class="bk-head"><span class="bk-check">✓</span> Booked</div>
    <div class="bk-sub">${merchant ? "Paid " + esc(merchant) : "Payment complete"}</div>
    <div class="bk-card">
      <div class="bk-card-brand">${esc(brand)}</div>
      <div class="bk-card-num">•••• •••• •••• ${esc(last4)}${expiry}</div>
      <div class="bk-card-tag">one-time · merchant-scoped${merchant ? " · locked to " + esc(merchant) : ""}</div>
    </div>`;
  chat.appendChild(el);
  scrollDown();
}

// Find the first present key (searching nested objects) — Paylink output shapes
// aren't fully documented, so be liberal about where fields live.
function deepFind(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 5) return undefined;
  for (const k of keys) if (obj[k] != null && typeof obj[k] !== "object") return obj[k];
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = deepFind(v, keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function extractCard(out) {
  const number = deepFind(out, ["pan", "card_number", "cardNumber", "number"]);
  let last4 = deepFind(out, ["last4", "last_four", "lastFour"]);
  if (!last4 && number) last4 = String(number).replace(/\D/g, "").slice(-4);
  const brand = deepFind(out, ["brand", "network", "scheme", "card_brand"]);
  const expMonth = deepFind(out, ["exp_month", "expMonth", "expiry_month"]);
  const expYear = deepFind(out, ["exp_year", "expYear", "expiry_year"]);
  let expiry = deepFind(out, ["expiry", "exp", "expiration"]);
  if (!expiry && expMonth && expYear) expiry = `${String(expMonth).padStart(2, "0")}/${String(expYear).slice(-2)}`;
  return { last4, brand, expiry };
}

function statusOf(out) {
  return deepFind(out, ["status", "state"]);
}

// --- tool event handling ---------------------------------------------------

function handleToolStart(evt) {
  if (evt.name === "paylink__request_payment") {
    lastPaymentInput = evt.input || {};
  }
  if (evt.name === "paylink__get_request" || evt.name === "paylink__claim_payment_credentials") {
    const rid = evt.input?.request_id || evt.input?.requestId || evt.input?.id;
    if (rid) lastReqId = rid;
  }
  // Only surface meaningful steps; hide internal meta-tools (e.g. ToolSearch).
  const label = TOOL_LABELS[evt.name];
  if (label) addChip(label);
}

function handleToolResult(evt) {
  const out = evt.output;
  if (evt.isError) { addMsg("bot", `⚠︎ ${evt.name} failed`); return; }

  if (evt.name === "travel__search_flights") {
    const r = out?.results || out;
    if (Array.isArray(r) && r.length) renderCards(r, flightCard);
    return;
  }
  if (evt.name === "travel__search_hotels") {
    const r = out?.results || out;
    if (Array.isArray(r) && r.length) renderCards(r, hotelCard);
    return;
  }
  if (evt.name === "paylink__request_payment") {
    const approval_url = deepFind(out, ["approval_url", "approvalUrl", "url"]);
    const request_id = deepFind(out, ["request_id", "requestId", "id"]);
    const st = statusOf(out);
    if (approval_url || st === "pending_approval") {
      approvalCard({
        request_id,
        approval_url,
        merchant: lastPaymentInput?.merchant,
        amount_cents: lastPaymentInput?.amount_cents,
      });
    } else if (st === "denied") {
      addMsg("bot", "⚠︎ Payment was declined.");
    }
    return;
  }
  if (evt.name === "paylink__get_request") {
    const st = statusOf(out);
    const reason = deepFind(out, ["reason", "message"]);
    if (lastReqId && (st === "success" || st === "denied" || st === "error")) {
      setApprovalStatus(lastReqId, st, reason);
    }
    return;
  }
  if (evt.name === "paylink__claim_payment_credentials") {
    const merchant = (lastReqId && payments[lastReqId]?.merchant) || lastPaymentInput?.merchant;
    bookingCard({ merchant, card: extractCard(out) });
    return;
  }
  // list_credentials and anything else: no card, the start chip is enough.
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// --- composer / input ------------------------------------------------------

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
});

form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});

resetBtn.addEventListener("click", () => {
  sessionId = null;
  sessionStorage.removeItem("ma_session");
  chat.innerHTML = "";
  lastChip = null;
  welcome();
});

const saveBtn = document.getElementById("save");
saveBtn.addEventListener("click", async () => {
  const t = tokenInput.value.trim();
  if (!t) return;
  saveBtn.disabled = true;
  gateErr.textContent = "Connecting…";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch("/api/ping?token=" + encodeURIComponent(t), { cache: "no-store", signal: ctl.signal });
    clearTimeout(timer);
    if (r.status === 401) { gateErr.textContent = "Token rejected (HTTP 401)."; return; }
    if (!r.ok) { gateErr.textContent = "Server returned HTTP " + r.status + "."; return; }
    token = t;
    try { localStorage.setItem("ma_token", t); } catch (_) {}
    gate.hidden = true;
    gate.style.display = "none";
    try { welcome(); } catch (_) {}
  } catch (e) {
    clearTimeout(timer);
    gateErr.textContent = "FAIL: " + (e?.name || "") + " — " + (e?.message || String(e));
  } finally {
    saveBtn.disabled = false;
  }
});

function sendText(text) {
  input.value = text;
  send();
}

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  if (!token) return showGate(true);

  busy = true;
  sendBtn.disabled = true;
  addMsg("user", text);
  input.value = "";
  input.style.height = "auto";

  let thinkingEl = addMsg("bot thinking", "…");
  let cur = null;          // current streaming text bubble
  let gotAnything = false;
  const killThinking = () => { if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } };

  try {
    const resp = await fetch("/api/chat?token=" + encodeURIComponent(token), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, sessionId }),
    });

    if (resp.status === 401) { killThinking(); showGate(true, "Token rejected. Try again."); return; }
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() || "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const evt = JSON.parse(line.slice(6));

        if (evt.type === "text") {
          gotAnything = true;
          if (!cur) {
            if (thinkingEl) { cur = thinkingEl; thinkingEl = null; cur.className = "msg bot"; cur.textContent = ""; cur._acc = ""; }
            else cur = addMsg("bot");
          }
          cur._acc = (cur._acc || "") + evt.delta;
          cur.textContent = cur._acc;
          scrollDown();
        } else if (evt.type === "tool") {
          killThinking();
          cur = null;            // next text starts a fresh bubble (keeps stream order)
          if (evt.phase === "result") { gotAnything = true; handleToolResult(evt); }
          else handleToolStart(evt);
        } else if (evt.type === "done") {
          if (evt.sessionId) { sessionId = evt.sessionId; sessionStorage.setItem("ma_session", sessionId); }
          if (!gotAnything) { killThinking(); addMsg("bot", evt.subtype === "success" ? "(done)" : `(${evt.subtype || "ended"})`); }
          killThinking();
        } else if (evt.type === "error") {
          killThinking(); cur = null;
          addMsg("bot", `⚠︎ ${evt.message}`);
        }
      }
    }
  } catch (err) {
    killThinking();
    addMsg("bot", `⚠︎ ${err.message || err}`);
  } finally {
    busy = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

// No service worker (avoids stale shell). Remove any a previous version installed.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  if (window.caches) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
}
