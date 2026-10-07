/* Everything that leaves the viewer carries what a reader needs to judge it: the case
   fingerprint, the time and frame, the state of the scale, and whether reconstructed
   (invented) surfaces are visible. */
import * as THREE from "three";
import { useStore } from "./store.js";
import { fmtTime, fmtLen, sampleTrack } from "./caseLoader.js";
import { getVideo } from "./Video.jsx";
import { reliableSpeed } from "./Scene3D.jsx";
import { measureUncertainty, scaleSigmaRel, SOURCE_LABEL, ASSUMED_HEIGHT_REL, TAPE_SIGMA_M, FREEFORM_REL } from "./uncertainty.js";

export function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export const stamp = () => new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const localStamp = (d = new Date()) => d.toLocaleString("it-IT", { dateStyle: "short", timeStyle: "medium" });
const csv = (rows) => rows.map((r) => r.map((v) => (typeof v === "string" && /[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v ?? "")).join(",")).join("\n");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function frameOf(cam, t) {
  return Math.max(0, Math.floor((t - cam.time_offset) * cam.fps + 1e-4));
}

export function scaleText(st) {
  const rel = scaleSigmaRel(st.caseData, st.scaleRef);
  return st.scaleRef
    ? `scala corretta con riferimento di ${fmtLen(st.scaleRef.real)} (±${pct(rel)})`
    : `scala stimata dall'altezza media delle persone (±${pct(rel)}), non verificata sul posto`;
}

/* ---------------------------------------------------------------- workspace */
export function workspaceData() {
  const st = useStore.getState();
  return {
    format: "sopralluogo-workspace/2",
    saved_at: new Date().toISOString(),
    case: st.caseData.title,
    case_fingerprint: st.caseData.fingerprint,
    case_inputs_sha256: st.caseData.cameras.map((k) => k.evidence.sha256),
    scale: st.scale, scaleRef: st.scaleRef,
    measurements: st.measurements, bookmarks: st.bookmarks, merges: st.merges,
    report: st.report,
    journal: st.journal,
  };
}

export function exportWorkspace() {
  useStore.getState().logAction("Area di lavoro salvata", "workspace.json");
  download("workspace.json", JSON.stringify(workspaceData(), null, 1), "application/json");
}

/* ---------------------------------------------------------------- CSV */
export function exportSubjectsCsv() {
  const st = useStore.getState();
  const rel = scaleSigmaRel(st.caseData, st.scaleRef);
  const rows = [
    [`# ${st.caseData.title}; impronta del caso ${st.caseData.fingerprint ?? "n.d."}; ${scaleText(st)}; esportato ${new Date().toISOString()}`],
    ["camera", "soggetto", "classe", "tempo_s", "fotogramma", "x_m", "z_m", "incertezza_posizione_1sigma_m", "incertezza_scala_rel", "velocita_kmh", "altezza_m", "interpolato", "corretto_a_mano"],
  ];
  for (const k of st.caseData.cameras)
    for (const t of k.tracks)
      t.t.forEach((_, i) => {
        const p = new THREE.Vector3(t.p[i][0], 0, t.p[i][1]).applyMatrix4(k.alignmentM).multiplyScalar(st.scale);
        rows.push([k.id, t.id, t.cls, (t.tg[i] - st.caseData.timeStart).toFixed(3), t.frame[i], p.x.toFixed(3), p.z.toFixed(3),
          (t.sigma[i] * st.scale).toFixed(3), rel.toFixed(3), t.speed[i] == null ? "" : (t.speed[i] * st.scale).toFixed(2),
          t.h[i] == null ? "" : (t.h[i] * st.scale).toFixed(3), t.interp[i], t.manualMerges?.length ? "si" : ""]);
      });
  st.logAction("Esportazione", "posizioni dei soggetti (CSV)");
  download(`soggetti-${stamp()}.csv`, csv(rows), "text/csv");
}

export function exportMeasuresCsv() {
  const st = useStore.getState();
  const c = st.caseData;
  const rows = [
    [`# ${c.title}; impronta del caso ${c.fingerprint ?? "n.d."}; ${scaleText(st)}; esportato ${new Date().toISOString()}`],
    ["tipo", "n", "tempo_s", "valore_m", "incertezza_1sigma_m", "min_95_m", "max_95_m", "punto_a", "punto_b", "ax", "ay", "az", "bx", "by", "bz", "avvisi", "nota"],
  ];
  st.measurements.forEach((m, i) => {
    const u = measureUncertainty(c, m, st.scale, st.scaleRef);
    rows.push(["misura", i + 1, (m.t - c.timeStart).toFixed(3), u.L.toFixed(3), u.sigma.toFixed(3), u.lo95.toFixed(3), u.hi95.toFixed(3),
      SOURCE_LABEL[m.pa?.src ?? "unknown"], SOURCE_LABEL[m.pb?.src ?? "unknown"],
      ...m.a.map((v) => (v * st.scale).toFixed(3)), ...m.b.map((v) => (v * st.scale).toFixed(3)),
      u.warnings.map((w) => w.text).join(" | "), ""]);
  });
  st.bookmarks.forEach((b, i) => rows.push(["istante", i + 1, (b.t - c.timeStart).toFixed(3), "", "", "", "", "", "", "", "", "", "", "", "", "", b.label]));
  st.logAction("Esportazione", "misure e istanti (CSV)");
  download(`misure-e-istanti-${stamp()}.csv`, csv(rows), "text/csv");
}

/* ---------------------------------------------------------------- captioned image */
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function tag(g, x, y, text, bg, fg, px) {
  g.font = `600 ${px}px Barlow, "Segoe UI", sans-serif`;
  const w = g.measureText(text).width + px * 0.9, h = px * 1.55;
  roundRect(g, x - w / 2, y - h / 2, w, h, px * 0.3);
  g.fillStyle = bg; g.fill();
  g.fillStyle = fg; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, x, y + px * 0.05);
}

