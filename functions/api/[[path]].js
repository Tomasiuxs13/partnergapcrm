// Catch-all for /api/* paths that have no function yet (spec 6.3.15).
// Specific function routes take precedence over this file. The front end's api.request()
// treats unavailable:true as "Not available yet" instead of an error.

export function onRequest() {
  return new Response(JSON.stringify({ error: "Not available yet", unavailable: true }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}
