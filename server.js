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
  "no markdown, no code blocks, no lists, no file paths unless essential. Lead with the answer or outcome.";

const LANGUAGE_PROMPT = {
  en: " Always reply in English, even if the question or the project files are in another language; the voice reading your reply can only pronounce English." +
      " You cannot change the voice language yourself: if the user wants Korean, tell them to say 'switch to Korean'.",
  ko: " Always reply in natural spoken Korean (한국어), even if the question or the project files are in English; the voice reading your reply is Korean. Keep code identifiers as they are." +
      " You cannot change the voice language yourself: if the user wants English, tell them to say '영어로'.",
};

// Fixed replies, in both languages.
const MSG = {
  en: {
    empty: "I didn't hear anything. Try again.",
    tooLong: "That was too long. Try a shorter question.",
    busy: "I'm still working on your last question. Try again in a moment.",
    busyReset: "I'm still answering your last question. Say new conversation again when it's done.",
    noAnswer: "I don't have an answer.",
    timeout: "That took too long, so I stopped. Try a shorter question.",
    crashed: "Claude couldn't start on the PC. Check the server log.",
    unknownProject: (names) => `I don't know that project. You have ${names}.`,
    switched: (p) => `Switched to ${p}.`,
    current: (p) => `You're on ${p}.`,
    list: (names) => `Your projects are ${names}.`,
    reset: "Okay, starting a fresh conversation.",
    switchLanguage: { ko: "Okay, switching to Korean. From your next question, I'll listen and answer in Korean.", en: "I'm already using English." },
  },
  ko: {
    empty: "아무 말도 못 들었어요. 다시 말해 주세요.",
    tooLong: "너무 길어요. 더 짧게 물어봐 주세요.",
    busy: "아직 지난 질문에 답하는 중이에요. 잠시 후에 다시 물어봐 주세요.",
    busyReset: "아직 지난 질문에 답하는 중이에요. 끝나면 다시 새 대화라고 말해 주세요.",
    noAnswer: "답을 찾지 못했어요.",
    timeout: "너무 오래 걸려서 멈췄어요. 더 짧게 물어봐 주세요.",
    crashed: "PC에서 Claude를 시작하지 못했어요. 서버 로그를 확인해 주세요.",
    unknownProject: (names) => `그런 프로젝트는 없어요. ${names} 중에서 골라 주세요.`,
    switched: (p) => `${p}로 바꿨어요.`,
    current: (p) => `지금은 ${p} 프로젝트예요.`,
    list: (names) => `프로젝트는 ${names} 중에서 고를 수 있어요.`,
    reset: "알겠어요, 새 대화를 시작할게요.",
    switchLanguage: { en: "알겠어요, 다음 질문부터는 영어로 듣고 대답할게요.", ko: "이미 한국어로 하고 있어요." },
  },
};

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

// state.json: { sessions: { [projectName]: claudeSessionId }, lastProject, language: "en" | "ko" }
const state = loadJson(STATE_PATH, {});
state.sessions = state.sessions || {};
const saveState = () => fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

const busy = new Set(); // projects with a question in progress

// ---------- language ----------

const language = () => (state.language || config.language) === "ko" ? "ko" : "en";
const hasKorean = (s) => /[가-힣]/.test(s);

// ---------- projects ----------

// In Korean, a project with a Korean name is called by that name; otherwise by its first alias.
const spokenName = (p, lang = language()) =>
  lang === "ko" && hasKorean(p.name) ? p.name : (p.aliases && p.aliases[0]) || p.name;
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
function runClaude(project, text, resume, lang) {
  return new Promise((resolve) => {
    const canEdit = config.permissionMode && config.permissionMode !== "default" && config.permissionMode !== "plan";
    const prompt = SYSTEM_PROMPT + LANGUAGE_PROMPT[lang] + (canEdit
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
      finish({ ok: false, reply: MSG[lang].timeout });
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
      finish({ ok: false, crashed: true, reply: MSG[lang].crashed });
    };
    child.on("error", (e) => crashed(e.message));
    child.on("close", (code) => crashed(`exit ${code}`));
    child.stdin.end(text);
  });
}

// Continues the project's conversation. If the saved conversation can't be
// resumed (deleted, corrupted, Claude Code update), starts a fresh one instead.
async function askClaude(project, text, lang) {
  const saved = state.sessions[project.name];
  let r = await runClaude(project, text, saved, lang);
  // Only a CLI failure (no answer at all) means the resume itself broke. Timeouts and
  // Claude-side errors (e.g. usage limit) keep the conversation and aren't retried.
  if (r.crashed && saved) {
    console.log(`  resume failed for ${project.name}, starting a fresh conversation`);
    r = await runClaude(project, text, null, lang);
  }
  if (r.sessionId) {
    state.sessions[project.name] = r.sessionId;
    saveState();
  }
  return r;
}

// ---------- voice commands ----------

