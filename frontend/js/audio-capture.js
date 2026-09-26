/**
 * Lecture audio capture into a short ephemeral ring buffer.
 */

import { sessionNowMs } from "./session.js";

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
    this.totalSamples = 0;
    this.epochMs = null;
    this.sampleRate = 0;
    this.sourceLabel = "none";
    this.onLevel = null;

    this.startedAtMs = null;
    this.peakLevel = 0;
    this.lastLevel = 0;
    this.silentBlocks = 0;
    this.totalBlocks = 0;
  }

  get isRunning() {
    return this.context !== null && this.context.state !== "closed";
  }

  async startTabAudio() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
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

  async startFile(file) {
    const context = new AudioContext();
    await this._setupGraph(context, "file: " + file.name);
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.node);
    source.connect(context.destination);
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
    if (peak === 0) this.silentBlocks += 1;
    this.lastLevel = peak;
    if (peak > this.peakLevel) this.peakLevel = peak;
    if (this.onLevel) this.onLevel(peak);
  }

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
      coverage: elapsedMs > 0 ? capturedMs / elapsedMs : 1,
      driftMs: Math.round(driftMs),
      bufferedMs: Math.round(
        Math.min(this.totalSamples, this.ringSize) / this.sampleRate * 1000
      ),
      peakLevel: this.peakLevel,
      lastLevel: this.lastLevel,
      silentFraction: this.totalBlocks ? this.silentBlocks / this.totalBlocks : 1,
      audible: this.peakLevel > 0.0005,
    };
  }

  get oldestAvailableMs() {
    if (this.epochMs === null) return null;
    const dropped = Math.max(0, this.totalSamples - this.ringSize);
    return this.epochMs + (dropped / this.sampleRate) * 1000;
  }

  get newestAvailableMs() {
    if (this.epochMs === null) return null;
    return this.epochMs + (this.totalSamples / this.sampleRate) * 1000;
  }

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
    } catch { /* may already have ended */ }
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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
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
