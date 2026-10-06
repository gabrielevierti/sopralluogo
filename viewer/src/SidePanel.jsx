import * as THREE from "three";
import { useStore, trackColor } from "./store.js";
import { fmtTime, fmtLen, sampleTrack } from "./caseLoader.js";
import { reliableSpeed } from "./Scene3D.jsx";

const n = (v, d = 1) => (v == null || !Number.isFinite(v) ? "n.d." : v.toFixed(d));

function Subjects() {
  const c = useStore((s) => s.caseData);
  const time = useStore((s) => s.time);
  const scale = useStore((s) => s.scale);
  const selectedTrack = useStore((s) => s.selectedTrack);
  const { setSelectedTrack, setTime, setPlaying, requestView } = useStore.getState();
  const tracks = c.cameras.flatMap((k) => k.tracks.map((t) => ({ t, cam: k })));
  if (!tracks.length)
    return <div className="empty"><b>Nessun soggetto rilevato.</b> Prova a rielaborare il video con <code>--imgsz 1280</code> o una soglia <code>--conf</code> piu' bassa.</div>;
  return (
    <div>
      {tracks.map(({ t, cam }) => {
        const s = t.stats;
        const onstage = !!sampleTrack(t, time);
        const goTo = () => {
          setSelectedTrack(t.key);
          setPlaying(false);
          if (!onstage) setTime(t.tg[0]);
          const p = sampleTrack(t, onstage ? time : t.tg[0]);
          const v = new THREE.Vector3(p.x, 0, p.z).applyMatrix4(cam.alignmentM);
          requestView({ kind: "focus", point: [v.x, v.y, v.z] });
        };
        return (
          <div key={t.key} className={`subject ${onstage ? "" : "offstage"}`} aria-selected={selectedTrack === t.key}
            onClick={() => setSelectedTrack(selectedTrack === t.key ? null : t.key)}>
            <div className="tent"><span>{t.id}</span></div>
            <div className="subject-name">
              <span className="swatch" style={{ background: trackColor(t.id) }} />
              {t.cls}{c.cameras.length > 1 ? `, ${cam.id}` : ""}
            </div>
            <button className="btn small ghost" onClick={(e) => { e.stopPropagation(); goTo(); }}>Vai</button>
            <div className="subject-meta">
              visibile da {fmtTime(t.tg[0] - c.timeStart)} a {fmtTime(t.tg[t.tg.length - 1] - c.timeStart)}
              {s.interpolated_ratio > 0.2 ? `, ${Math.round(s.interpolated_ratio * 100)}% interpolato` : ""}
            </div>
            <div className="subject-figs">
              {reliableSpeed(t)
                ? <span><b>{n(s.median_speed_kmh * scale)}</b> &plusmn;{n(s.speed_sigma_kmh * scale)} km/h</span>
                : <span title="Traccia troppo breve o lontana per una velocita' affidabile">velocita' n.d.</span>}
              <span><b>{fmtLen(s.path_m * scale)}</b> percorsi</span>
              {s.height_m != null && <span>h <b>{n(s.height_m * scale, 2)}</b> m</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Measures() {
  const measurements = useStore((s) => s.measurements);
  const scale = useStore((s) => s.scale);
  const scaleRef = useStore((s) => s.scaleRef);
  const { removeMeasurement, setTool, setScale } = useStore.getState();
  const len = (m) => new THREE.Vector3(...m.a).distanceTo(new THREE.Vector3(...m.b)) * scale;
  return (
    <div>
      <div className="section">
        <h3>Scala</h3>
        {scaleRef ? (
          <>
            <p>Corretta con un riferimento noto di {fmtLen(scaleRef.real)} (fattore {scale.toFixed(3)}). Tutte le misure, velocita' e altezze sono aggiornate.</p>
            <button className="btn small" onClick={() => setScale(1, null)}>Rimuovi correzione</button>
          </>
        ) : (
          <>
            <p>Scala stimata automaticamente. Per un uso probatorio misura sul posto una distanza visibile nel video (porta, lampione, piastrelle) e inseriscila qui.</p>
            <button className="btn small" onClick={() => setTool("calibrate")}>Calibra con una misura nota</button>
          </>
        )}
      </div>
      {measurements.length === 0 ? (
        <div className="empty">Nessuna misura. Scegli <b>Misura</b> in alto e clicca due punti nella scena.</div>
      ) : (
        measurements.map((m, i) => (
          <div key={m.id} className="measure-row">
            <span className="val">{fmtLen(len(m))}</span>
            <span className="lbl">Misura {i + 1}, dislivello {fmtLen(Math.abs(m.a[1] - m.b[1]) * scale)}</span>
            <button className="btn small ghost" onClick={() => removeMeasurement(m.id)} aria-label={`Elimina misura ${i + 1}`}>Elimina</button>
          </div>
        ))
      )}
    </div>
  );
}

function CaseInfo() {
  const c = useStore((s) => s.caseData);
  return (
    <div>
      {c.cameras.map((k) => {
        const cal = k.calibration, cm = k.camera;
        return (
          <div className="section" key={k.id}>
            <h3>{k.id}: {k.evidence.file_name}</h3>
            <dl className="kv">
              <dt>Durata</dt><dd>{fmtTime(k.duration)} a {k.fps.toFixed(2)} fps</dd>
              <dt>Risoluzione</dt><dd>{k.width} x {k.height}</dd>
              <dt>Altezza camera</dt><dd>{n(cm.height_m, 2)} m &plusmn;{n(cal.std_height_m, 2)}</dd>
              <dt>Inclinazione</dt><dd>{n(cm.pitch_deg)}&deg; &plusmn;{n(cal.std_pitch_deg)}</dd>
              <dt>Campo visivo</dt><dd>{n(cm.hfov_deg)}&deg;{cal.std_hfov_deg != null ? ` ±${n(cal.std_hfov_deg)}` : ""}</dd>
              <dt>Errore di calibrazione</dt><dd>{n(cal.median_reprojection_px)} px</dd>
              <dt>Riferimenti usati</dt><dd>{cal.people ?? 0} persone, {cal.vertical_lines ?? 0} linee verticali</dd>
              <dt>Camera ferma</dt><dd className={k.camera_motion.static ? "good" : "error"}>{k.camera_motion.static ? "si'" : `no (${n(k.camera_motion.max_px)} px)`}</dd>
              {k.sync && <><dt>Sincronia</dt><dd>{k.sync.method}{k.time_offset ? `, ${k.time_offset.toFixed(2)} s` : ""}</dd></>}
              {k.alignment_report && <><dt>Allineamento</dt><dd>{k.alignment_report.method}{k.alignment_report.rms_m != null ? `, rms ${n(k.alignment_report.rms_m, 2)} m` : ""}</dd></>}
            </dl>
            <p style={{ marginTop: 8 }}>{cal.method}</p>
            {cal.warning && <div className="warn">{cal.warning}</div>}
            {!k.camera_motion.static && <div className="warn">La camera si muove: il modello a camera fissa non e' affidabile su questo video.</div>}
            <div style={{ marginTop: 8 }}>
              <div className="status">SHA-256 del file originale</div>
              <div className="hash">{k.evidence.sha256}</div>
            </div>
          </div>
        );
      })}
      {c.manifest && (
        <div className="section">
          <h3>Elaborazione</h3>
          <dl className="kv">
            <dt>Software</dt><dd>{c.manifest.software.name} {c.manifest.software.version}</dd>
            <dt>Avviata</dt><dd>{c.manifest.started}</dd>
            <dt>File prodotti</dt><dd>{c.manifest.outputs.length}, con impronta SHA-256</dd>
          </dl>
          {c.manifest.models.map((m) => (
            <div key={m.file} style={{ marginTop: 8 }}>
              <div className="status">{m.about}</div>
              <div className="hash">{m.sha256}</div>
            </div>
          ))}
        </div>
      )}
      <div className="section">
        <h3>Limiti</h3>
        {c.scene.notes.map((t, i) => <p key={i}>{t}</p>)}
      </div>
    </div>
  );
}

export default function SidePanel() {
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  const c = useStore((s) => s.caseData);
  const count = c.cameras.reduce((a, k) => a + k.tracks.length, 0);
  const nm = useStore((s) => s.measurements.length);
  return (
    <aside className="side" aria-label="Pannello del caso">
      <div className="side-tabs" role="tablist">
        <button role="tab" aria-selected={panel === "subjects"} onClick={() => setPanel("subjects")}>Soggetti ({count})</button>
        <button role="tab" aria-selected={panel === "measures"} onClick={() => setPanel("measures")}>Misure ({nm})</button>
        <button role="tab" aria-selected={panel === "case"} onClick={() => setPanel("case")}>Caso</button>
      </div>
      <div className="side-body">
        {panel === "subjects" && <Subjects />}
        {panel === "measures" && <Measures />}
        {panel === "case" && <CaseInfo />}
      </div>
    </aside>
  );
}
