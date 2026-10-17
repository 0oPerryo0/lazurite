/**
 * renderer.js ??dependency-free Canvas renderer for the Crystallium playfield.
 *
 * Owner: renderer agent. Consumes the `engine.js` contract (see ./CONTRACTS.md):
 *
 *   export class PlayfieldRenderer {
 *     constructor(canvas)
 *     setChart(compiled)                          // engine.compileChart(...) result
 *     render(time, {scrollSpeed, overlays, selectedId, ...})
 *     pick(x, y) -> note id | null
 *     resize()
 *   }
 *
 * WHAT THIS IS
 * ------------
 * A mathematical reconstruction of the supplied build's playfield drawn with a 2D Canvas
 * perspective projection. Geometry, camera, cull ranges, per-note transforms, independent
 * slide-edge easings, void shading arithmetic and the baked lane-texture pixel positions
 * come from `docs/11-playfield-visual-specification.md`, the decompiled C# in
 * `evidence/decompiled/`, the shader evidence in `evidence/playfield-shaders/` and the
 * layout in `analysis/playfield-layout-v4.json`.
 *
 * WHAT THIS IS NOT
 * ----------------
 * No Unity process was launched and no game screenshot exists anywhere in this workspace,
 * so this is a projection, not a captured frame. Read APPROXIMATION LIMITS before judging
 * any pixel.
 *
 * APPROXIMATION LIMITS (honest list)
 * ----------------------------------
 *  1. Note artwork is procedural. TapMaterial / SlideMaterial / SlideTapMaterial /
 *     BulletMaterial / EdgeMaterial each sample their own `_MainTex` inside the compiled
 *     shaders (shader-921/922/924 asm), and those texture assets were not decoded into this
 *     workspace. The shader arithmetic (Z cull, `_Color` multiply, `_ExAlpha` branch) is
 *     reproduced, but the sampled art is replaced by code-drawn glyphs, so note COLOURS are
 *     chosen for legibility/contrast and are NOT recovered game colours.
 *  2. The Bullet mesh (prefab3687 -> mesh912, bounds ~.0041 x .0041 x .005, drawn at uniform
 *     scale 30) was not decoded, so its silhouette is approximated as a ~.12 wide, ~.15 deep
 *     faceted cone/gem. Its transform, cull behaviour and depth-write distinction are exact.
 *  3. GPU state cannot be reproduced on a 2D canvas. The void pass is ZTest Disabled /
 *     ZWrite On / blend DstAlpha,One; its XZ mask and its nonlinear abs(viewX) grey are pure
 *     arithmetic and are reproduced exactly, but the blend is approximated as source-over
 *     with a computed alpha.
 *  4. The `Track (1)` world-space UI overlay is drawn as a second additive pass of the same
 *     texture with the serialized image alpha (~.4196). Its real quad comes from the Image
 *     rect/sprite geometry rather than Track.GenerateQuad; only the track-sized reading of it
 *     is reproduced.
 *  5. `TrackEffects A/B/C` Animator clips (1/6 s press, 1/12 s release, one changing material
 *     scalar 1 -> .5 -> 0) are approximated as opacity ramps with those durations; the
 *     authored AnimationClip curves were not re-sampled here.
 *  6. Main Camera, Track and JudgementLine use the resolved RectTransform values (camera
 *     (0,1.46,-1.05), track Y .003, judgement Y .015). Track/camera animation from
 *     VisualFXSillyEffector is not part of the compiled chart contract, so the layout is
 *     static apart from the optional tutorial-style region covers.
 *  7. `render(time)` is a best-effort VISUAL position. Judgement windows and the absolute-time
 *     collision clock are not this module's job (see docs/03).
 *  8. `pick()` is a screen-space hit test over projected geometry. The game's input uses
 *     logical lane hitboxes, not pixels; this is the viewer's analogue.
 *  9. The lane markings are reproduced faithfully only when the track texture loads (the default
 *     `./assets/texture-435.png`, resolved next to the page so a sub-path static host works). The
 *     fallback draws the nine faint and four strong authored columns at their measured pixel
 *     positions, which is a faithful *position* approximation with synthetic brightness.
 *
 * COMBINED SLIDE OUTLINE (`render(time, {showOverlappingSlides})`)
 * -----------------------------------------------------------------
 * This is a VIEWER-side presentation choice, not a recovered game option. By default each visible
 * slide body is filled and only the outer boundary of the union of all visible slide bodies is
 * stroked, so the transverse stroke at every interior interval join and the doubled rails where
 * two slides cross disappear. Passing `showOverlappingSlides: true` selects the per-object outline,
 * which strokes every interval separately.
 *
 * Implementation: `_prepareSlideFrame` caches the projected screen polygon of every visible slide
 * body and head/tail tap quad for the frame, then each note strokes its own exposed boundary
 * pieces inside its normal `_drawNote` call (no deferred pass, so no other note's occlusion
 * changes). A candidate edge is split at every polygon-boundary intersection and each piece is
 * kept only when a probe to one side is inside the union and the probe to the other side is not
 * (nonzero winding, the rule Canvas fills use). Fills are never split or reordered — only the
 * strokes of an interval are clipped.
 *
 * Visual tokens for the field/UI layer (parent-provided frontend palette): background near
 * #0e1422, lapis surface #151c2e, warm ivory #eeeade, mint #9ee6cf. These are UI tokens, not
 * recovered game colours (see limit 1).
 */

// ---------------------------------------------------------------------------------------
// Constants ??world units, chart seconds, lanes, UVs and pixels as labelled.
// ---------------------------------------------------------------------------------------

/** Main Camera754. RectTransform-resolved root position (raw m_LocalPosition Y is -1.05). */
export const CAMERA = Object.freeze({
  position: Object.freeze([0, 1.46, -1.05]),
  /** quaternion (.2588191032, 0, 0, .9659258127) => +30 degrees about X. */
  pitchDegrees: 30,
  /** Serialized vertical field of view. */
  fovDegrees: 60,
  near: 0.3,
  far: 1000,
  depth: -1,
});

/** Track585 / GameScene layout. */
export const TRACK = Object.freeze({
  position: Object.freeze([0, 0.003, 4.75]),
  width: 2.5,
  height: 10,
  /** GenerateQuad Z span: extends .25 behind judgement; the far edge is 9.75, not 10. */
  nearZ: -0.25,
  farZ: 9.75,
  /** Quad UVs: near edge V=1, far edge V=0. */
  nearV: 1,
  farV: 0,
});

/** GameNote.Initialize: laneToUnityPos = track.bounds.extents.x / 6 = 5/24. */
export const LANES = Object.freeze({
  min: -6,
  max: 6,
  count: 12,
  toWorld: 5 / 24,
});

/** JudgementLine504: Plane10209 at (0,.015,0), scale (.25,1,.02) => 2.5 wide x .2 deep. */
export const JUDGEMENT = Object.freeze({
  position: Object.freeze([0, 0.015, 0]),
  scale: Object.freeze([0.25, 1, 0.02]),
  width: 2.5,
  depth: 0.2,
  /** The logical hit instant stays Z=0, not either edge of the .2-deep plane. */
  logicalZ: 0,
  /** Every note draw path applies "+.01" to its vertices; surfaces land near Y=.02. */
  tapSurfaceY: 0.02,
  bulletSurfaceY: 0.1,
});

/** GameNote cull guard + the exact shader Z bounds. */
export const CULL = Object.freeze({ back: -0.3, front: 10.2, shaderNear: -0.25, shaderFar: 9.75 });

/** OnibiBehavior: world Y = judgement + .2, logical box .65 lanes, clamp +/-5.675 lanes. */
export const ONIBI = Object.freeze({
  worldY: JUDGEMENT.position[1] + 0.2,
  logicalHalfWidthLanes: 0.325,
  centerClampLanes: 5.675,
});

/** ChartPlayer.SCROLL_SPEED_ADJUST_VALUE and VisualPositionToZPosition's position multiplier. */
export const SCROLL = Object.freeze({ adjust: 160, positionMultiplier: 4, defaultSavedSpeed: 1 });

/**
 * Baked markings of Texture435 ("playfield", 1082x1920 RGB), measured from
 * evidence/playfield-shaders/texture-435.png with pixel-to-world X = -1.25 + 2.5*u,
 * u = (px + .5)/1082.
 *
 * Strong (border/region) authored spans: 0-4, 357-363, 716-722, 1077-1081.
 * Faint one-pixel spans: 91, 181, 271, 450, 540, 630, 809, 899, 989.
 * Peak brightness at the near edge is ~172 for strong columns and ~24 for faint ones; both
 * fade along the texture (about 16 / 0 at the far row). The authored lines are therefore NOT
 * exactly at lane/12, which is why pixel positions are recorded instead of recomputed.
 */
export const TEXTURE_MARKINGS = Object.freeze({
  width: 1082,
  height: 1920,
  strongColumns: Object.freeze([1, 360, 719, 1079]),
  faintColumns: Object.freeze([91, 181, 271, 450, 540, 630, 809, 899, 989]),
  strongValue: 172,
  faintValue: 24,
});

/** Number of visual lane intervals (chartered as 12) and their region grouping (4 each). */
export const LANE_REGIONS = Object.freeze([
  Object.freeze({ index: 0, lanes: Object.freeze([-6, -2]) }),
  Object.freeze({ index: 1, lanes: Object.freeze([-2, 2]) }),
  Object.freeze({ index: 2, lanes: Object.freeze([2, 6]) }),
]);

// ---------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------

/** Signed left-to-right rotation about +Y (Unity left-handed), as an (x,z) -> (x,z) map. */
export function pathAngleFromDegrees(degrees) {
  const r = ((Number(degrees) || 0) * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return (x, z) => [x * c + z * s, -x * s + z * c];
}

/** Gimmick type 1/2: atan2(laneEnd - initialLane, length) converted to a Y rotation. */
export function pathAngleFromGimmick(laneEnd, initialLane, length) {
  const deg = (Math.atan2(laneEnd - initialLane, length) * 180) / Math.PI;
  return pathAngleFromDegrees(deg);
}

// ---------------------------------------------------------------------------------------
// Easing ??Sodalite.Util.Easing, ported from evidence/decompiled/SodaliteParser.
// Deliberately not a standard easing library: EaseInExpo is (2^(8t)-1)/255, EaseInElastic is
// t^4*sin(t*pi*4.5), EaseInCirc is 1-sqrt(1-t), and so on. t is not clamped by the game.
// ---------------------------------------------------------------------------------------

export const EASINGS = Object.freeze({
  Nothing: -1,
  EaseLinear: 0,
  EaseInSine: 1,
  EaseOutSine: 2,
  EaseInQuad: 3,
  EaseOutQuad: 4,
  EaseInCubic: 5,
  EaseOutCubic: 6,
  EaseInQuart: 7,
  EaseOutQuart: 8,
  EaseInQuint: 9,
  EaseOutQuint: 10,
  EaseInExpo: 11,
  EaseOutExpo: 12,
  EaseInCirc: 13,
  EaseOutCirc: 14,
  EaseInBack: 15,
  EaseOutBack: 16,
  EaseInElastic: 17,
  EaseOutElastic: 18,
  EaseInBounce: 19,
  EaseOutBounce: 20,
});

const EASING_FNS = [
  (t) => t, // 0
  (t) => Math.sin(1.5707963 * t), // 1
  (t) => 1 + Math.sin(1.5707963 * (t - 1)), // 2
  (t) => t * t, // 3
  (t) => t * (2 - t), // 4
  (t) => t * t * t, // 5
  (t) => 1 + (t - 1) * (t - 1) * (t - 1), // 6
  (t) => t * t * t * t, // 7
  (t) => 1 - (t - 1) * (t - 1) * (t - 1) * (t - 1), // 8
  (t) => t * t * t * t * t, // 9
  (t) => 1 + (t - 1) * (t - 1) * (t - 1) * (t - 1) * (t - 1), // 10
  (t) => (Math.pow(2, 8 * t) - 1) / 255, // 11
  (t) => 1 - Math.pow(2, -8 * t), // 12
  (t) => 1 - Math.sqrt(1 - t), // 13
  (t) => Math.sqrt(t), // 14
  (t) => t * t * (2.70158 * t - 1.70158), // 15
  (t) => 1 + (t - 1) * (t - 1) * (2.70158 * (t - 1) + 1.70158), // 16
  (t) => t * t * t * t * Math.sin(t * Math.PI * 4.5), // 17
  (t) => 1 - (t - 1) * (t - 1) * (t - 1) * (t - 1) * Math.cos(t * Math.PI * 4.5), // 18
  (t) => Math.pow(2, 6 * (t - 1)) * Math.abs(Math.sin(t * Math.PI * 3.5)), // 19
  (t) => 1 - Math.pow(2, -6 * t) * Math.abs(Math.cos(t * Math.PI * 3.5)), // 20
];

/** Evaluate a Sodalite easing by enum index, enum name, or function. Unknown -> linear. */
export function ease(type, t) {
  if (typeof type === 'function') return type(t);
  const i = typeof type === 'string' ? EASINGS[type] : type;
  const fn = EASING_FNS[i];
  return fn ? fn(t) : t;
}

/**
 * Resolve an easing from whatever the compiler emitted: function, numeric enum, enum name,
 * or null (a segment end point, which by construction has no easing).
 */
function resolveEasing(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'function') return value;
  const i = typeof value === 'string' ? EASINGS[value] : value;
  if (typeof i === 'number' && EASING_FNS[i]) return EASING_FNS[i];
  return fallback;
}

/**
 * Engine easing bridge.
 *
 * engine.js may be loaded at runtime (`loadEngine()` below) or handed to the constructor as
 * `options.engineModule`. When its `easingFunction(code)` export exists it is preferred, so the
 * renderer shares the compiler's exact curves; otherwise the bundled port above is used. The
 * namespace is never imported statically, so a missing or renamed engine export cannot break
 * this module's load.
 */
function makeEngineEasing(module) {
  if (!module || typeof module.easingFunction !== 'function') return null;
  return (code) => {
    const fn = module.easingFunction(code);
    return typeof fn === 'function' ? fn : EASING_FNS[0];
  };
}

let engineModulePromise = null;

/**
 * Best-effort dynamic import of the sibling engine module. Successful resolution replaces the
 * bundled easing with the engine's; failure (offline use, a non-browser loader, an older
 * browser) is silent and the bundled port stays in charge.
 */
export function loadEngine() {
  if (!engineModulePromise) {
    engineModulePromise = import('./engine.js').catch(() => null);
  }
  return engineModulePromise;
}

// ---------------------------------------------------------------------------------------
// Camera / projection (pure functions, exported so the geometry can be checked offline)
// ---------------------------------------------------------------------------------------

/**
 * Serialized rotation of Main Camera754 as a quaternion (x, y, z, w), exactly as the asset
 * reports it. Unity stores float32 and a quaternion is half-angle encoded, so these are the
 * rounded forms of sin(15 deg) / cos(15 deg) for a +30-degree pitch about X. They are used
 * literally (and normalized) because that is the convention behind the published projection
 * table in `analysis/playfield-layout-v4.json`: substituting exact double-precision
 * sin/cos shifts the camera-space Y by ~1.4e-7 world units.
 */
export const CAMERA_ROTATION = Object.freeze([0.2588191032, 0, 0, 0.9659258127]);

/**
 * Camera-local axes as unit vectors in world space, such that the camera-space coordinates of
 * a world point are `(dot(o,right), dot(o,up), dot(o,forward))` for the offset `o`.
 *
 *   right   = ( 1,  0,     0    )
 *   up      = ( 0,  cos p, sin p)
 *   forward = ( 0, -sin p, cos p)
 *
 * These are exactly the values stored in `analysis/playfield-layout-v4.json`: for the
 * judgement centre (0,.015,0) the convention gives camera (0, -0.72640657, 1.63182674) and
 * viewport (0.5, 0.114489). Normalized Y is independent of the viewport aspect while X scales
 * with it, which matches the published table.
 *
 * Note that this triple is left-handed (right x up = -forward); the reconstruction follows the
 * build's own stored projection rather than "correcting" the handedness, and mirroring is then
 * handled by the explicit +/-X mapping in the viewport formula.
 */
export function cameraAxes(pitchDegrees = CAMERA.pitchDegrees) {
  const p = ((Number(pitchDegrees) || 0) * Math.PI) / 180;
  const s = Math.sin(p);
  const c = Math.cos(p);
  return { right: [1, 0, 0], up: [0, c, s], forward: [0, -s, c] };
}

/** Alias of cameraAxes, for call sites that read more naturally as a "basis". */
export function cameraBasis(pitchDegrees = CAMERA.pitchDegrees) {
  return cameraAxes(pitchDegrees);
}

/**
 * Camera axes taken from the serialized quaternion instead of a rounded pitch angle.
 *
 * For a pure-X rotation `q = (sin(p/2), 0, 0, cos(p/2))` the rotation-matrix entries collapse to
 * `sin p = 2*qx*qw` and `cos p = 1 - 2*qx^2`, evaluated after normalization so the rounded
 * float32 text round-trips the same way the recovered projection did. (p = 2*asin(qx) also
 * works and is how the test documents the angle.)
 */
export function cameraAxesFromQuaternion(q = CAMERA_ROTATION) {
  const [qx = 0, qy = 0, qz = 0, qw = 1] = q;
  void qy;
  void qz;
  const norm = Math.hypot(qx, qw) || 1;
  const halfSin = qx / norm;
  const halfCos = qw / norm;
  const sin = 2 * halfSin * halfCos;
  const cos = 1 - 2 * halfSin * halfSin;
  return { right: [1, 0, 0], up: [0, cos, sin], forward: [0, -sin, cos] };
}

