// Stand-in for the product's bundled Worker module.
export default {
  async fetch(request, env) {
    const key = new URL(request.url).pathname.slice(1);
    if (!key) return new Response('ok');
    const object = await env.UploadsBucket.get(key);
    return object ? new Response(object.body) : new Response('not found', { status: 404 });
  },
};
