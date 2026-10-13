/**
 * engine.test.js — offline checks for engine.js.
 *
 * Run from this directory:  node --test engine.test.js
 *
 * The corpus checks read the chart payloads published with this folder under
 * `charts/*.json` (the same static files the page fetches; never written to).
 * Expected counts are assertions against the recovered corpus
 * (21 payloads / 63 difficulty records / 74,967 serialized lane points) as documented in
 * `../analysis/chart-inventory.json`, `../docs/02-chart-format.md` and
 * `../README.md`; they are intentionally strict. A new corpus must come with a new
 * manifest and updated expectations, not looser assertions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  parseChart,
  compileChart,
  loadChart,
  findDifficulty,
  measureLineBeats,
  lastBeatOfDifficulty,
  firstBpmOf,
  orderTimingPoints,
  easingAt,
  easingFunction,
  easingName,
  easingFunctions,
  lanesToGeometry,
  scrollRampFactors,
  createConductorState,
  resetConductorState,
  convertAbsoluteToRhythmic,
  convertRhythmicToAbsolute,
  convertRhythmicToPosition,
  processBpm,
  processScrollFactorChange,
  timeAtBeatInTimeline,
  beatAtTimeInTimeline,
  positionAtBeatInTimeline,
  NOTE_TYPE,
  DIFFICULTY_NAME,
  EASING_NAMES,
} from './engine.js';

// ---------------------------------------------------------------------------------------
// Corpus loading (read once; parse/compile once per difficulty)
// ---------------------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const chartDir = path.resolve(here, 'charts');
const chartFiles = readdirSync(chartDir).filter((name) => name.endsWith('.json')).sort();

const corpus = chartFiles.map((file) => {
  const raw = JSON.parse(readFileSync(path.join(chartDir, file), 'utf8'));
  const chart = parseChart(raw, file.replace(/_[0-9a-f]+\.json$/, ''));
  const records = chart.difficulties.map((difficulty) => {
    let compiled = null;
    let error = null;
    try {
      compiled = compileChart(chart, difficulty.id);
    } catch (err) {
      error = err;
    }
    return { difficulty, compiled, error };
  });
  return { file, chart, records };
});

const allRecords = corpus.flatMap((entry) => entry.records.map((record) => ({ ...record, file: entry.file })));

/** Docs: 21 payloads / 63 difficulty records; one embedded record (Hermóðr Crescent) is empty. */
const CORPUS = Object.freeze({
  payloads: 21,
  records: 63,
  emptyRecords: 1,
  serializedNotes: 48_800,
  serializedPoints: 74_967,
  gameNotePoints: 74_967,
  measureLines: 8_248,
  totalScrollEvents: 6_500,
  recordsWithMultiBpm: 10,
  recordsWithIndependentEasing: 47,
  recordsWithGimmickRefs: 10,
  measuredRecords: 61,
  typeCounts: { 0: 18_315, 1: 7_015, 2: 19_041, 3: 4_429, 4: 0 },
  recordTypePresence: { 0: 62, 1: 62, 2: 61, 3: 60, 4: 0 },
});

function compiledRecords() {
  return allRecords;
}

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

function timingPoint(numerator, denominator, bpm, startBeat, options = {}) {
  return [
    numerator,
    denominator,
    bpm,
    startBeat,
    options.endBeat ?? { $float: 'inf' },
    options.startTimestamp ?? 0,
    options.endTimestamp ?? { $float: 'inf' },
    options.timeOffset ?? 0,
    options.resetMetronome ?? false,
  ];
}

function lane(index, easing = -1) {
  return [index, easing];
}

function laneData(lanes, width = 1.0, beat = 0.0) {
  return [lanes, width, beat];
}

function note(type, extended, gimmicks = [], direction = -1) {
  return [type, extended, gimmicks, direction];
}

/** Doc fixture: 120 BPM -> 240 BPM at beat 4, scroll factor 2 at beat 8 (docs/03 table). */
const DOC_FIXTURE = [
  'v1.7.2',
  [
    timingPoint(4, 4, 120.0, 0.0, { resetMetronome: true }),
    timingPoint(4, 4, 240.0, 4.0, { resetMetronome: true }),
  ],
  [
    [
      'charter',
      0,
      12,
      [
        note(NOTE_TYPE.TAP, [laneData([lane(6), lane(6)], 1.0, 0.0)]),
        note(NOTE_TYPE.TAP, [laneData([lane(6), lane(6)], 1.0, 8.0)]),
      ],
      [[8.0, { $float: 'inf' }, 2.0, 0, 0]],
    ],
  ],
  [],
  'Doc Fixture',
  'Fixture Artist',
  'cover.png',
  'song.ogg',
  0.25,
  'Doc Fixture',
  'Fixture Artist',
];

function makeChart(overrides = {}) {
  return parseChart(JSON.parse(JSON.stringify({ ...DOC_FIXTURE, ...overrides })), 'fixture');
}

// ---------------------------------------------------------------------------------------
// parseChart
// ---------------------------------------------------------------------------------------

test('parseChart reads the ChartFile numeric-key schema with defaults', () => {
  const chart = parseChart(DOC_FIXTURE, 'doc');
  assert.equal(chart.id, 'doc');
  assert.equal(chart.version, 'v1.7.2');
  assert.equal(chart.title, 'Doc Fixture');
  assert.equal(chart.artist, 'Fixture Artist');
  assert.equal(chart.coverFilename, 'cover.png');
  assert.equal(chart.audioFilename, 'song.ogg');
  assert.equal(chart.offset, 0.25);
  assert.equal(chart.romanizedTitle, 'Doc Fixture');
  assert.equal(chart.romanizedArtist, 'Fixture Artist');
  assert.equal(chart.timing.length, 2);
  assert.equal(chart.difficulties.length, 1);
  assert.equal(chart.gimmicks.length, 0);
  assert.equal(chart.timing[0].endBeat, Infinity);
  assert.equal(chart.timing[0].endTimestamp, Infinity);
  assert.equal(chart.timing[0].numerator, 4);
  assert.equal(chart.timing[0].denominator, 4);
  assert.equal(chart.timing[0].resetMetronome, true);
});

test('parseChart applies C# model defaults for absent trailing fields', () => {
  // TimingPoint with only StartBeat/Bpm present; LaneData with only Lane.
  const chart = parseChart(['v1.7.2', [[4, 4, 180.0, 0.0]], [['c', 3, 14, [note(0, [laneData([lane(7)], 1.0, 2.0)])], []]]], 'short');
  const timingPointRecord = chart.timing[0];
  assert.equal(timingPointRecord.numerator, 4);
  assert.equal(timingPointRecord.denominator, 4);
  assert.equal(timingPointRecord.bpm, 180.0);
  assert.equal(timingPointRecord.startBeat, 0);
  assert.equal(timingPointRecord.timeOffset, 0);
  assert.equal(timingPointRecord.resetMetronome, false);
  const parsedNote = chart.difficulties[0].notes[0];
  assert.equal(parsedNote.direction, -1); // Note.Direction default
  assert.equal(parsedNote.points[0].leftLane, 7);
  assert.equal(parsedNote.points[0].rightLane, 7);
  assert.equal(parsedNote.points[0].rightEasing, null);
  assert.equal(chart.difficulties[0].id, 3);
  assert.equal(chart.difficulties[0].name, 'Bloodlust');
});

test('parseChart accepts {$float: inf} wrappers, plain infinities and string literals', () => {
  // `timingPoint()` already emits {$float: inf} for EndBeat/EndTimestamp, so assert those.
  const wrapped = parseChart(['v1.7.2', [timingPoint(4, 4, 100, 0)], [['c', 0, 1, [note(0, [laneData([lane(6)], { $float: 'inf' }, 0)])], []]]], 'w');
  assert.equal(wrapped.timing[0].endBeat, Infinity);
  assert.equal(wrapped.timing[0].endTimestamp, Infinity);
  assert.equal(wrapped.difficulties[0].notes[0].points[0].width, Infinity);

  const plain = parseChart(['v1.7.2', [[4, 4, 100, 0, Infinity, 0, -Infinity, 0, false]], [['c', 0, 1, [note(0, [laneData([lane(6)], 1, 0)])], []]]], 'p');
  assert.equal(plain.timing[0].endBeat, Infinity);
  assert.equal(plain.timing[0].endTimestamp, -Infinity);

  const strings = parseChart([
    'v1.7.2',
    [[4, 4, '100', '0', 'inf', '0', '-inf', '0', false]],
    [['c', '0', '1', [note(0, [laneData([lane('6')], 1, '0')])], []]],
  ], 's');
  assert.equal(strings.timing[0].bpm, 100);
  assert.equal(strings.timing[0].endBeat, Infinity);
  assert.equal(strings.timing[0].endTimestamp, -Infinity);
  assert.equal(strings.difficulties[0].notes[0].points[0].leftLane, 6);
});

