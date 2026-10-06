import { useEffect, useRef, useState } from "react";
import { useStore, trackColor } from "./store.js";
import { sampleTrack, fmtTime } from "./caseLoader.js";

/* One <video> per camera, created once and shared by the panel (display) and the 3D
   view (projected texture). They are the ground truth for "what the camera saw". */
const videos = new Map();
export function getVideo(cam) {
  let v = videos.get(cam.id);
  if (!v) {
    v = document.createElement("video");
    v.src = cam.videoUrl;
    v.preload = "auto";
    v.playsInline = true;
    v.muted = true;
    v.crossOrigin = "anonymous";
    videos.set(cam.id, v);
  }
  return v;
}
export function disposeVideos() {
  for (const v of videos.values()) { v.pause(); v.removeAttribute("src"); v.load(); }
  videos.clear();
}

const localTime = (cam, t) => t - cam.time_offset;
const inRange = (cam, t) => localTime(cam, t) >= 0 && localTime(cam, t) <= cam.duration;

/** Drives the global clock. While playing, the selected camera's video is the master. */
export function Clock() {
  useEffect(() => {
    let raf, last = performance.now();
    const loop = (now) => {
      const st = useStore.getState();
      const c = st.caseData;
      const dt = (now - last) / 1000;
      last = now;
      if (c) {
        let t = st.time;
        if (st.playing) {
          const master = c.cameras.find((k) => k.id === st.selectedCam);
          const mv = master && videos.get(master.id);
          if (mv && inRange(master, t) && !mv.paused && !mv.seeking && mv.readyState >= 2) {
            t = mv.currentTime + master.time_offset;
          } else {
            t = t + dt * st.rate;
          }
          if (t >= c.timeEnd) { t = c.timeEnd; st.setPlaying(false); }
          if (t !== st.time) st.setTime(t);
        }
        for (const cam of c.cameras) {
          const v = videos.get(cam.id);
          if (!v) continue;
          const lt = localTime(cam, t);
          if (lt < 0 || lt > cam.duration) {
            if (!v.paused) v.pause();
            continue;
          }
          if (st.playing) {
            v.playbackRate = st.rate;
            if (v.paused) v.play().catch(() => {});
            if (cam.id !== st.selectedCam && Math.abs(v.currentTime - lt) > 0.12 && !v.seeking) v.currentTime = lt;
          } else {
            if (!v.paused) v.pause();
            if (Math.abs(v.currentTime - lt) > 0.002 && !v.seeking) v.currentTime = lt;
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return null;
}

export function VideoPanel() {
  const c = useStore((s) => s.caseData);
  const selectedCam = useStore((s) => s.selectedCam);
  const setSelectedCam = useStore((s) => s.setSelectedCam);
  const layers = useStore((s) => s.layers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const time = useStore((s) => s.time);
  const selectedTrack = useStore((s) => s.selectedTrack);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const [large, setLarge] = useState(false);
  const [muted, setMuted] = useState(true);
  const boxRef = useRef(null);
  const canvasRef = useRef(null);
  const cam = c.cameras.find((k) => k.id === selectedCam) ?? c.cameras[0];

  // mount the shared video elements in the panel; only the selected one is visible
  useEffect(() => {
    const box = boxRef.current;
    for (const k of c.cameras) {
      const v = getVideo(k);
      if (v.parentElement !== box) box.prepend(v);
      v.className = k.id === cam.id ? "" : "hidden";
      v.muted = k.id === cam.id ? muted : true;
    }
  }, [c, cam.id, muted]);

  // detection boxes on top of the video
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(rect.width * dpr);
    cv.height = Math.round(rect.height * dpr);
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!layers.boxes || !inRange(cam, time)) return;
    const sx = cv.width / cam.width, sy = cv.height / cam.height;
    for (const tr of cam.tracks) {
      const s = sampleTrack(tr, time);
      if (!s) continue;
      const [x1, y1, x2, y2] = s.bbox;
      const sel = selectedTrack === tr.key;
      ctx.strokeStyle = sel ? "#f4c430" : trackColor(tr.id);
      ctx.lineWidth = (sel ? 2.5 : 1.5) * dpr;
      ctx.setLineDash(s.interp ? [4 * dpr, 3 * dpr] : []);
      ctx.strokeRect(x1 * sx, y1 * sy, (x2 - x1) * sx, (y2 - y1) * sy);
      ctx.setLineDash([]);
      const label = String(tr.id);
      ctx.font = `700 ${12 * dpr}px "Barlow Condensed", sans-serif`;
      const w = ctx.measureText(label).width + 8 * dpr;
      ctx.fillStyle = sel ? "#f4c430" : trackColor(tr.id);
      ctx.fillRect(x1 * sx, y1 * sy - 15 * dpr, w, 15 * dpr);
      ctx.fillStyle = "#151d27";
      ctx.fillText(label, x1 * sx + 4 * dpr, y1 * sy - 3.5 * dpr);
    }
  }, [time, cam, layers.boxes, selectedTrack, large]);

  // click a box in the video to select that subject
  const onClick = (e) => {
    const r = boxRef.current.getBoundingClientRect();
    const u = ((e.clientX - r.left) / r.width) * cam.width;
    const v = ((e.clientY - r.top) / r.height) * cam.height;
    for (const tr of cam.tracks) {
      const s = sampleTrack(tr, time);
      if (s && u >= s.bbox[0] && u <= s.bbox[2] && v >= s.bbox[1] && v <= s.bbox[3]) {
        setSelectedTrack(tr.key);
        return;
      }
    }
  };

  const lt = localTime(cam, time);
  const frame = Math.max(0, Math.floor(lt * cam.fps + 1e-4));
  return (
    <div className={`video-panel ${large ? "large" : ""}`}>
      <div className="video-head">
        {c.cameras.length > 1 ? (
          <div className="seg" role="tablist" aria-label="Camera">
            {c.cameras.map((k) => (
              <button key={k.id} aria-pressed={k.id === cam.id} onClick={() => setSelectedCam(k.id)} title={k.label}>
                {k.id}
              </button>
            ))}
          </div>
        ) : (
          <span className="status" title={cam.evidence.file_name}>{cam.evidence.file_name}</span>
        )}
        <span className="meta">fotogramma {frame}, {fmtTime(lt)}</span>
        <button className="btn small ghost" onClick={() => toggleLayer("boxes")} aria-pressed={layers.boxes}>
          {layers.boxes ? "Nascondi riquadri" : "Mostra riquadri"}
        </button>
        {cam.evidence.probe.has_audio && (
          <button className="btn small ghost" onClick={() => setMuted(!muted)}>{muted ? "Audio off" : "Audio on"}</button>
        )}
        <button className="btn small ghost" onClick={() => setLarge(!large)}>{large ? "Riduci" : "Ingrandisci"}</button>
      </div>
      <div className="video-box" ref={boxRef} onClick={onClick} style={{ aspectRatio: `${cam.width} / ${cam.height}` }}>
        <canvas ref={canvasRef} />
        {!inRange(cam, time) && <div className="video-out">Questa camera non ha immagini in questo istante</div>}
      </div>
    </div>
  );
}
