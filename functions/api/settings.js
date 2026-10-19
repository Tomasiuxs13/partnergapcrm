// GET/PUT /api/settings: team and client overrides in kv_meta (D1-only) (spec 6.3.11). G0 stub; owner B1.
// Until it is built it answers exactly like the catch-all functions/api/[[path]].js.

export function onRequest() {
  return new Response(JSON.stringify({ error: "Not available yet", unavailable: true }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}
