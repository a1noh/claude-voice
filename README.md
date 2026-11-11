# Claude Voice

**Press your iPhone's Action Button, ask Claude Code about your code, and hear the answer out loud.**

Talk to [Claude Code](https://claude.com/claude-code) about your repos from anywhere: on a walk, in the car, away from your desk.
It runs on **your own computer**, uses **your Claude Pro/Max plan** (no API key, no extra cost),
and reaches your phone privately through [Tailscale](https://tailscale.com).

```
 iPhone                                   Your computer
┌──────────────────────┐   Tailscale    ┌────────────────────────────┐
│ Action Button        │  (private,     │ server.js                  │
│  → dictate question  │ ─────────────▶ │  → claude CLI, in your     │
│  → speak the answer  │ ◀───────────── │    project folder          │
└──────────────────────┘   encrypted)   └────────────────────────────┘
```

- **No API key.** It runs the `claude` CLI you're already signed in to. `ANTHROPIC_API_KEY` is
  removed from its environment, so you never get billed per request by accident.
- **Remembers the conversation.** One ongoing conversation per project, so follow-up questions work.
- **Private.** The server only listens on your own computer. Only your own Tailscale account can reach it.
  Nothing is exposed to the internet.
- **Tiny.** One file of plain Node.js, no dependencies, no build step.
- **Native iPhone voice.** Uses iPhone's built-in dictation and voice through Shortcuts.
  No app to install, and mic permission is asked only once.

A typical answer starts playing about 5 seconds after you stop talking.

---

## What you need

| | |
|---|---|
| **Computer** | Windows, macOS or Linux, on and awake while you use it |
| **Claude Code** | Installed and signed in: run `claude` once in a terminal ([install guide](https://docs.claude.com/en/docs/claude-code/setup)) |
| **Node.js** | Version 18 or newer ([nodejs.org](https://nodejs.org)) |
| **Tailscale** | Free account, installed on the computer **and** the iPhone, signed in to the same account ([tailscale.com/download](https://tailscale.com/download)) |
| **iPhone** | With the Shortcuts app (built in). The Action Button needs an iPhone 15 Pro or newer; any iPhone can use Siri or a Home Screen icon. |

---

## Setup

### 1. Get the code

```bash
git clone https://github.com/a1noh/claude-voice.git
cd claude-voice
```

### 2. Configure it

Copy the example config:

```bash
cp config.example.json config.json
```

(On Windows Command Prompt: `copy config.example.json config.json`)

Open `config.json` and fill in:

- **`tailscaleUsers`**: the email or login you use for Tailscale. Only these accounts can use the server.
- **`projects`**: the folders Claude can answer about:
  - `name`: any name.
  - `path`: the full path to the project folder. On Windows, double the backslashes: `"C:\\Users\\me\\code\\my-app"`.
  - `aliases`: easy-to-say names for voice commands, like `"my app"`. The first one is what it calls the project out loud.

```json
"tailscaleUsers": ["you@example.com"],
"projects": [
  { "name": "My App", "path": "C:\\Users\\me\\code\\my-app", "aliases": ["my app"] },
  { "name": "Blog",   "path": "C:\\Users\\me\\code\\blog",   "aliases": ["blog", "website"] }
]
```

### 3. Start the server

```bash
node server.js
```

You should see `voice-claude listening on http://127.0.0.1:8787`. Leave it running.

### 4. Share it with your phone (privately)

In another terminal:

```bash
tailscale serve --bg 8787
```

The first time, Tailscale may print a link to enable Serve for your account. Open it and click **Enable**,
then run the command again. It prints your private address, something like:

```
https://my-pc.tail1234.ts.net/
```

Copy it, because the Shortcut needs it. You can always see it again with `tailscale serve status`.
This setting survives restarts, so you only do it once.

> This is **not** public. Only devices signed in to your Tailscale account can open that address.
> (Don't use `tailscale funnel`, which *would* make it public.)

### 5. Build the iPhone Shortcut (about 3 minutes)

First, on the iPhone, open the **Tailscale** app and make sure it says **Connected**.
In its settings, turn on **VPN On Demand** so it stays connected.

Then open the **Shortcuts** app, tap **+**, and add these three actions (search for each name):

**① Dictate Text**
- Language: **English (US)**
- Stop Listening: **On Tap**. You decide when you're done; it won't cut you off mid-thought.

**② Get Contents of URL**
- URL: your address + `/api/shortcut`, e.g. `https://my-pc.tail1234.ts.net/api/shortcut`
- Method: **POST**
- Request Body: **JSON**
- Add a **Text** field. Key: `text`. Value: **Dictated Text** (pick it from the variables).

**③ Speak Text**
- Text: **Contents of URL**
- Wait Until Finished: **on**
- Rate: drag left to make it talk slower.

Name it **Voice Claude**, tap **Done**, and run it once. Tap **Always Allow** on each permission prompt.

> **Tip:** on recent iOS you can tap **+** and *describe* the shortcut instead, then check the three actions match the list above:
> *"Dictate text in English and stop listening on tap. Then get contents of URL `<your address>/api/shortcut` using POST with a JSON body with a text field named "text" set to the dictated text. Then speak the contents of the URL and wait until finished."*

**Optional: see answers on screen.** Add **Show Notification** between ② and ③, showing **Contents of URL**.
Answers then also stay in Notification Center.

### 6. Put it on the Action Button

**Settings → Action Button →** swipe to **Shortcut →** choose **Voice Claude**.
Or say **"Hey Siri, Voice Claude"**, or add the shortcut to your Home Screen.

**Done.** Press, talk, tap to stop, listen.

---

## Using it

Ask anything about the current project:

- "What does this project do?"
- "Where is the login handled?"
- "Why would the build fail if the env file is missing?"
- "What did we change last time?"

**Voice commands:**

| Say | What happens |
|---|---|
| "Switch to *blog*" | Changes the project (uses `aliases`). Remembered until you switch again. |
| "Which project?" | Tells you the current project |
| "List projects" | Lists your projects |
| "New conversation" | The next question starts a fresh conversation for this project |

Every question and answer is also saved on your computer in `logs/conversations.log`.
The conversations are normal Claude Code sessions, so you can continue one at your desk with `claude --resume` in the project folder.

---

## Letting it edit code

By default it is **read-only**: Claude reads your files and answers, and if you ask it to change something, it says what it *would* change.

To let it edit files, set this in `config.json`:

```json
"permissionMode": "acceptEdits"
```

Claude can then create and change files, and tells you in one sentence what it changed. It still **can't run commands**
(installs, tests, git push), because nobody is there to approve them from the phone.

Only do this in projects that use **git**, so you can review and undo changes at your desk (`git diff`, `git restore`).

---

## Settings

`config.json` is re-read on every request, so changes apply without a restart.

| Setting | Default | What it does |
|---|---|---|
| `port` | `8787` | Local port (must match `tailscale serve`) |
| `tailscaleUsers` | — | Tailscale logins allowed to use it |
| `projects` | — | `name`, `path`, `aliases` for each project |
| `permissionMode` | `default` | `default` = read-only, `acceptEdits` = can edit files |
| `model` | `sonnet` | Claude model (`sonnet`, `opus`, `haiku`, …) |
| `effort` | `low` | Thinking effort: `low` is fastest; raise it for harder questions |
| `timeoutSeconds` | `300` | Give up on a question after this long |
| `claudePath` | auto | Path to the `claude` executable, only if it isn't found automatically |

---

## Keep it running (optional)

The server must be running for the Shortcut to work. To start it automatically when you log in on Windows:

```bat
schtasks /create /tn "Claude Voice" /sc onlogon /tr "node C:\full\path\to\claude-voice\server.js"
```

Also make sure the computer doesn't go to sleep while you want to use it
(**Settings → System → Power → Screen and sleep**).

On macOS or Linux, use `launchd`, `systemd`, or something like `pm2`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Shortcut says it **can't connect** | Tailscale isn't connected on the phone, the computer is off or asleep, or `node server.js` isn't running. |
| "**Not allowed.** Connect Tailscale with your own account." | Your Tailscale login isn't in `tailscaleUsers`. Check it with `tailscale status` on the computer. |
| "**Claude couldn't start on the PC**" | Run `claude` in a terminal to check it's installed and signed in. Details are in `logs/server.log`. If it isn't found, set `claudePath`. |
| Visiting the address shows **"Voice Claude is running."** but the Shortcut fails | Check the Shortcut URL ends in `/api/shortcut`, Method is POST, and the JSON key is exactly `text`. |
| It **cut me off** | Set Dictate Text → Stop Listening to **On Tap**. |
| It talks **too fast** | Speak Text → drag **Rate** left. |
| "I'm still working on your last question" | Claude is still answering the previous one. Wait a moment and ask again. |
| Answers are **slow** | Short questions take about 5 seconds. Questions that make Claude read many files take longer. Keep `effort` at `low`. |

Logs live in `logs/`: `server.log` (requests, timings, errors) and `conversations.log` (questions and answers).

---

## Security

- The server binds to `127.0.0.1` only, so nothing else on your network can reach it directly.
- `tailscale serve` makes it reachable only inside your tailnet, and adds the caller's verified
  Tailscale identity. The server rejects anyone not in `tailscaleUsers`.
- Claude runs with your normal Claude Code permissions in the project folder. Read-only by default.
- `config.json`, `state.json` and `logs/` are in `.gitignore`. Never commit them.

---

## Limitations

- **Waits for the full answer** before speaking (Shortcuts can't stream). Short answers take about 5 seconds.
- **One question per press.** Press again for a follow-up; it remembers the conversation.
- **English** speech in and out. Change the Dictate Text language and the prompt in `server.js` for other languages.
- Every question uses your Claude plan's usage, like any Claude Code message.

---

## How it works

1. The Shortcut dictates your speech and POSTs `{"text": "..."}` to `/api/shortcut`.
2. `server.js` checks the Tailscale identity header, handles voice commands, and otherwise runs:
   `claude -p --resume <session> --append-system-prompt "<reply in 1-3 short spoken sentences>"`
   in the current project's folder.
3. The reply comes back as plain text, and the Shortcut speaks it.
4. The session id is saved in `state.json`, so the next question continues the same conversation.
   If a saved conversation can't be resumed, it starts a fresh one automatically.
