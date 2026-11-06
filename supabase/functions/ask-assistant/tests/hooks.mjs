// Test helper: the function imports Claude's SDK as "npm:@anthropic-ai/sdk@…" (Deno style).
// Node doesn't understand that, so we map it:
//   - normally (the automated tests) to a tiny stand-in, so no key or internet is needed;
//   - for the local preview with a real key, to the real library in ./real-sdk.
let useReal = false;

export async function initialize(data) {
  useReal = Boolean(data && data.realSdk);
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("npm:@anthropic-ai/sdk")) {
    if (useReal) {
      return next("@anthropic-ai/sdk", { ...context, parentURL: new URL("./real-sdk/x.js", import.meta.url).href });
    }
    return { url: new URL("./stub-anthropic.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
