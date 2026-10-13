/**
 * audio.js — chart clock with optional local HTML audio.
 *
 * Owner: audio agent (website_loader/CONTRACTS.md § audio.js).
 * Dependency-free browser ES module; also importable in Node for tests (it then has no
 * document and silently uses the monotonic fallback).
 *
 * OFFSET CONVENTION (the important contract)
 * ------------------------------------------
 *   chartTime = audioPosition - outputLatency - offset
 *
 * `offset` is the chart's serialized audio offset (the .soda "audio offset (s)" field,
 * engine.js `offset`, and the value the server publishes as `charts[].offset`). It is the
 * audio-file position, in seconds, of chart second 0 — equivalently: how much of the file
 * must be skipped so that chart and audio agree.
 *
 *   offset > 0 → chart second 0 seeks to media position +offset (skips the opening).
 *   offset < 0 → the requested media position is initially negative and clamped to 0.
 *                Sample-exact delayed-start pre-roll is not implemented; HTML media can
 *                play immediately from 0. See AUDIO.md for this startup approximation.
 *
 * This is NOT the game's count-in and NOT `savedAudioDelay`/`songOffset`:
 * docs/03-timing-and-audio.md (MusicPlayer.GetMusicTime) defines
 *   normal timerDelay = 5 - savedAudioDelay + chartAudioOffset
 * where the 5 s count-in and the user's saved delay are session settings. The viewer has
 * no count-in and no saved delay, so only the chart's own offset is applied here.
 * Evidence label: source-observed (docs/03) + asset-confirmed (chart-inventory.json offset).
 *
 * CLOCK BEHAVIOUR
 * ---------------
 * - time is advanced from a monotonic wall clock (performance.now) and locked to the media
 *   element's own position while audio is healthy. The media element never drives `time`
 *   directly, so a jittery/plateauing currentTime cannot move the chart backwards.
 * - With no URL, an unsupported/failed URL, or a media element that never becomes ready,
 *   the clock runs a pure monotonic silent fallback and `load()` resolves with
 *   { mode: 'silent' } instead of throwing. The viewport keeps working: "silent preview".
 * - seeking, rate changes and pause work in both modes; while paused, time is frozen.
 */

export const VERSION = '1.0.0';

/** Defaults; every one can be overridden through the constructor options. */
export const DEFAULTS = Object.freeze({
  rate: 1,
  volume: 1,
  minRate: 0.0625,
  maxRate: 16,
  // Audio element time is read on each poll; drift beyond this many seconds is corrected.
  hardSyncSeconds: 0.08,
  // Normal media currentTime jitter; also the bound for forward corrections per read.
  jitterSeconds: 0.02,
  // The element is only re-seeked forward when it has fallen this far behind the clock.
  mediaSeekBackSeconds: 0.3,
  // Wall-clock drift beyond this is corrected even if the media element looks healthy.
  clockDriftSeconds: 0.35,
  // How long load() waits for the element to become playable before declaring silence.
  readyTimeoutMs: 2500,
  // Upper bound for the measured output latency used in the offset convention.
  maxLatencySeconds: 2,
  // 'hold' freezes at the end of the media; 'continue' (default) keeps the chart clock
  // advancing silently so a chart longer than its audio can still be inspected to its end.
  endBehavior: 'continue',
  // Media element is optimised for seeking during scrubbing.
  preload: 'auto',
});

const MODE = Object.freeze({ SILENT: 'silent', AUDIO: 'audio' });

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

function defaultNow() {
  const perf = typeof globalThis !== 'undefined' ? globalThis.performance : undefined;
  return perf && typeof perf.now === 'function' ? perf.now() / 1000 : Date.now() / 1000;
}

function defaultMediaFactory() {
  if (typeof globalThis === 'undefined' || typeof globalThis.document === 'undefined') return null;
  const el = globalThis.document.createElement('audio');
  if (!el || typeof el.play !== 'function') return null;
  return el;
}

/**
 * PlaybackClock — chart seconds source for renderer/game logic.
 *
 * Getters : time, playing, rate, volume, offset, status
 * Methods : load(url|null, {offset}), play(), pause(), seek(seconds), setRate(rate),
 *           setVolume(volume), setOffset(seconds), dispose()
 */
