/**
 * renderer.test.js — regression tests for Canvas perspective playfield renderer.
 *
 * Runs with the bundled Node test runner and no dependencies:
 *   node --test renderer.test.js
 *
 * The headline case is the "notes stop halfway down the field" defect: the renderer resolved the
 * conductor's `positionAt`/`timeAt` from `compiled.chart` (which carries DATA ONLY), so it fell
 * back to a seconds-valued toy model. The judgement-plane state was then measured in chart
 * seconds while note positions were in conductor position units, so `notePosition - statePosition`
 * was non-zero at every hit time — notes froze partway down the field and never reached the line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PlayfieldRenderer, SCROLL, CULL, TRACK, worldToCamera, cameraAxesFromQuaternion, CAMERA_ROTATION, makeMembership, windingNumber, segmentPolygonParams, segmentsIntersect, clipEdgeToBoundary, polygonBounds, ringSignedArea, ringIsSimple } from './renderer.js';

// ---------------------------------------------------------------------------------------
// Harness: a recording 2D context and a fake canvas, no DOM required
// ---------------------------------------------------------------------------------------

function makeCanvas(width = 840, height = 491) {
  const calls = [];
  const stateStack = [];
  const record = (name) => (...args) => {
    calls.push({ name, args, composite: ctx.globalCompositeOperation });
  };
  const gradient = () => ({ addColorStop: () => {} });
  const ctx = new Proxy(
    {
      canvas: null,
      globalCompositeOperation: 'source-over',
      globalAlpha: 1,
      save: () => {
        stateStack.push({ composite: ctx.globalCompositeOperation, alpha: ctx.globalAlpha });
        record('save')();
      },
      restore: () => {
        const state = stateStack.pop();
        if (state) {
          ctx.globalCompositeOperation = state.composite;
          ctx.globalAlpha = state.alpha;
        }
        record('restore')();
      },
      beginPath: record('beginPath'),
      closePath: record('closePath'),
      moveTo: record('moveTo'),
      lineTo: record('lineTo'),
      arc: record('arc'),
      fill: record('fill'),
      stroke: record('stroke'),
      fillRect: record('fillRect'),
      drawImage: record('drawImage'),
      setTransform: record('setTransform'),
      transform: record('transform'),
      createLinearGradient: gradient,
      createRadialGradient: gradient,
    },
    {
      get: (target, prop) => (prop in target ? target[prop] : undefined),
      set: (target, prop, value) => {
        target[prop] = value;
        return true;
      },
    },
  );
  const canvas = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  };
  ctx.canvas = canvas;
  return { canvas, ctx, calls };
}

/**
 * A compiled fixture whose conductor position is deliberately non-linear in time, so a
 * seconds-valued fallback cannot coincide with the real value.
 *
 * beat -> time: t = beat / 2 ; beat -> position: p = beat * 2 => p = t * 4
 * A note at beat b has time b/2 and position 2b, and positionAt(b/2) must return 2b.
 *
 * `curveLeft`/`curveRight` (optional) name easing functions for the interval start points. Passing
 * DIFFERENT functions for the two edges is what makes a slide body actually curve: PathAngle only
 * rotates a straight body, so a rotation alone is not curvature.
 */
function makeFixture({ includePositionAt = true, notes: noteSpecs } = {}) {
  const specs = noteSpecs || [
    { id: 'n0', type: 0, beat: 2, lanes: [0, 0] },
    { id: 'n1', type: 0, beat: 4, lanes: [3, 3] },
    { id: 'n2', type: 0, beat: 8, lanes: [-5, -5] },
    { id: 'n3', type: 2, beat: 12, lanes: [6, 6] },
    { id: 'n4', type: 1, beat: 16, lanes: [2, 2], extra: { beat: 24, lanes: [5, 5] } },
  ];
  const timeOf = (beat) => beat / 2;
  const positionOf = (beat) => beat * 2;
  const positionAtTime = (time) => time * 4;

  const points = [];
  for (const spec of specs) {
    const chain = [{ beat: spec.beat, lanes: spec.lanes }];
    if (Array.isArray(spec.extra)) chain.push(...spec.extra);
    else if (spec.extra) chain.push({ beat: spec.extra.beat, lanes: spec.extra.lanes });
    const pts = chain.map((step, i) => {
      const isLast = i === chain.length - 1;
      const left = step.lanes[0] - 6;
      const right = step.lanes[1] - 6 + 1;
      const keepsEasing = (spec.type === 1 || spec.type === 3) && !isLast;
      const easeLeft = keepsEasing ? (spec.curveLeft || ((t) => t)) : null;
      const easeRight = keepsEasing ? (spec.curveRight || ((t) => t)) : null;
      return {
        index: i,
        beat: step.beat,
        time: timeOf(step.beat),
        position: positionOf(step.beat),
        left,
        right,
        center: (left + right) / 2,
        size: Math.abs(right - left),
        width: 1,
        leftEasing: keepsEasing ? 0 : null,
        rightEasing: keepsEasing ? 0 : null,
        easeLeft,
        easeRight,
        isLast,
      };
    });
    points.push({
      id: spec.id,
      index: points.length,
      type: spec.type,
      typeName: ['tap', 'slide', 'bullet', 'void', 'dash'][spec.type],
      direction: -1,
      group: 0,
      scrollMod: 1,
      startBeat: pts[0].beat,
      endBeat: pts[pts.length - 1].beat,
      points: pts,
    });
  }

  // Mirrors engine.compileChart: conductor functions live on the COMPILED object; `chart` is
  // data only. `includePositionAt:false` models a caller that dropped them.
  const compiled = {
    chart: {
      id: 'fixture',
      firstBpm: 120,
      offset: 0,
      timing: [],
      difficulties: [],
      title: 'fixture',
    },
    notes: points,
    events: [
      { kind: 'measureLine', beat: 4, time: timeOf(4), position: positionOf(4), group: 0 },
      { kind: 'measureLine', beat: 8, time: timeOf(8), position: positionOf(8), group: 0 },
    ],
    duration: timeOf(24),
    firstBpm: 120,
    secondsPerBeat: 0.5,
    offset: 0,
    timeAt: timeOf,
    beatAt: (time) => time * 2,
    timeAtGroup: timeOf,
    beatAtGroup: (time) => time * 2,
  };
  if (includePositionAt) compiled.positionAt = positionAtTime;
  return compiled;
}

const zAtHit = (renderer, note) => {
  const speed = renderer.baseScrollSpeed(1);
  const state = renderer.chart.positionAt(note.first.time, note.group);
  return (note.first.position - state) * note.scrollMod * speed * SCROLL.positionMultiplier;
};

/** Screen-space distance from a point to a segment (CSS pixels). */
const distToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0)) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// ---------------------------------------------------------------------------------------
// The reported defect
// ---------------------------------------------------------------------------------------

test('REGRESSION: every note reaches the judgement line (Z=0) at its own hit time', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeFixture());
  assert.ok(renderer.notes.length >= 5, 'fixture notes were normalized');
  assert.equal(renderer.timingWarnings.length, 0, 'stored positions agree with positionAt');

  for (const note of renderer.notes) {
    const z = zAtHit(renderer, note);
    assert.ok(
      Math.abs(z) < 1e-9,
      `${note.key} must sit exactly on the judgement plane at its hit time, got Z=${z}`,
    );
  }
});

test('REGRESSION: notes are visible as they arrive and are not culled before the line', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeFixture());
  const speed = renderer.baseScrollSpeed(1);

  for (const note of renderer.notes) {
    const t0 = note.first.time;
    const stateAt = (t) => renderer.chart.positionAt(t, note.group);
    // Approaching: a quarter second before the hit the note must be on screen and ahead of the
    // line. (Further out it can legitimately be beyond the front guard of 10.2, where the game
    // itself does not draw it yet.)
    const zBefore = (note.first.position - stateAt(t0 - 0.25)) * note.scrollMod * speed * SCROLL.positionMultiplier;
    assert.ok(zBefore > 0, `${note.key} is ahead of the judgement plane while approaching (Z=${zBefore})`);
    assert.ok(renderer._visible(zBefore), `${note.key} is not culled while approaching (Z=${zBefore})`);
    // At the hit it must be exactly at Z=0, which is inside the cull guard.
    const zHit = zAtHit(renderer, note);
    assert.ok(renderer._visible(zHit), `${note.key} is visible at its hit time`);
    // Just after the hit it may pass behind the line, but only slightly.
    const zAfter = (note.first.position - stateAt(t0 + 0.1)) * note.scrollMod * speed * SCROLL.positionMultiplier;
    assert.ok(zAfter < zHit, `${note.key} continues past the judgement plane`);
  }
});

test('REGRESSION: a note must never freeze at a non-zero Z (the "stops halfway" symptom)', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeFixture());
  const note = renderer.notes.find((n) => n.key === 'n2');
  assert.ok(note, 'fixture contains n2');
  const speed = renderer.baseScrollSpeed(1);
  const t0 = note.first.time;

  // Z must decrease monotonically toward 0 over the approach, with no plateau.
  let previous = Infinity;
  let atLine = null;
  for (let step = 0; step <= 40; step += 1) {
    const t = t0 - 1 + (step / 40) * 1;
    const state = renderer.chart.positionAt(t, note.group);
    const z = (note.first.position - state) * note.scrollMod * speed * SCROLL.positionMultiplier;
    assert.ok(z <= previous + 1e-9, `Z decreases monotonically (t=${t.toFixed(3)} Z=${z})`);
    previous = z;
    if (Math.abs(t - t0) < 1e-9) atLine = z;
  }
  assert.ok(Math.abs(atLine) < 1e-9, 'the sweep reaches Z=0 exactly at the hit time');
});

