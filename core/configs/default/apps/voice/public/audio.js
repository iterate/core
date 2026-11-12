// audio.js — THE BROWSER'S AUDIO, kept to what voice speaks: 16 kHz mono PCM16, base64 on the
// wire, 50 ms microphone frames in, answer frames of any length out. One AudioContext at 16 kHz
// carries both directions, so nothing is resampled here. The two worklets beside this file do the
// work on each sample, off the main thread.

/** PCM16 samples to the base64 a `mic-frame` carries. */
export function int16ToBase64(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** A `speaker-frame`'s base64 back to PCM16 samples, in a buffer of its own. */
export function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length - (binary.length % 2));
  for (let at = 0; at < bytes.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return new Int16Array(bytes.buffer);
}

/**
 * Open the microphone and the speaker on one 16 kHz context. Call it from a click: a browser gives
 * the microphone, and lets sound play, only after a gesture. The answer:
 *
 *   onFrame   set by the caller: gets one frame of 800 samples every 50 ms
 *   speaker   push(pcm) queues a chunk of the answer; clear() drops what is queued
 *   close()   stops the microphone and the context
 */
export async function openAudio() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16_000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContext({ sampleRate: 16_000 });
  try {
    await Promise.all([
      context.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url)),
      context.audioWorklet.addModule(new URL("./playback-worklet.js", import.meta.url)),
    ]);
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    await context.close();
    throw error;
  }
  const capture = new AudioWorkletNode(context, "capture");
  const playback = new AudioWorkletNode(context, "playback");
  context.createMediaStreamSource(stream).connect(capture);
  capture.connect(context.destination); // silent: connected so that the worklet keeps running
  playback.connect(context.destination);
  const session = {
    onFrame: null,
    speaker: {
      push: (pcm) => playback.port.postMessage({ type: "push", pcm }, [pcm.buffer]),
      clear: () => playback.port.postMessage({ type: "clear" }),
    },
    async close() {
      capture.port.onmessage = null;
      for (const track of stream.getTracks()) track.stop();
      await context.close();
    },
  };
  capture.port.onmessage = (event) => session.onFrame?.(event.data);
  await context.resume();
  return session;
}
