// Controls OBS Studio (28+) over its built-in WebSocket server (obs-websocket v5).
// OBS captures the video + mixed audio of the Stage; the bot only starts/stops it.
import OBSWebSocket from 'obs-websocket-js';
import { config } from './config.js';
import { log } from './log.js';

export class ObsRecorder {
  constructor() {
    this.obs = new OBSWebSocket();
    this.connected = false;
  }

  async connect() {
    if (this.connected) return true;
    try {
      await this.obs.connect(config.obs.url, config.obs.password || undefined);
      this.connected = true;
      this.obs.once('ConnectionClosed', () => {
        this.connected = false;
        log.warn('OBS connection closed');
      });
      log.info('Connected to OBS at', config.obs.url);
      return true;
    } catch (err) {
      this.connected = false;
      if (!config.obs.optional) throw err;
      log.warn(`OBS not reachable (${err.message}). Continuing without video.`);
      return false;
    }
  }

  async startRecording() {
    if (!(await this.connect())) return false;
    const { outputActive } = await this.obs.call('GetRecordStatus');
    if (outputActive) {
      log.warn('OBS is already recording; leaving it running');
      return true;
    }
    await this.obs.call('StartRecord');
    log.info('OBS recording started');
    return true;
  }

  /** Stops recording and returns the path of the finished video file (or null). */
  async stopRecording() {
    if (!this.connected) return null;
    try {
      const { outputActive } = await this.obs.call('GetRecordStatus');
      if (!outputActive) return null;
      // v5 returns { outputPath } directly from StopRecord.
      const { outputPath } = await this.obs.call('StopRecord');
      log.info('OBS recording stopped ->', outputPath);
      // OBS finalizes the container shortly after StopRecord resolves.
      await new Promise((r) => setTimeout(r, 2500));
      return outputPath || null;
    } catch (err) {
      log.error('Failed to stop OBS recording:', err.message);
      return null;
    }
  }

  async disconnect() {
    try { await this.obs.disconnect(); } catch { /* ignore */ }
    this.connected = false;
  }
}
