class PaneForgeVoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(4096);
    this.length = 0;
    this.position = 0;
    this.frame = new Int16Array(480);
    this.frameLength = 0;
    this.step = sampleRate / 24000;
  }

  append(input) {
    const needed = this.length + input.length;
    if (needed > this.samples.length) {
      const next = new Float32Array(Math.max(needed, this.samples.length * 2));
      next.set(this.samples.subarray(0, this.length));
      this.samples = next;
    }
    this.samples.set(input, this.length);
    this.length += input.length;
  }

  emit(sample) {
    this.frame[this.frameLength++] = Math.max(-1, Math.min(1, sample)) * 32767;
    if (this.frameLength !== 480) return;
    this.port.postMessage({frame:this.frame.buffer,capturedAt:currentTime}, [this.frame.buffer]);
    this.frame = new Int16Array(480);
    this.frameLength = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;
    this.append(input);
    while (this.position + 1 < this.length) {
      const before = Math.floor(this.position);
      const blend = this.position - before;
      this.emit(this.samples[before] + (this.samples[before + 1] - this.samples[before]) * blend);
      this.position += this.step;
    }
    const consumed = Math.floor(this.position);
    if (consumed > 0) {
      this.samples.copyWithin(0, consumed, this.length);
      this.length -= consumed;
      this.position -= consumed;
    }
    return true;
  }
}

registerProcessor('paneforge-voice-processor', PaneForgeVoiceProcessor);
