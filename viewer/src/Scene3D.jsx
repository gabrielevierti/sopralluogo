import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Grid, Html, Line, Bvh } from "@react-three/drei";
import { useStore, trackColor } from "./store.js";
import { sampleTrack, fmtLen } from "./caseLoader.js";
import { getVideo } from "./Video.jsx";

/* ------------------------------------------------------------------ surface */
const vert = /* glsl */ `
  attribute vec3 rgb;
  uniform mat4 uCamFromWorld;
  uniform vec4 uK;
  uniform vec2 uSize;
  uniform float uPointSize;
  varying vec3 vColor;
  varying vec2 vUv;
  varying float vIn;
  void main() {
    vColor = rgb;
    vec4 pc = uCamFromWorld * vec4(position, 1.0);
    vec2 px = vec2(uK.x * pc.x / pc.z + uK.z, uK.y * pc.y / pc.z + uK.w);
    vUv = vec2(px.x / uSize.x, 1.0 - px.y / uSize.y);
    vIn = (pc.z > 0.0 && vUv.x >= 0.0 && vUv.x <= 1.0 && vUv.y >= 0.0 && vUv.y <= 1.0) ? 1.0 : 0.0;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uPointSize * 60.0 / -mv.z, 1.0, 6.0);
  }`;
const frag = /* glsl */ `
  uniform sampler2D uVideo;
  uniform float uMix;
  varying vec3 vColor;
  varying vec2 vUv;
  varying float vIn;
  void main() {
    vec3 c = vColor;
    if (vIn > 0.5 && uMix > 0.0) c = mix(c, texture2D(uVideo, vUv).rgb, uMix);
    gl_FragColor = vec4(c, 1.0);
  }`;

function Surface({ cam, onPick }) {
  const layers = useStore((s) => s.layers);
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(cam.positions, 3));
    g.setAttribute("rgb", new THREE.BufferAttribute(cam.colors, 3, true));
    g.setIndex(new THREE.BufferAttribute(cam.indices, 1));
    g.computeBoundingSphere();
    return g;
  }, [cam]);
  // The current video frame is copied into a canvas texture. Going through a canvas is the
  // most portable path (paused and seeked videos, every GPU backend).
  const tex = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = cam.width;
    canvas.height = cam.height;
    const t = new THREE.CanvasTexture(canvas);
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.userData.ctx = canvas.getContext("2d");
    t.userData.video = getVideo(cam);
    return t;
  }, [cam]);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        side: THREE.DoubleSide,
        uniforms: {
          uCamFromWorld: { value: cam.camFromWorld },
          uK: { value: new THREE.Vector4(cam.camera.K.fx, cam.camera.K.fy, cam.camera.K.cx, cam.camera.K.cy) },
          uSize: { value: new THREE.Vector2(cam.camera.K.width, cam.camera.K.height) },
          uVideo: { value: tex },
          uMix: { value: 1 },
          uPointSize: { value: 1.6 },
        },
      }),
    [cam, tex]
  );
  useEffect(() => () => { geom.dispose(); mat.dispose(); tex.dispose(); }, [geom, mat, tex]);
  // project the live frame only when the video actually has one (else keep the clean background colours)
  useFrame(() => {
    const v = tex.userData.video;
    const t = useStore.getState().time - cam.time_offset;
    const live = v.readyState >= 2 && v.videoWidth > 0 && t >= 0 && t <= cam.duration;
    if (live && layers.projection && (v.currentTime !== tex.userData.last || !v.paused)) {
      tex.userData.ctx.drawImage(v, 0, 0, cam.width, cam.height);
      tex.needsUpdate = true;
      tex.userData.last = v.currentTime;
      tex.userData.ready = true;
    }
    mat.uniforms.uMix.value = layers.projection && live && tex.userData.ready ? 1 : 0;
  });
  return (
    <>
      {layers.surface && (
        <Bvh firstHitOnly>
          <mesh geometry={geom} material={mat} onClick={onPick} />
        </Bvh>
      )}
      {layers.points && <points geometry={geom} material={mat} />}
    </>
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
      <Html position={apex} zIndexRange={[5, 0]}>
        <div className="cam-label">{cam.id}, h {cam.camera.height_m.toFixed(1)} m</div>
      </Html>
    </group>
  );
}

/* ------------------------------------------------------------------ subjects */
// short or far-away tracks give speeds dominated by noise: don't print a number then
export const reliableSpeed = (t) => t.stats.duration_s >= 1.5 && t.stats.speed_sigma_kmh <= 4;