// Returns a reply for built-in commands (English or Korean), or null for a normal question.
function handleCommand(text) {
  // Language: "switch to Korean", "speak English", "한국어로 바꿔", "영어로" ...
  // Matches natural requests too ("can you switch the language to Korean?", "I want to speak
  // in Korean", "한국어로 바꿔줘"), but only short ones, so real questions about Korean text still reach Claude.
  const wantsLang = (en, ko) => text.length <= 120 && (
    new RegExp(`\\b(switch|change|set|speak|talk|use|answer|reply|respond|listen)\\b[^.?!]{0,60}\\b${en}\\b`, "i").test(text) ||
    new RegExp(`^${en}( mode| please)?[.!?]*$`, "i").test(text) ||
    new RegExp(`^${ko}\\s*(로|으로)?\\s*(바꿔|전환|변경|해|말해|대답|듣고|할게|하자|모드)?`).test(text));
  const toKo = wantsLang("korean", "한국어|한국말");
  const toEn = !toKo && wantsLang("english", "영어");
  if (toKo || toEn) {
    // Confirm in the language that's active now: the Shortcut already chose this voice.
    const before = language();
    state.language = toKo ? "ko" : "en";
    saveState();
    return MSG[before].switchLanguage[state.language];
  }

  const m = MSG[language()];
  const names = () => config.projects.map((p) => spokenName(p)).join(language() === "ko" ? ", " : " and ");
  const switchTo = (p) => {
    state.lastProject = p.name;
    saveState();
    return m.switched(spokenName(p));
  };

  // "switch to X" is always a command; "change/go to X" only when X is a known project,
  // so requests like "change the header color to blue" still go to Claude.
  const sw = text.match(/^(switch|change|go)\s+(?:to\s+)?(?:the\s+)?(.+?)(?:\s+project)?[.!?]*$/i);
  if (sw) {
    const p = findProject(sw[2]);
    if (!p && sw[1].toLowerCase() !== "switch") return null;
    return p ? switchTo(p) : m.unknownProject(names());
  }
  // Korean: "헤르메스로 바꿔", "윈투 프로젝트로 전환해" (only when it names a known project)
  const ko = text.match(/^(.+?)\s*(?:프로젝트)?\s*(?:으로|로)\s*(?:바꿔|전환|이동|변경)/);
  if (ko && findProject(ko[1])) return switchTo(findProject(ko[1]));

  if (/^(which|what) project\b/i.test(text) || /(어떤|무슨|어느)\s*프로젝트/.test(text)) return m.current(spokenName(currentProject()));
  if (/^(list|what are) (my |the )?projects\b/i.test(text) || /프로젝트\s*(목록|리스트|뭐\s*있)/.test(text)) return m.list(names());
  if (/^(new conversation|start over|start fresh|reset)[.!]*$/i.test(text) || /^(새\s*대화|새로\s*시작|처음부터)/.test(text)) {
    // A running question would write its session back afterwards and undo the reset.
    if (busy.has(currentProject().name)) return m.busyReset;
    delete state.sessions[currentProject().name];
    saveState();
    return m.reset;
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
  const isAsk = req.method === "POST" && url.pathname === "/api/shortcut";
  const isLang = req.method === "GET" && url.pathname === "/api/language";
  if (!isAsk && !isLang) return reply(res, 404, "Not found.");
  if (!isAllowed(req)) return reply(res, 401, "Not allowed. Connect Tailscale with your own account.");

  config = loadJson(CONFIG_PATH, config); // pick up config edits without a restart
  // The Shortcut asks this first to pick its dictation and voice language: "en" or "ko".
  if (isLang) return reply(res, 200, language());

  const body = await readBody(req);
  if (body === null) return reply(res, 413, MSG[language()].tooLong);
  let text;
  try { text = JSON.parse(body).text; } catch { text = body; }
  text = String(text || "").trim();
  if (!text) return reply(res, 200, MSG[language()].empty);

  const command = handleCommand(text);
  if (command) return reply(res, 200, command);

  // Answer in the active language: the Shortcut already picked a voice for it,
  // and an English voice reading Korean (or the reverse) comes out as gibberish.
  const lang = language();
  const project = currentProject();
  if (busy.has(project.name)) return reply(res, 200, MSG[lang].busy);
  busy.add(project.name);
  const started = Date.now();
  console.log(`[${new Date().toISOString()}] ${project.name} (${lang}): ${text}`);
  try {
    const r = await askClaude(project, text, lang);
    const spoken = toSpeech(r.reply || MSG[lang].noAnswer);
    console.log(`  -> ${((Date.now() - started) / 1000).toFixed(1)}s${r.ok ? "" : " (error)"}`);
    appendLog("conversations.log", `[${new Date().toLocaleString()}] ${spokenName(project)}\nQ: ${text}\nA: ${spoken}\n`);
    reply(res, 200, spoken);
  } finally {
    busy.delete(project.name);
  }
})
  .on("error", (e) => {
    // e.g. EADDRINUSE: another copy is already running. Wait before exiting so a
    // launcher that restarts us doesn't spin.
    console.error(`server error: ${e.message}`);
    setTimeout(() => process.exit(1), 60000);
  })
  .listen(config.port || 8787, "127.0.0.1", () => console.log(`voice-claude listening on http://127.0.0.1:${config.port || 8787}`));