test('parseChart unwraps {payload}/{chart}/{data} envelopes', () => {
  for (const key of ['payload', 'chart', 'data', 'value']) {
    const chart = parseChart({ [key]: DOC_FIXTURE, id: 'x' }, 'env');
    assert.equal(chart.title, 'Doc Fixture', `envelope key ${key}`);
    assert.equal(chart.difficulties.length, 1);
  }
  assert.throws(() => parseChart(null, 'x'), TypeError);
  assert.throws(() => parseChart([], 'x'), TypeError);
});

test('parseChart keeps the raw payload, count fields and empty-record shape', () => {
  const chart = parseChart(['v1.7.2', [timingPoint(4, 4, 120, 0)], [['c', 0, 3, [], []]], []], 'empty');
  assert.equal(chart.difficulties[0].notes.length, 0);
  assert.equal(chart.difficulties[0].scrollSegments.length, 0);
  assert.ok(Array.isArray(chart.raw));
  assert.equal(chart.raw[0], 'v1.7.2');
  assert.equal(chart.difficulties[0].raw[1], 0);
});

// ---------------------------------------------------------------------------------------
// Lane geometry / note normalization
// ---------------------------------------------------------------------------------------

test('lanesToGeometry reproduces Hitbox.FromLanes plus the width shift', () => {
  // left = L - 6, right = R - 6 + 1, size = |right - left| * w, center = (left+right)/2 + (w-1)/2
  assert.deepEqual(lanesToGeometry(6, 6, 1), { left: 0, right: 1, size: 1, center: 0.5, width: 1 });
  assert.deepEqual(lanesToGeometry(0, 11, 1), { left: -6, right: 6, size: 12, center: 0, width: 1 });
  const wide = lanesToGeometry(6, 7, 2);
  assert.equal(wide.left, 0);
  assert.equal(wide.right, 2);
  assert.equal(wide.size, 4);
  assert.equal(wide.center, 1.5); // (0+2)/2 + (2-1)/2 — the width shift, not symmetric scaling
  const zeroWidth = lanesToGeometry(6, 6, 0);
  assert.equal(zeroWidth.size, 0);
  assert.equal(zeroWidth.center, -0.5 + 0.5); // (0+1)/2 + (0-1)/2
});

test('parseNote normalizes note types, points, easing and per-point geometry', () => {
  const chart = parseChart([
    'v1.7.2',
    [timingPoint(4, 4, 120, 0)],
    [[
      'c',
      0,
      1,
      [
        note(NOTE_TYPE.TAP, [laneData([lane(5), lane(8)], 1.0, 1.0)]),
        note(NOTE_TYPE.SLIDE, [laneData([lane(5, 3), lane(8, 4)], 1.0, 2.0), laneData([lane(6, 0), lane(7, 0)], 1.0, 3.0)]),
        note(NOTE_TYPE.BULLET, [laneData([lane(2), lane(9)], 4.0, 4.0)]),
        note(NOTE_TYPE.VOID, [laneData([lane(1, 1), lane(2, 2)], 0.5, 5.0), laneData([lane(3, 0), lane(4, 0)], 0.5, 6.0)]),
        note(NOTE_TYPE.DASH, [laneData([lane(7), lane(10)], 1.0, 7.0)], [], 1),
      ],
      [],
    ]],
    [],
  ], 'notes');
  const [tap, slide, bullet, voidNote, dash] = chart.difficulties[0].notes;

  assert.equal(tap.typeName, 'tap');
  assert.equal(tap.points.length, 1);
  assert.deepEqual(
    { left: tap.points[0].left, right: tap.points[0].right, size: tap.points[0].size, center: tap.points[0].center },
    { left: -1, right: 3, size: 4, center: 1 },
  );
  assert.equal(tap.points[0].leftEasing, null); // taps carry no easing pair

  assert.equal(slide.points.length, 2);
  // Loader keeps easing on non-terminal slide/void points only.
  assert.equal(slide.points[0].leftEasing, 3);
  assert.equal(slide.points[0].rightEasing, 4);
  assert.equal(slide.points[0].hasLeftEasing, true);
  assert.equal(slide.points[0].isLast, false);
  assert.equal(slide.points[1].leftEasing, null);
  assert.equal(slide.points[1].rightEasing, null);
  assert.equal(slide.points[1].isLast, true);
  assert.equal(slide.points[1].beat, 3.0);
  assert.equal(slide.lengthInBeats, 1.0);

  // Bullet ignores the width modifier and uses (firstLane - 6) + 0.5 as its center.
  assert.equal(bullet.points[0].center, -3.5);
  assert.equal(bullet.points[0].left, -4);
  assert.equal(bullet.points[0].right, -3);

  // Void keeps easing except on the last point.
  assert.equal(voidNote.points[0].leftEasing, 1);
  assert.equal(voidNote.points[1].leftEasing, null);

  assert.equal(dash.typeName, 'dash');
  assert.equal(dash.direction, 1);
  assert.equal(dash.points[0].size, 4);
});

test('parseNote rejects unknown types and missing lane data exactly like the loader', () => {
  const build = (type, extended) => parseChart(['v1.7.2', [timingPoint(4, 4, 120, 0)], [['c', 0, 1, [note(type, extended)], []]], []], 'bad');
  assert.throws(() => build(5, [laneData([lane(6)], 1, 0)]), /unknown note type 5/);
  assert.throws(() => build(-1, [laneData([lane(6)], 1, 0)]), /unknown note type -1/);
  assert.throws(() => build(0, []), /has no lane data/);
});

test('independently eased lane edges survive parsing as distinct functions', () => {
  const chart = parseChart([
    'v1.7.2',
    [timingPoint(4, 4, 120, 0)],
    [['c', 0, 1, [note(NOTE_TYPE.SLIDE, [
      laneData([lane(3, 1), lane(9, 4)], 1.0, 0.0),
      laneData([lane(4, 0), lane(8, 0)], 1.0, 1.0),
    ])], []]],
    [],
  ], 'edges');
  const point = chart.difficulties[0].notes[0].points[0];
  assert.equal(point.leftEasing, 1);
  assert.equal(point.rightEasing, 4);
  assert.notEqual(point.easeLeft, point.easeRight);
  assert.equal(point.easeLeft(0.5), easingFunctions.EaseInSine(0.5));
  assert.equal(point.easeRight(0.5), easingFunctions.EaseOutQuad(0.5));
  assert.equal(easingName(point.leftEasing), 'EaseInSine');
  assert.equal(easingName(point.rightEasing), 'EaseOutQuad');
});

// ---------------------------------------------------------------------------------------
// Easing — exact ports
// ---------------------------------------------------------------------------------------

test('easing codes match the Sodalite Easings enum and every curve is defined', () => {
  assert.equal(EASING_NAMES.length, 21);
  assert.equal(easingName(-1), 'Nothing');
  assert.equal(easingName(0), 'EaseLinear');
  assert.equal(easingName(20), 'EaseOutBounce');
  assert.equal(easingName(21), 'Unknown');
  for (let code = -1; code <= 20; code += 1) {
    const fn = easingFunction(code);
    assert.equal(typeof fn, 'function', `easing ${code}`);
    assert.ok(Number.isFinite(fn(0.5)) || Number.isNaN(fn(0.5)), `easing ${code} finite at 0.5`);
    assert.equal(easingAt(0.5, code), fn(0.5), `easingAt dispatches code ${code} to the named curve`);
  }
  // Unmapped/negative/out-of-range codes fall through to identity, as in ConvertToEasing.
  assert.equal(easingAt(0.375, -1), 0.375);
  assert.equal(easingAt(0.375, 21), 0.375);
  assert.equal(easingAt(0.375, 0), 0.375);
  assert.equal(easingFunction(-1), easingFunctions.EaseLinear);
  assert.equal(easingFunction(999), easingFunctions.EaseLinear);
});

