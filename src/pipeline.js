// Session lifecycle: start (OBS + audio capture) -> stop -> process (transcribe,
// summarize, upload, post). Everything for one session lives in one folder so a
// failed step can be re-run with `npm run process -- <session-dir>`.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';
import { ObsRecorder } from './obs.js';
import { VoiceCapture } from './voiceCapture.js';
import { transcribeSpeakerTracks, transcribeMixed, transcriptToText, fmtTime } from './transcribe.js';
import { summarize } from './summarize.js';
import { uploadToYouTube, uploadToDrive } from './google.js';
import { postResults, postStatus } from './discordPost.js';

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'stage';

export class Session {
  constructor(client, channel, topic) {
    this.client = client;
    this.channel = channel;
    this.topic = topic || channel.name;
    this.startedAt = new Date();
    const stamp = this.startedAt.toISOString().slice(0, 16).replace('T', '_').replace(':', '');
    this.dir = path.join(config.recordingsDir, `${stamp}_${slug(this.topic)}`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.obs = new ObsRecorder();
    this.capture = new VoiceCapture(channel, path.join(this.dir, 'audio'), (id) => this.#displayName(id));
    this.meta = { topic: this.topic, channelId: channel.id, startedAt: this.startedAt.toISOString() };
  }

  async #displayName(userId) {
    const m = await this.channel.guild.members.fetch(userId);
    return m.displayName;
  }

  async start() {
    log.info(`Stage started: "${this.topic}" -> ${this.dir}`);
    const [obsOk] = await Promise.all([
      this.obs.startRecording().catch((e) => { log.error('OBS start failed:', e.message); return false; }),
      this.capture.start().catch((e) => { log.error('Audio capture start failed:', e.message); this.capture = null; }),
    ]);
    this.meta.obsRecording = !!obsOk;
    this.#saveMeta();
    await postStatus(this.client, `🔴 Recording started for **${this.topic}**${obsOk ? '' : ' (audio only — OBS not connected)'}.`);
  }

  async stop() {
    log.info('Stage ended; stopping recorders');
    this.meta.endedAt = new Date().toISOString();
    const [videoPath, tracks] = await Promise.all([
      this.obs.stopRecording(),
      this.capture ? this.capture.stop().catch((e) => { log.error('Audio stop failed:', e.message); return []; }) : [],
    ]);
    await this.obs.disconnect();

    // Copy OBS output into the session folder so everything is in one place.
    if (videoPath && fs.existsSync(videoPath)) {
      const dest = path.join(this.dir, `video${path.extname(videoPath)}`);
      try { fs.renameSync(videoPath, dest); } catch { fs.copyFileSync(videoPath, dest); }
      this.meta.videoPath = dest;
    }
    this.meta.tracks = (tracks || []).map((t) => ({ ...t, wavPath: path.relative(this.dir, t.wavPath) }));
    this.#saveMeta();
    await postStatus(this.client, `⏹️ Recording stopped. Transcribing and summarizing — this can take a few minutes…`);
    return processSession(this.client, this.dir);
  }

  #saveMeta() {
    fs.writeFileSync(path.join(this.dir, 'session.json'), JSON.stringify(this.meta, null, 2));
  }
}

/** Runs (or re-runs) all post-processing for a session folder. */
export async function processSession(client, dir) {
  const metaPath = path.join(dir, 'session.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const save = () => fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  const title = `${config.google.youtubeTitlePrefix}${meta.topic}`.trim();
  const started = new Date(meta.startedAt);
  const dateStr = started.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const durationMs = meta.endedAt ? new Date(meta.endedAt) - started : 0;
  const durationStr = fmtTime(durationMs);

  // 1. Transcript
  const transcriptPath = path.join(dir, 'transcript.txt');
  let lines = [];
  try {
    const tracks = (meta.tracks || []).map((t) => ({ ...t, wavPath: path.join(dir, t.wavPath) }));
    if (tracks.some((t) => t.segments?.length)) {
      lines = await transcribeSpeakerTracks(tracks, dir);
    } else if (meta.videoPath && fs.existsSync(meta.videoPath)) {
      log.warn('No per-speaker audio; transcribing the OBS recording instead');
      lines = await transcribeMixed(meta.videoPath, dir);
    }
    fs.writeFileSync(transcriptPath, transcriptToText(lines));
    meta.transcriptPath = transcriptPath; save();
  } catch (err) {
    log.error('Transcription failed:', err.message);
  }

  // 2. Summary
  const summaryPath = path.join(dir, 'summary.md');
  let summaryText = null;
  if (lines.length) {
    try {
      summaryText = await summarize({ title: meta.topic, dateStr, transcriptText: transcriptToText(lines) });
      if (summaryText) { fs.writeFileSync(summaryPath, summaryText); meta.summaryPath = summaryPath; save(); }
    } catch (err) {
      log.error('Summary failed:', err.message);
    }
  }

  // 3. YouTube (disabled by default — see YOUTUBE_ENABLED in .env; video still goes to Drive below)
  let youtubeUrl = meta.youtubeUrl || null;
  if (config.google.youtubeEnabled && !youtubeUrl && meta.videoPath && fs.existsSync(meta.videoPath)) {
    try {
      const tldr = summaryText?.match(/## TL;DR\s*([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() || '';
      youtubeUrl = await uploadToYouTube({
        videoPath: meta.videoPath,
        title,
        description: `${meta.topic} — recorded ${dateStr}.\n\n${tldr}`,
      });
      meta.youtubeUrl = youtubeUrl; save();
    } catch (err) {
      log.error('YouTube upload failed:', err.message);
    }
  }

  // 4. Drive
  let drive = meta.drive || null;
  if (!drive) {
    try {
      drive = await uploadToDrive({
        folderName: `${started.toISOString().slice(0, 10)} ${meta.topic}`,
        files: [
          { path: meta.videoPath, name: `${title}${path.extname(meta.videoPath || '.mp4')}`, mimeType: 'video/mp4' },
          { path: fs.existsSync(transcriptPath) ? transcriptPath : null, name: 'transcript.txt', mimeType: 'text/plain' },
          { path: summaryText ? summaryPath : null, name: `${meta.topic} – Summary`, mimeType: 'text/markdown', convertToDoc: true },
        ],
      });
      meta.drive = drive; save();
    } catch (err) {
      log.error('Drive upload failed:', err.message);
    }
  }

  // 5. Discord
  if (client) {
    try {
      await postResults(client, {
        title, dateStr, durationStr, youtubeUrl, drive,
        videoPath: meta.videoPath,
        transcriptPath: lines.length ? transcriptPath : null,
        summaryPath: summaryText ? summaryPath : null,
        summaryText,
        speakers: (meta.tracks || []).filter((t) => t.speechSeconds > 5).map((t) => t.name),
      });
      meta.postedAt = new Date().toISOString(); save();
    } catch (err) {
      log.error('Discord post failed:', err.message);
    }
  }

  // 6. Cleanup
  if (config.cleanupRawAudio && lines.length) {
    for (const sub of ['audio', 'clips']) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
  }
  log.info('Session processing complete:', dir);
  return meta;
}