test('REGRESSION: note world Z is the conductor Z, with no Track offset added', () => {
  // The docs are explicit: "Never apply one blanket Track local-to-world matrix to notes".
  // `GameNote.Draw` submits an explicit WORLD matrix and the shader cull guard is on world Z.
  // Adding TRACK.position[2] (4.75) placed a note mid-field, which is where it then vanished.
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeFixture());
  const note = renderer.notes.find((n) => n.key === 'n0');
  const quad = renderer._tapQuad(note.first, note.pathAngle, 0, 0);
  assert.ok(quad, 'the quad projects at Z=0');
  const judgement = renderer.project(0, 0.015, 0);
  const quadY = quad.reduce((sum, p) => sum + p.y, 0) / 4;
  assert.ok(
    Math.abs(quadY - judgement.y) < 4,
    `a note at Z=0 sits on the judgement line (quad y=${quadY.toFixed(1)} vs line ${judgement.y.toFixed(1)})`,
  );
  // It must NOT sit at the Track centre (world Z 4.75), which is what the offset produced.
  const trackCentre = renderer.project(0, 0.02, TRACK.position[2]);
  assert.ok(
    Math.abs(quadY - trackCentre.y) > 100,
    `the note is far from the Track centre (quad y=${quadY.toFixed(1)} vs centre ${trackCentre.y.toFixed(1)})`,
  );
});

test('REGRESSION: a note travels the full field and is visible at the line', () => {
  const { canvas } = makeCanvas(838, 488);
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeFixture());
  const note = renderer.notes.find((n) => n.key === 'n1');
  const speed = renderer.baseScrollSpeed(1);
  const t0 = note.first.time;
  const stateAt = (t) => renderer.chart.positionAt(t, note.group);
  const sampleAt = (t) => {
    const z = (note.first.position - stateAt(t)) * note.scrollMod * speed * SCROLL.positionMultiplier;
    const quad = renderer._tapQuad(note.first, note.pathAngle, z, 0);
    if (!quad) return { z, y: null, visible: false };
    return { z, y: quad.reduce((sum, p) => sum + p.y, 0) / 4, visible: renderer._visible(z) };
  };

  // A note only exists on screen once it is inside the front guard (Z <= 10.2); beyond that the
  // game itself does not draw it. Sample inside that window and at the line.
  const early = sampleAt(t0 - 0.4);
  const mid = sampleAt(t0 - 0.25);
  const hit = sampleAt(t0);
  assert.ok(early.y !== null && mid.y !== null && hit.y !== null, 'all three samples project');
  // Screen Y increases (moves down the field) monotonically as the note approaches.
  assert.ok(early.y < mid.y, `approaches downward (${early.y.toFixed(1)} -> ${mid.y.toFixed(1)})`);
  assert.ok(mid.y < hit.y, `keeps moving to the line (${mid.y.toFixed(1)} -> ${hit.y.toFixed(1)})`);
  const judgement = renderer.project(0, 0.015, 0);
  assert.ok(Math.abs(hit.y - judgement.y) < 4, `reaches the judgement line (${hit.y.toFixed(1)})`);
  // It covers most of the field rather than freezing in the top third.
  assert.ok(hit.y - early.y > 200, `travels a long way (${(hit.y - early.y).toFixed(1)} px)`);
  assert.ok(early.visible && mid.visible && hit.visible, 'visible on approach and at the line');
  // Just beyond the front guard the renderer deliberately does not draw it.
  const beyond = sampleAt(t0 - 0.5);
  assert.equal(beyond.visible, false, `beyond the front guard is culled by design (Z=${beyond.z.toFixed(1)})`);
  assert.ok(beyond.y < early.y, 'and it is further up the field than the first visible sample');
});

test('REGRESSION: a void keeps drawing while its head crosses the judgement line', () => {
  // Reported symptom: "void spazzes out when the beginning touches the judgement line". Cause:
  // `_drawSegmentBody` returned as soon as ANY sample failed `project()`, so the whole body
  // vanished the moment its head crossed the camera's near plane, and the cross-sections between
  // the CPU guard and the camera projected to enormous coordinates first.
  const { canvas, calls } = makeCanvas(838, 488);
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(
    makeFixture({ notes: [{ id: 'v1', type: 3, beat: 40, lanes: [2, 5], extra: { beat: 48, lanes: [2, 5] } }] }),
  );
  const note = renderer.notes[0];
  assert.equal(note.kind, 3, 'void normalized');
  const speed = renderer.baseScrollSpeed(1);
  const stateAt = (t) => renderer.chart.positionAt(t, 0);

  const sample = (t) => {
    const st = stateAt(t);
    const zH = (note.first.position - st) * speed * SCROLL.positionMultiplier;
    calls.length = 0;
    renderer._drawVoid(renderer.ctx, note, zH, () => st, speed);
    const pts = calls
      .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
      .flatMap((c) => [c.args[0], c.args[1]]);
    const xs = pts.filter((_, i) => i % 2 === 0);
    const ys = pts.filter((_, i) => i % 2 === 1);
    const drawn = calls.some((c) => c.name === 'fill' || c.name === 'stroke');
    return {
      zH,
      drawn,
      maxAbsX: xs.length ? Math.max(...xs.map(Math.abs)) : 0,
      maxAbsY: ys.length ? Math.max(...ys.map(Math.abs)) : 0,
      finite: pts.every((v) => Number.isFinite(v)),
    };
  };

  const before = sample(note.first.time - 0.2);
  const atLine = sample(note.first.time);
  const after = sample(note.first.time + 0.2);
  const wellAfter = sample(note.first.time + 2.0);

  assert.ok(before.zH > 0 && atLine.zH === 0 && after.zH < 0, 'the head actually crosses zero');
  // The body must keep drawing on both sides of the crossing; that was the bug.
  assert.ok(before.drawn, 'drawn before the crossing');
  assert.ok(atLine.drawn, 'drawn at the crossing');
  assert.ok(after.drawn, 'STILL drawn after the head crossed the line');
  assert.ok(wellAfter.drawn, 'still drawn well after the crossing');
  for (const s of [before, atLine, after, wellAfter]) {
    assert.ok(s.finite, 'all polygon coordinates are finite');
    assert.ok(s.maxAbsY <= 488 * 9 + 1, `polygon stays inside the clip band (maxY=${s.maxAbsY})`);
    assert.ok(s.maxAbsX <= 838 * 9 + 1, `polygon stays inside the clip band (maxX=${s.maxAbsX})`);
  }
});

test('REGRESSION: void geometry is clipped to the shader Z bounds, not the wider CPU guard', () => {
  // Both note shaders discard fragments outside worldZ -.25..9.75. Clipping to that span before
  // projecting is what keeps a cross-section near the camera from blowing up.
  const { canvas, calls } = makeCanvas(838, 488);
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(
    makeFixture({ notes: [{ id: 'v1', type: 3, beat: 40, lanes: [2, 5], extra: { beat: 48, lanes: [2, 5] } }] }),
  );
  const note = renderer.notes[0];
  const shaderNearScreen = renderer.project(0, 0.012, CULL.shaderNear);
  assert.ok(shaderNearScreen, 'the shader near bound still projects');
  for (const dt of [0, 0.2, 1.0, 3.0]) {
    const st = renderer.chart.positionAt(note.first.time + dt, 0);
    const zH = (note.first.position - st) * renderer.baseScrollSpeed(1) * SCROLL.positionMultiplier;
    calls.length = 0;
    renderer._drawVoid(renderer.ctx, note, zH, () => st, renderer.baseScrollSpeed(1));
    const ys = calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo').map((c) => c.args[1]);
    for (const y of ys) {
      assert.ok(
        y <= shaderNearScreen.y + 2,
        `no vertex sits nearer than the shader near bound (y=${y.toFixed(1)} vs ${shaderNearScreen.y.toFixed(1)})`,
      );
    }
  }
});

test('void TRS in world space: start translation unrotated, mesh z scaled then rotated', () => {
  // VoidPoint.cs: `TRS(new Vector3(0f, .002f, num), pathAngle, new Vector3(1f, 1f, num2 - num))`.
  // Because TRS applies S then R to the local mesh point (laneWorldX, .01, s) and adds the
  // translation, the world position is
  //     PathAngle(laneWorldX, 0, s*(num2-num)) + (0, .002, num)
  // i.e. the start translation `num` is NOT rotated while the mesh's local z IS scaled then
  // rotated. The cells are captured BEFORE clipping/projection, so the check is exact and needs
  // no screen projection at all.
  const { canvas } = makeCanvas(838, 488);
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  const fixture = makeFixture({
    notes: [{ id: 'v1', type: 3, beat: 0, lanes: [0, 0], extra: { beat: 40, lanes: [0, 0] } }],
  });
  fixture.notes[0].angle = 45;
  renderer.setChart(fixture);
  const note = renderer.notes[0];

  let captured = null;
  const original = renderer._fillVoidBodyClipped.bind(renderer);
  renderer._fillVoidBodyClipped = (ctx, cells, leftRail, rightRail) => {
    captured = { cells, leftRail, rightRail };
    return original(ctx, cells, leftRail, rightRail);
  };
  // zA is large and negative here, so the interval is definitely NOT a no-op: any failure to
  // rotate the scaled mesh z (or to leave the start translation alone) shows up immediately.
  const t = 6;
  const st = renderer.chart.positionAt(t, 0);
  const speed = renderer.baseScrollSpeed(1);
  const zA = renderer._zOf(note.first, st, speed, note.scrollMod);
  const zB = renderer._zOf(note.last, st, speed, note.scrollMod);
  assert.ok(zA < 0, `the running test exercises a negative start Z (zA=${zA.toFixed(2)})`);
  assert.ok(zB > zA, 'the interval runs away from the judgement plane');
  renderer._drawVoid(renderer.ctx, note, zA, () => st, speed);
  assert.ok(captured && captured.cells.length > 0, 'cells were produced before clipping');

  const deg = (d) => (d * Math.PI) / 180;
  const rotate = (x, z, d) => {
    const c = Math.cos(deg(d));
    const si = Math.sin(deg(d));
    return [x * c + z * si, -x * si + z * c];
  };
  const n = captured.leftRail.length;
  assert.equal(captured.cells.length, n - 1, 'one cell per rail segment');

  for (let k = 0; k < n; k += 1) {
    const s = n === 1 ? 0 : k / (n - 1);
    const len = zB - zA;
    for (const [railName, laneLane] of [
      ['leftRail', note.first.left],
      ['rightRail', note.first.right],
    ]) {
      const got = captured[railName][k];
      const laneWorldX = laneLane * (5 / 24);
      // Correct matrix reading.
      const [cx, cz] = rotate(laneWorldX, s * len, 45);
      const wantX = cx;
      const wantZ = zA + cz;
      assert.ok(
        Math.abs(got.x - wantX) < 1e-9 && Math.abs(got.z - wantZ) < 1e-9,
        `${railName}[${k}] matches the source TRS (got ${got.x.toFixed(6)},${got.z.toFixed(6)} want ${wantX.toFixed(6)},${wantZ.toFixed(6)})`,
      );
      // Rejected alternative A: start translation rotated too.
      const [ax, az] = rotate(laneWorldX, s * len + zA, 45);
      const altA = Math.hypot(got.x - ax, got.z - az);
      // Rejected alternative B: mesh z span not scaled/rotated (only the lane turned).
      const [bx, bz] = rotate(laneWorldX, 0, 45);
      const altB = Math.hypot(got.x - bx, got.z - (zA + s * len + bz));
      assert.ok(altA > 1e-6 || altB > 1e-6, `${railName}[${k}] discriminates the rejected readings`);
    }
  }
});
test('void rails are clipped to an empty or single-segment result without duplicates', () => {
  // The border stroke must not double up at a bound (duplicate intersection points made a
  // degenerate "closed" polygon and a brightness jump), and a rail fully outside the box must
  // produce nothing.
  const { canvas, calls } = makeCanvas(838, 488);
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  const fixture = makeFixture({
    notes: [{ id: 'v1', type: 3, beat: 0, lanes: [0, 0], extra: { beat: 40, lanes: [2, 2] } }],
  });
  renderer.setChart(fixture);
  const note = renderer.notes[0];
  const speed = renderer.baseScrollSpeed(1);
  for (const t of [0, 2, 6, 20, 40]) {
    const st = renderer.chart.positionAt(t, 0);
    const zA = renderer._zOf(note.first, st, speed, note.scrollMod);
    calls.length = 0;
    renderer._drawVoid(renderer.ctx, note, zA, () => st, speed);
    // Walk each stroked path: no point may repeat back-to-back (that is the duplicate case).
    let prev = null;
    let moveCount = 0;
    for (const c of calls) {
      if (c.name === 'moveTo') {
        moveCount += 1;
        prev = [c.args[0], c.args[1]];
      } else if (c.name === 'lineTo') {
        const p = [c.args[0], c.args[1]];
        assert.ok(
          !prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1e-9,
          `no degenerate repeated point in a stroked path at t=${t}`,
        );
        prev = p;
      }
    }
    assert.ok(moveCount >= 0);
  }
});