test('nonstandard easing definitions are preserved (not replaced by a library)', () => {
  const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
  // EaseInSine is sin(1.5707963 t) — not 1 - cos(pi t / 2).
  close(easingAt(0.5, 1), Math.sin(1.5707963 * 0.5));
  assert.notEqual(easingAt(0.5, 1), 1 - Math.cos(0.5 * Math.PI / 2));
  // EaseOutSine is 1 + sin(1.5707963 (t - 1)).
  close(easingAt(0.5, 2), 1 + Math.sin(1.5707963 * -0.5));
  // EaseInExpo is (2^(8t) - 1) / 255 — at t = 1 that is exactly 1, unlike the usual
  // 1 - 2^(-10t) curve.
  close(easingAt(1, 11), (2 ** 8 - 1) / 255);
  close(easingAt(1, 11), 1);
  close(easingAt(0.5, 11), (2 ** 4 - 1) / 255);
  // EaseInCirc is 1 - sqrt(1 - t) (no t^2 term) and EaseOutCirc is sqrt(t).
  close(easingAt(0.5, 13), 1 - Math.sqrt(0.5));
  close(easingAt(0.5, 14), Math.sqrt(0.5));
  // Elastic/bounce use the odd 4.5/3.5 multipliers.
  close(easingAt(0.5, 17), 0.5 ** 4 * Math.sin(0.5 * Math.PI * 4.5));
  close(easingAt(0.5, 19), 2 ** (6 * -0.5) * Math.abs(Math.sin(0.5 * Math.PI * 3.5)));
  // Endpoints of the linear curve.
  close(easingAt(0, 0), 0);
  close(easingAt(1, 0), 1);
});

// ---------------------------------------------------------------------------------------
// Timing / conductor primitives
// ---------------------------------------------------------------------------------------

test('conductor conversion primitives round-trip offsets', () => {
  const state = createConductorState();
  assert.equal(state.absoluteTimePerRhythmicTime, 1);
  assert.equal(state.timeOffsetAbsolute, 0);
  assert.equal(state.timeOffsetRhythmic, 0);
  assert.equal(state.visualOffsetRhythmic, 0);
  assert.equal(state.visualOffsetPosition, 0);
  assert.equal(state.rhythmicTimePerPosition, 1);
  assert.equal(state.rhythmicTimePerPositionMultiplier, 1);
  assert.equal(convertAbsoluteToRhythmic(state, 3), 3);
  assert.equal(convertRhythmicToAbsolute(state, 3), 3);
  assert.equal(convertRhythmicToPosition(state, 3), 3);
  assert.equal(resetConductorState(state), state);
});

test('BPM.Process re-anchors time and position and sets compensation = firstBpm/bpm', () => {
  const state = createConductorState();
  processBpm(state, 0, 120, 120);
  assert.equal(state.absoluteTimePerRhythmicTime, 0.5);
  assert.equal(state.rhythmicTimePerPositionMultiplier, 1);
  assert.equal(state.timeOffsetAbsolute, 0);
  assert.equal(state.timeOffsetRhythmic, 0);
  assert.equal(convertRhythmicToAbsolute(state, 4), 2);

  processBpm(state, 4, 240, 120);
  assert.equal(state.absoluteTimePerRhythmicTime, 0.25);
  assert.equal(state.rhythmicTimePerPositionMultiplier, 0.5);
  assert.equal(state.timeOffsetAbsolute, 2);
  assert.equal(state.timeOffsetRhythmic, 4);
  assert.equal(state.visualOffsetPosition, 4);
  assert.equal(convertRhythmicToPosition(state, 4), 4);
});

test('ScrollFactorChange.Process preserves visual continuity at its own beat', () => {
  const state = createConductorState();
  processBpm(state, 0, 120, 120);
  const before = convertRhythmicToPosition(state, 8);
  processScrollFactorChange(state, 8, 2);
  assert.equal(state.rhythmicTimePerPosition, 2);
  assert.equal(state.visualOffsetRhythmic, 8);
  assert.equal(state.visualOffsetPosition, before);
  assert.equal(convertRhythmicToPosition(state, 8), before);
  assert.notEqual(convertRhythmicToPosition(state, 7.999), convertRhythmicToPosition(state, 8.001));
});

test('negative computed offsets are clamped to zero by BPM.Process', () => {
  const state = createConductorState();
  // Place the first BPM at a negative beat with an already-negative time/position.
  processBpm(state, -2, 120, 120);
  assert.equal(state.timeOffsetAbsolute, 0);
  assert.equal(state.visualOffsetPosition, 0);
  assert.equal(convertRhythmicToAbsolute(state, -2), 0);
});

test('measureLineBeats reproduces CreateMeasureLines including its quirks', () => {
  // Constant signature. `num9 = trunc(floor(segmentEnd - firstLine) / measureLength)` and the
  // loop runs `k < num9`, so the segment's own end beat never receives a line.
  const simple = measureLineBeats([timingPoint(4, 4, 120, 0, { resetMetronome: true })], 10);
  assert.deepEqual(simple, [0, 4]);
  const exact = measureLineBeats([timingPoint(4, 4, 120, 0, { resetMetronome: true })], 12);
  assert.deepEqual(exact, [0, 4, 8]);

  // 3/4 line length is 3 beats; a signature change re-anchors the measure grid.
  const changed = measureLineBeats([
    timingPoint(4, 4, 120, 0, { resetMetronome: true }),
    timingPoint(3, 4, 120, 10, { resetMetronome: false }),
  ], 16);
  assert.deepEqual(changed, [0, 4, 10, 13]);

  // When a following timing point falls exactly on the previous measure grid, the
  // `remainder === measureLength` branch suppresses its start beat and the line is emitted
  // once by the following segment instead of twice.
  const onGrid = measureLineBeats([
    timingPoint(4, 4, 120, 0, { resetMetronome: true }),
    timingPoint(4, 4, 120, 8, { resetMetronome: false }),
  ], 12);
  assert.deepEqual(onGrid, [0, 4, 8]);

  // ...and a signature change re-anchors the grid at that beat.
  const reAnchored = measureLineBeats([
    timingPoint(4, 4, 120, 0, { resetMetronome: true }),
    timingPoint(3, 4, 120, 8, { resetMetronome: false }),
  ], 12);
  assert.deepEqual(reAnchored, [0, 4, 8]);

  // ResetMetronome emits the line even when the measure length is unchanged, and the last
  // timing point spans only to `lastBeat`, so its own segment can be empty.
  const reset = measureLineBeats([
    timingPoint(4, 4, 120, 0, { resetMetronome: true }),
    timingPoint(4, 4, 120, 10, { resetMetronome: true }),
  ], 10);
  assert.deepEqual(reset, [0, 4]);
  const resetEarlier = measureLineBeats([
    timingPoint(4, 4, 120, 0, { resetMetronome: true }),
    timingPoint(4, 4, 120, 6, { resetMetronome: true }),
  ], 10);
  assert.deepEqual(resetEarlier, [0, 6]);

  // A missing trailing timing point falls back to its own start beat (lastBeat null).
  assert.deepEqual(measureLineBeats([timingPoint(4, 4, 120, 0, { resetMetronome: true })], null), []);

  // Degenerate signature: measureLength <= 0 skips the segment instead of throwing.
  assert.deepEqual(measureLineBeats([[0, 4, 120, 0, { $float: 'inf' }, 0, { $float: 'inf' }, 0, true]], 10), []);
});

