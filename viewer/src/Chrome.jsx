import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useStore } from "./store.js";
import { fmtTime, fmtLen } from "./caseLoader.js";
import { exportPng, exportSubjectsCsv, exportMeasuresCsv, exportWorkspace, exportReport } from "./exports.js";
import { localSigma, scaleSigmaRel, pointWarnings, SOURCE_LABEL, TAPE_SIGMA_M } from "./uncertainty.js";
import { runIntegrity } from "./integrity.js";
import { IconOrbit, IconRuler, IconScale, IconCamera, IconPlan, IconOverview, IconLayers, IconExport, IconHelp, IconPresent } from "./Icons.jsx";

function Menu({ label, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
      {open && <div className="menu-pop" onClick={(e) => e.target.tagName === "BUTTON" && setOpen(false)}>{children}</div>}
    </div>
  );
}

const LAYERS = [
  ["generated", "Evidenzia le parti ricostruite"],
  ["people3d", "Veicoli in 3D"],
  ["surface", "Superficie ricostruita"],
  ["points", "Nuvola di punti"],
  ["projection", "Proietta il video sulla scena"],
  ["fadeUncertain", "Sfuma le zone viste di taglio"],
  ["fill", "Pavimento e muri dietro gli oggetti"],
  ["buildings", "Edifici completati"],
  ["apron", "Pavimento attorno alla scena"],
  ["detail", "Dettaglio del pavimento lontano"],
  ["tracks", "Soggetti"],
  ["trails", "Percorsi"],
  ["uncertainty", "Incertezza di posizione del selezionato"],
  ["frustums", "Posizione delle camere"],
  ["grid", "Griglia a 1 m"],
];

export function TopBar({ onClose }) {
  const c = useStore((s) => s.caseData);
  const tool = useStore((s) => s.tool);
  const layers = useStore((s) => s.layers);
  const presenting = useStore((s) => s.presenting);
  const personMode = useStore((s) => s.personMode);
  const { setTool, toggleLayer, requestView, setPresenting, setDialog, setPersonMode } = useStore.getState();
  const T = ({ id, icon: Ic, label, title }) => (
    <button aria-pressed={tool === id} onClick={() => setTool(id)} title={title}><Ic />{label}</button>
  );
  const V = ({ kind, icon: Ic, label, title }) => (
    <button onClick={() => requestView({ kind, camId: useStore.getState().selectedCam })} title={title}><Ic />{label}</button>
  );
  return (
    <header className="topbar">
      <div className="brand">
        <svg width="20" height="18" viewBox="0 0 20 18" aria-hidden="true"><path d="M10 0 L20 18 H0 Z" fill="#f4c430" /></svg>
        Sopralluogo
      </div>
      <span className="case-title" title={c.source}>{c.title}</span>
      <SealBadge />
      <span className="spacer" />
      <div className="seg" role="group" aria-label="Strumento">
        <T id="orbit" icon={IconOrbit} label="Esplora" title="Ruota, sposta e ingrandisci la scena (V)" />
        <T id="measure" icon={IconRuler} label="Misura" title="Distanza tra due punti (M)" />
        <T id="calibrate" icon={IconScale} label="Scala" title="Correggi la scala con una distanza nota (K)" />
      </div>
      <div className="seg" role="group" aria-label="Vista">
        <V kind="camera" icon={IconCamera} label="Camera" title="Guarda dal punto di vista della telecamera (C)" />
        <V kind="top" icon={IconPlan} label="Pianta" title="Pianta dall'alto (T)" />
        <V kind="overview" icon={IconOverview} label="Insieme" title="Vista d'insieme (O)" />
      </div>
      <Menu label={<><IconLayers />Livelli</>}>
        <div className="menu-note">Persone</div>
        <div className="seg mode" role="radiogroup" aria-label="Come mostrare le persone">
          {[["roto", "Dal video"], ["mannequin", "Manichino"], ["flat", "Sagoma piatta"]].map(([k, l]) => (
            <button key={k} role="radio" aria-pressed={personMode === k} aria-checked={personMode === k} onClick={() => setPersonMode(k)}>{l}</button>
          ))}
        </div>
        <div className="menu-note">Livelli</div>
        {LAYERS.map(([k, label]) => (
          <label key={k}><input type="checkbox" checked={layers[k]} onChange={() => toggleLayer(k)} />{label}</label>
        ))}
      </Menu>
      <Menu label={<><IconExport />Esporta</>}>
        <button onClick={() => setDialog({ kind: "report" })}>Relazione tecnica (stampabile in PDF)</button>
        <button onClick={exportPng}>Immagine della vista con didascalia (PNG)</button>
        <button onClick={exportSubjectsCsv}>Posizioni dei soggetti (CSV)</button>
        <button onClick={exportMeasuresCsv}>Misure con incertezza e istanti (CSV)</button>
        <button onClick={exportWorkspace}>Salva area di lavoro</button>
        <div className="menu-note">Metti workspace.json nella cartella del caso per ritrovare misure, istanti, correzioni e registro.</div>
      </Menu>
      <button className={`btn ${presenting ? "primary" : ""}`} onClick={() => setPresenting(!presenting)} title="Nasconde i pannelli e fa girare la scena (P)">
        <IconPresent />{presenting ? "Esci" : "Presenta"}
      </button>
      <button className="btn icon-only" onClick={() => setDialog({ kind: "help" })} title="Come si usa (?)" aria-label="Aiuto"><IconHelp /></button>
      <button className="btn ghost" onClick={onClose}>Chiudi</button>
    </header>
  );
}

