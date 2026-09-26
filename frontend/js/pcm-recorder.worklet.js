/**
 * Forwards raw mono PCM to the main thread in fixed blocks.
 *
 * Counting samples here gives an exact clock: block N covers samples
 * [N*128, (N+1)*128), which the ring buffer turns into session milliseconds.
 * MediaRecorder cannot offer that -- its start latency is unspecified, and the
 * whole product hinges on knowing exactly when each word was spoken.
 */
class PCMRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel) return true;

    // Copy: the render quantum buffer is reused by the audio thread.
    this.port.postMessage(new Float32Array(channel), []);
    return true;
  }
}

registerProcessor("pcm-recorder", PCMRecorder);
