import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { useStore } from "./store.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

/* People and vehicles as solid 3D figures that look right from every side.

   The figure is a *representation*: position, height, heading and clothing colours
   come from the video; posture is a generic walk cycle driven by the distance
   actually travelled (so scrubbing back and forth always shows the same step).
   On the side facing the camera the real video pixels are projected onto the
   figure, wherever they differ from the empty background. */

/* ------------------------------------------------------------------ motion */
/** Cumulative distance and a stable heading along a track (heading holds while standing still). */
export function motionTable(track) {
  const n = track.p.length;
  const cum = new Float32Array(n);
  const head = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const dx = track.p[i][0] - track.p[i - 1][0], dz = track.p[i][1] - track.p[i - 1][1];
    cum[i] = cum[i - 1] + Math.hypot(dx, dz);
  }
  let last = null;
  for (let i = 0; i < n; i++) {
    // direction over about one second, ignoring jitter
    let a = i, b = i;
    while (a > 0 && track.t[i] - track.t[a] < 0.5) a--;
    while (b < n - 1 && track.t[b] - track.t[i] < 0.5) b++;
    const dx = track.p[b][0] - track.p[a][0], dz = track.p[b][1] - track.p[a][1];
    const dt = Math.max(track.t[b] - track.t[a], 1e-3);
    if (Math.hypot(dx, dz) / dt > 0.35) last = Math.atan2(dx, dz);
    head[i] = last ?? NaN;
  }
  // before the first movement, use the first known heading
  const first = head.find((v) => !Number.isNaN(v)) ?? 0;
  for (let i = 0; i < n && Number.isNaN(head[i]); i++) head[i] = first;
  return { cum, head };
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

export function motionAt(track, table, s, time) {
  const i = s.i, j = Math.min(i + 1, track.t.length - 1);
  const span = track.tg[j] - track.tg[i];
  const a = span > 0 ? Math.min(Math.max((time - track.tg[i]) / span, 0), 1) : 0;
  return {
    dist: table.cum[i] + (table.cum[j] - table.cum[i]) * a,
    heading: lerpAngle(table.head[i], table.head[j], a),
  };
}

/* ------------------------------------------------------------------ material */
const vert = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const frag = /* glsl */ `
  uniform vec3 uColor;
  uniform sampler2D uVideo;
  uniform sampler2D uStatic;
  uniform mat4 uWorldToCam;   // scene world -> OpenCV camera coordinates
  uniform vec3 uCamPos;       // camera centre in scene world
  uniform vec4 uK;
  uniform vec2 uSize;
  uniform vec4 uBox;          // the subject's box in this frame (pixels)
  uniform float uVideoOn;
  uniform float uHighlight;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec3 n = normalize(vNormal);
    // soft key + sky light: reads well on the dark background
    float key = max(dot(n, normalize(vec3(0.4, 0.9, 0.3))), 0.0);
    float sky = 0.5 + 0.5 * n.y;
    vec3 c = uColor * (0.35 + 0.45 * key + 0.25 * sky);
    if (uVideoOn > 0.5) {
      vec3 toCam = normalize(uCamPos - vWorld);
      float facing = dot(n, toCam);
      if (facing > 0.05) {
        vec4 pc = uWorldToCam * vec4(vWorld, 1.0);
        vec2 px = vec2(uK.x * pc.x / pc.z + uK.z, uK.y * pc.y / pc.z + uK.w);
        if (pc.z > 0.0 && px.x > uBox.x && px.x < uBox.z && px.y > uBox.y && px.y < uBox.w) {
          vec2 uv = vec2(px.x / uSize.x, 1.0 - px.y / uSize.y);
          vec3 v = texture2D(uVideo, uv).rgb;
          float fg = smoothstep(0.06, 0.15, distance(v, texture2D(uStatic, uv).rgb));
          c = mix(c, v * (0.85 + 0.15 * key), fg * smoothstep(0.05, 0.35, facing));
        }
      }
    }
    c = mix(c, vec3(0.957, 0.769, 0.188), uHighlight * 0.18 * (1.0 - abs(dot(n, normalize(uCamPos - vWorld)))));
    gl_FragColor = vec4(c, 1.0);
  }`;

