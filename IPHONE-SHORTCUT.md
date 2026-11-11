# Voice Claude on iPhone (Shortcut + Action Button)

Press the Action Button, talk, tap to stop, hear the answer. No browser, and the
mic permission is asked only once.

## Before you start
- Tailscale app: open it, tap your account/settings, turn on **VPN On Demand**
  (so it reconnects by itself). It must say Connected.
- The PC must be on and awake, with the voice server running.

## Build the Shortcut (about 3 minutes)
Open the **Shortcuts** app → **+** (new shortcut) → name it **Voice Claude**.
Add these 3 actions (search for each name at the bottom):

1. **Dictate Text**
   - Tap "Show More": Language = **English (US)**, Stop Listening = **On Tap**

2. **Get Contents of URL**
   - URL (from `tailscale serve status` on the PC): `https://<your-pc>.<your-tailnet>.ts.net/api/shortcut`
   - Tap "Show More": Method = **POST**, Request Body = **JSON**
   - Add new field → **Text**. Key: `text` Value: tap and pick **Dictated Text**

3. **Speak Text**
   - It should already say "Speak *Contents of URL*"
   - Tap "Show More": Rate = a bit below the middle (slower), Language = English (US),
     Wait Until Finished = on

Tap **Done**. Run it once from the Shortcuts app and tap **Always Allow** on every
permission it asks for (dictation, connecting to your …ts.net address).

## Put it on the Action Button
Settings → **Action Button** → swipe to **Shortcut** → choose **Voice Claude**.
You can also say "Hey Siri, Voice Claude".

## Things you can say
- Any question about the current project.
- "Switch to Hermes" / "Switch to Win Two": changes project (remembered).
- "Which project?" / "List projects"
- "New conversation": Claude starts fresh for this project.

## See the answer on screen (optional)
Add **Show Notification** between "Get Contents of URL" and "Speak", showing
**Contents of URL**. Answers then also stay in Notification Center.

## If something goes wrong
- "Could not connect": Tailscale isn't connected, or the PC is off/asleep.
- Silence after a long wait: the question took Claude very long; ask a shorter one.
- On the PC: `logs/conversations.log` has every question and answer,
  `logs/server.log` has timings and errors.
