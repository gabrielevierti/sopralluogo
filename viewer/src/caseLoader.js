import * as THREE from "three";

/** A case can come from a URL (sopralluogo serve) or from a local folder (nothing is uploaded). */
export function urlSource(base) {
  const b = base.endsWith("/") ? base : base + "/";
  return {
    label: b,
    url: (p) => b + p,
    async json(p) {
      const r = await fetch(b + p);
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      return r.json();
    },
    async buffer(p) {
      const r = await fetch(b + p);
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      return r.arrayBuffer();
    },
    async has(p) {
      try { return (await fetch(b + p, { method: "HEAD" })).ok; } catch { return false; }
    },
  };
}

export function filesSource(files) {
  // files: File[] from a directory picker / drop. Paths are relative to the case folder.
  const map = new Map();
  let root = "";
  const withScene = files.find((f) => (f.relPath || f.webkitRelativePath || f.name).endsWith("scene.json"));
  if (withScene) {
    const p = withScene.relPath || withScene.webkitRelativePath || withScene.name;
    root = p.slice(0, p.length - "scene.json".length);
  }
  for (const f of files) {
    const p = f.relPath || f.webkitRelativePath || f.name;
    if (p.startsWith(root)) map.set(p.slice(root.length), f);
  }
  const urls = new Map();
  const need = (p) => {
    const f = map.get(p);
    if (!f) throw new Error(`File mancante nella cartella: ${p}`);
    return f;
  };
  return {
    label: root.replace(/\/$/, "") || "cartella locale",
    url: (p) => {
      if (!urls.has(p)) urls.set(p, URL.createObjectURL(need(p)));
      return urls.get(p);
    },
    json: async (p) => JSON.parse(await need(p).text()),
    buffer: async (p) => need(p).arrayBuffer(),
    has: async (p) => map.has(p),
  };
}

const m4 = (rows) => new THREE.Matrix4().set(...rows.flat());

export async function loadCase(src, onProgress = () => {}) {
  onProgress("Leggo scene.json");
  const scene = await src.json("scene.json");
  if (!String(scene.format || "").startsWith("sopralluogo-case")) throw new Error("scene.json non riconosciuto");
  const manifest = (await src.has("manifest.json")) ? await src.json("manifest.json") : null;
  const workspace = (await src.has("workspace.json")) ? await src.json("workspace.json") : null;

  const cameras = [];
  for (const c of scene.cameras) {
    onProgress(`Carico la superficie di ${c.id}`);
    const [pos, col, idx] = await Promise.all([
      src.buffer(c.mesh.positions), src.buffer(c.mesh.colors), src.buffer(c.mesh.indices),
    ]);
    onProgress(`Carico i soggetti di ${c.id}`);
    const tracks = (await src.json(c.tracks)).map((t) => ({
      ...t,
      key: `${c.id}:${t.id}`,
      camId: c.id,
      tg: t.t.map((x) => x + c.time_offset),
    }));
    const worldFromCam = m4(c.camera.world_from_cam);
    cameras.push({
      ...c,
      positions: new Float32Array(pos),
      colors: new Uint8Array(col),
      indices: new Uint32Array(idx),
      tracks,
      worldFromCam,
      camFromWorld: worldFromCam.clone().invert(),
      alignmentM: m4(c.alignment),
      videoUrl: src.url(c.video),
      backgroundUrl: src.url(c.background),
    });
  }
  const starts = cameras.map((c) => c.time_offset);
  const ends = cameras.map((c) => c.time_offset + c.duration);
  return {
    title: scene.title,
    source: src.label,
    scene,
    manifest,
    workspace,
    cameras,
    timeStart: Math.min(...starts),
    timeEnd: Math.max(...ends),
  };
}

/** Linear interpolation of a track at global time t. Returns null outside the track's lifetime. */
export function sampleTrack(track, t) {
  const T = track.tg;
  if (t < T[0] || t > T[T.length - 1]) return null;
  let lo = 0, hi = T.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (T[mid] <= t) lo = mid; else hi = mid;
  }
  const span = T[hi] - T[lo];
  const a = span > 0 ? (t - T[lo]) / span : 0;
  const L = (x, y) => x + (y - x) * a;
  const p0 = track.p[lo], p1 = track.p[hi];
  const b0 = track.bbox[lo], b1 = track.bbox[hi];
  return {
    i: lo,
    x: L(p0[0], p1[0]),
    z: L(p0[1], p1[1]),
    sigma: L(track.sigma[lo], track.sigma[hi]),
    speed: track.speed[lo] ?? track.speed[hi],
    bbox: b0.map((v, k) => L(v, b1[k])),
    interp: track.interp[lo] && track.interp[hi],
  };
}

export function fmtTime(t) {
  if (!Number.isFinite(t)) return "--:--.--";
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, "0")}:${r.toFixed(2).padStart(5, "0")}`;
}

export const fmtLen = (m) => (m >= 100 ? `${m.toFixed(0)} m` : m >= 10 ? `${m.toFixed(1)} m` : `${m.toFixed(2)} m`);