test('firstBpmOf / orderTimingPoints use a stable StartBeat ordering', () => {
  const points = [
    { startBeat: 4, bpm: 200 },
    { startBeat: 0, bpm: 120 },
    { startBeat: 0, bpm: 130 },
  ];
  assert.equal(firstBpmOf(points), 120);
  const ordered = orderTimingPoints(points);
  assert.deepEqual(ordered.map((p) => p.bpm), [120, 130, 200]);
  assert.equal(firstBpmOf([]), null);
});

// ---------------------------------------------------------------------------------------
// compileChart: doc fixture
// ---------------------------------------------------------------------------------------

test('compileChart reproduces the docs/03 conductor table for the 120->240/scroll-2 fixture', () => {
  const chart = parseChart(DOC_FIXTURE, 'doc');
  const compiled = compileChart(chart, 0);
  const expected = [
    [0, 0, 0],
    [2, 1, 2],
    [4, 2, 4],
    [6, 2.5, 5],
    [8, 3, 6],
    [10, 3.5, 8],
  ];
  for (const [beat, time, position] of expected) {
    assert.equal(compiled.timeAt(beat), time, `time at beat ${beat}`);
    assert.equal(compiled.positionAt(compiled.timeAt(beat)), position, `position at beat ${beat}`);
  }
  assert.equal(compiled.firstBpm, 120);
  assert.equal(compiled.secondsPerBeat, 0.5);
  assert.equal(compiled.bpmAt(0), 120);
  assert.equal(compiled.bpmAt(1.999), 120);
  assert.equal(compiled.bpmAt(2), 240);
  assert.equal(compiled.bpmAt(100), 240);
  assert.equal(compiled.beatAt(0), 0);
  assert.equal(compiled.beatAt(1), 2);
  assert.equal(compiled.beatAt(2), 4);
  assert.equal(compiled.beatAt(2.5), 6);
  assert.equal(compiled.beatAt(3), 8);
  assert.equal(compiled.beatAt(3.5), 10);
});

test('compileChart exposes deterministic seek/adapter functions and event kinds', () => {
  const chart = parseChart(DOC_FIXTURE, 'doc');
  const compiled = compileChart(chart, 0);
  for (const fn of ['beatAt', 'timeAt', 'positionAt', 'bpmAt', 'scrollFactorAt', 'notesAtTime']) {
    assert.equal(typeof compiled[fn], 'function', fn);
  }
  const kinds = new Set(compiled.events.map((event) => event.kind));
  assert.deepEqual([...kinds].sort(), ['bpm', 'measureLine', 'note', 'scroll']);
  assert.equal(compiled.notes.length, 2);
  assert.equal(compiled.notes[0].points[0].time, 0);
  assert.equal(compiled.notes[1].points[0].time, 3);
  assert.equal(compiled.notes[1].points[0].position, 6);
  assert.equal(compiled.duration, 3);
  assert.equal(compiled.lastNoteTime, 3);
  assert.equal(compiled.offset, 0.25);
  assert.equal(compiled.difficulty.name, 'Crescent');
  assert.equal(compiled.difficulty.rating, 12);
  assert.equal(compiled.difficulty.charter, 'charter');
  assert.deepEqual(compiled.groupIds, [0]);
  assert.deepEqual(compiled.difficulty.measureBeats, [0, 4]);
  assert.equal(compiled.notesAtTime(2.9).length, 1);
  assert.equal(compiled.notesAtTime(3).length, 2);
  assert.deepEqual(compiled.notesAtTime(3).map((e) => e.noteId), ['n0', 'n1']);
  // Regression: several events share beat 0, and the segment table must not be skewed by
  // duplicate zero-beat entries (the state at beat 2 is still the initial 1 s/beat state).
  const dbgSeg = compiled.groups[0].timeline.segments;
  assert.deepEqual(
    dbgSeg.map((s) => [s.startBeat, s.startTime, s.timePerBeat]),
    [[0, 0, 0.5], [4, 2, 0.25], [8, 3, 0.25]],
    `segments=${JSON.stringify(dbgSeg.map((s) => [s.startBeat, s.startTime, s.timePerBeat]))} events=${compiled.events.map((e) => e.kind + '@' + e.beat).join(' ')}`,
  );
  const starts = compiled.groups[0].timeline.segments.map((segment) => segment.startBeat);
  assert.deepEqual(starts, [0, 4, 8]);
  // 2 beats at 120 BPM is 1 chart second, matching the docs/03 table.
  assert.equal(compiled.timeAt(2), 1);
  assert.equal(compiled.timeAt(1), 0.5);
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] > starts[i - 1], 'segment start beats are strictly increasing');
  }
});

test('compileChart failures mirror the loader for missing/duplicate classes', () => {
  const chart = parseChart(DOC_FIXTURE, 'doc');
  assert.throws(() => compileChart(chart, 2), /no difficulty with class id 2/);
  const duplicated = parseChart([
    'v1.7.2',
    [timingPoint(4, 4, 120, 0)],
    [
      ['a', 0, 1, [note(0, [laneData([lane(6)], 1, 0)])], []],
      ['b', 0, 2, [note(0, [laneData([lane(6)], 1, 0)])], []],
    ],
    [],
  ], 'dup');
  assert.throws(() => compileChart(duplicated, 0), /2 difficulties share class id 0/);
  assert.throws(() => compileChart(null, 0), TypeError);
});

test('empty difficulty has a usable, finite, seekable timeline', () => {
  // Intentional, documented deviation from the loader, which throws on Notes...Last().
  const empty = parseChart(['v1.7.2', [timingPoint(4, 4, 120, 0, { resetMetronome: true })], [['c', 4, 20, [], []]], []], 'none');
  const compiled = compileChart(empty, 4);
  assert.equal(compiled.difficulty.isEmpty, true);
  assert.equal(compiled.difficulty.hasNotes, false);
  assert.equal(compiled.difficulty.noteCount, 0);
  assert.deepEqual(compiled.notes, []);
  assert.equal(compiled.difficulty.lastBeat, 0);
  assert.equal(compiled.duration, 0);
  assert.ok(Number.isFinite(compiled.duration));
  assert.ok(Number.isFinite(compiled.firstNoteTime));
  assert.ok(Number.isFinite(compiled.lastNoteTime));
  assert.equal(compiled.timeAt(0), 0);
  assert.equal(compiled.beatAt(0), 0);
  assert.equal(compiled.positionAt(0), 0);
  assert.ok(Number.isFinite(compiled.bpmAt(0)));
  assert.equal(compiled.firstBpm, 120);
  assert.deepEqual(compiled.notesAtTime(1e9), []);
  assert.deepEqual(compiled.groupIds, [0]);
  const warning = compiled.warnings.find((w) => w.code === 'empty-difficulty');
  assert.ok(warning, 'empty-difficulty warning is present');
  assert.equal(warning.difficultyId, 4);
  assert.equal(findDifficulty(empty, 4).notes.length, 0);
  assert.equal(findDifficulty(empty, 1), null);
  // The chart stays renderable for arbitrary seek times.
  for (const time of [-5, 0, 0.5, 1e6]) {
    assert.ok(Number.isFinite(compiled.beatAt(time)));
    assert.ok(Number.isFinite(compiled.positionAt(time)));
  }
});

test('compileChart is deterministic and independent per difficulty id', () => {
  const chart = parseChart(DOC_FIXTURE, 'doc');
  const a = compileChart(chart, 0);
  const b = compileChart(chart, 0);
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.notes.map((n) => n.points.map((p) => [p.time, p.position])),
    b.notes.map((n) => n.points.map((p) => [p.time, p.position])));
});

// ---------------------------------------------------------------------------------------
// Scroll groups
// ---------------------------------------------------------------------------------------

