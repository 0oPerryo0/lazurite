/**
 * engine.js — normalized original-chart parser and conductor compiler.
 *
 * Evidence base (see ../docs/02-chart-format.md, ../docs/03-timing-and-audio.md and
 * ../evidence/decompiled/**):
 *   - SodaliteParser `ChartFile` / `Difficulty` / `Note` / `ExtendedLaneData` / `LaneData` /
 *     `TimingPoint` / `ScrollSegment` / `GimmickGroup` MessagePack schemas (numeric keys).
 *   - `Sodalite.Util.Easing` / `Easings` — the exact (partly nonstandard) easing curves.
 *   - `SodaChartLoader.LoadChart` / `CreateTimingNotes` / `CreateScrollGroups` /
 *     `CreateMeasureLines` / `SodaNoteToGameNotes` / `ExtendedLaneDataTo*`.
 *   - `Crystallium.Types.Rhythm.Conductor`, `ConductorState`, `BaseNote`,
 *     `Crystallium.BPM`, `Crystallium.ScrollFactorChange`, `Crystallium.ChartPlayer`.
 *
 * Everything here is dependency-free ES module code usable from the browser and from
 * `node:test`. No DOM, no network, no filesystem.
 *
 * Coordinate systems (from ConductorState):
 *   beat (rhythmic time)  b
 *   chart seconds (absolute time)  t
 *   visual position  p
 *
 * FAILURE ACCOUNTING — this module reproduces the *simulation* only. It never loads
 * audio, never touches FMOD, and never applies the player's `savedVisualDelay`.
 * `t` is chart seconds measured on `MusicPlayer.GetMusicTime()`'s clock, where the
 * ordinary 5-second count-in appears as negative time
 * (`timerDelay = 5 - savedAudioDelay + chartAudioOffset`). Chart seconds here are
 * therefore audio-relative-but-unshifted; `parseChart().offset` (ChartFile key 8) is
 * the serialized audio offset that the game feeds into that timer delay, while
 * `compileChart().secondsPerBeat` / `beatAt` / `timeAt` are already expressed in this
 * same chart-second space.
 *
 * OFFLINE-TESTED SCOPE — `engine.test.js` checks all 21 recovered payloads / 63
 * difficulty records: 74,967 serialized lane points become 74,967 game-note points in
 * 48,800 notes, 8,248 measure lines and 6,500 scroll events (334 instantaneous changes,
 * 6,166 discrete ramp steps). It also cross-checks every sampled note against an
 * independent forward re-simulation of `ConductorState` (position bit-identical, time
 * within float rounding).
 *
 * DOCUMENTED LIMITATIONS (see the report accompanying this module):
 *   - No Unity gameplay process was ever run, so fixed-update order, input scheduling,
 *     audio/DSP latency and the real `GetMusicTime()` clock are unobserved here.
 *   - Dash (type 4) does not appear in any recovered chart; its branch is implemented
 *     from `ExtendedLaneDataToDash` but never exercised by data.
 *   - `GimmickGroup.Easing` (key 4) is not used by any loader branch and is only
 *     preserved as data. The path-angle quaternion, the playfield-move render transform
 *     and gimmick *timing* over a group are not modelled beyond the raw angle.
 *   - Stereo/mirroring (`isMirror`), `Bullet` hitbox size, and hazard (Onibi) behaviour
 *     are outside this module; `bullets` expose only the loader's lane center.
 *   - `Note.GetHashCode()` gives runtime-only reference identities, so this module uses
 *     its own stable `id` (`n<index>`) instead.
 *   - The empty Hermóðr Crescent record is compiled with an `empty-difficulty` warning
 *     where the loader would throw; every other loader failure (unknown note type,
 *     missing/duplicate difficulty class, missing lane data) is reproduced as a throw.
 */

// ---------------------------------------------------------------------------------------
// Note types
// ---------------------------------------------------------------------------------------

/** Numeric note type -> loader behaviour. Confirmed against SodaChartLoader.SodaNoteToGameNotes. */
export const NOTE_TYPE = Object.freeze({
  TAP: 0,
  SLIDE: 1,
  BULLET: 2,
  VOID: 3,
  DASH: 4,
});

export const NOTE_TYPE_NAME = Object.freeze({
  0: 'tap',
  1: 'slide',
  2: 'bullet',
  3: 'void',
  4: 'dash',
});

/**
 * Difficulty class ids. DifficultyClass enum order, and the names used by
 * ChartPlayer.GetChartInfo for the result screen.
 */
export const DIFFICULTY_NAME = Object.freeze({
  0: 'Crescent',
  1: 'Lunar',
  2: 'Astral',
  3: 'Bloodlust',
  4: 'Eclipse',
});

/** `Sodalite.Util.Easings` numeric codes (values used verbatim in chart data). */
export const EASING_CODE = Object.freeze({
  NOTHING: -1,
  LINEAR: 0,
  IN_SINE: 1,
  OUT_SINE: 2,
  IN_QUAD: 3,
  OUT_QUAD: 4,
  IN_CUBIC: 5,
  OUT_CUBIC: 6,
  IN_QUART: 7,
  OUT_QUART: 8,
  IN_QUINT: 9,
  OUT_QUINT: 10,
  IN_EXPO: 11,
  OUT_EXPO: 12,
  IN_CIRC: 13,
  OUT_CIRC: 14,
  IN_BACK: 15,
  OUT_BACK: 16,
  IN_ELASTIC: 17,
  OUT_ELASTIC: 18,
  IN_BOUNCE: 19,
  OUT_BOUNCE: 20,
});

/** Human readable code -> name, in enum order. */
export const EASING_NAMES = Object.freeze([
  'EaseLinear',
  'EaseInSine',
  'EaseOutSine',
  'EaseInQuad',
  'EaseOutQuad',
  'EaseInCubic',
  'EaseOutCubic',
  'EaseInQuart',
  'EaseOutQuart',
  'EaseInQuint',
  'EaseOutQuint',
  'EaseInExpo',
  'EaseOutExpo',
  'EaseInCirc',
  'EaseOutCirc',
  'EaseInBack',
  'EaseOutBack',
  'EaseInElastic',
  'EaseOutElastic',
  'EaseInBounce',
  'EaseOutBounce',
]);

/** Gimmick numeric type -> loader branch. Names below are the *loader* behaviour, not the enum. */
export const GIMMICK_BEHAVIOR = Object.freeze({
  SCROLL_MOD_OVERRIDE: 'approach-rate-multiplier (loader case 0)',
  MOVE_PLAYFIELD: 'path-angle (loader cases 1 and 2)',
  SELECT_SCROLL_GROUP: 'scroll-group-select (loader case 3)',
});

// ---------------------------------------------------------------------------------------
// Easing — exact ports of Sodalite.Util.Easing (note the nonstandard definitions)
// ---------------------------------------------------------------------------------------

const SIN = Math.sin;
const COS = Math.cos;
const PI = Math.PI;
const SQRT = Math.sqrt;
const POW = Math.pow;
const ABS = Math.abs;

/**
 * Named easing functions, all taking a normalized `t` in [0, 1].
 * These are literal ports of `Sodalite.Util.Easing`; several deliberately differ from
 * the common "easing library" definitions (EaseInSine is `sin(1.5707963 t)`,
 * EaseInExpo is `(2^(8t) - 1)/255`, EaseInCirc is `1 - sqrt(1 - t)`, the elastic and
 * bounce curves use `sin(t*pi*4.5)` / `|sin(t*pi*3.5)|`, ...). Do not "fix" them.
 */
