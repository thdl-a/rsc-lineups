// Pass-through Worker: serves the static site in ./public exactly as before.
// Login, data proxy and demo mode are added in later phases.
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  }
};
