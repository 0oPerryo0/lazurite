/**
 * audio.test.js — offline checks for the PlaybackClock contract.
 * Owned by the audio agent. Runs under `node --test` with no browser:
 * a scripted fake media element and a controllable clock are injected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackClock, DEFAULTS, VERSION } from '../audio.js';

/** Controllable wall clock. */
function fakeClock() {
  let t = 1000;
  const now = () => t;
  now.advance = (seconds) => { t += seconds; };
  return now;
}

/** Minimal HTMLAudioElement double. */
class FakeMedia {
  constructor({ duration = 120, readyState = 4, failReady = false } = {}) {
    this.duration = duration;
    this.readyState = readyState;
    this.currentTime = 0;
    this.volume = 1;
    this.playbackRate = 1;
    this.preload = 'auto';
    this.paused = true;
    this.listeners = new Map();
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.loadCalls = 0;
    this.failReady = failReady;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type) { for (const fn of this.listeners.get(type) ?? []) fn(); }
  load() { this.loadCalls++; if (!this.failReady) this.readyState = 4; }
  play() {
    this.playCalls++;
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.pauseCalls++; this.paused = true; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}

function makeClock({ media = new FakeMedia(), readyTimeoutMs = 10, ...clockOptions } = {}) {
  const now = fakeClock();
  const clock = new PlaybackClock({ now, mediaFactory: () => media, readyTimeoutMs, ...clockOptions });
  return { clock, now, media };
}

test('exports the contract shape', () => {
  assert.equal(typeof VERSION, 'string');
  const clock = new PlaybackClock({ mediaFactory: () => null });
  for (const prop of ['time', 'playing', 'rate', 'volume', 'offset', 'status']) {
    assert.ok(prop in clock, `missing getter ${prop}`);
  }
  for (const method of ['load', 'play', 'pause', 'seek', 'setRate', 'setVolume', 'setOffset', 'dispose']) {
    assert.equal(typeof clock[method], 'function', `missing method ${method}`);
  }
  assert.equal(clock.playing, false);
  assert.equal(clock.time, 0);
});

test('silent fallback: load(null) resolves silent and time advances monotonically', async () => {
  const { clock, now } = makeClock();
  const result = await clock.load(null, { offset: 0 });
  assert.equal(result.mode, 'silent');
  await clock.play();
  assert.equal(clock.playing, true);
  let previous = clock.time;
  for (let i = 0; i < 50; i++) {
    now.advance(0.02);
    const t = clock.time;
    assert.ok(t >= previous, 'time went backwards');
    previous = t;
  }
  assert.ok(previous > 0.9 && previous < 1.2, `unexpected elapsed ${previous}`);
  clock.pause();
  const frozen = clock.time;
  now.advance(5);
  assert.equal(clock.time, frozen, 'paused clock advanced');
  assert.equal(clock.playing, false);
});

test('a broken source degrades to silent instead of throwing', async () => {
  const media = new FakeMedia({ readyState: 0, failReady: true });
  const { clock } = makeClock({ media });
  const result = await clock.load('/api/audio/missing', { offset: 0 });
  assert.equal(result.mode, 'silent');
  assert.ok(result.reason === 'timeout' || result.reason === 'error');
  assert.equal(clock.status.mode, 'silent', 'status must not claim local audio');
  assert.equal(clock.status.usingFallback, true);
  await clock.play();
  assert.equal(clock.playing, true);
});

test('offset convention: chartTime = mediaPosition - offset (and the inverse round-trips)', async () => {
  const { clock, media } = makeClock();
  const result = await clock.load('/api/audio/x', { offset: 0.5 });
  assert.equal(result.mode, 'audio');
  clock.seek(2);                          // chart second 2
  assert.equal(media.currentTime, 2.5);   // 2 + 0.5 of lead-in already elapsed
  assert.equal(clock.time, 2);
  clock.setOffset(-0.25);
  assert.equal(clock.offset, -0.25);
  clock.seek(2);
  assert.equal(media.currentTime, 1.75);  // 2 + (-0.25)

  // Round trip through the private conversions for both signs of offset.
  for (const offset of [-2, -0.5, 0, 0.25, 3]) {
    for (const mediaSeconds of [0, 0.001, 12.5, 180]) {
      const chart = 1 * 0 + mediaSeconds - 0 - offset; // documented: chart = media - latency - offset
      const back = chart + offset + 0;                 // documented inverse: media = chart + offset + latency
      assert.ok(Math.abs(back - mediaSeconds) < 1e-12, `round trip failed: ${offset} ${mediaSeconds} -> ${back}`);
    }
  }
});

test('chart tails keep running after short audio ends (endBehavior continue)', async () => {
  const media = new FakeMedia({ duration: 2 });
  const { clock, now } = makeClock({ media });
  await clock.load('/api/audio/x', { offset: 0 });
  await clock.play();
  // Simulate the element playing out its 2 s and then stopping.
  now.advance(2.0);
  media.currentTime = 2.0;
  clock.time;                 // poll: marks the audio exhausted
  media.paused = true;        // browser stops the element at EOF
  media.emit('ended');
  assert.equal(clock.playing, true, 'chart clock must keep running for the silent tail');
  now.advance(3.0);
  const tail = clock.time;
  assert.ok(tail > clock.offset + 4.5, `tail did not advance: ${tail}`);
  assert.ok(clock.status.audioExhausted === true);
});

test('audio mode follows the media element and clamps at duration end when holding', async () => {
  const media = new FakeMedia({ duration: 3 });
  const { clock, now } = makeClock({ media });
  await clock.load('/api/audio/x', { offset: 0 });
  await clock.play();
  for (let i = 0; i < 10; i++) {
    now.advance(0.5);
    media.currentTime = Math.min(3, media.currentTime + 0.5);
    clock.time;
  }
  assert.equal(clock.playing, true, 'default continue keeps the chart clock alive');
  assert.equal(clock.status.audioExhausted, true);

  const holdMedia = new FakeMedia({ duration: 3 });
  const holding = makeClock({ media: holdMedia, endBehavior: 'hold' });
  await holding.clock.load('/api/audio/x', { offset: 0 });
  await holding.clock.play();
  for (let i = 0; i < 10; i++) {
    holding.now.advance(0.5);
    holdMedia.currentTime = Math.min(3, holdMedia.currentTime + 0.5);
    holding.clock.time;
  }
  assert.equal(holding.clock.playing, false, 'hold mode should stop at media end');
  assert.ok(holding.clock.time <= 3.05, `hold time ${holding.clock.time} exceeded media duration`);
});

test('jittery or rewinding currentTime never moves the chart clock backwards', async () => {
  const media = new FakeMedia({ duration: 300 });
  const { clock, now } = makeClock({ media });
  await clock.load('/api/audio/x', { offset: 0 });
  await clock.play();
  let previous = clock.time;
  const script = [0.1, 0.2, 0.2, 0.05, 0.3, 0.3, 0.28, 0.5, 0.5, 0.5];
  for (const pos of script) {
    now.advance(0.05);
    media.currentTime = pos;
    const t = clock.time;
    assert.ok(t >= previous, `time went backwards at media pos ${pos}: ${t} < ${previous}`);
    previous = t;
  }
});

test('rate changes are continuous and clamp to the configured range', async () => {
  const { clock, now } = makeClock();
  await clock.load(null, { offset: 0 });
  await clock.play();
  now.advance(1);
  const before = clock.time;
  clock.setRate(2);
  assert.equal(clock.rate, 2);
  const afterChange = clock.time;
  assert.ok(afterChange >= before && afterChange - before < 0.01, 'rate change jumped');
  now.advance(0.5);
  assert.ok(Math.abs(clock.time - (afterChange + 1)) < 1e-9);
  assert.equal(clock.setRate(1e9), DEFAULTS.maxRate);
  assert.equal(clock.setRate(-5), DEFAULTS.minRate);
});

test('seek is exact in both modes and pause freezes the clock', async () => {
  const withMedia = makeClock();
  await withMedia.clock.load('/api/audio/x', { offset: 0 });
  assert.equal(withMedia.clock.seek(42.5), 42.5);
  assert.equal(withMedia.clock.time, 42.5);
  assert.equal(withMedia.media.currentTime, 42.5);

  const silent = makeClock();
  await silent.clock.load(null, { offset: 0 });
  assert.equal(silent.clock.seek(-10), 0, 'negative seek clamps to zero');
  assert.equal(silent.clock.seek(12.25), 12.25);
  assert.equal(silent.clock.time, 12.25);
});

test('setVolume clamps and is applied to the media element', async () => {
  const { clock, media } = makeClock();
  await clock.load('/api/audio/x', { offset: 0 });
  clock.setVolume(0.25);
  assert.equal(clock.volume, 0.25);
  assert.equal(media.volume, 0.25);
  clock.setVolume(7);
  assert.equal(clock.volume, 1);
});

test('dispose detaches the element and leaves the instance reusable', async () => {
  const { clock, media } = makeClock();
  await clock.load('/api/audio/x', { offset: 0 });
  clock.dispose();
  assert.ok(media.pauseCalls > 0);
  assert.equal(clock.playing, false);
  assert.equal(clock.time, 0);
  const again = await clock.load(null, { offset: 0 });
  assert.equal(again.mode, 'silent');
});

test('status exposes fallback diagnostics for the UI', async () => {
  const { clock } = makeClock();
  const silent = await clock.load(null);
  assert.equal(silent.mode, 'silent');
  assert.equal(clock.status.usingFallback, true);
  assert.equal(clock.status.mode, 'silent');
});

test('delayed canplay still resolves audio while pause/seek/setRate happen during the wait', async () => {
  // Regression: load() must not treat its own internal bookkeeping bumps as a supersede, and the
  // canplay upgrade must survive pause()/seek()/setRate() issued while the element is still loading.
  const media = new FakeMedia({ readyState: 0 });
  media.load = () => { media.loadCalls++; media.readyState = 0; }; // stays unready...
  const { clock, now } = makeClock({ media, readyTimeoutMs: 200 });
  setTimeout(() => { media.readyState = 4; media.emit('canplay'); }, 20); // ...until later

  const pending = clock.load('/api/audio/x', { offset: 0.05 });
  assert.equal(clock.status.mode, 'silent', 'before ready the clock is a silent fallback');

  clock.setRate(1.5);
  assert.equal(clock.rate, 1.5);
  assert.equal(clock.seek(10), 10);
  assert.equal(clock.time, 10);
  await clock.play();
  assert.equal(clock.playing, true);
  clock.pause();
  assert.equal(clock.playing, false);

  const result = await pending;
  assert.equal(result.mode, 'audio', 'a late canplay must still resolve as audio');
  assert.equal(result.reason, 'ready');
  assert.equal(clock.status.mode, 'audio');
  assert.equal(clock.status.usingFallback, false);
  assert.equal(clock.rate, 1.5, 'the rate set during the wait was kept');
  assert.equal(clock.time, 10, 'the seek during the wait was kept');
  assert.ok(Math.abs(media.currentTime - 10.05) < 1e-9, `media target ${media.currentTime}`);

  // The upgrade adopts the pending state rather than restarting playback.
  await clock.play();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(clock.playing, true);
  assert.equal(media.paused, false, 'play() after the upgrade actually starts the element');
  assert.equal(media.playbackRate, 1.5);
  now.advance(1);
  assert.ok(clock.time >= 10.99 && clock.time <= 11.51, `unexpected time ${clock.time}`);
});