export const easingFunctions = Object.freeze({
  EaseLinear: (t) => t,
  EaseInSine: (t) => SIN(1.5707963 * t),
  EaseOutSine: (t) => 1.0 + SIN(1.5707963 * (t - 1.0)),
  EaseInQuad: (t) => t * t,
  EaseOutQuad: (t) => t * (2.0 - t),
  EaseInCubic: (t) => t * t * t,
  EaseOutCubic: (t) => {
    const u = t - 1.0;
    return 1.0 + u * u * u;
  },
  EaseInQuart: (t) => {
    const u = t * t;
    return u * u;
  },
  EaseOutQuart: (t) => {
    const u = t - 1.0;
    const v = u * u;
    return 1.0 - v * v;
  },
  EaseInQuint: (t) => {
    const u = t * t;
    return t * u * u;
  },
  EaseOutQuint: (t) => {
    const u = t - 1.0;
    const v = u * u;
    return 1.0 + u * v * v;
  },
  EaseInExpo: (t) => (POW(2.0, 8.0 * t) - 1.0) / 255.0,
  EaseOutExpo: (t) => 1.0 - POW(2.0, -8.0 * t),
  EaseInCirc: (t) => 1.0 - SQRT(1.0 - t),
  EaseOutCirc: (t) => SQRT(t),
  EaseInBack: (t) => t * t * (2.70158 * t - 1.70158),
  EaseOutBack: (t) => {
    const u = t - 1.0;
    return 1.0 + u * u * (2.70158 * u + 1.70158);
  },
  EaseInElastic: (t) => {
    const u = t * t;
    return u * u * SIN(t * PI * 4.5);
  },
  EaseOutElastic: (t) => {
    const u = (t - 1.0) * (t - 1.0);
    return 1.0 - u * u * COS(t * PI * 4.5);
  },
  EaseInBounce: (t) => POW(2.0, 6.0 * (t - 1.0)) * ABS(SIN(t * PI * 3.5)),
  EaseOutBounce: (t) => 1.0 - POW(2.0, -6.0 * t) * ABS(COS(t * PI * 3.5)),
});

/**
 * Port of `Easing.ConvertToEasing`. Any code outside 0..20 (including -1 `Nothing`,
 * which is the serialized default for `LaneData.Easing`) returns `t` unchanged.
 */
export function easingAt(t, code) {
  switch (code) {
    case 0:
      return t;
    case 1:
      return easingFunctions.EaseInSine(t);
    case 2:
      return easingFunctions.EaseOutSine(t);
    case 3:
      return easingFunctions.EaseInQuad(t);
    case 4:
      return easingFunctions.EaseOutQuad(t);
    case 5:
      return easingFunctions.EaseInCubic(t);
    case 6:
      return easingFunctions.EaseOutCubic(t);
    case 7:
      return easingFunctions.EaseInQuart(t);
    case 8:
      return easingFunctions.EaseOutQuart(t);
    case 9:
      return easingFunctions.EaseInQuint(t);
    case 10:
      return easingFunctions.EaseOutQuint(t);
    case 11:
      return easingFunctions.EaseInExpo(t);
    case 12:
      return easingFunctions.EaseOutExpo(t);
    case 13:
      return easingFunctions.EaseInCirc(t);
    case 14:
      return easingFunctions.EaseOutCirc(t);
    case 15:
      return easingFunctions.EaseInBack(t);
    case 16:
      return easingFunctions.EaseOutBack(t);
    case 17:
      return easingFunctions.EaseInElastic(t);
    case 18:
      return easingFunctions.EaseOutElastic(t);
    case 19:
      return easingFunctions.EaseInBounce(t);
    case 20:
      return easingFunctions.EaseOutBounce(t);
    default:
      return t;
  }
}

/** Code -> function resolver; unknown/`-1` codes resolve to identity (linear). */
export function easingFunction(code) {
  const name = Number.isInteger(code) && code >= 0 && code < EASING_NAMES.length
    ? EASING_NAMES[code]
    : null;
  return name ? easingFunctions[name] : easingFunctions.EaseLinear;
}

/** Code -> enum name. -1 reports `'Nothing'` (the C# enum member name). */
export function easingName(code) {
  if (code === -1) return 'Nothing';
  if (Number.isInteger(code) && code >= 0 && code < EASING_NAMES.length) {
    return EASING_NAMES[code];
  }
  return 'Unknown';
}

// ---------------------------------------------------------------------------------------
// Lane geometry
// ---------------------------------------------------------------------------------------

const LANE_ORIGIN = 6; // chart lane 6 is runtime lane 0

/**
 * Chart lanes -> runtime hitbox geometry.
 *
 * From SodaChartLoader: `Hitbox.FromLanes(leftLane - 6, rightLane - 6 + 1)`, then
 * `Size *= width` and `Center += (width - 1) / 2`. Note that the serialized right lane
 * is *inclusive* in chart coordinates, so the runtime right edge is `rightLane - 5`,
 * and a wide note's center shifts by `(width - 1) / 2` rather than scaling symmetrically.
 *
 * @param {number} leftLane serialized first lane index
 * @param {number} rightLane serialized last lane index (inclusive)
 * @param {number} [width=1] serialized `WidthModifier`
 * @returns {{left:number,right:number,size:number,center:number,width:number}}
 */
export function lanesToGeometry(leftLane, rightLane, width = 1) {
  const left = leftLane - LANE_ORIGIN;
  const right = rightLane - LANE_ORIGIN + 1;
  const size = ABS(right - left) * width;
  const center = (left + right) / 2 + (width - 1) / 2;
  return { left, right, size, center, width };
}

/**
 * Bullet geometry: `(firstLane - 6) + 0.5`, width modifier and multi-lane spans are
 * ignored by the loader (`ExtendedLaneDataToBullet`). `left`/`right` are synthesized
 * around that center with the bullet's own runtime size (see `Bullet`), which this
 * engine does not model; the raw center is what matters here.
 */
export function bulletCenter(leftLane) {
  return leftLane - LANE_ORIGIN + 0.5;
}

// ---------------------------------------------------------------------------------------
// Raw value decoding
// ---------------------------------------------------------------------------------------

function literalNumber(value, what) {
  if (typeof value === 'number') {
    if (Number.isNaN(value) && what) throw new TypeError(`${what} must not be NaN`);
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    // Special literals ("inf"/"-inf"/"nan") appear as plain strings in the numeric-array
    // view, so they must be decoded before the generic numeric path.
    const text = value.trim().toLowerCase();
    if (text === 'inf' || text === '+inf' || text === 'infinity' || text === '+infinity') return Infinity;
    if (text === '-inf' || text === '-infinity') return -Infinity;
    if (text === 'nan') return NaN;
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
  }
  if (value && typeof value === 'object') {
    const wrapped = value.$float;
    if (typeof wrapped === 'string' || typeof wrapped === 'number') {
      return floatLiteral(wrapped);
    }
  }
  if (what) throw new TypeError(`${what} is not a number: ${JSON.stringify(value)}`);
  return undefined;
}

/** Decode one `{$float: ...}` / string / number literal, including infinities. */
export function floatLiteral(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'inf' || s === '+inf' || s === 'infinity' || s === '+infinity') {
      return Infinity;
    }
    if (s === '-inf' || s === '-infinity') return -Infinity;
    if (s === 'nan') return NaN;
    const n = Number(s);
    if (!Number.isNaN(n)) return n;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$float') return floatLiteral(value.$float);
  }
  throw new TypeError(`unrecognized numeric literal: ${JSON.stringify(value)}`);
}

function numberAt(array, index, fallback = 0) {
  if (!Array.isArray(array) || index >= array.length) return fallback;
  const value = array[index];
  if (value === undefined || value === null) return fallback;
  const n = literalNumber(value, undefined);
  // A NaN inside a payload is treated as "absent" so the C# model default applies; NaN
  // can never arrive through the JSON view anyway (`{$float:"nan"}` aside).
  if (n === undefined || Number.isNaN(n)) return fallback;
  return n;
}

