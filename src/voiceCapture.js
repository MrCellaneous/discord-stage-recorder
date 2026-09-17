// Captures each speaker's audio from the Stage channel into its own time-aligned
// WAV file (48 kHz, mono, 16-bit). Because every track shares the same clock,
// the per-speaker transcripts can be merged back into one labeled conversation.
import fs from 'node:fs';
import path from 'node:path';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
} from '@discordjs/voice';
import prism from 'prism-media';
import { log } from './log.js';

const SAMPLE_RATE = 48000;
const BYTES_PER_SAMPLE = 2; // 16-bit mono
const MAX_TRAILING_PAD_SECONDS = 5;

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);            // PCM chunk size
  h.writeUInt16LE(1, 20);             // PCM
  h.writeUInt16LE(1, 22);             // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  h.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

function stereoToMono(buf) {
  const frames = Math.floor(buf.length / 4);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const l = buf.readInt16LE(i * 4);
    const r = buf.readInt16LE(i * 4 + 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, (l + r) >> 1)), i * 2);
  }
  return out;
}

class Track {
  constructor(userId, filePath) {
    this.userId = userId;
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'w');
    fs.writeSync(this.fd, wavHeader(0)); // placeholder header
    this.bytes = 0;
    this.speechBytes = 0;
    this.active = false;
    this.segments = []; // { startMs, endMs } of speech bursts, on the shared clock
    this.current = null;
  }
  beginSegment(offsetMs) {
    this.current = { startMs: offsetMs, endMs: offsetMs };
  }
  endSegment() {
    if (this.current) {
      this.current.endMs = Math.round(this.bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE) * 1000);
      if (this.current.endMs > this.current.startMs) this.segments.push(this.current);
      this.current = null;
    }
  }
  padTo(offsetMs) {
    const target = Math.floor((offsetMs / 1000) * SAMPLE_RATE) * BYTES_PER_SAMPLE;
    if (target > this.bytes) {
      const pad = Buffer.alloc(target - this.bytes);
      fs.writeSync(this.fd, pad);
      this.bytes = target;
    }
  }
  write(pcmMono) {
    fs.writeSync(this.fd, pcmMono);
    this.bytes += pcmMono.length;
    this.speechBytes += pcmMono.length;
  }
  finalize() {
    fs.writeSync(this.fd, wavHeader(this.bytes), 0, 44, 0);
    fs.closeSync(this.fd);
  }
}

export class VoiceCapture {
  /**
   * @param {import('discord.js').StageChannel|import('discord.js').VoiceChannel} channel
   * @param {string} audioDir  directory for per-speaker WAVs
   * @param {(userId: string) => Promise<string>} resolveName
   */
  constructor(channel, audioDir, resolveName) {
    this.channel = channel;
    this.audioDir = audioDir;
    this.resolveName = resolveName;
    this.tracks = new Map();
    this.names = new Map();
    this.connection = null;
    this.startedAt = null;
  }

  async start() {
    fs.mkdirSync(this.audioDir, { recursive: true });
    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    this.connection.on('stateChange', (oldState, newState) => {
      log.info(`[voice debug] ${oldState.status} -> ${newState.status}`);
    });
    this.connection.on('error', (e) => log.warn('[voice debug] connection error:', e.message));
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    this.startedAt = Date.now();
    log.info(`Joined "${this.channel.name}" for audio capture`);

    // Bots join Stages as suppressed audience members; that's fine for receiving.
    // Keep it that way so it never becomes a "speaker" accidentally.

    const receiver = this.connection.receiver;
    receiver.speaking.on('start', (userId) => this.#onSpeakingStart(userId));

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        log.warn('Voice connection lost and could not reconnect');
      }
    });
  }

  #track(userId) {
    let t = this.tracks.get(userId);
    if (!t) {
      t = new Track(userId, path.join(this.audioDir, `${userId}.wav`));
      this.tracks.set(userId, t);
      this.resolveName(userId).then((n) => this.names.set(userId, n)).catch(() => {});
    }
    return t;
  }

  #onSpeakingStart(userId) {
    const track = this.#track(userId);
    if (track.active) return;
    track.active = true;
    const offsetMs = Date.now() - this.startedAt;
    track.padTo(offsetMs);
    track.beginSegment(offsetMs);

    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
    });
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: 2, frameSize: 960 });

    opus.pipe(decoder);
    decoder.on('data', (chunk) => track.write(stereoToMono(chunk)));
    const done = () => {
      if (!track.active) return;
      track.active = false;
      track.endSegment();
    };
    decoder.on('end', done);
    decoder.on('close', done);
    decoder.on('error', (e) => { log.warn(`decoder error for ${userId}:`, e.message); done(); });
    opus.on('error', (e) => { log.warn(`opus stream error for ${userId}:`, e.message); done(); });
  }

  /** Stops capture and returns [{ userId, name, wavPath, speechSeconds }]. */
  async stop() {
    const endMs = Date.now() - this.startedAt;
    try { this.connection?.destroy(); } catch { /* ignore */ }
    // Give in-flight decoder chunks a moment to flush.
    await new Promise((r) => setTimeout(r, 1000));

    const results = [];
    for (const track of this.tracks.values()) {
      if (track.active) { track.active = false; track.endSegment(); }
      track.padTo(Math.min(endMs, track.bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE) * 1000 + MAX_TRAILING_PAD_SECONDS * 1000));
      track.finalize();
      const speechSeconds = track.speechBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE);
      results.push({
        userId: track.userId,
        name: this.names.get(track.userId) || (await this.resolveName(track.userId).catch(() => track.userId)),
        wavPath: track.filePath,
        speechSeconds,
        segments: track.segments,
      });
    }
    log.info(`Audio capture stopped: ${results.length} speaker track(s)`);
    return results;
  }
}