const srgb = (rgb, fallback) => (rgb ? new THREE.Vector3(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255) : new THREE.Vector3(...fallback));

function useFigureMaterials(cam, tx, colors) {
  return useMemo(() => {
    const worldToCam = cam.camFromWorld.clone().multiply(cam.alignmentM.clone().invert());
    const camPos = new THREE.Vector3().setFromMatrixPosition(cam.alignmentM.clone().multiply(cam.worldFromCam));
    const shared = {
      uVideo: { value: tx.frame }, uStatic: { value: tx.bg }, uWorldToCam: { value: worldToCam },
      uCamPos: { value: camPos }, uK: { value: new THREE.Vector4(cam.camera.K.fx, cam.camera.K.fy, cam.camera.K.cx, cam.camera.K.cy) },
      uSize: { value: new THREE.Vector2(cam.camera.K.width, cam.camera.K.height) },
      uBox: { value: new THREE.Vector4() }, uVideoOn: { value: 0 }, uHighlight: { value: 0 },
    };
    const make = (col) => new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: { ...shared, uColor: { value: col } } });
    return { shared, ...Object.fromEntries(Object.entries(colors).map(([k, v]) => [k, make(v)])) };
  }, [cam, tx, colors]);
}

/* ------------------------------------------------------------------ geometry */
const capsule = new THREE.CapsuleGeometry(1, 1, 6, 12); // radius 1, straight part 1 (total height 3)
const sphere = new THREE.SphereGeometry(1, 20, 14);
const box = new THREE.BoxGeometry(1, 1, 1);
const wheel = new THREE.CylinderGeometry(1, 1, 1, 20).rotateZ(Math.PI / 2);
const shadowGeom = new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2);
const shadowMat = new THREE.MeshBasicMaterial({ color: "#05080c", transparent: true, opacity: 0.35, depthWrite: false });

/** A capsule spanning `len` downward from its parent's origin. */
function Limb({ len, r, mat }) {
  // capsule total height = 2r + straight; we want total = len
  const straight = Math.max(len - 2 * r, 0.001);
  return <mesh geometry={capsule} material={mat} position={[0, -len / 2, 0]} scale={[r, straight, r]} />;
}