function integerAt(array, index, fallback = 0) {
  const n = numberAt(array, index, fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function stringAt(array, index, fallback = '') {
  if (!Array.isArray(array) || index >= array.length) return fallback;
  const value = array[index];
  return typeof value === 'string' ? value : fallback;
}

function booleanAt(array, index, fallback = false) {
  if (!Array.isArray(array) || index >= array.length) return fallback;
  const value = array[index];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

function rawAt(array, index) {
  if (!Array.isArray(array) || index >= array.length) return undefined;
  return array[index];
}

// ---------------------------------------------------------------------------------------
// MessagePack array schema -> typed records
// ---------------------------------------------------------------------------------------

/** ChartFile[1] TimingPoint[0..8]. */
function parseTimingPoint(raw, index) {
  return {
    index,
    numerator: integerAt(raw, 0, 4),
    denominator: integerAt(raw, 1, 4),
    bpm: numberAt(raw, 2, 120.0),
    startBeat: numberAt(raw, 3, 0.0),
    endBeat: rawAt(raw, 4) === undefined ? 0.0 : numberAt(raw, 4, 0.0),
    startTimestamp: rawAt(raw, 5) === undefined ? 0.0 : numberAt(raw, 5, 0.0),
    endTimestamp: rawAt(raw, 6) === undefined ? 0.0 : numberAt(raw, 6, 0.0),
    timeOffset: numberAt(raw, 7, 0.0),
    resetMetronome: booleanAt(raw, 8, false),
    raw,
  };
}

/** ChartFile[2] Difficulty[0..4]. Notes and scroll segments are parsed separately. */
function parseDifficultyHeader(raw, index) {
  return {
    index,
    charter: stringAt(raw, 0, ''),
    id: integerAt(raw, 1, 0),
    rating: integerAt(raw, 2, 0),
    noteCount: Array.isArray(rawAt(raw, 3)) ? raw[3].length : 0,
    scrollSegmentCount: Array.isArray(rawAt(raw, 4)) ? raw[4].length : 0,
    raw,
  };
}

/** ExtendedLaneData[0..2] -> { lanes, width, beat }. */
function parseExtendedLaneData(raw, index) {
  const lanes = Array.isArray(rawAt(raw, 0)) ? raw[0] : [];
  return {
    index,
    lanes: lanes.map((lane) => ({
      lane: integerAt(lane, 0, -1),
      easing: integerAt(lane, 1, -1),
      raw: lane,
    })),
    width: numberAt(raw, 1, 1.0),
    beat: numberAt(raw, 2, 0.0),
    raw,
  };
}

/**
 * Note[0..3] -> normalized note.
 *
 * `points` is the contract shape (`{beat,left,right,leftEasing,rightEasing,width}`)
 * with the runtime geometry already applied. `leftEasing`/`rightEasing` carry the raw
 * serialized `Easings` codes (or `null` when the loader discards easing on the terminal
 * point of a slide/void — see `hasLeftEasing`/`hasRightEasing`).
 */
export function parseNote(raw, index) {
  if (!Array.isArray(raw)) {
    throw new TypeError(`note ${index} is not an array (got ${JSON.stringify(raw)})`);
  }
  const type = integerAt(raw, 0, 0);
  if (!Object.prototype.hasOwnProperty.call(NOTE_TYPE_NAME, type)) {
    // SodaChartLoader.SodaNoteToGameNotes throws InvalidDataException for these.
    throw new RangeError(`unknown note type ${type} (note ${index})`);
  }
  const rawLanes = Array.isArray(rawAt(raw, 1)) ? raw[1] : [];
  if (rawLanes.length === 0) {
    // Loader would call ExtendedLaneData.Single()/First() on an empty list.
    throw new RangeError(`note ${index} (${NOTE_TYPE_NAME[type]}) has no lane data`);
  }
  const extended = rawLanes.map((eld, i) => parseExtendedLaneData(eld, i));
  const gimmickIndexes = Array.isArray(rawAt(raw, 2)) ? raw[2].map((v) => integerAt([v], 0, -1)) : [];
  const direction = integerAt(raw, 3, -1);

  const points = extended.map((eld, i) => {
    const isLast = i === extended.length - 1;
    const firstLane = eld.lanes[0];
    const lastLane = eld.lanes[eld.lanes.length - 1];
    const geometry = type === NOTE_TYPE.BULLET
      ? { left: bulletCenter(firstLane.lane) - 0.5, right: bulletCenter(firstLane.lane) + 0.5, size: 1, center: bulletCenter(firstLane.lane), width: eld.width }
      : lanesToGeometry(firstLane.lane, lastLane.lane, eld.width);
    // Loader: the terminal point of a slide/void is constructed without an easing pair
    // (the intermediate points keep the serialized left/right easing). The loader's
    // `skip` flag is a hard-coded local `false`, so the confusing guard at
    // SodaChartLoader.cs:253-257 can never fire and is not modelled as data.
    const keepsEasing = (type === NOTE_TYPE.SLIDE || type === NOTE_TYPE.VOID) && !isLast;
    return {
      index: i,
      beat: eld.beat,
      left: geometry.left,
      right: geometry.right,
      center: geometry.center,
      size: geometry.size,
      width: eld.width,
      leftLane: firstLane.lane,
      rightLane: lastLane.lane,
      leftEasing: keepsEasing ? firstLane.easing : null,
      rightEasing: keepsEasing ? lastLane.easing : null,
      hasLeftEasing: keepsEasing,
      hasRightEasing: keepsEasing,
      easeLeft: keepsEasing ? easingFunction(firstLane.easing) : null,
      easeRight: keepsEasing ? easingFunction(lastLane.easing) : null,
      isLast,
      skip: false,
      lanes: eld.lanes.map((l) => ({ lane: l.lane, easing: l.easing })),
      raw: eld.raw,
    };
  });

  return {
    id: `n${index}`,
    index,
    type,
    typeName: NOTE_TYPE_NAME[type],
    direction,
    gimmickIndexes,
    startBeat: points[0].beat,
    endBeat: points[points.length - 1].beat,
    lengthInBeats: points[points.length - 1].beat - points[0].beat,
    points,
    raw,
  };
}

/** ScrollSegment[0..4]. */
export function parseScrollSegment(raw, index) {
  const length = rawAt(raw, 1) === undefined ? Infinity : numberAt(raw, 1, Infinity);
  const easing = integerAt(raw, 3, 0);
  return {
    index,
    startBeat: numberAt(raw, 0, 0.0),
    length,
    endMultiplier: numberAt(raw, 2, 1.0),
    easing,
    easingName: easingName(easing),
    groupId: integerAt(raw, 4, 0),
    raw,
  };
}

/** GimmickGroup[0..5]. */
export function parseGimmickGroup(raw, index) {
  const type = integerAt(raw, 0, -1);
  return {
    index,
    type,
    behavior: type === 0
      ? GIMMICK_BEHAVIOR.SCROLL_MOD_OVERRIDE
      : (type === 1 || type === 2)
        ? GIMMICK_BEHAVIOR.MOVE_PLAYFIELD
        : type === 3
          ? GIMMICK_BEHAVIOR.SELECT_SCROLL_GROUP
          : 'unused-by-loader',
    modifier: numberAt(raw, 1, 1.0),
    length: numberAt(raw, 2, 0.0),
    laneEndMoveLocation: integerAt(raw, 3, 0),
    easing: integerAt(raw, 4, -1),
    scrollGroupId: integerAt(raw, 5, 0),
    raw,
  };
}

/** ChartFile[Difficulty[3]] -> full normalized difficulty. */
function parseDifficulty(raw, index) {
  const header = parseDifficultyHeader(raw, index);
  const rawNotes = Array.isArray(rawAt(raw, 3)) ? raw[3] : [];
  const rawSegments = Array.isArray(rawAt(raw, 4)) ? raw[4] : [];
  const notes = rawNotes.map((n, i) => parseNote(n, i));
  const scrollSegments = rawSegments.map((s, i) => parseScrollSegment(s, i));
  return {
    index,
    id: header.id,
    name: DIFFICULTY_NAME[header.id] ?? `Unknown(${header.id})`,
    rating: header.rating,
    charter: header.charter,
    notes,
    scrollSegments,
    warnings: [],
    raw,
  };
}

// ---------------------------------------------------------------------------------------
// parseChart
// ---------------------------------------------------------------------------------------

/**
 * Normalize a raw original `ChartFile` (the numeric-array view of the MessagePack object,
 * as published next to the page, `charts/<id>.json`) into the normalized viewer schema.
 *
 * Accepted input:
 *   - a full root array `[version, timingPoints, difficulties, gimmickGroups, title, ...]`
 *   - an object with a `payload` / `chart` / `data` array property
 *   - an already parsed MessagePack array of arrays
 *
 * Nonfinite payload numbers appear in the JSON view as `{"$float":"inf"}`; both that
 * wrapper and bare `Infinity`/`-Infinity` numbers are accepted.
 *
 * @param {unknown} raw
 * @param {string} [id]
 * @param {{difficultyNames?: Record<number,string>}} [options]
 * @returns {object} normalized chart
 */
export function parseChart(raw, id = '', options = {}) {
  const names = options.difficultyNames ?? DIFFICULTY_NAME;
  const root = unwrapChartPayload(raw);
  if (!Array.isArray(root) || root.length === 0) {
    throw new TypeError('parseChart: chart payload must be a non-empty array');
  }
  const timingPoints = Array.isArray(rawAt(root, 1)) ? root[1].map(parseTimingPoint) : [];
  const difficulties = Array.isArray(rawAt(root, 2))
    ? root[2].map((d, i) => parseDifficulty(d, i))
    : [];
  const gimmickGroups = Array.isArray(rawAt(root, 3))
    ? root[3].map(parseGimmickGroup)
    : [];
  for (const difficulty of difficulties) {
    if (names[difficulty.id] !== undefined) difficulty.name = names[difficulty.id];
  }

  return {
    id,
    version: stringAt(root, 0, ''),
    title: stringAt(root, 4, ''),
    artist: stringAt(root, 5, ''),
    coverFilename: stringAt(root, 6, ''),
    audioFilename: stringAt(root, 7, ''),
    offset: numberAt(root, 8, 0.0),
    romanizedTitle: stringAt(root, 9, ''),
    romanizedArtist: stringAt(root, 10, ''),
    timing: timingPoints,
    difficulties: difficulties.map((d) => ({
      id: d.id,
      name: d.name,
      index: d.index,
      rating: d.rating,
      charter: d.charter,
      notes: d.notes,
      scrollSegments: d.scrollSegments,
      warnings: d.warnings,
      raw: d.raw,
    })),
    gimmicks: gimmickGroups,
    raw: root,
  };
}

function unwrapChartPayload(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    for (const key of ['payload', 'chart', 'data', 'value']) {
      if (Array.isArray(raw[key])) return raw[key];
    }
  }
  return raw;
}

/** Find a normalized difficulty by class id without throwing. Returns null when absent. */
export function findDifficulty(chart, difficultyId) {
  if (!chart || !Array.isArray(chart.difficulties)) return null;
  const wanted = Number(difficultyId);
  return chart.difficulties.find((d) => d.id === wanted) ?? null;
}

// ---------------------------------------------------------------------------------------
// Length / timing helpers
// ---------------------------------------------------------------------------------------

/**
 * `SodaChartLoader.LoadChart`'s `lastBeat`: the maximum `ExtendedLaneData.Beat` over every
 * note of a difficulty, evaluated over *all* lane points (not just the first or last).
 */
export function lastBeatOfDifficulty(difficulty) {
  let last = null;
  for (const note of difficulty.notes) {
    for (const point of note.points) {
      if (last === null || point.beat > last) last = point.beat;
    }
  }
  return last;
}

/**
 * First BPM: `CreateTimingNotes` orders timing points by `StartBeat` (a stable LINQ
 * `OrderBy`, so equal beats keep serialized order) and remembers the first `Bpm` it sees.
 * That value is the base BPM used for `BPM.Process`'s compensation term.
 */
export function firstBpmOf(timingPoints) {
  const sorted = orderTimingPoints(timingPoints);
  return sorted.length === 0 ? null : sorted[0].bpm;
}

/** Stable sort by start beat, preserving serialized order for exact ties. */
export function orderTimingPoints(timingPoints) {
  return timingPoints
    .map((tp, i) => ({ tp, i }))
    .sort((a, b) => (a.tp.startBeat < b.tp.startBeat ? -1 : a.tp.startBeat > b.tp.startBeat ? 1 : a.i - b.i))
    .map((entry) => entry.tp);
}

// ---------------------------------------------------------------------------------------
// Measure lines — port of SodaChartLoader.CreateMeasureLines
// ---------------------------------------------------------------------------------------

/**
 * Generate measure lines for a difficulty.
 *
 * Faithful to the loader, including C# int truncation of `floor(delta / measureLength)`
 * (which is *not* equivalent to `floor(delta / measureLength)` for negative deltas),
 * the `ResetMetronome` / signature-change handling, and the fact that a line exactly at
 * a segment's start beat is suppressed when the measure length was not reset.
 *
 * These lines only ever land in scroll group 0.
 *
 * @param {object[]} timingPoints normalized (or raw) timing points
 * @param {number|null} lastBeat
 * @returns {number[]} beats, in generation order
 */
export function measureLineBeats(timingPoints, lastBeat) {
  const points = Array.isArray(timingPoints) && timingPoints.length && timingPoints[0] && 'startBeat' in timingPoints[0]
    ? timingPoints.map((tp, i) => ({ ...tp, index: tp.index ?? i }))
    : timingPoints.map((raw, i) => parseTimingPoint(raw, i));
  const ordered = orderTimingPoints(points);
  const n = ordered.length;
  let measureLength = 0.0;
  let signatureStartBeat = 0.0;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const timingPoint = ordered[i];
    const next = 4.0 * timingPoint.numerator / timingPoint.denominator;
    if (timingPoint.resetMetronome || measureLength !== next) {
      measureLength = next;
      signatureStartBeat = timingPoint.startBeat;
    }
    if (!(measureLength > 0.0)) continue;
    const startBeat = timingPoint.startBeat;
    const segmentEnd = i === n - 1
      ? (lastBeat === null || lastBeat === undefined ? startBeat : lastBeat)
      : ordered[i + 1].startBeat;
    const remainder = measureLength - mod(startBeat - signatureStartBeat, measureLength);
    const firstLine = startBeat + remainder;
    // C#: (int)(Math.Floor(delta) / measureLength) — floor first, then truncating division.
    const count = Math.trunc(Math.floor(segmentEnd - firstLine) / measureLength);
    if (count >= 0) {
      const from = remainder === measureLength ? -1 : 0;
      for (let k = from; k < count; k += 1) {
        out.push(k * measureLength + firstLine);
      }
    }
  }
  return out;
}

/** C# `%` on doubles: result takes the sign of the dividend (JS `%` already matches). */
function mod(a, b) {
  return a % b;
}

// ---------------------------------------------------------------------------------------
// Conductor state — port of ConductorState + BPM + ScrollFactorChange
// ---------------------------------------------------------------------------------------

const EPS = 1e-12;

/**
 * Port of `Crystallium.Types.Rhythm.ConductorState`, including both conversion clamps.
 *
 * The offsets are mutable because `BPM.Process` / `ScrollFactorChange.Process` rewrite
 * them; the conversion helpers below are the exact same expressions as the C# methods.
 */
export function createConductorState() {
  return {
    lastProcessedRhythmicTime: null,
    absoluteTimePerRhythmicTime: 1.0,
    timeOffsetAbsolute: 0.0,
    timeOffsetRhythmic: 0.0,
    rhythmicTimePerPosition: 1.0,
    rhythmicTimePerPositionMultiplier: 1.0,
    visualOffsetRhythmic: 0.0,
    visualOffsetPosition: 0.0,
    lastProcessedAbsoluteTime: -Infinity,
  };
}

/** `ConductorState.Reset()` — restores the reviewed initial values. */
export function resetConductorState(state) {
  state.lastProcessedRhythmicTime = null;
  state.absoluteTimePerRhythmicTime = 1.0;
  state.timeOffsetAbsolute = 0.0;
  state.timeOffsetRhythmic = 0.0;
  state.rhythmicTimePerPosition = 1.0;
  state.rhythmicTimePerPositionMultiplier = 1.0;
  state.visualOffsetRhythmic = 0.0;
  state.visualOffsetPosition = 0.0;
  state.lastProcessedAbsoluteTime = -Infinity;
  return state;
}

function checkTimeScale(state) {
  if (!(state.absoluteTimePerRhythmicTime > 0.0)) {
    throw new Error('Absolute time per rhythmic time was equal to or below 0');
  }
  if (!Number.isFinite(state.absoluteTimePerRhythmicTime)) {
    throw new Error(`Absolute time per rhythmic time was ${state.absoluteTimePerRhythmicTime}`);
  }
}

/** `ConductorState.ConvertAbsoluteTimeToRhythmicTime`. */
export function convertAbsoluteToRhythmic(state, absoluteTime) {
  checkTimeScale(state);
  const value = (absoluteTime - state.timeOffsetAbsolute) / state.absoluteTimePerRhythmicTime
    + state.timeOffsetRhythmic;
  if (absoluteTime >= 0.0 && (absoluteTime < state.timeOffsetAbsolute || value < state.timeOffsetRhythmic)) {
    return state.timeOffsetRhythmic;
  }
  return value;
}

/** `ConductorState.ConvertRhythmicTimeToAbsoluteTime`. */
export function convertRhythmicToAbsolute(state, rhythmicTime) {
  checkTimeScale(state);
  const value = (rhythmicTime - state.timeOffsetRhythmic) * state.absoluteTimePerRhythmicTime
    + state.timeOffsetAbsolute;
  if (value >= 0.0 && (value < state.timeOffsetAbsolute || rhythmicTime < state.timeOffsetRhythmic)) {
    return state.timeOffsetAbsolute;
  }
  return value;
}

/** `ConductorState.ConvertRhythmicTimeToPosition`. */
export function convertRhythmicToPosition(state, rhythmicTime) {
  if (!Number.isFinite(state.rhythmicTimePerPosition)) {
    throw new Error(`The rhythmic time per position can not be ${state.rhythmicTimePerPosition}`);
  }
  if (!Number.isFinite(state.rhythmicTimePerPositionMultiplier)) {
    throw new Error(`The rhythmic time per position multiplier can not be ${state.rhythmicTimePerPositionMultiplier}`);
  }
  return (rhythmicTime - state.visualOffsetRhythmic)
    * (state.rhythmicTimePerPosition * state.rhythmicTimePerPositionMultiplier)
    + state.visualOffsetPosition;
}

/** `ConductorState.ConvertPositionToRhythmicTime`. */
export function convertPositionToRhythmic(state, position) {
  if (!Number.isFinite(state.rhythmicTimePerPosition)) {
    throw new Error(`The scroll factor can not be ${state.rhythmicTimePerPosition}`);
  }
  if (!Number.isFinite(state.rhythmicTimePerPositionMultiplier)) {
    throw new Error(`The rhythmic time per position multiplier can not be ${state.rhythmicTimePerPositionMultiplier}`);
  }
  return (position - state.visualOffsetPosition)
    / (state.rhythmicTimePerPosition * state.rhythmicTimePerPositionMultiplier)
    + state.visualOffsetRhythmic;
}

/**
 * `BPM.Process`. Re-anchors the absolute-time and visual-position origins at the event's
 * own beat (clamping negative values to zero), sets `secondsPerBeat = 60/bpm`, and sets
 * the tempo compensation term to `baseBpm / bpm`.
 */
export function processBpm(state, beat, bpm, baseBpm) {
  const position = convertRhythmicToPosition(state, beat);
  const time = convertRhythmicToAbsolute(state, beat);
  state.visualOffsetPosition = position < 0.0 ? 0.0 : position;
  state.visualOffsetRhythmic = beat;
  state.rhythmicTimePerPositionMultiplier = baseBpm / bpm;
  state.timeOffsetAbsolute = time < 0.0 ? 0.0 : time;
  state.timeOffsetRhythmic = beat;
  state.absoluteTimePerRhythmicTime = 60.0 / bpm;
}

/** `ScrollFactorChange.Process`. Preserves visual continuity, then replaces the factor. */
export function processScrollFactorChange(state, beat, factor) {
  state.visualOffsetPosition = convertRhythmicToPosition(state, beat);
  state.visualOffsetRhythmic = beat;
  state.rhythmicTimePerPosition = factor;
}

// ---------------------------------------------------------------------------------------
// Scroll group event generation
// ---------------------------------------------------------------------------------------

/** Port of the discrete ramp inside `SodaChartLoader.CreateScrollGroups`. */
export function scrollRampFactors(previousFactor, length, endMultiplier, easingCode) {
  const changeAmount = endMultiplier - previousFactor;
  const steps = Math.min(Math.max(Math.ceil(ABS(changeAmount) / 0.005), 2), 192);
  const resolution = 1.0 / (steps - 1);
  const easing = easingFunction(easingCode);
  const out = [];
  for (let i = 0; i < steps; i += 1) {
    const fraction = i * resolution;
    out.push({ fraction, factor: previousFactor + changeAmount * easing(fraction) });
  }
  return { steps, resolution, easingCode, changeAmount, factors: out };
}

/**
 * Build a scroll group's event list.
 *
 * Faithful to `CreateScrollGroups`:
 *   - segments are consumed in serialized order (never sorted), and a group's
 *     `previousFactor` carries across its own segments only;
 *   - complex ramps become `steps` discrete `ScrollFactorChange` events, so a ramp is a
 *     staircase, not a continuous scalar;
 *   - `length == 0` (or non-finite) produces a single instantaneous change at `startBeat`.
 */
export function buildScrollGroups(parsed, timingNotes) {
  const groups = new Map();
  const warnings = [];
  const ensure = (groupId) => {
    let group = groups.get(groupId);
    if (!group) {
      group = {
        groupId,
        events: timingNotes.map((e) => ({ ...e })),
        segments: [],
        ramps: [],
      };
      groups.set(groupId, group);
    }
    return group;
  };
  const previous = new Map();
  parsed.scrollSegments.forEach((segment) => {
    const group = ensure(segment.groupId);
    const previousFactor = previous.has(segment.groupId) ? previous.get(segment.groupId) : 1.0;
    group.segments.push({ ...segment, previousFactor });
    if (segment.length !== 0.0 && Number.isFinite(segment.length)) {
      const ramp = scrollRampFactors(previousFactor, segment.length, segment.endMultiplier, segment.easing);
      group.ramps.push({
        segmentIndex: segment.index,
        steps: ramp.steps,
        resolution: ramp.resolution,
        easingCode: ramp.easingCode,
        easingName: easingName(segment.easing),
        previousFactor,
        changeAmount: ramp.changeAmount,
      });
      for (let i = 0; i < ramp.steps; i += 1) {
        const entry = ramp.factors[i];
        group.events.push({
          kind: 'scroll',
          beat: segment.startBeat + segment.length * entry.fraction,
          factor: entry.factor,
          segmentIndex: segment.index,
          step: i,
        });
      }
    } else {
      if (!Number.isFinite(segment.endMultiplier)) {
        warnings.push({ code: 'nonfinite-scroll-multiplier', segment: segment.index, value: segment.endMultiplier });
      }
      group.events.push({
        kind: 'scroll',
        beat: segment.startBeat,
        factor: segment.endMultiplier,
        segmentIndex: segment.index,
        step: -1,
      });
    }
    previous.set(segment.groupId, segment.endMultiplier);
  });
  return { groups, warnings };
}

// ---------------------------------------------------------------------------------------
// compileChart
// ---------------------------------------------------------------------------------------

const PROCESS_ORDER = Object.freeze({ bpm: -32768, normal: 0, measureLine: 32767 });

function baseNoteOrder(kind) {
  if (kind === 'bpm') return PROCESS_ORDER.bpm;
  if (kind === 'measureLine') return PROCESS_ORDER.measureLine;
  return PROCESS_ORDER.normal; // scroll changes and every game point
}

/**
 * Stable sort by (beat, process order); equal keys keep insertion order, matching
 * `Conductor.SetNotes` (`OrderBy` with `BaseNote.CompareTo`, stable in LINQ).
 * `Array.prototype.sort` is stable in every supported engine, and the explicit sequence
 * counter makes the guarantee independent of the engine.
 */
function stableSortEvents(events) {
  return events
    .map((event, i) => ({ event, i }))
    .sort((a, b) => {
      const ba = a.event.beat;
      const bb = b.event.beat;
      if (ba < bb) return -1;
      if (ba > bb) return 1;
      const oa = baseNoteOrder(a.event.kind);
      const ob = baseNoteOrder(b.event.kind);
      if (oa !== ob) return oa - ob;
      return a.i - b.i;
    })
    .map((entry) => entry.event);
}

function runState(state, kind, beat, event, firstBpm) {
  if (kind === 'bpm') {
    processBpm(state, beat, event.bpm, firstBpm);
  } else if (kind === 'scroll') {
    processScrollFactorChange(state, beat, event.factor);
  }
}

function buildGroupTimeline(groupId, events, firstBpm) {
  const state = resetConductorState(createConductorState());
  const segments = [];
  const pushSegment = (beat, current) => {
    // Only a change of beat starts a new segment: several events can share one beat
    // (BPM + notes + measure line at beat 0, ties, ramps that land together), and the
    // state at a shared beat is whatever it is *after* the earlier events processed it.
    if (segments.length > 0 && segments[segments.length - 1].startBeat === beat) {
      segments.pop();
    }
    segments.push({
      startBeat: beat,
      startTime: convertRhythmicToAbsolute(current, beat),
      timePerBeat: current.absoluteTimePerRhythmicTime,
      bpm: 60.0 / current.absoluteTimePerRhythmicTime,
      compensation: current.rhythmicTimePerPositionMultiplier,
      visualOffsetRhythmic: current.visualOffsetRhythmic,
      visualOffsetPosition: current.visualOffsetPosition,
      scrollFactor: current.rhythmicTimePerPosition,
      timeOffsetAbsolute: current.timeOffsetAbsolute,
      timeOffsetRhythmic: current.timeOffsetRhythmic,
    });
  };
  pushSegment(events.length ? events[0].beat : 0.0, state);
  const noteInfo = [];
  events.forEach((event, i) => {
    const beat = event.beat;
    if (i > 0) pushSegment(beat, state);
    // `Conductor.CalculateNoteInfo`: convert with the pre-event state, process, then read.
    const absoluteTime = convertRhythmicToAbsolute(state, beat);
    state.lastProcessedAbsoluteTime = absoluteTime;
    state.lastProcessedRhythmicTime = convertAbsoluteToRhythmic(state, absoluteTime);
    runState(state, event.kind, beat, event, firstBpm);
    state.lastProcessedRhythmicTime = convertAbsoluteToRhythmic(state, absoluteTime);
    noteInfo.push({
      time: convertRhythmicToAbsolute(state, beat),
      position: convertRhythmicToPosition(state, beat),
      bpm: 60.0 / state.absoluteTimePerRhythmicTime,
      scrollFactor: state.rhythmicTimePerPosition,
      compensation: state.rhythmicTimePerPositionMultiplier,
    });
  });
  return {
    groupId,
    events,
    noteInfo,
    segments,
    keyTimes: segments.map((s) => s.startTime),
    noteInfoByKey: buildNoteInfoIndex(events, noteInfo),
    scrollEvents: events.filter((e) => e.kind === 'scroll'),
    bpmEvents: events.filter((e) => e.kind === 'bpm'),
  };
}

/** `noteId:pointIndex` -> calculated info, so note compilation stays O(points). */
function buildNoteInfoIndex(events, noteInfo) {
  const index = new Map();
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.kind === 'note') {
      index.set(`${event.noteId}:${event.pointIndex}`, noteInfo[i]);
    }
  }
  return index;
}

