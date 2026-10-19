// POST /api/partner/:id/outcome: golden PATCH rows, then the golden activity row (spec 6.3.3). G0 stub; owner G1-B.
// Until it is built it answers exactly like the catch-all functions/api/[[path]].js.

export function onRequest() {
  return new Response(JSON.stringify({ error: "Not available yet", unavailable: true }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}
