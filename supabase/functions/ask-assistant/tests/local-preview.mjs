// Try the website chat on your own computer, without deploying anything to Supabase.
//
//   node --import ./supabase/functions/ask-assistant/tests/register-preview.mjs supabase/functions/ask-assistant/tests/local-preview.mjs
//   then open http://localhost:8093
//
// It serves the site and runs the REAL ask-assistant code (checks, limits, rules text).
// Which AI answers depends on what you have:
//   - a real key in the private file supabase/functions/ask-assistant/.env ->
//     the REAL AI answers: ANTHROPIC_API_KEY=sk-ant-... (needs the Claude library, see README)
//     for Claude, or GEMINI_API_KEY=AIza... for Google Gemini (nothing to install).
//     Questions go to Anthropic / Google and cost a fraction of a penny each;
//   - otherwise, if you have Ollama with llama3.1 installed, that small local AI answers (it
//     reads the same rules text, but is much weaker than Claude, and slow on a CPU);
//   - otherwise short canned replies labelled "Preview".
// Nothing is saved. A yellow note in the corner of the page says which one is answering.
// Set PREVIEW_AI=local or PREVIEW_AI=canned to skip the real Claude even if a key is present.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { handleRequest, defaultDeps } = await import("../index.ts");
// Set by register-preview.mjs: "claude" or "gemini" when a real key is present, else "".
const realAi = process.env.PREVIEW_REAL_AI || "";
const useClaude = realAi !== ""; // (name kept short: true for either real AI)

const PORT = Number(process.env.PORT || 8093);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ENDPOINT_PATH = "/functions/v1/ask-assistant";

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf", ".mp4": "video/mp4", ".woff2": "font/woff2",
};

/* ---- the pretend Claude ---- */
const TAG = "(Preview reply, not the real AI.) ";
function pretend(question) {
  const q = question.toLowerCase();
  const has = (...w) => w.some((x) => q.includes(x));
  let text;
  if (has("custom", "tailor", "modify", "bespoke", "adapt", "change the software", "suit our")) {
    text = "Yes, we would. We're happy to change our software to suit how your company works. Tell us what you need and email info@build-tracker.co.uk or phone 07931 095631 to talk it through.";
  } else if (has("xero", "sage", "quickbooks", "integrat", "connect to", "api", "gdpr", "secur", "seats", "users", "annual", "discount")) {
    text = "I'm not sure about that one, and I don't want to guess. Please email info@build-tracker.co.uk or phone 07931 095631 and we'll tell you properly.";
  } else if (has("buildos", "payroll", "payslip", "invoice", "hmrc", "paye")) {
    text = "BuildOS covers payroll, invoicing, expenses and HR admin for small UK businesses. It's 9.99 pounds a month with a 30-day free trial and no card needed. It produces drafts for you to check. It doesn't file with HMRC or make payments.";
  } else if (has("courtesy", "loan car")) {
    text = "Courtesy Car Manager keeps track of your loan cars: MOT, tax and insurance checks, hand-overs with photos and a signature, and returns. It's 9.99 pounds a month with a 30-day free trial, and it can be installed as a phone app.";
  } else if (has("cost", "price", "how much", "pay", "£", "pound")) {
    text = "Our main tools are 32 pounds per tool, per month, with a 30-day free trial and no card needed. Smaller tools start from 3.99 pounds a month and have their own trials.\n\nFull prices: https://build-tracker.co.uk/#pricing";
  } else if (has("trial", "free")) {
    text = "The main tools have a 30-day free trial, no card needed. Smaller tools have their own trial lengths: Build Tracker Cloud 14 days, Courtesy Car Manager and BuildOS 30 days.";
  } else if (has("install", "app", "phone", "download")) {
    text = "No app store needed. Use the Apps menu at the top of the page, or see https://build-tracker.co.uk/#get-the-app\n\n- Android: Chrome, Download the app, Install app\n- iPhone: Safari, Download the app, Share, Add to Home Screen\n- Computer: Chrome or Edge, Download the app, Install app";
  } else if (has("which", "recommend", "start", "should i", "garage", "workshop", "restor", "body")) {
    text = "It depends what you do day to day. Is it mostly repairs and estimates, scheduling jobs, tracking a restoration, or stock and parts? Tell me and I'll point you to the right tool.";
  } else if (has("stock")) {
    text = "Stock Control handles inventory, reorder levels, suppliers and costs for all your parts. It's 32 pounds a month with a 30-day free trial.";
  } else if (has("contact", "email", "phone", "call", "human", "person", "speak", "talk")) {
    text = "You can email info@build-tracker.co.uk or phone 07931 095631. We're based in Cheshire East.";
  } else if (has("hello", "hi ", "hey", "thanks", "thank")) {
    text = "Hello! Ask me about our tools, prices, free trials or the phone apps.";
  } else {
    text = "I can only help with questions about Build Tracker's software, such as tools, prices, trials and installing the apps. Is there something like that I can help with?";
  }
  return TAG + text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finalOf = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } });
