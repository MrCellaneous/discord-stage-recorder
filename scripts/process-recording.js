// Re-run post-processing for a session folder (e.g. after a failed upload), or
// process a plain video file that was recorded without the bot.
//   npm run process -- recordings/2026-09-13_1900_technique-qa
//   npm run process -- path/to/video.mp4 "Session title"
import fs from 'node:fs';
import path from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.js';
import { processSession } from '../src/pipeline.js';

const [target, title] = process.argv.slice(2);
if (!target) { console.error('Usage: npm run process -- <session-dir | video-file> [title]'); process.exit(1); }

let dir = path.resolve(target);
if (fs.statSync(dir).isFile()) {
  // Wrap a standalone video in a session folder.
  const topic = title || path.basename(dir, path.extname(dir));
  const sessionDir = path.join(config.recordingsDir, `manual_${Date.now()}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  const dest = path.join(sessionDir, `video${path.extname(dir)}`);
  fs.copyFileSync(dir, dest);
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
    topic, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), videoPath: dest, tracks: [],
  }, null, 2));
  dir = sessionDir;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(config.discord.token);
try {
  await processSession(client, dir);
} finally {
  client.destroy();
}
