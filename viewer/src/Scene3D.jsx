import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { pickInfo, measureUncertainty, SOURCE_LABEL, fmtSigma } from "./uncertainty.js";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Grid, Html, Line, Bvh } from "@react-three/drei";
import { useStore, trackColor } from "./store.js";
import { sampleTrack, fmtLen } from "./caseLoader.js";
import { getVideo } from "./Video.jsx";
import { Mannequin, Vehicle, motionTable, useLatest } from "./People3D.jsx";
import { RotoFigure, GEN } from "./Roto.jsx";
import { Buildings, GroundApron } from "./Generated.jsx";

/* ------------------------------------------------------------------ shared textures */
// One set per camera: the live video frame (canvas), the clean background plate, the filled plate.
const camTex = new Map();
export function texturesFor(cam, gl) {
  let t = camTex.get(cam.id);
  if (t) return t;
  const canvas = document.createElement("canvas");
  canvas.width = cam.width;
  canvas.height = cam.height;
  const frame = new THREE.CanvasTexture(canvas);
  frame.generateMipmaps = false;
  frame.minFilter = THREE.LinearFilter;
  const loader = new THREE.TextureLoader();
  const aniso = gl.capabilities.getMaxAnisotropy();
  const still = (url) => {
    if (!url) return null;
    const tx = loader.load(url);
    tx.anisotropy = aniso; // keeps the floor sharp when seen at a grazing angle
    tx.minFilter = THREE.LinearMipmapLinearFilter;
    tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping;
    return tx;
  };
  const plain = (url, repeat) => {
    if (!url) return null;
    const tx = loader.load(url);
    tx.anisotropy = aniso;
    if (repeat) { tx.wrapS = tx.wrapT = THREE.RepeatWrapping; } else {
      tx.generateMipmaps = false; tx.minFilter = THREE.LinearFilter; // mask atlas: no bleeding between cells
    }
    return tx;
  };
  t = { frame, ctx: canvas.getContext("2d"), video: getVideo(cam), bg: still(cam.backgroundUrl), fill: still(cam.fillUrl),
    mask: plain(cam.maskUrl, false), detail: plain(cam.detailUrl, true), live: false, last: -1 };
  camTex.set(cam.id, t);
  return t;
}
export function disposeTextures() {
  for (const t of camTex.values()) { t.frame.dispose(); t.bg?.dispose(); t.fill?.dispose(); t.mask?.dispose(); t.detail?.dispose(); }
  camTex.clear();
}

/* ------------------------------------------------------------------ surface */
const vert = /* glsl */ `
  attribute float quality;
  attribute float kind;
  varying float vKind;
  varying vec3 vLocalPos;
  uniform mat4 uCamFromWorld;
  uniform vec4 uK;
  uniform vec2 uSize;
  uniform float uPointSize;
  varying vec2 vUv;
  varying vec2 vPx;
  varying float vIn;
  varying float vQ;
  void main() {
    vQ = quality;
    vKind = kind;
    vLocalPos = position;
    vec4 pc = uCamFromWorld * vec4(position, 1.0);
    vPx = vec2(uK.x * pc.x / pc.z + uK.z, uK.y * pc.y / pc.z + uK.w);
    vUv = vec2(vPx.x / uSize.x, 1.0 - vPx.y / uSize.y);
    vIn = (pc.z > 0.0 && vUv.x >= 0.0 && vUv.x <= 1.0 && vUv.y >= 0.0 && vUv.y <= 1.0) ? 1.0 : 0.0;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uPointSize * 60.0 / -mv.z, 1.0, 6.0);
  }`;
const BAYER = /* glsl */ `
  float bayer(vec2 p) {
    int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0));
    int i = x + y * 4;
    float m[16];
    m[0]=0.0; m[1]=8.0; m[2]=2.0; m[3]=10.0; m[4]=12.0; m[5]=4.0; m[6]=14.0; m[7]=6.0;
    m[8]=3.0; m[9]=11.0; m[10]=1.0; m[11]=9.0; m[12]=15.0; m[13]=7.0; m[14]=13.0; m[15]=5.0;
    for (int k = 0; k < 16; k++) if (k == i) return (m[k] + 0.5) / 16.0;
    return 0.5;
  }`;