test('scrollRampFactors discretizes ramps with n = clamp(ceil(|delta|/0.005), 2, 192)', () => {
  const tiny = scrollRampFactors(1.0, 4, 1.0, 0);
  assert.equal(tiny.steps, 2); // zero delta still produces the two endpoints
  assert.deepEqual(tiny.factors.map((f) => f.fraction), [0, 1]);
  assert.deepEqual(tiny.factors.map((f) => f.factor), [1, 1]);

  const quarter = scrollRampFactors(0.5, 2, 1.5, 0); // delta 1 -> ceil(200) -> 192
  assert.equal(quarter.steps, 192);
  assert.equal(quarter.factors[0].factor, 0.5);
  assert.equal(quarter.factors[191].factor, 1.5);
  // The factor at step i is previous + delta * Easing(i/(n-1)).
  assert.equal(quarter.factors[10].factor, 0.5 + 1.0 * easingAt(10 / 191, 0));

  const ramp = scrollRampFactors(0.0, 1, 1.0, 0);
  assert.equal(ramp.steps, 192);
  const small = scrollRampFactors(1.0, 1, 1.1, 0); // delta ~0.1 -> ceil(20.000000000000004) = 21
  assert.equal(small.steps, 21);
  const two = scrollRampFactors(1.0, 1, 1.02, 0); // delta ~0.02 -> ceil(4.000000000000004) = 5
  assert.equal(two.steps, 5);
  const exactDelta = scrollRampFactors(0.0, 1, 0.05, 0); // delta 0.05 -> ceil(10) = 10 exactly
  assert.equal(exactDelta.steps, 10);
  // Easing code is applied to the fraction, so a nonzero easing changes interior samples.
  const eased = scrollRampFactors(0.0, 1, 1.0, 1);
  assert.equal(eased.factors[1].factor, easingAt(1 / 191, 1));
});

test('scroll groups inherit BPM events, receive their own changes and notes, and stay isolated', () => {
  const chart = parseChart([
    'v1.7.2',
    [
      timingPoint(4, 4, 120, 0, { resetMetronome: true }),
      timingPoint(4, 4, 240, 4, { resetMetronome: true }),
    ],
    [[
      'c', 0, 1,
      [
        note(0, [laneData([lane(6)], 1, 0)], [0]),
        note(0, [laneData([lane(6)], 1, 1)], [1]),
        note(0, [laneData([lane(6)], 1, 2)], [2]),
      ],
      [
        [0.0, { $float: 'inf' }, 1.0, 0, 0],
        [0.0, { $float: 'inf' }, 3.0, 0, 1],
      ],
    ]],
    [
      [3, 1.0, 0, 0, -1, 0], // select group 0
      [3, 1.0, 0, 0, -1, 1], // select group 1
      [0, 1.0, 0, 0, -1, 0], // ignored for group selection
    ],
  ], 'groups');
  const compiled = compileChart(chart, 0);
  assert.deepEqual(compiled.groupIds, [0, 1]);
  const g0 = compiled.groups.find((g) => g.id === 0);
  const g1 = compiled.groups.find((g) => g.id === 1);
  assert.equal(g0.noteCount, 2);
  assert.equal(g1.noteCount, 1);
  // both groups inherit the BPM events
  assert.equal(g0.timeline.bpmEvents.length, 2);
  assert.equal(g1.timeline.bpmEvents.length, 2);
  // group 0 has factor 1, group 1 factor 3
  assert.equal(compiled.scrollFactorAt(10, 0), 1);
  assert.equal(compiled.scrollFactorAt(10, 1), 3);
  assert.equal(compiled.positionAt(1, 0), 2);
  assert.equal(compiled.positionAt(1, 1), 6);
  // Times are shared; only the visual mapping differs.
  assert.equal(compiled.timeAt(2), 1);
  assert.equal(compiled.notes.find((n) => n.gimmickIndexes.includes(2)).group, 0);
});

test('a finite nonzero scroll segment becomes a discrete staircase, not a scalar', () => {
  const chart = parseChart([
    'v1.7.2',
    [timingPoint(4, 4, 120, 0, { resetMetronome: true })],
    [['c', 0, 1, [note(0, [laneData([lane(6)], 1, 0)])], [[2.0, 4.0, 2.0, 0, 0]]]],
    [],
  ], 'ramp');
  const compiled = compileChart(chart, 0);
  const scroll = compiled.events.filter((event) => event.kind === 'scroll');
  assert.equal(scroll.length, 192);
  assert.equal(scroll[0].beat, 2);
  assert.equal(scroll[191].beat, 6);
  assert.equal(scroll[0].factor, 1);
  assert.equal(scroll[191].factor, 2);
  assert.equal(scroll[0].step, 0);
  assert.equal(scroll[191].step, 191);
  for (let i = 1; i < scroll.length; i += 1) {
    assert.ok(scroll[i].beat > scroll[i - 1].beat);
    assert.ok(scroll[i].factor > scroll[i - 1].factor);
  }
  // Position is continuous at each step and monotone inside the ramp. `timeAtGroup` is
  // used because the ramp itself re-anchors the time offsets throughout the segment.
  for (let i = 1; i < scroll.length; i += 1) {
    const event = scroll[i];
    const eventTime = compiled.timeAtGroup(event.beat, 0);
    const before = compiled.positionAt(eventTime - 1e-9, 0);
    const at = compiled.positionAt(eventTime, 0);
    assert.ok(Math.abs(at - before) < 0.5, `continuity near step ${i}: ${before} -> ${at}`);
  }
  // Before the ramp the factor is still the default 1; at the ramp end it is 2.
  assert.equal(compiled.scrollFactorAt(0, 0), 1);
  assert.equal(compiled.scrollFactorAt(compiled.timeAtGroup(6, 0), 0), 2);
  assert.equal(compiled.positionAt(compiled.timeAtGroup(1, 0), 0), 1);
});

test('a missing requested scroll group falls back to identity (matching the game default)', () => {
  const chart = parseChart(DOC_FIXTURE, 'doc');
  const compiled = compileChart(chart, 0);
  assert.equal(compiled.scrollFactorAt(5, 99), 1);
  assert.equal(compiled.positionAt(compiled.timeAt(2), 99), 2);
});

// ---------------------------------------------------------------------------------------
// Gimmicks
// ---------------------------------------------------------------------------------------

test('gimmick branches follow the loader, not the enum names', () => {
  const chart = parseChart([
    'v1.7.2',
    [timingPoint(4, 4, 120, 0, { resetMetronome: true })],
    [[
      'c', 0, 1,
      [
        note(0, [laneData([lane(0)], 1, 0)], [0]),          // index 0: type 0 -> 1.5x approach rate
        note(0, [laneData([lane(0)], 1, 1)], [0, 1]),       // multiply, then select group 2
        note(0, [laneData([lane(0)], 1, 2)], [2]),          // index 2: type 1 -> path angle
        note(0, [laneData([lane(12)], 1, 3)], [3]),         // index 3: type 2 -> path angle, anchor 12
        note(0, [laneData([lane(0)], 1, 4)], [4, 5]),       // last valid selector wins (group 4)
        note(0, [laneData([lane(0)], 1, 5)], [99]),         // invalid index -> warned + skipped
      ],
      [[0.0, { $float: 'inf' }, 1.0, 0, 0]],
    ]],
    [
      [0, 1.5, 0, 0, -1, 0],   // gimmick 0
      [3, 1.0, 0, 0, -1, 2],   // gimmick 1: type 3 selects scroll group 2
      [1, 1.0, 64, 8, 0, 0],   // gimmick 2: type 1, length 64, lane end 8
      [2, 1.0, 64, 18, 0, 0],  // gimmick 3: type 2, length 64, lane end 18
      [3, 1.0, 0, 0, -1, 4],   // gimmick 4: type 3 selects scroll group 4
      [0, 4.0, 0, 0, -1, 0],   // gimmick 5: type 0 -> 4x (unused by these notes)
    ],
  ], 'gimmicks');
  const compiled = compileChart(chart, 0);
  // `compiled.notes` is grouped by scroll group, so select by the stable note id.
  const byId = new Map(compiled.notes.map((entry) => [entry.id, entry]));
  const notes = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'].map((id) => byId.get(id));
  assert.deepEqual(
    notes.map((entry) => entry.group),
    [0, 2, 0, 0, 4, 0],
    `groups=${JSON.stringify(notes.map((entry) => [entry.id, entry.group]))} gimmickIndexes=${JSON.stringify(chart.difficulties[0].notes.map((n) => n.gimmickIndexes))}`,
  );
  assert.equal(notes[0].scrollMod, 1.5);
  assert.equal(notes[0].group, 0);
  assert.equal(notes[0].angle, null);
  assert.equal(notes[1].scrollMod, 1.5);
  assert.equal(notes[1].group, 2);
  assert.equal(notes[2].angle.degrees, Math.atan2(8 - 0, 64) * 57.29578);
  assert.equal(notes[2].angle.anchorLane, 0);
  assert.equal(notes[3].angle.degrees, Math.atan2(18 - 12, 64) * 57.29578);
  assert.equal(notes[3].angle.anchorLane, 12);
  assert.equal(notes[4].group, 4);
  assert.equal(notes[5].scrollMod, 1);
  assert.equal(notes[5].group, 0);
  assert.equal(notes[5].angle, null);
  assert.deepEqual(compiled.groupIds, [0, 2, 4]);
  const warning = compiled.warnings.find((w) => w.code === 'nonexistent-gimmick-group');
  assert.ok(warning);
  assert.equal(warning.gimmickIndex, 99);
  assert.equal(compiled.warnings.filter((w) => w.code === 'nonexistent-gimmick-group').length, 1);
});