/**
 * Deterministic beat -> chart-seconds conversion using a precomputed timeline.
 *
 * Mirrors `ConductorState`'s clamp: the segment chosen is the latest one whose recorded
 * start beat is `<= time`; within the segment the conversion is the plain affine map.
 */
export function timeAtBeatInTimeline(timeline, beat) {
  const segments = timeline.segments;
  if (segments.length === 0) return 0;
  // `<=` on purpose: several events can share a beat, and each one re-anchors the state,
  // so the *last* segment at that beat is the one the live conductor would be in.
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].startBeat <= beat) lo = mid;
    else hi = mid - 1;
  }
  const segment = segments[lo];
  return clampSegmentTime(segment, (beat - segment.startBeat) * segment.timePerBeat + segment.startTime);
}

function clampSegmentTime(segment, value) {
  let out = value;
  if (out >= 0.0 && (out < segment.timeOffsetAbsolute || out < segment.startTime)) {
    out = segment.timeOffsetAbsolute;
  }
  return out;
}

/** Deterministic chart-seconds -> beat conversion using a precomputed timeline. */
export function beatAtTimeInTimeline(timeline, time) {
  const segments = timeline.segments;
  if (segments.length === 0) return 0;
  const keyTimes = timeline.keyTimes;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keyTimes[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  const segment = segments[lo];
  let absoluteTime = time;
  if (absoluteTime >= 0.0 && absoluteTime < segment.timeOffsetAbsolute) {
    absoluteTime = segment.timeOffsetAbsolute;
  }
  const value = (absoluteTime - segment.startTime) / segment.timePerBeat + segment.startBeat;
  if (absoluteTime >= 0.0 && (absoluteTime < segment.timeOffsetAbsolute || value < segment.startBeat)) {
    return segment.startBeat;
  }
  return value;
}

/** Visual position for a beat, using the timeline's visual offsets. */
export function positionAtBeatInTimeline(timeline, beat) {
  const segments = timeline.segments;
  if (segments.length === 0) return 0;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].startBeat <= beat) lo = mid;
    else hi = mid - 1;
  }
  const segment = segments[lo];
  return (beat - segment.visualOffsetRhythmic)
    * (segment.scrollFactor * segment.compensation)
    + segment.visualOffsetPosition;
}

