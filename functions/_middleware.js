// Password login for the whole dashboard site.
// The password lives in the Pages secret DASHBOARD_PASSWORD (Settings > Variables and Secrets).
// Without it the site stays locked: nobody can sign in until the secret is set.

const COOKIE = "pg_session";
const MAX_AGE = 30 * 24 * 3600; // stay signed in for 30 days
const enc = new TextEncoder();

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Compares two strings without leaking where they differ.
async function same(a, b) {
  const [x, y] = await Promise.all([hmac("cmp", a), hmac("cmp", b)]);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

async function makeToken(secret) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  return exp + "." + (await hmac(secret, "session:" + exp));
}

async function validToken(secret, token) {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || +exp < Date.now() / 1000) return false;
  return same(sig, await hmac(secret, "session:" + exp));
}

function readCookie(req, name) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : "";
}

function safeNext(v) {
  return typeof v === "string" && /^\/(?!\/)[\w\-./#?=&%]*$/.test(v) ? v : "/";
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function page(msg, next, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · PartnerGap Affiliate Pipeline</title><meta name="robots" content="noindex">
<style>
:root{color-scheme:dark;--bg:#0a0f1c;--tile:#111a2e;--tile2:#142038;--line:rgba(148,170,210,.18);--text:#e7edf7;--muted:#93a1bb;--cyan:#3fd8ee;--amber:#f6b44c;--rose:#f2727f}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font:15px/1.45 Manrope,"Segoe UI",system-ui,-apple-system,sans-serif;color:var(--text);display:grid;place-items:center;padding:24px 16px;
background:radial-gradient(900px 500px at 85% -10%,rgba(63,216,238,.10),transparent 60%),radial-gradient(700px 400px at -10% 110%,rgba(246,180,76,.08),transparent 60%),var(--bg)}
form{width:100%;max-width:380px;background:linear-gradient(180deg,var(--tile2),var(--tile));border:1px solid var(--line);border-radius:18px;padding:28px 24px;display:grid;gap:16px}
.b{display:flex;align-items:center;gap:12px}.logo{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(140deg,rgba(63,216,238,.25),rgba(246,180,76,.18));border:1px solid var(--line)}
h1{margin:0;font-size:19px;font-weight:800}p{margin:0;color:var(--muted);font-size:13px}
label{display:grid;gap:6px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
input{font:inherit;font-size:16px;color:var(--text);background:#0d1426;border:1px solid var(--line);border-radius:12px;padding:12px 14px}
input:focus{outline:2px solid var(--cyan);outline-offset:1px}
button{font:inherit;font-weight:700;font-size:15px;padding:12px;border:0;border-radius:12px;cursor:pointer;color:#05202a;background:linear-gradient(180deg,#5fe3f4,#2fc4dc)}
button:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
.err{color:var(--rose);font-size:13px;font-weight:600}
</style></head><body>
<form method="post" action="/login">
<div class="b"><div class="logo" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3fd8ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.6 10.6l6.8-3.2M8.6 13.4l6.8 3.2"/></svg></div>
<div><h1>Affiliate Pipeline</h1><p>PartnerGap team sign-in</p></div></div>
${msg ? `<div class="err" role="alert">${esc(msg)}</div>` : ""}
<label>Password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit">Sign in</button>
</form></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

// Sign-in is switched off for now (Jonas, 2026-10-08): everyone with the link can open the site.
// Set this back to true to require the DASHBOARD_PASSWORD again.
const LOGIN_ENABLED = false;

export async function onRequest(ctx) {
  const { request, env, next } = ctx;
  const url = new URL(request.url);

  if (!LOGIN_ENABLED) {
    if (url.pathname === "/login" || url.pathname === "/logout") return Response.redirect(new URL("/", url), 302);
    const res = await next();
    const out = new Response(res.body, res);
    out.headers.set("X-Robots-Tag", "noindex");
    return out;
  }
  const secret = env.DASHBOARD_PASSWORD;

  if (url.pathname === "/logout") {
    return new Response(null, { status: 302, headers: { Location: "/login", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
  }

  if (url.pathname === "/login") {
    if (!secret) return page("Sign-in is not set up yet. Ask Tomas to add the DASHBOARD_PASSWORD secret in Cloudflare Pages.", "/", 503);
    if (request.method === "POST") {
      const form = await request.formData();
      const nextUrl = safeNext(form.get("next"));
      if (await same(String(form.get("password") || ""), secret)) {
        return new Response(null, { status: 303, headers: { Location: nextUrl, "Set-Cookie": `${COOKIE}=${await makeToken(secret)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax` } });
      }
      await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      return page("Wrong password. Try again.", nextUrl, 401);
    }
    return page("", safeNext(url.searchParams.get("next")));
  }

  if (secret && (await validToken(secret, readCookie(request, COOKIE)))) {
    const res = await next();
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "private, no-store");
    out.headers.set("X-Robots-Tag", "noindex");
    return out;
  }

  if (url.pathname.startsWith("/api/")) return new Response("Sign in required", { status: 401 });
  return new Response(null, { status: 302, headers: { Location: "/login?next=" + encodeURIComponent(url.pathname + url.search) } });
}