const MAX_BOXES = 32;
const frag = /* glsl */ `
  uniform sampler2D uStatic;
  uniform sampler2D uDetail;
  uniform float uTile;
  uniform float uDetailOn;
  uniform float uGenerated;
  varying float vKind;
  varying vec3 vLocalPos;
  ${GEN}
  uniform sampler2D uVideo;
  uniform float uMix;
  uniform float uFade;
  uniform vec4 uBoxes[${MAX_BOXES}];
  uniform int uNBoxes;
  varying vec2 vUv;
  varying vec2 vPx;
  varying float vIn;
  varying float vQ;
  ${BAYER}
  void main() {
    // surfaces the camera saw edge-on fade out instead of drawing long streaks
    float alpha = mix(1.0, smoothstep(0.0, 0.7, vQ), uFade);
    if (alpha < 0.02) discard;
    vec3 c = texture2D(uStatic, vUv).rgb;
    if (vIn > 0.5 && uMix > 0.0) {
      // moving subjects are drawn as cut-out figures, not smeared on the floor:
      // inside their boxes keep the clean background
      bool inBox = false;
      for (int i = 0; i < ${MAX_BOXES}; i++) {
        if (i >= uNBoxes) break;
        vec4 b = uBoxes[i];
        if (vPx.x > b.x && vPx.x < b.z && vPx.y > b.y && vPx.y < b.w) inBox = true;
      }
      if (!inBox) c = mix(c, texture2D(uVideo, vUv).rgb, uMix);
    }
    float gen = uGenerated;
    // far floor: the source image has fewer pixels than the screen, so it looks smeared.
    // Add the fine grain of the floor (taken close to the camera) where that happens.
    if (uDetailOn > 0.5 && vKind > 0.5 && vKind < 1.5) {
      float tpp = length(fwidth(vPx));            // source pixels per screen pixel
      float w = 1.0 - smoothstep(0.35, 1.1, tpp);
      float d = texture2D(uDetail, vLocalPos.xz / uTile).r - 0.5;
      c *= 1.0 + d * 0.9 * w;
      gen = max(gen, w * 0.35);
    }
    c = generatedTint(c, gen);
    gl_FragColor = vec4(c, alpha);
  }`;

function useSurfaceMaterial(cam, staticTex, { offset = false, generated = 0 } = {}) {
  const { gl } = useThree();
  const tx = texturesFor(cam, gl);
  return useMemo(() => {
    const m = new THREE.ShaderMaterial({ alphaToCoverage: true,
      vertexShader: vert,
      fragmentShader: frag,
      side: THREE.DoubleSide,
      uniforms: {
        uCamFromWorld: { value: cam.camFromWorld },
        uK: { value: new THREE.Vector4(cam.camera.K.fx, cam.camera.K.fy, cam.camera.K.cx, cam.camera.K.cy) },
        uSize: { value: new THREE.Vector2(cam.camera.K.width, cam.camera.K.height) },
        uStatic: { value: staticTex ?? tx.bg },
        uVideo: { value: tx.frame },
        uMix: { value: 0 },
        uFade: { value: 1 },
        uPointSize: { value: 1.6 },
        uBoxes: { value: Array.from({ length: MAX_BOXES }, () => new THREE.Vector4()) },
        uNBoxes: { value: 0 },
        uDetail: { value: tx.detail ?? tx.bg }, uTile: { value: cam.floor_detail?.tile_m ?? 6 },
        uDetailOn: { value: tx.detail ? 1 : 0 }, uGenerated: { value: generated }, uShowGen: { value: 1 },
      },
    });
    if (offset) { m.polygonOffset = true; m.polygonOffsetFactor = 2; m.polygonOffsetUnits = 2; }
    return m;
  }, [cam, staticTex, tx, offset, generated]);
}