/** The 3D view with measurement and subject labels, the original frame and a caption. */
export async function renderViewImage({ withFrame = true } = {}) {
  const st = useStore.getState();
  const c = st.caseData;
  const view = window.__sopralluogoView;
  if (!view) throw new Error("vista 3D non pronta");
  const src = view.gl.domElement;
  const W = src.width, H = src.height, dpr = W / view.size.width;
  const px = Math.round(13 * dpr);
  const lines = captionLines(st);
  const band = Math.round(px * 1.6 * lines.length + px * 1.6);
  const out = document.createElement("canvas");
  out.width = W; out.height = H + band;
  const g = out.getContext("2d");
  g.drawImage(src, 0, 0);

  const toScreen = (v) => {
    const p = v.clone().project(view.camera);
    if (p.z > 1 || p.z < -1) return null;
    return [(p.x + 1) / 2 * W, (1 - p.y) / 2 * H];
  };
  // subjects visible at this instant
  if (st.layers.tracks) {
    for (const k of c.cameras)
      for (const t of k.tracks) {
        const s = sampleTrack(t, st.time);
        if (!s) continue;
        const top = new THREE.Vector3(s.x, (s.h ?? 1.7) + 0.35, s.z).applyMatrix4(k.alignmentM);
        const q = toScreen(top);
        if (q) tag(g, q[0], q[1], String(t.id), "#f4c430", "#141b23", Math.round(px * 0.9));
      }
  }
  // measurements
  st.measurements.forEach((m, i) => {
    const u = measureUncertainty(c, m, st.scale, st.scaleRef);
    const mid = new THREE.Vector3(...m.a).add(new THREE.Vector3(...m.b)).multiplyScalar(0.5);
    const q = toScreen(mid);
    const bg = u.worst === "bad" ? "#6b4a86" : u.worst === "warn" ? "#7a5d10" : "#0f5068";
    if (q) tag(g, q[0], q[1], `${i + 1}: ${fmtLen(u.L)} ±${u.sigma.toFixed(2)}`, bg, "#ffffff", px);
  });

  // the original frame, so the reconstruction is always shown next to what the camera saw
  const cam = c.cameras.find((k) => k.id === st.selectedCam) ?? c.cameras[0];
  const v = getVideo(cam);
  if (withFrame && v.readyState >= 2 && v.videoWidth) {
    const fw = Math.round(W * 0.3), fh = Math.round(fw * v.videoHeight / v.videoWidth);
    const x = W - fw - px, y = px;
    g.fillStyle = "rgba(10,14,19,0.85)";
    g.fillRect(x - 3, y - 3, fw + 6, fh + px * 1.8 + 6);
    g.drawImage(v, x, y, fw, fh);
    g.fillStyle = "#e9eef3"; g.font = `500 ${Math.round(px * 0.85)}px Barlow, sans-serif`;
    g.textAlign = "left"; g.textBaseline = "middle";
    g.fillText(`Fotogramma originale ${frameOf(cam, st.time)}, ${cam.id} (${cam.evidence.file_name})`, x + 4, y + fh + px * 0.9);
  }

  // caption band
  g.fillStyle = "#10161d"; g.fillRect(0, H, W, band);
  g.fillStyle = "#f4c430"; g.fillRect(0, H, W, Math.max(2, Math.round(dpr * 2)));
  g.textAlign = "left"; g.textBaseline = "alphabetic";
  lines.forEach((l, i) => {
    g.font = `${i === 0 ? 600 : 400} ${i === 0 ? Math.round(px * 1.1) : px}px Barlow, "Segoe UI", sans-serif`;
    g.fillStyle = l.warn ? "#d8b4ff" : i === 0 ? "#ffffff" : "#b9c4cf";
    g.fillText(l.text, px, H + px * 1.9 + i * px * 1.6);
  });
  return out;
}

