import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { useStore } from "./store.js";
import { GEN } from "./Roto.jsx";
import { texturesFor } from "./Scene3D.jsx";

/* Completed parts of the scene that no camera saw: building volumes behind the
   visible facades, and an apron of floor around the reconstruction. They exist to
   make the scene read as a whole; with "Evidenzia le parti ricostruite" they are
   striped in violet, without it they blend in. */

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

const bVert = /* glsl */ `
  attribute vec2 fuv;
  varying vec2 vF;
  varying vec3 vN;
  varying vec3 vP;
  void main() {
    vF = fuv;
    vN = normalize(mat3(modelMatrix) * normal);
    vP = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const bFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uHeight;
  uniform sampler2D uFacade;
  uniform float uHasFacade;
  varying vec2 vF;
  varying vec3 vN;
  varying vec3 vP;
  ${GEN}
  void main() {
    vec3 n = normalize(vN);
    float key = max(dot(n, normalize(vec3(0.35, 0.85, 0.4))), 0.0);
    vec3 base = uHasFacade > 0.5 && vF.y >= 0.0 ? texture2D(uFacade, vF).rgb : uColor;
    vec3 c = base * (0.62 + 0.3 * key + 0.12 * n.y);
    c *= 0.88 + 0.12 * smoothstep(0.0, uHeight, vP.y);   // a little darker at street level
    gl_FragColor = vec4(generatedTint(c, 1.0), 1.0);
  }`;

function buildingGeometry(b, facadeLen) {
  const [A, B, C, D] = b.footprint;
  const h = b.height;
  // push the closing front face 5 cm behind the real facade so the real one always wins
  const back = [C[0] - B[0], C[1] - B[1]];
  const L = Math.hypot(...back) || 1;
  const o = [(back[0] / L) * 0.05, (back[1] / L) * 0.05];
  const a = [A[0] + o[0], A[1] + o[1]], bb = [B[0] + o[0], B[1] + o[1]];
  const quad = (p, q, y0, y1) => [[p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y0, p[1]], [q[0], y1, q[1]], [p[0], y1, p[1]]];
  // facade texture coordinates: u = metres along the wall / facade length (repeats), v = height
  const fq = (p, q) => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) / facadeLen;
    return [[0, 0], [len, 0], [len, 1], [0, 0], [len, 1], [0, 1]];
  };
  const tris = [
    ...quad(a, bb, 0, h), ...quad(bb, C, 0, h), ...quad(C, D, 0, h), ...quad(D, a, 0, h),
    // roof
    [a[0], h, a[1]], [bb[0], h, bb[1]], [C[0], h, C[1]], [a[0], h, a[1]], [C[0], h, C[1]], [D[0], h, D[1]],
  ];
  const uvs = [...fq(a, bb), ...fq(bb, C), ...fq(C, D), ...fq(D, a), ...Array(6).fill([0, -1])];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(tris.flat(), 3));
  g.setAttribute("fuv", new THREE.Float32BufferAttribute(uvs.flat(), 2));
  g.computeVertexNormals();
  return g;
}

export function Buildings({ cam }) {
  const items = useMemo(() => (cam.buildings ?? []).map((b) => {
    const tex = b.textureUrl ? new THREE.TextureLoader().load(b.textureUrl) : null;
    if (tex) { tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping; tex.anisotropy = 8; }
    const m = new THREE.ShaderMaterial({ alphaToCoverage: true,
      vertexShader: bVert, fragmentShader: bFrag, side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: new THREE.Vector3(...b.color.map((v) => v / 255)) }, uHeight: { value: b.height }, uShowGen: { value: 1 },
        uFacade: { value: tex }, uHasFacade: { value: tex ? 1 : 0 },
      },
    });
    return { g: buildingGeometry(b, b.facade_length_m), m, tex };
  }), [cam]);
  useEffect(() => () => items.forEach(({ g, m, tex }) => { g.dispose(); m.dispose(); tex?.dispose(); }), [items]);
  useFrame(() => {
    const on = useStore.getState().layers.generated ? 1 : 0;
    for (const { m } of items) m.uniforms.uShowGen.value = on;
  });
  return items.map(({ g, m }, i) => <mesh key={i} geometry={g} material={m} />);
}

const aVert = /* glsl */ `
  varying vec3 vW;
  varying vec2 vR;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vR = position.xz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const aFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform sampler2D uDetail;
  uniform float uTile;
  uniform float uHasDetail;
  varying vec3 vW;
  varying vec2 vR;
  ${BAYER}
  ${GEN}
  void main() {
    float r = length(vR);                    // 0 at the centre, 1 at the rim
    float a = 1.0 - smoothstep(0.3, 1.0, r);
    if (a < 0.02) discard;
    vec3 c = uColor * 0.92;
    if (uHasDetail > 0.5) c *= 1.0 + (texture2D(uDetail, vW.xz / uTile).r - 0.5) * 0.8;
    gl_FragColor = vec4(generatedTint(c, 1.0), a);
  }`;

/** Floor continuing around the reconstruction, fading out at the rim. */
export function GroundApron({ c }) {
  const { gl } = useThree();
  const cam = c.cameras[0];
  const tx = texturesFor(cam, gl);
  const { centre, radius } = useMemo(() => {
    const pts = [];
    for (const k of c.cameras) {
      for (const t of k.tracks) for (const [x, z] of t.p) pts.push(new THREE.Vector3(x, 0, z).applyMatrix4(k.alignmentM));
      const P = k.positions;
      for (let i = 0; i < P.length; i += 3 * 97) if (Math.abs(P[i + 1]) < 0.05) pts.push(new THREE.Vector3(P[i], 0, P[i + 2]).applyMatrix4(k.alignmentM));
    }
    const box = new THREE.Box3().setFromPoints(pts);
    const ctr = box.getCenter(new THREE.Vector3()).setY(0);
    const size = box.getSize(new THREE.Vector3());
    return { centre: ctr, radius: Math.max(size.x, size.z) * 0.9 + 15 };
  }, [c]);
  const mat = useMemo(() => new THREE.ShaderMaterial({ alphaToCoverage: true,
    vertexShader: aVert, fragmentShader: aFrag,
    uniforms: {
      uColor: { value: new THREE.Vector3(...(cam.floor_detail?.floor_rgb ?? [120, 128, 120]).map((v) => v / 255)) },
      uDetail: { value: tx.detail }, uTile: { value: cam.floor_detail?.tile_m ?? 6 }, uHasDetail: { value: tx.detail ? 1 : 0 },
      uShowGen: { value: 1 },
    },
  }), [cam, tx]);
  const geom = useMemo(() => new THREE.CircleGeometry(1, 96).rotateX(-Math.PI / 2), []);
  useEffect(() => () => { mat.dispose(); geom.dispose(); }, [mat, geom]);
  useFrame(() => { mat.uniforms.uShowGen.value = useStore.getState().layers.generated ? 1 : 0; });
  return <mesh geometry={geom} material={mat} position={[centre.x, -0.04, centre.z]} scale={[radius, 1, radius]} renderOrder={-1} />;
}