export function ToolHint() {
  const tool = useStore((s) => s.tool);
  const pending = useStore((s) => s.pending);
  const setTool = useStore((s) => s.setTool);
  if (tool === "orbit") return null;
  const text = tool === "measure"
    ? pending.length ? "Clicca il secondo punto" : "Clicca il primo punto da misurare, sulla superficie o sul suolo"
    : pending.length ? "Clicca il secondo estremo della distanza nota" : "Clicca il primo estremo di una distanza che conosci";
  return (
    <div className="hint" role="status">
      <span>{text}</span>
      <button className="btn small" onClick={() => setTool("orbit")}>Fine (Esc)</button>
    </div>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const setDialog = useStore((s) => s.setDialog);
  const [val, setVal] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { setVal(""); setTimeout(() => inputRef.current?.focus(), 0); }, [dialog]);
  if (!dialog) return null;
  const st = useStore.getState();
  const close = () => setDialog(null);

  if (dialog.kind === "calibrate") {
    const c = st.caseData;
    const measured = new THREE.Vector3(...dialog.a).distanceTo(new THREE.Vector3(...dialog.b));
    const real = parseFloat(String(val).replace(",", "."));
    const ok = Number.isFinite(real) && real > 0;
    const loc = localSigma(c, dialog.a, dialog.b, dialog.pa, dialog.pb);
    const sigmaRel = ok ? Math.hypot(loc / measured, TAPE_SIGMA_M / real) : null;
    const before = scaleSigmaRel(c, null);
    const warns = [...pointWarnings(dialog.pa), ...pointWarnings(dialog.pb)];
    const blocked = warns.some((w) => w.level === "bad");
    const factor = ok ? real / measured : null;
    const apply = () => {
      if (!ok || blocked) return;
      st.setScale(factor, { a: dialog.a, b: dialog.b, pa: dialog.pa, pb: dialog.pb, real, measured, sigmaRel });
      st.setTool("orbit");
      close();
    };
    return (
      <div className="dialog-backdrop" onClick={close}>
        <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); apply(); }}>
          <h2>Distanza reale</h2>
          <p>Nella ricostruzione questi due punti distano {fmtLen(measured)} (punti su {SOURCE_LABEL[dialog.pa?.src ?? "unknown"]} e {SOURCE_LABEL[dialog.pb?.src ?? "unknown"]}). Quanto distano nella realta', misurati sul posto?</p>
          <input ref={inputRef} type="text" inputMode="decimal" placeholder="es. 3,20" value={val} onChange={(e) => setVal(e.target.value)} aria-label="Distanza reale in metri" />
          {warns.map((w, i) => <div key={i} className={w.level === "bad" ? "error" : "warn"} style={{ marginTop: 8 }}>{w.text}</div>)}
          {ok && !blocked && (
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>Fattore di correzione</dt><dd>{factor.toFixed(3)} (misure {factor >= 1 ? "piu' lunghe" : "piu' corte"} del {Math.abs((factor - 1) * 100).toFixed(1)}%)</dd>
              <dt>Incertezza di scala</dt><dd>da ±{(before * 100).toFixed(1)}% a <b>±{(sigmaRel * 100).toFixed(1)}%</b></dd>
            </dl>
          )}
          {ok && !blocked && Math.abs(factor - 1) > 0.15 && <div className="warn">La scala stimata era lontana dal riferimento: controlla di aver cliccato gli estremi giusti.</div>}
          {ok && !blocked && sigmaRel > before && <div className="warn">Questo riferimento e' meno preciso della scala stimata: scegli due punti piu' lontani tra loro o piu' vicini alla camera.</div>}
          <p className="fine">Il riferimento migliore e' lungo, sul suolo, e vicino alla camera: lo spigolo di un marciapiede, una fila di piastrelle, la distanza tra due pali.</p>
          <div className="row">
            <button type="button" className="btn ghost" onClick={close}>Annulla</button>
            <button type="submit" className="btn primary" disabled={!ok || blocked}>Applica scala</button>
          </div>
        </form>
      </div>
    );
  }
  if (dialog.kind === "report") return <ReportDialog close={close} />;
  if (dialog.kind === "help") {
    const rows = [
      ["Ruotare la scena", "trascina"], ["Spostarla", "tasto destro o due dita"], ["Avvicinarsi", "rotella"],
      ["Riproduci / pausa", "Spazio"], ["Fotogramma per fotogramma", "← →  (Maiusc: 10)"],
      ["Misurare", "M, poi due clic"], ["Correggere la scala", "K"], ["Segnare un istante", "B"],
      ["Vista dalla telecamera, pianta, insieme", "C  T  O"], ["Presentazione", "P"], ["Annullare / deselezionare", "Esc"],
    ];
    return (
      <div className="dialog-backdrop" onClick={close}>
        <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
          <h2>Come si usa</h2>
          <ol className="steps">
            <li><b>Scorri il tempo</b> con la barra in basso: video e scena 3D si muovono insieme.</li>
            <li><b>Clicca un soggetto</b> (nella scena, nel video o nell'elenco) per vederne percorso, velocita', altezza e le inquadrature migliori.</li>
            <li><b>Misura</b> una distanza con due clic. Per un uso ufficiale correggi prima la scala con una misura presa sul posto.</li>
          </ol>
          <table className="keys"><tbody>
            {rows.map(([a, b]) => <tr key={a}><td>{a}</td><td><kbd>{b}</kbd></td></tr>)}
          </tbody></table>
          <p className="fine">Le persone sono ricostruite dalla loro sagoma nel video: il davanti e' il video vero, il retro (non visto dalla telecamera) e' ricostruito. Tutto cio' che e' ricostruito senza informazioni certe e' rigato in viola; l'evidenziazione si spegne da Livelli.</p>
          <div className="row"><button className="btn primary" onClick={close}>Ho capito</button></div>
        </div>
      </div>
    );
  }
  if (dialog.kind === "bookmark") {
    const save = () => {
      st.addBookmark({ id: crypto.randomUUID?.() ?? String(Date.now()), t: dialog.t, label: val.trim() || "Istante segnato" });
      close();
    };
    return (
      <div className="dialog-backdrop" onClick={close}>
        <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); save(); }}>
          <h2>Segna l'istante {fmtTime(dialog.t - st.caseData.timeStart)}</h2>
          <p>Una nota breve per ritrovarlo sulla linea del tempo.</p>
          <input ref={inputRef} type="text" placeholder="es. il soggetto 7 entra dalla porta" value={val} onChange={(e) => setVal(e.target.value)} aria-label="Nota" />
          <div className="row">
            <button type="button" className="btn ghost" onClick={close}>Annulla</button>
            <button type="submit" className="btn primary">Segna istante</button>
          </div>
        </form>
      </div>
    );
  }
  return null;
}