test('multiple scroll-mod overrides on one note multiply', () => {
  const chart = parseChart([
    'v1.7.2',
    [timingPoint(4, 4, 120, 0)],
    [['c', 0, 1, [note(0, [laneData([lane(6)], 1, 0)], [0, 1])], []]],
    [
      [0, 1.25, 0, 0, -1, 0],
      [0, 1.6, 0, 0, -1, 0],
    ],
  ], 'multiply');
  const compiled = compileChart(chart, 0);
  assert.ok(Math.abs(compiled.notes[0].scrollMod - 2.0) < 1e-12);
});

// ---------------------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------------------

test('corpus shape: 21 payloads / 63 records, v1.7.2, nine-field timing points', () => {
  assert.equal(corpus.length, CORPUS.payloads);
  assert.equal(allRecords.length, CORPUS.records);
  for (const entry of corpus) {
    assert.equal(entry.chart.version, 'v1.7.2', entry.file);
    assert.ok(entry.chart.difficulties.length >= 1, entry.file);
    for (const timingPointRecord of entry.chart.timing) {
      assert.equal(typeof timingPointRecord.numerator, 'number');
      assert.equal(typeof timingPointRecord.bpm, 'number');
      assert.ok(Number.isFinite(timingPointRecord.bpm));
      assert.ok(Number.isFinite(timingPointRecord.startBeat));
    }
    for (const difficulty of entry.chart.difficulties) {
      assert.ok([0, 1, 2, 3, 4].includes(difficulty.id), `${entry.file} class ${difficulty.id}`);
      assert.ok(Number.isInteger(difficulty.rating));
      assert.equal(typeof difficulty.charter, 'string');
    }
  }
});

test('corpus compiles every one of the 63 records, including the empty Hermóðr Crescent', () => {
  assert.equal(allRecords.length, CORPUS.records);
  for (const record of allRecords) {
    assert.ok(record.error === null, `${record.file} class ${record.difficulty.id}: ${record.error?.message}`);
    assert.ok(record.compiled, `${record.file} class ${record.difficulty.id} compiled`);
    assert.ok(Number.isFinite(record.compiled.duration), `${record.file} finite duration`);
  }
  const empty = allRecords.filter((record) => record.compiled.difficulty.isEmpty);
  assert.equal(empty.length, CORPUS.emptyRecords);
  assert.match(empty[0].file, /^Hermodr/);
  assert.equal(empty[0].difficulty.id, 0);
  assert.equal(empty[0].compiled.notes.length, 0);
  assert.ok(empty[0].compiled.warnings.some((w) => w.code === 'empty-difficulty'));
});

test('corpus note/point/measure-line/scroll totals match the recovered data', () => {
  let serializedNotes = 0;
  let serializedPoints = 0;
  let compiledNotes = 0;
  let compiledPoints = 0;
  let measureLines = 0;
  let scrollEvents = 0;
  for (const entry of corpus) {
    for (const difficulty of entry.chart.difficulties) {
      serializedNotes += difficulty.notes.length;
      for (const parsedNote of difficulty.notes) serializedPoints += parsedNote.points.length;
    }
  }
  for (const record of compiledRecords()) {
    compiledNotes += record.compiled.notes.length;
    for (const compiledNote of record.compiled.notes) compiledPoints += compiledNote.points.length;
    measureLines += record.compiled.difficulty.measureBeats.length;
    scrollEvents += record.compiled.events.filter((event) => event.kind === 'scroll').length;
  }
  assert.equal(serializedNotes, CORPUS.serializedNotes);
  assert.equal(serializedPoints, CORPUS.serializedPoints);
  // Slide/void emit one game point per ExtendedLaneData, exactly like the loader.
  assert.equal(compiledPoints, CORPUS.gameNotePoints);
  assert.equal(compiledNotes, CORPUS.serializedNotes);
  assert.equal(measureLines, CORPUS.measureLines);
  assert.equal(scrollEvents, CORPUS.totalScrollEvents);
  // Regression: the chart span must come from every serialized note, not just group 0.
  for (const record of compiledRecords()) {
    const { difficulty, compiled } = record;
    const points = difficulty.notes.flatMap((note) => note.points.map((point) => point.beat));
    const expectedLastBeat = points.length === 0 ? 0 : Math.max(...points);
    assert.equal(compiled.difficulty.lastBeat, expectedLastBeat, `${record.file} lastBeat`);
    assert.equal(compiled.endBeat, expectedLastBeat, `${record.file} endBeat`);
    // `group.noteCount` counts game-note points (one per ExtendedLaneData), matching the
    // loader; the parent-note count is `difficulty.noteCount`.
    const groupedPoints = compiled.groups.reduce((total, group) => total + group.noteCount, 0);
    const expectedPoints = difficulty.notes.reduce((total, note) => total + note.points.length, 0);
    assert.equal(groupedPoints, expectedPoints, `${record.file} every point is assigned to a group`);
    assert.equal(compiled.difficulty.noteCount, difficulty.notes.length, `${record.file} parent note count`);
  }
});

test('corpus feature counts match docs/02 (tap/slide/bullet/void/dash coverage, easing, BPM, gimmicks, scroll segments)', () => {
  const typeCounts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  const recordTypePresence = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  let multiBpmRecords = 0;
  let independentEasingRecords = 0;
  let gimmickRefRecords = 0;
  let scrollSegmentRecords = 0;
  for (const entry of corpus) {
    for (const difficulty of entry.chart.difficulties) {
      const bpms = new Set(entry.chart.timing.map((tp) => tp.bpm));
      if (bpms.size > 1) multiBpmRecords += 1;
      if (difficulty.scrollSegments.length > 0) scrollSegmentRecords += 1;
      const present = new Set();
      let independent = false;
      let gimmicks = false;
      for (const parsedNote of difficulty.notes) {
        present.add(parsedNote.type);
        typeCounts[parsedNote.type] += 1;
        if (parsedNote.gimmickIndexes.length > 0) gimmicks = true;
        for (const point of parsedNote.points) {
          if (point.hasLeftEasing && point.hasRightEasing && point.leftEasing !== point.rightEasing) {
            independent = true;
          }
        }
      }
      for (const type of present) recordTypePresence[type] += 1;
      if (independent) independentEasingRecords += 1;
      if (gimmicks) gimmickRefRecords += 1;
    }
  }
  assert.deepEqual(typeCounts, CORPUS.typeCounts);
  assert.deepEqual(recordTypePresence, CORPUS.recordTypePresence);
  assert.equal(multiBpmRecords, CORPUS.recordsWithMultiBpm);
  assert.equal(independentEasingRecords, CORPUS.recordsWithIndependentEasing);
  assert.equal(gimmickRefRecords, CORPUS.recordsWithGimmickRefs);
  assert.equal(scrollSegmentRecords, CORPUS.measuredRecords);
  // Dash is implemented but absent from the recovered corpus (docs/10, docs/02).
  assert.equal(typeCounts[4], 0);
});

