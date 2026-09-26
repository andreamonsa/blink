/**
 * Lecture audio capture into a short ephemeral ring buffer.
 *
 * Only a rolling window of recent audio is held, in memory, so the start of an
 * away event can be recovered once gaze returns. Nothing is written to disk,
 * and only the slice covering a valid away window is ever sent for
 * transcription.
 *
 * Source note (macOS): a lecture playing in another Chrome tab is captured
 * with getDisplayMedia + "Share tab audio". Sharing the entire screen with
 * audio is not supported on macOS, and Safari/Firefox do not offer tab audio
 * at all. A lecture in the Zoom/Teams desktop app needs a virtual audio device
 * such as BlackHole, captured as a microphone.
 */

import { sessionNowMs } from "./session.js";

// A full lecture is never buffered -- only enough to cover an away window plus
// the reaction time before the tracker reports it. 60 s at 48 kHz mono Float32
// is ~11.5 MB, cheap insurance against a long glance away.
const DEFAULT_BUFFER_SECONDS = 60;

export class AudioCapture {
  constructor({ bufferSeconds = DEFAULT_BUFFER_SECONDS } = {}) {
    this.bufferSeconds = bufferSeconds;
    this.context = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.ring = null;
    this.ringSize = 0;
    this.writeIndex = 0;
    this.totalSamples = 0;   // samples ever written; an exact monotonic clock
    this.epochMs = null;     // session time of sample 0
    this.sampleRate = 0;
    this.sourceLabel = "none";
    this.onLevel = null;

    // Capture health. "All the audio" means no dropped render quanta and a
    // track that is actually carrying sound, not just existing.
    this.startedAtMs = null;
    this.peakLevel = 0;
    this.lastLevel = 0;
    this.silentBlocks = 0;
    this.totalBlocks = 0;
  }

  get isRunning() {
    return this.context !== null && this.context.state !== "closed";
  }