/** World -> camera space: project the camera-relative offset onto the camera-local axes. */
export function worldToCamera(x, y, z, camera = CAMERA) {
  // CAMERA itself carries no precomputed axes, so the default path derives them from the
  // serialized quaternion; a renderer instance stores `axes` on its layout for speed.
  const axes = camera.axes || cameraAxesFromQuaternion(camera.quaternion || CAMERA_ROTATION);
  const dx = x - camera.position[0];
  const dy = y - camera.position[1];
  const dz = z - camera.position[2];
  const dot = (v) => dx * v[0] + dy * v[1] + dz * v[2];
  return {
    xc: dot(axes.right),
    yc: dot(axes.up),
    zc: dot(axes.forward),
  };
}

/** Normalized viewport coordinates (Unity: Y=0 is the bottom). */
export function viewportFromCamera(cam, aspect, fovDegrees = CAMERA.fovDegrees) {
  if (!(cam.zc > 1e-6)) return null;
  const t = Math.tan((fovDegrees * Math.PI) / 360);
  const scale = 1 / (2 * cam.zc * t);
  return { x: 0.5 + (cam.xc * scale) / aspect, y: 0.5 + cam.yc * scale, zc: cam.zc };
}

/**
 * Ground-plane reference projection.
 *
 * IMPORTANT: this is a constant-depth reference computed at the plane origin, not the ground
 * mapping. The ground is projected per point by `PlayfieldRenderer.project()`; an earlier
 * revision used this as the ground mapping, which was wrong because the ground normal is
 * `(0,1,0)` while the camera forward is `(0,-sin p, cos p)`, so the two are NOT perpendicular
 * (dot = cos p = .866) and ground depth actually runs from 1.4213 at Z=-.25 to 10.0816 at
 * Z=9.75. What remains valid here is the depth of the judgement plane, which drives the
 * narrow-viewport fit scale and the void body's world-X interpolation.
 */
export function groundProjection(groundY = TRACK.position[1], camera = CAMERA) {
  const cam = worldToCamera(0, groundY, 0, camera);
  const zc = cam.zc;
  const yc = cam.yc;
  const t = Math.tan((CAMERA.fovDegrees * Math.PI) / 360);
  return { zc, yc, scale: 1 / (2 * zc * t) };
}

/**
 * Exact Custom/Mask pixel arithmetic (shader-922 program3), transcribed instruction by
 * instruction with v = abs(viewX). Note the unusual constants and the absence of any
 * saturation/clamp. Returned components are the shader's RGB before alpha compositing.
 */
export function maskShade(viewX) {
  const v = Math.abs(viewX);
  const a = v - 0.15;
  const s = Math.sin(a * 1.570796) * (1 - (1 - a) * (1 - a) * (1 - a));
  const base = 0.35 * (0.7 - 0.9 * s) + 0.3;
  const b = 1 - (1 - v) * (1 - v) * (1 - v);
  return [base - b * 0.2, base - b * 0.05, base - b * 0.05];
}