test('slide tails keep drawing after the head has passed the camera', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(
    makeFixture({
      notes: [{ id: 'slide1', type: 1, beat: 20, lanes: [0, 1], extra: { beat: 60, lanes: [4, 5] } }],
    }),
  );
  const note = renderer.notes[0];
  assert.equal(note.kind, 1, 'slide normalized');
  assert.equal(note.points.length, 2, 'two points');

  const speed = renderer.baseScrollSpeed(1);
  // Choose a time where the head is already behind the guard while the tail is still inside it.
  // z = (position - state) * speed * 4, so solving for a tail z of ~5 gives the state and time.
  const headPos = note.first.position;
  const tailPos = note.last.position;
  const tailZ = 5;
  const state = tailPos - tailZ / (speed * SCROLL.positionMultiplier);
  const t = state / 4; // fixture: positionAt(t) = t * 4
  const zHead = (headPos - state) * speed * SCROLL.positionMultiplier;
  const zTail = (tailPos - state) * speed * SCROLL.positionMultiplier;
  assert.ok(zHead < CULL.back, `head is behind the guard (Z=${zHead})`);
  assert.ok(zTail > CULL.back && zTail < CULL.front, `tail is on screen (Z=${zTail})`);
  assert.equal(renderer._segmentVisible(zHead, zTail), true, 'the interval is still drawn');
  const anchor = renderer._visibleAnchorZ(note, state, speed);
  assert.equal(anchor, zTail, 'the draw anchor is the visible tail, not the culled head');
  void t;
});

// ---------------------------------------------------------------------------------------
// Read-only viewer: no central player marker or debug dot
// ---------------------------------------------------------------------------------------

for (const overlays of [true, false]) {
  test(`REGRESSION: normal render never draws Onibi with overlays=${overlays}`, () => {
    const { canvas } = makeCanvas();
    const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
    renderer.setChart(makeFixture());
    let markerCalls = 0, judgementCalls = 0, noteCalls = 0;
    renderer._drawOnibi = () => markerCalls++;
    const judgement = renderer._drawJudgementLine.bind(renderer);
    renderer._drawJudgementLine = (...args) => { judgementCalls++; return judgement(...args); };
    const note = renderer._drawNote.bind(renderer);
    renderer._drawNote = (...args) => { noteCalls++; return note(...args); };
    renderer.render(1, { overlays, onibiLane: 3 });
    assert.equal(markerCalls, 0, 'no player marker even with an explicit marker lane');
    assert.equal(judgementCalls, overlays ? 1 : 0, 'judgement line respects overlay setting');
    assert.ok(noteCalls > 0, 'notes still draw');
  });
}

test('REGRESSION: empty viewer frame has no center dot and retains the judgement bar', () => {
  const { canvas, ctx, calls } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeFixture({ notes: [] }));
  for (const overlays of [true, false]) {
    calls.length = 0;
    renderer.render(0, { overlays });
    assert.equal(calls.filter(c => c.name === 'arc').length, 0, 'empty frame draws no central dot');
  }
  calls.length = 0;
  renderer._drawJudgementLine(ctx);
  assert.ok(calls.some(c => c.name === 'lineTo'), 'judgement bar polygon remains');
  assert.ok(calls.some(c => c.name === 'fill'), 'judgement bar is still painted');
  assert.equal(calls.filter(c => c.name === 'arc').length, 0, 'bar does not add a debug dot');
});

// ---------------------------------------------------------------------------------------
// Void compositing: fixed underlay instead of endpoint-dependent whole-object occlusion
// ---------------------------------------------------------------------------------------

function makeOverlapFixture() {
  return makeFixture({ notes: [
    { id: 'void', type: 3, beat: 20, lanes: [2, 5], extra: { beat: 21, lanes: [2, 5] } },
    { id: 'tap', type: 0, beat: 20.5, lanes: [3, 3] },
    { id: 'slide', type: 1, beat: 20.5, lanes: [3, 3], extra: { beat: 21, lanes: [3, 3] } },
    { id: 'bullet', type: 2, beat: 20.5, lanes: [3, 3] },
    { id: 'dash', type: 4, beat: 20.5, lanes: [3, 3] },
  ] });
}

test('REGRESSION: void stays a once-only underlay when its visible anchor jumps past overlapping notes', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeOverlapFixture());
  const voidNote = renderer.notes.find((n) => n.key === 'void');
  const tapNote = renderer.notes.find((n) => n.key === 'tap');
  const speed = renderer.baseScrollSpeed(1);
  const frames = [9.99, 10.03];
  const anchors = frames.map((t) => {
    const state = renderer.chart.positionAt(t, 0);
    return {
      voidZ: renderer._visibleAnchorZ(voidNote, state, speed),
      tapZ: renderer._visibleAnchorZ(tapNote, state, speed),
    };
  });
  assert.ok(anchors[0].voidZ < anchors[0].tapZ, 'initial anchor is the near void head');
  assert.ok(anchors[1].voidZ > anchors[1].tapZ, 'tail enters the guard and flips the old sort order');

  const drawOrder = [];
  renderer._drawGround = () => drawOrder.push('ground');
  renderer._drawRegions = () => drawOrder.push('regions');
  renderer._drawMeasureLines = () => drawOrder.push('measures');
  renderer._drawJudgementLine = () => drawOrder.push('judgement');
  renderer._drawOnibi = () => drawOrder.push('onibi');
  renderer._drawVoid = (_ctx, note) => drawOrder.push(note.key);
  // Keep dispatch real: if a void is accidentally redrawn by _drawNote, the count doubles.
  const drawNote = renderer._drawNote.bind(renderer);
  renderer._drawNote = (...args) => {
    if (args[1].kind !== 3) drawOrder.push(args[1].key);
    return drawNote(...args);
  };
  for (const t of frames) {
    drawOrder.length = 0;
    renderer.render(t);
    assert.deepEqual(drawOrder.slice(0, 5), ['ground', 'regions', 'void', 'measures', 'judgement']);
    assert.ok(!drawOrder.includes('onibi'), 'viewer has no player marker');
    for (const id of ['void', 'tap', 'slide', 'bullet', 'dash']) {
      assert.equal(drawOrder.filter((drawn) => drawn === id).length, 1, `${id} draws exactly once at t=${t}`);
      if (id !== 'void') assert.ok(drawOrder.indexOf('void') < drawOrder.indexOf(id), `${id} stays above void`);
    }
  }
});

test('REGRESSION: moving void to the underlay preserves selected and hovered void overlays', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeOverlapFixture());
  const calls = [];
  renderer._drawVoid = (_ctx, note) => calls.push({ id: note.key, kind: 'body' });
  renderer._drawHighlight = (_ctx, note, _z, _stateAt, _speed, selected) => calls.push({ id: note.key, kind: 'highlight', selected });
  for (const [options, selected] of [
    [{ selectedId: 'void', hoverId: 'void' }, true],
    [{ selectedId: null, hoverId: 'void' }, false],
  ]) {
    calls.length = 0;
    renderer.render(10.03, { ...options, overlays: false });
    assert.deepEqual(calls, [
      { id: 'void', kind: 'body' },
      { id: 'void', kind: 'highlight', selected },
    ], 'body draws once with overlays disabled, highlight remains above it and selection wins over hover');
  }
});