export function GeneratedLegend() {
  const on = useStore((s) => s.layers.generated);
  const toggle = useStore((s) => s.toggleLayer);
  const presenting = useStore((s) => s.presenting);
  if (presenting) return null;
  return (
    <button className={`legend ${on ? "" : "off"}`} onClick={() => toggle("generated")} title="Mostra o nascondi l'evidenziazione">
      <span className="hatch" />
      {on ? "Ricostruito senza dati certi" : "Evidenzia le parti ricostruite"}
    </button>
  );
}

function ReportDialog({ close }) {
  const report = useStore((s) => s.report);
  const integrity = useStore((s) => s.integrity);
  const scaleRef = useStore((s) => s.scaleRef);
  const nMeasures = useStore((s) => s.measurements.length);
  const [r, setR] = useState(report);
  const [verifyFirst, setVerifyFirst] = useState(integrity.status !== "ok");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    useStore.getState().setReport(r);
    if (verifyFirst) await runIntegrity();
    await exportReport();
    setBusy(false);
    close();
  };
  const field = (k, label, ph, area) => (
    <label className="field">{label}
      {area
        ? <textarea rows={3} value={r[k]} placeholder={ph} onChange={(e) => setR({ ...r, [k]: e.target.value })} />
        : <input type="text" value={r[k]} placeholder={ph} onChange={(e) => setR({ ...r, [k]: e.target.value })} />}
    </label>
  );
  return (
    <div className="dialog-backdrop" onClick={busy ? undefined : close}>
      <form className="dialog wide" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); go(); }}>
        <h2>Relazione tecnica</h2>
        <p>Un documento da stampare o salvare in PDF: impronta del caso, fonti, calibrazione, misure con incertezza, soggetti, registro delle operazioni e la vista attuale.</p>
        {field("operator", "Redatta da", "nome, qualifica")}
        {field("reference", "Riferimento", "es. numero del procedimento o della nota")}
        {field("notes", "Oggetto", "cosa si e' voluto accertare", true)}
        <label className="check"><input type="checkbox" checked={verifyFirst} onChange={(e) => setVerifyFirst(e.target.checked)} />Verifica l'integrita' di tutti i file prima di generarla</label>
        {!scaleRef && <div className="warn">La scala non e' stata corretta con una misura sul posto: la relazione lo dichiarera'.</div>}
        {nMeasures === 0 && <div className="warn">Nessuna misura: la relazione conterra' solo fonti, soggetti e registro.</div>}
        {busy && <p role="status">{integrity.status === "running" ? `Verifica in corso: ${integrity.done} di ${integrity.total} file` : "Preparo la relazione"}</p>}
        <div className="row">
          <button type="button" className="btn ghost" onClick={close} disabled={busy}>Annulla</button>
          <button type="submit" className="btn primary" disabled={busy}>Genera relazione</button>
        </div>
      </form>
    </div>
  );
}

/** Case fingerprint and integrity state, always visible next to the title. */
function SealBadge() {
  const c = useStore((s) => s.caseData);
  const integrity = useStore((s) => s.integrity);
  const { setPanel, setSideOpen } = useStore.getState();
  if (!c.fingerprint) return <span className="seal none" title="Il caso non ha manifest.json: non e' verificabile">Non verificabile</span>;
  const label = {
    unchecked: "Da verificare",
    running: `Verifica ${integrity.total ? Math.round((integrity.done / integrity.total) * 100) : 0}%`,
    ok: "Integro",
    bad: "Non integro",
  }[integrity.status];
  const onClick = () => {
    setPanel("case"); setSideOpen(true);
    if (integrity.status === "unchecked") runIntegrity();
  };
  return (
    <button className={`seal ${integrity.status}`} onClick={onClick} title={`Impronta del caso (SHA-256 di manifest.json)\n${c.fingerprint}\nClic per i dettagli`}>
      <span className="dot" aria-hidden="true" />
      <span className="lbl">{label}</span>
      <span className="fp">{c.fingerprint.slice(0, 8)}</span>
    </button>
  );
}
