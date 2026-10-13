# AUDIO — PlaybackClock, chart/audio offsets and local audio mapping

Owner: audio agent. Files: `audio.js`, `audio-map.json`, `AUDIO.md` (plus `audio.test.js`).
Read `CONTRACTS.md` first. No audio was rendered, decrypted, exported or uploaded for this work,
and no game/profile/script was executed: this only reads files that already exist in the workspace.

## 1. What `audio.js` exports

```js
import { PlaybackClock } from './audio.js';
const clock = new PlaybackClock();              // optional: inject now/mediaFactory for tests
await clock.load(urlOrNull, { offset });        // never rejects
clock.time        // chart seconds (getter, never decreases while playing)
clock.playing     // getter
clock.rate        // getter
clock.volume      // getter
await clock.play(); clock.pause(); clock.seek(seconds);
clock.setRate(r); clock.setVolume(v); clock.setOffset(seconds); clock.dispose();
clock.status      // diagnostics, see §5
```

`load()` returns `{ mode, reason, duration, offset }` where `mode` is `'audio'` or `'silent'`.
Every getter in the contract is a property, matching how `app.js` is written.

## 2. Offset convention (authoritative for this viewer)

```text
chartTime       = mediaPosition - outputLatency - offset      (exact inverse of the second line)
mediaPosition   = max(0, chartTime + offset + outputLatency)  (the max() is the only non-inverse)
```

`offset` is the chart's own serialized **audio offset** — `.soda` document field 8, `engine.js`
`chart.offset`, and the value the server publishes as `charts[].offset` (e.g. Before The Storm
`+0.127`, Forgotten Mission `-0.02`, Freagarthach `+0.014`, most charts within ±0.05). Semantics:
**the file-relative position that chart second 0 would map to**, before the physical clamp at the
start of the file.

Because a file cannot be played before its own position 0, `_mediaTarget()` clamps with that
`max(0, ...)`. The two signs therefore behave like this (this is what `audio.js` implements and
what the table below means):

| sign | chart time 0 | what actually happens |
|---|---|---|
| `offset > 0` | maps to file position `offset` | playback starts `offset` seconds into the file; that opening portion is skipped |
| `offset = 0` | maps to 0 | direct, no clamp |
| `offset < 0` | maps to a negative file position, clamped to 0 | the requested file position remains clamped while chart time is below `-offset`. The HTML media element can nevertheless start playing from 0 immediately: this viewer does not implement a sample-exact delayed-start pre-roll. The first `-offset` seconds are therefore an approximation; seek beyond that interval uses the stated inverse exactly (subject to browser seek granularity) |

Evidence for the algebra (source-observed, `docs/03-timing-and-audio.md`): `MusicPlayer.GetMusicTime()`
returns `Stopwatch.Elapsed - timerDelay` with `timerDelay = 5 - savedAudioDelay + chartAudioOffset`,
and the FMOD event plays from its own zero, so `chartTime = audioTime - chartAudioOffset`. The
viewer applies only the chart's own offset; the count-in and saved delay are not applied, which is
what creates the clamped pre-roll/hold cases above. Chart times in this document are taken from the
parent's compiled `engine.js` output, not from an independent re-derivation.

**What is deliberately NOT applied:** the game's 5 s count-in (`MusicPlayer`), the user's saved
audio delay (`savedAudioDelay`), the saved visual delay, and practice-mode seek adjustments. None
of those exist in a browser viewer, and mixing them in would make the offset mean something
different from the game's `chartAudioOffset`. `setOffset()` exists so the UI's offset slider can
change the alignment live; it takes effect from the next `time` read and never moves time backwards.

## 3. Clock behaviour

- **Audio mode.** The element is the reference while it is healthy. `time` is advanced from a
  monotonic wall clock on every read and then corrected toward `media.currentTime`:
  forward corrections only, capped by wall time plus `jitterSeconds` (20 ms), so a jumped
  `currentTime` cannot race the chart ahead of real time; a large forward disagreement
  (> `clockDriftSeconds`, 350 ms — tab throttling or suspend) is pulled to the media, forward only;
  an element that has fallen > 300 ms behind is re-seeked forward to the clock.