test('REGRESSION: additive void fill and rails restore compositing before later layers', () => {
  const { canvas, ctx, calls } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeOverlapFixture());
  const note = renderer.notes.find((n) => n.key === 'void');
  const speed = renderer.baseScrollSpeed(1);
  const state = renderer.chart.positionAt(10.03, 0);
  // A non-default caller state detects restoration, not merely an unconditional reset.
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.6;
  renderer._drawVoid(ctx, note, renderer._visibleAnchorZ(note, state, speed), () => state, speed);
  const paintCalls = calls.filter((c) => c.name === 'fill' || c.name === 'stroke');
  assert.ok(paintCalls.some((c) => c.name === 'fill'), 'real clipped void body paints');
  assert.ok(paintCalls.some((c) => c.name === 'stroke'), 'real clipped rails paint');
  assert.ok(paintCalls.every((c) => c.composite === 'lighter'), 'body and rails use additive blending, not opaque source-over');
  assert.equal(ctx.globalCompositeOperation, 'screen', 'restores caller composite');
  assert.equal(ctx.globalAlpha, 0.6, 'restores caller alpha');

  const laterComposites = [];
  renderer._drawMeasureLines = () => laterComposites.push(ctx.globalCompositeOperation);
  const drawNote = renderer._drawNote.bind(renderer);
  renderer._drawNote = (...args) => {
    laterComposites.push(ctx.globalCompositeOperation);
    return drawNote(...args);
  };
  renderer.render(10.03, { overlays: false });
  assert.equal(laterComposites.length, 5, 'measures and four ordinary notes are checked');
  assert.ok(laterComposites.every((value) => value === 'source-over'), 'additive state does not leak into later layers');
  assert.equal(ctx.globalCompositeOperation, 'source-over', 'frame ends with default compositing');
});

// ---------------------------------------------------------------------------------------
// Conductor resolution
// ---------------------------------------------------------------------------------------

test('conductor functions are resolved from the compiled object, not compiled.chart', () => {
  const { canvas } = makeCanvas();
  const fixture = makeFixture();
  assert.equal(typeof fixture.chart.positionAt, 'undefined', 'the parsed chart carries no functions');
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(fixture);
  assert.equal(renderer.chart.hasConductorPosition, true, 'conductors were found on `compiled`');
  assert.equal(renderer.chart.positionAt(2), 8, 'positionAt is the conductor function (t*4)');
  assert.equal(renderer.chart.timeAt(4), 2, 'timeAt is the conductor function (beat/2)');
  assert.equal(renderer.chart.beatAt(2), 4, 'beatAt is the conductor inverse');
  assert.equal(renderer.chart.secondsPerBeat, 0.5, 'secondsPerBeat came from the compiled object');
});

test('a caller without positionAt degrades safely instead of fabricating a desync', () => {
  // Degenerate case: no conductor position function at all. There is no way to define a correct
  // field depth, so the renderer must at least stay finite, keep the placeholder state in sync
  // with the note positions (no spurious drift warnings), and never produce NaN geometry.
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeFixture({ includePositionAt: false }));
  assert.equal(renderer.chart.hasConductorPosition, false, 'no conductor position was found');
  assert.equal(renderer.timingWarnings.length, 0, 'no false drift warnings for the placeholder');
  const speed = renderer.baseScrollSpeed(1);
  for (const note of renderer.notes) {
    const state = renderer.chart.positionAt(note.first.time, note.group);
    assert.ok(Number.isFinite(state), `${note.key} state is finite`);
    const z = (note.first.position - state) * note.scrollMod * speed * SCROLL.positionMultiplier;
    assert.ok(Number.isFinite(z), `${note.key} Z is finite`);
    const quad = renderer._tapQuad(note.first, note.pathAngle, z, 0);
    if (quad) {
      for (const p of quad) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${note.key} projects to finite pixels`);
      }
    }
  }
  // Rendering must not throw in this degraded mode either.
  renderer.render(5, { scrollSpeed: 1 });
});

test('a desynchronized compiled position is reported instead of silently freezing notes', () => {
  const { canvas } = makeCanvas();
  const fixture = makeFixture();
  // Break one point's stored position so it can never satisfy positionAt at its own time.
  fixture.notes[1].points[0].position += 3;
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(fixture);
  assert.ok(renderer.timingWarnings.length >= 1, 'the drift is recorded');
  const warning = renderer.timingWarnings.find((w) => w.id === 'n1');
  assert.ok(warning, 'the offending note id is reported');
  assert.ok(Math.abs(warning.drift - 3) < 1e-9, `drift magnitude is reported (${warning.drift})`);
});

// ---------------------------------------------------------------------------------------
// Supporting behaviour that the fix depends on
// ---------------------------------------------------------------------------------------

test('render() and pick() advance the same per-group state', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeFixture());
  const note = renderer.notes.find((n) => n.key === 'n1');
  renderer.render(note.first.time, { scrollSpeed: 1 });
  const quad = renderer._tapQuad(note.first, note.pathAngle, 0, 0);
  const cx = quad.reduce((sum, p) => sum + p.x, 0) / 4;
  const cy = quad.reduce((sum, p) => sum + p.y, 0) / 4;
  assert.equal(renderer.pick(cx, cy), 'n1', 'picking agrees with the on-line render');
});

// ---------------------------------------------------------------------------------------
// Combined slide outline (render option `showOverlappingSlides`, default false)
// ---------------------------------------------------------------------------------------

/** Shoelace area of a screen polygon (px^2); zero means a degenerate body. */
function polygonArea(poly) {
  let area = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    area += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return Math.abs(area) / 2;
}

/**
 * Two multi-interval curved slides that are BOTH genuinely on the field and overlapping in the
 * sampled window.
 *
 * Lanes are the chart's own 0..11 lanes (the fixture maps lane L to left = L - 6, so lane 6 is the
 * track centre); the values below stay inside the 2.5-unit track instead of the out-of-field lanes
 * an earlier revision used. Beats are compact (.125 steps => .25 position steps => 1.0 world-Z per
 * interval, far inside the shader Z span) and the two slides are offset by half a step so they
 * cross. Curvature comes from independent left/right easings: PathAngle alone would only ROTATE a
 * straight body.
 */
function makeOverlappingSlidesFixture() {
  const curveLeft = (t) => t * t;
  const curveRight = (t) => 1 - (1 - t) * (1 - t);
  return makeFixture({ notes: [
    { id: 'A', type: 1, beat: 20, lanes: [1, 5], extra: [{ beat: 20.125, lanes: [2, 6] }, { beat: 20.25, lanes: [3, 7] }], curveLeft, curveRight },
    { id: 'B', type: 1, beat: 20.025, lanes: [3, 7], extra: [{ beat: 20.15, lanes: [4, 8] }, { beat: 20.275, lanes: [5, 9] }], curveLeft, curveRight },
    { id: 'V', type: 3, beat: 19.5, lanes: [7, 10], extra: { beat: 21, lanes: [7, 10] } },
    { id: 'T', type: 0, beat: 20.1, lanes: [8, 8] },
  ] });
}

/**
 * A straight multi-interval slide whose frame puts BOTH intervals fully on the field with real
 * area, so the interior join is a genuine on-screen seam rather than a clamped zero-area strip.
 * At t=10.02 the three points sit at visual Z -0.08 / 0.92 / 1.92.
 */
function makeStraightSlideFixture() {
  return makeFixture({ notes: [
    { id: 'S', type: 1, beat: 20, lanes: [3, 7], extra: [{ beat: 20.125, lanes: [3, 7] }, { beat: 20.25, lanes: [3, 7] }] },
  ] });
}

/** Sampled window in which both overlap-fixture slides have every interval on the field. */
const OVERLAP_SLIDE_TIMES = [9.99, 9.995, 10.0, 10.01, 10.02, 10.03, 10.04, 10.05];
/** Frame used for the interior-join seam check. */
const OVERLAP_SLIDE_TIME = 10.02;

/** Record every stroked piece the renderer's own rule emitted. */
function captureOutline(renderer) {
  const pieces = [];
  const shared = { a: null, b: null };
  const original = PlayfieldRenderer.prototype._drawEdgePieces;
  const fake = {
    lineWidth: 1,
    strokeStyle: '',
    beginPath() {},
    stroke() {},
    moveTo(x, y) { shared.a = { x, y }; shared.b = null; },
    lineTo(x, y) {
      shared.b = { x, y };
      if (shared.a) pieces.push({ a: shared.a, b: shared.b });
      shared.a = shared.b;
    },
  };
  renderer._drawEdgePieces = function patched(ctx, edges, clip) {
    if (!clip) return undefined;
    return original.call(this, fake, edges, clip);
  };
  return pieces;
}

/** Every candidate closed ring of a slide's own geometry (body intervals plus tap quads). */
function boundaryRings(renderer, note, state, speed) {
  const geometry = renderer._collectSlideGeometry(note, 0, () => state, speed);
  if (!geometry) return [];
  return geometry.rings.map((ring) => ring.poly);
}

/**
 * Record every fill() the renderer issues, as a list of closed subpaths. Replaces the render
 * context wholesale, so nothing downstream needs a mutable ctx proxy and the recorded paths are
 * exactly what the renderer handed to fill().
 */
function captureFills(renderer) {
  const fills = [];
  let path = [];
  let current = null;
  const ctx = {
    canvas: { width: 840, height: 491 },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save() {}, restore() {},
    beginPath() { path = []; current = null; },
    closePath() {},
    moveTo(x, y) { current = { x, y }; path.push(current); },
    lineTo(x, y) { current = { x, y }; path.push(current); },
    fill() { fills.push(path.slice()); },
    stroke() {},
    fillRect() {},
    drawImage() {},
    arc() {},
    setTransform() {},
    transform() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  renderer.ctx = ctx;
  return fills;
}

/** A vertical ray test; it is exact for the non-vertical rail edges these fixtures produce. */
function insideRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if ((a.y > y) !== (b.y > y)) {
      const xCross = a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (x < xCross) inside = !inside;
    }
  }
  return inside;
}

test('clean mode never takes the legacy per-interval stroke path', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeStraightSlideFixture());
  const note = renderer.notes.find((n) => n.key === 'S');
  // Record every _drawSegmentBody call and whether it was asked to suppress its own stroke.
  const calls = [];
  const original = PlayfieldRenderer.prototype._drawSegmentBody;
  renderer._drawSegmentBody = function patched(ctx, a, b, zA, zB, easeL, easeR, colors, isVoid, pathAngle, clip) {
    calls.push({ clip: !!clip, isVoid: !!isVoid });
    return original.call(this, ctx, a, b, zA, zB, easeL, easeR, colors, isVoid, pathAngle, clip);
  };

  // A plain frame, a frame that takes the non-simple fallback, and a head-only frame: none of them
  // may reach the legacy stroke path, because that would draw an interior edge in combined mode.
  const forceNonSimple = PlayfieldRenderer.prototype._collectSlideGeometry;
  renderer._collectSlideGeometry = function patchedCollect(n, z, stateAt, speed) {
    const geometry = forceNonSimple.call(this, n, z, stateAt, speed);
    if (geometry && n === note && geometry.bodyPolys.length) {
      const poly = geometry.bodyPolys[0].poly;
      const crossed = [poly[0], poly[1], poly[3], poly[2]];
      poly.length = 0;
      for (const v of crossed) poly.push(v);
    }
    return geometry;
  };

  for (const t of [OVERLAP_SLIDE_TIME, 10.0, 10.05]) {
    calls.length = 0;
    renderer.render(t, { overlays: false });
    const legacyCalls = calls.filter((c) => c.isVoid === false && c.clip === false);
    assert.equal(legacyCalls.length, 0, `t=${t}: clean mode never strokes an interval's own edge`);
  }

  // Legacy mode must still take it, or the option would be meaningless.
  calls.length = 0;
  renderer.render(OVERLAP_SLIDE_TIME, { overlays: false, showOverlappingSlides: true });
  assert.ok(calls.some((c) => c.isVoid === false && c.clip === false), 'legacy mode still strokes each interval');
});