export class PlaybackClock {
  constructor(options = {}) {
    if (options === null || typeof options !== 'object') throw new TypeError('PlaybackClock options must be an object');
    this._opts = { ...DEFAULTS, ...options };
    this._now = typeof options.now === 'function' ? options.now : defaultNow;
    const factory = typeof options.mediaFactory === 'function' ? options.mediaFactory : defaultMediaFactory;

    /** @type {any|null} */
    this._media = null;
    this._detach = [];
    this._createMedia = factory;

    this._mode = MODE.SILENT;
    this._state = 'paused'; // 'paused' | 'playing' | 'ended'
    this._rate = clamp(Number(this._opts.rate) || 1, this._opts.minRate, this._opts.maxRate);
    this._volume = clamp(Number(this._opts.volume) ?? 1, 0, 1);
    this._offset = 0;
    this._latency = 0;
    this._anchorWall = this._now();
    this._anchorPos = 0;
    this._pos = 0;
    this._mediaTimeWatermark = 0;
    this._revision = 0;
    this._loadedRevision = -1;
    this._loadToken = 0;
    this._error = null;
    this._src = null;
    this._reason = 'new';
    this._pending = null;
    this._audioExhausted = false;
    this._lastMediaSeekAt = -Infinity;
    this._lastLatencyAt = -Infinity;
    this._maxPlausibleAhead = 0;
  }

  // ---------------------------------------------------------------- public getters

  /** Chart seconds. Never decreases while playing; frozen while paused. */
  get time() {
    this._sync(false);
    return this._pos;
  }

  get playing() {
    return this._state === 'playing';
  }

  get rate() {
    return this._rate;
  }

  get volume() {
    return this._volume;
  }

  get offset() {
    return this._offset;
  }

