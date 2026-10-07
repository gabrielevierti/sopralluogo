/* How much a measurement can be trusted.

   Every picked point records WHERE it was picked (its provenance): the ground plane seen by
   the camera, a wall fitted as a plane, free-form surface from monocular depth, or surface
   reconstructed behind objects (invented content). The 1-sigma error of a distance combines:

   - random error of each end point (pixel picking + calibration residual), which grows with
     the square of the distance on the ground and is much larger on free-form surface;
   - camera tilt (pitch) error, which moves every ground point of the same camera radially:
     correlated, so it partly cancels for two points at a similar distance;
   - scale error, proportional to the length: from the assumed person height when the scale
     is automatic, from the reference measurement when the operator corrected it.

   Linearised, first order. Formulas and constants are documented in docs/METODO.md. */
import * as THREE from "three";

export const ASSUMED_HEIGHT_REL = 0.04; // mean height of the people seen: ±4% (1 sigma), systematic
export const TAPE_SIGMA_M = 0.01;       // reference measured on site with a tape: ±1 cm
export const FREEFORM_REL = 0.10;       // monocular depth on free-form surface: ±10% of the range
export const WALL_FACTOR = 1.5;         // fitted walls: ground error at that distance, inflated

export const SOURCE_LABEL = {
  ground: "suolo",
  wall: "muro",
  surface: "superficie stimata",
  fill: "superficie ricostruita",
  plane: "suolo ipotizzato piano",
  unknown: "provenienza non registrata",
};

const camGeom = new Map();
/** Camera centre, height and intrinsics in scene coordinates. */
export function cameraGeometry(cam) {
  if (camGeom.has(cam)) return camGeom.get(cam);
  const M = cam.alignmentM.clone().multiply(cam.worldFromCam);
  const C = new THREE.Vector3().setFromMatrixPosition(M);
  const cal = cam.calibration ?? {};
  const g = {
    C, M, inv: M.clone().invert(),
    h: Math.max(0.3, C.y),
    f: cam.camera.K.fx,
    K: cam.camera.K,
    sigmaPx: Math.max(1.5, 0.5 * (cal.median_reprojection_px ?? 3)),
    sigmaPitch: THREE.MathUtils.degToRad(cal.std_pitch_deg ?? 0.5),
    sigmaHeightRel: (cal.std_height_m ?? 0.05) / Math.max(0.3, C.y),
  };
  camGeom.set(cam, g);
  return g;
}

/** Is a scene point inside the image of this camera, in front of it? */
export function inFrame(cam, p) {
  const g = cameraGeometry(cam);
  const q = new THREE.Vector3(...p).applyMatrix4(g.inv);
  if (q.z <= 0.05) return false;
  const u = g.K.fx * q.x / q.z + g.K.cx, v = g.K.fy * q.y / q.z + g.K.cy;
  return u >= 0 && v >= 0 && u <= g.K.width && v <= g.K.height;
}

/** Provenance of a picked point from the three.js intersection event. */
export function pickInfo(e, cameras) {
  const ud = e.object?.userData ?? {};
  const p = [e.point.x, e.point.y, e.point.z];
  if (ud.src === "surface") {
    const cam = cameras.find((k) => k.id === ud.camId);
    const v = e.face?.a ?? 0;
    const kind = cam.kind[v], q = cam.quality[v] / 255;
    return { cam: cam.id, src: kind === 1 ? "ground" : kind === 2 ? "wall" : "surface", q: Math.round(q * 100) / 100 };
  }
  if (ud.src === "fill") return { cam: ud.camId, src: "fill", q: 0 };
  // invisible ground plane: owned by the nearest camera that actually sees the point
  const seeing = cameras.filter((k) => inFrame(k, p));
  const pool = seeing.length ? seeing : cameras;
  const near = pool.reduce((a, k) => (cameraGeometry(k).C.distanceTo(e.point) < cameraGeometry(a).C.distanceTo(e.point) ? k : a));
  return { cam: near.id, src: "plane", q: 1, outside: !seeing.length };
}

/** Warnings about one end point, most serious first. */
export function pointWarnings(info) {
  if (!info) return [{ level: "warn", text: "provenienza del punto non registrata (misura di una versione precedente)" }];
  const w = [];
  if (info.src === "fill") w.push({ level: "bad", text: "punto su superficie ricostruita senza dati: non usarlo come misura" });
  if (info.outside) w.push({ level: "warn", text: "punto fuori dall'inquadratura: il suolo vi e' solo ipotizzato piano" });
  if (info.src === "surface") w.push({ level: "warn", text: "punto su superficie a profondita' stimata (non suolo, non muro)" });
  if (info.q != null && info.q < 0.5 && info.src !== "fill") w.push({ level: "warn", text: "superficie vista di taglio dalla camera" });
  return w;
}