test('clean mode fills a multi-interval slide body as ONE compound fill', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeStraightSlideFixture());
  const note = renderer.notes.find((n) => n.key === 'S');
  const speed = renderer.baseScrollSpeed(1);
  const t = OVERLAP_SLIDE_TIME;
  const state = renderer.chart.positionAt(t, 0);
  const geometry = renderer._collectSlideGeometry(note, 0, () => state, speed);
  assert.equal(geometry.bodyPolys.length, 2, 'two body intervals in this frame');

  const fills = captureFills(renderer);
  renderer.render(t, { overlays: false });

  // A lane-constant interval projects to its minimal silhouette: a 4-point quad (2 samples per
  // rail because no lane edge moves). The fixture's two intervals therefore give one fill holding
  // exactly 8 vertices. Two separate interval fills would instead show two 4-vertex fills.
  const bodyFills = new Map();
  for (const p of fills) bodyFills.set(p.length, (bodyFills.get(p.length) || 0) + 1);
  const eight = fills.filter((p) => p.length === 8);
  assert.equal(eight.length, 1, `the body is ONE compound fill of both rings (fills by size: ${JSON.stringify([...bodyFills])})`);
  const fours = fills.filter((p) => p.length === 4).length;
  assert.ok(fours >= 2, `the intervals exist as geometry, so the single 8-vertex fill is the merge (${fours} quads total)`);

  assert.deepEqual(geometry.bodyPolys.map((e) => e.poly.length), [4, 4], 'each interval ring is a 4-point silhouette');

  // The compound path must contain BOTH cached rings' points (as one 8-vertex path), normalized to
  // a consistent sign so overlapping intervals add winding instead of cancelling.
  const traced = eight[0];
  for (const entry of geometry.bodyPolys) {
    for (const v of entry.poly) {
      const found = traced.some((w) => Math.abs(w.x - v.x) < 1e-9 && Math.abs(w.y - v.y) < 1e-9);
      assert.ok(found, `compound path contains the cached ring vertex (${v.x.toFixed(1)},${v.y.toFixed(1)})`);
    }
  }
  const firstHalf = traced.slice(0, 4);
  const secondHalf = traced.slice(4);
  assert.ok(ringSignedArea(firstHalf) > 0, `ring 1 is normalized positive (${ringSignedArea(firstHalf).toFixed(0)})`);
  assert.ok(ringSignedArea(secondHalf) > 0, `ring 2 is normalized positive (${ringSignedArea(secondHalf).toFixed(0)})`);

  // The crack was the shared cross-section between the intervals. Because the body is ONE fill, the
  // rasterizer resolves that interior edge once, and the two subpaths' interior coverage combines
  // instead of compositing twice: both rings must contain the join, which is what makes the union
  // interior solid.
  const a = geometry.runs[0].tail.a;
  const b = geometry.runs[0].tail.b;
  const joinMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  assert.ok(insideRing(joinMid.x, joinMid.y, firstHalf), 'join midpoint is inside ring 1');
  // The join is ring 2's TAIL edge, so the exact midpoint lies ON its boundary: probe one pixel
  // toward ring 2's interior (away from the join, i.e. toward the other end of its y span).
  const ring2Y = secondHalf.map((v) => v.y);
  const ring2MinY = Math.min(...ring2Y);
  const ring2MaxY = Math.max(...ring2Y);
  const away = Math.abs(joinMid.y - ring2MinY) < Math.abs(joinMid.y - ring2MaxY) ? 1 : -1;
  assert.ok(
    insideRing(joinMid.x, joinMid.y + away, secondHalf),
    `one pixel into ring 2 from the shared cross-section is inside (y ${joinMid.y.toFixed(1)} -> ${(joinMid.y + away).toFixed(1)}, ring y ${ring2MinY.toFixed(1)}..${ring2MaxY.toFixed(1)})`,
  );
  // The join edge sits exactly on both rings, so both subpaths reach it — the shared edge exists in
  // the path (one fill, two subpaths), and it is the rasterizer that unifies it.
  const joinOnBoth = [firstHalf, secondHalf].every((ring) => ring.some((v) => Math.abs(v.y - joinMid.y) < 1e-9));
  assert.ok(joinOnBoth, 'both rings reach the shared cross-section');
});

test('legacy mode still fills one path per interval', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeStraightSlideFixture());
  const fills = captureFills(renderer);
  renderer.render(OVERLAP_SLIDE_TIME, { overlays: false, showOverlappingSlides: true });
  const fours = fills.filter((p) => p.length === 4);
  assert.ok(fours.length >= 2, `legacy keeps a separate fill per interval (${fours.length} quads)`);
  assert.equal(fills.filter((p) => p.length === 8).length, 0, 'legacy never merges the intervals');
});

test('a self-crossing body takes the per-interval fallback, never the compound fill', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeStraightSlideFixture());
  const note = renderer.notes.find((n) => n.key === 'S');
  // Force ONE body ring to be non-simple (a bowtie) as the frame is collected, so the real gate
  // sees it. Reordering a quad's vertices into a crossing order (0,1,3,2) makes the diagonals the
  // edges; the same four points now bound a self-intersecting ring.
  const original = PlayfieldRenderer.prototype._collectSlideGeometry;
  renderer._collectSlideGeometry = function patched(n, z, stateAt, speed) {
    const geometry = original.call(this, n, z, stateAt, speed);
    if (geometry && n === note && geometry.bodyPolys.length) {
      const poly = geometry.bodyPolys[0].poly;
      const crossed = [poly[0], poly[1], poly[3], poly[2]];
      assert.equal(ringIsSimple(crossed), false, 'the perturbed ring is self-crossing');
      poly.length = 0;
      for (const v of crossed) poly.push(v);
    }
    return geometry;
  };
  const fills = captureFills(renderer);
  renderer.render(OVERLAP_SLIDE_TIME, { overlays: false });
  assert.equal(fills.filter((p) => p.length === 8).length, 0, 'the self-crossing note never merges into one 8-vertex fill');
  const quads = fills.filter((p) => p.length === 4);
  assert.ok(quads.length >= 2, `it fills each cached interval separately instead (${quads.length} quads)`);
});

test('segmentsIntersect decides near-parallel crossings far from P0 in pixel units', () => {
  // The counterexample that exposed the unit bug: a very shallow crossing whose intersection with
  // P sits at 1000px along P, far beyond the 1px the projected coordinate used to be compared to.
  const P0 = { x: 0, y: 0 };
  const P1 = { x: 1000, y: 0 };
  const Q0 = { x: 500, y: 0.00025 };
  const Q1 = { x: 1500, y: -0.00025 };
  assert.equal(segmentsIntersect(P0, P1, Q0, Q1, 1e-6), true, 'a shallow crossing at 1000px must be found');

  // Same shape at a tiny scale, so every projected coordinate is below 1px: the old comparison
  // answered this by accident, the corrected code answers it by construction.
  assert.equal(
    segmentsIntersect({ x: 0, y: 0 }, { x: 0.8, y: 0 }, { x: 0.4, y: 0.0002 }, { x: 1.2, y: -0.0002 }, 1e-6),
    true,
    'a short shallow crossing is found too',
  );

  // Parallel and genuinely offset by more than eps: proved separation, so NOT an intersection.
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 10, y: 5 }, { x: 90, y: 5 }, 1e-6), false, 'parallel offset is separated');
  // Collinear but disjoint spans: separated along the segment's own length.
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 300, y: 0 }, 1e-6), false, 'collinear disjoint spans are separated');
  // Collinear and overlapping: an intersection, which is what makes a self-overlapping ring simple=false.
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 0 }, { x: 150, y: 0 }, 1e-6), true, 'collinear overlap is an intersection');
  // Collinear, touching only at their shared endpoint.
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, 1e-6), true, 'a shared endpoint counts as touching');
  // A plain perpendicular crossing, decided by the exact t/u branch.
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: -10 }, { x: 50, y: 10 }, 1e-6), true, 'a perpendicular crossing is found');
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 150, y: -10 }, { x: 150, y: 10 }, 1e-6), false, 'a perpendicular miss is rejected');
});

test('a shallow crossing far along a long edge makes a ring non-simple', () => {
  // Ring-level adversarial case: the ring's bottom edge is 1000px long and a thin spike crosses it
  // ~800px from that edge's start, far beyond 1 projected pixel.
  const ring = [
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 800, y: 0.0004 },
    { x: 900, y: -40 },
  ];
  assert.equal(ringIsSimple(ring), false, 'the shallow crossing is detected, so the ring is not simple');
});

