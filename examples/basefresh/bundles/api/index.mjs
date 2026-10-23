// Stand-in for the product's esbuild output: an API Gateway v2 handler.
export const handler = async (event) => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ok: true, path: event.rawPath }),
});
