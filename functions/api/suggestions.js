// GET /api/suggestions: daily-run suggestions (spec 6.3.12). G0 stub; owner B1.
// Until it is built it answers exactly like the catch-all functions/api/[[path]].js.

export function onRequest() {
  return new Response(JSON.stringify({ error: "Not available yet", unavailable: true }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}