/* ------------------------------------------------------------------ person */
export function Mannequin({ cam, tx, track, table, s, height, selected, onSelect }) {
  const root = useRef();
  const parts = useRef({});
  const a = track.appearance;
  const colors = useMemo(() => ({
    upper: srgb(a?.upper?.rgb, [0.45, 0.48, 0.52]),
    lower: srgb(a?.lower?.rgb, [0.22, 0.24, 0.28]),
    skin: new THREE.Vector3(0.62, 0.5, 0.42),
    shoe: new THREE.Vector3(0.12, 0.12, 0.13),
  }), [a]);
  const mats = useFigureMaterials(cam, tx, colors);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose?.()), [mats]);

  const H = height;
  const hip = 0.52 * H, thigh = 0.25 * H, shin = 0.24 * H, sh = 0.81 * H, upperArm = 0.17 * H, foreArm = 0.16 * H;

  useFrame(() => {
    const st = useStore.getState();
    const cur = s.current;
    if (!cur || !root.current) return;
    const m = motionAt(track, table, cur, st.time);
    root.current.position.set(cur.x, 0, cur.z);
    root.current.rotation.y = m.heading;
    // walk cycle from distance travelled: one stride (two steps) every ~0.8 H metres
    const phase = (m.dist / (0.8 * H)) * Math.PI * 2;
    const amp = Math.min((cur.speed ?? 0) / 4.0, 1) * 0.5; // km/h -> radians, 0.5 rad at walking pace
    const P = parts.current;
    const sw = Math.sin(phase) * amp;
    P.hipL.rotation.x = sw;
    P.hipR.rotation.x = -sw;
    P.kneeL.rotation.x = -Math.max(0, Math.sin(phase + 1.2)) * amp * 1.3;
    P.kneeR.rotation.x = -Math.max(0, Math.sin(phase + 1.2 + Math.PI)) * amp * 1.3;
    P.armL.rotation.x = -sw * 0.8;
    P.armR.rotation.x = sw * 0.8;
    P.body.position.y = Math.abs(Math.cos(phase)) * amp * 0.02 * H;
    // video box for the projected texture
    const [x1, y1, x2, y2] = cur.bbox;
    const px = (x2 - x1) * 0.05;
    mats.shared.uBox.value.set(x1 - px, y1 - px, x2 + px, y2 + px);
    mats.shared.uVideoOn.value = st.layers.projection && tx.live && !cur.hidden ? 1 : 0;
    mats.shared.uHighlight.value = selected ? 1 : 0;
  });

  const reg = (k) => (el) => { parts.current[k] = el; };
  const click = (e) => { e.stopPropagation(); onSelect(); };
  return (
    <group ref={root} onClick={click}>
      <mesh geometry={shadowGeom} material={shadowMat} position={[0, 0.02, 0]} scale={[0.32 * H / 1.7, 1, 0.32 * H / 1.7]} />
      <group ref={reg("body")}>
        {/* legs */}
        {[["hipL", "kneeL", 1], ["hipR", "kneeR", -1]].map(([hk, kk, side]) => (
          <group key={hk} ref={reg(hk)} position={[side * 0.055 * H, hip, 0]}>
            <Limb len={thigh} r={0.052 * H} mat={mats.lower} />
            <group ref={reg(kk)} position={[0, -thigh, 0]}>
              <Limb len={shin} r={0.04 * H} mat={mats.lower} />
              <mesh geometry={box} material={mats.shoe} position={[0, -shin + 0.012 * H, 0.03 * H]} scale={[0.06 * H, 0.035 * H, 0.15 * H]} />
            </group>
          </group>
        ))}
        {/* pelvis and torso */}
        <mesh geometry={capsule} material={mats.lower} position={[0, hip + 0.02 * H, 0]} scale={[0.1 * H, 0.03 * H, 0.065 * H]} />
        <mesh geometry={capsule} material={mats.upper} position={[0, 0.68 * H, 0]} scale={[0.105 * H, 0.1 * H, 0.068 * H]} />
        {/* arms */}
        {[["armL", 1], ["armR", -1]].map(([k, side]) => (
          <group key={k} ref={reg(k)} position={[side * 0.13 * H, sh, 0]}>
            <Limb len={upperArm} r={0.036 * H} mat={mats.upper} />
            <group position={[0, -upperArm, 0]} rotation-x={-0.25}>
              <Limb len={foreArm} r={0.03 * H} mat={mats.skin} />
            </group>
          </group>
        ))}
        {/* neck and head */}
        <mesh geometry={capsule} material={mats.skin} position={[0, 0.86 * H, 0]} scale={[0.028 * H, 0.012 * H, 0.028 * H]} />
        <mesh geometry={sphere} material={mats.skin} position={[0, 0.935 * H, 0.005 * H]} scale={[0.058 * H, 0.068 * H, 0.062 * H]} />
      </group>
    </group>
  );
}

/* ------------------------------------------------------------------ vehicle */
const VEHICLE_SIZE = { // length, width, height (m)
  auto: [4.4, 1.8, 1.48], moto: [2.1, 0.8, 1.25], bicicletta: [1.75, 0.6, 1.1],
  autobus: [12, 2.55, 3.1], camion: [8, 2.5, 3.2],
};

