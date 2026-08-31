#!/usr/bin/env node
// Paylink OAuth 2.1 + PKCE helper.
//
//   node paylink-auth.mjs           → run the full browser login, save .paylink-token.json
//   node paylink-auth.mjs --refresh → silently refresh the access token (no browser)
//   node paylink-auth.mjs --print   → print a valid access token to stdout (refresh if needed)
//
// Paylink is a public OAuth client (token_endpoint_auth_method: "none") with dynamic
// client registration, so there's no secret to manage. The token file is gitignored.

import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ISSUER = process.env.PAYLINK_ISSUER || "https://api.paylink.sh";
const TOKEN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".paylink-token.json");
const CALLBACK_PORT = Number(process.env.PAYLINK_CALLBACK_PORT || 8788);
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const SCOPE = "mcp offline_access";

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function loadToken() {
  if (!existsSync(TOKEN_FILE)) return null;
  try { return JSON.parse(readFileSync(TOKEN_FILE, "utf8")); } catch { return null; }
}
function saveToken(obj) {
  writeFileSync(TOKEN_FILE, JSON.stringify(obj, null, 2));
}

async function discover() {
  const r = await fetch(`${ISSUER}/.well-known/oauth-authorization-server`);
  if (!r.ok) throw new Error(`discovery failed: HTTP ${r.status}`);
  return r.json();
}

async function registerClient(meta) {
  const r = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "TripPilot Demo",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
  });
  if (!r.ok) throw new Error(`client registration failed: HTTP ${r.status} ${await r.text()}`);
  return r.json(); // { client_id, ... }
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}

// Wait for the OAuth redirect on a tiny localhost server, return the auth code.
function awaitCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><meta charset=utf8><title>TripPilot</title>
        <body style="font:16px -apple-system,sans-serif;background:#0e0b1a;color:#ece9f6;display:grid;place-items:center;height:100vh;margin:0">
        <div style="text-align:center"><h2 style="color:#a78bfa">${err ? "Authorization failed" : "Paylink connected ✓"}</h2>
        <p>${err ? err : "You can close this tab and return to the terminal."}</p></div>`);
      server.close();
      if (err) return reject(new Error(`authorize error: ${err}`));
      if (state !== expectedState) return reject(new Error("state mismatch (possible CSRF)"));
      if (!code) return reject(new Error("no code in callback"));
      resolve(code);
    });
    server.on("error", reject);
    server.listen(CALLBACK_PORT, "127.0.0.1");
  });
}

async function exchangeToken(meta, params) {
  const r = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`token endpoint failed: HTTP ${r.status} ${JSON.stringify(body)}`);
  return body; // { access_token, refresh_token?, expires_in, token_type, scope }
}

function persist(tok, client_id) {
  const expires_at = tok.expires_in ? Date.now() + tok.expires_in * 1000 : null;
  const saved = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    expires_at,
    token_type: tok.token_type || "Bearer",
    scope: tok.scope || SCOPE,
    client_id,
    issuer: ISSUER,
  };
  saveToken(saved);
  return saved;
}

async function login() {
  const meta = await discover();
  const { client_id } = await registerClient(meta);

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  console.log("\n  Opening your browser to approve Paylink access…");
  console.log("  If it doesn't open, paste this URL:\n");
  console.log("  " + authUrl.toString() + "\n");
  const codeP = awaitCallback(state);
  openBrowser(authUrl.toString());
  const code = await codeP;

  const tok = await exchangeToken(meta, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id,
    code_verifier: verifier,
  });
  const saved = persist(tok, client_id);
  console.log(`\n  ✓ Saved token to .paylink-token.json${saved.refresh_token ? " (with refresh token)" : ""}.\n`);
  return saved;
}

async function refresh() {
  const cur = loadToken();
  if (!cur?.refresh_token) throw new Error("no refresh_token on file — run `node paylink-auth.mjs` to log in");
  const meta = await discover();
  const tok = await exchangeToken(meta, {
    grant_type: "refresh_token",
    refresh_token: cur.refresh_token,
    client_id: cur.client_id,
  });
  // Some servers omit a rotated refresh_token; keep the old one if so.
  if (!tok.refresh_token) tok.refresh_token = cur.refresh_token;
  return persist(tok, cur.client_id);
}

// Return a valid access token, refreshing (or prompting login) as needed.
export async function getAccessToken() {
  const cur = loadToken();
  const fresh = cur?.access_token && cur.expires_at && cur.expires_at - Date.now() > 60_000;
  if (fresh) return cur.access_token;
  if (cur?.refresh_token) {
    try { return (await refresh()).access_token; } catch (e) { console.error("  refresh failed:", e.message); }
  }
  return (await login()).access_token;
}

// CLI entry
if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  try {
    if (mode === "--refresh") { await refresh(); console.error("  ✓ refreshed"); }
    else if (mode === "--print") { process.stdout.write(await getAccessToken()); }
    else { await login(); }
    process.exit(0);
  } catch (e) {
    console.error("\n  ✗ " + e.message + "\n");
    process.exit(1);
  }
}