  /** Lecture playing in another Chrome tab. User must tick "share tab audio". */
  async startTabAudio() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // getDisplayMedia cannot be audio-only; we never read frames
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(
        'No audio track. Pick a "Chrome Tab" and tick "Also share tab audio".'
      );
    }
    return this._attachStream(stream, "tab audio");
  }

  /** Physical lecture in a room, or a virtual device such as BlackHole. */
  async startMicrophone() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    return this._attachStream(stream, "microphone");
  }

  /** A local file played on the session timeline, for reproducible testing. */
  async startFile(file) {
    const context = new AudioContext();
    await this._setupGraph(context, "file: " + file.name);
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.node);
    source.connect(context.destination); // so you can hear it while testing
    source.start();
    this.source = source;
    return { sampleRate: this.sampleRate, label: this.sourceLabel };
  }

  async _attachStream(stream, label) {
    this.stream = stream;
    const context = new AudioContext();
    await this._setupGraph(context, label);
    const source = context.createMediaStreamSource(stream);
    source.connect(this.node);
    this.source = source;

    // If the user clicks "Stop sharing" in Chrome's bar.
    stream.getTracks().forEach((track) => {
      track.addEventListener("ended", () => this.stop());
    });

    return { sampleRate: this.sampleRate, label };
  }

  async _setupGraph(context, label) {
    await context.audioWorklet.addModule(
      new URL("./pcm-recorder.worklet.js", import.meta.url)
    );
    this.context = context;
    this.sampleRate = context.sampleRate;
    this.sourceLabel = label;
    this.ringSize = Math.ceil(this.sampleRate * this.bufferSeconds);
    this.ring = new Float32Array(this.ringSize);
    this.writeIndex = 0;
    this.totalSamples = 0;
    this.epochMs = null;
    this.startedAtMs = sessionNowMs();
    this.peakLevel = 0;
    this.lastLevel = 0;
    this.silentBlocks = 0;
    this.totalBlocks = 0;

    const node = new AudioWorkletNode(context, "pcm-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
    });
    node.port.onmessage = (event) => this._write(event.data);
    this.node = node;
  }

  _write(block) {
    if (this.epochMs === null) {
      // Anchor the sample clock to the session clock once. This block was
      // captured just before it arrived, so back off its own duration.
      this.epochMs = sessionNowMs() - (block.length / this.sampleRate) * 1000;
    }

    for (let i = 0; i < block.length; i++) {
      this.ring[this.writeIndex] = block[i];
      this.writeIndex = (this.writeIndex + 1) % this.ringSize;
    }
    this.totalSamples += block.length;

    let peak = 0;
    for (let i = 0; i < block.length; i++) {
      const v = Math.abs(block[i]);
      if (v > peak) peak = v;
    }
    this.totalBlocks += 1;
    // Digital silence, not just quiet: a shared tab with no audio routed to it
    // produces exact zeros, which is the most common capture mistake.
    if (peak === 0) this.silentBlocks += 1;
    this.lastLevel = peak;
    if (peak > this.peakLevel) this.peakLevel = peak;
    if (this.onLevel) this.onLevel(peak);
  }

  /**
   * Is the capture actually receiving everything?
   *
   * The sample count is the audio clock; performance.now() is the session
   * clock. If the worklet ever misses a render quantum the two diverge, and
   * every timestamp downstream shifts with it -- so this is worth watching
   * rather than assuming.
   */
  getHealth() {
    if (this.epochMs === null || this.startedAtMs === null) {
      return { running: this.isRunning, receiving: false };
    }
    const elapsedMs = sessionNowMs() - this.startedAtMs;
    const capturedMs = (this.totalSamples / this.sampleRate) * 1000;
    const driftMs = capturedMs - elapsedMs;

    return {
      running: this.isRunning,
      receiving: this.totalBlocks > 0,
      contextState: this.context ? this.context.state : "closed",
      sampleRate: this.sampleRate,
      elapsedMs: Math.round(elapsedMs),
      capturedMs: Math.round(capturedMs),
      // >1 means we captured more than elapsed (impossible beyond rounding);
      // <1 means render quanta were dropped and timestamps are drifting.
      coverage: elapsedMs > 0 ? capturedMs / elapsedMs : 1,
      driftMs: Math.round(driftMs),
      bufferedMs: Math.round(
        Math.min(this.totalSamples, this.ringSize) / this.sampleRate * 1000
      ),
      peakLevel: this.peakLevel,
      lastLevel: this.lastLevel,
      // 1.0 means the track is carrying pure digital silence.
      silentFraction: this.totalBlocks ? this.silentBlocks / this.totalBlocks : 1,
      audible: this.peakLevel > 0.0005,
    };
  }

  /** Session time of the oldest sample still held. */
  get oldestAvailableMs() {
    if (this.epochMs === null) return null;
    const dropped = Math.max(0, this.totalSamples - this.ringSize);
    return this.epochMs + (dropped / this.sampleRate) * 1000;
  }

  get newestAvailableMs() {
    if (this.epochMs === null) return null;
    return this.epochMs + (this.totalSamples / this.sampleRate) * 1000;
  }

  /**
   * Extract [startMs, endMs) as a 16-bit mono WAV.
   * Returns null when nothing in that range is still buffered. `clipStartMs`
   * is the session time of the FIRST returned sample after clamping, which is
   * what the backend needs to place words on the shared timeline.
   */
  sliceToWav(startMs, endMs) {
    if (this.epochMs === null || this.totalSamples === 0) return null;

    const toSample = (ms) => Math.round(((ms - this.epochMs) / 1000) * this.sampleRate);
    const firstAvailable = Math.max(0, this.totalSamples - this.ringSize);

    let from = Math.max(firstAvailable, toSample(startMs));
    const to = Math.min(this.totalSamples, toSample(endMs));
    if (to <= from) return null;

    const length = to - from;
    const pcm = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      pcm[i] = this.ring[(from + i) % this.ringSize];
    }

    return {
      blob: encodeWav(pcm, this.sampleRate),
      clipStartMs: Math.round(this.epochMs + (from / this.sampleRate) * 1000),
      clipEndMs: Math.round(this.epochMs + (to / this.sampleRate) * 1000),
      durationMs: Math.round((length / this.sampleRate) * 1000),
      truncated: from > toSample(startMs),
    };
  }

  /** Forget buffered audio. Called on session stop so nothing lingers. */
  clearBuffer() {
    if (this.ring) this.ring.fill(0);
    this.writeIndex = 0;
    this.totalSamples = 0;
    this.epochMs = null;
    this.startedAtMs = null;
    this.peakLevel = 0;
    this.lastLevel = 0;
    this.silentBlocks = 0;
    this.totalBlocks = 0;
  }

  async stop() {
    try {
      if (this.source && this.source.stop) this.source.stop();
    } catch { /* a buffer source may already have ended */ }
    if (this.node) this.node.port.onmessage = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.clearBuffer();
    this.context = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.sourceLabel = "none";
  }
}

/** Minimal 16-bit PCM WAV encoder. faster-whisper resamples server-side. */
export function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);       // PCM chunk size
  view.setUint16(20, 1, true);        // format: PCM
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);        // block align
  view.setUint16(34, 16, true);       // bits per sample
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}
