// Worker in front of the static site in ./public.
//   /demo, /demo/*  the same site in demo mode (the page loads demo-data.json, no Apps Script calls)
//   everything else static assets, unchanged
// Login and the data proxy are added in later phases.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/demo') return Response.redirect(url.origin + '/demo/' + url.search, 302);
    if (url.pathname.startsWith('/demo/')) return demoAsset(request, env, url);
    return env.ASSETS.fetch(request);
  }
};

// /demo/<file> serves /<file>. The page sees /demo in its path and switches to demo mode;
// relative links (rsc-logo.png, demo-data.json) stay under /demo/.
function demoAsset(request, env, url) {
  const u = new URL(url);
  u.pathname = url.pathname.slice('/demo'.length).replace(/\/index\.html$/, '/');
  return env.ASSETS.fetch(new Request(u, request));
}
