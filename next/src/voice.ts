import { useCallback, useEffect, useRef, useState } from "react";

export type VoicePhase =
  | "off"
  | "connecting"
  | "listening"
  | "speaking"
  | "error";
export type VoiceStatus = {
  configured?: boolean;
  reason?: string;
  weeklyLimitUsd?: number;
  remainingUsd?: number;
  model?: string;
};

type VoiceResources = {
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  processor?: AudioWorkletNode | ScriptProcessorNode;
  silent?: GainNode;
  stream?: MediaStream;
  socket?: WebSocket;
  scheduled: Set<AudioBufferSourceNode>;
  audibleScheduled: Set<AudioBufferSourceNode>;
  audiblePlaying: Set<AudioBufferSourceNode>;
  playbackTimers: Map<AudioBufferSourceNode, number>;
  connectionTimer?: number;
  silenceTimer?: number;
  lastAudibleAt?: number;
  delegating?: boolean;
  meterFrame?: number;
  inputMeter?: AnalyserNode;
  outputMeter?: AnalyserNode;
};

const idleStatus: VoiceStatus = {
  configured: false,
  reason: "Checking voice configuration",
};
const emptyResources = (): VoiceResources => ({
  scheduled: new Set(),
  audibleScheduled: new Set(),
  audiblePlaying: new Set(),
  playbackTimers: new Map(),
});
const toWebSocketUrl = (sessionId?: string, clientId?: string) => {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const query = sessionId
    ? `?session=${encodeURIComponent(sessionId)}&client=${encodeURIComponent(clientId || "")}`
    : "";
  return `${protocol}//${location.host}/api/voice${query}`;
};

const pcmFromBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return new Int16Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
};

const within = <T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
) =>
  new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(Error(message)),
      milliseconds,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });

class PcmFramer {
  private samples = new Float32Array(0);
  private position = 0;
  private frame = new Int16Array(480);
  private frameLength = 0;
  private readonly step: number;

  constructor(inputRate: number) {
    this.step = inputRate / 24000;
  }

  push(input: Float32Array, onFrame: (frame: ArrayBuffer) => void) {
    const next = new Float32Array(this.samples.length + input.length);
    next.set(this.samples);
    next.set(input, this.samples.length);
    this.samples = next;
    while (this.position + 1 < this.samples.length) {
      const before = Math.floor(this.position),
        blend = this.position - before;
      this.frame[this.frameLength++] =
        Math.max(
          -1,
          Math.min(
            1,
            this.samples[before] +
              (this.samples[before + 1] - this.samples[before]) * blend,
          ),
        ) * 32767;
      this.position += this.step;
      if (this.frameLength === 480) {
        onFrame(this.frame.buffer);
        this.frame = new Int16Array(480);
        this.frameLength = 0;
      }
    }
    const consumed = Math.floor(this.position);
    if (consumed) {
      this.samples = this.samples.slice(consumed);
      this.position -= consumed;
    }
  }
}

