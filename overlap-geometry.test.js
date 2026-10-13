/**
 * overlap-geometry.test.js — geometry contract for the synthetic overlapping-slide fixture used by
 * browser-check.mjs's real-canvas pixel comparison.
 *
 * Runs with the bundled Node test runner and no dependencies:
 *   node --test website_loader/overlap-geometry.test.js
 *
 * Why this exists: the browser check compares real canvas pixels, so a fixture whose junction is
 * off the field, whose intervals do not overlap, or whose intermediate point was not actually the
 * painted rail would make the pixel claims meaningless (or vacuously true). This test pins those
 * preconditions without a browser: the fixture's depths, containment, and on-screen projection.
 *
 * The fixture needs no `positionAt`/`timeAt`/`beatAt`: PlayfieldRenderer.setChart derives an
 * identity conductor when the compiled object carries none, which is the same fallback the
 * browser check relies on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {PlayfieldRenderer, CULL, SCROLL} from './renderer.js';

const TARGET_DEPTH = [1.6, 2.8, 4.8];
const PROBE_TIME = 8;
const FIRST_BPM = 200;
const USER_SPEED = 1.5;

/** A DOM-free canvas whose drawing methods are chainable no-ops (no pixels are read here). */
function makeCanvas(width = 840, height = 488) {
  const ctx = new Proxy({}, {
    get: (target, prop) => {
      if (prop in target) return target[prop];
      const fn = () => ctx;
      target[prop] = fn;
      return fn;
    },
    set: (target, prop, value) => {
      target[prop] = value;
      return true;
    },
  });
  const canvas = {
    width, height, clientWidth: width, clientHeight: height, style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({left: 0, top: 0, width, height}),
  };
  ctx.canvas = canvas;
  return {canvas, ctx};
}

/**
 * Build the fixture chart: a bare compiled object with the real point fields, then the point
 * POSITIONS are fitted from the speed the configured chart actually yields, because
 * `_zOf(point,state,speed) = (position - state) * scrollMod * speed * SCROLL.positionMultiplier`.
 * That makes z equal the requested depth at the probe time whatever the base speed is.
 */
function makeOverlapFixture(renderer) {
  const easeIn = (t) => t * t;
  const easeOut = (t) => 1 - (1 - t) * (1 - t);
  renderer.setChart({
    chart: {id: 'overlap-geometry-fixture', firstBpm: FIRST_BPM, offset: 0, timing: [], difficulties: [], title: 'Overlap fixture'},
    firstBpm: FIRST_BPM,
    scrollAdjust: SCROLL.adjust,
    duration: 24,
    notes: [{
      id: 'overlap-slide', type: 1, group: 0, scrollMod: 1, direction: -1,
      points: [
        {index: 0, beat: 4, time: 4, position: 8 + TARGET_DEPTH[0], left: -6, right: 5, width: 1, leftEasing: 3, rightEasing: 3, easeLeft: easeIn, easeRight: easeIn, isLast: false},
        {index: 1, beat: 8, time: 8, position: 8 + TARGET_DEPTH[1], left: -3, right: 3, width: 1, leftEasing: 4, rightEasing: 4, easeLeft: easeOut, easeRight: easeOut, isLast: false},
        {index: 2, beat: 12, time: 12, position: 8 + TARGET_DEPTH[2], left: -1, right: 2, width: 1, leftEasing: null, rightEasing: null, easeLeft: null, easeRight: null, isLast: true},
      ],
    }],
    events: [],
  });
  const note = renderer.notes[0];
  assert.ok(note, 'fixture note must normalize');
  const speed = renderer.baseScrollSpeed(USER_SPEED) || 1;
  const fitted = TARGET_DEPTH.map((z) => PROBE_TIME + z / (speed * SCROLL.positionMultiplier));
  for (let i = 0; i < fitted.length; i++) note.points[i].position = fitted[i];
  return {note, speed, fitted};
}