const deltaOf = (text) => ({ type: "content_block_delta", delta: { type: "text_delta", text } });

const fakeClient = {
  messages: {
    create: async (params) => {
      await sleep(600); // feel like a real request
      const last = params.messages[params.messages.length - 1].content;
      const reply = pretend(last);
      console.log(`  Q: ${last}\n  A: ${reply}\n`);
      return finalOf(reply);
    },
    // Same thing, but a few words at a time, the way the real one arrives.
    stream: (params) => {
      const last = params.messages[params.messages.length - 1].content;
      const reply = pretend(last);
      console.log(`  Q: ${last}\n  A: ${reply}\n`);
      return {
        async *[Symbol.asyncIterator]() {
          await sleep(300);
          for (const word of reply.match(/\S+\s*/g) ?? []) {
            yield deltaOf(word);
            await sleep(35);
          }
        },
        finalMessage: async () => finalOf(reply),
      };
    },
  },
};

/* ---- a free local AI (Ollama) if you have one, so you can judge the style ---- */
// Not Claude, and much weaker, but it follows the same rules text, so you can see the
// friendly style and the "never make up company facts" behaviour. Set PREVIEW_AI=canned
// to skip it.
const OLLAMA = process.env.OLLAMA_URL || "http://localhost:11434";
const LOCAL_MODEL = process.env.PREVIEW_MODEL || "llama3.1:latest";
let localAi = false;
if (!useClaude && process.env.PREVIEW_AI !== "canned") {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    localAi = Boolean(j.models?.some((m) => m.name === LOCAL_MODEL));
  } catch { /* not running: use canned replies */ }
}

function ollamaBody(system, messages, extra = {}, stream = false) {
  return JSON.stringify({
    model: LOCAL_MODEL,
    stream,
    keep_alive: "60m",
    // The rules text is long, so give the model room to read all of it.
    options: { num_ctx: 8192, temperature: 0.7, num_predict: 250, ...extra },
    messages: [{ role: "system", content: system }, ...messages],
  });
}

// The local AI answers one question at a time and is slow, so an abandoned question
// (page reloaded, second tab, impatient re-send) would otherwise keep everything behind
// it waiting. In this preview the newest question always wins: starting a new one
// cancels the one before it.
let inFlight = null;
const localClient = {
  messages: {
    create: async (params) => {
      if (inFlight) inFlight.abort();
      const ctrl = new AbortController();
      inFlight = ctrl;
      const timer = setTimeout(() => ctrl.abort(), 170000);
      const system = params.system.map((s) => s.text).join("\n");
      const started = Date.now();
      try {
        const r = await fetch(`${OLLAMA}/api/chat`, {
          method: "POST",
          body: ollamaBody(system, params.messages),
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`local AI said HTTP ${r.status}`);
        const j = await r.json();
        const text = String(j.message?.content ?? "").trim();
        console.log(`  Q: ${params.messages.at(-1).content}\n  A (${LOCAL_MODEL}, ${((Date.now() - started) / 1000).toFixed(1)}s): ${text}\n`);
        return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };
      } catch (err) {
        if (ctrl.signal.aborted && inFlight !== ctrl) console.log(`  (dropped: "${params.messages.at(-1).content}" was replaced by a newer question)\n`);
        throw err;
      } finally {
        clearTimeout(timer);
        if (inFlight === ctrl) inFlight = null;
      }
    },
    // Words are passed on as the local AI writes them, so the chat shows them straight away.
    stream: (params, options = {}) => {
      if (inFlight) inFlight.abort();
      const ctrl = new AbortController();
      inFlight = ctrl;
      options.signal?.addEventListener("abort", () => ctrl.abort());
      const timer = setTimeout(() => ctrl.abort(), 170000);
      const system = params.system.map((s) => s.text).join("\n");
      const question = params.messages.at(-1).content;
      const started = Date.now();
      let firstWord = 0;
      let full = "";
      async function* events() {
        try {
          const r = await fetch(`${OLLAMA}/api/chat`, {
            method: "POST",
            body: ollamaBody(system, params.messages, {}, true),
            signal: ctrl.signal,
          });
          if (!r.ok || !r.body) throw new Error(`local AI said HTTP ${r.status}`);
          const reader = r.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              const piece = JSON.parse(line).message?.content ?? "";
              if (!piece) continue;
              if (!firstWord) firstWord = Date.now() - started;
              full += piece;
              yield deltaOf(piece);
            }
          }
          console.log(`  Q: ${question}\n  A (${LOCAL_MODEL}, first words after ${(firstWord / 1000).toFixed(1)}s, all done in ${((Date.now() - started) / 1000).toFixed(1)}s): ${full.trim()}\n`);
        } catch (err) {
          if (ctrl.signal.aborted && inFlight !== ctrl) console.log(`  (dropped: "${question}" was replaced by a newer question)\n`);
          throw err;
        } finally {
          clearTimeout(timer);
          if (inFlight === ctrl) inFlight = null;
        }
      }
      return { [Symbol.asyncIterator]: () => events(), finalMessage: async () => finalOf(full.trim()) };
    },
  },
};