test('ringSignedArea reports orientation and ringIsSimple rejects every self-touch', () => {
  // Screen space has y pointing DOWN. This ring goes left edge down, along the bottom, back up the
  // right edge: visually clockwise, and its shoelace sum is positive.
  const positive = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }];
  const negative = [...positive].reverse();
  assert.ok(ringSignedArea(positive) > 0, 'positive shoelace ring reports positive area');
  assert.ok(ringSignedArea(negative) < 0, 'the reversed ring reports negative area');
  assert.ok(Math.abs(ringSignedArea(positive) - 100) < 1e-9, 'area magnitude is 100px^2');
  assert.ok(ringSignedArea([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]) === 0, 'degenerate ring has zero area');

  // A ring with the positive sign is exactly a ring whose interior points have winding +1 per
  // windingNumber: the two helpers must agree on sign, or normalization would pick the wrong side.
  assert.equal(windingNumber(5, 5, positive), 1, 'windingNumber agrees the positive ring counts +1');
  assert.equal(windingNumber(5, 5, negative), -1, 'and the reversed ring counts -1');

  assert.equal(ringIsSimple(positive), true, 'a convex ring is simple');
  assert.equal(ringIsSimple([...positive, positive[0]]), true, 'a repeated closing vertex is still simple');
  assert.equal(ringIsSimple([positive[0], positive[1]]), false, 'two points are not simple');
  assert.equal(ringIsSimple([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]), false, 'collinear zero-area ring');
  assert.equal(ringIsSimple([{ x: 0, y: 0 }, { x: 1, y: NaN }, { x: 2, y: 0 }]), false, 'non-finite point');

  // A bowtie crosses itself.
  const bowtie = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  assert.equal(ringIsSimple(bowtie), false, 'a bowtie is self-crossing');

  // A non-adjacent edge lying exactly ON another edge (collinear overlap) is not simple.
  const overlap = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 10 }, { x: 5, y: 0 }, { x: 0, y: 10 }];
  assert.equal(ringIsSimple(overlap), false, 'collinear overlap is rejected');

  // A vertex exactly on a non-adjacent edge is rejected too.
  const vertexOnEdge = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 0 }];
  assert.equal(ringIsSimple(vertexOnEdge), false, 'vertex-on-edge is rejected');
});

test('DEFAULT render uses the combined slide outline, and true selects the legacy outline', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeOverlappingSlidesFixture());
  const seen = [];
  const original = PlayfieldRenderer.prototype._drawEdgePieces;
  renderer._drawEdgePieces = function patched(ctx, edges, clip) {
    seen.push({ edges: edges.length, hasClip: !!clip });
    return original.call(this, ctx, edges, clip);
  };
  // Default: no option at all.
  renderer.render(OVERLAP_SLIDE_TIME, { overlays: false });
  assert.ok(seen.length > 0, 'the combined outline runs by default');
  assert.ok(seen.every((entry) => entry.hasClip), 'default mode has a union clip context');
  // Explicit false is the same default.
  seen.length = 0;
  renderer.render(OVERLAP_SLIDE_TIME, { overlays: false, showOverlappingSlides: false });
  assert.ok(seen.length > 0 && seen.every((entry) => entry.hasClip), 'false is the combined outline');
  // Explicit true is the legacy per-object outline: the union pass must not run at all.
  seen.length = 0;
  renderer.render(OVERLAP_SLIDE_TIME, { overlays: false, showOverlappingSlides: true });
  assert.equal(seen.length, 0, 'true keeps the legacy per-object outline');
});

test('the combined outline never paints an interior interval join', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeStraightSlideFixture());
  const note = renderer.notes.find((n) => n.key === 'S');
  const speed = renderer.baseScrollSpeed(1);
  const t = 10.02;
  const state = renderer.chart.positionAt(t, 0);
  const geometry = renderer._collectSlideGeometry(note, 0, () => state, speed);
  assert.equal(geometry.bodyPolys.length, 2, 'two drawable intervals');
  assert.ok(geometry.bodyPolys.every((entry) => polygonArea(entry.poly) > 100), 'both intervals have real area');

  // The interior join is the transverse cap between interval 0's tail and interval 1's head.
  const run = geometry.runs[0];
  const a = run.left[run.left.length - 1];
  const b = run.right[run.right.length - 1];
  const joinMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const joinLen = Math.hypot(b.x - a.x, b.y - a.y);
  assert.ok(joinLen > 50, `the join is a real on-screen cross-section (${joinLen.toFixed(1)}px)`);

  const pieces = captureOutline(renderer);
  renderer.render(t, { overlays: false });
  // Nothing may be painted strictly BETWEEN the two rail corners along that cross-section.
  const transverse = pieces.filter((piece) => {
    if (!piece.b) return false;
    const pmx = (piece.a.x + piece.b.x) / 2;
    const pmy = (piece.a.y + piece.b.y) / 2;
    const along = Math.abs(pmx - a.x) / Math.max(1e-6, b.x - a.x);
    const nearLine = distToSegment(pmx, pmy, a.x, a.y, b.x, b.y) < 1.5;
    if (!nearLine) return false;
    const nearCorner = Math.hypot(pmx - a.x, pmy - a.y) < 2 || Math.hypot(pmx - b.x, pmy - b.y) < 2;
    return !nearCorner && along > 0.05 && along < 0.95;
  });
  assert.equal(transverse.length, 0, 'no stroke sits on the interior join between the rails');
  void joinMid;
});

test('the combined outline covers the whole union boundary of overlapping curved slides', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeOverlappingSlidesFixture());
  const speed = renderer.baseScrollSpeed(1);
  let boundaryEdgesChecked = 0;

  for (const t of OVERLAP_SLIDE_TIMES) {
    const state = renderer.chart.positionAt(t, 0);
    const slides = renderer.notes.filter((n) => n.kind === 1 && renderer._visibleAnchorZ(n, state, speed) !== null);
    assert.ok(slides.length >= 2, `both slides are visible at t=${t}`);
    const geoms = slides.map((note) => renderer._collectSlideGeometry(note, 0, () => state, speed));
    // Guard against a degenerate fixture: both notes must have real, on-screen bodies.
    for (const geometry of geoms) {
      assert.ok(geometry && geometry.bodyPolys.length >= 1, 'each slide has a body on the field');
      const totalArea = geometry.bodyPolys.reduce((sum, entry) => sum + polygonArea(entry.poly), 0);
      assert.ok(totalArea > 5, `body area is non-degenerate (${totalArea.toFixed(1)}px^2)`);
    }
    const rings = geoms.flatMap((geometry) => geometry.rings.map((ring) => ring.poly));
    const membership = makeMembership(geoms.flatMap((geometry) => geometry.polys));

    const pieces = captureOutline(renderer);
    renderer.render(t, { overlays: false });
    assert.ok(pieces.length > 0, `the outline is painted at t=${t}`);

    // Every union boundary edge must have a painted piece within a few pixels of its midpoint.
    for (const ring of rings) {
      const closed = ring.length > 2;
      const segCount = closed ? ring.length : ring.length - 1;
      for (let k = 0; k < segCount; k += 1) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        if (!a || !b) continue;
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        // Only geometry that can actually be seen matters: the shader Z span legitimately projects
        // some cross-sections below the canvas (near-plane strip), where no stroke is expected.
        const onCanvas =
          Math.min(a.x, b.x) < canvas.clientWidth && Math.max(a.x, b.x) > 0 &&
          Math.min(a.y, b.y) < canvas.clientHeight && Math.max(a.y, b.y) > 0;
        if (!onCanvas) continue;
        // An edge that is itself interior to the union is legitimately suppressed and needs no ink.
        if (membership(mx, my)) continue;
        boundaryEdgesChecked += 1;
        let nearest = Infinity;
        for (const piece of pieces) {
          if (!piece.b) continue;
          nearest = Math.min(nearest, distToSegment(mx, my, piece.a.x, piece.a.y, piece.b.x, piece.b.y));
        }
        assert.ok(
          nearest <= 8,
          `t=${t}: boundary edge (${mx.toFixed(0)},${my.toFixed(0)}) is covered (nearest stroke ${nearest.toFixed(1)}px)`,
        );
      }
    }
  }
  assert.ok(boundaryEdgesChecked > 100, `real on-canvas boundary edges were checked (${boundaryEdgesChecked})`);
});

test('the combined outline draws no stroke that is interior to the union', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeOverlappingSlidesFixture());
  const speed = renderer.baseScrollSpeed(1);
  let checked = 0;
  for (const t of OVERLAP_SLIDE_TIMES) {
    const state = renderer.chart.positionAt(t, 0);
    const slides = renderer.notes.filter((n) => n.kind === 1 && renderer._visibleAnchorZ(n, state, speed) !== null);
    const geoms = slides.map((n) => renderer._collectSlideGeometry(n, 0, () => state, speed));
    assert.ok(geoms.length >= 2 && geoms.every((g) => g && g.bodyPolys.length >= 1), 'non-degenerate fixture');
    const membership = makeMembership(geoms.flatMap((geometry) => geometry.polys));
    const pieces = captureOutline(renderer);
    renderer.render(t, { overlays: false });
    for (const piece of pieces) {
      if (!piece.b) continue;
      const rx = piece.b.x - piece.a.x;
      const ry = piece.b.y - piece.a.y;
      const len = Math.hypot(rx, ry);
      if (!(len > 0)) continue;
      const nx = -ry / len;
      const ny = rx / len;
      const mx = (piece.a.x + piece.b.x) / 2;
      const my = (piece.a.y + piece.b.y) / 2;
      let interior = true;
      for (const d of [1e-3, 0.5, 2]) {
        if (!membership(mx + nx * d, my + ny * d) || !membership(mx - nx * d, my - ny * d)) {
          interior = false;
          break;
        }
      }
      checked += 1;
      assert.equal(
        interior,
        false,
        `t=${t}: piece (${mx.toFixed(0)},${my.toFixed(0)}) is not interior to the union`,
      );
    }
  }
  assert.ok(checked > 100, `a meaningful number of stroke pieces was checked (${checked})`);
});

test('the combined outline leaves the void path and every other layer untouched', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeOverlappingSlidesFixture());
  const voidNote = renderer.notes.find((n) => n.key === 'V');
  const speed = renderer.baseScrollSpeed(1);
  const state = renderer.chart.positionAt(10.0, 0);
  const z = renderer._visibleAnchorZ(voidNote, state, speed);

  const captureVoid = () => {
    const seen = [];
    const original = renderer._fillVoidBodyClipped.bind(renderer);
    renderer._fillVoidBodyClipped = (ctx, cells, leftRail, rightRail) => {
      seen.push(JSON.stringify({ cells, leftRail, rightRail }));
      return original(ctx, cells, leftRail, rightRail);
    };
    renderer.render(10.0, { overlays: false, showOverlappingSlides: options.showOverlappingSlides });
    renderer._fillVoidBodyClipped = original;
    return seen;
  };

  const options = { showOverlappingSlides: false };
  const clean = captureVoid();
  options.showOverlappingSlides = true;
  const legacy = captureVoid();
  assert.ok(clean.length > 0, 'the void body is drawn in clean mode');
  assert.deepEqual(clean, legacy, 'void cells and rails are identical in both modes');
  void z;
});