function captionLines(st) {
  const c = st.caseData;
  const cam = c.cameras.find((k) => k.id === st.selectedCam) ?? c.cameras[0];
  const lines = [
    { text: `${c.title}: vista 3D ricostruita` },
    { text: `Tempo ${fmtTime(st.time - c.timeStart)}, fotogramma ${frameOf(cam, st.time)} di ${cam.id}. Distanze in metri, incertezza a 1 sigma; ${scaleText(st)}.` },
    { text: `Impronta del caso (SHA-256 di manifest.json): ${c.fingerprint ?? "non disponibile"}. Esportata il ${localStamp()}.` },
  ];
  const generated = st.layers.surface && (st.layers.fill || st.layers.buildings || st.layers.apron || st.layers.detail);
  if (generated)
    lines.push({ warn: true, text: st.layers.generated
      ? "Le superfici rigate in viola sono completate senza dati: servono a orientarsi, non sono riprese dalla camera."
      : "Attenzione: la vista contiene superfici completate senza dati, qui non evidenziate." });
  return lines;
}

export async function exportPng() {
  const canvas = await renderViewImage();
  const st = useStore.getState();
  st.logAction("Esportazione", `immagine della vista a ${fmtTime(st.time - st.caseData.timeStart)}`);
  canvas.toBlob((b) => download(`vista-3d-${stamp()}.png`, b), "image/png");
}

/* ---------------------------------------------------------------- report */
const REPORT_CSS = `
@page { size: A4; margin: 18mm 16mm 20mm; }
* { box-sizing: border-box; }
body { font: 10.5pt/1.5 "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; color: #1b232c; margin: 0 auto; max-width: 182mm; padding: 24px 0 60px; background: #fff; }
h1 { font: 600 20pt/1.2 "Barlow Condensed", "Arial Narrow", sans-serif; margin: 0 0 4px; letter-spacing: 0.01em; }
h2 { font: 600 12.5pt/1.3 "Barlow Condensed", "Arial Narrow", sans-serif; margin: 26px 0 8px; padding-top: 6px; border-top: 2px solid #1b232c; break-after: avoid; }
h3 { font: 600 10.5pt/1.3 "Barlow", Arial, sans-serif; margin: 14px 0 4px; }
p { margin: 0 0 8px; max-width: 75ch; }
.sub { color: #505c68; margin-bottom: 18px; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font: 9pt/1.4 "Barlow", Arial, sans-serif; break-inside: auto; }
th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #d5dbe1; vertical-align: top; }
th { font-weight: 600; color: #3a4652; border-bottom: 1.5px solid #1b232c; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr { break-inside: avoid; }
.kv { display: grid; grid-template-columns: 52mm 1fr; gap: 2px 12px; font: 9.5pt/1.45 "Barlow", Arial, sans-serif; margin: 4px 0 10px; }
.kv dt { color: #505c68; } .kv dd { margin: 0; }
.hash { font: 8.5pt/1.4 ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; word-break: break-all; }
.seal { border: 2px solid #1b232c; padding: 10px 12px; margin: 14px 0; break-inside: avoid; }
.seal .hash { font-size: 10pt; font-weight: 600; }
.ok { color: #1d6b3a; font-weight: 600; } .bad { color: #a3262a; font-weight: 600; } .warn { color: #8a5a00; }
.note { color: #505c68; font-size: 9pt; }
figure { margin: 8px 0 12px; break-inside: avoid; } figure img { width: 100%; display: block; border: 1px solid #c8d0d8; }
figcaption { font: 8.5pt/1.4 "Barlow", Arial, sans-serif; color: #505c68; margin-top: 4px; }
.sign { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 40px; font: 9.5pt "Barlow", Arial, sans-serif; break-inside: avoid; }
.sign div { border-top: 1px solid #1b232c; padding-top: 4px; color: #505c68; }
.toolbar { position: sticky; top: 0; background: #f4f6f8; border-bottom: 1px solid #d5dbe1; padding: 8px 0; margin: -24px 0 18px; font: 10pt "Barlow", Arial, sans-serif; }
.toolbar button { font: inherit; padding: 6px 12px; cursor: pointer; }
@media print { .toolbar { display: none; } body { padding: 0; } }
`;

