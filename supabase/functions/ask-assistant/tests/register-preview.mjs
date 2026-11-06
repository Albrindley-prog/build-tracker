// Used by local-preview.mjs. Same as register.mjs, plus: if a real AI key is in the
// private file supabase/functions/ask-assistant/.env (git-ignored, never published), the
// preview talks to the real AI instead of a stand-in:
//   ANTHROPIC_API_KEY=sk-ant-...   -> real Claude (needs the library in ./real-sdk)
//   GEMINI_API_KEY=AIza... or AQ.... -> real Google Gemini (nothing to install)
import { register } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Read KEY=value lines from .env (without overriding anything already set).
const envFile = path.join(here, "..", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const claudeKey = process.env.ANTHROPIC_API_KEY ?? "";
const geminiKey = process.env.GEMINI_API_KEY ?? "";
const hasClaude = /^sk-ant-/.test(claudeKey);
// Google keys come in more than one style (older ones start AIza, newer ones AQ.), so only
// check it looks like a key: reasonably long, with no spaces.
const hasGemini = geminiKey.length >= 20 && !/\s/.test(geminiKey);
const sdkInstalled = fs.existsSync(path.join(here, "real-sdk", "node_modules", "@anthropic-ai", "sdk"));
const wanted = !["local", "canned"].includes(process.env.PREVIEW_AI ?? "");

if (claudeKey && !hasClaude) console.log("Note: ANTHROPIC_API_KEY doesn't look like an Anthropic key (they start with sk-ant-). Ignoring it.");
if (geminiKey && !hasGemini) console.log("Note: GEMINI_API_KEY doesn't look like a Google key (it should be one long piece with no spaces). Ignoring it.");
if (hasClaude && !sdkInstalled && !hasGemini) {
  console.log("A Claude key was found, but the Claude library isn't installed yet. Run: npm install --prefix supabase/functions/ask-assistant/tests/real-sdk");
}

// Which real AI to use: the one asked for with ASSISTANT_PROVIDER, otherwise Claude if it
// can run, otherwise Gemini (the same order the function itself uses).
const forced = (process.env.ASSISTANT_PROVIDER ?? "").trim().toLowerCase();
let provider = "";
if (wanted) {
  if (forced === "gemini") provider = hasGemini ? "gemini" : "";
  else if (forced === "claude") provider = hasClaude && sdkInstalled ? "claude" : "";
  else if (hasClaude && sdkInstalled) provider = "claude";
  else if (hasGemini) provider = "gemini";
}

process.env.PREVIEW_REAL_AI = provider; // "claude", "gemini" or "" (stand-in)
if (provider) process.env.ASSISTANT_PROVIDER = provider;
register("./hooks.mjs", import.meta.url, { data: { realSdk: provider === "claude" } });