/** Copies the current video frame to the shared texture and lists the subjects' boxes. */
function FrameUpdater({ cam, materials }) {
  const { gl } = useThree();
  const tx = texturesFor(cam, gl);
  useFrame(() => {
    const st = useStore.getState();
    const v = tx.video;
    const t = st.time - cam.time_offset;
    const live = v.readyState >= 2 && v.videoWidth > 0 && t >= 0 && t <= cam.duration;
    if (live && (st.layers.projection || st.layers.sprites) && (v.currentTime !== tx.last || !v.paused)) {
      tx.ctx.drawImage(v, 0, 0, cam.width, cam.height);
      tx.frame.needsUpdate = true;
      tx.last = v.currentTime;
      tx.ready = true;
    }
    tx.live = live && !!tx.ready;
    let n = 0;
    const boxes = materials[0]?.uniforms.uBoxes.value;
    if ((st.layers.sprites || st.layers.people3d) && boxes) {
      for (const tr of cam.tracks) {
        const s = sampleTrack(tr, st.time);
        if (!s || n >= MAX_BOXES) continue;
        const [x1, y1, x2, y2] = s.bbox;
        const px = (x2 - x1) * 0.12, py = (y2 - y1) * 0.06;
        boxes[n++].set(x1 - px, y1 - py, x2 + px, y2 + py);
      }
    }
    for (const m of materials) {
      if (!m) continue;
      m.uniforms.uMix.value = st.layers.projection && tx.live ? 1 : 0;
      m.uniforms.uFade.value = st.layers.fadeUncertain ? 1 : 0;
      m.uniforms.uNBoxes.value = n;
      m.uniforms.uShowGen.value = st.layers.generated ? 1 : 0;
      m.uniforms.uDetailOn.value = st.layers.detail && tx.detail ? 1 : 0;
      if (m.uniforms.uBoxes.value !== boxes) m.uniforms.uBoxes.value = boxes;
    }
  });
  return null;
}

function Surface({ cam, onPick }) {
  const layers = useStore((s) => s.layers);
  const { gl } = useThree();
  const tx = texturesFor(cam, gl);
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(cam.positions, 3));
    g.setAttribute("quality", new THREE.BufferAttribute(cam.quality, 1, true));
    g.setAttribute("kind", new THREE.BufferAttribute(cam.kind, 1));
    g.setIndex(new THREE.BufferAttribute(cam.indices, 1));
    g.computeBoundingSphere();
    return g;
  }, [cam]);
  const fillGeom = useMemo(() => {
    if (!cam.fillPositions) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(cam.fillPositions, 3));
    g.setAttribute("quality", new THREE.BufferAttribute(cam.fillQuality ?? new Uint8Array(cam.fillPositions.length / 3).fill(255), 1, true));
    g.setAttribute("kind", new THREE.BufferAttribute(new Uint8Array(cam.fillPositions.length / 3), 1));
    g.setIndex(new THREE.BufferAttribute(cam.fillIndices, 1));
    g.computeBoundingSphere();
    return g;
  }, [cam]);
  const mat = useSurfaceMaterial(cam, tx.bg);
  const fillMat = useSurfaceMaterial(cam, tx.fill, { offset: true, generated: 1 });
  useEffect(() => () => { geom.dispose(); fillGeom?.dispose(); mat.dispose(); fillMat.dispose(); }, [geom, fillGeom, mat, fillMat]);
  return (
    <>
      <FrameUpdater cam={cam} materials={[mat, fillMat]} />
      {layers.surface && (
        <Bvh firstHitOnly>
          <mesh geometry={geom} material={mat} onClick={onPick} userData={{ src: "surface", camId: cam.id }} />
        </Bvh>
      )}
      {layers.surface && layers.fill && fillGeom && <mesh geometry={fillGeom} material={fillMat} onClick={onPick} userData={{ src: "fill", camId: cam.id }} />}
      {layers.points && <points geometry={geom} material={mat} />}
    </>
  );
}

