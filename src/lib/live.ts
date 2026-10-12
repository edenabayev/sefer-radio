"use client";
// שיחה חיה עם Gemini מהדפדפן: מיקרופון → PCM 16kHz → Live API; שמע חוזר 24kHz → רמקול.
// חצי-דופלקס: בזמן שהמודל מדבר לא שולחים מיקרופון (מונע שהוא ישמע את עצמו ברכב).
import { GoogleGenAI, type LiveServerMessage, type Session } from "@google/genai";

export type LiveState = "connecting" | "listening" | "thinking" | "speaking" | "closed" | "error";

export interface LiveHandlers {
  onState: (s: LiveState) => void;
  onTranscript: (role: "user" | "model", text: string, final: boolean) => void;
  onError: (msg: string) => void;
}

export interface LiveHandle {
  stop: () => void;
}

const WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const out = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) { const v = Math.max(-1, Math.min(1, ch[i])); out[i] = v < 0 ? v * 32768 : v * 32767; }
    this.buf.push(out); this.n += out.length;
    if (this.n >= 2048) {
      const all = new Int16Array(this.n); let o = 0;
      for (const b of this.buf) { all.set(b, o); o += b.length; }
      this.port.postMessage(all.buffer, [all.buffer]); this.buf = []; this.n = 0;
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): ArrayBuffer {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function startLive(token: string, model: string, h: LiveHandlers): Promise<LiveHandle> {
  h.onState("connecting");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const micCtx = new AudioContext({ sampleRate: 16000 });
  const outCtx = new AudioContext({ sampleRate: 24000 });
  await micCtx.resume();
  await outCtx.resume();

  let session: Session | null = null;
  let closed = false;
  let nextTime = 0;
  const playing: AudioBufferSourceNode[] = [];
  let userText = "";
  let modelText = "";

  const speakingNow = () => nextTime > outCtx.currentTime + 0.05;

  const flushPlayback = () => {
    for (const s of playing.splice(0)) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    nextTime = 0;
  };

  const playChunk = (buf: ArrayBuffer) => {
    const i16 = new Int16Array(buf);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    const ab = outCtx.createBuffer(1, f32.length, 24000);
    ab.getChannelData(0).set(f32);
    const src = outCtx.createBufferSource();
    src.buffer = ab;
    src.connect(outCtx.destination);
    const at = Math.max(outCtx.currentTime + 0.02, nextTime);
    src.start(at);
    nextTime = at + ab.duration;
    playing.push(src);
    src.onended = () => {
      const k = playing.indexOf(src);
      if (k >= 0) playing.splice(k, 1);
      if (!speakingNow() && !closed) h.onState("listening");
    };
    h.onState("speaking");
  };

  const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
  session = await ai.live.connect({
    model,
    callbacks: {
      onopen: () => h.onState("listening"),
      onmessage: (m: LiveServerMessage) => {
        const sc = m.serverContent;
        if (!sc) return;
        if (sc.interrupted) flushPlayback();
        if (sc.inputTranscription?.text) {
          userText += sc.inputTranscription.text;
          h.onTranscript("user", userText, false);
        }
        if (sc.outputTranscription?.text) {
          modelText += sc.outputTranscription.text;
          h.onTranscript("model", modelText, false);
        }
        for (const part of sc.modelTurn?.parts ?? []) {
          if (part.inlineData?.data) playChunk(unb64(part.inlineData.data));
        }
        if (sc.turnComplete) {
          if (userText) h.onTranscript("user", userText, true);
          if (modelText) h.onTranscript("model", modelText, true);
          userText = "";
          modelText = "";
        }
      },
      onerror: (e) => {
        h.onError(e.message || "שגיאת חיבור");
        h.onState("error");
      },
      onclose: () => {
        if (!closed) h.onState("closed");
      },
    },
  });

  // מיקרופון → המודל
  const source = micCtx.createMediaStreamSource(stream);
  let node: AudioNode;
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await micCtx.audioWorklet.addModule(url);
    const w = new AudioWorkletNode(micCtx, "pcm-capture");
    w.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (closed || !session || speakingNow()) return;
      session.sendRealtimeInput({ audio: { data: b64(ev.data), mimeType: "audio/pcm;rate=16000" } });
    };
    node = w;
  } catch {
    // דפדפן ישן: ScriptProcessor
    const sp = micCtx.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = (ev) => {
      if (closed || !session || speakingNow()) return;
      const ch = ev.inputBuffer.getChannelData(0);
      const out = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) out[i] = Math.max(-1, Math.min(1, ch[i])) * 32767;
      session.sendRealtimeInput({ audio: { data: b64(out.buffer), mimeType: "audio/pcm;rate=16000" } });
    };
    node = sp;
  }
  source.connect(node);
  const sink = micCtx.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(micCtx.destination);

  return {
    stop: () => {
      closed = true;
      flushPlayback();
      try {
        session?.close();
      } catch {
        /* ignore */
      }
      stream.getTracks().forEach((t) => t.stop());
      micCtx.close().catch(() => {});
      outCtx.close().catch(() => {});
      h.onState("closed");
    },
  };
}
