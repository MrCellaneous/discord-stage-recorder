import 'dotenv/config';
import path from 'node:path';

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));
const req = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var ${k} (see .env.example)`);
  return v;
};

export const config = {
  discord: {
    token: req('DISCORD_TOKEN'),
    clientId: process.env.DISCORD_CLIENT_ID || '',
    guildId: req('DISCORD_GUILD_ID'),
    postChannelId: req('DISCORD_POST_CHANNEL_ID'),
    stageChannelId: process.env.DISCORD_STAGE_CHANNEL_ID || null,
  },
  obs: {
    url: process.env.OBS_URL || 'ws://127.0.0.1:4455',
    password: process.env.OBS_PASSWORD || '',
    optional: bool(process.env.OBS_OPTIONAL, true),
  },
  whisper: {
    bin: process.env.WHISPER_BIN || 'whisper-cli',
    model: path.resolve(process.env.WHISPER_MODEL || './models/ggml-medium.en.bin'),
    threads: Number(process.env.WHISPER_THREADS || 8),
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.SUMMARY_MODEL || 'claude-sonnet-4-5',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    tokenPath: path.resolve(process.env.GOOGLE_TOKEN_PATH || './google-token.json'),
    youtubePrivacy: process.env.YOUTUBE_PRIVACY || 'unlisted',
    youtubeTitlePrefix: process.env.YOUTUBE_TITLE_PREFIX ?? '',
    driveFolderId: process.env.DRIVE_FOLDER_ID || null,
  },
  recordingsDir: path.resolve(process.env.RECORDINGS_DIR || './recordings'),
  coachName: process.env.COACH_NAME || 'Coach',
  cleanupRawAudio: bool(process.env.CLEANUP_RAW_AUDIO, true),
};