export function useVoice(sessionId?: string, clientId?: string) {
  const [phase, setPhase] = useState<VoicePhase>("off");
  const [status, setStatus] = useState<VoiceStatus>(idleStatus);
  const [detail, setDetail] = useState("");
  const [action, setAction] = useState<{
    label: string;
    active: boolean;
  } | null>(null);
  const [levels, setLevels] = useState({
    input: Array(24).fill(0) as number[],
    output: Array(24).fill(0) as number[],
  });
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!connectedAt) {
      setElapsedSeconds(0);
      return;
    }
    const update = () =>
      setElapsedSeconds(Math.floor((Date.now() - connectedAt) / 1000));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [connectedAt]);
  const resources = useRef<VoiceResources>(emptyResources());
  const generation = useRef(0);
  const ready = useRef(false);
  const scheduledUntil = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/voice/status", {
        headers: { Accept: "application/json" },
      });
      const payload = (await response.json()) as VoiceStatus;
      if (!response.ok)
        throw Error(payload.reason || "Voice status is unavailable");
      setStatus(payload);
      return payload;
    } catch (error) {
      const next = {
        configured: false,
        reason:
          error instanceof Error
            ? error.message
            : "Voice status is unavailable",
      };
      setStatus(next);
      return next;
    }
  }, []);

  const stop = useCallback(() => {
    generation.current += 1;
    ready.current = false;
    scheduledUntil.current = 0;
    const current = resources.current;
    resources.current = emptyResources();
    window.clearTimeout(current.connectionTimer);
    window.clearInterval(current.silenceTimer);
    if (current.meterFrame !== undefined)
      window.cancelAnimationFrame(current.meterFrame);
    try {
      current.socket?.close(1000, "Voice ended");
    } catch {}
    current.playbackTimers.forEach((timer) => window.clearTimeout(timer));
    current.scheduled.forEach((source) => {
      try {
        source.stop();
      } catch {}
    });
    current.processor?.disconnect();
    current.source?.disconnect();
    current.silent?.disconnect();
    current.inputMeter?.disconnect();
    current.outputMeter?.disconnect();
    current.stream?.getTracks().forEach((track) => track.stop());
    void current.context?.close().catch(() => undefined);
    setConnectedAt(null);
    setPhase("off");
    setAction(null);
    setDetail("");
    setLevels({ input: Array(24).fill(0), output: Array(24).fill(0) });
  }, []);

  const fail = useCallback(
    (message: string) => {
      stop();
      setPhase("error");
      setDetail(message);
    },
    [stop],
  );

  const toggle = useCallback(async () => {
    if (resources.current.context || (phase !== "off" && phase !== "error")) {
      stop();
      return;
    }
    const run = ++generation.current;
    setPhase("connecting");
    setDetail("Waiting for microphone permission…");
    ready.current = false;
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      fail("This browser does not support live voice audio");
      return;
    }
    try {
      // Capture at the device's native rate. Both processors resample to the
      // provider's 24 kHz format; forcing the capture graph rate is unnecessary.
      const context = new AudioContext();
      // Start resume in the button gesture. It can resolve while permission or
      // the worklet loads, but is not awaited until socket handlers exist.
      const resumed = context.resume();
      // Permission may reject or remain pending before we await resume below.
      void resumed.catch(() => undefined);
      const current: VoiceResources = { ...emptyResources(), context };
      resources.current = current;
      if (!status.configured) {
        const checked = await refresh();
        if (run !== generation.current) return;
        if (!checked.configured) {
          fail(checked.reason || "Live voice is not configured");
          return;
        }
      }
      const native = (
        window as Window & {
          __TAURI_INTERNALS__?: {
            invoke: (command: string) => Promise<string>;
          };
        }
      ).__TAURI_INTERNALS__;
      if (native) {
        setDetail("Waiting for macOS microphone permission…");
        let permission: string;
        try {
          permission = await within(
            native.invoke("request_microphone_permission"),
            60_000,
            "macOS microphone permission is still pending. Stop voice and retry after answering the permission prompt.",
          );
        } catch (error) {
          const message = String(error);
          throw Error(
            /command.*not found|not allowed/i.test(message)
              ? "The native microphone repair is not installed yet. Update PaneForge Next before using voice."
              : `Native microphone setup: ${message}`,
          );
        }
        if (run !== generation.current) return;
        if (permission !== "granted")
          throw Error(
            permission === "denied"
              ? "Microphone access is denied. Enable PaneForge Next in System Settings → Privacy & Security → Microphone, then retry."
              : `Microphone access is ${permission}.`,
          );
      }
      setDetail("Opening microphone audio…");
      let microphoneTimedOut = false;
      const microphone = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      void microphone.then(
        (stream) => {
          if (microphoneTimedOut || run !== generation.current)
            stream.getTracks().forEach((track) => track.stop());
        },
        () => undefined,
      );
      let stream: MediaStream;
      try {
        stream = await within(
          microphone,
          20_000,
          "Microphone capture did not start. Bring PaneForge Next to the front and try again.",
        );
      } catch (error) {
        microphoneTimedOut = true;
        throw error;
      }
      if (run !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream = stream;
      setDetail("Preparing microphone audio…");
      const source = context.createMediaStreamSource(stream);
      const inputMeter = context.createAnalyser(),
        outputMeter = context.createAnalyser();
      inputMeter.fftSize = outputMeter.fftSize = 1024;
      current.inputMeter = inputMeter;
      current.outputMeter = outputMeter;
      outputMeter.connect(context.destination);
      const inputSamples = new Float32Array(1024),
        outputSamples = new Float32Array(1024);
      const amplitudes = (samples: Float32Array) =>
        Array.from({ length: 24 }, (_, bar) => {
          const from = Math.floor((bar * samples.length) / 24),
            to = Math.floor(((bar + 1) * samples.length) / 24);
          let energy = 0;
          for (let i = from; i < to; i++) energy += samples[i] * samples[i];
          return Math.min(1, Math.sqrt(energy / (to - from)) * 5);
        });
      let lastMeterAt = 0;
      const meter = (at: number) => {
        if (run !== generation.current) return;
        if (at - lastMeterAt >= 60) {
          inputMeter.getFloatTimeDomainData(inputSamples);
          outputMeter.getFloatTimeDomainData(outputSamples);
          setLevels({
            input: amplitudes(inputSamples),
            output: amplitudes(outputSamples),
          });
          lastMeterAt = at;
        }
        current.meterFrame = window.requestAnimationFrame(meter);
      };
      current.meterFrame = window.requestAnimationFrame(meter);
      const silent = context.createGain();
      silent.gain.value = 0;
      let sendAudio = (_frame: ArrayBuffer) => undefined;
      let processor: AudioWorkletNode | ScriptProcessorNode;
      try {
        if (!window.AudioWorkletNode || !context.audioWorklet)
          throw Error("AudioWorklet is unavailable");
        await within(
          context.audioWorklet.addModule(
            new URL("/voice-processor.js", location.origin).href,
          ),
          8_000,
          "Voice audio setup timed out",
        );
        if (run !== generation.current) return;
        const worklet = new AudioWorkletNode(
          context,
          "paneforge-voice-processor",
        );
        worklet.port.onmessage = (event) => {
          // A blocked renderer can receive a burst of old worklet messages.
          // Discard stale microphone audio instead of flooding the provider.
          const { frame, capturedAt } = event.data;
          if (context.currentTime - capturedAt <= 0.25) sendAudio(frame);
        };
        processor = worklet;
      } catch {
        if (run !== generation.current) return;
        // Chromium's muted headless runtime can reject AudioWorklet modules.
        // ScriptProcessor still uses the real input stream and keeps the same
        // 20 ms PCM contract without opening a second connection.
        const fallback = context.createScriptProcessor(2048, 1, 1);
        const framer = new PcmFramer(context.sampleRate);
        fallback.onaudioprocess = (event) => {
          event.outputBuffer.getChannelData(0).fill(0);
          if (run === generation.current)
            framer.push(event.inputBuffer.getChannelData(0), sendAudio);
        };
        processor = fallback;
      }
      current.source = source;
      current.processor = processor;
      current.silent = silent;
      source.connect(inputMeter);
      inputMeter.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
      // Do not establish a billable session while the microphone prompt or
      // worklet setup is pending. Once connected, install every handler before
      // the next await so early ready/error events cannot be lost.
      const socket = new WebSocket(toWebSocketUrl(sessionId, clientId));
      current.socket = socket;
      setDetail("Connecting to live voice…");
      current.connectionTimer = window.setTimeout(() => {
        if (run === generation.current && !ready.current)
          fail(
            "Voice connection timed out. Check your connection and try again.",
          );
      }, 15_000);
      sendAudio = (frame) => {
        if (
          run !== generation.current ||
          !ready.current ||
          socket.readyState !== WebSocket.OPEN
        )
          return;
        const pcm = new Int16Array(frame);
        let energy = 0;
        for (let i = 0; i < pcm.length; i++) energy += (pcm[i] / 32768) ** 2;
        if (Math.sqrt(energy / Math.max(1, pcm.length)) >= 0.01)
          current.lastAudibleAt = Date.now();
        const bytes = frame.byteLength;
        if (socket.bufferedAmount + bytes > 96_000) {
          fail("Live voice microphone audio fell behind, so it was stopped");
          return;
        }
        try {
          socket.send(frame);
        } catch {
          fail("Live voice connection closed while sending audio");
        }
      };
      socket.onopen = () => {
        if (run !== generation.current) socket.close(1000, "Voice ended");
      };
      socket.onmessage = (event) => {
        if (run !== generation.current || typeof event.data !== "string")
          return;
        let message: {
          direction?: string;
          type?: string;
          message?: string;
          active?: boolean;
          label?: string;
          reason?: string;
          delta?: string;
          audio?: string;
          data?: { delta?: string };
        };
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (
          message.type === "voice.ready" ||
          message.type === "session.started"
        ) {
          if (!ready.current) {
            // Local ready cue: no speech generation or network request. Track it
            // with playback resources so Cancel/Stop also stops the cue.
            const cue = context.createBuffer(
              1,
              Math.ceil(context.sampleRate * 0.18),
              context.sampleRate,
            );
            const samples = cue.getChannelData(0);
            for (let i = 0; i < samples.length; i++) {
              const t = i / context.sampleRate;
              const envelope =
                Math.min(1, t / 0.012) * Math.max(0, 1 - t / 0.18);
              samples[i] =
                Math.sin(2 * Math.PI * (t < 0.09 ? 660 : 880) * t) *
                0.07 *
                envelope;
            }
            const sound = context.createBufferSource();
            sound.buffer = cue;
            sound.connect(context.destination);
            current.scheduled.add(sound);
            sound.onended = () => {
              current.scheduled.delete(sound);
              sound.disconnect();
            };
            sound.start();
            current.lastAudibleAt = Date.now();
            current.silenceTimer = window.setInterval(() => {
              if (run !== generation.current) return;
              if (
                current.delegating ||
                current.audiblePlaying.size ||
                current.audibleScheduled.size
              ) {
                current.lastAudibleAt = Date.now();
                return;
              }
              if (
                Date.now() - (current.lastAudibleAt ?? Date.now()) >=
                30_000
              ) {
                stop();
                setDetail(
                  "Voice turned off after 30 seconds of silence. Your work continues.",
                );
              }
            }, 1000);
          }
          ready.current = true;
          setConnectedAt((previous) => previous ?? Date.now());
          window.clearTimeout(current.connectionTimer);
          setDetail("");
          if (resources.current.audiblePlaying.size === 0)
            setPhase("listening");
          return;
        }
        if (
          message.type === "voice.action" &&
          typeof message.label === "string"
        ) {
          setAction({
            label: message.label.slice(0, 400),
            active: message.active === true,
          });
          return;
        }
        if (message.type === "voice.delegation") {
          current.delegating = message.active === true;
          current.lastAudibleAt = Date.now();
          return;
        }
        if (message.type === "voice.error") {
          fail(message.message || "Live voice connection failed");
          return;
        }
        if (
          (message.type === "voice.status" && message.active === false) ||
          message.type === "session.ended"
        ) {
          stop();
          if (message.reason) setDetail(message.reason);
          return;
        }
        if (message.type !== "session.output_audio.delta") return;
        const encoded = message.delta || message.audio || message.data?.delta;
        if (!encoded) return;
        try {
          const pcm = pcmFromBase64(encoded);
          const duration = pcm.length / 24000;
          let energy = 0,
            peak = 0;
          for (let index = 0; index < pcm.length; index++) {
            const sample = pcm[index] / 32768;
            energy += sample * sample;
            peak = Math.max(peak, Math.abs(sample));
          }
          const audible =
            Math.sqrt(energy / Math.max(1, pcm.length)) >= 0.003 ||
            peak >= 0.003;
          const queued = Math.max(
            0,
            scheduledUntil.current - context.currentTime,
          );
          if (queued + duration > 2) {
            fail("Live voice playback fell behind, so it was stopped");
            return;
          }
          const buffer = context.createBuffer(1, pcm.length, 24000);
          const channel = buffer.getChannelData(0);
          for (let index = 0; index < pcm.length; index++)
            channel[index] = pcm[index] / 32768;
          const playback = context.createBufferSource();
          playback.buffer = buffer;
          playback.connect(outputMeter);
          const startAt = Math.max(
            context.currentTime + 0.02,
            scheduledUntil.current,
          );
          scheduledUntil.current = startAt + duration;
          current.scheduled.add(playback);
          if (audible) {
            current.lastAudibleAt = Date.now();
            current.audibleScheduled.add(playback);
            const timer = window.setTimeout(
              () => {
                current.playbackTimers.delete(playback);
                current.audibleScheduled.delete(playback);
                if (
                  run !== generation.current ||
                  !current.scheduled.has(playback)
                )
                  return;
                current.audiblePlaying.add(playback);
                setPhase("speaking");
              },
              Math.max(0, (startAt - context.currentTime) * 1000),
            );
            current.playbackTimers.set(playback, timer);
          }
          playback.onended = () => {
            current.scheduled.delete(playback);
            current.audibleScheduled.delete(playback);
            current.audiblePlaying.delete(playback);
            const timer = current.playbackTimers.get(playback);
            if (timer !== undefined) window.clearTimeout(timer);
            current.playbackTimers.delete(playback);
            if (run === generation.current && current.audiblePlaying.size === 0)
              setPhase("listening");
          };
          playback.start(startAt);
        } catch {
          fail("Live voice returned invalid audio");
        }
      };
      socket.onerror = () => {
        if (run === generation.current) fail("Live voice connection failed");
      };
      socket.onclose = (event) => {
        if (run !== generation.current) return;
        if (event.code === 1000) stop();
        else fail(event.reason || "Live voice connection closed");
      };
      await within(
        resumed,
        8_000,
        "Audio playback could not start. Try voice again.",
      );
      if (run !== generation.current) return;
    } catch (error) {
      if (run === generation.current) {
        const name = error instanceof Error ? error.name : "";
        fail(
          name === "NotAllowedError"
            ? "Microphone access was denied. Allow PaneForge Next in System Settings → Privacy & Security → Microphone, then retry voice."
            : name === "NotFoundError"
              ? "No microphone was found. Connect or select an input device, then retry voice."
              : name === "NotReadableError"
                ? "The microphone could not be opened. Check your input device and try again."
                : error instanceof Error
                  ? error.message
                  : "Live voice could not start",
        );
      }
    }
  }, [fail, phase, refresh, sessionId, clientId, status.configured, stop]);

  useEffect(() => {
    if (phase === "off" || phase === "error") void refresh();
  }, [refresh, phase]);
  useEffect(() => stop, [sessionId, clientId, stop]);

  return {
    phase,
    detail,
    action,
    levels,
    connectedAt,
    elapsedSeconds,
    active:
      phase === "connecting" || phase === "listening" || phase === "speaking",
    toggle,
    stop,
    status,
    refresh,
  };
}
