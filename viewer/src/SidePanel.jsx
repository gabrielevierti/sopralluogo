import { useState } from "react";
import * as THREE from "three";
import { IconChevron, IconShield } from "./Icons.jsx";
import { useStore, trackColor } from "./store.js";
import { fmtTime, fmtLen, sampleTrack } from "./caseLoader.js";
import { reliableSpeed } from "./Scene3D.jsx";
import { measureUncertainty, scaleSigmaRel, SOURCE_LABEL, fmtSigma } from "./uncertainty.js";
import { runIntegrity } from "./integrity.js";

const n = (v, d = 1) => (v == null || !Number.isFinite(v) ? "n.d." : v.toFixed(d));

const COLORS = ["nero", "grigio scuro", "grigio", "bianco", "rosso", "arancione", "giallo", "verde", "azzurro", "blu", "viola", "rosa", "marrone", "beige"];

const subjectName = (t) => `Soggetto ${t.id}`;

/** Human correction: the operator knows two tracks are the same person. */
function MergeControl({ t, cam }) {
  const applyMerge = useStore((s) => s.applyMerge);
  const others = cam.tracks.filter((o) => o.id !== t.id && o.cls === t.cls &&
    (o.tg[0] > t.tg[t.tg.length - 1] || o.tg[o.tg.length - 1] < t.tg[0]));
  if (!others.length) return null;
  return (
    <div className="merge">
      <label>E' la stessa persona del
        <select value="" onChange={(e) => e.target.value && applyMerge(cam.id, t.id, Number(e.target.value))}>
          <option value="">scegli...</option>
          {others.map((o) => <option key={o.id} value={o.id}>Soggetto {o.id}</option>)}
        </select>
      </label>
    </div>
  );
}

function Swatch({ part }) {
  if (!part) return null;
  return <span className="swatch" style={{ background: part.swatch }} title={`${part.name} (accordo ${Math.round(part.agreement * 100)}%)`} />;
}