// With a real AI the stand-in key must not be added (it would make the function pick Claude).
const env = { ...(useClaude ? {} : { ANTHROPIC_API_KEY: "preview" }), ASSISTANT_HOURLY_LIMIT: "60", ...process.env };
const deps = {
  // The real thing when a key is present: the function's own default way of calling Claude.
  ...(useClaude ? defaultDeps() : { fetch, now: () => Date.now(), createClient: () => (localAi ? localClient : fakeClient) }),
  getEnv: (n) => (n === "SUPABASE_URL" || n === "SUPABASE_SERVICE_ROLE_KEY" ? undefined : env[n]), // no database in preview
};

// Load the local AI and let it read the rules once now, so the first question isn't slow.
if (localAi) {
  const { SYSTEM_PROMPT, SYSTEM_PROMPT_OPEN } = await import("../index.ts");
  const rules = String(env.ASSISTANT_SCOPE).toLowerCase() === "open" ? SYSTEM_PROMPT_OPEN : SYSTEM_PROMPT;
  const t0 = Date.now();
  console.log(`Warming up the local AI (${LOCAL_MODEL}). The first answers are slow until this finishes...`);
  fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    body: ollamaBody(rules, [{ role: "user", content: "hi" }], { num_predict: 1 }),
  }).then(() => console.log(`Local AI ready (${((Date.now() - t0) / 1000).toFixed(0)}s).\n`)).catch((e) => console.log("Warm-up failed:", e.message));
}

const BANNER = useClaude
  ? `Local preview: chat answered by the REAL ${realAi === "gemini" ? "Gemini" : "Claude"} (${env.ASSISTANT_MODEL || (realAi === "gemini" ? "gemini-3.5-flash-lite" : "claude-haiku-5-5")}) using your key. Nothing is saved`
  : localAi
    ? `Local preview: chat answered by a small test AI (${LOCAL_MODEL}), much weaker than Claude`
    : "Local preview: chat replies are canned, not a real AI";

/* ---- web server ---- */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === ENDPOINT_PATH) {
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      headers.set("x-forwarded-for", req.socket.remoteAddress || "127.0.0.1");
      const started = Date.now();
      const r = await handleRequest(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body }), deps);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      if (!r.body) { res.end(); return; }
      // Pass the answer on piece by piece (it may be streaming), and stop if the visitor leaves.
      const reader = r.body.getReader();
      res.on("close", () => { if (!res.writableFinished) reader.cancel().catch(() => {}); });
      let firstWords = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstWords) firstWords = Date.now() - started;
        res.write(value);
      }
      res.end();
      console.log(`  [speed] HTTP ${r.status}: first words after ${(firstWords / 1000).toFixed(1)}s, finished after ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
      return;
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(ROOT, "." + rel);
    if (!file.startsWith(ROOT + path.sep) || file.split(path.sep).includes(".git") || file.split(path.sep).includes("supabase")) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    let data = fs.readFileSync(file);
    // Only in this preview, and only in memory: point the chat at this server instead of Supabase.
    if (path.basename(file) === "index.html" && path.dirname(file) === ROOT) {
      data = Buffer.from(
        data.toString("utf8").replace(
          /<script src="assistant\/assistant\.js[^"]*" defer><\/script>/,
          `<script src="assistant/assistant.js" defer data-endpoint="${ENDPOINT_PATH}" data-key="preview-key" data-timeout-ms="${localAi ? 175000 : 35000}"></script>` +
            `<div style="position:fixed;left:8px;top:8px;z-index:2000;max-width:60vw;background:#fde68a;color:#1f2937;font:600 11px/1.3 system-ui,sans-serif;padding:4px 8px;border-radius:6px;pointer-events:none">${BANNER}</div>`,
        ),
      );
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch (err) {
    console.error(err);
    if (res.headersSent) res.end();
    else res.writeHead(500).end("Server error");
  }
}).listen(PORT, () => {
  console.log(`\nPreview running: http://localhost:${PORT}\n${BANNER}. Press Ctrl+C to stop.\n`);
});