test('slide tails keep drawing in combined-outline mode after the head passes the camera', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeFixture({
    notes: [{ id: 'slide1', type: 1, beat: 20, lanes: [0, 1], extra: { beat: 60, lanes: [4, 5] } }],
  }));
  const note = renderer.notes[0];
  const speed = renderer.baseScrollSpeed(1);
  const state = note.last.position - 5 / (speed * SCROLL.positionMultiplier);
  const t = state / 4;
  const zHead = (note.first.position - state) * speed * SCROLL.positionMultiplier;
  assert.ok(zHead < CULL.back, 'the head is behind the guard');
  const pieces = captureOutline(renderer);
  renderer.render(t, { overlays: false });
  assert.ok(pieces.length > 0, 'the visible tail still strokes its exposed boundary');
  for (const piece of pieces) {
    assert.ok(piece.b, 'every recorded piece is a segment');
    for (const v of [piece.a, piece.b]) {
      assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y), 'no NaN/Infinity coordinates');
    }
  }
});

test('degenerate slides stay finite in combined-outline mode', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeFixture({ notes: [
    { id: 'zero-width', type: 1, beat: 20, lanes: [0, -1], extra: { beat: 23, lanes: [0, -1] } },
    { id: 'single', type: 1, beat: 10, lanes: [1, 1] },
    { id: 'self-fold', type: 1, beat: 21, lanes: [-4, 4], extra: [{ beat: 22, lanes: [4, -4] }, { beat: 23, lanes: [-4, 4] }] },
  ] }));
  const pieces = captureOutline(renderer);
  for (const t of [4.4, 5, 9.9, 10, 10.5, 10.9, 11, 11.5, 20]) {
    renderer.render(t, { overlays: false });
  }
  for (const piece of pieces) {
    if (!piece.b) continue;
    for (const v of [piece.a, piece.b]) {
      assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y), `finite coordinates at ${JSON.stringify(v)}`);
    }
  }
});

test('combined-outline mode does not throw at any sample over a full chart span', () => {
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeOverlappingSlidesFixture());
  for (let step = 0; step <= 40; step += 1) {
    const t = 8 + (step / 40) * 6;
    renderer.render(t, { scrollSpeed: 1 + (step % 3) * 0.25, overlays: step % 2 === 0 });
  }
});

// --- pure geometry helpers of the union rule -------------------------------------------

test('windingNumber matches the nonzero fill rule (inside positive, outside zero)', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.notEqual(windingNumber(5, 5, square), 0, 'centre is inside');
  assert.equal(windingNumber(-1, 5, square), 0, 'left of the square is outside');
  assert.equal(windingNumber(11, 5, square), 0, 'right of the square is outside');
  assert.equal(windingNumber(5, -1, square), 0, 'below the square is outside');
  assert.equal(windingNumber(5, 11, square), 0, 'above the square is outside');
  // Reversed winding is still "inside" under the nonzero rule (unlike even-odd).
  const reversed = [...square].reverse();
  assert.notEqual(windingNumber(5, 5, reversed), 0, 'reversed polygon is still filled');
});

test('makeMembership is the nonzero-winding union test with a bounding-box broad phase', () => {
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const membership = makeMembership([{ poly: square, bbox: polygonBounds(square) }]);
  assert.equal(membership(50, 50), true, 'well inside');
  assert.equal(membership(1, 1), true, 'near an edge is still inside');
  assert.equal(membership(50, -1), false, 'outside');
  assert.equal(membership(-1, 50), false, 'outside on the other axis');
  // Union of two disjoint squares: a point in either is inside.
  const other = [{ x: 200, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 300 }, { x: 200, y: 300 }];
  const union = makeMembership([
    { poly: square, bbox: polygonBounds(square) },
    { poly: other, bbox: polygonBounds(other) },
  ]);
  assert.equal(union(250, 250), true, 'inside the second polygon');
  assert.equal(union(150, 150), false, 'in the gap between them');
});

test('segmentPolygonParams reports collinear overlap endpoints, not just crossings', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  // The candidate edge runs along the square's BOTTOM edge and leaves it on both sides: the two
  // overlap endpoints (t=0.25 entering at x=0, t=0.75 leaving at x=10) must both be cut points.
  const params = segmentPolygonParams({ x: -5, y: 0 }, { x: 15, y: 0 }, square);
  assert.ok(params.some((t) => Math.abs(t - 0.25) < 1e-9), 'the overlap entry is a cut');
  assert.ok(params.some((t) => Math.abs(t - 0.75) < 1e-9), 'the overlap exit is a cut');
  // A segment PARALLEL to the bottom edge but one pixel below it crosses nothing at all.
  assert.deepEqual(segmentPolygonParams({ x: -5, y: -1 }, { x: 15, y: -1 }, square), []);
  // A segment parallel to the bottom edge but passing THROUGH the square is not collinear with it;
  // it crosses the two vertical edges and must still report exactly those crossings.
  const through = segmentPolygonParams({ x: -5, y: 1 }, { x: 15, y: 1 }, square);
  assert.equal(through.length, 2, 'two vertical-edge crossings, not treated as collinear');
  assert.ok(Math.abs(through[0] - 0.25) < 1e-9 && Math.abs(through[1] - 0.75) < 1e-9, 'at x=0 and x=10');
  // A pure crossing at mid-height is the same story.
  const cross = segmentPolygonParams({ x: -5, y: 5 }, { x: 15, y: 5 }, square);
  assert.equal(cross.length, 2, 'two crossings');
  assert.ok(Math.abs(cross[0] - 0.25) < 1e-9 && Math.abs(cross[1] - 0.75) < 1e-9, 'at the square edges');
});

test('clipEdgeToBoundary keeps only the union-boundary stretch of a candidate edge', () => {
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const squareEntry = { poly: square, bbox: polygonBounds(square) };
  const all = [squareEntry];
  const union = makeMembership(all);

  // An edge through the middle of the polygon is inside on both sides -> fully suppressed.
  const interior = clipEdgeToBoundary({ x: 0, y: 50 }, { x: 100, y: 50 }, all, union, 0.5);
  assert.equal(interior.length, 0, 'an interior edge is fully suppressed');

  // The polygon's own bottom edge has the outside below it -> kept along its length.
  const boundary = clipEdgeToBoundary({ x: 0, y: 0 }, { x: 100, y: 0 }, all, union, 0.5);
  const painted = boundary.reduce((sum, piece) => sum + Math.hypot(piece.b.x - piece.a.x, piece.b.y - piece.a.y), 0);
  assert.ok(painted > 99, `the boundary edge is painted along its length (${painted.toFixed(1)}px)`);

  // A rectangle covering x=40..60 makes the covered stretch of that bottom edge interior.
  const cover = [{ x: 40, y: -10 }, { x: 60, y: -10 }, { x: 60, y: 30 }, { x: 40, y: 30 }];
  const coverEntry = { poly: cover, bbox: polygonBounds(cover) };
  const both = [squareEntry, coverEntry];
  const coveredUnion = makeMembership(both);
  const clipped = clipEdgeToBoundary({ x: 0, y: 0 }, { x: 100, y: 0 }, both, coveredUnion, 0.5);
  const keptPainted = clipped.reduce((sum, piece) => sum + Math.hypot(piece.b.x - piece.a.x, piece.b.y - piece.a.y), 0);
  assert.ok(keptPainted > 70, `the exposed stretches are still painted (${keptPainted.toFixed(1)}px of 100)`);
  assert.ok(keptPainted < 90, `the covered stretch is not painted (${keptPainted.toFixed(1)}px)`);
  for (const piece of clipped) {
    const midX = (piece.a.x + piece.b.x) / 2;
    assert.ok(midX < 40 || midX > 60, `no kept piece sits inside the cover (mid x=${midX.toFixed(1)})`);
  }

  // A candidate edge LONGER than the polygon edge paints only the part that IS the union boundary:
  // x in 0..100, never the overhang outside the polygon.
  const overlong = clipEdgeToBoundary({ x: -20, y: 0 }, { x: 120, y: 0 }, all, union, 0.5);
  const overlongPainted = overlong.reduce((sum, piece) => sum + Math.hypot(piece.b.x - piece.a.x, piece.b.y - piece.a.y), 0);
  assert.ok(Math.abs(overlongPainted - 100) < 1, `exactly the union-boundary stretch is painted (${overlongPainted.toFixed(1)}px)`);
  for (const piece of overlong) {
    assert.ok(piece.a.x >= -1e-9 && piece.b.x <= 100 + 1e-9, `no overhang is painted (${piece.a.x.toFixed(1)}..${piece.b.x.toFixed(1)})`);
  }
});

test('clipEdgeToBoundary skips strictly disjoint polygons without reading them', () => {
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const squareEntry = { poly: square, bbox: polygonBounds(square) };
  const membership = makeMembership([squareEntry]);
  // A polygon whose bbox is far from the candidate segment. Reading its `poly` at all would be
  // wasted work, so the narrow-phase bbox test must reject it before segmentPolygonParams sees it.
  const poison = {
    bbox: { x0: 1000, y0: 1000, x1: 1100, y1: 1100 },
    get poly() { throw new Error('disjoint polygon must not be read'); },
  };
  const runs = clipEdgeToBoundary({ x: 0, y: 0 }, { x: 100, y: 0 }, [squareEntry, poison], membership, 0.5);
  const painted = runs.reduce((sum, piece) => sum + Math.hypot(piece.b.x - piece.a.x, piece.b.y - piece.a.y), 0);
  assert.ok(painted > 99, `the touching polygon still clips normally (${painted.toFixed(1)}px)`);

  // The ring's OWN polygon shares the segment's box exactly, so it must never be skipped.
  const own = { bbox: polygonBounds(square), get poly() { return square; } };
  const ownRuns = clipEdgeToBoundary({ x: 0, y: 0 }, { x: 100, y: 0 }, [own], membership, 0.5);
  assert.ok(ownRuns.length > 0, 'the own polygon is still visited');
  // A polygon whose bbox merely TOUCHES the segment box is visited too: collinear overlap
  // endpoints sit exactly on that boundary.
  const touching = {
    bbox: { x0: 0, y0: 0, x1: 100, y1: 0 },
    get poly() { return square; },
  };
  const touchingRuns = clipEdgeToBoundary({ x: 0, y: 0 }, { x: 100, y: 0 }, [touching], membership, 0.5);
  assert.ok(touchingRuns.length > 0, 'a bbox touching the segment box is not skipped');
});