/** Latest scroll factor at or before `beat` (the game keeps this scalar between events). */
function scrollFactorAtBeat(timeline, beat) {
  const list = timeline.scrollEvents;
  if (!list || list.length === 0) return 1.0;
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].beat <= beat) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found === -1 ? 1.0 : list[found].factor;
}

/** Latest tempo (BPM) at or before `beat`; `fallback` before any BPM event exists. */
function bpmAtBeat(timeline, beat, fallback) {
  const list = timeline.bpmEvents;
  if (!list || list.length === 0) return fallback;
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].beat <= beat) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found === -1 ? fallback : list[found].bpm;
}

/**
 * Resolve a note's gimmick references exactly as `SodaChartLoader.LoadChart` does:
 * the group-select branch (loader case 3) overwrites the running key, so the last valid
 * selecting gimmick wins; the scroll-mod branch (case 0) **multiplies**; the path-angle
 * branches (cases 1 and 2) use `atan2(laneEnd - firstLane, length)` and are stored in
 * degrees (and radians) without applying any easing.
 */
function resolveNoteGimmicks(parsed, note, warnings) {
  const anchorLane = note.points[0].leftLane;
  let selectedGroup = 0;
  let scrollMod = 1;
  const pathAngles = [];
  for (const gimmickIndex of note.gimmickIndexes) {
    if (!Number.isInteger(gimmickIndex) || gimmickIndex < 0 || gimmickIndex >= parsed.gimmicks.length) {
      warnings.push({
        code: 'nonexistent-gimmick-group',
        noteId: note.id,
        gimmickIndex,
        message: `Non-existant gimmick group ${gimmickIndex}`,
      });
      continue;
    }
    const gimmick = parsed.gimmicks[gimmickIndex];
    switch (gimmick.type) {
      case 0:
        scrollMod *= gimmick.modifier;
        break;
      case 1:
      case 2: {
        const degrees = Math.atan2(gimmick.laneEndMoveLocation - anchorLane, gimmick.length) * 57.29578;
        pathAngles.push({
          gimmickIndex,
          type: gimmick.type,
          degrees,
          radians: Math.atan2(gimmick.laneEndMoveLocation - anchorLane, gimmick.length),
          length: gimmick.length,
          laneEndMoveLocation: gimmick.laneEndMoveLocation,
          anchorLane,
        });
        break;
      }
      case 3:
        selectedGroup = gimmick.scrollGroupId;
        break;
      default:
        warnings.push({ code: 'unhandled-gimmick-type', noteId: note.id, gimmickIndex, type: gimmick.type });
        break;
    }
  }
  return { selectedGroup, scrollMod, pathAngles };
}

