import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useStore } from "./store.js";
import { fmtTime, fmtLen } from "./caseLoader.js";

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const stamp = () => new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const csv = (rows) => rows.map((r) => r.map((v) => (typeof v === "string" && /[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v ?? "")).join(",")).join("\n");

export function exportWorkspace() {
  const st = useStore.getState();
  const ws = {
    format: "sopralluogo-workspace/1",
    saved_at: new Date().toISOString(),
    case: st.caseData.title,
    case_inputs_sha256: st.caseData.cameras.map((k) => k.evidence.sha256),
    scale: st.scale, scaleRef: st.scaleRef,
    measurements: st.measurements, bookmarks: st.bookmarks,
  };
  download("workspace.json", JSON.stringify(ws, null, 1), "application/json");
}

function exportSubjectsCsv() {
  const st = useStore.getState();
  const rows = [["camera", "soggetto", "classe", "tempo_s", "fotogramma", "x_m", "z_m", "incertezza_1sigma_m", "velocita_kmh", "altezza_m", "interpolato"]];
  for (const k of st.caseData.cameras)
    for (const t of k.tracks)
      t.t.forEach((_, i) => {
        const p = new THREE.Vector3(t.p[i][0], 0, t.p[i][1]).applyMatrix4(k.alignmentM).multiplyScalar(st.scale);
        rows.push([k.id, t.id, t.cls, (t.tg[i] - st.caseData.timeStart).toFixed(3), t.frame[i], p.x.toFixed(3), p.z.toFixed(3),
          (t.sigma[i] * st.scale).toFixed(3), t.speed[i] == null ? "" : (t.speed[i] * st.scale).toFixed(2),
          t.h[i] == null ? "" : (t.h[i] * st.scale).toFixed(3), t.interp[i]]);
      });
  download(`soggetti-${stamp()}.csv`, csv(rows), "text/csv");
}

function exportMeasuresCsv() {
  const st = useStore.getState();
  const rows = [["tipo", "n", "tempo_s", "valore", "ax", "ay", "az", "bx", "by", "bz", "nota"]];
  st.measurements.forEach((m, i) => {
    const d = new THREE.Vector3(...m.a).distanceTo(new THREE.Vector3(...m.b)) * st.scale;
    rows.push(["misura_m", i + 1, (m.t - st.caseData.timeStart).toFixed(3), d.toFixed(3), ...m.a.map((v) => (v * st.scale).toFixed(3)), ...m.b.map((v) => (v * st.scale).toFixed(3)), ""]);
  });
  st.bookmarks.forEach((b, i) => rows.push(["istante", i + 1, (b.t - st.caseData.timeStart).toFixed(3), "", "", "", "", "", "", "", b.label]));
  download(`misure-e-istanti-${stamp()}.csv`, csv(rows), "text/csv");
}

function exportPng() {
  const canvas = document.querySelector(".stage canvas");
  canvas.toBlob((b) => download(`vista-3d-${stamp()}.png`, b), "image/png");
}

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
  ["surface", "Superficie ricostruita"],
  ["points", "Nuvola di punti"],
  ["projection", "Proietta il video sulla scena"],
  ["tracks", "Soggetti"],
  ["trails", "Percorsi"],
  ["uncertainty", "Cerchio di incertezza (2 sigma)"],
  ["frustums", "Posizione delle camere"],
  ["grid", "Griglia a 1 m"],
];

export function TopBar({ onClose }) {
  const c = useStore((s) => s.caseData);
  const tool = useStore((s) => s.tool);
  const layers = useStore((s) => s.layers);
  const { setTool, toggleLayer, requestView } = useStore.getState();
  return (
    <header className="topbar">
      <div className="brand">
        <svg width="20" height="18" viewBox="0 0 20 18" aria-hidden="true"><path d="M10 0 L20 18 H0 Z" fill="#f4c430" /></svg>
        Sopralluogo
      </div>
      <span className="case-title" title={c.source}>{c.title}</span>
      <span className="spacer" />
      <div className="seg" role="group" aria-label="Strumento">
        <button aria-pressed={tool === "orbit"} onClick={() => setTool("orbit")} title="Ruota, sposta e ingrandisci la scena (V)">Esplora</button>
        <button aria-pressed={tool === "measure"} onClick={() => setTool("measure")} title="Distanza tra due punti (M)">Misura</button>
        <button aria-pressed={tool === "calibrate"} onClick={() => setTool("calibrate")} title="Correggi la scala con una distanza nota (K)">Calibra scala</button>
      </div>
      <div className="seg" role="group" aria-label="Vista">
        <button onClick={() => requestView({ kind: "camera", camId: useStore.getState().selectedCam })} title="Guarda dal punto di vista della camera (C)">Dalla camera</button>
        <button onClick={() => requestView({ kind: "top" })} title="Pianta dall'alto (T)">Pianta</button>
        <button onClick={() => requestView({ kind: "overview" })} title="Vista d'insieme (O)">Insieme</button>
      </div>
      <Menu label="Livelli">
        {LAYERS.map(([k, label]) => (
          <label key={k}><input type="checkbox" checked={layers[k]} onChange={() => toggleLayer(k)} />{label}</label>
        ))}
      </Menu>
      <Menu label="Esporta">
        <button onClick={exportPng}>Immagine della vista 3D (PNG)</button>
        <button onClick={exportSubjectsCsv}>Posizioni dei soggetti (CSV)</button>
        <button onClick={exportMeasuresCsv}>Misure e istanti segnati (CSV)</button>
        <button onClick={exportWorkspace}>Salva area di lavoro</button>
        <div className="menu-note">Metti workspace.json nella cartella del caso per ritrovare misure e istanti.</div>
      </Menu>
      <button className="btn ghost" onClick={onClose}>Chiudi caso</button>
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
    const measured = new THREE.Vector3(...dialog.a).distanceTo(new THREE.Vector3(...dialog.b));
    const real = parseFloat(String(val).replace(",", "."));
    const ok = Number.isFinite(real) && real > 0;
    const apply = () => {
      if (!ok) return;
      st.setScale(real / measured, { a: dialog.a, b: dialog.b, real, measured });
      st.setTool("orbit");
      close();
    };
    return (
      <div className="dialog-backdrop" onClick={close}>
        <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); apply(); }}>
          <h2>Distanza reale</h2>
          <p>Nella ricostruzione questi due punti distano {fmtLen(measured)}. Quanto distano nella realta'?</p>
          <input ref={inputRef} type="text" inputMode="decimal" placeholder="es. 3,20" value={val} onChange={(e) => setVal(e.target.value)} aria-label="Distanza reale in metri" />
          {ok && <p style={{ marginTop: 10 }}>Fattore di correzione {(real / measured).toFixed(3)}: tutte le misure verranno moltiplicate per questo valore.</p>}
          <div className="row">
            <button type="button" className="btn ghost" onClick={close}>Annulla</button>
            <button type="submit" className="btn primary" disabled={!ok}>Applica scala</button>
          </div>
        </form>
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
