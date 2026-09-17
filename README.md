# Discord Stage Recorder

Automation for coaching Q&A sessions held in a Discord **Stage** channel.

**When a Stage starts** the bot:
- tells OBS on your Mac to start recording (video + mixed audio), and
- joins the Stage itself and records **each speaker on their own track** (audio only — Discord doesn't let bots receive video).

**When the Stage ends** it:
1. stops OBS and the audio capture,
2. transcribes locally with whisper.cpp, producing a timestamped, **speaker-labeled** transcript,
3. asks Claude for a Q&A summary document (TL;DR, each question + answer, drills/takeaways, follow-ups),
4. uploads video + transcript + summary (as a Google Doc) to a dated **Google Drive** folder,
5. posts an embed with the links, the summary and transcript files, and the TL;DR to a **Discord** channel.

YouTube upload is built in but **off by default for now** — set `YOUTUBE_ENABLED=true` in `.env` to turn it on later; everything still goes to Drive either way.

Everything for a session lands in `recordings/<date>_<topic>/` (`video.mkv`, `transcript.txt`, `summary.md`, `session.json`), so any failed step can be re-run.

```
Stage starts ──▶ OBS StartRecord ─────────────────────┐
             └─▶ bot joins Stage, per-speaker WAVs    │
                                                      ▼
Stage ends ──▶ stop both ──▶ whisper.cpp ──▶ Claude summary ──▶ Drive ──▶ Discord post
                                                        (optional: YouTube, YOUTUBE_ENABLED=true)
```

## Setup (Mac)

### 1. Install
```bash
chmod +x setup-mac.sh && ./setup-mac.sh
```
Installs Node, ffmpeg, whisper.cpp, OBS (via Homebrew), downloads the `medium.en` Whisper model and creates `.env`.
On an M-series Mac `medium.en` transcribes roughly 5–10× faster than real time. Use `ggml-small.en.bin` if you want it faster, `ggml-large-v3-turbo.bin` (+ `-l en`) if you want it better.

### 2. Discord bot
1. https://discord.com/developers/applications → **New Application** → Bot → **Reset Token** → copy into `DISCORD_TOKEN`. Copy the Application ID into `DISCORD_CLIENT_ID`.
2. Under **Bot → Privileged Gateway Intents**, enable **Server Members Intent** (used to label speakers by display name).
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; bot permissions **View Channels, Connect, Send Messages, Attach Files, Embed Links**. Open the generated URL and add the bot to your server.
4. Enable Developer Mode in Discord (Settings → Advanced), right-click your server → Copy ID → `DISCORD_GUILD_ID`; do the same for the text channel where posts should go (`DISCORD_POST_CHANNEL_ID`). Optionally set `DISCORD_STAGE_CHANNEL_ID` to only record one Stage channel.
5. `npm run register` — adds the `/record start|stop|status` commands (manual override; automatic start/stop via Stage events needs nothing else).

### 3. OBS
1. OBS → **Tools → WebSocket Server Settings** → Enable, set a password → `OBS_PASSWORD`.
2. Build a scene that captures what you want on video (your camera, screen share, or the Discord window) and add a **macOS Audio Capture** source pointing at Discord so the video has the session audio. Set **Settings → Output → Recording** format to MKV or fragmented MP4 so a crash never corrupts a recording.
3. OBS must be open when a Stage starts. If it isn't, the bot still records audio (`OBS_OPTIONAL=true`) but there's no video to upload.

### 4. Google (Drive)
1. https://console.cloud.google.com → create a project → **APIs & Services → Library**: enable **Google Drive API** (also enable **YouTube Data API v3** if you plan to turn YouTube on later).
2. **OAuth consent screen**: External, add yourself as a test user (or publish). Scopes are requested at sign-in.
3. **Credentials → Create → OAuth client ID → Desktop app** → copy the client ID/secret into `.env`.
4. `npm run google-auth` — signs in once and saves `google-token.json`.
5. Optional: `DRIVE_FOLDER_ID` = the ID from a Drive folder URL to keep sessions together.

> YouTube is off by default (see the note above). Turning it on later just needs `YOUTUBE_ENABLED=true` in `.env` — no other setup changes. When you do, note the default quota (10,000 units/day) allows ~6 uploads/day, and unverified OAuth apps upload videos as **private** regardless of the setting until the app passes Google's verification.

### 5. Claude (summaries)
Set `ANTHROPIC_API_KEY` from https://console.anthropic.com. Without it the bot still records, transcribes, uploads and posts — just no summary.

### 6. Run
```bash
npm start
```
Keep it running in a terminal (or see "Run at login" below). Start a Stage in Discord and watch the post channel for the 🔴 / ⏹️ status messages.

## Day-to-day
- Automatic: starting/ending a Stage (or a scheduled Event on a Stage channel) triggers everything.
- Manual: `/record start topic:"Finger strength Q&A"` and `/record stop` from inside any Stage or voice channel. `/record status` shows what's live.
- Retry a failed step: `npm run process -- recordings/2026-09-13_1900_finger-strength-qa` (already-completed uploads are skipped).
- Process a video you recorded some other way: `npm run process -- ~/Movies/session.mp4 "Session title"`.

## Run at login (optional)
Create `~/Library/LaunchAgents/com.yourname.stage-recorder.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.yourname.stage-recorder</string>
  <key>ProgramArguments</key><array><string>/opt/homebrew/bin/node</string><string>src/index.js</string></array>
  <key>WorkingDirectory</key><string>/PATH/TO/stage-recorder</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/stage-recorder.log</string>
  <key>StandardErrorPath</key><string>/tmp/stage-recorder.log</string>
</dict></plist>
```
then `launchctl load ~/Library/LaunchAgents/com.yourname.stage-recorder.plist`.

## How the speaker-labeled transcript works
Discord sends the bot a separate Opus stream per speaker. Each is decoded into its own WAV on a shared clock (silence is padded in), so timestamps line up. Only the stretches where someone actually spoke are cut out and sent to Whisper — which keeps it fast and stops Whisper hallucinating text over silence — then all speakers' lines are merged in time order and labeled with their server display name.

## Limits worth knowing
- **No video from Discord.** Bots can't receive camera/screen-share streams; OBS on your Mac is the video source. Your Mac must be on, in OBS, and the bot running.
- Discord attachments are capped at 10 MB on non-boosted servers, so the video goes to Discord as a Drive link (or YouTube link, if enabled), not a file.
- Whisper runs after the session ends; a 60-minute Stage takes roughly 6–12 minutes on an M-series Mac with `medium.en`.
- Speakers who join with an unusual client sometimes send no `speaking` events; if a speaker is missing from the transcript, the OBS mixed audio is still complete and `npm run process` on the video gives an unlabeled fallback transcript.