function SubjectCard({ t, cam }) {
  const c = useStore((s) => s.caseData);
  const scale = useStore((s) => s.scale);
  const faceFollow = useStore((s) => s.faceFollow);
  const { setTime, setPlaying, setSelectedCam, setFaceFollow } = useStore.getState();
  const a = t.appearance;
  const goFrame = (v) => { setPlaying(false); setSelectedCam(cam.id); setTime(v.tg + 1e-4); };
  const best = t.views?.[0];
  return (
    <div className="card">
      <div className="card-head">
        <div className="tent"><span>{t.id}</span></div>
        <div>
          <div className="subject-name">{subjectName(t)}{c.cameras.length > 1 ? `, ${cam.id}` : ""}</div>
          <div className="subject-meta">{t.cls === "persona" ? "Persona" : t.cls[0].toUpperCase() + t.cls.slice(1)}</div>
        </div>
      </div>
      {best && (
        <div className="views">
          <figure className="head-view" onClick={() => goFrame(best)} title="Vai a questo fotogramma">
            <img src={best.headUrl} alt={`Testa del soggetto ${t.id}, fotogramma ${best.frame}`} />
            <figcaption>
              {best.face ? `volto rilevato (${Math.round(best.face.confidence * 100)}%)` : "testa"}, {best.head_px} px, fotogramma {best.frame}
            </figcaption>
          </figure>
          <div className="body-views">
            {t.views.map((v, i) => (
              <figure key={i} onClick={() => goFrame(v)} title={`Fotogramma ${v.frame}: clicca per andarci`}>
                <img src={v.bodyUrl} alt={`Soggetto ${t.id}, fotogramma ${v.frame}`} />
                <figcaption>{fmtTime(v.tg - c.timeStart)}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}
      <p className="fine">Pixel originali del video, ingranditi senza miglioramenti artificiali.</p>
      <div className="row-actions">
        <button className={`btn small ${faceFollow ? "primary" : ""}`} onClick={() => setFaceFollow(!faceFollow)}>
          {faceFollow ? "Chiudi focus volto" : "Focus volto nel video"}
        </button>
      </div>
      {t.links?.length > 0 && (
        <p className="fine">
          {t.links.map((l, i) => l.manual
            ? <span key={i}>Unito a mano con il soggetto {l.merged_id}. </span>
            : <span key={i}>Coperto per {l.gap_s.toFixed(1)} s e riconosciuto: ricompare a {l.position_error_m?.toFixed(1) ?? "?"} m da dove era atteso, abiti simili al {Math.round((1 - l.appearance_distance) * 100)}%. </span>)}
          Il tratto tratteggiato in giallo e' il percorso non visto.
        </p>
      )}
      <MergeControl t={t} cam={cam} />
      <dl className="kv" style={{ marginTop: 6 }}>
        <dt>Velocita' tipica</dt><dd>{reliableSpeed(t) ? `${n(t.stats.median_speed_kmh * scale)} ±${n(t.stats.speed_sigma_kmh * scale)} km/h` : "n.d."}</dd>
        <dt>Percorso</dt><dd>{fmtLen(t.stats.path_m * scale)}</dd>
        {t.stats.height_m != null && <><dt>Altezza stimata</dt><dd>{n(t.stats.height_m * scale, 2)} m ({n(t.stats.height_iqr_m[0] * scale, 2)} a {n(t.stats.height_iqr_m[1] * scale, 2)})</dd></>}
        <dt>Incertezza posizione</dt><dd>±{n(t.stats.median_sigma_m * scale, 2)} m</dd>
      </dl>
    </div>
  );
}

function Subjects() {
  const c = useStore((s) => s.caseData);
  const time = useStore((s) => s.time);
  const scale = useStore((s) => s.scale);
  const selectedTrack = useStore((s) => s.selectedTrack);
  const filter = useStore((s) => s.colorFilter);
  const hoverTrack = useStore((s) => s.hoverTrack);
  const [showFilter, setShowFilter] = useState(false);
  const { setSelectedTrack, setTime, setPlaying, requestView, setColorFilter, setHoverTrack } = useStore.getState();
  const all = c.cameras.flatMap((k) => k.tracks.map((t) => ({ t, cam: k })));
  const tracks = all.filter(({ t }) =>
    (!filter.upper || t.appearance?.upper?.name === filter.upper) &&
    (!filter.lower || t.appearance?.lower?.name === filter.lower));
  if (!all.length)
    return <div className="empty"><b>Nessun soggetto rilevato.</b> Prova a rielaborare il video con <code>--imgsz 1280</code> o una soglia <code>--conf</code> piu' bassa.</div>;
  const hasAppearance = all.some(({ t }) => t.appearance);
  return (
    <div>
      {hasAppearance && !showFilter && !filter.upper && !filter.lower && (
        <div className="filters"><button className="linklike" onClick={() => setShowFilter(true)}>Filtra per colore degli abiti</button></div>
      )}
      {hasAppearance && (showFilter || filter.upper || filter.lower) && (
        <div className="filters">
          <span>Abiti</span>
          <label>sopra
            <select value={filter.upper} onChange={(e) => setColorFilter({ upper: e.target.value })}>
              <option value="">qualsiasi</option>
              {COLORS.map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label>sotto
            <select value={filter.lower} onChange={(e) => setColorFilter({ lower: e.target.value })}>
              <option value="">qualsiasi</option>
              {COLORS.map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          {(filter.upper || filter.lower) && <span className="status">{tracks.length} di {all.length}</span>}
          <button className="linklike" onClick={() => { setColorFilter({ upper: "", lower: "" }); setShowFilter(false); }}>chiudi</button>
        </div>
      )}
      {tracks.length === 0 && <div className="empty">Nessun soggetto con questi colori. I colori sono stimati dal video e possono variare con luce e ombre.</div>}
      {tracks.map(({ t, cam }) => {
        const s = t.stats;
        const onstage = !!sampleTrack(t, time);
        const sel = selectedTrack === t.key;
        const goTo = () => {
          setSelectedTrack(t.key);
          setPlaying(false);
          if (!onstage) setTime(t.tg[0]);
          const p = sampleTrack(t, onstage ? time : t.tg[0]);
          const v = new THREE.Vector3(p.x, 0, p.z).applyMatrix4(cam.alignmentM);
          requestView({ kind: "focus", point: [v.x, v.y, v.z] });
        };
        if (sel) return (
          <div key={t.key} aria-selected="true" className="subject-open"
            ref={(el) => el && el.scrollIntoView({ block: "nearest", behavior: "smooth" })}>
            <SubjectCard t={t} cam={cam} />
            <div className="row-actions" style={{ padding: "0 12px 10px" }}>
              <button className="btn small" onClick={goTo}>Inquadra nella scena</button>
              <button className="btn small ghost" onClick={() => setSelectedTrack(null)}>Chiudi</button>
            </div>
          </div>
        );
        return (
          <div key={t.key} className={`subject ${onstage ? "" : "offstage"} ${hoverTrack === t.key ? "hover" : ""}`} aria-selected={false}
            onClick={() => setSelectedTrack(t.key)} onMouseEnter={() => setHoverTrack(t.key)} onMouseLeave={() => setHoverTrack(null)}>
            {t.views?.[0] ? <img className="thumb" src={t.views[0].bodyUrl} alt="" /> : <div className="tent"><span>{t.id}</span></div>}
            <div className="subject-name">
              <span className="id-chip">{t.id}</span>
              {subjectName(t)}
              {t.appearance && <span className="swatches"><Swatch part={t.appearance.upper} /><Swatch part={t.appearance.lower} /></span>}
            </div>
            <button className="btn small ghost" onClick={(e) => { e.stopPropagation(); goTo(); }}>Vai</button>
            <div className="subject-meta">
              visibile da {fmtTime(t.tg[0] - c.timeStart)} a {fmtTime(t.tg[t.tg.length - 1] - c.timeStart)}
              {t.links?.length ? ", ricucito dopo un'occlusione" : ""}
            </div>
            <div className="subject-figs">
              {reliableSpeed(t)
                ? <span><b>{n(s.median_speed_kmh * scale)}</b> &plusmn;{n(s.speed_sigma_kmh * scale)} km/h</span>
                : <span title="Traccia troppo breve o lontana per una velocita' affidabile">velocita' n.d.</span>}
              <span><b>{fmtLen(s.path_m * scale)}</b></span>
              {s.height_m != null && <span>h <b>{n(s.height_m * scale, 2)}</b> m</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Measures() {
  const c = useStore((s) => s.caseData);
  const measurements = useStore((s) => s.measurements);
  const bookmarks = useStore((s) => s.bookmarks);
  const scale = useStore((s) => s.scale);
  const scaleRef = useStore((s) => s.scaleRef);
  const { removeMeasurement, setTool, setScale, setTime, removeBookmark } = useStore.getState();
  const rel = scaleSigmaRel(c, scaleRef);
  return (
    <div>
      <div className="section">
        <h3>Scala</h3>
        {scaleRef ? (
          <>
            <p>Corretta con un riferimento misurato sul posto di {fmtLen(scaleRef.real)} (fattore {scale.toFixed(3)}). Incertezza di scala <b>±{(rel * 100).toFixed(1)}%</b>. Misure, velocita' e altezze sono aggiornate.</p>
            <button className="btn small" onClick={() => setScale(1, null)}>Rimuovi correzione</button>
          </>
        ) : (
          <>
            <p>Stimata dall'altezza media delle persone, incertezza <b>±{(rel * 100).toFixed(1)}%</b>. Per un uso probatorio misura sul posto una distanza visibile nel video (spigolo del marciapiede, piastrelle, distanza tra due pali) e inseriscila qui.</p>
            <button className="btn small" onClick={() => setTool("calibrate")}>Calibra con una misura nota</button>
          </>
        )}
      </div>
      {measurements.length === 0 ? (
        <div className="empty">Nessuna misura. Scegli <b>Misura</b> in alto e clicca due punti nella scena: il suolo e i muri danno le misure piu' affidabili.</div>
      ) : (
        <div className="section">
          <h3>Misure</h3>
          {measurements.map((m, i) => {
            const u = measureUncertainty(c, m, scale, scaleRef);
            return (
              <div key={m.id} className={`measure-row ${u.worst}`}>
                <div className="mhead">
                  <span className="mn">{i + 1}</span>
                  <span className="val">{fmtLen(u.L)}<small> ±{fmtSigma(u.sigma)} m</small></span>
                  <button className="btn small ghost" onClick={() => removeMeasurement(m.id)} aria-label={`Elimina misura ${i + 1}`}>Elimina</button>
                </div>
                <div className="lbl">
                  Al 95% tra {u.lo95.toFixed(2)} e {u.hi95.toFixed(2)} m. Punti su {SOURCE_LABEL[m.pa?.src ?? "unknown"]} e {SOURCE_LABEL[m.pb?.src ?? "unknown"]}, dislivello {fmtLen(Math.abs(m.a[1] - m.b[1]) * scale)}.{" "}
                  <button className="link" onClick={() => setTime(m.t)}>Istante {fmtTime(m.t - c.timeStart)}</button>
                </div>
                {u.warnings.map((w, k) => <div key={k} className={w.level === "bad" ? "error" : "warn"}>{w.text}</div>)}
              </div>
            );
          })}
        </div>
      )}
      {bookmarks.length > 0 && (
        <div className="section">
          <h3>Istanti segnati</h3>
          {bookmarks.map((b) => (
            <div key={b.id} className="bm-row">
              <button className="link" onClick={() => setTime(b.t)}>{fmtTime(b.t - c.timeStart)}</button>
              <span>{b.label}</span>
              <button className="btn small ghost" onClick={() => removeBookmark(b.id)} aria-label={`Elimina istante ${b.label}`}>Elimina</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Fingerprint of the case and verification of every file against the manifest. */
function IntegrityCheck() {
  const c = useStore((s) => s.caseData);
  const st = useStore((s) => s.integrity);
  const [copied, setCopied] = useState(false);
  if (!c.manifest || !c.src) {
    return (
      <div className="section">
        <h3>Integrita' del caso</h3>
        <div className="warn">Manca manifest.json: non c'e' modo di dimostrare che questi file siano quelli prodotti dall'analisi.</div>
      </div>
    );
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(c.fingerprint); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* not allowed */ }
  };
  const mb = (b) => `${(b / 1048576).toFixed(0)} MB`;
  return (
    <div className="section">
      <h3>Integrita' del caso</h3>
      <div className="fingerprint">
        <div className="status">Impronta del caso, da riportare a verbale</div>
        <div className="hash big">{c.fingerprint}</div>
        <button className="btn small ghost" onClick={copy}>{copied ? "Copiata" : "Copia"}</button>
      </div>
      <p className="fine">E' l'impronta SHA-256 di manifest.json, che a sua volta contiene l'impronta di ogni file. Se coincide con quella annotata a verbale, nessun file e' cambiato.</p>
      {st.status === "unchecked" && <button className="btn small" onClick={runIntegrity}><IconShield />Verifica tutti i file</button>}
      {st.status === "running" && (
        <div role="status">
          <div className="progress"><span style={{ width: `${(st.totalBytes ? st.bytes / st.totalBytes : st.done / st.total) * 100}%` }} /></div>
          <p className="fine">File {st.done + 1} di {st.total}: {st.file}{st.totalBytes ? `, ${mb(st.bytes)} di ${mb(st.totalBytes)}` : ""}</p>
        </div>
      )}
      {st.status === "ok" && <p className="good">Tutti i {st.total} file corrispondono al manifest{st.listingChecked ? " e non ci sono file aggiunti" : ""}.</p>}
      {st.status === "bad" && (
        <>
          <p className="error">Il caso non corrisponde al manifest.</p>
          {[["changed", "Modificato"], ["missing", "Mancante"], ["added", "Aggiunto dopo l'analisi"]].flatMap(([k, l]) =>
            st[k].map((f) => <div key={k + f} className="hash"><b>{l}:</b> {f}</div>))}
        </>
      )}
      {(st.status === "ok" || st.status === "bad") && <button className="btn small ghost" style={{ marginTop: 8 }} onClick={runIntegrity}>Ripeti la verifica</button>}
    </div>
  );
}

/** What the operator did on top of the automatic analysis. */
function Journal() {
  const journal = useStore((s) => s.journal);
  const merges = useStore((s) => s.merges);
  const undoMerge = useStore((s) => s.undoMerge);
  return (
    <>
      {merges.length > 0 && (
        <div className="section">
          <h3>Correzioni manuali</h3>
          {merges.map((m, i) => (
            <div key={i} className="bm-row">
              <span>{m.cam}: soggetto {m.from} unito al soggetto {m.into}</span>
              <button className="btn small ghost" onClick={() => undoMerge(i)}>Annulla</button>
            </div>
          ))}
        </div>
      )}
      <div className="section">
        <h3>Registro delle operazioni</h3>
        {journal.length === 0
          ? <p className="fine">Ancora nessuna operazione: qui compaiono misure, correzioni di scala, unioni di soggetti, verifiche ed esportazioni, con data e ora. Il registro viene salvato con l'area di lavoro e stampato nella relazione.</p>
          : <ol className="journal">{[...journal].reverse().map((j, i) => (
              <li key={i}><time>{new Date(j.at).toLocaleTimeString("it-IT")}</time><b>{j.action}</b>{j.detail && <span>{j.detail}</span>}</li>
            ))}</ol>}
      </div>
    </>
  );
}

function CaseInfo() {
  const c = useStore((s) => s.caseData);
  return (
    <div>
      <IntegrityCheck />
      <Journal />
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

export function SideTab() {
  const setSideOpen = useStore((s) => s.setSideOpen);
  const count = useStore((s) => s.caseData.cameras.reduce((a, k) => a + k.tracks.length, 0));
  return (
    <button className="side-tab" onClick={() => setSideOpen(true)} title="Apri il pannello">
      <span className="tent sm"><span>{count}</span></span>Soggetti
    </button>
  );
}

export default function SidePanel() {
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  const setSideOpen = useStore((s) => s.setSideOpen);
  const c = useStore((s) => s.caseData);
  const count = c.cameras.reduce((a, k) => a + k.tracks.length, 0);
  const nm = useStore((s) => s.measurements.length);
  return (
    <aside className="side" aria-label="Pannello del caso">
      <div className="side-tabs" role="tablist">
        <button role="tab" aria-selected={panel === "subjects"} onClick={() => setPanel("subjects")}>Soggetti ({count})</button>
        <button role="tab" aria-selected={panel === "measures"} onClick={() => setPanel("measures")}>Misure ({nm})</button>
        <button role="tab" aria-selected={panel === "case"} onClick={() => setPanel("case")}>Caso</button>
        <button className="collapse" onClick={() => setSideOpen(false)} title="Chiudi il pannello" aria-label="Chiudi il pannello"><IconChevron /></button>
      </div>
      <div className="side-body">
        {panel === "subjects" && <Subjects />}
        {panel === "measures" && <Measures />}
        {panel === "case" && <CaseInfo />}
      </div>
    </aside>
  );
}
