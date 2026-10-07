import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { useStore } from "./store.js";

/* A person (or vehicle) rebuilt from its own silhouette in the current frame.

   The segmentation mask of the subject ("rotoscoping") is turned into a puffy 3D
   shape: thick in the middle of the body, thin at the edges. The front shows the
   real video pixels, so pose, clothes and gestures are exactly the ones recorded.
   The back cannot be seen by the camera: it repeats the silhouette, darker, and is
   marked as reconstructed. */

const GEN = /* glsl */ `
  uniform float uShowGen;
  vec3 generatedTint(vec3 c, float amount) {
    float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 12.0));
    return mix(c, vec3(0.62, 0.48, 1.0), amount * uShowGen * (0.10 + 0.14 * stripe));
  }`;
export { GEN };

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

const vert = /* glsl */ `
  uniform sampler2D uMask;
  uniform vec4 uMaskRect;
  uniform vec2 uMaskTexel;
  uniform float uHasMask;
  uniform float uDepth;
  uniform float uSide;
  varying vec2 vLocal;
  varying vec3 vN;
  varying float vBlur;
  float maskAt(vec2 l) {
    vec2 uv = mix(uMaskRect.xy, uMaskRect.zw, clamp(l, 0.0, 1.0));
    return texture2D(uMask, uv).r;
  }
  float blurAt(vec2 l) {
    // 3x3 blur over ~3 mask texels: a smooth "distance from the edge"
    vec2 d = 3.0 * uMaskTexel / (uMaskRect.zw - uMaskRect.xy);
    float s = 0.0;
    for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) s += maskAt(l + vec2(float(i), float(j)) * d);
    return s / 9.0;
  }
  float inflate(float b) { return uDepth * sqrt(clamp((b - 0.25) / 0.65, 0.0, 1.0)); }
  void main() {
    vLocal = uv;
    float b = uHasMask > 0.5 ? blurAt(uv) : 0.6 * (1.0 - pow(abs(uv.x * 2.0 - 1.0), 2.0));
    vBlur = b;
    float z = inflate(b);
    // normal from the slope of the inflated surface
    float e = 0.03;
    float zx = uHasMask > 0.5 ? inflate(blurAt(uv + vec2(e, 0.0))) - z : 0.0;
    float zy = uHasMask > 0.5 ? inflate(blurAt(uv + vec2(0.0, e))) - z : 0.0;
    vec3 n = normalize(vec3(-zx * uSide / e, -zy * uSide / e, 0.35) * vec3(1.0, 1.0, uSide));
    vN = normalize(mat3(modelMatrix) * n);
    vec3 p = position + vec3(0.0, 0.0, uSide * z);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;

const frag = /* glsl */ `
  uniform sampler2D uVideo;
  uniform sampler2D uStatic;
  uniform sampler2D uMask;
  uniform vec4 uMaskRect;
  uniform float uHasMask;
  uniform vec4 uRect;
  uniform vec2 uTexel;
  uniform float uSide;
  uniform float uHighlight;
  varying vec2 vLocal;
  varying vec3 vN;
  varying float vBlur;
  ${BAYER}
  ${GEN}
  float fg(vec2 uv) { return distance(texture2D(uVideo, uv).rgb, texture2D(uStatic, uv).rgb); }
  void main() {
    vec2 uv = mix(uRect.xy, uRect.zw, vLocal);
    // background subtraction gives fine edges, the segmentation mask gives a reliable shape
    float d = fg(uv) * 0.4 + 0.15 * (fg(uv + vec2(uTexel.x, 0.0)) + fg(uv - vec2(uTexel.x, 0.0))
             + fg(uv + vec2(0.0, uTexel.y)) + fg(uv - vec2(0.0, uTexel.y)));
    // the live frame decides the outline (it is exactly in sync with the video); the
    // segmentation, sampled at the analysis rate, only bounds it and fills the body's core
    float a = smoothstep(0.06, 0.14, d);
    if (uHasMask > 0.5) {
      float seg = texture2D(uMask, mix(uMaskRect.xy, uMaskRect.zw, vLocal)).r;
      float core = smoothstep(0.8, 0.97, seg) * smoothstep(0.55, 0.8, vBlur);
      a = max(a * smoothstep(0.06, 0.28, vBlur), core);
    } else {
      a *= 1.0 - smoothstep(0.35, 0.5, abs(vLocal.x - 0.5));
    }
    vec2 e = min(vLocal, 1.0 - vLocal);
    a *= smoothstep(0.0, 0.03, e.x) * smoothstep(0.0, 0.015, e.y);
    if (a < 0.03) discard;
    vec3 c = texture2D(uVideo, uv).rgb;
    float light = 0.82 + 0.18 * max(dot(normalize(vN), normalize(vec3(0.3, 0.9, 0.4))), 0.0);
    c *= light;
    if (uSide < 0.0) c = generatedTint(c * 0.72, 1.0); // the unseen back
    c = mix(c, vec3(0.957, 0.769, 0.188), uHighlight * 0.12);
    gl_FragColor = vec4(c, a);
  }`;

const planeGeom = new THREE.PlaneGeometry(1, 1, 24, 48).translate(0, 0.5, 0);

export function RotoFigure({ cam, tx, maskTex, masks, track, s, height, selected, onSelect }) {
  const ref = useRef();
  const { camera } = useThree();
  const mats = useMemo(() => {
    const shared = {
      uVideo: { value: tx.frame }, uStatic: { value: tx.bg }, uMask: { value: maskTex },
      uMaskRect: { value: new THREE.Vector4() }, uHasMask: { value: 0 },
      uMaskTexel: { value: masks ? new THREE.Vector2(1 / masks.size[0], 1 / masks.size[1]) : new THREE.Vector2(1, 1) },
      uRect: { value: new THREE.Vector4() }, uTexel: { value: new THREE.Vector2(1 / cam.width, 1 / cam.height) },
      uDepth: { value: 0.15 }, uHighlight: { value: 0 }, uShowGen: { value: 1 },
    };
    const make = (side) => new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide,
      uniforms: { ...shared, uSide: { value: side } },
      alphaToCoverage: true, // soft, sort-free edges with the canvas' multisampling
    });
    return { shared, front: make(1), back: make(-1) };
  }, [cam, tx, maskTex, masks]);
  useEffect(() => () => { mats.front.dispose(); mats.back.dispose(); }, [mats]);
  // capture camera position in the camera group's local frame
  const camLocal = useMemo(() => new THREE.Vector3().setFromMatrixPosition(cam.worldFromCam), [cam]);

  useFrame(() => {
    const g = ref.current, cur = s.current;
    if (!g?.parent || !cur) return;
    const st = useStore.getState();
    g.visible = tx.live && !cur.hidden;
    const [x1, y1, x2, y2] = cur.bbox;
    const width = height * (x2 - x1) / Math.max(y2 - y1, 1);
    g.position.set(cur.x, 0, cur.z);
    g.scale.set(width, height, 1);
    // face the camera that filmed it; turn a little towards the viewer to keep it readable
    const capture = Math.atan2(camLocal.x - cur.x, camLocal.z - cur.z);
    const viewer = g.parent.worldToLocal(camera.position.clone());
    let dv = Math.atan2(viewer.x - cur.x, viewer.z - cur.z) - capture;
    while (dv > Math.PI) dv -= 2 * Math.PI;
    while (dv < -Math.PI) dv += 2 * Math.PI;
    g.rotation.y = capture + Math.max(-1.3, Math.min(1.3, dv * 0.75));
    const sh = mats.shared;
    sh.uRect.value.set(x1 / cam.width, 1 - y2 / cam.height, x2 / cam.width, 1 - y1 / cam.height);
    sh.uDepth.value = 0.2 * width; // metres: z is not scaled by the group. A body is not a pillow
    const mi = track.mask?.[cur.i] ?? -1;
    if (masks && mi >= 0) {
      const [cw, ch] = masks.cell, [W, H] = masks.size;
      const r = Math.floor(mi / masks.cols), c = mi % masks.cols;
      sh.uMaskRect.value.set((c * cw) / W, 1 - ((r + 1) * ch) / H, ((c + 1) * cw) / W, 1 - (r * ch) / H);
      sh.uHasMask.value = 1;
    } else sh.uHasMask.value = 0;
    sh.uHighlight.value = selected ? 1 : 0;
    sh.uShowGen.value = st.layers.generated ? 1 : 0;
  });
  return (
    <group ref={ref} onClick={(e) => { e.stopPropagation(); onSelect(); }}>
      <mesh geometry={planeGeom} material={mats.front} />
      <mesh geometry={planeGeom} material={mats.back} />
    </group>
  );
}