test('corpus scroll segments: serialized order is preserved and every ramp is a valid staircase', () => {
  let finite = 0;
  let infinite = 0;
  let zero = 0;
  for (const entry of corpus) {
    for (const difficulty of entry.chart.difficulties) {
      const previousByGroup = new Map();
      for (const segment of difficulty.scrollSegments) {
        const previous = previousByGroup.get(segment.groupId) ?? 1.0;
        if (segment.length === 0) zero += 1;
        else if (Number.isFinite(segment.length)) finite += 1;
        else infinite += 1;
        previousByGroup.set(segment.groupId, segment.endMultiplier);
        assert.equal(typeof segment.easing, 'number');
        assert.ok(segment.easing >= 0 && segment.easing <= 20, `${entry.file} easing ${segment.easing}`);
        if (segment.length !== 0 && Number.isFinite(segment.length)) {
          const ramp = scrollRampFactors(previous, segment.length, segment.endMultiplier, segment.easing);
          assert.equal(ramp.steps, Math.min(Math.max(Math.ceil(Math.abs(segment.endMultiplier - previous) / 0.005), 2), 192));
          assert.ok(Math.abs(ramp.factors[0].factor - previous) <= 1e-9,
            `${entry.file} ramp start ${ramp.factors[0].factor} != ${previous}`);
          assert.ok(Math.abs(ramp.factors[ramp.steps - 1].factor - segment.endMultiplier) <= 1e-9,
            `${entry.file} ramp endpoint ${ramp.factors[ramp.steps - 1].factor} != ${segment.endMultiplier}`);
          for (let i = 1; i < ramp.steps; i += 1) {
            assert.ok(ramp.factors[i].fraction > ramp.factors[i - 1].fraction);
          }
        }
      }
    }
  }
  assert.equal(finite, 40);
  assert.equal(infinite, 334);
  assert.equal(zero, 0);
});

test('corpus scroll events come only from segments, with one event per instantaneous change', () => {
  let instantaneous = 0;
  let rampEvents = 0;
  for (const record of compiledRecords()) {
    for (const group of record.compiled.groups) {
      assert.ok(Array.isArray(group.events), `${record.file} group ${group.id} events`);
      const segments = group.segments || [];
      const stepsExpected = segments.reduce((total, segment) => (
        segment.length === 0 || !Number.isFinite(segment.length) ? total + 1 : total
      ), 0);
      instantaneous += stepsExpected;
      const instantaneousEvents = group.events.filter((event) => event.kind === 'scroll' && event.step === -1);
      assert.equal(instantaneousEvents.length, stepsExpected, `${record.file} group ${group.id}`);
      // Every instantaneous change lands exactly on a segment start beat with its end multiplier.
      for (const event of instantaneousEvents) {
        const segment = group.segments.find((candidate) => candidate.index === event.segmentIndex);
        assert.equal(event.beat, segment.startBeat, `${record.file} instantaneous beat`);
        assert.equal(event.factor, segment.endMultiplier, `${record.file} instantaneous factor`);
      }
      rampEvents += group.events.filter((event) => event.kind === 'scroll' && event.step >= 0).length;
      for (const event of group.events) {
        if (event.kind === 'scroll') {
          assert.ok(Number.isFinite(event.factor), `${record.file} scroll factor`);
        }
      }
    }
  }
  // 374 serialized scroll segments in the 62 non-empty records plus the empty Hermóðr
  // Crescent record's own group 0 produce 6,500 scroll events: 334 instantaneous changes
  // and 6,166 discrete ramp steps.
  assert.equal(instantaneous, 334);
  assert.equal(rampEvents, CORPUS.totalScrollEvents - 334);
  assert.ok(rampEvents > 6000, `ramp staircase events: ${rampEvents}`);
  assert.equal(instantaneous + rampEvents, CORPUS.totalScrollEvents);
});

test('corpus: every compiled note reproduces the conductor simulation (position and time)', () => {
  // Independent forward state walk driven only by recorded absolute times.
  const forwardStateAt = (timeline, time, firstBpm) => {
    const state = resetConductorState(createConductorState());
    for (let i = 0; i < timeline.events.length; i += 1) {
      const info = timeline.noteInfo[i];
      if (info.time > time) break;
      const event = timeline.events[i];
      if (info.time < state.lastProcessedAbsoluteTime) continue;
      state.lastProcessedAbsoluteTime = info.time;
      state.lastProcessedRhythmicTime = convertAbsoluteToRhythmic(state, info.time);
      if (event.kind === 'bpm') processBpm(state, event.beat, event.bpm, firstBpm);
      else if (event.kind === 'scroll') processScrollFactorChange(state, event.beat, event.factor);
    }
    return state;
  };

  let checked = 0;
  let worstPosition = 0;
  let worstBeat = 0;
  for (const record of compiledRecords()) {
    const compiled = record.compiled;
    for (const group of compiled.groups) {
      const noteEvents = group.timeline.events
        .map((event, index) => ({ event, info: group.timeline.noteInfo[index] }))
        .filter(({ event }) => event.kind === 'note');
      const stride = Math.max(1, Math.floor(noteEvents.length / 120));
      for (let i = 0; i < noteEvents.length; i += stride) {
        const { event, info } = noteEvents[i];
        const state = forwardStateAt(group.timeline, info.time, compiled.firstBpm);
        const position = convertRhythmicToPosition(state, event.beat);
        worstPosition = Math.max(worstPosition, Math.abs(position - info.position));
        const beat = compiled.beatAtGroup(info.time, group.id);
        worstBeat = Math.max(worstBeat, Math.abs(beat - event.beat));
        checked += 1;
      }
    }
  }
  assert.ok(checked > 5000, `sampled ${checked} note points`);
  assert.equal(worstPosition, 0, 'position must be exact');
  // Time is reconstructed from the precomputed segment table, so it can differ from the
  // in-order accumulation only by float rounding.
  assert.ok(worstBeat < 1e-9, `worst beat reconstruction error ${worstBeat}`);
});

test('corpus: arbitrary-order seeking matches in-order queries exactly', () => {
  const record = compiledRecords().find((entry) => entry.file.startsWith('Training_2'));
  assert.ok(record, 'Training_2 corpus record');
  const compiled = record.compiled;
  const lo = compiled.timeAt(0);
  const hi = compiled.duration;
  const beats = [];
  for (let i = 0; i <= 200; i += 1) beats.push(lo + ((hi - lo) * i) / 200);

  const ascending = beats.map((beat) => compiled.timeAt(beat));
  const descending = [...beats].reverse().map((beat) => compiled.timeAt(beat)).reverse();
  const shuffled = beats
    .map((beat, index) => ({ beat, index, key: (index * 2654435761) % 1000 }))
    .sort((a, b) => a.key - b.key)
    .map(({ beat, index }) => ({ index, time: compiled.timeAt(beat) }))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.time);
  assert.deepEqual(descending, ascending);
  assert.deepEqual(shuffled, ascending);
  // positionAt composes beatAt/timeAt and is likewise order independent
  const positionsAscending = beats.map((beat) => compiled.positionAt(compiled.timeAt(beat)));
  const positionsDescending = [...beats].reverse().map((beat) => compiled.positionAt(compiled.timeAt(beat))).reverse();
  assert.deepEqual(positionsDescending, positionsAscending);
});

test('corpus: beatAt is monotone and timeAt inverts it away from clamped regions', () => {
  let checked = 0;
  let clamped = 0;
  for (const record of compiledRecords()) {
    const compiled = record.compiled;
    let previous = -Infinity;
    const lo = compiled.timeAt(0);
    for (let i = 0; i <= 60; i += 1) {
      const time = lo + ((compiled.duration - lo) * i) / 60;
      const beat = compiled.beatAt(time);
      assert.ok(beat >= previous - 1e-9, `${record.file} beatAt monotone`);
      previous = beat;
      const back = compiled.timeAt(beat);
      if (Math.abs(back - time) < 1e-9) checked += 1;
      else clamped += 1;
    }
  }
  assert.ok(checked > clamped, `round-tripped ${checked}, clamped/limited ${clamped}`);
});

