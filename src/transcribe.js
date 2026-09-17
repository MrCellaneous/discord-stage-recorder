// Local transcription with whisper.cpp. Each speaker's speech bursts are cut into
// clips (so Whisper never sees long silence, which it tends to hallucinate on),
// transcribed, and merged back into a single time-ordered, speaker-labeled transcript.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { log } from './log.js';

const run = promisify(execFile);

const CLIP_MERGE_GAP_MS = 8000;   // bursts closer than this are transcribed as one clip
const CLIP_PAD_MS = 300;          // context padding around each clip
const MIN_CLIP_MS = 700;          // ignore blips shorter than this

export function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:` : '') + `${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
}

function mergeSegments(segments) {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const clips = [];
  for (const s of sorted) {
    const last = clips[clips.length - 1];
    if (last && s.startMs - last.endMs <= CLIP_MERGE_GAP_MS) last.endMs = Math.max(last.endMs, s.endMs);
    else clips.push({ startMs: s.startMs, endMs: s.endMs });
  }
  return clips.filter((c) => c.endMs - c.startMs >= MIN_CLIP_MS);
}

async function extractClip(srcWav, outWav, startMs, endMs) {
  await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-ss', (startMs / 1000).toFixed(3),
    '-t', ((endMs - startMs) / 1000).toFixed(3),
    '-i', srcWav,
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    outWav,
  ]);
}

/** Runs whisper.cpp on a 16 kHz mono WAV; returns [{ startMs, endMs, text }]. */
async function whisper(wav16k) {
  const outPrefix = wav16k.replace(/\.wav$/, '');
  await run(config.whisper.bin, [
    '-m', config.whisper.model,
    '-f', wav16k,
    '-t', String(config.whisper.threads),
    '-l', 'en',
    '-oj', '-of', outPrefix,
    '-np', // no prints
  ], { maxBuffer: 64 * 1024 * 1024 });
  const json = JSON.parse(fs.readFileSync(`${outPrefix}.json`, 'utf8'));
  return (json.transcription || [])
    .map((t) => ({ startMs: t.offsets.from, endMs: t.offsets.to, text: t.text.trim() }))
    .filter((t) => t.text && !/^\s*[\[\(].*[\]\)]\s*$/.test(t.text)); // drop "[BLANK_AUDIO]" etc.
}

/**
 * @param {Array<{userId,name,wavPath,segments}>} tracks from VoiceCapture.stop()
 * @param {string} workDir
 * @returns {Promise<Array<{startMs,endMs,speaker,text}>>}
 */
export async function transcribeSpeakerTracks(tracks, workDir) {
  const clipsDir = path.join(workDir, 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });
  const lines = [];

  for (const track of tracks) {
    const clips = mergeSegments(track.segments || []);
    if (!clips.length) continue;
    log.info(`Transcribing ${track.name}: ${clips.length} clip(s)`);
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const start = Math.max(0, c.startMs - CLIP_PAD_MS);
      const end = c.endMs + CLIP_PAD_MS;
      const clipPath = path.join(clipsDir, `${track.userId}_${i}.wav`);
      try {
        await extractClip(track.wavPath, clipPath, start, end);
        const segs = await whisper(clipPath);
        for (const s of segs) {
          lines.push({ startMs: start + s.startMs, endMs: start + s.endMs, speaker: track.name, text: s.text });
        }
      } catch (err) {
        log.warn(`Clip ${clipPath} failed: ${err.message}`);
      }
    }
  }

  lines.sort((a, b) => a.startMs - b.startMs);
  return coalesce(lines);
}

/** Fallback: transcribe a single mixed file (e.g. the OBS video) with no speaker labels. */
export async function transcribeMixed(mediaPath, workDir) {
  const wav = path.join(workDir, 'mixed16k.wav');
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  const segs = await whisper(wav);
  return coalesce(segs.map((s) => ({ ...s, speaker: 'Speaker' })));
}

/** Merge consecutive lines from the same speaker into paragraphs. */
function coalesce(lines) {
  const out = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.speaker === l.speaker && l.startMs - last.endMs < 3000) {
      last.text += ' ' + l.text;
      last.endMs = l.endMs;
    } else out.push({ ...l });
  }
  return out;
}

export function transcriptToText(lines) {
  return lines.map((l) => `[${fmtTime(l.startMs)}] ${l.speaker}: ${l.text}`).join('\n');
}
