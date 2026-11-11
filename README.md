# voice-claude

Ask Claude Code about your projects by voice from your iPhone and hear a short spoken answer.

```
iPhone Shortcut (dictate) → Tailscale → server.js on this PC → claude CLI in the project folder
                         ← spoken reply ←
```

- Uses the local `claude` CLI on your Pro login. Never an API key (`ANTHROPIC_API_KEY` is stripped).
- One ongoing conversation per project, remembered across questions.
- No dependencies: plain Node.

## Setup on the PC
1. `copy config.example.json config.json`, then fill in `tailscaleUsers` (your Tailscale login)
   and `projects` (name, folder, and easy-to-say `aliases`).
2. Run `node server.js`. It listens on `http://127.0.0.1:8787` (this PC only).
3. `tailscale serve --bg 8787` publishes it privately to your Tailscale devices as
   `https://<pc-name>.<tailnet>.ts.net`.

## Setup on the iPhone
See [IPHONE-SHORTCUT.md](IPHONE-SHORTCUT.md).

## Voice commands
- "Switch to <project>", "Which project?", "List projects"
- "New conversation": the next question starts fresh for the current project.
- Anything else is a question for Claude about the current project.

## Logs (in `logs/`)
- `conversations.log`: every question and answer.
- `server.log`: requests, timings, errors.

## Settings (`config.json`, re-read on every request)
- `permissionMode`: `default` means Claude can read and answer but not edit files.
  `acceptEdits` lets it edit files (commands are still refused; nobody is there to approve them).
- `model` / `effort`: `sonnet` + `low` keeps answers fast.
- `timeoutSeconds`: give up on a question after this long.

`config.json`, `state.json` and `logs/` are gitignored.
