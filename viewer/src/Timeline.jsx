import { useRef } from "react";
import { useStore, trackColor } from "./store.js";
import { fmtTime } from "./caseLoader.js";

const Icon = {
  play: <svg width="12" height="14" viewBox="0 0 12 14"><path d="M1 1l10 6-10 6z" fill="currentColor" /></svg>,
  pause: <svg width="12" height="14" viewBox="0 0 12 14"><path d="M1 1h3.5v12H1zM7.5 1H11v12H7.5z" fill="currentColor" /></svg>,
  back: <svg width="14" height="12" viewBox="0 0 14 12"><path d="M2 1v10M12 1L4 6l8 5z" stroke="currentColor" strokeWidth="1.6" fill="currentColor" /></svg>,
  fwd: <svg width="14" height="12" viewBox="0 0 14 12"><path d="M12 1v10M2 1l8 5-8 5z" stroke="currentColor" strokeWidth="1.6" fill="currentColor" /></svg>,
};

export function stepFrame(dir) {
  const st = useStore.getState();
  const cam = st.caseData.cameras.find((k) => k.id === st.selectedCam) ?? st.caseData.cameras[0];
  const lt = st.time - cam.time_offset;
  const f = Math.round(lt * cam.fps) + dir;
  st.setPlaying(false);
  st.setTime(Math.min(st.caseData.timeEnd, Math.max(st.caseData.timeStart, f / cam.fps + cam.time_offset + 1e-4)));
}

function niceStep(span, px) {
  const target = span / Math.max(px / 90, 1);
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) if (s >= target) return s;
  return 1200;
}

export default function Timeline() {
  const c = useStore((s) => s.caseData);
  const time = useStore((s) => s.time);
  const playing = useStore((s) => s.playing);
  const rate = useStore((s) => s.rate);
  const selectedTrack = useStore((s) => s.selectedTrack);
  const bookmarks = useStore((s) => s.bookmarks);
  const { setTime, setPlaying, setRate, setSelectedTrack, setDialog } = useStore.getState();
  const areaRef = useRef(null);

  const t0 = c.timeStart, t1 = c.timeEnd, span = Math.max(t1 - t0, 1e-6);
  const pct = (t) => `${((t - t0) / span) * 100}%`;
  const tracks = c.cameras.flatMap((k) => k.tracks);

  const seekFromEvent = (e) => {
    const r = areaRef.current.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
    setTime(t0 + (x / r.width) * span);
  };
  const onDown = (e) => {
    if (e.button !== 0) return;
    setPlaying(false);
    seekFromEvent(e);
    const move = (ev) => seekFromEvent(ev);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const width = areaRef.current?.clientWidth ?? 800;
  const step = niceStep(span, width);
  const ticks = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1 + 1e-6; t += step) ticks.push(t);

  const cam = c.cameras.find((k) => k.id === useStore.getState().selectedCam) ?? c.cameras[0];
  const frame = Math.max(0, Math.floor((time - cam.time_offset) * cam.fps + 1e-4));

  return (
    <div className="timeline">
      <div className="transport">
        <button className="icon-btn" onClick={() => stepFrame(-1)} title="Fotogramma precedente (freccia sinistra)" aria-label="Fotogramma precedente">{Icon.back}</button>
        <button className="icon-btn play" onClick={() => {
          if (!playing && time >= t1 - 1e-3) setTime(t0);
          setPlaying(!playing);
        }} title="Riproduci o metti in pausa (spazio)" aria-label={playing ? "Pausa" : "Riproduci"}>
          {playing ? Icon.pause : Icon.play}
        </button>
        <button className="icon-btn" onClick={() => stepFrame(1)} title="Fotogramma successivo (freccia destra)" aria-label="Fotogramma successivo">{Icon.fwd}</button>
        <span className="clock">{fmtTime(time - t0)}<small>di {fmtTime(span)}</small></span>
        <span className="status">fotogramma {frame} ({cam.id})</span>
        <select className="rate" value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Velocita' di riproduzione">
          {[0.1, 0.25, 0.5, 1, 2, 4].map((r) => <option key={r} value={r}>{r}x</option>)}
        </select>
        <span className="spacer" />
        <button className="btn small" onClick={() => setDialog({ kind: "bookmark", t: time })} title="Segna questo istante (B)">
          Segna istante
        </button>
      </div>
      <div className="track-wrap">
        <div className="track-area">
          <div className="lane-label ruler-label" />
          <div className="ruler" ref={areaRef} onPointerDown={onDown}>
            {ticks.map((t) => <div key={t} className="tick" style={{ left: pct(t) }}>{fmtTime(t - t0).replace(/\.00$/, "")}</div>)}
            {bookmarks.map((b, i) => (
              <div key={b.id} className="bookmark" style={{ left: pct(b.t) }} title={`${fmtTime(b.t - t0)} ${b.label}`}
                onPointerDown={(e) => { e.stopPropagation(); setPlaying(false); setTime(b.t); }}>
                <div className="tent sm"><span>{i + 1}</span></div>
              </div>
            ))}
          </div>
          {c.cameras.map((k) => (
            <Row key={k.id} label={k.id} cam onDown={onDown}>
              <div className="lane-bar" style={{ left: pct(k.time_offset), width: `${(k.duration / span) * 100}%` }} />
            </Row>
          ))}
          {tracks.map((t) => (
            <Row key={t.key} label={`${c.cameras.length > 1 ? t.camId + " " : ""}Soggetto ${t.id}`} onDown={onDown}
              active={selectedTrack === t.key}>
              <div
                className={`lane-bar ${selectedTrack === t.key ? "sel" : ""}`}
                style={{ left: pct(t.tg[0]), width: `${Math.max(((t.tg[t.tg.length - 1] - t.tg[0]) / span) * 100, 0.4)}%`, background: trackColor(t.id) }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setSelectedTrack(t.key);
                  setPlaying(false);
                  if (time < t.tg[0] || time > t.tg[t.tg.length - 1]) setTime(t.tg[0]);
                }}
              />
            </Row>
          ))}
        </div>
        <div className="playhead-layer"><div className="playhead" style={{ left: pct(time) }} /></div>
      </div>
    </div>
  );
}

function Row({ label, cam, active, onDown, children }) {
  return (
    <>
      <div className={`lane-label ${cam ? "cam" : ""}`} style={{ color: active ? "var(--text)" : undefined }}>{label}</div>
      <div className={`lane-row ${cam ? "cam" : ""}`} onPointerDown={onDown}>{children}</div>
    </>
  );
}
