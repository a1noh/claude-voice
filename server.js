// voice-claude: ask Claude Code about your projects by voice from an iPhone Shortcut.
//
// The Shortcut dictates your question, POSTs {"text": "..."} to /api/shortcut,
// and speaks the plain-text reply. This server runs the local `claude` CLI on your
// Pro login (never an API key), one ongoing conversation per project.
//
// It listens on 127.0.0.1 only and is reached through `tailscale serve`, which
// adds the caller's Tailscale login; only logins in config.tailscaleUsers get in.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");
const STATE_PATH = path.join(ROOT, "state.json");
const LOG_DIR = path.join(ROOT, "logs");

const SYSTEM_PROMPT =
  "You are being used through a voice interface while the user may be walking or driving. " +
  "Your final reply will be read aloud by text-to-speech. Reply in 1-3 short spoken sentences, " +
  "no markdown, no code blocks, no lists, no file paths unless essential. Lead with the answer or outcome. " +
  "Always reply in English, even if the question or the project files are in another language.";

// ---------- files ----------

fs.mkdirSync(LOG_DIR, { recursive: true });

function appendLog(name, text) {
  const file = path.join(LOG_DIR, name);
  try {
    if (fs.statSync(file).size > 2e6) fs.renameSync(file, file + ".old");
  } catch {}
  try { fs.appendFileSync(file, text + "\n"); } catch {}
}

// The server runs hidden, so everything it prints also goes to logs/server.log.
for (const level of ["log", "error"]) {
  const print = console[level];
  console[level] = (...args) => { print(...args); appendLog("server.log", args.join(" ")); };
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

let config = loadJson(CONFIG_PATH, null);
if (!config) {
  console.error("config.json missing. Copy config.example.json to config.json first.");
  process.exit(1);
}

// state.json: { sessions: { [projectName]: claudeSessionId }, lastProject }
const state = loadJson(STATE_PATH, {});
state.sessions = state.sessions || {};
const saveState = () => fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

const busy = new Set(); // projects with a question in progress

// ---------- projects ----------

const spokenName = (p) => (p.aliases && p.aliases[0]) || p.name;
const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9가-힣 ]/g, "").trim();

function findProject(query) {
  const q = normalize(query);
  return config.projects.find((p) => [p.name, ...(p.aliases || [])].some((n) => q.includes(normalize(n))));
}

function currentProject() {
  return config.projects.find((p) => p.name === state.lastProject) || config.projects[0];
}

// ---------- Claude ----------

// On Windows, `claude` on PATH is a .cmd shim that spawn() can't run directly,
// so when claudePath isn't set, look for the real claude.exe in the usual install spots.
function claudeCommand() {
  if (config.claudePath && config.claudePath !== "claude") return config.claudePath;
  if (process.platform !== "win32") return "claude";
  const candidates = [
    path.join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    path.join(process.env.USERPROFILE || "", ".local", "bin", "claude.exe"),
  ];
  return candidates.find((c) => fs.existsSync(c)) || "claude";
}

// Runs one Claude turn. Resolves as soon as the final result arrives
// (the CLI takes another ~1.5s to exit, which we don't wait for).
function runClaude(project, text, resume) {
  return new Promise((resolve) => {
    const canEdit = config.permissionMode && config.permissionMode !== "default" && config.permissionMode !== "plan";
    const prompt = SYSTEM_PROMPT + (canEdit
      ? " You may edit files; after any change, say in one sentence what you changed."
      : " In this mode you can read files but cannot edit them or run commands. If asked to change something, say so plainly and describe the change instead of claiming you made it.");
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--append-system-prompt", prompt];
    if (config.permissionMode) args.push("--permission-mode", config.permissionMode);
    if (config.model) args.push("--model", config.model);
    if (config.effort) args.push("--effort", config.effort);
    if (resume) args.push("--resume", resume);

    const env = { ...process.env };
    delete env.CLAUDECODE; // allow running even if the server was started from inside Claude Code
    delete env.ANTHROPIC_API_KEY; // always use the Pro login, never a pay-per-use key

    const child = spawn(claudeCommand(), args, { cwd: project.path, env, windowsHide: true });
    let pending = "", stderr = "", done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reply: "That took too long, so I stopped. Try a shorter question." });
    }, (config.timeoutSeconds || 300) * 1000);

    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "result") {
          finish({ ok: !msg.is_error, reply: String(msg.result || "").trim(), sessionId: msg.session_id });
        }
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    // No result line at all means the CLI itself failed (bad resume id, auth, crash).
    // Details go to the log; the spoken reply stays short.
    const crashed = (why) => {
      if (done) return;
      console.error(`  claude failed (${why}): ${stderr.trim().slice(-500)}`);
      finish({ ok: false, crashed: true, reply: "Claude couldn't start on the PC. Check the server log." });
    };
    child.on("error", (e) => crashed(e.message));
    child.on("close", (code) => crashed(`exit ${code}`));
    child.stdin.end(text);
  });
}