function Subject({ track }) {
  const time = useStore((s) => s.time);
  const layers = useStore((s) => s.layers);
  const scale = useStore((s) => s.scale);
  const selected = useStore((s) => s.selectedTrack === track.key);
  const select = useStore((s) => s.setSelectedTrack);
  const color = trackColor(track.id);
  const pathPts = useMemo(() => track.p.map(([x, z]) => [x, 0.04, z]), [track]);
  const s = sampleTrack(track, time);
  const trail = useMemo(() => {
    if (!s) return null;
    const pts = pathPts.slice(0, s.i + 1);
    pts.push([s.x, 0.05, s.z]);
    return pts.length >= 2 ? pts : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.i, pathPts, s && Math.round(s.x * 20), s && Math.round(s.z * 20)]);
  const isPerson = track.cls === "persona";
  const h = isPerson ? track.stats.height_m ?? 1.7 : 1.5;
  return (
    <group>
      {layers.trails && (
        <Line points={pathPts} color={color} lineWidth={selected ? 2.5 : 1.2} transparent opacity={selected ? 0.9 : 0.28} />
      )}
      {layers.trails && trail && <Line points={trail} color={color} lineWidth={selected ? 3.5 : 2.2} />}
      {s && (
        <group position={[s.x, 0, s.z]}>
          <mesh position={[0, h / 2, 0]} onClick={(e) => { e.stopPropagation(); select(track.key); }}>
            {isPerson ? <cylinderGeometry args={[0.22, 0.22, h, 18]} /> : <boxGeometry args={[1.8, h, 4.2]} />}
            <meshBasicMaterial color={selected ? "#f4c430" : color} transparent opacity={s.interp ? 0.3 : 0.62} />
          </mesh>
          {layers.uncertainty && Number.isFinite(s.sigma) && (
            <mesh rotation-x={-Math.PI / 2} position={[0, 0.03, 0]}>
              <ringGeometry args={[Math.max(2 * s.sigma - 0.04, 0.01), 2 * s.sigma, 48]} />
              <meshBasicMaterial color={color} transparent opacity={0.6} side={THREE.DoubleSide} />
            </mesh>
          )}
          <Html position={[0, h + 0.35, 0]} zIndexRange={[10, 0]}>
            <div className={`label3d ${selected ? "sel" : ""}`}>
              {s.speed != null && reliableSpeed(track) && <div className="chip">{(s.speed * scale).toFixed(1)} km/h</div>}
              <div className="tent"><span>{track.id}</span></div>
            </div>
          </Html>
        </group>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ measurements */
function Measurements() {
  const measurements = useStore((s) => s.measurements);
  const pending = useStore((s) => s.pending);
  const scale = useStore((s) => s.scale);
  const tool = useStore((s) => s.tool);
  const color = tool === "calibrate" ? "#f4c430" : "#5cc8e8";
  return (
    <group>
      {measurements.map((m) => {
        const a = new THREE.Vector3(...m.a), b = new THREE.Vector3(...m.b);
        const mid = a.clone().add(b).multiplyScalar(0.5);
        return (
          <group key={m.id}>
            <Line points={[a, b]} color="#5cc8e8" lineWidth={2.5} depthTest={false} />
            {[a, b].map((p, i) => (
              <mesh key={i} position={p} renderOrder={10}>
                <sphereGeometry args={[0.07, 12, 8]} />
                <meshBasicMaterial color="#5cc8e8" depthTest={false} />
              </mesh>
            ))}
            <Html position={mid} zIndexRange={[20, 0]}>
              <div className="measure-label">{fmtLen(a.distanceTo(b) * scale)}</div>
            </Html>
          </group>
        );
      })}
      {pending.map((p, i) => (
        <mesh key={i} position={p} renderOrder={10}>
          <sphereGeometry args={[0.09, 12, 8]} />
          <meshBasicMaterial color={color} depthTest={false} />
        </mesh>
      ))}
    </group>
  );
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
      const dist = Math.max(18, target.distanceTo(C.clone().setY(0)) * 0.9);
      const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
      pos = target.clone()
        .add(fwd.clone().multiplyScalar(-dist * 1.0))
        .add(side.multiplyScalar(dist * 0.18))
        .add(new THREE.Vector3(0, dist * 0.75, 0));
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

  const onPick = (e) => {
    if (e.delta > 4) return; // it was an orbit drag, not a click
    const st = useStore.getState();
    if (st.tool === "orbit") return;
    e.stopPropagation();
    const p = [e.point.x, e.point.y, e.point.z];
    const pts = [...st.pending, p];
    if (pts.length < 2) { st.addPending(p); return; }
    st.clearPending();
    if (st.tool === "measure") {
      st.addMeasurement({ id: crypto.randomUUID?.() ?? String(Date.now()), a: pts[0], b: pts[1], t: st.time });
    } else if (st.tool === "calibrate") {
      st.setDialog({ kind: "calibrate", a: pts[0], b: pts[1] });
    }
  };

  return (
    <Canvas
      flat
      dpr={[1, 2]}
      camera={{ position: [0, 12, 12], fov: 50, near: 0.05, far: 3000 }}
      gl={{ preserveDrawingBuffer: true, antialias: true }}
      onCreated={({ gl }) => gl.setClearColor("#1d2733")}
    >
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} maxPolarAngle={Math.PI * 0.495} />
      <Rig />
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
      {c.cameras.map((cam) => (
        <group key={cam.id} matrixAutoUpdate={false} matrix={cam.alignmentM}>
          <Surface cam={cam} onPick={onPick} />
          {layers.frustums && <Frustum cam={cam} />}
          {layers.tracks && cam.tracks.map((t) => <Subject key={t.key} track={t} />)}
        </group>
      ))}
      <Measurements />
    </Canvas>
  );
}