- **Monotonic guarantee.** While `playing` is true, `time` never decreases, whatever
  `currentTime` reports. A plateauing or rewinding `currentTime` is ignored (monotonic watermark).
- **Silent fallback.** With `load(null)`, a failing/unsupported URL, no `document` (Node), or an
  element that never reaches `readyState >= 2`, the clock runs purely on the monotonic wall clock
  and `load()` resolves `mode: 'silent'` instead of throwing. The viewport keeps working.
- **Pause / seek / rate.** `pause()` freezes `time`; `seek(s)` is exact in both modes (clamped at 0)
  and moves the element to `s + offset`; `setRate(r)` is continuous (re-anchored, no jump) and
  clamped to `[0.0625, 16]`.
- **End of audio.** Default `endBehavior: 'continue'`: when the element reaches its end the clock
  keeps advancing monotonically (`status.audioExhausted === true`) so a chart longer than its audio
  can still be inspected to its last note. `endBehavior: 'hold'` freezes at the media end instead.
- **Output latency.** When the element exposes `getOutputTimestamp()`, the measured
  presentation delay is subtracted from media position (clamped to `maxLatencySeconds`). Otherwise
  latency is 0, and device latency remains unobserved — see §6.

## 4. Local audio mapping (`audio-map.json`)

Keys are the published chart ids (`charts/<id>.json` inside `website_loader/`); values are either a
workspace-relative path string or an object `{ path, duration, source, format, audioFilename,
offset, verification, notes }`. `server.mjs` resolves them with `path.resolve(root, mapped)` and
only accepts `.wav/.mp3/.ogg/.m4a`, so all paths here are workspace-relative POSIX with a
supported extension. The mapped files are **not** part of the published folder: a standalone clone
starts with silent previews, and an entry whose file is absent simply yields no audio.

**Candidate mapping (10 ids, 9 distinct files). These are *candidate* pairings of local audio,
NOT confirmed identical masters, and NOT verified sample-exact synchronisation.** A name/title
match only shows that the file is the one a human or the game's own matcher would pick; it cannot
show that the file is the same master, version, edit or encode the chart was authored against.
Every file below is an existing `game/user_audio/*.wav`: RIFF/WAVE **PCM16, 48 kHz, stereo**, a
single `fmt `/`data` pair, audible from ~frame 0 (no leading silence of any kind) — decodable by
current Chrome, Firefox and Safari, and served with a range-capable `audio/wav` response by the
parent server.

| Chart id | File | File length | Chart first note | Chart last note | Alignment caveat |
|---|---|---|---|---|---|
| `Basic_Tutorial_a06c592833ac` | `Basic Tutorial.wav` | 153.56 s | 27.0 s | 144.0 s | candidate (title match only); file covers the chart |
| `Before_The_Storm_3a7e1451c2d5` | `Before The Storm.wav` | 157.69 s | 2.16 s | 153.05 s | candidate (title match; chart names `Ardolf - Before The Storm.ogg`); covers the chart with ~4.6 s of audio left over — spare length is not proof of the same edit |
| `Forgotten_Mission_19fa84514725` | `Forgotten Mission.wav` | 167.18 s | 2.67 s | 164.09 s | candidate (base-name match); file covers the chart, but the file is a different length than the native FMOD render of the same event (174.23 s), so the version is unconfirmed |
| `Forgotten_Mission_2026_AF_2__c210fdb7a8eb` | `Forgotten Mission.wav` | 167.18 s | 1.33 s | 164.09 s | same file, same version caveat |
| `Freagarthach_5fd68c8964a1` | `Freagarthach.wav` | 147.88 s | 2.84 s | 142.72 s | candidate (title match); covers the chart |
| `GOODTEK_e7c60ba6888b` | `GOODTEK.wav` | 125.35 s | 0.0 s | 121.58 s | candidate (title match; chart names `GOODTEK_master_2025.wav`, so another revision may exist) |
| `Luxe_Chain_e854fcacafe7` | `Luxe Chain.wav` | 168.71 s | 1.48 s | 165.93 s | candidate (title match; chart names `luxe chain - master.wav`); covers the chart |
| `Training_1_cf15de000072` | `Magicis Phantasmatibus (Training Cut).wav` | 71.68 s | 0.0 s | 65.4 s (chart duration 102.1 s) | candidate (exact file-name match, the strongest signal here) — but the compiled chart runs to 102.1 s while the file ends at 71.68 s, so ~30 s of chart has no audio. This is a **length/version mismatch**, not an offset that can be tuned away |
| `Training_2_9e19d94fcf5c` | `Warrior Of Wolfville (Training Cut).wav` | 92.85 s | 0.07 s | 86.41 s | candidate (base-name match, case differs); covers the chart |
| `Training_3_0e305758c58c` | `Credits.wav` | 99.41 s | 1.34 s | 97.54 s | candidate (exact file-name match); covers the chart, but the first note already sits 1.34 s in — that is a chart property, not evidence that this file is the authored master |