test('a horizontal seam shared by two stacked rectangles is suppressed, outer edges kept', () => {
  // Two rectangles sharing the y=50 edge: the union is one tall rectangle, so the shared seam is
  // interior and must disappear while the four outer edges survive. Membership includes the ring's
  // own polygon — that is exactly what makes the seam read as inside on BOTH sides.
  const lower = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
  const upper = [{ x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const lowerEntry = { poly: lower, bbox: polygonBounds(lower) };
  const upperEntry = { poly: upper, bbox: polygonBounds(upper) };
  const both = [lowerEntry, upperEntry];
  const union = makeMembership(both);

  // Inward probe (y=49.999) is in the lower body, outward probe (y=50.001) is in the upper body.
  assert.equal(union(50, 49.999), true, 'the seam is inside the union from below');
  assert.equal(union(50, 50.001), true, 'the seam is inside the union from above');

  const seam = clipEdgeToBoundary({ x: 0, y: 50 }, { x: 100, y: 50 }, both, union, 0.05);
  assert.equal(seam.length, 0, 'the shared horizontal seam is not painted at all');

  for (const [name, a, b, wantMin] of [
    ['lower bottom', { x: 0, y: 0 }, { x: 100, y: 0 }, 99],
    ['upper top', { x: 0, y: 100 }, { x: 100, y: 100 }, 99],
    ['lower left', { x: 0, y: 0 }, { x: 0, y: 50 }, 49],
    ['upper left', { x: 0, y: 50 }, { x: 0, y: 100 }, 49],
    ['lower right', { x: 100, y: 0 }, { x: 100, y: 50 }, 49],
    ['upper right', { x: 100, y: 50 }, { x: 100, y: 100 }, 49],
  ]) {
    const pieces = clipEdgeToBoundary(a, b, both, union, 0.05);
    const painted = pieces.reduce((sum, piece) => sum + Math.hypot(piece.b.x - piece.a.x, piece.b.y - piece.a.y), 0);
    assert.ok(painted > wantMin, `${name} survives (${painted.toFixed(1)}px)`);
  }
});

test('overlapping rectangles keep only the true union boundary', () => {
  // A is the tall rectangle; B pokes in from the right over the lower half.
  const a = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const b = [{ x: 50, y: 20 }, { x: 150, y: 20 }, { x: 150, y: 60 }, { x: 50, y: 60 }];
  const aEntry = { poly: a, bbox: polygonBounds(a) };
  const bEntry = { poly: b, bbox: polygonBounds(b) };
  const both = [aEntry, bEntry];
  const union = makeMembership(both);

  // A's right edge: covered by B between y=20 and y=60, exposed elsewhere.
  const rightEdge = clipEdgeToBoundary({ x: 100, y: 0 }, { x: 100, y: 100 }, both, union, 0.05);
  const covered = rightEdge.filter((piece) => {
    const midY = (piece.a.y + piece.b.y) / 2;
    return midY > 20 && midY < 60;
  });
  assert.equal(covered.length, 0, "A's right edge is clipped away where B covers it");
  const exposed = rightEdge.reduce((sum, piece) => sum + Math.abs(piece.b.y - piece.a.y), 0);
  assert.ok(exposed > 55 && exposed < 65, `only the exposed stretch of A's right edge is painted (${exposed.toFixed(1)}px of 100)`);

  // B's left edge is entirely inside A -> nothing painted.
  const bLeft = clipEdgeToBoundary({ x: 50, y: 20 }, { x: 50, y: 60 }, both, union, 0.05);
  assert.equal(bLeft.length, 0, "B's left edge is interior to A");
  // B's top edge is outside A for x>100 only.
  const bTop = clipEdgeToBoundary({ x: 50, y: 20 }, { x: 150, y: 20 }, both, union, 0.05);
  const bTopPainted = bTop.reduce((sum, piece) => sum + Math.abs(piece.b.x - piece.a.x), 0);
  assert.ok(bTopPainted > 45 && bTopPainted < 55, `B's top edge survives only outside A (${bTopPainted.toFixed(1)}px of 100)`);
  for (const piece of bTop) {
    assert.ok((piece.a.x + piece.b.x) / 2 > 100, 'no kept piece is inside A');
  }
});

test('a head-only slide (no drawable interval) still strokes its tap boundary', () => {
  // A single-point slide, plus a frame where a two-point slide's only interval is culled while its
  // head tap is still visible. In clean mode the tap quad is the whole exposed outline.
  const { canvas } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeFixture({ notes: [
    { id: 'single', type: 1, beat: 20, lanes: [1, 3] },
  ] }));
  const note = renderer.notes[0];
  assert.equal(note.points.length, 1, 'single-point slide');
  const speed = renderer.baseScrollSpeed(1);

  // A time where the head is visible on the field.
  const t = note.first.time - 0.4;
  const state = renderer.chart.positionAt(t, 0);
  const zHead = (note.first.position - state) * speed * SCROLL.positionMultiplier;
  assert.ok(renderer._visible(zHead), 'the head tap is inside the cull guard');

  const geometry = renderer._collectSlideGeometry(note, 0, () => state, speed);
  assert.ok(geometry, 'a head-only slide still has geometry');
  assert.equal(geometry.bodyPolys.length, 0, 'no body interval is drawable');
  assert.ok(geometry.headQuad, 'the head tap quad is part of the geometry');
  assert.equal(geometry.rings.length, 1, 'the tap quad is the only candidate ring');

  const pieces = captureOutline(renderer);
  renderer.render(t, { overlays: false });
  assert.ok(pieces.length > 0, 'the head tap boundary is stroked end to end');
  // Its boundary is a closed quad: the total painted length must cover the four sides.
  const painted = pieces.reduce((sum, piece) => sum + Math.hypot(piece.b.x - piece.a.x, piece.b.y - piece.a.y), 0);
  const perimeter = geometry.headQuad.reduce((sum, point, i) => {
    const next = geometry.headQuad[(i + 1) % geometry.headQuad.length];
    return sum + Math.hypot(next.x - point.x, next.y - point.y);
  }, 0);
  assert.ok(
    painted >= perimeter - 2,
    `the whole tap perimeter is painted (${painted.toFixed(1)}px of ${perimeter.toFixed(1)}px)`,
  );
});

test('a full render in combined-outline mode emits only finite geometry', () => {
  const { canvas, calls } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeOverlappingSlidesFixture());
  for (const t of OVERLAP_SLIDE_TIMES) {
    calls.length = 0;
    renderer.render(t, { overlays: true });
    const coords = calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo').flatMap((c) => [c.args[0], c.args[1]]);
    assert.ok(coords.length > 0, `geometry is emitted at t=${t}`);
    assert.ok(coords.every((v) => Number.isFinite(v)), `all coordinates are finite at t=${t}`);
  }
});

test('the ground quad uses the camera axes, not a constant depth', () => {
  const { canvas } = makeCanvas(874, 491);
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeFixture());
  const axes = cameraAxesFromQuaternion(CAMERA_ROTATION);
  const groundY = TRACK.position[1];
  const depth = (z) => worldToCamera(0, groundY, z, { ...renderer.layout.camera, axes }).zc;
  assert.ok(depth(TRACK.farZ) > depth(TRACK.nearZ) * 5, 'ground depth varies strongly along Z');
  const quad = renderer._groundQuad();
  assert.ok(quad.farR.x - quad.farL.x < quad.nearR.x - quad.nearL.x, 'far edge is narrower');
  // Straight edges: X is a linear function of screen Y, so a mid scanline sits on the chord.
  const midY = (quad.farL.y + quad.nearL.y) / 2;
  const band = renderer._groundBoundary(quad, midY);
  const chord = quad.farL.x + (quad.nearL.x - quad.farL.x) * ((midY - quad.farL.y) / (quad.nearL.y - quad.farL.y));
  assert.ok(Math.abs(band.left.x - chord) < 1e-9, 'left edge is straight');
});

test('slide head is pickable and highlighted at its own depth, not the painter anchor', () => {
  const { canvas, calls } = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, { textureUrl: null });
  renderer.setChart(makeFixture());
  const slide = renderer.notes.find((n) => n.key === 'n4');
  // Find a time where the head is near the line and the tail is further up the field.
  const time = slide.first.time - 0.05;
  renderer.render(time, { scrollSpeed: 0.1 });
  const { speed, stateAt } = renderer._frameState();
  const zHead = renderer._zOf(slide.first, stateAt(0), speed, slide.scrollMod);
  const zTail = renderer._zOf(slide.last, stateAt(0), speed, slide.scrollMod);
  const anchor = renderer._visibleAnchorZ(slide, stateAt(0), speed);
  assert.ok(Math.abs(anchor - zHead) > 0.5, `anchor ${anchor} differs from head ${zHead} (tail ${zTail})`);

  const head = renderer._tapQuad(slide.first, slide.pathAngle, zHead, 0);
  const cx = head.reduce((s, p) => s + p.x, 0) / 4;
  const cy = head.reduce((s, p) => s + p.y, 0) / 4;
  assert.equal(renderer.pick(cx, cy), 'n4', 'clicking the drawn head selects the slide');

  // The selection outline's first ring is the head quad: it must sit on the drawn head.
  calls.length = 0;
  renderer._drawHighlight(renderer.ctx, slide, anchor, stateAt, speed, true);
  const move = calls.find((c) => c.name === 'moveTo');
  assert.ok(Math.abs(move.args[0] - head[0].x) < 0.5 && Math.abs(move.args[1] - head[0].y) < 0.5,
    'highlight head ring starts at the drawn head');
});