export async function buildReport() {
  const st = useStore.getState();
  const c = st.caseData;
  const r = st.report;
  const now = new Date();
  const sRel = scaleSigmaRel(c, st.scaleRef);
  let img = null;
  try { img = (await renderViewImage()).toDataURL("image/jpeg", 0.88); } catch { /* no view */ }

  const integ = st.integrity;
  const integrityHtml = integ.status === "ok"
    ? `<span class="ok">Verifica eseguita il ${esc(localStamp(new Date(integ.at)))}: tutti i ${integ.total} file corrispondono al manifest.</span>`
    : integ.status === "bad"
      ? `<span class="bad">Verifica eseguita il ${esc(localStamp(new Date(integ.at)))}: ${integ.changed.length} file modificati, ${integ.missing.length} mancanti, ${integ.added.length} aggiunti.</span>`
      : `<span class="warn">Verifica dei file non eseguita prima di questa relazione.</span>`;

  const measures = st.measurements.map((m, i) => {
    const u = measureUncertainty(c, m, st.scale, st.scaleRef);
    return `<tr><td class="num">${i + 1}</td><td class="num">${fmtTime(m.t - c.timeStart)}</td>
      <td class="num"><b>${u.L.toFixed(2)} m</b></td><td class="num">±${u.sigma.toFixed(2)} m</td>
      <td class="num">${u.lo95.toFixed(2)} – ${u.hi95.toFixed(2)} m</td>
      <td>${esc(SOURCE_LABEL[m.pa?.src ?? "unknown"])}, ${esc(SOURCE_LABEL[m.pb?.src ?? "unknown"])}</td>
      <td>${u.warnings.map((w) => `<div class="${w.level === "bad" ? "bad" : "warn"}">${esc(w.text)}</div>`).join("") || "nessuno"}</td></tr>`;
  }).join("");

  const subjects = c.cameras.flatMap((k) => k.tracks.map((t) => {
    const s = t.stats ?? {};
    const speed = reliableSpeed(t) ? `${(s.median_speed_kmh * st.scale).toFixed(1)} ±${((s.speed_sigma_kmh ?? 0) * st.scale).toFixed(1)}` : "n.d.";
    const h = s.height_m != null ? `${(s.height_m * st.scale).toFixed(2)}` : "n.d.";
    const pos = s.median_sigma_m != null ? `±${(s.median_sigma_m * st.scale).toFixed(1)}` : "n.d.";
    const corr = t.manualMerges?.length ? `unito a mano con ${t.manualMerges.join(", ")}` : "";
    return `<tr><td>${esc(k.id)}</td><td class="num">${t.id}</td><td>${esc(t.cls === "person" ? "persona" : t.cls)}</td>
      <td class="num">${fmtTime((s.start_s ?? t.t[0]))} – ${fmtTime((s.end_s ?? t.t[t.t.length - 1]))}</td>
      <td class="num">${s.path_m != null ? (s.path_m * st.scale).toFixed(1) : "n.d."}</td><td class="num">${speed}</td><td class="num">${h}</td><td class="num">${pos}</td><td>${esc(corr)}</td></tr>`;
  })).join("");

  const cams = c.cameras.map((k) => {
    const cal = k.calibration ?? {}, cm = k.camera;
    return `<h3>${esc(k.id)}: ${esc(k.evidence.file_name)}</h3>
    <dl class="kv">
      <dt>SHA-256 del video originale</dt><dd class="hash">${esc(k.evidence.sha256)}</dd>
      <dt>Dimensione</dt><dd>${k.evidence.size_bytes != null ? `${k.evidence.size_bytes.toLocaleString("it-IT")} byte` : "n.d."}</dd>
      <dt>Durata e cadenza</dt><dd>${fmtTime(k.duration)}, ${k.fps.toFixed(2)} fotogrammi al secondo, ${k.width} x ${k.height} pixel</dd>
      <dt>Altezza della camera</dt><dd>${cm.height_m.toFixed(2)} m ±${(cal.std_height_m ?? 0).toFixed(2)}</dd>
      <dt>Inclinazione</dt><dd>${cm.pitch_deg.toFixed(1)}° ±${(cal.std_pitch_deg ?? 0).toFixed(1)}, rollio ${cm.roll_deg.toFixed(1)}°</dd>
      <dt>Campo visivo orizzontale</dt><dd>${cm.hfov_deg.toFixed(1)}°${cal.std_hfov_deg != null ? ` ±${cal.std_hfov_deg.toFixed(1)}` : ""}${cal.focal_estimated ? " (stimato)" : " (dato)"}</dd>
      <dt>Metodo</dt><dd>${esc(cal.method ?? "")}; ${cal.people ?? 0} persone, ${cal.vertical_lines ?? 0} linee verticali, errore mediano ${(cal.median_reprojection_px ?? 0).toFixed(1)} px</dd>
      <dt>Camera ferma</dt><dd>${k.camera_motion?.static ? "si'" : `<span class="bad">no: il modello a camera fissa non e' affidabile</span>`}</dd>
      ${k.sync ? `<dt>Sincronia</dt><dd>${esc(k.sync.method)}, scarto ${k.time_offset.toFixed(2)} s</dd>` : ""}
      ${k.alignment_report ? `<dt>Allineamento</dt><dd>${esc(k.alignment_report.method)}${k.alignment_report.rms_m != null ? `, scarto quadratico medio ${k.alignment_report.rms_m.toFixed(2)} m` : ""}</dd>` : ""}
    </dl>${cal.warning ? `<p class="warn">${esc(cal.warning)}</p>` : ""}`;
  }).join("");

  const journal = st.journal.map((j) => `<tr><td class="num">${esc(localStamp(new Date(j.at)))}</td><td>${esc(j.action)}</td><td>${esc(j.detail)}</td></tr>`).join("");
  const bookmarks = st.bookmarks.map((b) => `<tr><td class="num">${fmtTime(b.t - c.timeStart)}</td><td>${esc(b.label)}</td></tr>`).join("");
  const models = (c.manifest?.models ?? []).map((m) => `<tr><td>${esc(m.about)}</td><td class="hash">${esc(m.sha256)}</td></tr>`).join("");

  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Relazione tecnica: ${esc(c.title)}</title>
<style>${REPORT_CSS}</style></head><body>
<div class="toolbar"><button onclick="print()">Stampa o salva in PDF</button></div>
<h1>Relazione tecnica di ricostruzione 3D</h1>
<p class="sub">${esc(c.title)}${r.reference ? `. Riferimento: ${esc(r.reference)}` : ""}. Redatta il ${esc(localStamp(now))}${r.operator ? ` da ${esc(r.operator)}` : ""}.</p>

<div class="seal">
  <div>Impronta del caso (SHA-256 di manifest.json, da riportare a verbale):</div>
  <div class="hash">${esc(c.fingerprint ?? "manifest.json assente: il caso non e' verificabile")}</div>
  <p style="margin-top:6px">${integrityHtml}</p>
  <p class="note">Il manifest elenca l'impronta di ogni file prodotto dall'analisi. Chiunque puo' ricontrollare il caso con <span class="hash">sopralluogo verify &lt;cartella&gt; --impronta ${esc((c.fingerprint ?? "").slice(0, 16))}...</span> o dal visualizzatore; se l'impronta non coincide con quella sopra, il caso e' stato modificato dopo questa relazione.</p>
</div>

${r.notes ? `<h2>Oggetto</h2><p>${esc(r.notes).replace(/\n/g, "<br>")}</p>` : ""}

<h2>Sintesi dei limiti</h2>
<p>La scena e' ricostruita da ${c.cameras.length === 1 ? "una sola telecamera" : `${c.cameras.length} telecamere`}. Le distanze sono stime ottenute dalla geometria della ripresa e vanno lette con la loro incertezza. ${st.scaleRef
    ? `La scala e' stata corretta con una distanza nota misurata sul posto (${fmtLen(st.scaleRef.real)}); l'incertezza di scala residua e' ±${pct(sRel)}.`
    : `<b>La scala non e' stata verificata sul posto</b>: deriva dall'altezza media assunta per le persone inquadrate e ha un'incertezza di circa ±${pct(sRel)}. Per un uso probatorio va corretta con almeno una distanza misurata sul luogo.`}
Le superfici non viste dalla camera (dietro gli oggetti, retro degli edifici e delle persone, pavimento attorno alla scena) sono completate senza dati: servono a orientarsi e non hanno valore di ripresa.</p>
${(c.scene.notes ?? []).map((t) => `<p class="note">${esc(t)}</p>`).join("")}

<h2>Fonti</h2>
${cams}

<h2>Misure</h2>
${st.measurements.length ? `<table><thead><tr><th class="num">N.</th><th class="num">Istante</th><th class="num">Distanza</th><th class="num">1 sigma</th><th class="num">Intervallo 95%</th><th>Punti su</th><th>Avvisi</th></tr></thead><tbody>${measures}</tbody></table>
<p class="note">Incertezza a 1 sigma: errore di localizzazione dei punti, inclinazione della camera e scala, combinati (metodo in docs/METODO.md). L'intervallo al 95% e' ±1,96 sigma. Una misura con un estremo su superficie ricostruita non va usata.</p>` : "<p>Nessuna misura eseguita.</p>"}

${img ? `<h2>Vista</h2><figure><img src="${img}" alt="Vista 3D al momento della relazione"><figcaption>Vista al momento della redazione. A destra il fotogramma originale corrispondente; sotto, i dati per ricondurre l'immagine al caso.</figcaption></figure>` : ""}

${bookmarks ? `<h2>Istanti segnati</h2><table><thead><tr><th class="num">Istante</th><th>Nota</th></tr></thead><tbody>${bookmarks}</tbody></table>` : ""}

<h2>Soggetti tracciati</h2>
<table><thead><tr><th>Camera</th><th class="num">N.</th><th>Classe</th><th class="num">Visibile</th><th class="num">Percorso m</th><th class="num">Velocita' km/h</th><th class="num">Altezza m</th><th class="num">Posizione m</th><th>Correzioni</th></tr></thead><tbody>${subjects}</tbody></table>
<p class="note">I soggetti sono numerati automaticamente; il numero non e' un'identificazione. Velocita' tipica come mediana con la sua dispersione (n.d. quando la stima non e' affidabile: dispersione oltre 4 km/h o soggetto visto per meno di 1,5 s); posizione come incertezza mediana a 1 sigma sul suolo.</p>

<h2>Registro delle operazioni</h2>
${journal ? `<table><thead><tr><th class="num">Quando</th><th>Operazione</th><th>Dettaglio</th></tr></thead><tbody>${journal}</tbody></table>` : "<p>Nessuna operazione registrata oltre all'analisi automatica.</p>"}

<h2>Software e modelli</h2>
<dl class="kv">
  <dt>Software</dt><dd>${esc(c.manifest?.software?.name ?? "sopralluogo")} ${esc(c.manifest?.software?.version ?? "")}, Python ${esc(c.manifest?.software?.python ?? "")}, OpenCV ${esc(c.manifest?.software?.opencv ?? "")}</dd>
  <dt>Analisi eseguita</dt><dd>dal ${esc(c.manifest?.started ?? "n.d.")} al ${esc(c.manifest?.finished ?? "n.d.")}</dd>
  <dt>File prodotti</dt><dd>${c.manifest?.outputs?.length ?? "n.d."}, ciascuno con impronta SHA-256 nel manifest</dd>
</dl>
${models ? `<table><thead><tr><th>Modello</th><th>SHA-256</th></tr></thead><tbody>${models}</tbody></table>` : ""}
<p class="note">Parametri dell'incertezza: altezza media assunta ±${pct(ASSUMED_HEIGHT_REL)}, profondita' su superficie libera ±${pct(FREEFORM_REL)} della distanza, riferimento misurato a nastro ±${(TAPE_SIGMA_M * 100).toFixed(0)} cm.</p>

<div class="sign"><div>Luogo e data</div><div>Firma${r.operator ? ` (${esc(r.operator)})` : ""}</div></div>
</body></html>`;
  return html;
}

export async function exportReport() {
  const html = await buildReport();
  const st = useStore.getState();
  st.logAction("Relazione generata", `impronta del caso ${st.caseData.fingerprint ?? "n.d."}`);
  const name = `relazione-${stamp()}.html`;
  download(name, html, "text/html");
  const w = window.open("", "_blank");
  if (w) { w.document.open(); w.document.write(html); w.document.close(); }
}