/**
 * Compile one difficulty into a deterministic, seekable timeline.
 *
 * @param {object} chart result of {@link parseChart}
 * @param {number} difficultyId difficulty class id (0..4)
 * @returns {object} compiled chart
 */
export function compileChart(chart, difficultyId) {
  if (!chart || typeof chart !== 'object') throw new TypeError('compileChart: chart is required');
  const wanted = Number(difficultyId);
  const matches = (chart.difficulties || []).filter((d) => d.id === wanted);
  if (matches.length === 0) {
    // SodaChartLoader: Difficulties.Single(...) throws when absent.
    throw new RangeError(`compileChart: no difficulty with class id ${difficultyId}`);
  }
  if (matches.length > 1) {
    // SodaChartLoader: Single(...) also throws on duplicates.
    throw new RangeError(`compileChart: ${matches.length} difficulties share class id ${difficultyId}`);
  }
  const difficulty = matches[0];
  const rawLastBeat = lastBeatOfDifficulty(difficulty);
  const warnings = [...(difficulty.warnings || [])];
  // Deviation from the loader, requested by the viewer: an empty difficulty (the recovered
  // Hermóðr Crescent record) must still compile. `SodaChartLoader` computes
  // `difficulty.Notes...Last()` here and throws, but a viewer must be able to open the
  // record and show an empty playfield. We substitute a last beat of 0 and warn loudly.
  const isEmpty = rawLastBeat === null;
  const lastBeat = isEmpty ? 0.0 : rawLastBeat;
  if (isEmpty) {
    warnings.push({
      code: 'empty-difficulty',
      difficultyId: difficulty.id,
      message: 'difficulty has no notes; the loader\'s last-beat computation (Notes...Last()) would throw. '
        + 'Compiled with lastBeat = 0 and measure lines anchored on the timing points only.',
    });
  }
  const firstBpm = firstBpmOf(chart.timing || []);
  const ordering = orderTimingPoints(chart.timing || []);
  const timingNotes = ordering.map((tp) => ({ kind: 'bpm', beat: tp.startBeat, bpm: tp.bpm, timingPoint: tp }));

  const { groups, warnings: scrollWarnings } = buildScrollGroups(difficulty, timingNotes);
  warnings.push(...scrollWarnings);

  // Notes are added per difficulty in serialized order; measure lines go to group 0 last.
  const noteAssignments = difficulty.notes.map((note) => {
    const resolved = resolveNoteGimmicks(chart, note, warnings);
    return { note, ...resolved };
  });
  for (const assignment of noteAssignments) {
    let group = groups.get(assignment.selectedGroup);
    if (!group) {
      group = { groupId: assignment.selectedGroup, events: timingNotes.map((e) => ({ ...e })), segments: [], ramps: [] };
      groups.set(assignment.selectedGroup, group);
    }
    for (let i = 0; i < assignment.note.points.length; i += 1) {
      group.events.push({
        kind: 'note',
        beat: assignment.note.points[i].beat,
        noteId: assignment.note.id,
        noteIndex: assignment.note.index,
        pointIndex: i,
      });
    }
  }
  const measureBeats = measureLineBeats(chart.timing || [], lastBeat);
  const zeroGroup = groups.get(0) ?? { groupId: 0, events: timingNotes.map((e) => ({ ...e })), segments: [], ramps: [] };
  groups.set(0, zeroGroup);
  for (const beat of measureBeats) {
    zeroGroup.events.push({ kind: 'measureLine', beat });
  }

  const groupIds = [...groups.keys()].sort((a, b) => a - b);
  const groupTimelines = new Map();
  const groupSections = [];
  for (const groupId of groupIds) {
    const rawGroup = groups.get(groupId);
    const events = stableSortEvents(rawGroup.events);
    const timeline = buildGroupTimeline(groupId, events, firstBpm);
    groupTimelines.set(groupId, timeline);
    groupSections.push({
      groupId,
      events,
      timeline,
      segments: rawGroup.segments,
      ramps: rawGroup.ramps,
    });
  }

  const defaultTimeline = groupTimelines.get(0);
  const groupIndexById = new Map(groupIds.map((id, index) => [id, index]));
  const sectionByGroup = new Map(groupSections.map((section) => [section.groupId, section]));
  const assignmentsByGroup = new Map(groupIds.map((id) => [id, []]));
  for (const assignment of noteAssignments) {
    assignmentsByGroup.get(assignment.selectedGroup).push(assignment);
  }

  // ---- compiled notes -----------------------------------------------------------------
  const compiledNotes = [];
  const events = [];
  const noteInfoById = new Map();
  for (const groupId of groupIds) {
    const section = sectionByGroup.get(groupId);
    const timeline = section.timeline;
    const groupIndex = groupIndexById.get(groupId);
    for (let i = 0; i < timeline.events.length; i += 1) {
      const event = timeline.events[i];
      const info = timeline.noteInfo[i];
      if (event.kind === 'bpm') {
        events.push({
          kind: 'bpm',
          group: groupId,
          groupIndex,
          beat: event.beat,
          time: info.time,
          position: info.position,
          bpm: event.bpm,
          secondsPerBeat: 60.0 / event.bpm,
          compensation: info.compensation,
          timingIndex: event.timingPoint.index,
        });
      } else if (event.kind === 'scroll') {
        events.push({
          kind: 'scroll',
          group: groupId,
          groupIndex,
          beat: event.beat,
          time: info.time,
          position: info.position,
          factor: event.factor,
          segmentIndex: event.segmentIndex,
          step: event.step,
        });
      } else if (event.kind === 'measureLine') {
        events.push({
          kind: 'measureLine',
          group: groupId,
          groupIndex,
          beat: event.beat,
          time: info.time,
          position: info.position,
        });
      }
    }
    for (const assignment of assignmentsByGroup.get(groupId)) {
      const note = assignment.note;
      const angle = assignment.pathAngles.length
        ? { ...assignment.pathAngles[assignment.pathAngles.length - 1], all: assignment.pathAngles }
        : null;
      const points = note.points.map((point, pointIndex) => {
        const info = timeline.noteInfoByKey.get(`${note.id}:${pointIndex}`);
        if (!info) {
          throw new Error(`internal: missing calculated info for ${note.id} point ${pointIndex}`);
        }
        const compiled = {
          index: pointIndex,
          beat: point.beat,
          time: info.time,
          position: info.position,
          left: point.left,
          right: point.right,
          center: point.center,
          size: point.size,
          width: point.width,
          leftLane: point.leftLane,
          rightLane: point.rightLane,
          leftEasing: point.leftEasing,
          rightEasing: point.rightEasing,
          hasLeftEasing: point.hasLeftEasing,
          hasRightEasing: point.hasRightEasing,
          easeLeft: point.easeLeft,
          easeRight: point.easeRight,
          isLast: point.isLast,
          skip: point.skip,
          group: groupId,
          groupIndex,
          scrollMod: assignment.scrollMod,
          angle,
        };
        noteInfoById.set(`${note.id}:${pointIndex}`, compiled);
        return compiled;
      });
      compiledNotes.push({
        id: note.id,
        index: note.index,
        type: note.type,
        typeName: note.typeName,
        direction: note.direction,
        gimmickIndexes: note.gimmickIndexes,
        startBeat: note.startBeat,
        endBeat: note.endBeat,
        absoluteStartTime: points[0].time,
        absoluteEndTime: points[points.length - 1].time,
        group: groupId,
        groupIndex,
        scrollMod: assignment.scrollMod,
        angle,
        points,
        raw: note.raw,
      });
    }
    for (let i = 0; i < timeline.events.length; i += 1) {
      const event = timeline.events[i];
      if (event.kind !== 'note') continue;
      const info = timeline.noteInfo[i];
      events.push({
        kind: 'note',
        group: groupId,
        groupIndex,
        beat: event.beat,
        time: info.time,
        position: info.position,
        noteId: event.noteId,
        noteIndex: event.noteIndex,
        pointIndex: event.pointIndex,
      });
    }
  }
  events.sort((a, b) => {
    if (a.time < b.time) return -1;
    if (a.time > b.time) return 1;
    if (a.group !== b.group) return a.group - b.group;
    if (a.beat < b.beat) return -1;
    if (a.beat > b.beat) return 1;
    return 0;
  });

  // ---- duration / range ---------------------------------------------------------------
  // `endBeat` is the chart-authoring span: the maximum stored lane-point beat over *every*
  // serialized note of the difficulty, independent of scroll grouping. It must be taken
  // from `difficulty.notes` (or every group), never from group 0 alone.
  let minTime = 0.0;
  let maxTime = 0.0;
  let endBeat = 0.0;
  for (const note of difficulty.notes) {
    for (const point of note.points) {
      if (point.beat > endBeat) endBeat = point.beat;
    }
  }
  let first = true;
  for (const note of compiledNotes) {
    for (const point of note.points) {
      if (first) {
        minTime = point.time;
        maxTime = point.time;
        first = false;
      } else {
        if (point.time < minTime) minTime = point.time;
        if (point.time > maxTime) maxTime = point.time;
      }
    }
  }
  for (const section of groupSections) {
    for (const info of section.timeline.noteInfo) {
      if (first) {
        minTime = info.time;
        maxTime = info.time;
        first = false;
      } else {
        if (info.time < minTime) minTime = info.time;
        if (info.time > maxTime) maxTime = info.time;
      }
    }
  }
  const secondsPerBeat = defaultTimeline ? defaultTimeline.segments[0].timePerBeat : (firstBpm ? 60.0 / firstBpm : 1.0);

  const compiled = {
    chart,
    difficulty: {
      id: difficulty.id,
      name: difficulty.name,
      rating: difficulty.rating,
      charter: difficulty.charter,
      index: difficulty.index,
      notes: compiledNotes,
      scrollSegments: difficulty.scrollSegments,
      measureBeats,
      lastBeat,
      noteCount: difficulty.notes.length,
      isEmpty,
      hasNotes: !isEmpty,
    },
    notes: compiledNotes,
    duration: maxTime,
    firstNoteTime: minTime,
    lastNoteTime: maxTime,
    endBeat,
    secondsPerBeat,
    firstBpm,
    audioFilename: chart.audioFilename,
    offset: chart.offset,
    groups: groupSections.map((section) => ({
      id: section.groupId,
      index: groupIds.indexOf(section.groupId),
      events: section.events,
      eventCount: section.events.length,
      noteCount: section.events.filter((e) => e.kind === 'note').length,
      segments: section.segments,
      ramps: section.ramps,
      timeline: section.timeline,
    })),
    groupIds,
    events: events.map((event) => {
      const { groupIndex, ...rest } = event;
      return { ...rest, groupIndex };
    }),
    noteInfoById,
    warnings,
    _timelines: groupTimelines,
  };

  compiled.beatAt = (time) => beatAtTimeInTimeline(
    groupTimelines.get(0) ?? { segments: [], keyTimes: [] },
    time,
  );
  compiled.timeAt = (beat) => timeAtBeatInTimeline(
    groupTimelines.get(0) ?? { segments: [], keyTimes: [] },
    beat,
  );
  compiled.beatAtGroup = (time, group = 0) => beatAtTimeInTimeline(
    groupTimelines.get(group) ?? { segments: [], keyTimes: [] },
    time,
  );
  compiled.timeAtGroup = (beat, group = 0) => timeAtBeatInTimeline(
    groupTimelines.get(group) ?? { segments: [], keyTimes: [] },
    beat,
  );
  compiled.positionAt = (time, group = 0) => {
    const timeline = groupTimelines.get(group);
    if (!timeline) return positionAtBeatInTimeline(defaultTimeline ?? { segments: [] }, compiled.beatAt(time));
    return positionAtBeatInTimeline(timeline, beatAtTimeInTimeline(timeline, time));
  };
  compiled.bpmAt = (time) => {
    const timeline = groupTimelines.get(0);
    if (!timeline || timeline.segments.length === 0) return firstBpm ?? null;
    let lo = 0;
    let hi = timeline.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (timeline.keyTimes[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    return timeline.segments[lo].bpm;
  };
  compiled.scrollFactorAt = (time, group = 0) => {
    const timeline = groupTimelines.get(group);
    if (!timeline) return 1;
    return scrollFactorAtBeat(timeline, beatAtTimeInTimeline(timeline, time));
  };
  compiled.bpmAtBeat = (beat, group = 0) => bpmAtBeat(
    groupTimelines.get(group) ?? { bpmEvents: [] },
    beat,
    firstBpm,
  );
  compiled.range = { minTime, maxTime, endBeat };

  const noteEvents = events.filter((event) => event.kind === 'note');
  /**
   * Notes whose compiled chart time is `<= time`, in the game's own processing order
   * (per group: sorted by beat, process order, insertion order — not by absolute time).
   */
  compiled.notesAtTime = (time) => noteEvents.filter((event) => event.time <= time);
  return compiled;
}

/** Convenience: parse + compile in one call. */
export function loadChart(raw, id, difficultyId) {
  const chart = parseChart(raw, id);
  return compileChart(chart, difficultyId);
}

export default { parseChart, compileChart, loadChart };