/** maskShade as a CSS colour, folded through the pass alpha multiplier. */
function maskShadeCss(viewX, alphaMultiplier) {
  const [r, g, b] = maskShade(viewX);
  const a = clamp(0.5 * alphaMultiplier, 0, 1);
  const to255 = (c) => Math.round(clamp(Math.sqrt(Math.max(0, c * a)) * 255, 0, 255));
  return `rgb(${to255(r)},${to255(g)},${to255(b)})`;
}

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** #rgb/#rrggbb -> [r,g,b] 0..255. */
function hexToRgb(hex) {
  const raw = String(hex).replace('#', '');
  const h = raw.length === 3 ? raw.replace(/(.)/g, '$1$1') : raw;
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return [238, 234, 222];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${clamp(Number(alpha) || 0, 0, 1).toFixed(4)})`;
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Screen-space union helpers for the combined slide outline (option `showOverlappingSlides`).
 *
 * The problem they solve: this renderer fills and strokes EVERY interval of a slide body, so a
 * multi-interval slide shows a transverse stroke at each interior join and two overlapping rails
 * wherever two slide bodies cross. The option suppresses those interior strokes and keeps only
 * the outer boundary of the union of all visible slide bodies.
 *
 * Method (no offscreen canvas, no compositing tricks): every projected body polygon is cached for
 * the frame, then each candidate edge — the two rails of an interval plus its end caps — is split
 * at every intersection with a polygon boundary and each resulting piece is classified once, by
 * probing a hairline to each side of its midpoint. The union membership used for those probes
 * INCLUDES the ring's own polygon: for a shared join the two probes land in the two adjacent
 * bodies, so both read inside and the piece is dropped, while an outer rail reads inside on one
 * side and outside on the other and survives.
 */
export function polygonBounds(poly) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Parameters along P0->P1 where it meets a polygon boundary.
 *
 * Collinear overlap is handled explicitly: when the candidate edge runs along a polygon edge, the
 * two overlap endpoints are returned instead of nothing. A long edge can coincide with a boundary
 * for part of its length and leave it elsewhere, and without those cut points a single piece would
 * span both states; the side test then decides each piece on its own.
 */
export function segmentPolygonParams(P0, P1, poly) {
  const rx = P1.x - P0.x;
  const ry = P1.y - P0.y;
  const len = Math.hypot(rx, ry);
  if (!(len > 0)) return [];
  const params = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    edgeParams(P0, rx, ry, len, poly[j].x, poly[j].y, poly[i].x, poly[i].y, params);
  }
  return params;
}

/** One polygon edge A->B of segmentPolygonParams: pushes 0, 1 or 2 clamped parameters. */
function edgeParams(P0, rx, ry, len, ax, ay, bx, by, params) {
  const sx = bx - ax;
  const sy = by - ay;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) {
    // Parallel. Only collinear overlaps matter; parallel-but-offset has no crossing. The offset
    // is a perpendicular distance in px, so the tolerance must be absolute, not relative to len.
    if (Math.abs((ax - P0.x) * ry - (ay - P0.y) * rx) > 1e-6 * len) return;
    const useX = Math.abs(sx) >= Math.abs(sy);
    const aT = ((useX ? ax - P0.x : ay - P0.y) / (useX ? rx : ry));
    const bT = ((useX ? bx - P0.x : by - P0.y) / (useX ? rx : ry));
    pushParam(params, Math.min(aT, bT));
    pushParam(params, Math.max(aT, bT));
    return;
  }
  const ox = ax - P0.x;
  const oy = ay - P0.y;
  const t = (ox * sy - oy * sx) / den;
  const u = (ox * ry - oy * rx) / den;
  if (t > -1e-9 && t < 1 + 1e-9 && u > -1e-9 && u < 1 + 1e-9) pushParam(params, t);
}

function pushParam(params, t) {
  if (t > -1e-9 && t < 1 + 1e-9) params.push(clamp(t, 0, 1));
}

/**
 * Nonzero winding number of a point with respect to one polygon — the same fill rule Canvas uses
 * by default (`ctx.fill()` is nonzero, not even-odd).
 *
 * The distinction matters only for a SELF-crossing polygon or one whose winding reaches +/-2: a
 * union of separate body polygons is filled under both rules (the membership test ORs over the
 * polygons, so overlap is never punched out by parity between two polygons). Reproducing the
 * nonzero rule here keeps self-folded slide bodies identical to how Canvas fills them.
 */
export function windingNumber(x, y, poly) {
  let winding = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    winding += edgeWinding(x, y, poly[i].x, poly[i].y, poly[j].x, poly[j].y);
  }
  return winding;
}

/** One edge J->I of windingNumber: +1, -1 or 0. Only edges straddling `y` left of `x` count. */
function edgeWinding(x, y, xi, yi, xj, yj) {
  const upward = yj <= y && yi > y;
  const downward = yi <= y && yj > y;
  if (!upward && !downward) return 0;
  const side = (xj - xi) * (y - yi) - (x - xi) * (yj - yi);
  if (upward && side > 0) return 1;
  if (downward && side < 0) return -1;
  return 0;
}

/**
 * Signed area of a closed ring (shoelace), in px^2: the conventional `-sum/2` after accumulating
 * `sum = Σ(x_j·y_i − x_i·y_j)`, so a square of side 10 reports 100, not 200.
 *
 * POSITIVE is the algebraic orientation this renderer normalizes to; it is not a claim about the
 * visual direction, because screen space has y pointing down (a positive-shoelace ring reads
 * clockwise on screen). What matters is that positive markers agree with `windingNumber`, which
 * counts an interior point of such a ring as +1.
 *
 * Used only to give every ring of one compound fill the same orientation. Orientation never
 * changes what a single ring fills under the nonzero rule (its winding simply negates), but two
 * overlapping rings with OPPOSITE orientation cancel to winding 0 and would punch a hole in the
 * middle of the slide. Normalizing each ring removes that cancellation.
 */
export function ringSignedArea(poly) {
  let sum = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    sum += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return -sum / 2;
}

/**
 * True when segments P0->P1 and Q0->Q1 intersect or overlap, with collinear and touch cases
 * included. `eps` is an absolute distance tolerance in px, matching `segmentPolygonParams`.
 *
 * Exported so the near-parallel branch (the one place where t/u become numerically unusable and the
 * test falls back to projected pixel distances) can be pinned by an adversarial regression.
 */
export function segmentsIntersect(P0, P1, Q0, Q1, eps) {
  const rx = P1.x - P0.x;
  const ry = P1.y - P0.y;
  const sx = Q1.x - Q0.x;
  const sy = Q1.y - Q0.y;
  const rxry = Math.hypot(rx, ry);
  const sysx = Math.hypot(sx, sy);
  if (!(rxry > eps) || !(sysx > eps)) return true; // degenerate segment counts as intersecting
  const den = rx * sy - ry * sx;
  const qpx = Q0.x - P0.x;
  const qpy = Q0.y - P0.y;
  const denScale = rxry * sysx;
  // |den| / (|r||s|) is |sin(angle between the segments)|. A ratio above the tolerance gives exact
  // t/u parameters, so the answer is decided precisely for every genuinely crossing pair.
  if (Math.abs(den) > eps * denScale) {
    const t = (qpx * sy - qpy * sx) / den;
    const u = (qpx * ry - qpy * rx) / den;
    const tolT = eps / rxry;
    const tolU = eps / sysx;
    return t >= -tolT && t <= 1 + tolT && u >= -tolU && u <= 1 + tolU;
  }
  // Nearly parallel: t/u are numerically unusable, so decide with explicit distances instead.
  // At this point |sin(angle)| <= eps, so the two lines are as good as collinear; the segment's own
  // extent is the only thing left to test.
  //
  // `perp` is a distance in PX from P's line, so separation is proved against an absolute px eps.
  // t0/t1 are projections onto the UNIT direction along P, i.e. also in PX measured from P0, so
  // they must be compared against P's LENGTH (rxry) — never against 1. Comparing against 1 was a
  // unit bug: a segment meeting P far along its length looked like a proven separation.
  const ux = rx / rxry;
  const uy = ry / rxry;
  const t0 = (Q0.x - P0.x) * ux + (Q0.y - P0.y) * uy;
  const t1 = (Q1.x - P0.x) * ux + (Q1.y - P0.y) * uy;
  const perp0 = (Q0.x - P0.x) * -uy + (Q0.y - P0.y) * ux;
  const perp1 = (Q1.x - P0.x) * -uy + (Q1.y - P0.y) * ux;
  const perp = perp0 * perp1 <= 0 ? 0 : Math.min(Math.abs(perp0), Math.abs(perp1));
  if (perp > eps) return false; // the whole of Q stays clear of P's line -> proved separation
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  return hi >= -eps && lo <= rxry + eps;
}

/**
 * True when a ring is simple: a closed curve that never crosses or touches itself, so every
 * interior point has the same winding. NOT simple: any non-finite point, fewer than three distinct
 * vertices, a ring that folds back on itself at a vertex, a ring with no area (all points
 * collinear), or any self-intersection — including a collinear overlap and a vertex lying on
 * another edge.
 *
 * Consecutive coincident points are NOT a rejection: they are dropped first (a duplicated closing
 * vertex and a zero-length edge both survive as simple), which is why the check below runs on the
 * cleaned vertex list. A duplicated point that is not consecutive still collides as an
 * intersection.
 *
 * A compound `nonzero` fill is only exact when every member ring is simple. A self-crossing ring
 * contains regions of opposite winding, so it can cancel against its own overlap; such a slide
 * keeps the per-interval fill path instead.
 */
export function ringIsSimple(poly, eps = 1e-6) {
  if (!poly || poly.length < 3) return false;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  }
  // Drop consecutive coincident points so a zero-length edge cannot make the ring look
  // self-touching. Fewer than three left means the ring has no area.
  const pts = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const last = pts[pts.length - 1];
    if (last && Math.abs(p.x - last.x) <= eps && Math.abs(p.y - last.y) <= eps) continue;
    pts.push(p);
  }
  while (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.abs(first.x - last.x) <= eps && Math.abs(first.y - last.y) <= eps) pts.pop();
    else break;
  }
  if (pts.length < 3) return false;
  const n = pts.length;
  // A ring that folds back on itself at a vertex (adjacent edges collinear and opposite) is a
  // zero-width spike: the adjacent-pair skip below cannot see it, and it contributes no area.
  for (let i = 0; i < n; i++) {
    const prev = pts[(i + n - 1) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const inX = cur.x - prev.x;
    const inY = cur.y - prev.y;
    const outX = next.x - cur.x;
    const outY = next.y - cur.y;
    if (Math.abs(inX * outY - inY * outX) <= eps * Math.max(1, Math.hypot(inX, inY)) * Math.max(1, Math.hypot(outX, outY)) && inX * outX + inY * outY < 0) return false;
  }
  // Degenerate rings (collinear points, three distinct points on one line) have no interior; a
  // compound fill would then add a path that fills nothing while still being normalized.
  const area = Math.abs(ringSignedArea(pts));
  if (!(area > eps * eps)) return false;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip pairs that share a vertex: edge j follows edge i, or edge j is the wrap-around edge
      // that follows the last edge.
      if (j === i || j === i + 1) continue;
      if (j === n - 1 && i === 0) continue;
      const c = pts[j];
      const d = pts[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d, eps)) return false;
    }
  }
  return true;
}

/**
 * Union membership: true when (x, y) is inside ANY cached body polygon under the nonzero winding
 * rule that Canvas fills use. A bounding-box test is the only broad phase. Deliberately a plain
 * boolean — the boundary classification is decided by the two-sided probe in
 * `clipEdgeToBoundary`, not by a depth metric here.
 *
 * The union INCLUDES the ring's own polygon, and that is deliberate: for a shared seam between
 * two adjacent bodies the inward probe is inside one body and the outward probe inside the other,
 * so sideA === sideB and the seam is dropped. Excluding the ring's own polygon would make the
 * outward probe fall outside everything and wrongly KEEP that internal seam.
 */
export function makeMembership(polys, grid) {
  if (grid) return (x, y) => grid.contains(x, y);
  return (x, y) => {
    for (let i = 0; i < polys.length; i++) {
      const entry = polys[i];
      const b = entry.bbox;
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      if (windingNumber(x, y, entry.poly) !== 0) return true;
    }
    return false;
  };
}

/**
 * Uniform screen grid over the EDGES of the frame's slide polygons: the broad phase for the
 * combined slide outline.
 *
 * Both exact tests are sums over independent polygon edges, so an edge that cannot touch the query
 * is skipped without changing the result:
 *   - `segmentParams` only gathers edges whose cells overlap the segment's box grown by `margin`.
 *     An edge yields a cut only where it meets the segment (to ~1e-9 of its length), so a skipped
 *     edge, whose box is at least `margin` away, contributes nothing.
 *   - `contains` only gathers edges in the point's row up to `x + margin`. An edge adds winding
 *     only when it straddles `y` and crosses that row to the left of `x` (see edgeWinding's sign).
 * The per-edge arithmetic is the shared `edgeParams`/`edgeWinding` kernel, and cut parameters are
 * sorted afterwards, so results equal the linear scan. One known exception: an edge almost exactly
 * collinear with the segment but beyond its end can make the full scan's t/u division return a
 * spurious in-range cut (catastrophic cancellation). The grid never visits such an edge, so that
 * piece is not split in two; the stroked line is the same. Cell indices are clamped (far off-canvas
 * geometry lands in border cells and queries clamp the same way); edges with non-finite
 * coordinates are visited by every query.
 */
export function makeSlideEdgeGrid(entries, width, height, cellWidth = 8, cellHeight = 2, margin = 0.5) {
  // Rows are thin: slide geometry bunches up near the horizon, and a membership probe only needs
  // the edges that straddle its own y.
  const cols = Math.max(1, Math.ceil((Number(width) || 1) / cellWidth));
  const rows = Math.max(1, Math.ceil((Number(height) || 1) / cellHeight));
  // Cells are created on first use: most of a frame's grid is empty. `rowEdges` lists every edge
  // whose y-range covers a row, which is all a membership probe needs.
  const cells = new Array(cols * rows).fill(null);
  const rowEdges = new Array(rows).fill(null);
  const always = [];
  const col = (x) => Math.min(cols - 1, Math.max(0, Math.floor(x / cellWidth)));
  const row = (y) => Math.min(rows - 1, Math.max(0, Math.floor(y / cellHeight)));
  // Edge k of entry e is stored as one record; `mark` dedups an edge spanning several cells.
  const edges = [];
  for (let e = 0; e < entries.length; e++) {
    const poly = entries[e].poly;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const rec = { entry: entries[e], slot: e, ax: poly[j].x, ay: poly[j].y, bx: poly[i].x, by: poly[i].y, minX: Math.min(poly[j].x, poly[i].x), mark: 0 };
      edges.push(rec);
      if (!(Number.isFinite(rec.ax) && Number.isFinite(rec.ay) && Number.isFinite(rec.bx) && Number.isFinite(rec.by))) {
        always.push(rec);
        continue;
      }
      const c1 = col(Math.max(rec.ax, rec.bx));
      const r1 = row(Math.max(rec.ay, rec.by));
      for (let r = row(Math.min(rec.ay, rec.by)); r <= r1; r++) {
        (rowEdges[r] || (rowEdges[r] = [])).push(rec);
        for (let c = col(Math.min(rec.ax, rec.bx)); c <= c1; c++) {
          const idx = r * cols + c;
          (cells[idx] || (cells[idx] = [])).push(rec);
        }
      }
    }
  }
  let stamp = 0;
  const winding = new Float64Array(entries.length);
  const touched = [];
  const gather = (c0, c1, r0, r1, visit) => {
    stamp++;
    for (let k = 0; k < always.length; k++) { always[k].mark = stamp; visit(always[k]); }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = cells[r * cols + c];
        if (!cell) continue;
        for (let k = 0; k < cell.length; k++) {
          const rec = cell[k];
          if (rec.mark === stamp) continue;
          rec.mark = stamp;
          visit(rec);
        }
      }
    }
  };
  return {
    /** Push the cut parameters of every accepted polygon onto `params` (unsorted). */
    segmentParams(P0, P1, accept, params) {
      const rx = P1.x - P0.x;
      const ry = P1.y - P0.y;
      const len = Math.hypot(rx, ry);
      if (!(len > 0)) return;
      const x0 = Math.min(P0.x, P1.x) - margin;
      const x1 = Math.max(P0.x, P1.x) + margin;
      const y0 = Math.min(P0.y, P1.y) - margin;
      const y1 = Math.max(P0.y, P1.y) + margin;
      const visit = (rec) => {
        if (accept(rec.entry)) edgeParams(P0, rx, ry, len, rec.ax, rec.ay, rec.bx, rec.by, params);
      };
      if (!(Number.isFinite(x0) && Number.isFinite(x1) && Number.isFinite(y0) && Number.isFinite(y1))) {
        stamp++;
        for (let k = 0; k < edges.length; k++) visit(edges[k]);
        return;
      }
      gather(col(x0), col(x1), row(y0), row(y1), visit);
    },
    /** True when (x, y) has nonzero winding in any polygon whose bbox contains it. */
    contains(x, y) {
      touched.length = 0;
      const visit = (rec) => {
        const b = rec.entry.bbox;
        if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) return;
        const w = edgeWinding(x, y, rec.bx, rec.by, rec.ax, rec.ay);
        if (!w) return;
        if (winding[rec.slot] === 0) touched.push(rec.slot);
        winding[rec.slot] += w;
      };
      if (!(Number.isFinite(x) && Number.isFinite(y))) {
        stamp++;
        for (let k = 0; k < edges.length; k++) visit(edges[k]);
      } else {
        for (let k = 0; k < always.length; k++) visit(always[k]);
        const list = rowEdges[row(y)];
        if (list) {
          const limit = x + margin;
          for (let k = 0; k < list.length; k++) if (list[k].minX <= limit) visit(list[k]);
        }
      }
      let inside = false;
      for (let k = 0; k < touched.length; k++) {
        if (winding[touched[k]] !== 0) inside = true;
        winding[touched[k]] = 0;
      }
      return inside;
    },
  };
}

/**
 * Clip a candidate edge to the union boundary.
 *
 * The edge is split at EVERY intersection with a polygon boundary (including collinear overlap
 * endpoints, and including an intersection with the edge's own polygon, which is how a
 * self-folded slide's crossing cut is captured). Each piece between two consecutive true cuts is
 * then classified ONCE, at its midpoint, by probing a small distance to each side of the edge:
 *
 *   sideA === sideB  -> drop (both sides in the union is interior paint; both outside means the
 *                      piece is not on any body's boundary at all)
 *   sideA !== sideB  -> keep (the piece is a boundary of the union)
 *
 * Segment endpoints are deliberately NOT used as extra anchors: a cut point sits exactly on a
 * polygon boundary, where a probe to either side is ambiguous. The explicit cut set is what makes
 * a single midpoint per piece exact union topology for ordinary geometry; only a polygon thinner
 * than `eps` can misread, which is why `eps` is a hairline (1e-6 of the canvas width).
 *
 * @param {Function} membership (x, y) -> boolean "inside the union"
 * @param {number} eps probe distance in CSS pixels
 */
export function clipEdgeToBoundary(P0, P1, clipPolys, membership, eps, grid) {
  if (!clipPolys.length) return [{ a: P0, b: P1 }];
  const rx = P1.x - P0.x;
  const ry = P1.y - P0.y;
  const len = Math.hypot(rx, ry);
  if (!(len > 0)) return [];
  // Narrow phase: a polygon can only contribute a cut when its bounding box overlaps the candidate
  // segment's own box. That box is grown by a hairline, so a boundary exactly touching the segment
  // (a collinear overlap endpoint) is still visited. This can never skip the ring's own polygon:
  // the segment's box is built from its own endpoints, which that polygon contains.
  const segX0 = Math.min(P0.x, P1.x) - eps;
  const segX1 = Math.max(P0.x, P1.x) + eps;
  const segY0 = Math.min(P0.y, P1.y) - eps;
  const segY1 = Math.max(P0.y, P1.y) + eps;
  const params = [0, 1];
  const accept = (entry) => {
    const b = entry.bbox;
    return !(b && (b.x1 < segX0 || b.x0 > segX1 || b.y1 < segY0 || b.y0 > segY1));
  };
  if (grid) {
    grid.segmentParams(P0, P1, accept, params);
  } else {
    for (let i = 0; i < clipPolys.length; i++) {
      const entry = clipPolys[i];
      if (!accept(entry)) continue;
      const piece = segmentPolygonParams(P0, P1, entry.poly);
      for (let k = 0; k < piece.length; k++) params.push(piece[k]);
    }
  }
  params.sort((a, b) => a - b);
  const cuts = [];
  for (let i = 0; i < params.length; i++) {
    if (!cuts.length || params[i] - cuts[cuts.length - 1] > 1e-9) cuts.push(params[i]);
  }
  const nx = -ry / len;
  const ny = rx / len;
  const d = Math.max(1e-9, eps);
  const at = (t) => ({ x: P0.x + rx * t, y: P0.y + ry * t });
  const runs = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const t0 = cuts[i];
    const t1 = cuts[i + 1];
    if (t1 - t0 < 1e-9) continue;
    // A piece shorter than the probe would sample its own far side; shrink the probe for it.
    const probe = Math.min(d, (t1 - t0) * len * 0.25);
    if (!(probe > 0)) continue;
    const mx = P0.x + rx * ((t0 + t1) / 2);
    const my = P0.y + ry * ((t0 + t1) / 2);
    const sideA = membership(mx + nx * probe, my + ny * probe);
    const sideB = membership(mx - nx * probe, my - ny * probe);
    if (sideA === sideB) continue; // interior, or an off-boundary sliver -> suppressed
    runs.push({ a: at(t0), b: at(t1) });
  }
  return runs;
}

/** Eased hitbox between two segment points. The two edges ease independently. */
/**
 * Painter order for the note pass: flat bodies (slides, voids), then flat notes (taps, dashes),
 * then bullets; far first within each layer.
 *
 * A slide/void sorts by its largest VISIBLE point Z. While a long hold's tail is still beyond the
 * far cull that anchor can be its head, so a tap sitting on the body further up the track sorted
 * as "farther", was drawn first and vanished under the body until the tail came into view. Both
 * lie on the track surface, so the body must never cover a tap: layer before depth.
 */
function paintLayer(note) {
  if (note.kind === 1 || note.kind === 3) return 0;
  // Bullets float above the track (render queue 2000 vs 52 for taps), so a flat note never covers
  // one. Depth-sorting them with taps flipped the order each time a faster-scrolling bullet
  // overtook a tap, and the bullet popped under it.
  return note.kind === 2 ? 2 : 1;
}

/**
 * Depth key for sorting. Notes at the same instant must tie exactly, but their Z values can differ
 * in the last bits from frame to frame (rounding in position - state), which flipped the tie-break
 * and made equal-time neighbours swap. Rounding to ~9 significant digits absorbs that noise; it is
 * RELATIVE so genuinely different depths near the judgement line (z ~ 1e-10) still order correctly.
 */
function depthKey(z) {
  if (!z || !Number.isFinite(z)) return z || 0;
  const step = 2 ** (Math.floor(Math.log2(Math.abs(z))) - 30);
  return Math.round(z / step) * step;
}

function paintOrder(a, b) {
  return paintLayer(a.n) - paintLayer(b.n) || depthKey(b.z) - depthKey(a.z) || a.n.queue - b.n.queue || (a.n.order ?? 0) - (b.n.order ?? 0);
}

function hitboxAt(a, b, t, easeLeft, easeRight) {
  const left = lerp(a.left, b.left, clamp(easeLeft(t), -8, 8));
  const right = lerp(a.right, b.right, clamp(easeRight(t), -8, 8));
  return { left, right, center: (left + right) / 2, size: Math.abs(right - left) };
}

/** SegmentPoint.CalculateSegments: preferred edge resolution .125 lanes (1/3 in low quality). */
function bodySampleCount(pa, pb, lowQuality) {
  const preferred = lowQuality ? 1 / 3 : 0.125;
  const dl = Math.abs(pb.left - pa.left) / preferred;
  const dr = Math.abs(pb.right - pa.right) / preferred;
  return Math.max(2, Math.min(256, Math.ceil(Math.max(dl, dr, 2))));
}

// ---------------------------------------------------------------------------------------
// Chart normalization (tolerant of both engine.compileChart output and raw-ish notes)
// ---------------------------------------------------------------------------------------

/** Sodalite note type -> internal kind. Source-observed (SodaChartLoader.SodaNoteToGameNotes). */
const TYPE_BY_NAME = Object.freeze({
  tap: 0,
  single: 0,
  singlenote: 0,
  slide: 1,
  bullet: 2,
  void: 3,
  dash: 4,
  measureline: 5,
  beatline: 5,
  measure: 5,
});

function normalizeKind(note) {
  if (note.kind === 'measureLine' || note.kind === 'measure' || note.isMeasureLine === true) return 5;
  const raw = note.type ?? note.kind ?? note.noteType;
  if (typeof raw === 'string') {
    const key = raw.toLowerCase().replace(/[\s_-]/g, '');
    return TYPE_BY_NAME[key] !== undefined ? TYPE_BY_NAME[key] : 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

const KIND_NAMES = ['tap', 'slide', 'bullet', 'void', 'dash', 'measure'];

/** Loading precedence for note-type ordering (base render queues from chapter11 section 5). */
const QUEUE_BY_KIND = [52, 52, 2000, 49, 54, 51];

/**
 * Apply the loader's width rule:
 *   size = |right - left| * w ; center = (left + right)/2 + (w - 1)/2
 * (`right` already includes the chart's inclusive-lane +1.)
 */
function applyWidth(left, right, width) {
  const l = Number(left);
  const r = Number(right);
  const w = Number.isFinite(Number(width)) ? Number(width) : 1;
  if (!Number.isFinite(l) || !Number.isFinite(r)) return null;
  const size = Math.abs(r - l) * w;
  const center = (l + r) / 2 + (w - 1) / 2;
  return { center, size, left: center - size / 2, right: center + size / 2 };
}

/**
 * Sutherland-Hodgman clip of a world-space polygon against ONE half-plane (`value <= max`).
 *
 * Implemented per half-plane deliberately. A single pass that tests `min <= v <= max` at once
 * cannot represent a clip whose two endpoints are outside on OPPOSITE sides — the segment
 * crosses the whole slab and must survive — so the slab is applied as two sequential half-plane
 * passes (min, then max) on each axis. Works for any polygon length >= 2, which is what the rail
 * helper needs (a rail segment is a degenerate 2-point polygon).
 *
 * @param {Array<{x:number,z:number}>} polygon
 * @param {number} limit
 * @param {boolean} useX true to test X, false to test Z
 * @param {boolean} keepBelow true for `value <= limit`, false for `value >= limit`
 * @returns {Array<{x:number,z:number}>}
 */
function clipHalfPlane(polygon, limit, useX, keepBelow) {
  if (polygon.length < 2) return [];
  const value = (v) => (useX ? v.x : v.z);
  const inside = (v) => (keepBelow ? value(v) <= limit : value(v) >= limit);
  const out = [];
  const samePoint = (a, b) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.z - b.z) < 1e-9;
  const push = (p) => {
    if (out.length && samePoint(out[out.length - 1], p)) return; // avoid duplicate intersections
    out.push(p);
  };
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i];
    const previous = polygon[(i + polygon.length - 1) % polygon.length];
    const currentInside = inside(current);
    const previousInside = inside(previous);
    if (currentInside !== previousInside) {
      const cv = value(current);
      const pv = value(previous);
      const t = cv === pv ? 0 : (limit - pv) / (cv - pv);
      push({
        x: previous.x + (current.x - previous.x) * t,
        z: previous.z + (current.z - previous.z) * t,
      });
    }
    if (currentInside) push(current);
  }
  // Drop the closing duplicate that a clipped ring can produce.
  if (out.length > 1 && samePoint(out[0], out[out.length - 1])) out.pop();
  return out;
}

/** Clip a polygon to `min <= value <= max` by applying the two half-planes in sequence. */
function clipPolygonToBounds(polygon, min, max, useX) {
  const below = clipHalfPlane(polygon, min, useX, false); // value >= min
  if (below.length < 2) return [];
  return clipHalfPlane(below, max, useX, true); // value <= max
}

/**
 * Clip a world-space polyline, returning the surviving pieces.
 *
 * Each consecutive pair is clipped parametrically through both half-planes of both axes. Used for
 * the void's two outer rails, which are stroked independently so the fill's tessellation never
 * introduces interior border lines.
 *
 * @param {Array<{x:number,z:number}>} points
 * @returns {Array<Array<{x:number,z:number}>>}
 */
function clipRailToBounds(points, xMin, xMax, zMin, zMax) {
  const pieces = [];
  for (let i = 0; i + 1 < points.length; i++) {
    let seg = [points[i], points[i + 1]];
    for (const [min, max, useX] of [
      [xMin, xMax, true],
      [zMin, zMax, false],
    ]) {
      seg = clipPolygonToBounds(seg, min, max, useX);
      if (seg.length < 2) break;
    }
    if (seg.length >= 2) pieces.push(seg);
  }
  return pieces;
}

function normalizeNote(raw, index, ctx) {
  const kind = normalizeKind(raw);
  const rawPoints = Array.isArray(raw.points) && raw.points.length ? raw.points : [raw];
  const points = [];
  for (let i = 0; i < rawPoints.length; i++) {
    const p = rawPoints[i];
    const prev = points[points.length - 1];
    let beat;
    let time;
    let position;
    let left;
    let right;
    let width;
    let leftEasing;
    let rightEasing;
    let leftEaseFn;
    let rightEaseFn;
    let direction;
    if (Array.isArray(p)) {
      beat = p[0];
      left = p[1];
      right = p[2];
      leftEasing = p[3];
      rightEasing = p[4];
      width = p[5];
      time = p[6];
      position = p[7];
      direction = p[8];
    } else if (p && typeof p === 'object') {
      beat = p.beat;
      left = p.left ?? p.leftLane ?? p.lane;
      right = p.right ?? p.rightLane ?? (left !== undefined ? Number(left) + 1 : undefined);
      width = p.width ?? p.widthModifier ?? 1;
      // engine.compileChart emits leftEasing/rightEasing codes plus easeLeft/easeRight functions.
      leftEasing = p.leftEasing ?? p.easingLeft ?? p.easing;
      rightEasing = p.rightEasing ?? p.easingRight ?? p.easing;
      leftEaseFn = typeof p.easeLeft === 'function' ? p.easeLeft : undefined;
      rightEaseFn = typeof p.easeRight === 'function' ? p.easeRight : undefined;
      time = p.time;
      position = p.position ?? p.visualPosition;
      direction = p.direction;
    } else {
      continue;
    }
    const box = applyWidth(left, right, width);
    if (!box) continue;
    const beatNum = Number.isFinite(Number(beat)) ? Number(beat) : 0;
    const timeNum = Number.isFinite(Number(time)) ? Number(time) : ctx.timeAt(beatNum);
    const group = Number(raw.group) || 0;
    const posNum = Number.isFinite(Number(position))
      ? Number(position)
      : (ctx.positionAtPoint ?? ctx.positionAt)(timeNum, group);
    // Consistency guard: the state the renderer advances is `ctx.positionAt(t, group)`. If the
    // engine's stored point position disagrees with that function, a note can never reach Z=0,
    // which is exactly the "notes stop halfway" failure. Record it instead of failing silently.
    if (!ctx.positionIsPlaceholder) {
      const expected = ctx.positionAt(timeNum, group);
      if (Number.isFinite(expected)) {
        const drift = Math.abs(expected - posNum);
        if (drift > Math.max(1e-6, Math.abs(posNum) * 1e-6)) {
          ctx.reportDrift?.(raw.id ?? raw.noteId ?? `note-${index}`, drift, posNum, expected);
        }
      }
    }
    points.push({
      beat: beatNum,
      time: timeNum,
      position: posNum,
      left: box.left,
      right: box.right,
      center: box.center,
      size: box.size,
      leftEasing: leftEasing ?? raw.leftEasing ?? null,
      rightEasing: rightEasing ?? raw.rightEasing ?? null,
      easeLeft: leftEaseFn || ctx.easingFunction(leftEasing ?? raw.leftEasing),
      easeRight: rightEaseFn || ctx.easingFunction(rightEasing ?? raw.rightEasing),
      direction: direction ?? raw.direction ?? 0,
      prev,
    });
  }
  if (!points.length) return null;

  const first = points[0];
  const last = points[points.length - 1];
  const scrollModRaw = Number(raw.scrollMod ?? raw.scrollModifier ?? 1);
  const angleDeg = Number(raw.angle ?? raw.pathAngleDegrees ?? 0);

  return {
    id: raw.id ?? raw.noteId ?? `note-${index}`,
    key: String(raw.id ?? raw.noteId ?? `note-${index}`),
    /** Position in the compiled note list: a stable tie-breaker for paint order. */
    order: index,
    kind,
    kindName: KIND_NAMES[kind] || 'tap',
    group: Number(raw.group) || 0,
    queue: QUEUE_BY_KIND[kind] ?? 52,
    scrollMod: Number.isFinite(scrollModRaw) && scrollModRaw !== 0 ? scrollModRaw : 1,
    angleDegrees: Number.isFinite(angleDeg) ? angleDeg : 0,
    pathAngle: pathAngleFromDegrees(Number.isFinite(angleDeg) ? angleDeg : 0),
    points,
    first,
    last,
    startTime: first.time,
    endTime: last.time,
    segmentId: raw.segmentId ?? raw.segment ?? null,
  };
}

// ---------------------------------------------------------------------------------------
// PlayfieldRenderer
// ---------------------------------------------------------------------------------------

export class PlayfieldRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{
   *   textureUrl?: string|null,
   *   palette?: {background?:string, surface?:string, ivory?:string, mint?:string},
   *   dprCap?: number,
   *   lowQuality?: boolean,
   *   engineModule?: object,
   * }} [options]
   */
  constructor(canvas, options = {}) {
    if (!canvas) throw new Error('PlayfieldRenderer requires a canvas element');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });

    this.options = {
      textureUrl: options.textureUrl === undefined ? './assets/texture-435.png' : options.textureUrl,
      dprCap: Number(options.dprCap) > 0 ? Number(options.dprCap) : 3,
      lowQuality: !!options.lowQuality,
    };

    this.palette = Object.freeze({
      background: '#0e1422',
      surface: '#151c2e',
      ivory: '#eeeade',
      mint: '#9ee6cf',
      ...(options.palette || {}),
    });

    /** Engine easing resolver; the bundled port is used until/unless engine.js loads. */
    this.engineModule = options.engineModule && typeof options.engineModule === 'object' ? options.engineModule : null;
    this.resolveEasingFn = makeEngineEasing(this.engineModule) || ((code) => resolveEasing(code, EASING_FNS[0]));
    if (!this.engineModule) {
      loadEngine().then((mod) => {
        if (mod) {
          this.engineModule = mod;
          this.resolveEasingFn = makeEngineEasing(mod) || this.resolveEasingFn;
        }
      });
    }

    // Field/UI colours are tokens; note colours are procedural approximations (limit 1).
    this.color = {
      fieldLineStrong: rgba(this.palette.ivory, 0.5),
      fieldLineFaint: rgba(this.palette.ivory, 0.2),
      judgement: this.palette.ivory,
      onibi: this.palette.mint,
      measure: rgba(this.palette.ivory, 0.3),
      region: [this.palette.mint, this.palette.ivory, this.palette.mint],
      selection: this.palette.ivory,
      hover: this.palette.mint,
      tap: { fill: '#f3f0e6', edge: '#9ee6cf' },
      tapPast: { fill: '#7f8b89', edge: '#5d6a68' },
      // Hold body is a deeper mint so taps and the ivory head read above it; caps keep the accent.
      slide: { fill: '#3f8a77', edge: '#9ee6cf' },
      slideTap: { fill: '#f3f0e6', edge: '#9ee6cf' },
      slideTail: { fill: '#9ee6cf', edge: '#9ee6cf' },
      bullet: { fill: '#ffcf8f', edge: '#ffe6c2', dark: '#e2a75f' },
      dash: { fill: '#9ee6cf', edge: '#eeeade' },
    };

    // canvas / projection
    this.cssWidth = 960;
    this.cssHeight = 540;
    this.dpr = 1;
    this.aspect = 16 / 9;
    this.groundY = TRACK.position[1];
    this.ground = groundProjection(this.groundY);
    this._cc = null;

    // chart
    this.compiled = null;
    this.chart = null;
    this.notes = [];
    this.measureLines = [];
    this.measureRule = 'committed';
    this.duration = 0;
    this.layout = {
      groundY: TRACK.position[1],
      quaternion: CAMERA_ROTATION,
      camera: { ...CAMERA, quaternion: CAMERA_ROTATION, axes: cameraAxesFromQuaternion(CAMERA_ROTATION) },
    };

    // interaction / animation state
    this.lastTime = 0;
    this.lastOptions = {};
    this.lastPick = null;
    this.hoverId = null;
    this.onibiLane = 0;

    // Per-frame screen geometry of the visible slides, used by the combined slide outline. Built
    // by _prepareSlideFrame at the start of every render and cleared at the end; null outside a
    // frame, in which case _drawSlide keeps the legacy per-object outline. Independent of the
    // `showOverlappingSlides` option: the mode itself is decided by the caller passing `true`.
    this._slideFrame = null;

    // texture
    this.texture = null;
    this.textureReady = false;
    this.textureFailed = false;

    this._startTextureLoad();
    this.resize();
  }

  // -------------------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------------------

  /** Fetch the original track texture once. Failure degrades to affine lane markings. */
  _startTextureLoad() {
    const url = this.options.textureUrl;
    if (!url || typeof Image === 'undefined') {
      this.textureFailed = true;
      return;
    }
    const img = new Image();
    if ('decoding' in img) img.decoding = 'async';
    img.onload = () => {
      this.texture = img;
      this.textureReady = true;
    };
    img.onerror = () => {
      this.texture = null;
      this.textureReady = false;
      this.textureFailed = true;
    };
    img.src = url;
  }

  /**
   * Re-read the canvas' live layout box and rebuild the backing store.
   *
   * The renderer never writes inline CSS sizes for the canvas. Doing so is what broke the
   * responsive frame: an inline `style.width` (or the implicit inline size that comes from the
   * `width`/`height` ATTRIBUTES when no stylesheet rule applies) is a used-value input, so
   * `getBoundingClientRect()` kept reporting the previous size and the canvas was pinned to the
   * first layout forever. The stylesheet owns the CSS box (`.stage canvas { width:100%;
   * height:100% }`), and this method only reads it. Bitmap pixels per CSS pixel (`this.dpr`) are
   * derived from the ratio of the measured box to the allocated backing store instead of being
   * trusted from `window.devicePixelRatio`.
   *
   * The attribute fallback is used only when the layout box measures zero (for example a canvas
   * that is not in the document or is `display:none`). Safe to call every frame.
   *
   * @returns {boolean} whether the backing store was rebuilt
   */
  resize() {
    const canvas = this.canvas;
    const rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
    const rectW = rect ? Number(rect.width) : 0;
    const rectH = rect ? Number(rect.height) : 0;

    let cssW = rectW > 0 ? rectW : 0;
    let cssH = rectH > 0 ? rectH : 0;
    if (!(cssW > 0)) cssW = Number(canvas.clientWidth) || 0;
    if (!(cssH > 0)) cssH = Number(canvas.clientHeight) || 0;
    if (!(cssW > 0)) cssW = Number(canvas.width) || 960;
    if (!(cssH > 0)) cssH = Number(canvas.height) || 540;

    const requested = (typeof window !== 'undefined' && Number(window.devicePixelRatio)) || 1;
    const dpr = clamp(Number.isFinite(requested) ? requested : 1, 1, this.options.dprCap);
    let bw = Math.max(1, Math.round(cssW * dpr));
    let bh = Math.max(1, Math.round(cssH * dpr));

    // Guard against absurd backing stores (a huge display at dpr 3 on a wide layout) by scaling
    // both axes together, which keeps the aspect ratio and therefore the projection intact.
    const maxPixels = 4096 * 2304;
    if (bw * bh > maxPixels) {
      const shrink = Math.sqrt(maxPixels / (bw * bh));
      bw = Math.max(1, Math.round(bw * shrink));
      bh = Math.max(1, Math.round(bh * shrink));
    }

    const changed = canvas.width !== bw || canvas.height !== bh;
    if (changed) {
      canvas.width = bw;
      canvas.height = bh;
    }

    this.cssWidth = cssW;
    this.cssHeight = cssH;
    this.dpr = bh / cssH; // bitmap pixels per CSS pixel, as actually allocated
    this.aspect = bw / bh;
    this.ground = groundProjection(this.groundY, this.layout.camera);
    this._cc = null;
    return changed;
  }

  /**
   * Install a compiled chart.
   *
   * Reads the real `engine.compileChart` shape:
   *   compiled.chart                 parsed chart (DATA ONLY: no time/position functions)
   *   compiled.notes[]               id, type (0..4), typeName, direction, group, scrollMod,
   *                                  points[] {beat,time,position,left,right,center,size,width,
   *                                            leftEasing,rightEasing,easeLeft,easeRight,isLast}
   *   compiled.events[]              {kind:'measureLine', beat, time, position} etc.
   *   compiled.firstBpm / offset / duration / secondsPerBeat
   *   compiled.timeAt(beat) / timeAtGroup(beat, group) / positionAt(time, group) / beatAt(time)
   *
   * IMPORTANT (this caused a real regression): the conductor functions live on the COMPILED
   * OBJECT, not on `compiled.chart`. Resolving them from `compiled.chart` silently fell back to a
   * seconds-based toy model, so the judgement-plane state was measured in chart seconds while
   * note positions were in conductor position units. `notePosition - statePosition` was then
   * non-zero at every hit time and grew monotonically, which made notes freeze partway down the
   * field and never reach the judgement line. Both the note and the state must use the SAME
   * function.
   *
   * @param {object} compiled
   * @param {{groundY?:number, camera?:object, measureRule?:'committed'|'all'}} [options]
   */
  setChart(compiled, options = {}) {
    this.compiled = compiled || null;
    const chart = (compiled && compiled.chart) || compiled || {};
    const holders = [compiled, chart];
    /** Pick a conductor function from the compiled object first, then the parsed chart. */
    const resolveFn = (name) => {
      for (const holder of holders) {
        if (holder && typeof holder[name] === 'function') return holder[name].bind(holder);
      }
      return null;
    };

    const firstBpmRaw = Number((compiled && compiled.firstBpm) ?? chart.firstBpm);
    const firstBpm = firstBpmRaw > 0 ? firstBpmRaw : 120;
    const secondsPerBeatRaw = Number(
      (compiled && compiled.secondsPerBeat) ?? chart.secondsPerBeat ?? 60 / firstBpm,
    );
    const secondsPerBeat = Number.isFinite(secondsPerBeatRaw) && secondsPerBeatRaw > 0 ? secondsPerBeatRaw : 60 / firstBpm;
    const offset = Number((compiled && compiled.offset) ?? chart.offset) || 0;

    // Beat <-> chart seconds. `timeAt` and `beatAt` are the same affine map, so when only one is
    // exposed it is inverted exactly rather than approximated with a guessed tempo.
    const timeAtGroup = resolveFn('timeAtGroup') || resolveFn('timeAt');
    const beatAtGroup = resolveFn('beatAtGroup') || resolveFn('beatAt');
    let timeAt = timeAtGroup;
    if (!timeAt) {
      timeAt = beatAtGroup
        ? (beat) => offset + ((Number(beat) || 0) - (beatAtGroup(offset) || 0)) * secondsPerBeat
        : (beat) => offset + (Number(beat) || 0) * secondsPerBeat;
    }
    let beatAt = beatAtGroup;
    if (!beatAt) {
      beatAt = timeAtGroup
        ? (time) => {
            const t = Number(time) || 0;
            const probe = timeAtGroup(1) - timeAtGroup(0);
            return probe > 0 ? (t - timeAtGroup(0)) / probe : 0;
          }
        : (time) => ((Number(time) || 0) - offset) / secondsPerBeat;
    }

    // Visual position D(t, group). When the engine exposes no position function there is nothing
    // to advance the field with, so use the identity map over the same instants: notes stay in
    // sync with the plane (no false drift warnings) even though the resulting motion is a
    // placeholder. A seconds-valued fallback is NEVER used — that is what desynchronized notes.
    const positionResolver = resolveFn('positionAt');
    const positionAt = positionResolver || ((time) => {
      const t = Number(time);
      return Number.isFinite(t) ? t : 0;
    });

    this.chart = {
      firstBpm,
      secondsPerBeat,
      offset,
      timeAt,
      beatAt,
      positionAt,
      duration: Number((compiled && compiled.duration) ?? chart.duration) || 0,
      /** True when the conductor's own position function was found. */
      hasConductorPosition: positionResolver !== null,
    };

    this.layout = {
      groundY: Number.isFinite(Number(options.groundY)) ? Number(options.groundY) : TRACK.position[1],
      camera: { ...CAMERA, ...(options.camera || {}) },
      quaternion: (options.camera && options.camera.quaternion) || CAMERA_ROTATION,
    };
    this.layout.camera.quaternion = this.layout.quaternion;
    this.layout.camera.axes = cameraAxesFromQuaternion(this.layout.quaternion);
    this.groundY = this.layout.groundY;
    this.ground = groundProjection(this.groundY, this.layout.camera);
    this._cc = null;

    const rawNotes = (compiled && compiled.notes) || [];
    const driftWarnings = [];
    const ctx = {
      timeAt,
      positionAt,
      /**
       * With a real conductor, a point that disagrees with `positionAt` is a genuine desync. In
       * the degenerate no-conductor case every point would be flagged, so the check is skipped;
       * there `positionAt` is the placeholder identity and carries no conductor meaning.
       */
      positionIsPlaceholder: positionResolver === null,
      positionAtPoint: positionResolver === null
        ? (time) => {
            const t = Number(time);
            return Number.isFinite(t) ? t : 0;
          }
        : positionAt,
      easingFunction: (code) => this.resolveEasingFn(code),
      reportDrift: (id, drift, stored, expected) => {
        driftWarnings.push({ id, drift, stored, expected });
      },
    };
    const notes = [];
    for (let i = 0; i < rawNotes.length; i++) {
      const n = normalizeNote(rawNotes[i], i, ctx);
      if (n) notes.push(n);
    }
    this.notes = notes;
    /** Non-empty when the compiled point positions disagree with `positionAt` (see setChart). */
    this.timingWarnings = driftWarnings;

    // Measure lines live in compiled.events, not in compiled.notes.
    const rawEvents = (compiled && compiled.events) || [];
    const measures = [];
    for (let i = 0; i < rawEvents.length; i++) {
      const e = rawEvents[i];
      if (!e || e.kind !== 'measureLine') continue;
      const time = Number(e.time);
      if (!Number.isFinite(time)) continue;
      measures.push({
        beat: Number(e.beat) || 0,
        time,
        position: Number.isFinite(Number(e.position)) ? Number(e.position) : positionAt(time, e.group || 0),
        group: Number(e.group) || 0,
      });
    }
    this.measureLines = measures;
    this.measureRule = options.measureRule === 'all' ? 'all' : 'committed';

    this.duration = Number(compiled && compiled.duration) || Number(chart.duration) || 0;
    this.lastPick = null;
    return this;
  }

  /** Base game speed: savedSpeed * 160 / firstBpm (ChartPlayer lines 251-262). */
  baseScrollSpeed(savedSpeed = SCROLL.defaultSavedSpeed) {
    const bpm = this.chart ? this.chart.firstBpm : 120;
    return (Number(savedSpeed) || SCROLL.defaultSavedSpeed) * (SCROLL.adjust / bpm);
  }

  /**
   * Projection context in CSS pixels for the current canvas.
   *
   * `fitScale` is a reconstruction decision, not a recovered value: the serialized camera is a
   * fixed 60-degree VERTICAL field of view calibrated for a 16:9 viewport, so at that aspect the
   * scale is exactly 1 and the published projection table applies. On a much narrower canvas
   * (a 390-pixel phone viewport) a fixed vertical FOV magnifies the track far past the canvas
   * edges, which threw notes off the right edge. Narrower-than-16:9 viewports therefore hold the
   * HORIZONTAL field of view constant instead, i.e. `k` is capped so the full 2.5-unit track fits
   * the canvas width. Wider viewports keep `k` (and thus the vertical FOV) and simply show more.
   */
  cameraContext() {
    if (this._cc) return this._cc;
    const height = this.cssHeight || 1;
    const t = Math.tan((CAMERA.fovDegrees * Math.PI) / 360);
    const aspect = this.aspect || 16 / 9;
    const referenceAspect = 16 / 9;
    // Screen half-width per world unit is (k/zc) / width; the widest visible ground depth is the
    // near edge, so constraining there keeps the whole track on screen.
    const zcNear = groundProjection(this.groundY, this.layout.camera).zc;
    // Required: (TRACK.width/2) * (k / zcNear) <= width/2  =>  k <= width * zcNear / TRACK.width
    const maximumK = ((this.cssWidth || 1) * zcNear) / TRACK.width;
    const baseK = height / (2 * t);
    const fitScale = Math.min(1, maximumK / baseK);
    this._cc = {
      width: this.cssWidth,
      height,
      aspect,
      /** world units -> CSS pixels at depth zc: (k * fitScale) / zc */
      k: baseK * fitScale,
      baseK,
      fitScale,
      referenceAspect,
      ground: this.ground,
    };
    return this._cc;
  }

  /** Project a world point to canvas CSS pixels. Null when at or behind the near plane. */
  project(x, y, z) {
    const cc = this.cameraContext();
    const { xc, yc, zc } = worldToCamera(x, y, z, this.layout.camera);
    if (!(zc > CAMERA.near)) return null;
    const k = cc.k / zc;
    return { x: cc.width / 2 + xc * k, y: cc.height / 2 - yc * k, zc };
  }

  /** Ground-plane projection (constant depth) in CSS pixels. */
  projectGround(x, z) {
    const cc = this.cameraContext();
    const g = cc.ground;
    const k = cc.k / g.zc;
    return {
      x: cc.width / 2 + x * k,
      y: cc.height / 2 - (g.yc + (z - TRACK.position[2]) * g.scale) * k,
    };
  }

  // -------------------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------------------

  /**
   * Draw one frame.
   *
   * @param {number} time chart seconds
   * @param {object} [options]
   * @param {number} [options.scrollSpeed=1] user multiplier; base speed derives from firstBpm
   * @param {number} [options.savedSpeed=1] saved scroll-speed setting used to derive base speed
   * @param {number} [options.statePosition] visual position of the judgement plane
   * @param {boolean} [options.overlays=true] judgement line, measures, regions
   * @param {string|null} [options.selectedId=null] highlighted note id
   * @param {string|null} [options.hoverId] pick-preview highlight id
   * @param {number} [options.onibiLane] reference-only lane state (clamped to +/-5.675); no marker drawn
   * @param {number[]} [options.zonePress] [A,B,C] press ages in seconds
   * @param {number} [options.coverA] [options.coverB] [options.coverC] cover alpha 0..1
   * @param {boolean} [options.covers] enable tutorial-style region covers
   * @param {number} [options.groundAlpha] ground layer opacity (default 1)
   * @param {boolean} [options.showOverlappingSlides=false] `false`/omitted strokes only the outer
   *        boundary of the union of visible slide bodies; `true` keeps the per-object outlines
   *        (see COMBINED SLIDE OUTLINE in the file header)
   */
  render(time, options = {}) {
    const ctx = this.ctx;
    if (!ctx) return this;

    this.resize();
    this.lastTime = Number(time) || 0;
    this.lastOptions = options;
    const t = this.lastTime;
    const cc = this.cameraContext();

    const overlays = options.overlays !== false;
    const selectedId = options.selectedId === undefined || options.selectedId === null ? null : String(options.selectedId);
    const hoverId = options.hoverId === undefined ? (this.hoverId === null ? null : String(this.hoverId)) : options.hoverId === null ? null : String(options.hoverId);
    const userMult = Number.isFinite(Number(options.scrollSpeed)) ? Number(options.scrollSpeed) : SCROLL.defaultSavedSpeed;
    const speed = this.baseScrollSpeed(options.savedSpeed) * userMult;
    // Notes live in scroll groups, and each group has its own conductor timeline, so the
    // judgement-plane visual position is per group. `statePosition` (group 0) is only used for
    // the overlays and the measure lines, which are created on group 0.
    const groupStates = new Map();
    const stateAt = (group) => {
      const g = Number(group) || 0;
      if (groupStates.has(g)) return groupStates.get(g);
      let value;
      if (Number.isFinite(Number(options.statePosition)) && !g) value = Number(options.statePosition);
      else value = this.chart ? this.chart.positionAt(t, g) : 0;
      if (!Number.isFinite(value)) value = 0;
      groupStates.set(g, value);
      return value;
    };
    const statePosition = stateAt(0);

    if (Number.isFinite(Number(options.onibiLane))) {
      this.onibiLane = clamp(Number(options.onibiLane), -ONIBI.centerClampLanes, ONIBI.centerClampLanes);
    }

    // Frame clear in device pixels, then switch to CSS-pixel space.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this.palette.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';

    const groundAlpha = Number.isFinite(Number(options.groundAlpha)) ? clamp(Number(options.groundAlpha), 0, 1) : 1;

    // 1. ground
    this._drawGround(ctx, groundAlpha);
    // 2. regional surfaces (TrackEffects A/B/C geometry)
    if (overlays) this._drawRegions(ctx, options);
    // 3. Void body/rails are a fixed underlay, not a whole-object depth-sorted overlay.
    // Source materials use body queue 0 / border 50 and sit below note surfaces (.012 vs .02).
    // Canvas has no depth buffer: sorting a long void by one endpoint flips its occlusion when
    // that endpoint enters/leaves the view. Keep its layer independent of its visibility anchor.
    for (const n of this.notes) {
      if (n.kind !== 3) continue;
      const z = this._visibleAnchorZ(n, stateAt(n.group), speed);
      if (z !== null) this._drawVoid(ctx, n, z, stateAt, speed);
    }
    // 4. measure lines (base queue 51, above the void border)
    this._drawMeasureLines(ctx, statePosition, speed);
    // 5. judgement line only: this read-only viewer has no controllable player marker.
    if (overlays) this._drawJudgementLine(ctx);
    // 6. ordinary notes, painter's algorithm: far first; bullets later among equal depth
    const visible = [];
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.kind === 5) continue;
      const z = this._visibleAnchorZ(n, stateAt(n.group), speed);
      if (z === null) continue;
      visible.push({ n, z });
    }
    visible.sort(paintOrder);

    // Combined slide outline: one prepass caches the projected body polygons of every visible
    // slide so an edge can be tested against the union of all of them (see _drawSlideOutline).
    // The cache does not move any drawing: each note is still filled and stroked inside its own
    // _drawNote call at its normal painter position.
    // `showOverlappingSlides` is false by default (clean union) and true selects the legacy
    // per-object outlines; any other value keeps the default.
    const cleanSlides = options.showOverlappingSlides !== true;
    this._prepareSlideFrame(visible, stateAt, speed, cleanSlides);

    const highlight = (n, z) => {
      if (selectedId !== null && selectedId === n.key) this._drawHighlight(ctx, n, z, stateAt, speed, true);
      else if (hoverId !== null && hoverId === n.key) this._drawHighlight(ctx, n, z, stateAt, speed, false);
    };
    // Flat layer (paintOrder puts it first): slide bodies, then every slide cap above all bodies,
    // then the overlays of this layer. Voids were already drawn in their fixed underlay pass.
    let flat = 0;
    while (flat < visible.length && paintLayer(visible[flat].n) === 0) flat++;
    for (let i = 0; i < flat; i++) {
      const { n, z } = visible[i];
      if (n.kind !== 3) this._drawNote(ctx, n, z, stateAt, speed, t, cleanSlides, 'body');
    }
    const capDepth = (n, point) => this._zOf(point, stateAt(n.group), speed, n.scrollMod);
    for (const which of ['tail', 'head']) {
      const caps = [];
      for (let i = 0; i < flat; i++) {
        const n = visible[i].n;
        if (n.kind !== 1 || (which === 'tail' && n.points.length < 2)) continue;
        const z = capDepth(n, which === 'head' ? n.first : n.last);
        if (z !== null) caps.push({ n, z });
      }
      caps.sort((a, b) => depthKey(b.z) - depthKey(a.z) || a.n.order - b.n.order);
      for (const cap of caps) this._drawSlideCaps(ctx, cap.n, stateAt, speed, which);
    }
    for (let i = 0; i < flat; i++) highlight(visible[i].n, visible[i].z);
    for (let i = flat; i < visible.length; i++) {
      const { n, z } = visible[i];
      this._drawNote(ctx, n, z, stateAt, speed, t, cleanSlides);
      highlight(n, z);
    }

    this._slideFrame = null;

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    void cc;
    return this;
  }

  // -------------------------------------------------------------------------------------
  // Depth helpers
  // -------------------------------------------------------------------------------------

  /** VisualPositionToZPosition for a note's leading point. */
  _noteZ(note, statePosition, speed) {
    return this._zOf(note.first, statePosition, speed, note.scrollMod);
  }

  /**
   * Drawability anchor for the render list.
   *
   * Single notes use their own leading point. A slide/void, however, is drawn interval by
   * interval and `SegmentPoint.Draw` only drops an interval when BOTH of its endpoints are
   * outside the same side of the guard — so a long object whose head has passed behind the
   * camera must still be drawn while its tail is on screen. The anchor is therefore the largest
   * visible point Z (falling back to the largest Z overall), which also gives the nearest-first
   * sort a sensible key.
   *
   * @returns {number|null} null when every point is outside the guard
   */
  _visibleAnchorZ(note, statePosition, speed) {
    if (note.kind !== 1 && note.kind !== 3) {
      const z = this._noteZ(note, statePosition, speed);
      return z !== null && this._visible(z) ? z : null;
    }
    let best = null;
    let maxAny = null;
    for (let i = 0; i < note.points.length; i++) {
      const z = this._zOf(note.points[i], statePosition, speed, note.scrollMod);
      if (z === null) continue;
      if (maxAny === null || z > maxAny) maxAny = z;
      if (this._visible(z) && (best === null || z > best)) best = z;
    }
    return best !== null ? best : maxAny;
  }

  _zOf(point, statePosition, speed, scrollMod) {
    const z = (point.position - statePosition) * scrollMod * speed * SCROLL.positionMultiplier;
    return Number.isFinite(z) ? z : null;
  }

  /** Single/segment CPU drawing rejects centres/whole segments outside -.3 .. 10.2. */
  _visible(z) {
    return z >= CULL.back && z <= CULL.front;
  }

  /** SegmentPoint.Draw's guard: reject only when both ends are outside the same side. */
  _segmentVisible(zA, zB) {
    if (zA > CULL.front && zB > CULL.front) return false;
    if (zA < CULL.back && zB < CULL.back) return false;
    return true;
  }

  /** Z for a sample inside an interval, mirroring the body TRS scale on startZ..endZ. */
  _lerpZ(startZ, endZ, s) {
    return lerp(startZ, endZ, s);
  }

  // -------------------------------------------------------------------------------------
  // Ground
  // -------------------------------------------------------------------------------------

  /**
   * Project the four ground-quad corners with the SAME per-point perspective as every note.
   *
   * An earlier version projected the ground through a single constant depth ("the ground plane
   * is perpendicular to the camera, so its depth is constant"). That premise is wrong: the
   * camera's forward axis is `(0,-sin p, cos p)` and the ground normal is `(0,1,0)`, whose dot
   * product is `cos p` = .866, not 0, so ground depth varies from 1.4213 at Z=-.25 to 10.0816 at
   * Z=9.75. The published table in `analysis/playfield-layout-v4.json` and chapter 11 confirm
   * the per-point values (far edge 0.855479 viewport Y), so the affine version was ~2.5x too
   * tall and pushed the whole field off screen.
   *
   * @returns {{nearL:object, nearR:object, farR:object, farL:object, k:number}|null}
   */
  _groundQuad() {
    const cc = this.cameraContext();
    const g = this.ground;
    const y = this.groundY;
    const hw = TRACK.width / 2;
    // Surface Y for the judgement plane / far edge: the quad is a flat mesh at groundY, so all
    // four corners share it; the constant-depth reference is only used for the void shading.
    const nearL = this.project(-hw, y, TRACK.nearZ);
    const nearR = this.project(hw, y, TRACK.nearZ);
    const farR = this.project(hw, y, TRACK.farZ);
    const farL = this.project(-hw, y, TRACK.farZ);
    if (!nearL || !nearR || !farR || !farL) return null;
    // Attach the world Z of each corner for the perspective-correct depth interpolation.
    return {
      nearL: { ...nearL, depth: TRACK.nearZ },
      nearR: { ...nearR, depth: TRACK.nearZ },
      farR: { ...farR, depth: TRACK.farZ },
      farL: { ...farL, depth: TRACK.farZ },
      k: cc.k,
      ground: g,
    };
  }

  /**
   * Intersect the ground quad with a horizontal screen scanline, returning the two boundary
   * points and the world Z at each.
   *
   * The screen edge of a projected straight world edge is itself a straight screen segment, so
   * `x` is a plain LINEAR interpolation along the edge. Only the world depth needs the
   * perspective-correct reciprocal interpolation (`k = 1/z`): a straight line in world XZ maps
   * to a straight line in screen X, but world Z does not vary linearly with screen Y. Applying
   * the reciprocal weight to `x` as well (an earlier revision did) bows the quad's sides into a
   * dome.
   */
  _groundBoundary(quad, y) {
    const edge = (a, b) => {
      const dy = b.y - a.y;
      const t = Math.abs(dy) < 1e-9 ? 0 : (y - a.y) / dy;
      const x = a.x + (b.x - a.x) * t;
      // Reciprocal (perspective-correct) weight for the out-of-screen depth axis.
      const za = a.depth;
      const zb = b.depth;
      const k = za === zb ? t : (1 / za + (1 / zb - 1 / za) * t);
      const z = k === 0 ? za : 1 / k;
      return { x, z, t };
    };
    // Left boundary: farL -> nearL. Right boundary: farR -> nearR.
    return {
      left: edge(quad.farL, quad.nearL),
      right: edge(quad.farR, quad.nearR),
    };
  }

  _drawGround(ctx, alpha) {
    const quad = this._groundQuad();
    if (!quad) return;
    const cc = this.cameraContext();

    const quadTop = Math.min(quad.nearL.y, quad.farL.y, quad.nearR.y, quad.farR.y);
    const quadBottom = Math.max(quad.nearL.y, quad.farL.y, quad.nearR.y, quad.farR.y);
    const top = clamp(Math.floor(quadTop), 0, cc.height);
    const bottom = clamp(Math.ceil(quadBottom), 0, cc.height);

    ctx.save();
    ctx.globalAlpha = alpha;

    // Base plate: the visible highway surface under the texture.
    if (bottom > top) {
      ctx.beginPath();
      ctx.moveTo(quad.farL.x, quad.farL.y);
      ctx.lineTo(quad.farR.x, quad.farR.y);
      ctx.lineTo(quad.nearR.x, quad.nearR.y);
      ctx.lineTo(quad.nearL.x, quad.nearL.y);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, quad.farL.y, 0, quad.nearL.y);
      grad.addColorStop(0, 'rgba(16,23,25,0.35)');
      grad.addColorStop(0.35, 'rgba(14,20,22,0.72)');
      grad.addColorStop(1, 'rgba(10,15,17,0.95)');
      ctx.fillStyle = grad;
      ctx.fill();
    }

    if (this.textureReady && this.texture) {
      this._drawGroundQuad(ctx, quad, top, bottom, 1);
      // Track (1): additive world-space UI overlay of the same texture, serialized image alpha
      // .4196078. save/restore so the composite mode cannot leak into later layers.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * 0.41960784792900085;
      this._drawGroundQuad(ctx, quad, top, bottom, 1);
      ctx.restore();
    } else {
      this._drawMarkingFallback(ctx, quad, top, bottom);
    }

    // Hard edges: the quad is 2.5 wide; nothing is drawn outside it.
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = rgba(this.palette.ivory, 0.18);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(quad.farL.x, quad.farL.y);
    ctx.lineTo(quad.nearL.x, quad.nearL.y);
    ctx.moveTo(quad.farR.x, quad.farR.y);
    ctx.lineTo(quad.nearR.x, quad.nearR.y);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Draw the texture onto the ground quad.
   *
   * The quad's screen boundary is straight on both sides, so a translation+scale transform per
   * scanline maps a texture strip onto it. Horizontal scale is a plain linear ratio (a straight
   * world edge projects to a straight screen edge); only the texture V coordinate encodes depth,
   * and it is derived from the perspective-correct Z returned by `_groundBoundary`.
   */
  _drawGroundQuad(ctx, quad, top, bottom, layerAlpha, fixedStep) {
    const img = this.texture;
    if (!img || bottom <= top) return;
    const cc = this.cameraContext();
    const sh = img.naturalHeight || img.height || TEXTURE_MARKINGS.height;
    const sw = img.naturalWidth || img.width || TEXTURE_MARKINGS.width;
    const span = bottom - top;
    const step = fixedStep || (span > 2.2 * cc.height ? 2 : 1);
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * layerAlpha;
    const depthRange = TRACK.farZ - TRACK.nearZ;
    const invDepthRange = depthRange === 0 ? 0 : 1 / depthRange;

    for (let y = top; y < bottom; y += step) {
      const band = this._groundBoundary(quad, y);
      if (!(band.right.x - band.left.x > 0.2)) continue;
      // Texture V from the world depth at this scanline; near edge -> V=1.
      const v = clamp((band.left.z - TRACK.nearZ) * invDepthRange, 0, 1);
      const vTop = clamp(lerp(TRACK.nearV, TRACK.farV, v), 0, 1);
      // The U span is clamped to the canvas, so off-screen quad width costs nothing.
      const rowSpan = band.right.x - band.left.x;
      const u0 = clamp((0 - band.left.x) / rowSpan, 0, 1);
      const u1 = clamp((cc.width - band.left.x) / rowSpan, 0, 1);
      if (!(u1 > u0)) continue;
      const x0 = band.left.x + u0 * rowSpan;
      const x1 = band.left.x + u1 * rowSpan;
      const sy = (1 - vTop) * sh;
      // One step of screen Y corresponds to this many texture rows at this scanline. The
      // derivative varies along the quad, so measure it between this row and the next.
      const next = this._groundBoundary(quad, Math.min(bottom, y + step));
      const vNext = clamp((next.left.z - TRACK.nearZ) * invDepthRange, 0, 1);
      const vTopNext = clamp(lerp(TRACK.nearV, TRACK.farV, vNext), 0, 1);
      const syNext = (1 - vTopNext) * sh;
      const dhTex = clamp(Math.abs(syNext - sy) + 0.5, 0.5, sh);
      const dy = Math.max(sh - sy, 0.5);
      const dh = clamp(Math.min(dhTex, dy), 0.5, sh);
      // A translation+scale basis draws the strip without per-row beginPath/closePath overhead.
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.transform((x1 - x0) / ((u1 - u0) * sw), 0, 0, step / dh, x0, y - 0.5);
      ctx.drawImage(img, u0 * sw, sy, (u1 - u0) * sw, dh, 0, 0, (u1 - u0) * sw, dh);
      ctx.restore();
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = prevAlpha;
  }

  /**
   * Lane markings derived from the measured authored pixel columns, used only when the track
   * texture has not loaded (or failed). Every mark is drawn inside the projected ground
   * quad, so the marks share the field's perspective instead of forming full-height columns.
   */
  _drawMarkingFallback(ctx, quad, top, bottom) {
    const cc = this.cameraContext();
    const sw = TEXTURE_MARKINGS.width;
    const pxToWorld = (px) => -1.25 + 2.5 * ((px + 0.5) / sw);
    const mark = (px, widthWorld, value) => {
      const worldX = pxToWorld(px);
      const leftWorld = worldX - widthWorld / 2;
      const rightWorld = worldX + widthWorld / 2;
      const p0 = this.project(leftWorld, this.groundY, TRACK.nearZ);
      const p1 = this.project(rightWorld, this.groundY, TRACK.nearZ);
      const p2 = this.project(rightWorld, this.groundY, TRACK.farZ);
      const p3 = this.project(leftWorld, this.groundY, TRACK.farZ);
      if (!p0 || !p1 || !p2 || !p3) return;
      if (Math.max(p0.x, p1.x, p2.x, p3.x) < 0 || Math.min(p0.x, p1.x, p2.x, p3.x) > cc.width) return;
      const strength = clamp(value / TEXTURE_MARKINGS.strongValue, 0, 1);
      // The authored texture fades along its length: bright near, black far. The projected marks
      // are straight lines, so the quad above is already the straight-edge projection.
      const grad = ctx.createLinearGradient(0, p0.y, 0, p3.y);
      grad.addColorStop(0, rgba(this.palette.ivory, 0.55 * strength));
      grad.addColorStop(0.4, rgba(this.palette.ivory, 0.18 * strength));
      grad.addColorStop(1, rgba(this.palette.ivory, 0));
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.lineTo(p3.x, p3.y);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    };
    void top;
    void bottom;
    for (let i = 0; i < TEXTURE_MARKINGS.faintColumns.length; i++) {
      mark(TEXTURE_MARKINGS.faintColumns[i], 2.5 / sw, TEXTURE_MARKINGS.faintValue);
    }
    for (let i = 0; i < TEXTURE_MARKINGS.strongColumns.length; i++) {
      mark(TEXTURE_MARKINGS.strongColumns[i], 5 / sw, TEXTURE_MARKINGS.strongValue);
    }
  }
  /**
   * TrackEffects A/B/C: three regional planes ~.83 wide x 10 long at X ~ -.83 / 0 / +.83.
   * Projected with the same per-point perspective as the ground quad, so the regions lie on the
   * field instead of forming full-height columns.
   */
  _drawRegions(ctx, options) {
    const half = 5 / 12; // .83333 / 2
    const centers = [-5 / 6, 0, 5 / 6];

    const zonePress = Array.isArray(options.zonePress) ? options.zonePress : null;
    const covers = [options.coverA, options.coverB, options.coverC];

    for (let i = 0; i < 3; i++) {
      let alpha = 0.045;
      if (zonePress) {
        const age = Number(zonePress[i]);
        if (Number.isFinite(age) && age >= 0) {
          // Press clip 1/6 s ramps the material scalar 1 -> .5; release 1/12 s ramps .5 -> 0.
          const pressT = clamp(age / (1 / 6), 0, 1);
          const releaseT = clamp((age - 1 / 6) / (1 / 12), 0, 1);
          const v = pressT < 1 ? 1 - 0.5 * pressT : 0.5 * (1 - releaseT);
          alpha = 0.04 + 0.18 * v;
        }
      }
      if (options.covers) alpha = Math.max(alpha, 0.22 * clamp(Number(covers[i]) || 0, 0, 1));
      if (alpha <= 0.002) continue;

      const a = this.project(centers[i] - half, this.groundY, TRACK.nearZ);
      const b = this.project(centers[i] + half, this.groundY, TRACK.nearZ);
      const c = this.project(centers[i] + half, this.groundY, TRACK.farZ);
      const d = this.project(centers[i] - half, this.groundY, TRACK.farZ);
      if (!a || !b || !c || !d) continue;
      const grad = ctx.createLinearGradient(0, a.y, 0, d.y);
      const tone = this.color.region[i];
      grad.addColorStop(0, rgba(tone, alpha * 0.25));
      grad.addColorStop(0.55, rgba(tone, alpha * 0.7));
      grad.addColorStop(1, rgba(tone, alpha * 0.12));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

  /**
   * Measure lines. The engine emits these as `compiled.events` entries of kind `measureLine`
   * (SodaChartLoader.CreateMeasureLines appends them to group 0); they are not part of
   * `compiled.notes`. MeasureLine.GenerateMesh spans the full logical width (lanes -6..6) with
   * a .02 inset and mesh Z +-.0625, and SingleNote.Draw adds +.01 to a vertex Y already at .01.
   */
  _drawMeasureLines(ctx, statePosition, speed) {
    const lines = this.measureLines;
    if (!lines || !lines.length) return;
    const t = this.lastTime;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const z = this._zOf(line, statePosition, speed, 1);
      if (z === null || !this._visible(z)) continue;
      const visible = this.measureRule === 'committed' ? line.time <= t : true;
      if (!visible) continue;
      const quad = this._tapQuad(line, null, z, 0, 0.0625, -6 + 0.02, 6 - 0.02);
      if (!quad) continue;
      ctx.beginPath();
      ctx.moveTo(quad[0].x, quad[0].y);
      for (let v = 1; v < quad.length; v++) ctx.lineTo(quad[v].x, quad[v].y);
      ctx.closePath();
      ctx.fillStyle = this.color.measure;
      ctx.fill();
    }
  }

  // -------------------------------------------------------------------------------------
  // Judgement line / Onibi
  // -------------------------------------------------------------------------------------

  /**
   * JudgementLine504: Plane10209 (2.5 x .2 world) textured by the authored 800x80
   * JudgementLine alpha, which is two ~21px end bars with a soft interior glow.
   */
  _drawJudgementLine(ctx) {
    const y = JUDGEMENT.position[1];
    const zHalf = JUDGEMENT.depth / 2;
    const corners = [
      this.project(-JUDGEMENT.width / 2, y, -zHalf),
      this.project(JUDGEMENT.width / 2, y, -zHalf),
      this.project(JUDGEMENT.width / 2, y, zHalf),
      this.project(-JUDGEMENT.width / 2, y, zHalf),
    ];
    if (corners.some((c) => !c)) return;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();

    const a = this.project(-JUDGEMENT.width / 2, y, 0);
    const b = this.project(JUDGEMENT.width / 2, y, 0);
    if (a && b) {
      const grad = ctx.createLinearGradient(a.x, 0, b.x, 0);
      const bar = rgba(this.color.judgement, 0.9);
      grad.addColorStop(0, bar);
      grad.addColorStop(0.06, bar);
      grad.addColorStop(0.16, rgba(this.color.judgement, 0.12));
      grad.addColorStop(0.5, rgba(this.color.judgement, 0.06));
      grad.addColorStop(0.84, rgba(this.color.judgement, 0.12));
      grad.addColorStop(0.94, bar);
      grad.addColorStop(1, bar);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = rgba(this.color.judgement, 0.5);
    }
    ctx.fill();

    // The bar remains the timing reference; omit the viewer-only center debug dot.
  }

  /** Reference-only Onibi helper; normal viewer render never draws a player marker.
   * World X = lane * laneToUnityPos, world Y ~ .215, world Z = 0.
   */
  _drawOnibi(ctx) {
    const p = this.project(this.onibiLane * LANES.toWorld, ONIBI.worldY, 0);
    if (!p) return;
    const cc = this.cameraContext();
    const k = cc.k / Math.max(0.001, p.zc);
    const r = Math.max(3, 0.06 * k);
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.2);
    grad.addColorStop(0, rgba(this.palette.mint, 0.95));
    grad.addColorStop(0.45, rgba(this.palette.mint, 0.3));
    grad.addColorStop(1, rgba(this.palette.mint, 0));
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // -------------------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------------------

  /**
   * @param {Function} stateAt (group) -> visual position of the judgement plane for that group
   * @param {boolean} [cleanSlides] combined-outline mode for slides (see _drawSlide)
   */
  _drawNote(ctx, note, z, stateAt, speed, t, cleanSlides, part) {
    const statePosition = stateAt(note.group);
    switch (note.kind) {
      case 1:
        this._drawSlide(ctx, note, z, stateAt, speed, cleanSlides, part);
        break;
      case 2:
        this._drawBullet(ctx, note, z);
        break;
      case 3:
        this._drawVoid(ctx, note, z, stateAt, speed);
        break;
      case 4:
        this._drawDash(ctx, note, z);
        break;
      default:
        this._drawTap(ctx, note.first, note.pathAngle, z, t, this.color.tap, this.color.tapPast);
        break;
    }
    void statePosition;
  }

  /**
   * Tap.SingleNote draw path: quad with .02-lane inset per side, local Z +-.125, vertex Y .01,
   * placed by Translate(PathAngle*(0,0,z) + (0,.01,0)) so the surface sits near Y=.02.
   *
   * @param {object} point eased lane edges (left/right in lanes)
   * @param {Function|null} pathAngle (x,z) -> (x,z); pass null for MeasureLine, which builds
   *        its mesh in TestNote.Initialize and does NOT rotate it at draw time
   * @param {number} z leading-edge visual Z
   * @param {number} [extraY] extra world Y (measure lines are .01 lower than taps)
   * @param {number} [zMesh] mesh Z half-extent (default .125; measure lines use .0625)
   * @param {number} [leftOverride] [rightOverride] lane edges to use instead of the point's
   */
  _tapQuad(point, pathAngle, z, extraY = 0, zMesh = 0.125, leftOverride, rightOverride) {
    const inset = 0.02;
    const leftLane = leftOverride !== undefined ? leftOverride : point.left + inset;
    const rightLane = rightOverride !== undefined ? rightOverride : point.right - inset;
    const lx = leftLane * LANES.toWorld;
    const rx = rightLane * LANES.toWorld;
    const y = JUDGEMENT.tapSurfaceY + extraY;
    const local = [
      [rx, -zMesh],
      [lx, -zMesh],
      [lx, zMesh],
      [rx, zMesh],
    ];
    const out = [];
    for (let i = 0; i < 4; i++) {
      const lz = local[i][1];
      const raw = z + lz;
      // Clip the mesh's own Z span to the shader bounds for the same reason the body is clipped:
      // a vertex between the guard and the camera would project to an enormous coordinate.
      const zz = clamp(raw, CULL.shaderNear, CULL.shaderFar);
      const [wx, wz] = pathAngle ? pathAngle(local[i][0], zz) : [local[i][0], zz];
      const p = this.project(wx, y, wz);
      if (!p) return null;
      out.push(p);
    }
    return out;
  }

  /**
   * Trace one closed ring into the current path without beginning or filling it, optionally
   * reversing the point order. Callers use this to put several body rings into a single path so
   * the whole slide silhouette is antialiased once instead of once per interval.
   *
   * @param {boolean} [reverse] trace back-to-front, normalizing this ring's orientation
   */
  _traceRing(ctx, poly, reverse) {
    if (!poly || poly.length < 3) return;
    if (reverse) {
      ctx.moveTo(poly[poly.length - 1].x, poly[poly.length - 1].y);
      for (let i = poly.length - 2; i >= 0; i--) ctx.lineTo(poly[i].x, poly[i].y);
    } else {
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    }
    ctx.closePath();
  }

  _fillQuad(ctx, quad, fill, stroke, lineWidth) {
    if (!quad) return;
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.lineWidth = lineWidth || 1;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }

  /** Tap: mesh X embeds lane edges with the .02-lane inset; placement is Z-only. */
  _drawTap(ctx, point, pathAngle, z, time, base, pastColors) {
    const quad = this._tapQuad(point, pathAngle, z, 0);
    if (!quad) return;
    const c = time > point.time ? pastColors : base;
    this._fillQuad(ctx, quad, c.fill, c.edge, 1.25);
  }

  /** Dash: absent from the recovered corpus; footprint reuses the tap mesh with a hue + arrow. */
  _drawDash(ctx, note, z) {
    const quad = this._tapQuad(note.first, note.pathAngle, z, 0);
    if (!quad) return;
    this._fillQuad(ctx, quad, this.color.dash.fill, this.color.dash.edge, 1.5);
    const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
    const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
    // SodaChartLoader: direction != 0 => DashDirection.Right.
    const dir = Number(note.first.direction) !== 0 ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(cx + dir * 5, cy);
    ctx.lineTo(cx - dir * 4, cy - 3.5);
    ctx.lineTo(cx - dir * 4, cy + 3.5);
    ctx.closePath();
    ctx.fillStyle = this.palette.surface;
    ctx.globalAlpha = 0.8;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------------------------
  // Combined slide outline (option `showOverlappingSlides:false`)
  // -------------------------------------------------------------------------------------

  /**
   * Cache the projected screen geometry of every visible slide for this frame.
   *
   * Called once per frame before the note loop. Nothing is drawn here: the cache exists so that
   * `_drawSlide` can test an edge against the union of ALL slide geometry while still painting
   * inside its own `_drawNote` call (no deferred pass, so no other note changes occlusion).
   *
   * @param {Array<{n:object,z:number}>} visible painter-sorted note list
   * @param {Function} stateAt (group) -> judgement-plane position
   * @param {number} speed scroll speed in world units per position unit
   * @param {boolean} enabled skip the whole prepass when the legacy outline is selected
   */
  _prepareSlideFrame(visible, stateAt, speed, enabled) {
    this._slideFrame = null;
    if (!enabled) return;
    const polys = [];
    const byNote = new Map();
    for (let i = 0; i < visible.length; i++) {
      const { n, z } = visible[i];
      if (n.kind !== 1) continue;
      const geometry = this._collectSlideGeometry(n, z, stateAt, speed);
      if (!geometry) continue;
      byNote.set(n, geometry);
      for (let k = 0; k < geometry.polys.length; k++) polys.push(geometry.polys[k]);
    }
    this._slideFrame = { polys, byNote, grid: makeSlideEdgeGrid(polys, this.cssWidth, this.cssHeight) };
  }

  /**
   * Cached frame geometry for one slide: the prepass result, or an on-demand collection when
   * `_drawSlide` is invoked outside a full frame (direct calls and tests). Null in legacy mode,
   * where no union context is needed.
   */
  _slideGeometry(note, z, stateAt, speed) {
    if (!this._slideFrame) return null;
    if (this._slideFrame.byNote.has(note)) return this._slideFrame.byNote.get(note);
    const geometry = this._collectSlideGeometry(note, z, stateAt, speed);
    if (geometry) this._slideFrame.byNote.set(note, geometry);
    return geometry;
  }

  /**
   * Project the whole of one slide into screen-space geometry: every drawable interval's closed
   * body polygon plus its head and tail tap quads.
   *
   * Uses the same `_segmentScreenRuns` sampler as the fill, so the union boundary always lies
   * exactly on the painted fill edges. Every polygon is registered with its bounding box, which
   * is the only broad phase the edge test uses.
   *
   * @returns {null|{intervalCount:number,polys:Array,bodyPolys:Array,rings:Array,runs:Array,headQuad:Array|null,tailQuad:Array|null}}
   */
  _collectSlideGeometry(note, z, stateAt, speed) {
    const points = note.points;
    const statePosition = stateAt(note.group);
    const runs = [];
    const polys = [];
    const bodyPolys = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const zA = this._zOf(a, statePosition, speed, note.scrollMod);
      const zB = this._zOf(b, statePosition, speed, note.scrollMod);
      if (zA === null || zB === null || !this._segmentVisible(zA, zB)) continue;
      const easeL = this._easing(a, 'left');
      const easeR = this._easing(a, 'right');
      const geometry = this._segmentScreenRuns(a, b, zA, zB, easeL, easeR, false, note.pathAngle);
      if (!geometry) continue;
      const run = geometry.runs[0];
      runs.push(run);
      const entry = { poly: run.poly, note, bbox: polygonBounds(run.poly) };
      polys.push(entry);
      bodyPolys.push(entry);
    }

    // The head/tail tap meshes are part of the drawn slide, so they join the union: a cap sitting
    // just outside the body still hides another body's rail edge where it overlaps, exactly as the
    // legacy per-interval stroke is hidden by the tap quad drawn on top of it.
    const quads = [];
    let headQuad = null;
    const zHead = this._zOf(points[0], statePosition, speed, note.scrollMod);
    if (zHead !== null && this._visible(zHead)) {
      headQuad = this._tapQuad(points[0], note.pathAngle, zHead, 0);
      if (headQuad) {
        const entry = { poly: headQuad, note, bbox: polygonBounds(headQuad) };
        quads.push(entry);
        polys.push(entry);
      }
    }
    let tailQuad = null;
    if (points.length > 1) {
      const last = points[points.length - 1];
      const zLast = this._zOf(last, statePosition, speed, note.scrollMod);
      if (zLast !== null && this._visible(zLast)) {
        tailQuad = this._tapQuad(last, note.pathAngle, zLast, 0);
        if (tailQuad) {
          const entry = { poly: tailQuad, note, bbox: polygonBounds(tailQuad) };
          quads.push(entry);
          polys.push(entry);
        }
      }
    }
    // A slide with a visible head tap but no drawable interval (single point, or every interval
    // culled) still has geometry: the tap quad is part of the union.
    if (!polys.length) return null;
    return {
      intervalCount: bodyPolys.length,
      polys,
      bodyPolys,
      quads,
      rings: bodyPolys.concat(quads),
      runs,
      headQuad,
      tailQuad,
    };
  }

  /**
   * Slide. SegmentPoint.Draw places the body with
   *   TRS(PathAngle*(0,0,startZ) + (0,.01,0), PathAngle, (1,1,endZ-startZ))
   * and the body mesh's sample rails come from independently eased left/right lane edges at
   * .125-lane resolution (1/3 in low quality). Each interval is owned by its START point, so
   * the easing used for an interval is the start point's ??an end/skip point has none.
   *
   * Two outline modes (option `showOverlappingSlides`, default `false`):
   *   false / undefined (DEFAULT) — combined outline: fill as always, then stroke only the pieces
   *     of the union boundary that are not covered by another visible slide body. Interior
   *     transverse joins, doubled rails of overlapping slides and caps buried in another body
   *     disappear.
   *   true (LEGACY) — per-object outline: every interval is filled AND stroked separately, so
   *     overlapping objects keep their individual outlines.
   * Both modes run inside this one call at the note's normal painter position; nothing is
   * deferred and no other note's occlusion changes.
   *
   * @param {boolean} [cleanOutline] override for the option (render() passes its own value);
   *        omitted -> this.lastOptions, where only an explicit `true` selects the legacy outline
   */
  _drawSlide(ctx, note, z, stateAt, speed, cleanOutline, part = 'all') {
    if (part === 'caps') {
      this._drawSlideCaps(ctx, note, stateAt, speed);
      return;
    }
    const caps = part !== 'body';
    const points = note.points;
    const first = points[0];
    const statePosition = stateAt(note.group);
    const useClean = cleanOutline === undefined
      ? this.lastOptions.showOverlappingSlides !== true
      : cleanOutline === true;
    const geometry = useClean ? this._slideGeometry(note, z, stateAt, speed) : null;
    // `z` is the painter's-algorithm ANCHOR (the largest visible point Z) so that a slide whose
    // head is behind the camera still sorts by its tail. The head tap must NOT use it: that made
    // the head jump to the tail's depth whenever the visible endpoint changed. Recompute the
    // head's own depth here.
    const zHead = this._zOf(first, statePosition, speed, note.scrollMod);

    // Clean mode paints every fill of this note FIRST and strokes the union boundary once at the
    // end of the call, so no stroke can be covered by a later fill of the same note.
    // `geometry.rings` is already the whole candidate set (body intervals plus this note's tap
    // quads), so a head-only slide still strokes its tap boundary.
    const rings = geometry ? geometry.rings : [];
    if (!caps) {
      // Caps are painted later by _drawSlideCaps, above every slide body.
    } else if (!geometry) {
      // Legacy per-object outline (or no cached frame): the head tap is filled AND stroked.
      if (zHead !== null && this._visible(zHead)) {
        this._fillQuad(ctx, this._tapQuad(first, note.pathAngle, zHead, 0), this.color.slideTap.fill, this.color.slideTap.edge, 1.25);
      }
    } else if (geometry.headQuad) {
      this._fillQuad(ctx, geometry.headQuad, this.color.slideTap.fill, null, 1);
    }

    // Every interval is tested on its OWN two endpoints, so a slide whose head has passed
    // behind the camera keeps drawing the tail that is still on screen.
    const visibleIntervals = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const zA = this._zOf(a, statePosition, speed, note.scrollMod);
      const zB = this._zOf(b, statePosition, speed, note.scrollMod);
      if (zA === null || zB === null) continue;
      if (!this._segmentVisible(zA, zB)) continue;
      const easeL = this._easing(a, 'left');
      const easeR = this._easing(a, 'right');
      visibleIntervals.push({ a, b, zA, zB, easeL, easeR });
    }
    if (geometry) {
      // A compound fill paints the union of this note's interval silhouettes as ONE path. Two
      // adjacent intervals share a bit-identical cross-section, and two separate fills each
      // antialias that shared edge, so the background bleeds through as a hairline
      // (body*(1-(1-c0)(1-c1)) + bg*(1-c0)(1-c1)); the interior join stroke that used to hide it is
      // removed by the union outline. One path has no interior edge at all.
      //
      // Orientation is normalized PER RING, never globally: a global flip negates every winding and
      // leaves an opposite pair cancelling. Only simple rings are safe here — a self-crossing ring
      // has opposite-wound interior regions that can cancel against its own overlap — so such a
      // slide falls back to the per-interval fills below, unchanged.
      //
      // The rings come from the geometry ALREADY collected this frame rather than being sampled a
      // third time: same sampler inputs, same cached points, no null case to guard, and the fill
      // edges therefore coincide with the outline edges by construction.
      const bodyRings = geometry.bodyPolys.map((entry) => entry.poly);
      let allSimple = bodyRings.length > 0;
      for (let i = 0; i < bodyRings.length && allSimple; i++) {
        if (bodyRings[i].length < 3 || !ringIsSimple(bodyRings[i])) allSimple = false;
      }
      if (allSimple) {
        ctx.beginPath();
        for (let i = 0; i < bodyRings.length; i++) this._traceRing(ctx, bodyRings[i], ringSignedArea(bodyRings[i]) < 0);
        ctx.fillStyle = this.color.slide.fill;
        ctx.fill();
      } else {
        // A self-crossing (or otherwise non-simple) body keeps the literal per-interval fills, each
        // as its OWN path so the nonzero rule is evaluated exactly as the legacy renderer did. The
        // cached body is used directly rather than re-sampled: it is already the drawable set, and
        // nothing here may paint an internal edge stroke — clean mode strokes the union boundary
        // once, elsewhere.
        ctx.fillStyle = this.color.slide.fill;
        for (let i = 0; i < bodyRings.length; i++) {
          ctx.beginPath();
          this._traceRing(ctx, bodyRings[i], false);
          ctx.fill();
        }
      }
    } else {
      // Legacy mode (`showOverlappingSlides:true`): per-interval fill AND its own edge stroke.
      for (let i = 0; i < visibleIntervals.length; i++) {
        const iv = visibleIntervals[i];
        this._drawSegmentBody(ctx, iv.a, iv.b, iv.zA, iv.zB, iv.easeL, iv.easeR, this.color.slide, false, note.pathAngle, null);
      }
    }

    // Tail tap for the final point (fill only in clean mode).
    if (!caps) {
      // See above: painted by _drawSlideCaps.
    } else if (points.length > 1 && !geometry) {
      const last = points[points.length - 1];
      const zLast = this._zOf(last, statePosition, speed, note.scrollMod);
      if (zLast !== null && this._visible(zLast)) {
        this._fillQuad(ctx, this._tapQuad(last, note.pathAngle, zLast, 0), this.color.slideTail.fill, this.color.slideTail.edge, 1.25);
      }
    } else if (geometry && geometry.tailQuad) {
      this._fillQuad(ctx, geometry.tailQuad, this.color.slideTail.fill, null, 1);
    }

    // One stroke pass for the whole note, after all of its fills.
    if (geometry && rings.length) {
      const clip = this._slideOutlineClip(note, geometry);
      this._drawSlideOutline(ctx, rings, clip);
    }
  }

  /**
   * Head and tail caps of one slide, filled and outlined at their own depths.
   *
   * render() paints these after EVERY slide body. A cap sits on the track surface like a tap, so
   * another slide's body must never cover it; sorting whole slides by their anchor flipped that
   * order whenever an anchor jumped, and caps lying on a long hold blinked in and out. render()
   * also paints all tails before all heads, each sorted by its OWN depth, so a head sitting on the
   * previous hold's tail never swaps places with it.
   *
   * @param {'both'|'head'|'tail'} [which]
   */
  _drawSlideCaps(ctx, note, stateAt, speed, which = 'both') {
    const points = note.points;
    const statePosition = stateAt(note.group);
    const zHead = this._zOf(points[0], statePosition, speed, note.scrollMod);
    if (which !== 'tail' && zHead !== null && this._visible(zHead)) {
      this._fillQuad(ctx, this._tapQuad(points[0], note.pathAngle, zHead, 0), this.color.slideTap.fill, this.color.slideTap.edge, 1.25);
    }
    if (which !== 'head' && points.length > 1) {
      const last = points[points.length - 1];
      const zLast = this._zOf(last, statePosition, speed, note.scrollMod);
      if (zLast !== null && this._visible(zLast)) {
        this._fillQuad(ctx, this._tapQuad(last, note.pathAngle, zLast, 0), this.color.slideTail.fill, this.color.slideTail.edge, 1.25);
      }
    }
  }

  /**
   * Combined-outline context for one slide: the cached polygons that occlude it plus the probe
   * distance and union-membership test used by the two-sided edge rule.
   *
   * Occluders are every visible slide's geometry (body intervals and tap quads), INCLUDING this
   * slide's own polygons: a polygon's interior contains its own boundary, which is exactly what
   * makes a shared seam between two adjacent bodies read inside on both sides and disappear. No
   * polygon is excluded for the ring being tested.
   */
  _slideOutlineClip(note, geometry) {
    const frame = this._slideFrame;
    if (!frame || !frame.byNote.has(note)) return null;
    // Every visible polygon joins the union, this slide's own included. The result set is simply
    // the frame's polygons: `_prepareSlideFrame` registered this slide's geometry in the frame, so
    // the same entry objects are already present and none is added twice.
    void geometry;
    const clipPolys = frame.polys.slice();
    // Probe distance: a hairline relative to the canvas, so the side test resolves boundaries of
    // ordinary width while never bridging a polygon thinner than a pixel.
    const eps = Math.max(1e-6, 1e-6 * (this.cssWidth || 0));
    const grid = frame.grid || null;
    const membership = makeMembership(clipPolys, grid);
    return { clipPolys, membership, eps, grid };
  }

  /**
   * Stroke all exposed boundary pieces of one slide.
   *
   * Candidate edges are the CLOSED rings of every drawn interval (both rails and both end caps)
   * plus the head and tail tap quads. The union test then removes whatever is interior to the
   * slide's own other intervals or to another visible slide's geometry. Emitting every interval's
   * ring (rather than only the first and last cap) matters when an interval is clipped by the near
   * plane: the drawn run then starts or ends mid-interval, and that clipped cross-section is a real
   * exposed cap.
   *
   * @param {Array<{poly:Array}>} rings closed candidate rings; the per-ring entry object is only
   *        used to read `poly`
   */
  _drawSlideOutline(ctx, rings, clip) {
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = this.color.slide.edge;
    this._drawEdgePieces(ctx, rings, clip);
  }

  /**
   * Stroke a set of candidate edges, keeping only the pieces that survive the union test.
   * Each entry is a CLOSED ring (its last->first segment is included). The union membership
   * INCLUDES the ring's own polygon: a polygon's interior contains its own boundary, so a shared
   * seam (whose two probes land in the two adjacent bodies) reads inside on both sides and is
   * dropped, while an outer rail reads inside on one side and outside on the other and survives.
   */
  _drawEdgePieces(ctx, edges, clip) {
    if (!clip) return;
    ctx.beginPath();
    let drew = false;
    // Pieces already painted, bucketed by a.x at 1e-5 px (wider than the 1e-6 match tolerance), so
    // a match can only sit in the same or a neighbouring bucket. Same answer as a full scan.
    const seen = new Map();
    const bucketOf = (x) => Math.floor(x * 1e5);
    for (let i = 0; i < edges.length; i++) {
      const entry = edges[i];
      const ring = entry && entry.poly ? entry.poly : entry;
      if (!ring || ring.length < 2) continue;
      const membership = clip.membership;
      const closed = ring.length > 2;
      const segCount = closed ? ring.length : ring.length - 1;
      for (let k = 0; k < segCount; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        if (!a || !b) continue;
        if (!(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(b.x) && Number.isFinite(b.y))) continue;
        const pieces = clipEdgeToBoundary(a, b, clip.clipPolys, membership, clip.eps, clip.grid);
        for (let j = 0; j < pieces.length; j++) {
          const piece = pieces[j];
          // Coincident pieces (a shared cap between two intervals, a duplicated edge) are painted
          // once. The first occurrence in this batch is kept, and since the batch follows the
          // painter order (far to near) that first occurrence is the earlier-drawn object.
          let duplicate = false;
          const key = bucketOf(piece.a.x);
          for (let d = -1; d <= 1 && !duplicate; d++) {
            const bucket = seen.get(key + d);
            if (!bucket) continue;
            for (let s = 0; s < bucket.length; s++) {
              const other = bucket[s];
              if (
                Math.abs(other.a.x - piece.a.x) < 1e-6 &&
                Math.abs(other.a.y - piece.a.y) < 1e-6 &&
                Math.abs(other.b.x - piece.b.x) < 1e-6 &&
                Math.abs(other.b.y - piece.b.y) < 1e-6
              ) { duplicate = true; break; }
            }
          }
          if (duplicate) continue;
          if (Number.isFinite(key)) {
            if (!seen.has(key)) seen.set(key, []);
            seen.get(key).push(piece);
          }
          ctx.moveTo(piece.a.x, piece.a.y);
          ctx.lineTo(piece.b.x, piece.b.y);
          drew = true;
        }
      }
    }
    if (drew) ctx.stroke();
  }

  /**
   * Resolve the easing for one side of an interval. engine.compileChart already provides
   * `easeLeft`/`easeRight` functions; a bare numeric code falls back to the engine resolver and
   * then to the bundled port. `null` (a segment end point) means linear, which is unreachable
   * for a real interval because only non-final points carry an easing pair.
   */
  _easing(point, side) {
    const direct = side === 'left' ? point.easeLeft : point.easeRight;
    if (typeof direct === 'function') return direct;
    const code = side === 'left' ? point.leftEasing : point.rightEasing;
    const fn = this.resolveEasingFn(code);
    return typeof fn === 'function' ? fn : EASING_FNS[0];
  }
  /**
   * Sampled, projected screen geometry of one eased body interval.
   *
   * The interval is sampled in full and then split into runs of CONSECUTIVE PROJECTABLE samples.
   * An earlier revision returned as soon as any single sample failed `project()`, which means the
   * whole void (or slide) vanished the instant its head crossed the camera's near plane — the
   * "void spazzes out when the beginning touches the judgement line" report. A sample fails to
   * project when its camera depth `zc <= near`, i.e. when that cross-section is at or behind the
   * camera; the remaining cross-sections are still perfectly visible and must keep drawing.
   *
   * Runs are the shared source of truth for the fill, the (legacy) interval stroke and the
   * combined-outline pass, so all three always describe exactly the same geometry.
   *
   * @returns {null|{runs:Array<{left:Array,right:Array,poly:Array,head:object,tail:object}>}}
   */
  _segmentScreenRuns(a, b, zA, zB, easeL, easeR, isVoid, pathAngle) {
    const n = bodySampleCount(a, b, this.options.lowQuality);
    // Horizontal padding: .1 lane for slides, none for voids (VoidPoint.GenerateBodyMesh).
    const pad = isVoid ? 0 : 0.1;
    // Body vertex Y is .01; slides translate by +.01 (surface ~.02), voids translate by
    // +.002 (surface ~.012) and add +.005 for the border.
    const yBody = isVoid ? 0.012 : JUDGEMENT.tapSurfaceY;
    const cc = this.cameraContext();
    // Clip band for a cross-section magnified near the camera. Recorded for
    // reference/diagnostics: after world-space clipping to the shader bounds there is no
    // screen-space rejection here, because a surviving vertex is geometrically valid even when it
    // lands off-screen (the near shader bound legitimately projects high above the canvas).
    const nearX = -cc.width * 8;
    const farX = cc.width * 9;
    const maxY = cc.height * 9;

    // Full-resolution geometry, computed once, then clipped to the shader Z span by EXACT
    // boundary intersection (interpolating the crossing) rather than by dropping samples. That
    // keeps the sample grid independent of the crossing, so nothing pops when a boundary moves.
    const samples = [];
    for (let i = 0; i < n; i++) {
      const s = i / (n - 1);
      let lLane;
      let rLane;
      if (isVoid) {
        lLane = lerp(a.left, b.left, clamp(easeL(s), -8, 8));
        rLane = lerp(a.right, b.right, clamp(easeR(s), -8, 8));
      } else {
        const box = hitboxAt(a, b, s, easeL, easeR);
        lLane = box.left + pad;
        rLane = box.right - pad;
      }
      // The two draw paths apply PathAngle differently:
      //   slide  TRS(PathAngle*(0,0,startZ) + (0,.01,0), PathAngle, (1,1,len))
      //          => the start translation is rotated, and the mesh z (0..len) is scaled BEFORE
      //             the rotation, so both lane and z are turned:
      //             world = PathAngle(laneWorldX, s*len)
      //   void   TRS((0,.002,startZ), PathAngle, (1,1,len))
      //          => the start translation is NOT rotated, and the mesh z (0..len) is scaled
      //             before the rotation, so:
      //             world = PathAngle(laneWorldX, s*(zB-zA)) + (0, 0, zA)
      // These differ, so they are computed separately rather than sharing one expression.
      const z = lerp(zA, zB, s);
      let wl;
      let zl;
      let wr;
      let zr;
      if (isVoid) {
        const [vxl, vzl] = pathAngle(lLane * LANES.toWorld, s * (zB - zA));
        const [vxr, vzr] = pathAngle(rLane * LANES.toWorld, s * (zB - zA));
        wl = vxl;
        zl = zA + vzl;
        wr = vxr;
        zr = zA + vzr;
      } else {
        [wl, zl] = pathAngle(lLane * LANES.toWorld, z);
        [wr, zr] = pathAngle(rLane * LANES.toWorld, z);
      }
      // Clamp to the shader's world Z span (-.25..9.75) for the same reason the GPU discards
      // those fragments: a cross-section between the CPU guard and the camera would project to an
      // enormous coordinate. Because the bound is a constant Z plane, only the z component moves
      // and the x components are untouched.
      samples.push({
        lx: wl,
        lz: clamp(zl, CULL.shaderNear, CULL.shaderFar),
        wlx: wl,
        rx: wr,
        rz: clamp(zr, CULL.shaderNear, CULL.shaderFar),
        wrx: wr,
      });
    }

    // Project every sample. `null` means "at or behind the near plane"; those samples cannot be
    // drawn, but they do not invalidate their neighbours.
    const projected = samples.map((sample) => {
      const pl = this.project(sample.lx, yBody, sample.lz);
      const pr = this.project(sample.rx, yBody, sample.rz);
      if (!pl || !pr) return null;
      const valid =
        Number.isFinite(pl.x) &&
        Number.isFinite(pl.y) &&
        Number.isFinite(pr.x) &&
        Number.isFinite(pr.y);
      return valid ? { l: pl, r: pr } : null;
    });

    // Longest run of consecutive projectable samples; prefer a run that is actually in frame, so
    // a cross-section magnified to a huge off-screen coordinate does not dominate.
    const ranges = [];
    let current = null;
    for (let i = 0; i < projected.length; i++) {
      if (projected[i]) {
        if (!current) current = { from: i, to: i };
        else current.to = i;
      } else if (current) {
        ranges.push(current);
        current = null;
      }
    }
    if (current) ranges.push(current);
    if (!ranges.length) return null;
    let best = null;
    for (const range of ranges) {
      if (range.to - range.from < 1) continue;
      const inFrame = this._runInFrame(projected, range);
      if (!best) best = { range, inFrame };
      else if (inFrame && !best.inFrame) best = { range, inFrame };
      else if (inFrame === best.inFrame && range.to - range.from > best.range.to - best.range.from) {
        best = { range, inFrame };
      }
    }
    if (!best) return null;

    const drawn = [];
    for (let i = best.range.from; i <= best.range.to; i++) {
      drawn.push({ l: projected[i].l, r: projected[i].r });
    }
    const left = drawn.map((d) => d.l);
    const right = drawn.map((d) => d.r);
    const poly = left.concat([...right].reverse());
    const mid = Math.floor(drawn.length / 2);
    const runs = [{
      left,
      right,
      poly,
      head: { a: left[0], b: right[0] },
      tail: { a: left[left.length - 1], b: right[right.length - 1] },
      mid: { a: left[mid], b: right[mid] },
    }];
    void nearX;
    void farX;
    void maxY;
    void cc;
    return { runs };
  }

  /** True when a sample range projects inside the clip band rather than to a huge coordinate. */
  _runInFrame(projected, range) {
    const nearX = -this.cameraContext().width * 8;
    const farX = this.cameraContext().width * 9;
    const maxY = this.cameraContext().height * 9;
    for (let i = range.from; i <= range.to; i++) {
      const p = projected[i];
      if (!p) continue;
      for (const v of [p.l, p.r]) {
        if (v.x < nearX || v.x > farX || v.y < -maxY || v.y > maxY) return false;
      }
    }
    return true;
  }

  /**
   * Draw one eased body interval.
   *
   * @param {object} a start point (owns the easings)
   * @param {object} b end point
   * @param {number} zA start visual Z
   * @param {number} zB end visual Z
   * @param {Function} easeL left-edge easing
   * @param {Function} easeR right-edge easing
   * @param {{fill:string,edge:string}} colors slide palette (void ignores it)
   * @param {boolean} isVoid VoidPoint body/border rules
   * @param {Function} pathAngle the note's (x,z) -> (x,z) rotation
   * @param {{clipPolys:Array,inside:Function,eps:number}|null} [clip] combined-outline context:
   *        when present the interval is filled WITHOUT its own stroke and the exposed boundary
   *        pieces are stroked instead (option `showOverlappingSlides`).
   */
  _drawSegmentBody(ctx, a, b, zA, zB, easeL, easeR, colors, isVoid, pathAngle, clip) {
    const geometry = this._segmentScreenRuns(a, b, zA, zB, easeL, easeR, isVoid, pathAngle);
    if (!geometry) return;
    const leftPoly = geometry.runs[0].left;
    const rightPoly = geometry.runs[0].right;

    ctx.beginPath();
    ctx.moveTo(leftPoly[0].x, leftPoly[0].y);
    for (let i = 1; i < leftPoly.length; i++) ctx.lineTo(leftPoly[i].x, leftPoly[i].y);
    for (let i = rightPoly.length - 1; i >= 0; i--) ctx.lineTo(rightPoly[i].x, rightPoly[i].y);
    ctx.closePath();
    ctx.fillStyle = colors.fill;
    ctx.fill();
    if (clip) {
      // Combined outline: the union boundary is stroked once by _drawSlideOutline, so an interval
      // must not paint its own (interior) stroke here.
      return geometry.runs[0];
    }
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = colors.edge;
    ctx.stroke();
    return geometry.runs[0];
  }

  /**
   * Clip each void cell in WORLD space, then project only what survives.
   *
   * Applies the two tests shader-922 actually performs, both of which return RGBA 0 outside the
   * box rather than discarding: the Z span (`worldZ < centerZ-extentZ || worldZ > centerZ+extentZ`)
   * and the `_CullPosition` / `_CullSize` X extent (world X +- track half width, from the Track
   * AABB). Both are planar operations, so Sutherland-Hodgman on the world quad is exact, and
   * intersections interpolate world X and Z, preserving the world X the shade needs.
   *
   * @param {Array<Array<{x:number,z:number}>>} worldCells unclipped world quads
   * @param {Array<{x:number,z:number}>} [leftRail] world polyline of the left edge
   * @param {Array<{x:number,z:number}>} [rightRail] world polyline of the right edge
   */
  _fillVoidBodyClipped(ctx, worldCells, leftRail, rightRail) {
    // Shader922 uses DstAlpha/One, not SrcAlpha/OneMinusSrcAlpha. On our opaque
    // ground, Canvas additive blending is the practical approximation; source-over with
    // maskShadeCss's RGB colour would instead paint an opaque slab over earlier geometry.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const zMin = CULL.shaderNear;
    const zMax = CULL.shaderFar;
    const xMin = -TRACK.width / 2;
    const xMax = TRACK.width / 2;
    const yBody = 0.012;
    for (const cell of worldCells) {
      let poly = clipPolygonToBounds(cell, xMin, xMax, true);
      if (poly.length < 3) continue;
      poly = clipPolygonToBounds(poly, zMin, zMax, false);
      if (poly.length < 3) continue;
      const screen = [];
      let broken = false;
      for (const v of poly) {
        const p = this.project(v.x, yBody, v.z);
        if (!p) {
          broken = true;
          break;
        }
        screen.push(p);
      }
      if (broken || screen.length < 3) continue;
      // The shader's grey is a function of abs(viewX); use the cell centre's world X.
      let sx = 0;
      for (const v of poly) sx += v.x;
      const viewX = sx / poly.length;
      ctx.beginPath();
      ctx.moveTo(screen[0].x, screen[0].y);
      for (let i = 1; i < screen.length; i++) ctx.lineTo(screen[i].x, screen[i].y);
      ctx.closePath();
      ctx.fillStyle = maskShadeCss(viewX, 0.35);
      ctx.fill();
    }
    // Border mesh (X +-.02 world, Y +.005) strokes ONLY the two original outer rails, each
    // clipped independently. Stroking every tessellation cell would draw a full interior grid.
    ctx.strokeStyle = maskShadeCss(0.6, 0.75);
    ctx.lineWidth = 1.25;
    for (const rail of [leftRail, rightRail]) {
      if (!rail || rail.length < 2) continue;
      const pieces = clipRailToBounds(rail, xMin, xMax, zMin, zMax);
      for (const piece of pieces) {
        let started = false;
        ctx.beginPath();
        for (const v of piece) {
          const p = this.project(v.x, yBody, v.z);
          if (!p) continue;
          if (!started) {
            ctx.moveTo(p.x, p.y);
            started = true;
          } else {
            ctx.lineTo(p.x, p.y);
          }
        }
        if (started) ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * VoidPoint.Draw: TRS((0,.002,startZ), PathAngle, (1,1,endZ-startZ)); no last-segment draw.
   *
   * This is the ONLY void draw path. It builds the eased world rails, tessellates them into
   * world quads, and hands cells plus rails to the world clipper — so the fill, the XZ mask and
   * the border all come from one implementation.
   */
  _drawVoid(ctx, note, z, stateAt, speed) {
    const points = note.points;
    const statePosition = stateAt(note.group);
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const zA = this._zOf(a, statePosition, speed, note.scrollMod);
      const zB = this._zOf(b, statePosition, speed, note.scrollMod);
      if (zA === null || zB === null) continue;
      if (!this._segmentVisible(zA, zB)) continue;
      const easeL = this._easing(a, 'left');
      const easeR = this._easing(a, 'right');
      // VoidPoint.GenerateBodyMesh samples the eased edges at the preferred resolution; that
      // tessellation is the fill, and the same samples form the two outer rails.
      const n = bodySampleCount(a, b, this.options.lowQuality);
      const leftRail = [];
      const rightRail = [];
      for (let k = 0; k < n; k++) {
        const s = k / (n - 1);
        const laneLeft = lerp(a.left, b.left, clamp(easeL(s), -8, 8));
        const laneRight = lerp(a.right, b.right, clamp(easeR(s), -8, 8));
        // VoidPoint.Draw does NOT rotate its start translation; the mesh z (0..len) is scaled and
        // then rotated, so world = PathAngle(laneWorldX, s*(zB-zA)) + (0, 0, zA).
        const [lx, lz] = note.pathAngle(laneLeft * LANES.toWorld, s * (zB - zA));
        const [rx, rz] = note.pathAngle(laneRight * LANES.toWorld, s * (zB - zA));
        leftRail.push({ x: lx, z: zA + lz });
        rightRail.push({ x: rx, z: zA + rz });
      }
      const cells = [];
      for (let k = 0; k + 1 < n; k++) {
        cells.push([leftRail[k], rightRail[k], rightRail[k + 1], leftRail[k + 1]]);
      }
      this._fillVoidBodyClipped(ctx, cells, leftRail, rightRail);
    }
    // VoidPoint.DrawLastSegment is intentionally empty: an end point draws nothing.
    void z;
  }

  /**
   * Bullet.Draw: uniform scale 30, rotation PathAngle*Euler(0,180,0), position
   * PathAngle*(0,0,z) + (centre * laneToUnityPos, .1, 0). The mesh itself (mesh912) was not
   * decoded, so the silhouette below is the documented approximation.
   */
  _drawBullet(ctx, note, z) {
    const x = note.first.center * LANES.toWorld;
    const [wx, wz] = note.pathAngle(x, z);
    const base = this.project(wx, JUDGEMENT.bulletSurfaceY, wz);
    if (!base) return;
    const cc = this.cameraContext();
    const k = cc.k / Math.max(0.001, base.zc);
    const halfW = Math.max(2, 0.0615 * k);
    const depth = Math.max(2, 0.075 * k);
    const tipX = base.x;
    const tipY = base.y - depth;
    const bl = { x: base.x - halfW, y: base.y + depth * 0.35 };
    const br = { x: base.x + halfW, y: base.y + depth * 0.35 };
    const bc = { x: base.x, y: base.y + depth * 0.12 };
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bc.x, bc.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    const grad = ctx.createLinearGradient(bl.x, bl.y, br.x, br.y);
    grad.addColorStop(0, this.color.bullet.dark);
    grad.addColorStop(0.5, this.color.bullet.fill);
    grad.addColorStop(1, this.color.bullet.edge);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = rgba(this.color.bullet.edge, 0.9);
    ctx.stroke();
    // Highlight facet to read as a solid gem rather than a flat triangle.
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(base.x + halfW * 0.35, base.y + depth * 0.2);
    ctx.lineTo(base.x, base.y + depth * 0.4);
    ctx.closePath();
    ctx.fillStyle = rgba('#ffffff', 0.18);
    ctx.fill();
  }

  // -------------------------------------------------------------------------------------
  // Highlights
  // -------------------------------------------------------------------------------------

  _drawHighlight(ctx, note, z, stateAt, speed, selected) {
    const color = selected ? this.color.selection : this.color.hover;
    ctx.save();
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.strokeStyle = rgba(color, selected ? 0.95 : 0.6);
    if (selected) {
      ctx.shadowColor = rgba(color, 0.8);
      ctx.shadowBlur = 12;
    }
    // Outline exactly what was drawn: head/tail taps at their own depths plus every body interval.
    for (const poly of this._noteSilhouette(note, z, stateAt, speed)) this._strokeQuad(ctx, poly);
    ctx.restore();
  }

  _strokeQuad(ctx, quad) {
    if (!quad) return;
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
    ctx.closePath();
    ctx.stroke();
  }

  /**
   * Screen polygons covering a note as drawn, shared by highlight and picking.
   *
   * `z` is the painter's anchor. Single notes are drawn there, but a slide/void anchor is the
   * largest visible point Z, so the head and every interval use their OWN depths (as _drawSlide
   * and _drawVoid do). Each polygon is kept separate: concatenating rings into one polygon makes
   * it self-intersecting and breaks the point-in-polygon test.
   */
  _noteSilhouette(note, z, stateAt, speed) {
    if (note.kind !== 1 && note.kind !== 3) {
      const quad = this._tapQuad(note.first, note.pathAngle, z, 0.001);
      return quad ? [quad] : [];
    }
    const isVoid = note.kind === 3;
    const statePosition = stateAt(note.group);
    const points = note.points;
    const polys = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const zA = this._zOf(a, statePosition, speed, note.scrollMod);
      const zB = this._zOf(b, statePosition, speed, note.scrollMod);
      if (zA === null || zB === null || !this._segmentVisible(zA, zB)) continue;
      const geometry = this._segmentScreenRuns(a, b, zA, zB, this._easing(a, 'left'), this._easing(a, 'right'), isVoid, note.pathAngle);
      if (geometry) polys.push(geometry.runs[0].poly);
    }
    if (!isVoid) {
      // VoidPoint draws no head/tail mesh; slides draw a tap at both ends.
      const ends = points.length > 1 ? [points[0], points[points.length - 1]] : [points[0]];
      const caps = [];
      for (const point of ends) {
        const zp = this._zOf(point, statePosition, speed, note.scrollMod);
        if (zp === null || !this._visible(zp)) continue;
        const quad = this._tapQuad(point, note.pathAngle, zp, 0.001);
        if (quad) caps.push(quad);
      }
      return caps.concat(polys);
    }
    return polys;
  }

  // -------------------------------------------------------------------------------------
  // Picking
  // -------------------------------------------------------------------------------------

  /** Current visual state used by render/pick, shared so both agree. */
  _frameState() {
    const userMult = Number.isFinite(Number(this.lastOptions.scrollSpeed)) ? Number(this.lastOptions.scrollSpeed) : SCROLL.defaultSavedSpeed;
    const speed = this.baseScrollSpeed(this.lastOptions.savedSpeed) * userMult;
    const t = this.lastTime;
    const groupStates = new Map();
    const stateAt = (group) => {
      const g = Number(group) || 0;
      if (groupStates.has(g)) return groupStates.get(g);
      let value;
      if (Number.isFinite(Number(this.lastOptions.statePosition)) && !g) value = Number(this.lastOptions.statePosition);
      else value = this.chart ? this.chart.positionAt(t, g) : 0;
      if (!Number.isFinite(value)) value = 0;
      groupStates.set(g, value);
      return value;
    };
    return { speed, stateAt, t };
  }

  /**
   * Screen-space hit test in CSS pixels relative to the canvas' top-left corner. Uses the
   * geometry from the most recent render() call and returns the note id under the point.
   * @returns {string|null}
   */
  pick(x, y) {
    if (!this.notes.length) {
      this.lastPick = null;
      return null;
    }
    const { speed, stateAt } = this._frameState();
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;

    // The topmost hit wins: the one render() paints last (see paintOrder).
    let best = null;
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.kind === 5) continue;
      const z = this._visibleAnchorZ(n, stateAt(n.group), speed);
      if (z === null) continue;
      if (!this._noteSilhouette(n, z, stateAt, speed).some((poly) => pointInPolygon(px, py, poly))) continue;
      const hit = { n, z };
      if (!best || paintOrder(best, hit) < 0) best = hit;
    }
    this.lastPick = best ? best.n.key : null;
    return this.lastPick;
  }

  /** Convenience: pick straight from a pointer/mouse event on the canvas. */
  pickFromEvent(event) {
    if (!event || !Number.isFinite(Number(event.clientX))) return null;
    const rect = this.canvas.getBoundingClientRect();
    return this.pick(Number(event.clientX) - rect.left, Number(event.clientY) - rect.top);
  }

  /** Reset transient interaction/texture state without rebuilding the renderer. */
  dispose() {
    this.texture = null;
    this.textureReady = false;
    this.notes = [];
    this.measureLines = [];
    this.compiled = null;
    this.lastPick = null;
  }
}

export default PlayfieldRenderer;
