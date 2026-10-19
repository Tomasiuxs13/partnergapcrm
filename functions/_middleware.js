// Password login for the whole dashboard site, the read-only guard for preview hosts, and caching
// headers (spec 6.3.14, 2.2.8, D4, D12).
// The password lives in the Pages secret DASHBOARD_PASSWORD (Settings > Variables and Secrets).
// Without it the site stays locked: nobody can sign in until the secret is set (503 page).
//
// - Read-only guard: every host except the production host (env PROD_HOST, default
//   partnergap-crm.pages.dev), localhost and 127.0.0.1 is read-only, and so is any host while
//   READ_ONLY=1. Branch previews (*.partnergap-crm.pages.dev) are therefore read-only. The answer is on
//   ctx.data.readOnly, and every non-GET /api/* request on a read-only host gets
//   403 {"error":"This copy is read-only."} before it reaches a handler.
// - Sign-in form: password, "Your name" (the team list from lib/meta.js with the Settings overrides, plus
//   "Someone else", which shows a text field), and "Don't know the password? Ask Jonas." Signing in sets
//   pg_me (the name, readable by the page) next to the HttpOnly session cookie; the page's inline script
//   also writes localStorage pgcrm-me, so the name picked here always wins. A request without "who" (an
//   API client) signs in without a name.
// - The deep-link hash survives sign-in: the login page puts it in next as /?h=<encoded hash>, and the
//   app puts it back (js/core/router.js).
// - /logout ends the session and shows /login?bye=1, whose script clears the page's Cache Storage list.
// - Caching: /api/* private, no-store; pages and static files private, no-cache. X-Robots-Tag: noindex.
// - Local test aid: on localhost/127.0.0.1 only, a request with the header X-PGCRM-Count: 1 gets
//   X-D1-Statements (the D1 statements it ran), for the contract test's Free-plan budget check (spec 6.6).
import { isReadOnlyHost, baseMeta } from "../lib/meta.js";
import { readOverrides, mergeTeam } from "../lib/settings.js";

const COOKIE = "pg_session";
const ME_COOKIE = "pg_me";
const MAX_AGE = 30 * 24 * 3600; // stay signed in for 30 days
const OTHER = "__other";
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
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]);
  } catch (e) {
    return m[1];
  }
}