  /**
   * Diagnostics for the UI; not required by the contract.
   * `mode` is the *actual* clock source: 'audio' only while a real media element is driving
   * the position. A requested-but-failed URL stays 'silent' with `reason`/`error` set, so a
   * caller must never label it as local audio just because audioUrl was non-null.
   */
  get status() {
    const media = this._media;
    const healthy = this._mode === MODE.AUDIO && this._mediaHealthy();
    return {
      mode: healthy ? MODE.AUDIO : MODE.SILENT,
      requestedSource: this._src,
      reason: this._reason,
      state: this._state,
      hasMedia: Boolean(media),
      readyState: media ? media.readyState : 0,
      duration: media && Number.isFinite(media.duration) ? media.duration : null,
      latency: this._latency,
      error: this._error ? String(this._error.message || this._error) : null,
      audioExhausted: this._audioExhausted,
      usingFallback: !healthy,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Attach (or clear) the audio source and set the chart/audio offset.
   * Resolves — never rejects — with { mode: 'audio'|'silent', reason, duration, offset }.
   * A failed or unsupported URL leaves the clock running silently instead of breaking the UI.
   */
  async load(url, { offset = 0 } = {}) {
    const revision = ++this._loadToken;
    this._revision++;
    const wasPlaying = this._state === 'playing';
    const previousTime = this.time;
    this._offset = Number.isFinite(offset) ? Number(offset) : 0;
    this._error = null;
    this._mode = MODE.SILENT;
    this._pending = null;
    this._audioExhausted = false;
    this._reason = 'loading';

    if (!url) {
      this._src = null;
      this._reason = 'no-url';
      this._media = null;
      this._detachMedia();
      this._resetPosition(previousTime);
      this._state = wasPlaying ? 'playing' : 'paused';
      this._anchorWall = this._now();
      return { mode: MODE.SILENT, reason: 'no-url', duration: null, offset: this._offset };
    }

    const media = this._ensureMedia();
    if (!media) {
      this._src = url;
      this._reason = 'no-media-element';
      this._resetPosition(previousTime);
      this._state = wasPlaying ? 'playing' : 'paused';
      return { mode: MODE.SILENT, reason: 'no-media-element', duration: null, offset: this._offset };
    }

    this._src = url;
    this._setVolumeOnMedia();
    try {
      media.src = url;
      media.preload = this._opts.preload;
      if ('preservesPitch' in media) media.preservesPitch = true;
      else if ('mozPreservesPitch' in media) media.mozPreservesPitch = true;
      else if ('webkitPreservesPitch' in media) media.webkitPreservesPitch = true;
      media.playbackRate = this._rate;
      media.load?.();
    } catch (error) {
      this._error = error;
      this._reason = 'src-error';
      this._mode = MODE.SILENT;
      return { mode: MODE.SILENT, reason: 'src-error', duration: null, offset: this._offset };
    }

    this._resetPosition(previousTime);
    this._state = 'paused';
    if (wasPlaying) this._state = 'playing';

    const readiness = await this._waitForReadiness(media, revision);
    if (revision !== this._loadToken) {
      this._reason = 'superseded';
      return { mode: this._mode, reason: 'superseded', duration: this._duration(media), offset: this._offset };
    }
    if (readiness !== 'ready' && readiness !== 'superseded') {
      this._error = this._error || new Error(readiness === 'timeout' ? 'audio did not become ready' : 'audio element error');
      this._reason = readiness;
      this._mode = MODE.SILENT;
      // Keep the element attached: a late 'canplay' can still upgrade us to audio mode.
      return { mode: MODE.SILENT, reason: readiness, duration: this._duration(media), offset: this._offset };
    }
    if (readiness === 'superseded') {
      this._reason = 'superseded';
      return { mode: this._mode, reason: 'superseded', duration: this._duration(media), offset: this._offset };
    }

    this._mode = MODE.AUDIO;
    this._reason = 'ready';
    try {
      const start = this._mediaTarget(this._pos);
      if (start > 0) media.currentTime = start;
    } catch { /* element may refuse a seek before metadata; the poller corrects it */ }

    if (wasPlaying) {
      this._state = 'playing';
      this._anchorWall = this._now();
      this._anchorPos = this._pos;
      this._revision++;
      this._resumeMedia();
    }
    return { mode: MODE.AUDIO, reason: 'ready', duration: this._duration(media), offset: this._offset };
  }

  /** Start or resume playback. Resolves after the element was asked to play. */
  async play() {
    if (this._state === 'playing') return;
    if (this._state === 'ended') this._resetPosition(this._pos); // restart from the end position
    this._state = 'playing';
    this._anchorWall = this._now();
    this._anchorPos = this._pos;
    this._revision++;
    if (this._mode === MODE.AUDIO && this._media) await this._resumeMedia();
  }

  pause() {
    if (this._state !== 'playing') {
      this._sync(false);
      this._state = 'paused';
      return;
    }
    this._sync(false);
    this._state = 'paused';
    this._anchorWall = this._now();
    this._anchorPos = this._pos;
    this._revision++;
    this._pauseMedia();
  }

  /** Jump to an absolute chart time (seconds). Negative values clamp to 0. */
  seek(seconds) {
    const target = Number.isFinite(seconds) ? Math.max(0, Number(seconds)) : 0;
    this._pos = target;
    this._anchorPos = target;
    this._anchorWall = this._now();
    if (this._state === 'ended' && target < (this._duration(this._media) ?? Infinity)) this._state = 'paused';
    const duration = this._duration(this._media);
    if (duration !== null && target <= duration - 0.05) this._audioExhausted = false;
    if (duration !== null && target >= duration - 0.05 && this._opts.endBehavior === 'continue') {
      this._audioExhausted = true;
    }
    this._revision++;
    const media = this._media;
    if (this._mode === MODE.AUDIO && media) {
      const at = this._mediaTarget(target);
      try {
        if (Number.isFinite(at) && Math.abs((media.currentTime || 0) - at) > 0.004) {
          media.currentTime = at;
          this._lastMediaSeekAt = this._now();
        }
      } catch { /* ignore; poller retries */ }
      this._mediaTimeWatermark = Number.isFinite(media.currentTime) ? media.currentTime : this._mediaTimeWatermark;
      if (this._state === 'playing' && media.paused) this._resumeMedia();
    }
    return target;
  }

  /** Playback rate multiplier; also changes the chart clock rate. Clamped to [minRate, maxRate]. */
  setRate(rate) {
    const requested = Number(rate);
    const next = clamp(Number.isFinite(requested) ? requested : this._rate, this._opts.minRate, this._opts.maxRate);
    if (next === this._rate) return this._rate;
    this._sync(false);
    this._anchorWall = this._now();
    this._anchorPos = this._pos;
    this._rate = next;
    if (this._state === 'ended') this._state = 'paused';
    if (this._media) {
      try { this._media.playbackRate = next; } catch { /* unsupported rate */ }
    }
    this._revision++;
    return this._rate;
  }

  setVolume(volume) {
    const requested = Number(volume);
    this._volume = clamp(Number.isFinite(requested) ? requested : this._volume, 0, 1);
    this._setVolumeOnMedia();
    return this._volume;
  }

  /**
   * Change the chart/audio offset while playing. Applied from the next `time` read;
   * time is never moved backwards (a later offset is simply reached sooner).
   */
  setOffset(seconds) {
    const next = Number(seconds);
    if (!Number.isFinite(next) || next === this._offset) return this._offset;
    this._sync(false);
    this._offset = next;
    this._anchorPos = this._pos;
    this._anchorWall = this._now();
    this._revision++;
    const media = this._media;
    if (this._mode === MODE.AUDIO && media) {
      const at = this._mediaTarget(this._pos);
      try {
        if (Number.isFinite(at)) { media.currentTime = at; this._lastMediaSeekAt = this._now(); }
      } catch { /* ignore */ }
    }
    return this._offset;
  }

  /** Detach media, clear the source and stop the clock. The instance stays usable. */
  dispose() {
    this._state = 'paused';
    this._pos = 0;
    this._revision++;
    this._detachMedia();
    this._media = null;
    this._src = null;
    this._mode = MODE.SILENT;
    this._error = null;
  }

  // ---------------------------------------------------------------- internals

  _ensureMedia() {
    if (this._media) return this._media;
    let media = null;
    try { media = this._createMedia(); } catch { media = null; }
    if (!media) return null;
    this._media = media;
    const listen = (type, handler) => {
      const wrapped = () => handler();
      try { media.addEventListener(type, wrapped); } catch { media['on' + type] = wrapped; }
      this._detach.push(() => {
        try { media.removeEventListener(type, wrapped); } catch { /* ignore */ }
      });
    };
    listen('canplay', () => {
      if (this._mode !== MODE.AUDIO && this._src && this._error === null) {
        this._mode = MODE.AUDIO;
        this._reason = 'ready';
        this._revision++;
        const at = this._mediaTarget(this._pos);
        try { if (at > 0) media.currentTime = at; } catch { /* ignore */ }
        if (this._state === 'playing') this._resumeMedia();
      }
    });
    listen('error', () => {
      this._error = new Error('media element error');
      this._mode = MODE.SILENT;
      this._reason = 'media-error';
      this._revision++;
    });
    listen('ended', () => {
      if (this._opts.endBehavior === 'continue') {
        // The chart may outlast its audio; hand over to the monotonic clock.
        this._audioExhausted = true;
        this._revision++;
        return;
      }
      this._sync(false);
      this._state = 'ended';
      this._anchorWall = this._now();
      this._anchorPos = this._pos;
      this._revision++;
    });
    listen('stalled', () => { this._error = new Error('media stalled'); });
    listen('durationchange', () => { this._revision++; });
    this._setVolumeOnMedia();
    return media;
  }

  _detachMedia() {
    for (const off of this._detach) {
      try { off(); } catch { /* ignore */ }
    }
    this._detach = [];
    const media = this._media;
    if (media) {
      try { media.pause(); } catch { /* ignore */ }
      try { media.removeAttribute('src'); media.load?.(); } catch { /* ignore */ }
    }
  }

  _setVolumeOnMedia() {
    if (!this._media) return;
    try { this._media.volume = this._volume; } catch { /* ignore */ }
  }

  _resetPosition(seconds) {
    const target = Number.isFinite(seconds) ? Math.max(0, Number(seconds)) : 0;
    this._pos = target;
    this._anchorPos = target;
    this._anchorWall = this._now();
    this._mediaTimeWatermark = 0;
    this._revision++;
  }

  _duration(media) {
    if (!media) return null;
    const d = media.duration;
    return Number.isFinite(d) && d > 0 ? d : null;
  }

  _mediaHealthy() {
    const media = this._media;
    if (!media) return false;
    if (this._error && /stalled|error/i.test(String(this._error.message))) return false;
    if (media.readyState !== undefined && media.readyState < 2) return false;
    const d = media.duration;
    if (d !== undefined && !(Number.isFinite(d) || d === Infinity)) return false;
    return true;
  }

  /**
   * chart seconds → media currentTime seconds. Exact inverse of _mediaChartSeconds
   * except for the physical clamp at the start of the file.
   */
  _mediaTarget(chartSeconds) {
    return Math.max(0, chartSeconds + this._offset + this._latency);
  }

  /**
   * media currentTime seconds → chart seconds. Inverse of _mediaTarget:
   * mediaTarget(mediaChartSeconds(m)) === m for every m >= 0 (round-trip test in audio.test.js).
   */
  _mediaChartSeconds(mediaSeconds) {
    return mediaSeconds - this._latency - this._offset;
  }

  /**
   * Advance (or realign) the virtual position. Called by every `time` read.
   * `_pos` only ever increases while playing/ended; corrections move it forward by at
   * most the measured audio lead, so the chart never jumps backwards under the renderer.
   */
  _sync(force) {
    const now = this._now();
    const state = this._state;
    if (state === 'playing') {
      const elapsed = Math.max(0, now - this._anchorWall);
      this._pos = this._anchorPos + elapsed * this._rate;
    }
    this._anchorWall = now;
    this._anchorPos = this._pos;
    // Forward corrections are capped by the wall clock plus normal media jitter, so a
    // jumped-ahead currentTime can never pull the chart forward faster than real time.
    this._maxPlausibleAhead = this._pos + this._opts.jitterSeconds;

    // Media position is compared on every read: a currentTime plateau or a revision change
    // alone must not hide the moment the audio runs out. The read is a cheap property get;
    // only the timestamp measurement is throttled.
    if (this._mode !== MODE.AUDIO || !this._media || !this._mediaHealthy()) {
      this._loadedRevision = this._revision;
      return;
    }

    const media = this._media;
    if (this._audioExhausted) {
      // endBehavior 'continue': the media ran out before the chart did. Keep the monotonic
      // clock running so the remaining chart (short-media tail) stays inspectable.
      if (state === 'playing') {
        const duration = this._duration(media);
        if (duration === null || this._pos <= duration - 0.05 || media.currentTime < duration - 0.05) {
          this._audioExhausted = false; // seeked back inside the file: audio is usable again
        }
      }
      return;
    }
    const raw = Number(media.currentTime);
    if (!Number.isFinite(raw)) return;
    // Monotonic media watermark: a plateauing/rewinding currentTime must not rewind the chart.
    if (raw < this._mediaTimeWatermark) return;
    this._mediaTimeWatermark = raw;

    if (now - this._lastLatencyAt > 0.25) {
      this._measureLatency();
      this._lastLatencyAt = now;
    }
    const mediaChart = this._mediaChartSeconds(raw);
    const duration = this._duration(media);
    const mediaAtEnd = duration !== null && raw >= duration - 0.05;

    if (state === 'playing') {
      const clockDrift = mediaChart - this._pos;
      if (Math.abs(clockDrift) > this._opts.clockDriftSeconds) {
        // Media and wall clock disagree badly (tab throttling, suspend, stall).
        // Trust the media only up to the wall-clock bound, and never move backwards.
        if (clockDrift > 0 && mediaChart <= this._maxPlausibleAhead) this._pos = mediaChart;
      } else if (clockDrift > this._opts.hardSyncSeconds) {
        // Audio slightly ahead: advance the chart to it (forward only, never past reality).
        if (mediaChart <= this._maxPlausibleAhead) this._pos = mediaChart;
      } else if (clockDrift < -this._opts.mediaSeekBackSeconds) {
        // Audio clearly behind the chart: re-seek the element forward to the clock.
        const target = this._mediaTarget(this._pos);
        if (Number.isFinite(target) && target > 0 && now - this._lastMediaSeekAt > 0.25) {
          try { media.currentTime = target; this._lastMediaSeekAt = now; } catch { /* ignore */ }
        }
      }
      if (mediaAtEnd) {
        if (this._opts.endBehavior === 'hold') {
          this._state = 'ended';
          this._revision++;
        } else {
          this._audioExhausted = true;
        }
      }
    } else if (state === 'paused') {
      // A paused element is authoritative after a seek.
      const clockDrift = mediaChart - this._pos;
      if (Math.abs(clockDrift) > this._opts.hardSyncSeconds && mediaChart >= 0) {
        this._pos = Math.max(0, this._pos + Math.min(0, clockDrift));
      }
    }
  }

  /** Best-effort output-latency estimate (0 when the browser cannot report it). */
  _measureLatency() {
    const media = this._media;
    if (!media || typeof media.getOutputTimestamp !== 'function' || typeof this._now !== 'function') return;
    try {
      const ts = media.getOutputTimestamp();
      if (!ts || !Number.isFinite(ts.contextTime) || !Number.isFinite(ts.performanceTime)) return;
      const wallSeconds = ts.performanceTime / 1000;
      const raw = this._now() - wallSeconds;
      if (!Number.isFinite(raw)) return;
      // Ignore readings that are obviously not about audio output.
      if (raw < -0.05 || raw > this._opts.maxLatencySeconds) return;
      this._latency = clamp(raw, 0, this._opts.maxLatencySeconds);
    } catch { /* ignore */ }
  }

  _resumeMedia() {
    const media = this._media;
    if (!media) return Promise.resolve();
    if (this._pending) return this._pending;
    let promise;
    try { promise = media.play(); } catch (error) {
      this._error = error;
      this._mode = MODE.SILENT;
      return Promise.resolve();
    }
    if (!promise || typeof promise.then !== 'function') return Promise.resolve();
    this._pending = promise.then(() => {
      this._pending = null;
    }, (error) => {
      this._pending = null;
      // Autoplay policy / unsupported source: keep the monotonic clock running.
      if (error && (error.name === 'AbortError')) return;
      this._error = error;
      this._mode = MODE.SILENT;
      this._revision++;
    });
    return this._pending;
  }

  _pauseMedia() {
    const media = this._media;
    if (!media) return;
    try { media.pause(); } catch { /* ignore */ }
  }

  _waitForReadiness(media, revision) {
    if (typeof media.readyState === 'number' && media.readyState >= 2 && !this._error) return Promise.resolve('ready');
    const timeout = Number(this._opts.readyTimeoutMs);
    if (!(timeout > 0)) return Promise.resolve('ready');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        try { media.removeEventListener('canplay', onReady); } catch { /* ignore */ }
        try { media.removeEventListener('loadeddata', onReady); } catch { /* ignore */ }
        try { media.removeEventListener('error', onError); } catch { /* ignore */ }
        resolve(result);
      };
      const onReady = () => finish(this._error ? 'error' : 'ready');
      const onError = () => finish('error');
      try {
        media.addEventListener('canplay', onReady);
        media.addEventListener('loadeddata', onReady);
        media.addEventListener('error', onError);
      } catch {
        finish('error');
        return;
      }
      const timer = setTimeout(() => finish('timeout'), timeout);
      if (timer && typeof timer.unref === 'function') timer.unref();
      // A superseded load must not leave a dangling listener. `_loadToken` (not `_revision`,
      // which our own bookkeeping bumps) is what identifies a newer load.
      const check = setInterval(() => {
        if (revision !== this._loadToken) { clearInterval(check); finish('superseded'); }
      }, 50);
      if (check && typeof check.unref === 'function') check.unref();
    });
  }
}

export default PlaybackClock;