/** Winding-number style point-in-polygon over a projected screen polygon. */
function inside(point, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if ((yi > point.y) !== (yj > point.y) && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function centroid(poly) {
  let x = 0;
  let y = 0;
  for (const v of poly) {
    x += v.x;
    y += v.y;
  }
  return {x: x / poly.length, y: y / poly.length};
}

function collect(renderer, note, speed) {
  const state = renderer.chart.positionAt(PROBE_TIME, 0);
  const stateAt = () => state;
  const z = renderer._visibleAnchorZ(note, state, speed);
  const visible = [{n: note, z}];
  renderer._prepareSlideFrame(visible, stateAt, speed, true);
  const geometry = renderer._slideGeometry(note, z, stateAt, speed);
  assert.ok(geometry, 'combined-outline geometry must exist for the fixture');
  return {state, stateAt, z, geometry};
}

test('overlap pixel fixture: fitted depths put the junction and tail on the field', () => {
  const {canvas} = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, {textureUrl: null});
  const {note, speed} = makeOverlapFixture(renderer);
  assert.ok(Math.abs(speed * SCROLL.positionMultiplier - 4.8) < 1e-9, 'base speed x position multiplier must be the configured 160/200*1.5*4, got ' + speed * SCROLL.positionMultiplier);
  assert.equal(renderer.timingWarnings.length, 0, 'the fitted positions must agree with positionAt');
  const state = renderer.chart.positionAt(PROBE_TIME, 0);
  const depths = note.points.map((p) => renderer._zOf(p, state, speed, note.scrollMod));
  const expected = TARGET_DEPTH.map((z) => PROBE_TIME + z / (speed * SCROLL.positionMultiplier));
  const actualPositions = note.points.map((p) => p.position);
  assert.deepEqual(actualPositions, expected, 'point positions must be fitted from the live base speed');
  for (let i = 0; i < depths.length; i++) {
    assert.ok(Math.abs(depths[i] - TARGET_DEPTH[i]) < 1e-6, `point ${i} depth must be ${TARGET_DEPTH[i]}, got ${depths[i]}`);
  }
  assert.ok(depths[0] > CULL.back && depths[0] < CULL.front, 'the slide head must be inside the drawable depth guard');
  assert.ok(depths[2] < CULL.shaderFar, 'the slide tail must stay inside the shader Z far bound');
});

test('overlap pixel fixture: the junction is a transverse cap strictly on screen', () => {
  const {canvas} = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, {textureUrl: null});
  const {note, speed} = makeOverlapFixture(renderer);
  const {geometry} = collect(renderer, note, speed);
  assert.equal(geometry.bodyPolys.length, 2, 'exactly two visible slide intervals are required');
  assert.equal(geometry.runs.length, 2, 'two intervals must each expose a projected run');
  const [runA, runB] = geometry.runs;
  const tailLeft = runA.left[runA.left.length - 1];
  const tailRight = runA.right[runA.right.length - 1];
  const headLeft = runB.left[0];
  const headRight = runB.right[0];
  // The junction is the transverse cap between the two rails, not either rail corner: the browser
  // check samples the cap midpoint, so a fixture where the cap is off screen would invalidate it.
  const junction = {x: (tailLeft.x + tailRight.x) / 2, y: (tailLeft.y + tailRight.y) / 2};
  assert.ok(Number.isFinite(junction.x) && Number.isFinite(junction.y), 'the junction must project to finite coordinates');
  assert.ok(junction.x > 8 && junction.x < canvas.width - 8, `junction x must be on screen, got ${junction.x}`);
  assert.ok(junction.y > 8 && junction.y < canvas.height - 8, `junction y must be on screen, got ${junction.y}`);
  const capLength = Math.hypot(tailRight.x - tailLeft.x, tailRight.y - tailLeft.y);
  assert.ok(capLength > 8, 'the transverse cap must be a real painted edge, got ' + capLength);
  const headLength = Math.hypot(headRight.x - headLeft.x, headRight.y - headLeft.y);
  assert.ok(Math.abs(capLength - headLength) < 0.5, `the shared junction cap must project one size, got ${capLength} vs ${headLength}`);
  assert.ok(Number.isFinite(tailLeft.zc) && Number.isFinite(headLeft.zc), 'the junction must carry a camera depth');
  assert.ok(Math.abs(tailLeft.zc - headLeft.zc) < 1e-6, 'both intervals must place the junction at the same camera depth');
  for (const poly of geometry.bodyPolys.map((entry) => entry.poly)) {
    for (const point of poly) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), 'every projected vertex must be finite');
    }
  }
});

test('overlap pixel fixture: the second interval is actually buried in the first', () => {
  const {canvas} = makeCanvas();
  const renderer = new PlayfieldRenderer(canvas, {textureUrl: null});
  const {note, speed} = makeOverlapFixture(renderer);
  const {geometry} = collect(renderer, note, speed);
  const [first, second] = geometry.bodyPolys.map((entry) => entry.poly);
  // The outer body is strictly wider at every depth, so none of ITS rail may be inside the inner
  // body: that is what makes the outer edge the exposed boundary the pixel test samples.
  for (const point of first) {
    assert.equal(inside(point, second), false, 'the outer rail must not be buried in the inner body');
  }
  const buriedInner = second.filter((point) => inside(point, first)).length;
  assert.ok(buriedInner > 0, 'the inner interval must be buried in the outer body to form a union');
  const middle = centroid(first);
  assert.equal(inside(middle, first), true, 'the outer body centroid must be inside the outer body');
  assert.equal(inside(middle, second), false, 'the painted interior sample must not be inside the inner body');
});