/* ------------------------------------------------------------------ cut-out figures */
const spriteVert = /* glsl */ `
  varying vec2 vLocal;
  void main() {
    vLocal = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const spriteFrag = /* glsl */ `
  uniform sampler2D uVideo;
  uniform sampler2D uStatic;
  uniform vec4 uRect;   // u0, v0, u1, v1 of the subject's box in the frame
  uniform vec2 uTexel;
  uniform float uGhost;
  varying vec2 vLocal;
  ${BAYER}
  float fg(vec2 uv) {
    return distance(texture2D(uVideo, uv).rgb, texture2D(uStatic, uv).rgb);
  }
  void main() {
    vec2 uv = mix(uRect.xy, uRect.zw, vLocal);
    // background subtraction, smoothed over a small cross: what differs from the empty scene is the person
    float d = fg(uv) * 0.4 + 0.15 * (fg(uv + vec2(uTexel.x, 0.0)) + fg(uv - vec2(uTexel.x, 0.0))
             + fg(uv + vec2(0.0, uTexel.y)) + fg(uv - vec2(0.0, uTexel.y)));
    float a = smoothstep(0.07, 0.16, d);
    // fade the border of the box
    vec2 e = min(vLocal, 1.0 - vLocal);
    a *= smoothstep(0.0, 0.06, e.x) * smoothstep(0.0, 0.03, e.y + step(vLocal.y, 0.5) * 0.03);
    a *= uGhost;
    if (a < 0.02) discard;
    gl_FragColor = vec4(texture2D(uVideo, uv).rgb, a);
  }`;
const spriteGeom = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);

function Figure({ cam, s, height, selected }) {
  const ref = useRef();
  const { gl, camera } = useThree();
  const tx = texturesFor(cam, gl);
  const mat = useMemo(() => new THREE.ShaderMaterial({ alphaToCoverage: true,
    vertexShader: spriteVert, fragmentShader: spriteFrag, side: THREE.DoubleSide,
    uniforms: { uVideo: { value: tx.frame }, uStatic: { value: tx.bg }, uRect: { value: new THREE.Vector4() },
      uTexel: { value: new THREE.Vector2(1 / cam.width, 1 / cam.height) }, uGhost: { value: 1 } },
  }), [tx, cam]);
  useEffect(() => () => mat.dispose(), [mat]);
  const [x1, y1, x2, y2] = s.bbox;
  mat.uniforms.uRect.value.set(x1 / cam.width, 1 - y2 / cam.height, x2 / cam.width, 1 - y1 / cam.height);
  const width = height * (x2 - x1) / Math.max(y2 - y1, 1);
  // always face the viewer, turning only around the vertical axis (like a cardboard cut-out)
  useFrame(() => {
    const g = ref.current;
    if (!g?.parent) return;
    g.visible = tx.live; // shown only when there is a real video frame to cut from
    const local = g.parent.worldToLocal(camera.position.clone());
    g.rotation.y = Math.atan2(local.x - g.position.x, local.z - g.position.z);
  });
  return (
    <group ref={ref} position={[s.x, 0, s.z]}>
      <mesh geometry={spriteGeom} material={mat} scale={[width, height, 1]} />
      {selected && (
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.04, 0]}>
          <ringGeometry args={[0.38, 0.48, 40]} />
          <meshBasicMaterial color="#f4c430" side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ camera gizmo */
function Frustum({ cam }) {
  const requestView = useStore((s) => s.requestView);
  const selectedCam = useStore((s) => s.selectedCam);
  const { lines, apex } = useMemo(() => {
    const K = cam.camera.K;
    const d = 1.6;
    const corner = (u, v) =>
      new THREE.Vector3(((u - K.cx) / K.fx) * d, ((v - K.cy) / K.fy) * d, d).applyMatrix4(cam.worldFromCam);
    const o = new THREE.Vector3(0, 0, 0).applyMatrix4(cam.worldFromCam);
    const c = [corner(0, 0), corner(K.width, 0), corner(K.width, K.height), corner(0, K.height)];
    return {
      apex: o,
      lines: [o, c[0], o, c[1], o, c[2], o, c[3], c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0]],
    };
  }, [cam]);
  const sel = selectedCam === cam.id;
  return (
    <group>
      <Line points={lines} segments color={sel ? "#f4c430" : "#8e9cab"} lineWidth={1.5} />
      <mesh position={apex} onClick={(e) => { e.stopPropagation(); requestView({ kind: "camera", camId: cam.id }); }}>
        <sphereGeometry args={[0.18, 16, 12]} />
        <meshBasicMaterial color={sel ? "#f4c430" : "#8e9cab"} />
      </mesh>
      <Html position={apex} zIndexRange={[2, 0]}>
        <div className="cam-label">{cam.id}, h {cam.camera.height_m.toFixed(1)} m</div>
      </Html>
    </group>
  );
}

/* ------------------------------------------------------------------ subjects */
// short or far-away tracks give speeds dominated by noise: don't print a number then
export const reliableSpeed = (t) => t.stats.duration_s >= 1.5 && t.stats.speed_sigma_kmh <= 4;

function Subject({ track, cam }) {
  const time = useStore((s) => s.time);
  const layers = useStore((s) => s.layers);
  const scale = useStore((s) => s.scale);
  const selected = useStore((s) => s.selectedTrack === track.key);
  const hovered = useStore((s) => s.hoverTrack === track.key);
  const select = useStore((s) => s.setSelectedTrack);
  const setHover = useStore((s) => s.setHoverTrack);
  const color = trackColor(track.id);
  const pathPts = useMemo(() => track.p.map(([x, z]) => [x, 0.04, z]), [track]);
  const table = useMemo(() => motionTable(track), [track]);
  // occlusions bridged by re-identification: straight dashed connector
  const gapSegs = useMemo(() => (track.gapsG ?? []).map(([a, b]) => {
    const pa = sampleTrack(track, a), pb = sampleTrack(track, b);
    return pa && pb ? [[pa.x, 0.05, pa.z], [pb.x, 0.05, pb.z]] : null;
  }).filter(Boolean), [track]);
  const s = sampleTrack(track, time);
  const sRef = useLatest(s);
  const trail = useMemo(() => {
    if (!s) return null;
    const pts = pathPts.slice(0, s.i + 1);
    pts.push([s.x, 0.05, s.z]);
    return pts.length >= 2 ? pts : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.i, pathPts, s && Math.round(s.x * 20), s && Math.round(s.z * 20)]);
  const isPerson = track.cls === "persona";
  const h = isPerson ? track.stats.height_m ?? 1.7 : 1.5;
  const { gl } = useThree();
  const tx = texturesFor(cam, gl);
  const mode = useStore((st) => st.personMode); // roto | mannequin | flat
  const roto = mode === "roto" && s && (isPerson || !layers.people3d);
  const as3d = (mode === "mannequin" || (mode === "roto" && !isPerson && layers.people3d)) && s;
  const asFigure = mode === "flat" && s && !s.hidden;
  const figH = isPerson ? (s?.h ?? h) : h;
  const labelH = isPerson ? h : 2.0;
  const solidRef = useRef();
  // the solid marker stands in for the cut-out whenever there is no live frame
  // a solid stand-in whenever there is no live frame to cut the figure from (or it is hidden)
  useFrame(() => { if (solidRef.current) solidRef.current.visible = !as3d && !((asFigure || roto) && tx.live && !s?.hidden); });
  const onSelect = () => select(track.key);
  const emph = selected || hovered;
  return (
    <group onPointerOver={(e) => { e.stopPropagation(); setHover(track.key); }} onPointerOut={() => setHover(null)}>
      {layers.trails && (
        <Line points={pathPts} color={color} lineWidth={emph ? 2.5 : 1.2} transparent opacity={emph ? 0.9 : 0.28} />
      )}
      {layers.trails && trail && <Line points={trail} color={color} lineWidth={emph ? 3.5 : 2.2} />}
      {layers.trails && gapSegs.map((seg, i) => (
        <Line key={i} points={seg} color="#f4c430" lineWidth={2} dashed dashSize={0.4} gapSize={0.3} />
      ))}
      {as3d && (isPerson
        ? <Mannequin cam={cam} tx={tx} track={track} table={table} s={sRef} height={figH} selected={selected} onSelect={onSelect} />
        : <Vehicle cam={cam} tx={tx} track={track} table={table} s={sRef} selected={selected} onSelect={onSelect} />)}
      {asFigure && <Figure cam={cam} s={s} height={figH * 1.06} selected={selected} />}
      {roto && <RotoFigure cam={cam} tx={tx} maskTex={tx.mask} masks={cam.masks} track={track} s={sRef} height={figH * 1.04} selected={selected} onSelect={onSelect} />}
      {s && (
        <group position={[s.x, 0, s.z]}>
          <mesh ref={solidRef} position={[0, h / 2, 0]} onClick={(e) => { e.stopPropagation(); onSelect(); }}>
            {isPerson ? <cylinderGeometry args={[0.22, 0.22, h, 18]} /> : <boxGeometry args={[1.8, h, 4.2]} />}
            <meshBasicMaterial color={selected ? "#f4c430" : color} transparent opacity={s.hidden ? 0.22 : s.interp ? 0.3 : 0.62} depthWrite={false} />
          </mesh>
          {selected && (
            <mesh rotation-x={-Math.PI / 2} position={[0, 0.045, 0]}>
              <ringGeometry args={[isPerson ? 0.42 : 2.6, isPerson ? 0.5 : 2.75, 48]} />
              <meshBasicMaterial color="#f4c430" side={THREE.DoubleSide} />
            </mesh>
          )}
          {layers.uncertainty && selected && Number.isFinite(s.sigma) && (
            <mesh rotation-x={-Math.PI / 2} position={[0, 0.03, 0]}>
              <ringGeometry args={[Math.max(2 * s.sigma - 0.05, 0.01), 2 * s.sigma, 64]} />
              <meshBasicMaterial color="#f4c430" transparent opacity={0.45} side={THREE.DoubleSide} />
            </mesh>
          )}
          <Html position={[0, labelH + 0.3, 0]} zIndexRange={[3, 0]}>
            <div className={`label3d ${selected ? "sel" : ""}`}>
              {s.hidden ? <div className="chip">coperto</div>
                : emph && s.speed != null && reliableSpeed(track) && <div className="chip">{(s.speed * scale).toFixed(1)} km/h</div>}
              <div className="tent"><span>{track.id}</span></div>
            </div>
          </Html>
        </group>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ measurements */
const MEASURE_COLOR = { ok: "#5cc8e8", warn: "#f4c430", bad: "#c38ce8" };

function Measurements() {
  const c = useStore((s) => s.caseData);
  const measurements = useStore((s) => s.measurements);
  const pending = useStore((s) => s.pending);
  const scale = useStore((s) => s.scale);
  const scaleRef = useStore((s) => s.scaleRef);
  const tool = useStore((s) => s.tool);
  const presenting = useStore((s) => s.presenting);
  const color = tool === "calibrate" ? "#f4c430" : "#5cc8e8";
  return (
    <group>
      {measurements.map((m, i) => {
        const a = new THREE.Vector3(...m.a), b = new THREE.Vector3(...m.b);
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const u = measureUncertainty(c, m, scale, scaleRef);
        const col = MEASURE_COLOR[u.worst];
        return (
          <group key={m.id}>
            <Line points={[a, b]} color={col} lineWidth={2.5} depthTest={false} dashed={u.worst === "bad"} dashSize={0.3} gapSize={0.2} />
            {[a, b].map((p, k) => (
              <mesh key={k} position={p} renderOrder={10}>
                <sphereGeometry args={[0.07, 12, 8]} />
                <meshBasicMaterial color={col} depthTest={false} />
              </mesh>
            ))}
            <Html position={mid} zIndexRange={[3, 0]}>
              <div className={`measure-label ${u.worst}`} title={u.warnings.map((w) => w.text).join("\n")}>
                {!presenting && <span className="mn">{i + 1}</span>}
                {fmtLen(u.L)}<span className="pm"> ±{fmtSigma(u.sigma)}</span>
              </div>
            </Html>
          </group>
        );
      })}
      {pending.map((p, i) => (
        <mesh key={i} position={p.p} renderOrder={10}>
          <sphereGeometry args={[0.09, 12, 8]} />
          <meshBasicMaterial color={color} depthTest={false} />
        </mesh>
      ))}
    </group>
  );
}

/** Gives the exporter access to the renderer and the camera of the 3D view. */
function ExportHandle() {
  const { gl, camera, size, controls } = useThree();
  useEffect(() => { window.__sopralluogoView = { gl, camera, size, controls }; }, [gl, camera, size, controls]);
  return null;
}

/* ------------------------------------------------------------------ view control */
function sceneCentre(c) {
  const pts = c.cameras.flatMap((k) => k.tracks.flatMap((t) => t.p.map(([x, z]) => new THREE.Vector3(x, 0, z).applyMatrix4(k.alignmentM))));
  if (!pts.length) {
    const k = c.cameras[0];
    const M = k.alignmentM.clone().multiply(k.worldFromCam);
    const C = new THREE.Vector3().setFromMatrixPosition(M).setY(0);
    const f = new THREE.Vector3(0, 0, 1).transformDirection(M).setY(0).normalize();
    return { centre: C.add(f.multiplyScalar(25)), radius: 25 };
  }
  const q = (arr, p) => arr[Math.floor(p * (arr.length - 1))];
  const xs = pts.map((p) => p.x).sort((a, b) => a - b), zs = pts.map((p) => p.z).sort((a, b) => a - b);
  const centre = new THREE.Vector3(q(xs, 0.5), 0, q(zs, 0.5));
  const radius = Math.max(12, (q(xs, 0.95) - q(xs, 0.05)) / 2, (q(zs, 0.95) - q(zs, 0.05)) / 2);
  return { centre, radius };
}

function Rig() {
  const { camera, controls } = useThree();
  const viewRequest = useStore((s) => s.viewRequest);
  const c = useStore((s) => s.caseData);
  const anim = useRef(null);

  useEffect(() => {
    if (!viewRequest || !controls) return;
    const cam0 = c.cameras[0];
    const camOf = (id) => c.cameras.find((k) => k.id === id) ?? cam0;
    const world = (cam) => cam.alignmentM.clone().multiply(cam.worldFromCam);
    let pos, target, fov = 50;
    if (viewRequest.kind === "camera") {
      const k = camOf(viewRequest.camId);
      const M = world(k);
      pos = new THREE.Vector3().setFromMatrixPosition(M);
      const fwd = new THREE.Vector3(0, 0, 1).transformDirection(M);
      target = pos.clone().add(fwd.multiplyScalar(12));
      fov = THREE.MathUtils.radToDeg(2 * Math.atan(k.camera.K.height / 2 / k.camera.K.fy));
      useStore.getState().setSelectedCam(k.id);
    } else if (viewRequest.kind === "focus") {
      target = new THREE.Vector3(...viewRequest.point);
      const dir = camera.position.clone().sub(controls.target).normalize();
      pos = target.clone().add(dir.multiplyScalar(14));
    } else if (viewRequest.kind === "top") {
      const { centre, radius } = sceneCentre(c);
      target = centre;
      const fwd = new THREE.Vector3(0, 0, 1).transformDirection(world(cam0)).setY(0).normalize();
      // tiny offset along the camera heading keeps "up" on screen = away from the camera
      pos = target.clone().add(new THREE.Vector3(0, radius * 2.2, 0)).add(fwd.multiplyScalar(-0.01));
    } else {
      // overview: three-quarter view over the area where subjects moved
      const M = world(cam0);
      const C = new THREE.Vector3().setFromMatrixPosition(M);
      const fwd = new THREE.Vector3(0, 0, 1).transformDirection(M).setY(0).normalize();
      target = sceneCentre(c).centre;
      // three-quarter view, low enough to see people as figures, from the camera's side
      const dist = Math.max(16, target.distanceTo(C.clone().setY(0)) * 0.7);
      const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
      pos = target.clone()
        .add(fwd.clone().multiplyScalar(-dist * 0.85))
        .add(side.multiplyScalar(dist * 0.22))
        .add(new THREE.Vector3(0, dist * 0.5, 0));
    }
    anim.current = {
      t: 0,
      p0: camera.position.clone(), p1: pos,
      q0: controls.target.clone(), q1: target,
      f0: camera.fov, f1: fov,
    };
  }, [viewRequest, controls]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((_, dt) => {
    const a = anim.current;
    if (!a || !controls) return;
    a.t = Math.min(1, a.t + dt / 0.7);
    const k = a.t < 0.5 ? 4 * a.t ** 3 : 1 - (-2 * a.t + 2) ** 3 / 2;
    camera.position.lerpVectors(a.p0, a.p1, k);
    controls.target.lerpVectors(a.q0, a.q1, k);
    camera.fov = a.f0 + (a.f1 - a.f0) * k;
    camera.updateProjectionMatrix();
    controls.update();
    if (a.t >= 1) anim.current = null;
  });
  return null;
}

/* ------------------------------------------------------------------ root */
export default function Scene3D() {
  const c = useStore((s) => s.caseData);
  const layers = useStore((s) => s.layers);
  const presenting = useStore((s) => s.presenting);
  const tool = useStore((s) => s.tool);
  const hoverTrack = useStore((s) => s.hoverTrack);

  const onPick = (e) => {
    if (e.delta > 4) return; // it was an orbit drag, not a click
    const st = useStore.getState();
    if (st.tool === "orbit") return;
    e.stopPropagation();
    // the measured surface wins over the hypothetical ground plane when they coincide
    const hits = e.intersections?.length ? e.intersections : [e];
    const first = hits[0] ?? e;
    const hit = hits.find((h) => h.object.userData.src && h.distance <= first.distance + 0.25) ?? first;
    const p = { p: [hit.point.x, hit.point.y, hit.point.z], info: pickInfo(hit, st.caseData.cameras) };
    const pts = [...st.pending, p];
    if (pts.length < 2) { st.addPending(p); return; }
    st.clearPending();
    const [A, B] = pts;
    if (st.tool === "measure") {
      const m = { id: crypto.randomUUID?.() ?? String(Date.now()), a: A.p, b: B.p, pa: A.info, pb: B.info, t: st.time };
      const u = measureUncertainty(st.caseData, m, st.scale, st.scaleRef);
      m.summary = `misura ${st.measurements.length + 1}: ${u.L.toFixed(3)} m ±${u.sigma.toFixed(3)} (1σ), punti su ${SOURCE_LABEL[A.info.src]} e ${SOURCE_LABEL[B.info.src]}, a ${(st.time - st.caseData.timeStart).toFixed(2)} s`;
      st.addMeasurement(m);
    } else if (st.tool === "calibrate") {
      st.setDialog({ kind: "calibrate", a: A.p, b: B.p, pa: A.info, pb: B.info });
    }
  };

  return (
    <Canvas
      style={{ cursor: tool !== "orbit" ? "crosshair" : hoverTrack ? "pointer" : "grab" }}
      flat
      dpr={[1, 2]}
      camera={{ position: [0, 12, 12], fov: 50, near: 0.05, far: 3000 }}
      gl={{ preserveDrawingBuffer: true, antialias: true }}
      onCreated={({ gl }) => gl.setClearColor("#1d2733")}
    >
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} maxPolarAngle={Math.PI * 0.495}
        autoRotate={presenting} autoRotateSpeed={-0.5} />
      <Rig />
      <ExportHandle />
      {layers.grid && (
        <Grid
          infiniteGrid
          cellSize={1}
          sectionSize={5}
          cellColor="#2b3949"
          sectionColor="#3b4d62"
          fadeDistance={160}
          fadeStrength={1.5}
          position={[0, -0.01, 0]}
        />
      )}
      <mesh rotation-x={-Math.PI / 2} onClick={onPick} visible={false}>
        <planeGeometry args={[4000, 4000]} />
        <meshBasicMaterial />
      </mesh>
      {layers.apron && <GroundApron c={c} />}
      {c.cameras.map((cam) => (
        <group key={cam.id} matrixAutoUpdate={false} matrix={cam.alignmentM}>
          <Surface cam={cam} onPick={onPick} />
          {layers.buildings && <Buildings cam={cam} />}
          {layers.frustums && <Frustum cam={cam} />}
          {layers.tracks && cam.tracks.map((t) => <Subject key={t.key} track={t} cam={cam} />)}
        </group>
      ))}
      <Measurements />
    </Canvas>
  );
}