/* Error terms of one end point along the measurement direction u (unit vector). */
function pointTerms(cam, P, info, u) {
  const g = cameraGeometry(cam);
  const dx = P.x - g.C.x, dz = P.z - g.C.z;
  const dh = Math.max(0.5, Math.hypot(dx, dz));
  const rH = new THREE.Vector3(dx / dh, 0, dz / dh);           // radial, horizontal
  const tH = new THREE.Vector3(-rH.z, 0, rH.x);                // across, horizontal
  const src = info?.src ?? "unknown";
  const h = g.h, f = g.f, s = g.sigmaPx;
  const groundAlong = s * (h * h + dh * dh) / (f * h);
  const groundAcross = s * Math.hypot(h, dh) / f;
  const pitchShift = (h * h + dh * dh) / h * g.sigmaPitch;     // correlated, radial
  let rand2;
  if (src === "ground" || src === "plane") {
    rand2 = (groundAlong * rH.dot(u)) ** 2 + (groundAcross * tH.dot(u)) ** 2 + (groundAcross * u.y) ** 2;
  } else if (src === "wall") {
    rand2 = WALL_FACTOR ** 2 * ((groundAlong * rH.dot(u)) ** 2 + (groundAcross * tH.dot(u)) ** 2 + (groundAcross * u.y) ** 2);
  } else {
    // free-form / reconstructed / unknown: error along the 3D viewing ray
    const ray = P.clone().sub(g.C);
    const d3 = ray.length();
    ray.normalize();
    const along = Math.max(groundAlong, FREEFORM_REL * d3);
    const across = s * d3 / f;
    const c = ray.dot(u);
    rand2 = (along * c) ** 2 + across * across * (1 - c * c);
  }
  if (info?.q != null && info.q < 0.5 && src !== "fill") rand2 *= 4;
  return { rand2, pitch: pitchShift * rH.dot(u), sigmaHeightRel: g.sigmaHeightRel };
}

/** Relative 1-sigma error of the scale (multiply by a length to get metres). */
export function scaleSigmaRel(c, scaleRef) {
  if (scaleRef) {
    if (scaleRef.sigmaRel != null) return scaleRef.sigmaRel;
    return Math.hypot(0.02, TAPE_SIGMA_M / scaleRef.real); // old workspace: conservative
  }
  const h = Math.max(...c.cameras.map((k) => cameraGeometry(k).sigmaHeightRel));
  return Math.hypot(ASSUMED_HEIGHT_REL, h);
}

/** Error of a two-point distance, in raw scene units, without the scale term. */
export function localSigma(c, a, b, pa, pb) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const L = A.distanceTo(B);
  if (L < 1e-6) return 0;
  const u = B.clone().sub(A).divideScalar(L);
  const camOf = (info, P) => c.cameras.find((k) => k.id === info?.cam)
    ?? c.cameras.reduce((x, k) => (cameraGeometry(k).C.distanceTo(P) < cameraGeometry(x).C.distanceTo(P) ? k : x));
  const ca = camOf(pa, A), cb = camOf(pb, B);
  const ta = pointTerms(ca, A, pa, u), tb = pointTerms(cb, B, pb, u);
  const pitch2 = ca === cb ? (tb.pitch - ta.pitch) ** 2 : ta.pitch ** 2 + tb.pitch ** 2;
  return Math.sqrt(ta.rand2 + tb.rand2 + pitch2);
}

/**
 * Full uncertainty of a measurement for display. Lengths are in metres (scale applied).
 * Returns { L, sigma, lo95, hi95, warnings, worst }.
 */
export function measureUncertainty(c, m, scale, scaleRef) {
  const raw = new THREE.Vector3(...m.a).distanceTo(new THREE.Vector3(...m.b));
  const loc = localSigma(c, m.a, m.b, m.pa, m.pb);
  const sRel = scaleSigmaRel(c, scaleRef);
  const L = raw * scale;
  const sigma = Math.hypot(loc * scale, L * sRel);
  const warnings = [...pointWarnings(m.pa).map((w) => ({ ...w, text: `A: ${w.text}` })),
    ...pointWarnings(m.pb).map((w) => ({ ...w, text: `B: ${w.text}` }))];
  const worst = warnings.some((w) => w.level === "bad") ? "bad" : warnings.length ? "warn" : "ok";
  return { L, sigma, lo95: Math.max(0, L - 1.96 * sigma), hi95: L + 1.96 * sigma, warnings, worst, scaleRel: sRel };
}

export const fmtSigma = (s) => (s >= 10 ? s.toFixed(0) : s >= 1 ? s.toFixed(1) : s.toFixed(2));