Chart times above come from the parent's compiled `engine.js` (`compileChart`), not from this
agent's own conductor re-derivation. Note that a chart's first note time is a property of the
chart; it is **not** evidence about which audio file is correct, and it does not validate the
offset sign.

Matching follows the game's own `AudioLocator` order (exact chart file name, then same base name
with another supported extension, then title): `Training_1`/`Training_3` are exact file-name
matches; `Before_The_Storm`/`Freagarthach`/`GOODTEK`/`Luxe_Chain`/`Basic_Tutorial` are title
matches because the chart's stored name is a different source file (e.g. `Ardolf - Before The
Storm.ogg`, `GOODTEK_master_2025.wav`); `Forgotten_Mission` is a base-name match;
`Training_2` differs only in the case of "of"/"Of". A name match selects a **candidate**; it cannot
distinguish two edits of the same song.

**Recommendation for the UI:** show mapped audio as "local audio found (unverified match)" rather
than "audio ready/synced", and surface the per-entry `verification`/`notes` text. For
`Training_1` the file provably cannot cover the chart (102.1 s chart vs 71.7 s file), and for
`Forgotten Mission` the file length disagrees with the native render of the same event, so a user
should be told the audio may be a different or shortened version instead of hunting for an offset.

**Excluded on purpose (declared unreliable).**

- `Warrior_Of_Wolfville_01ef8821371d` — the only candidate is the 92.85 s *Training Cut*, but the
  chart runs to t = 245.12 s (stored name `Ardolf_-_Warrior_of_Wolfville.ogg`). Mapping it would
  desynchronise the playfield against unrelated music, so no mapping is declared.
- `Magicis_Phantasmatibus_ff7bbd5896ef` — the chart's stored name is
  `Magicis Proeliis • Phantasmatibus p1 mastered.wav`; the workspace has
  `Magicis Phantasmatibus.wav` (full, 132.88 s) and the Training Cut only. Title-similar is not
  verified, so no mapping is declared.

**Unmapped (11 chart ids)**: `Advanced_Tutorial`, `Fantasia_Sonata_God_Dance_WH`,
`Hermodr`, `SolarFragment`, `Tainted_Reminiscence`, `deathmatch`, `how_to_make_otoge_music`,
`petrified_thistle`, `thief`, `Warrior_Of_Wolfville`, `Magicis_Phantasmatibus`. These keep the
silent-preview fallback (`audioUrl: null`) until the user attaches local files in the browser.

## 5. `status` for the UI (avoid describing silence as local audio)

```js
clock.status = { mode, requestedSource, reason, state, hasMedia, readyState, duration,
                 latency, error, audioExhausted, usingFallback }