// Continues the project's conversation. If the saved conversation can't be
// resumed (deleted, corrupted, Claude Code update), starts a fresh one instead.
async function askClaude(project, text) {
  const saved = state.sessions[project.name];
  let r = await runClaude(project, text, saved);
  // Only a CLI failure (no answer at all) means the resume itself broke. Timeouts and
  // Claude-side errors (e.g. usage limit) keep the conversation and aren't retried.
  if (r.crashed && saved) {
    console.log(`  resume failed for ${project.name}, starting a fresh conversation`);
    r = await runClaude(project, text, null);
  }
  if (r.sessionId) {
    state.sessions[project.name] = r.sessionId;
    saveState();
  }
  return r;
}

// ---------- voice commands ----------

// Returns a reply for built-in commands, or null for a normal question.
function handleCommand(text) {
  const names = () => config.projects.map(spokenName).join(" and ");

  // "switch to X" is always a command; "change/go to X" only when X is a known project,
  // so requests like "change the header color to blue" still go to Claude.
  const sw = text.match(/^(switch|change|go)\s+(?:to\s+)?(?:the\s+)?(.+?)(?:\s+project)?[.!?]*$/i);
  if (sw) {
    const p = findProject(sw[2]);
    if (!p && sw[1].toLowerCase() !== "switch") return null;
    if (!p) return `I don't know that project. You have ${names()}.`;
    state.lastProject = p.name;
    saveState();
    return `Switched to ${spokenName(p)}.`;
  }
  if (/^(which|what) project\b/i.test(text)) return `You're on ${spokenName(currentProject())}.`;
  if (/^(list|what are) (my |the )?projects\b/i.test(text)) return `Your projects are ${names()}.`;
  if (/^(new conversation|start over|start fresh|reset)[.!]*$/i.test(text)) {
    // A running question would write its session back afterwards and undo the reset.
    if (busy.has(currentProject().name)) return "I'm still answering your last question. Say new conversation again when it's done.";
    delete state.sessions[currentProject().name];
    saveState();
    return "Okay, starting a fresh conversation.";
  }
  return null;
}

// ---------- HTTP ----------

function isAllowed(req) {
  const login = String(req.headers["tailscale-user-login"] || "").toLowerCase();
  return !!login && (config.tailscaleUsers || []).some((u) => String(u).toLowerCase() === login);
}

function reply(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

// Resolves with the request body, or null if it's too large or the connection drops.
function readBody(req) {
  return new Promise((resolve) => {
    let body = "", tooBig = false;
    req.on("data", (d) => {
      if (tooBig) return; // keep draining so we can still send a reply
      body += d;
      if (body.length > 20000) { tooBig = true; body = ""; }
    });
    req.on("end", () => resolve(tooBig ? null : body));
    req.on("close", () => resolve(null)); // no-op if already resolved
  });
}

// The prompt asks for no markdown; this only removes markup that slips through,
// keeping underscores in names and symbols like ">" that carry meaning.
function toSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/^\s*(#{1,6}|>|[-*])\s+/gm, "")
    .trim();
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/") return reply(res, 200, "Voice Claude is running.");
  if (!(req.method === "POST" && url.pathname === "/api/shortcut")) return reply(res, 404, "Not found.");
  if (!isAllowed(req)) return reply(res, 401, "Not allowed. Connect Tailscale with your own account.");

  config = loadJson(CONFIG_PATH, config); // pick up config edits without a restart
  const body = await readBody(req);
  if (body === null) return reply(res, 413, "That was too long. Try a shorter question.");
  let text;
  try { text = JSON.parse(body).text; } catch { text = body; }
  text = String(text || "").trim();
  if (!text) return reply(res, 200, "I didn't hear anything. Try again.");

  const command = handleCommand(text);
  if (command) return reply(res, 200, command);

  const project = currentProject();
  if (busy.has(project.name)) return reply(res, 200, "I'm still working on your last question. Try again in a moment.");
  busy.add(project.name);
  const started = Date.now();
  console.log(`[${new Date().toISOString()}] ${project.name}: ${text}`);
  try {
    const r = await askClaude(project, text);
    const spoken = toSpeech(r.reply || "I don't have an answer.");
    console.log(`  -> ${((Date.now() - started) / 1000).toFixed(1)}s${r.ok ? "" : " (error)"}`);
    appendLog("conversations.log", `[${new Date().toLocaleString()}] ${spokenName(project)}\nQ: ${text}\nA: ${spoken}\n`);
    reply(res, 200, spoken);
  } finally {
    busy.delete(project.name);
  }
}).listen(config.port || 8787, "127.0.0.1", () => console.log(`voice-claude listening on http://127.0.0.1:${config.port || 8787}`));
