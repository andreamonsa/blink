/**
 * Forwards raw mono PCM to the main thread in fixed blocks.
 */
class PCMRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel) return true;

    this.port.postMessage(new Float32Array(channel), []);
    return true;
  }
}

registerProcessor("pcm-recorder", PCMRecorder);