```

`mode` is `'audio'` **only** while a real element is actually driving the clock. If a mapped file
is missing, unsupported or fails to become ready, `mode` stays `'silent'`,
`usingFallback === true`, and `reason`/`error` explain why (`no-url`, `no-media-element`,
`src-error`, `timeout`, `error`, `media-error`, `ready`). A caller must gate any "LOCAL AUDIO"
label on `status.mode === 'audio'`, not on `audioUrl` being non-null.

## 6. Limitations and unobserved behaviour

1. Integration verification drove headless Chrome with the mapped Luxe Chain WAV: it decoded,
   reported LOCAL AUDIO, sought to 15 seconds, and advanced during playback with no console errors.
   This observes browser media playback, not audible speaker output or sample-exact synchronisation.
   Other candidate files have not individually been played in the browser.
2. Output-device latency is unmeasured unless the browser implements `getOutputTimestamp()`;
   otherwise the latency term is 0 and real device delay (typically 10–50 ms on Windows) is not
   corrected. The chart offset slider is the practical adjustment, exactly as the game exposes an
   audio-delay setting.
3. The 12 files are 13–32 MB of uncompressed stereo PCM (**308 MB total**). They load from
   loopback and support range requests, but first-play buffering and memory are a real cost; no
   encoder was run to shrink them (that would require rendering/transcoding, which this task
   forbids). A mapped chart plays fine, but the browser is holding one full WAV per page, and the
   server reads the whole file into memory per request (`readFile` in `server.mjs`), so the
   parent may want a streaming send if more than one large file is ever fetched at once.
4. The `game/user_audio/*.wav` files are byte-identical copies of the "previous project WAVs"
   preserved in `artifacts-local/audio-wav-export/previous-wavs/` (`reports/manifest-final.json`),
   and their content differs from the fresh native FMOD renders in `songs/`: the fresh renders
   begin with 3.1–5.5 s of silence and are 5.0–7.0 s longer, while every `user_audio` file is
   audible from frame 0 (peak ±0.33 full scale). Both are consistent performances
   (envelope correlation 0.96–0.998), so the pair is the same recording with different leading
   silence and trim, but **the provenance of the `user_audio` copies is not established by this
   audit** and they were not regenerated. Treat the mapping as "existing workspace audio that
   matches this chart", not as an original-bank export.
5. All 12 files begin with short click-like transients at a constant interval (e.g. 0.35 s in
   `Luxe Chain`, 0.30 s in `Forgotten Mission`) before the music starts: typically a single
   non-zero frame at 0 s, ~0.35 s of true digital silence, then a repeated transient about every
   0.3–0.35 s (block peak ≈ 0.17–0.33 full scale) until the music begins 2–3 s in (measured in
   `artifacts-local/audio-audit/`; the raw files were not modified or re-exported). They look like
   a count-in/measure marker, but their origin is unverified. They are **not** compensated for: the
   chart offsets are ≤ 0.163 s in magnitude, so the clock/timeline relationship is unaffected, but a
   user may hear clicks before the music. If a future audit shows they are part of the intended
   timeline, the map's `offset` values would shift accordingly — this is a per-file property, not a
   clock bug.
6. `setOffset()` never moves time backwards by design; a user changing the offset mid-playback
   hears the correction at the next read without a backwards jump.
7. `docs/10-open-questions.md` lists device/audio latency and DSP correction during pause/seek as
   unobserved in the game too; this module's resync policy is a browser-safe approximation, not a
   reconstruction of `MusicPlayer`'s 0.1 s DSP/Stopwatch correction.

## 7. Tests and evidence

- `node --test audio.test.js` — 12 checks: contract shape, silent monotonic fallback, broken-source
  degradation, offset round-trip (both signs), media tail continuation, hold mode, monotonicity
  under jitter/rewind, rate continuity and clamping, exact seek in both modes, volume clamp,
  dispose/reuse, and status diagnostics. Run from `website_loader/`.
- Local audit artifacts (read-only derivation, not deliverables):
  `artifacts-local/audio-audit/audio-audit.json`, `audio-match-table.txt`, `audio-profiles.json`,
  `source-match.json`, produced by the scripts in the same directory from
  `analysis/chart-inventory.json` and the existing WAV headers.