export function Vehicle({ cam, tx, track, table, s, selected, onSelect }) {
  const root = useRef();
  const wheels = useRef([]);
  const a = track.appearance;
  const colors = useMemo(() => ({
    body: srgb(a?.upper?.rgb, [0.55, 0.58, 0.62]),
    glass: new THREE.Vector3(0.1, 0.14, 0.19),
    tyre: new THREE.Vector3(0.07, 0.07, 0.08),
  }), [a]);
  const mats = useFigureMaterials(cam, tx, colors);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose?.()), [mats]);
  const [L, W, Hh] = VEHICLE_SIZE[track.cls] ?? VEHICLE_SIZE.auto;
  const two = track.cls === "moto" || track.cls === "bicicletta";
  const r = two ? 0.32 : Math.min(0.34, Hh * 0.22);
  // rounded body and cabin, built at real size so the corner radius is not distorted
  const geo = useMemo(() => {
    const bodyH = Hh * 0.42, cabH = Hh - r - bodyH, cabL = L * (track.cls === "auto" ? 0.5 : 0.92);
    return {
      body: new RoundedBoxGeometry(W, bodyH, L, 3, Math.min(0.18, bodyH * 0.35)),
      cabin: new RoundedBoxGeometry(W * 0.86, cabH, cabL, 3, Math.min(0.22, cabH * 0.4)),
      bodyH, cabH,
    };
  }, [W, Hh, L, r, track.cls]);
  useEffect(() => () => { geo.body.dispose(); geo.cabin.dispose(); }, [geo]);

  useFrame(() => {
    const st = useStore.getState();
    const cur = s.current;
    if (!cur || !root.current) return;
    const m = motionAt(track, table, cur, st.time);
    root.current.position.set(cur.x, 0, cur.z);
    root.current.rotation.y = m.heading;
    for (const w of wheels.current) if (w) w.rotation.x = m.dist / r;
    const [x1, y1, x2, y2] = cur.bbox;
    mats.shared.uBox.value.set(x1, y1, x2, y2);
    mats.shared.uVideoOn.value = st.layers.projection && tx.live && !cur.hidden ? 1 : 0;
    mats.shared.uHighlight.value = selected ? 1 : 0;
  });

  const wheelPos = two
    ? [[0, r, L * 0.36], [0, r, -L * 0.36]]
    : [[W * 0.42, r, L * 0.32], [-W * 0.42, r, L * 0.32], [W * 0.42, r, -L * 0.32], [-W * 0.42, r, -L * 0.32]];
  return (
    <group ref={root} onClick={(e) => { e.stopPropagation(); onSelect(); }}>
      <mesh geometry={shadowGeom} material={shadowMat} position={[0, 0.02, 0]} scale={[W * 0.7, 1, L * 0.55]} />
      {two ? (
        <>
          <mesh geometry={box} material={mats.body} position={[0, r + 0.35, 0]} scale={[0.25, 0.35, L * 0.6]} />
          <mesh geometry={capsule} material={mats.body} position={[0, Hh - 0.25, -L * 0.05]} scale={[0.17, 0.2, 0.15]} />
        </>
      ) : (
        <>
          <mesh geometry={geo.body} material={mats.body} position={[0, r + geo.bodyH / 2, 0]} />
          <mesh geometry={geo.cabin} material={mats.glass} position={[0, r + geo.bodyH + geo.cabH / 2 - 0.02, -L * 0.04]} />
        </>
      )}
      {wheelPos.map((p, i) => (
        <group key={i} position={p}>
          <mesh ref={(el) => { wheels.current[i] = el; }} geometry={wheel} material={mats.tyre} scale={[two ? 0.08 : 0.24, r, r]} />
        </group>
      ))}
    </group>
  );
}

/** Small helper so the figures read the latest sample without re-rendering React every frame. */
export function useLatest(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function useCamTx(texturesFor, cam) {
  const { gl } = useThree();
  return texturesFor(cam, gl);
}
