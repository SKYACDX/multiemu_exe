// Playback for whatever the core has synthesised. One AudioBuffer per
// emulated frame, scheduled back to back against the AudioContext's own
// clock -- not an AudioWorklet, because there is no DSP to do here, only
// handing over samples the core already produced.

// How far ahead of the clock the queue is kept. Below this, ordinary
// scheduling jitter opens an audible gap; above the ceiling, the emulator is
// outrunning real time and the extra queue is just latency.
const MIN_LEAD_S = 0.05;
const MAX_LEAD_S = 0.2;

// Frames to pull per call. A frame of emulation produces about 800 at
// 48kHz, and mGBA's own buffer holds 2048, so this never truncates.
const READ_FRAMES = 2048;

let context = null;
let playhead = 0;

function audioStart(sampleRate) {
  audioStop();
  if (!sampleRate) return; // a core with no APU (the Game Boy one, so far)
  context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
  playhead = 0;
}

function audioStop() {
  if (context) context.close();
  context = null;
}

// Browsers start an AudioContext suspended until the page has seen a user
// gesture. Opening a ROM through the picker counts, but launching straight
// into one from the command line doesn't, so any key or click resumes it.
function audioResume() {
  if (context && context.state === 'suspended') context.resume();
}

function audioPush(samples) {
  if (!context || samples.length === 0) return;

  const now = context.currentTime;
  // Running ahead of real time: dropping the chunk is better than letting
  // latency creep up for the rest of the session.
  if (playhead - now > MAX_LEAD_S) return;

  const frames = samples.length / 2;
  const buffer = context.createBuffer(2, frames, context.sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  for (let i = 0; i < frames; i++) {
    left[i] = samples[i * 2] / 32768;
    right[i] = samples[i * 2 + 1] / 32768;
  }

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);

  // Resync when the queue has drained -- the first buffer, or after a stall.
  if (playhead < now + MIN_LEAD_S) playhead = now + MIN_LEAD_S;
  source.start(playhead);
  playhead += buffer.duration;
}