test('corpus: positionAt is continuous at scroll changes and monotone inside a segment', () => {
  for (const record of compiledRecords()) {
    const compiled = record.compiled;
    for (const group of compiled.groups) {
      const timeline = group.timeline;
      // Each segment's stored visual anchor must reproduce positionAt exactly.
      for (const segment of timeline.segments) {
        const expected = (segment.startBeat - segment.visualOffsetRhythmic)
          * (segment.scrollFactor * segment.compensation) + segment.visualOffsetPosition;
        assert.ok(Number.isFinite(expected), `${record.file} group ${group.id} finite anchor`);
        assert.ok(Math.abs(positionAtBeatInTimeline(timeline, segment.startBeat) - expected) < 1e-9,
          `${record.file} group ${group.id} anchor at beat ${segment.startBeat}`);
      }
      // positionAt is right-continuous at a scroll event: the event's own beat already uses
      // the new factor (ScrollFactorChange.Process anchors the offset at that beat).
      for (const event of timeline.scrollEvents) {
        if (!Number.isFinite(event.beat)) continue;
        const at = positionAtBeatInTimeline(timeline, event.beat);
        const justAfter = positionAtBeatInTimeline(timeline, event.beat + 1e-9);
        assert.ok(Math.abs(justAfter - at) < 1e-4, `${record.file} group ${group.id} right continuity`);
      }
      // Monotone inside each segment whenever the effective slope is non-negative.
      for (const segment of timeline.segments) {
        if (segment.scrollFactor * segment.compensation < 0) continue;
        const span = (timeline.segments[timeline.segments.indexOf(segment) + 1]?.startBeat ?? segment.startBeat + 4)
          - segment.startBeat;
        if (!(span > 0)) continue;
        let previous = -Infinity;
        for (let k = 0; k < 8; k += 1) {
          const value = positionAtBeatInTimeline(timeline, segment.startBeat + (span * k) / 8);
          assert.ok(value >= previous - 1e-9, `${record.file} group ${group.id} monotone`);
          previous = value;
        }
      }
    }
  }
});

test('corpus: measure lines stay inside their timing segments and use the exclusive end beat', () => {
  const training = compiledRecords().find((record) => record.file.startsWith('Training_1'));
  const trainingBeats = training.compiled.difficulty.measureBeats;
  const trainingLastBeat = training.compiled.difficulty.lastBeat; // 218: max stored lane-point beat
  const trainingLastNote = Math.max(...training.compiled.notes.flatMap((n) => n.points.map((p) => p.beat)));
  assert.equal(trainingLastBeat, 218);
  assert.equal(trainingLastNote, trainingLastBeat);
  assert.deepEqual(trainingBeats.slice(0, 3), [0, 4, 8]);
  // Measure lines follow the timing points, not the notes, and the final timing point's
  // segment ends at `lastBeat` (218): its grid stops at 216 there, while the earlier
  // segments keep their own grids — the chart's 88 lines end at beat 332.
  assert.equal(trainingBeats.length, 88);
  assert.equal(trainingBeats[trainingBeats.length - 1], 332);
  assert.ok(trainingBeats[trainingBeats.length - 1] > trainingLastNote);
  assert.equal(training.compiled.chart.timing[training.compiled.chart.timing.length - 1].startBeat, 339);
  assert.ok(!trainingBeats.includes(339));

  for (const record of compiledRecords()) {
    const { difficulty, compiled } = record;
    const lastBeat = lastBeatOfDifficulty(difficulty);
    // The empty record has no notes, so the loader's last-beat step is replaced by 0.
    assert.equal(compiled.difficulty.lastBeat, lastBeat === null ? 0 : lastBeat);
    assert.deepEqual(compiled.difficulty.measureBeats, measureLineBeats(record.compiled.chart.timing, compiled.difficulty.lastBeat));
    const beats = compiled.difficulty.measureBeats;
    const chartEnd = Math.max(...compiled.chart.timing.map((tp) => tp.startBeat), compiled.difficulty.lastBeat);
    for (let i = 0; i < beats.length; i += 1) {
      assert.ok(Number.isFinite(beats[i]), `${record.file} measure beat finite`);
      assert.ok(beats[i] < chartEnd + 1e-9, `${record.file} measure beat ${beats[i]} within chart end ${chartEnd}`);
      if (i > 0) {
        assert.ok(beats[i] >= beats[i - 1], `${record.file} measure lines are generated in ascending order`);
      }
    }
  }
});

test('corpus: every serialized note keeps its independent edges and stable relative order', () => {
  for (const entry of corpus) {
    for (const difficulty of entry.chart.difficulties) {
      for (const parsedNote of difficulty.notes) {
        parsedNote.points.forEach((point, index) => {
          assert.equal(point.index, index);
          if (point.hasLeftEasing) {
            assert.equal(point.easeLeft, easingFunction(point.leftEasing));
          }
          if (point.hasRightEasing) {
            assert.equal(point.easeRight, easingFunction(point.rightEasing));
          }
          if (point.hasLeftEasing && point.hasRightEasing) {
            // Independent edges must not be collapsed into a single easing.
            assert.equal(typeof point.easeLeft, 'function');
            assert.equal(typeof point.easeRight, 'function');
          }
        });
      }
    }
  }
});

test('corpus: notes that share a beat keep loader insertion order for stable ties', () => {
  const chart = parseChart([
    'v1.7.2',
    [timingPoint(4, 4, 120, 0, { resetMetronome: true })],
    [['c', 0, 1, [
      note(0, [laneData([lane(1)], 1, 2.0)], []),
      note(0, [laneData([lane(2)], 1, 2.0)], []),
      note(0, [laneData([lane(3)], 1, 2.0)], []),
      note(2, [laneData([lane(4)], 1, 2.0)], []),
    ], []]],
    [],
  ], 'ties');
  const compiled = compileChart(chart, 0);
  const tied = compiled.events.filter((event) => event.kind === 'note' && event.beat === 2.0);
  assert.deepEqual(tied.map((event) => event.noteId), ['n0', 'n1', 'n2', 'n3']);

  // Same beat, different kinds: BPM (ProcessOrder short.MinValue) < scroll/game point (0)
  // < measure line (short.MaxValue). The loader adds measure lines last, so a measure line
  // sharing a beat with a game point is processed after it.
  const shared = parseChart([
    'v1.7.2',
    [timingPoint(4, 4, 120, 0, { resetMetronome: true })],
    [['c', 0, 1, [
      note(0, [laneData([lane(1)], 1, 0.0)], []),
      note(0, [laneData([lane(2)], 1, 4.0)], []),
    ], []]],
    [],
  ], 'shared');
  const sharedCompiled = compileChart(shared, 0);
  const atZero = sharedCompiled.events.filter((event) => event.beat === 0);
  const atFour = sharedCompiled.events.filter((event) => event.beat === 4);
  assert.deepEqual(atZero.map((event) => event.kind), ['bpm', 'measureLine', 'note']);
  assert.deepEqual(atFour.map((event) => event.kind), ['note']);
  assert.deepEqual(sharedCompiled.difficulty.measureBeats, [0]);
});

test('loadChart parses and compiles in one call', () => {
  const compiled = loadChart(DOC_FIXTURE, 'one-shot', 0);
  assert.equal(compiled.chart.id, 'one-shot');
  assert.equal(compiled.difficulty.id, 0);
  assert.equal(compiled.notes.length, 2);
});

test('corpus difficulty names and classes match the documented ids', () => {
  const seen = new Set();
  for (const entry of corpus) {
    for (const difficulty of entry.chart.difficulties) {
      seen.add(difficulty.id);
      assert.equal(difficulty.name, DIFFICULTY_NAME[difficulty.id]);
    }
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4]);
  assert.equal(DIFFICULTY_NAME[0], 'Crescent');
  assert.equal(DIFFICULTY_NAME[4], 'Eclipse');
});

test('corpus compile is fast enough for the viewer (whole corpus under 10s)', () => {
  const started = Date.now();
  let count = 0;
  for (const entry of corpus) {
    for (const difficulty of entry.chart.difficulties) {
      try {
        compileChart(entry.chart, difficulty.id);
        count += 1;
      } catch {
        // the single empty record is expected to throw
      }
    }
  }
  const elapsed = Date.now() - started;
  assert.equal(count, allRecords.length);
  assert.ok(elapsed < 10_000, `compiled ${count} records in ${elapsed}ms`);
});