function safeNext(v) {
  return typeof v === "string" && /^\/(?!\/)[\w\-./#?=&%]*$/.test(v) ? v : "/";
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// A typed name ("Someone else"): 2-40 characters, letters, spaces, ' and -.
function cleanName(v) {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 40) return "";
  if (!/^[\p{L}\p{M}' ’-]+$/u.test(s) || (s.match(/\p{L}/gu) || []).length < 2) return "";
  return s;
}

// The names on the sign-in form: the team list with the Settings overrides, active names only, A to Z.
async function teamNames(db) {
  let team = baseMeta().team;
  if (db) {
    try {
      team = mergeTeam(team, (await readOverrides(db)).team);
    } catch (e) {
      // keep the built-in list
    }
  }
  return team.filter((m) => m && m.name && m.active !== false).map((m) => m.name).sort((a, b) => a.localeCompare(b));
}

const LOGO = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.6 10.6l6.8-3.2M8.6 13.4l6.8 3.2"/></svg>`;

// The sign-in page. o: {msg, note, next, names, who, other, status, field, form}. field = the input the
// error is about ("password" or "who"): it gets aria-invalid and the focus. form: false shows no form (503).
function page({ msg = "", note = "", next = "/", names = [], who = "", other = "", status = 200, field = "", form = true } = {}) {
  const known = !!who && names.includes(who);
  const pickOther = who === OTHER || (!!who && !known);
  const otherVal = who === OTHER ? other : pickOther ? who : other;
  const options = names.map((n) => `<option${known && n === who ? " selected" : ""}>${esc(n)}</option>`).join("");
  const bad = (f) => (field === f ? ` aria-invalid="true" aria-describedby="err"` : "");
  const focus = (f) => ((field || "password") === f ? " autofocus" : "");
  const body = form
    ? `<form method="post" action="/login" novalidate>
<div class="b"><div class="logo" aria-hidden="true">${LOGO}</div><div><h1>PartnerGap CRM</h1><p>Team sign-in</p></div></div>
${msg ? `<div class="err" id="err" role="alert">${esc(msg)}</div>` : ""}${note ? `<div class="note" role="status">${esc(note)}</div>` : ""}
<label>Password<input type="password" name="password" autocomplete="current-password" required${bad("password")}${focus("password")}></label>
<label>Your name<select name="who" required${pickOther ? "" : bad("who") + focus("who")}>
<option value=""${known || pickOther ? "" : " selected"} disabled>Pick your name</option>${options}
<option value="${OTHER}"${pickOther ? " selected" : ""}>Someone else (type your name)</option></select></label>
<label id="other"${pickOther ? "" : " hidden"}>Type your name<input type="text" name="who_other" maxlength="40" autocomplete="name" value="${esc(otherVal)}"${pickOther ? bad("who") + focus("who") : " disabled"}><span class="hint">Your edits are signed with this name.</span></label>
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit">Sign in</button>
<p class="foot">Don't know the password? Ask Jonas.</p>
</form>`
    : `<div class="box"><div class="b"><div class="logo" aria-hidden="true">${LOGO}</div><div><h1>PartnerGap CRM</h1><p>Team sign-in</p></div></div>
<div class="err" role="alert">${esc(msg)}</div></div>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · PartnerGap CRM</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{color-scheme:light;--bg:#f5f8fa;--tile:#fff;--line:#dfe3eb;--field:#cbd6e2;--text:#213343;--muted:#516f90;--acc:#ff5c35;--acc-d:#e8401c;--rose:#d9364f;--ok:#00806e;--focus:#00a4bd}
*{box-sizing:border-box}html,body{margin:0}
body{font:15px/1.45 "Lexend Deca","Segoe UI",system-ui,-apple-system,sans-serif;color:var(--text);display:grid;place-items:center;padding:24px 16px;background:var(--bg);min-height:100vh}
form,.box{width:100%;max-width:380px;background:var(--tile);border:1px solid var(--line);border-radius:8px;padding:28px 24px;display:grid;gap:16px;box-shadow:0 8px 24px -12px rgba(33,51,67,.25)}
.b{display:flex;align-items:center;gap:12px}.logo{width:40px;height:40px;border-radius:8px;display:grid;place-items:center;background:var(--acc);flex:none}
h1{margin:0;font-size:19px;font-weight:600}p{margin:0;color:var(--muted);font-size:13px}
label{display:grid;gap:6px;font-size:13px;font-weight:600;color:var(--text)}
.hint{font-weight:400;color:var(--muted);font-size:12px}
input,select{font:inherit;font-size:16px;font-weight:400;color:var(--text);background-color:#fff;border:1px solid var(--field);border-radius:6px;padding:10px 12px;min-height:44px;width:100%}
select{appearance:none;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23516f90' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:36px}
select:invalid{color:var(--muted)}option{color:var(--text)}
input:focus,select:focus{outline:2px solid var(--focus);outline-offset:1px}
[aria-invalid=true]{border-color:var(--rose)}
button{font:inherit;font-weight:600;font-size:15px;min-height:44px;padding:10px 12px;border:0;border-radius:6px;cursor:pointer;color:#fff;background:var(--acc)}
button:hover{background:var(--acc-d)}
button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.err{color:var(--rose);font-size:13px;font-weight:600}
.note{color:var(--ok);font-size:13px;font-weight:600}
.foot{text-align:center}
[hidden]{display:none!important}
</style></head><body>
${body}
<script>
(function(){
  if(/[?&]bye=1(&|$)/.test(location.search)){
    try{localStorage.removeItem("pgcrm-cache-etag");}catch(e){}
    try{if(window.caches)caches.delete("pgcrm");}catch(e){}
  }
  var f=document.forms[0];
  if(!f)return;
  var s=f.elements.who,o=f.elements.who_other,box=document.getElementById("other"),n=f.elements.next;
  function sync(){var on=s.value==="${OTHER}";box.hidden=!on;o.disabled=!on;o.required=on;}
  s.addEventListener("change",function(){sync();if(s.value==="${OTHER}")o.focus();});
  sync();
  var h=location.hash;
  if(h&&h!=="#"&&!/[?&]h=/.test(n.value)){
    var e=encodeURIComponent(h).replace(/[!'()*~]/g,function(c){return "%"+c.charCodeAt(0).toString(16).toUpperCase();});
    n.value=n.value+(n.value.indexOf("?")<0?"?":"&")+"h="+e;
  }
  // The same checks as the server, before the password is sent (a refused form comes back without it).
  function stop(ev,el,msg){
    ev.preventDefault();
    var e=document.getElementById("err");
    if(!e){e=document.createElement("div");e.id="err";e.className="err";e.setAttribute("role","alert");f.insertBefore(e,f.querySelector("label"));}
    e.textContent=msg;
    [f.elements.password,s,o].forEach(function(x){x.removeAttribute("aria-invalid");});
    el.setAttribute("aria-invalid","true");el.setAttribute("aria-describedby","err");el.focus();
  }
  f.addEventListener("submit",function(ev){
    var other=s.value==="${OTHER}",who=other?o.value.replace(/\\s+/g," ").trim():s.value;
    if(!f.elements.password.value)return stop(ev,f.elements.password,"Type the password.");
    if(!other&&!who)return stop(ev,s,"Pick your name from the list, or Someone else.");
    if(other&&(who.length<2||who.length>40||!/^[\\p{L}\\p{M}' \u2019-]+$/u.test(who)||(who.match(/\\p{L}/gu)||[]).length<2))
      return stop(ev,o,"Type your name: 2\u201340 letters (spaces, ' and - are fine).");
    try{localStorage.setItem("pgcrm-me",JSON.stringify(who));}catch(e){}
  });
})();
</script>
</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

function jsonError(error, status) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" },
  });
}

// The request's host name, without the port. The Host header is what Cloudflare routes on.
function hostOf(request, url) {
  return String(request.headers.get("Host") || url.host || "").toLowerCase().replace(/:\d+$/, "");
}

const isLocal = (host) => host === "localhost" || host === "127.0.0.1";

// Counts D1 statements for one request (local hosts only, on request; see the header comment).
// Each first/all/run/raw call counts 1, each batch counts its statements.
function countingDb(db, box) {
  const real = new WeakMap();
  const wrap = (st) => {
    const p = new Proxy(st, {
      get(t, k) {
        if (k === "bind") return (...a) => wrap(t.bind(...a));
        const v = Reflect.get(t, k, t);
        if (k === "first" || k === "all" || k === "run" || k === "raw") return (...a) => { box.n++; return v.apply(t, a); };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    real.set(p, st);
    return p;
  };
  return new Proxy(db, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (k === "prepare") return (sql) => wrap(t.prepare(sql));
      if (k === "batch") return (list) => { box.n += list.length; return t.batch(list.map((s) => real.get(s) || s)); };
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

// Sign-in is on (Jonas, 2026-10-09) because partner profiles show contact emails.
// Setting this to false opens the whole site, emails included, to anyone with the link.
const LOGIN_ENABLED = true;

function finish(res, path) {
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", path.startsWith("/api/") ? "private, no-store" : "private, no-cache");
  out.headers.set("X-Robots-Tag", "noindex");
  return out;
}

export async function onRequest(ctx) {
  const { request, env, next } = ctx;
  const url = new URL(request.url);
  const host = hostOf(request, url);
  const readOnly = isReadOnlyHost(env, host);
  if (ctx.data && typeof ctx.data === "object") ctx.data.readOnly = readOnly;
  const isApi = url.pathname.startsWith("/api/");
  const writing = isApi && request.method !== "GET" && request.method !== "HEAD";
  // Preview hosts never write: a pushed branch can't change production data (D12).
  if (writing && readOnly) return jsonError("This copy is read-only.", 403);
  // Edits only come from the CRM's own pages, and only while sign-in is on.
  if (writing) {
    if (!LOGIN_ENABLED) return new Response("Editing needs sign-in to be on", { status: 403 });
    const origin = request.headers.get("Origin");
    const site = request.headers.get("Sec-Fetch-Site");
    if ((origin && origin !== url.origin) || (!origin && site && site !== "same-origin")) return new Response("Forbidden", { status: 403 });
  }

  if (url.pathname === "/favicon.ico") return new Response(null, { status: 302, headers: { Location: "/favicon.svg" } });
  // The sign-in page shows the icon too.
  if (url.pathname === "/favicon.svg" && (request.method === "GET" || request.method === "HEAD")) return finish(await next(), url.pathname);

  if (!LOGIN_ENABLED) {
    if (url.pathname === "/login" || url.pathname === "/logout") return Response.redirect(new URL("/", url), 302);
    return finish(await next(), url.pathname);
  }
  // Trim so a stray space or line break saved with the secret does not lock everyone out.
  const secret = (env.DASHBOARD_PASSWORD || "").trim();

  if (url.pathname === "/logout") {
    return new Response(null, { status: 302, headers: { Location: "/login?bye=1", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
  }

  if (url.pathname === "/login") {
    if (!secret) {
      return page({ msg: "Sign-in is not set up yet. Add the DASHBOARD_PASSWORD secret to the partnergap-crm Pages project in Cloudflare.", status: 503, form: false });
    }
    const db = env.PARTNERS_DB;
    if (request.method === "POST") {
      const f = await request.formData();
      const nextUrl = safeNext(f.get("next"));
      const hasWho = f.has("who");
      const pick = String(f.get("who") || "");
      const other = String(f.get("who_other") || "");
      const names = await teamNames(db);
      const again = (msg, field, status) => page({ msg, next: nextUrl, names, who: pick, other, status, field });
      if (!(await same(String(f.get("password") || "").trim(), secret))) {
        await new Promise((r) => setTimeout(r, 800)); // slow down guessing
        return again("Wrong password. Try again.", "password", 401);
      }
      let name = "";
      if (hasWho) {
        if (pick === OTHER) {
          name = cleanName(other);
          if (!name) return again("Type your name: 2–40 letters (spaces, ' and - are fine).", "who", 400);
        } else if (names.includes(pick)) {
          name = pick;
        } else {
          return again("Pick your name from the list, or Someone else.", "who", 400);
        }
      }
      const headers = new Headers({ Location: nextUrl, "Cache-Control": "no-store" });
      headers.append("Set-Cookie", `${COOKIE}=${await makeToken(secret)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
      if (name) headers.append("Set-Cookie", `${ME_COOKIE}=${encodeURIComponent(name)}; Path=/; Max-Age=${MAX_AGE}; Secure; SameSite=Lax`);
      return new Response(null, { status: 303, headers });
    }
    const bye = url.searchParams.get("bye") === "1";
    return page({ note: bye ? "You're signed out." : "", next: safeNext(url.searchParams.get("next")), names: await teamNames(db),
      who: readCookie(request, ME_COOKIE).slice(0, 40) });
  }

  if (secret && (await validToken(secret, readCookie(request, COOKIE)))) {
    if (isApi && isLocal(host) && request.headers.get("X-PGCRM-Count") === "1" && env.PARTNERS_DB) {
      const box = { n: 0 };
      const db = env.PARTNERS_DB;
      env.PARTNERS_DB = countingDb(db, box);
      try {
        const out = finish(await next(), url.pathname);
        out.headers.set("X-D1-Statements", String(box.n));
        return out;
      } finally {
        env.PARTNERS_DB = db;
      }
    }
    return finish(await next(), url.pathname);
  }

  if (isApi) return new Response("Sign in required", { status: 401 });
  return new Response(null, { status: 302, headers: { Location: "/login?next=" + encodeURIComponent(url.pathname + url.search) } });
}
