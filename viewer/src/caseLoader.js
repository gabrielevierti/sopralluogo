import * as THREE from "three";
import { sha256Buffer } from "./sha256.js";

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
    async stream(p) {
      const r = await fetch(b + p, { cache: "no-store" });
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      return r.body;
    },
    async has(p) {
      try { return (await fetch(b + p, { method: "HEAD" })).ok; } catch { return false; }
    },
    async list() { return null; }, // a web server cannot list the folder
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
    stream: async (p) => need(p).stream(),
    has: async (p) => map.has(p),
    list: async () => [...map.keys()],
  };
}

const m4 = (rows) => new THREE.Matrix4().set(...rows.flat());

export async function loadCase(src, onProgress = () => {}) {
  onProgress("Leggo scene.json");
  const scene = await src.json("scene.json");
  if (!String(scene.format || "").startsWith("sopralluogo-case")) throw new Error("scene.json non riconosciuto");
  let manifest = null, fingerprint = null;
  if (await src.has("manifest.json")) {
    // the case fingerprint is the SHA-256 of manifest.json exactly as stored on disk
    const raw = await src.buffer("manifest.json");
    fingerprint = await sha256Buffer(raw);
    manifest = JSON.parse(new TextDecoder().decode(raw));
  }
  const workspace = (await src.has("workspace.json")) ? await src.json("workspace.json") : null;

  const cameras = [];
  for (const c of scene.cameras) {
    onProgress(`Carico la superficie di ${c.id}`);
    const [pos, col, idx, q, fpos, fidx] = await Promise.all([
      src.buffer(c.mesh.positions), src.buffer(c.mesh.colors), src.buffer(c.mesh.indices),
      c.mesh.quality ? src.buffer(c.mesh.quality) : Promise.resolve(null),
      c.fill ? src.buffer(c.fill.positions) : Promise.resolve(null),
      c.fill ? src.buffer(c.fill.indices) : Promise.resolve(null),
    ]);
    const [kindBuf, fillQ] = await Promise.all([
      c.mesh.kind ? src.buffer(c.mesh.kind) : Promise.resolve(null),
      c.fill?.quality ? src.buffer(c.fill.quality) : Promise.resolve(null),
    ]);
    onProgress(`Carico i soggetti di ${c.id}`);
    const tracks = (await src.json(c.tracks)).map((t) => ({
      ...t,
      key: `${c.id}:${t.id}`,
      camId: c.id,
      tg: t.t.map((x) => x + c.time_offset),
      gapsG: (t.gaps ?? []).map(([a, b]) => [a + c.time_offset, b + c.time_offset]),
      views: (t.views ?? []).map((v) => ({
        ...v,
        tg: v.t + c.time_offset,
        bodyUrl: src.url(v.body),
        headUrl: src.url(v.head),
      })),
    }));
    const worldFromCam = m4(c.camera.world_from_cam);
    cameras.push({
      ...c,
      positions: new Float32Array(pos),
      colors: new Uint8Array(col),
      indices: new Uint32Array(idx),
      quality: q ? new Uint8Array(q) : new Uint8Array(pos.byteLength / 12).fill(255),
      fillPositions: fpos ? new Float32Array(fpos) : null,
      fillIndices: fidx ? new Uint32Array(fidx) : null,
      fillUrl: c.fill ? src.url(c.fill.texture) : null,
      kind: kindBuf ? new Uint8Array(kindBuf) : new Uint8Array(pos.byteLength / 12),
      fillQuality: fillQ ? new Uint8Array(fillQ) : null,
      maskUrl: c.masks ? src.url(c.masks.atlas) : null,
      detailUrl: c.floor_detail ? src.url(c.floor_detail.texture) : null,
      buildings: (c.buildings ?? []).map((b) => ({ ...b, textureUrl: b.texture ? src.url(b.texture) : null })),
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
    src,
    scene,
    manifest,
    fingerprint,
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
    interp: !!(track.interp[lo] && track.interp[hi]),
    hidden: (track.gapsG ?? []).some(([a, b]) => t > a && t < b),
    h: track.h?.[lo] ?? track.h?.[hi] ?? null,
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

/** Manual correction: append track `b` to track `a` (same camera). Returns the merged track. */
export function mergeTracks(a, b) {
  const idx = [...a.t.map((_, i) => ["a", i]), ...b.t.map((_, i) => ["b", i])]
    .sort((x, y) => (x[0] === "a" ? a : b).t[x[1]] - (y[0] === "a" ? a : b).t[y[1]]);
  const pick = (k) => idx.map(([w, i]) => (w === "a" ? a : b)[k][i]);
  const m = { ...a };
  for (const k of ["t", "tg", "frame", "p", "p_raw", "sigma", "speed", "h", "bbox", "conf", "interp"]) m[k] = pick(k);
  const [first, second] = a.tg[0] <= b.tg[0] ? [a, b] : [b, a];
  const gap = [first.tg[first.tg.length - 1], second.tg[0]];
  m.gapsG = [...(a.gapsG ?? []), ...(b.gapsG ?? []), ...(gap[1] > gap[0] ? [gap] : [])];
  m.views = [...(a.views ?? []), ...(b.views ?? [])];
  m.links = [...(a.links ?? []), { manual: true, merged_id: b.id }];
  m.stats = { ...a.stats, start_s: Math.min(a.stats.start_s, b.stats.start_s), end_s: Math.max(a.stats.end_s, b.stats.end_s),
    path_m: a.stats.path_m + b.stats.path_m, duration_s: Math.max(a.stats.end_s, b.stats.end_s) - Math.min(a.stats.start_s, b.stats.start_s) };
  m.manualMerges = [...(a.manualMerges ?? []), b.id];
  return m;
}
