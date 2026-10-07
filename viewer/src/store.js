import { create } from "zustand";
import { mergeTracks } from "./caseLoader.js";

export const TRACK_COLORS = [
  "#5cc8e8", "#e86f5c", "#8fd16a", "#c38ce8", "#e8a24c",
  "#4fd1b0", "#e87fb5", "#9aa9ff", "#d6d46a", "#ff9e7a",
];
export const trackColor = (id) => TRACK_COLORS[(id - 1) % TRACK_COLORS.length];

export const useStore = create((set, get) => ({
  // loaded case
  caseData: null,
  setCase: (caseData) =>
    set({
      caseData: { ...caseData, originalCameras: caseData.cameras },
      time: caseData.timeStart,
      selectedCam: caseData.cameras[0]?.id,
      measurements: caseData.workspace?.measurements ?? [],
      bookmarks: caseData.workspace?.bookmarks ?? [],
      scale: caseData.workspace?.scale ?? 1,
      scaleRef: caseData.workspace?.scaleRef ?? null,
      merges: [],
      journal: caseData.workspace?.journal ?? [],
      report: caseData.workspace?.report ?? { operator: "", reference: "", notes: "" },
      integrity: { status: "unchecked" },
    }),

  /* Registro operazioni: every action that changes what the case says, with a timestamp.
     Saved with the workspace and printed in the report, so a reader can see what the
     operator did on top of the automatic analysis. */
  journal: [],
  logAction: (action, detail = "") =>
    set({ journal: [...get().journal, { at: new Date().toISOString(), action, detail }] }),

  integrity: { status: "unchecked" }, // unchecked | running | ok | bad
  setIntegrity: (integrity) => set({ integrity }),

  report: { operator: "", reference: "", notes: "" },
  setReport: (r) => set({ report: { ...get().report, ...r } }),

  // manual corrections: [{ cam, into, from }]
  merges: [],
  applyMerge: (camId, intoId, fromId, { silent = false } = {}) => {
    const c = get().caseData;
    const cameras = c.cameras.map((k) => {
      if (k.id !== camId) return k;
      const a = k.tracks.find((t) => t.id === intoId), b = k.tracks.find((t) => t.id === fromId);
      if (!a || !b) return k;
      return { ...k, tracks: k.tracks.filter((t) => t.id !== fromId).map((t) => (t.id === intoId ? mergeTracks(a, b) : t)) };
    });
    set({ caseData: { ...c, cameras }, merges: [...get().merges, { cam: camId, into: intoId, from: fromId }] });
    if (!silent) get().logAction("Correzione manuale", `${camId}: soggetto ${fromId} unito al soggetto ${intoId} (stessa persona)`);
  },
  /** Undo one manual correction: rebuild the tracks from the analysis and re-apply the others. */
  undoMerge: (index) => {
    const st = get();
    const removed = st.merges[index];
    const keep = st.merges.filter((_, i) => i !== index);
    set({ caseData: { ...st.caseData, cameras: st.caseData.originalCameras }, merges: [] });
    for (const m of keep) get().applyMerge(m.cam, m.into, m.from, { silent: true });
    get().logAction("Correzione annullata", `${removed.cam}: il soggetto ${removed.from} torna separato dal soggetto ${removed.into}`);
    if (get().selectedTrack === `${removed.cam}:${removed.into}`) set({ selectedTrack: null });
  },

  // clock
  time: 0,
  playing: false,
  rate: 1,
  setTime: (time) => set({ time }),
  setPlaying: (playing) => set({ playing }),
  setRate: (rate) => set({ rate }),

  // selection
  selectedCam: null,
  selectedTrack: null, // "cam1:7"
  setSelectedCam: (selectedCam) => set({ selectedCam }),
  setSelectedTrack: (selectedTrack) => set({ selectedTrack }),
  hoverTrack: null,
  setHoverTrack: (hoverTrack) => set({ hoverTrack }),

  // tools: orbit | measure | calibrate
  tool: "orbit",
  pending: [], // points picked for the current tool
  setTool: (tool) => set({ tool, pending: [] }),
  addPending: (p) => set({ pending: [...get().pending, p] }),
  clearPending: () => set({ pending: [] }),

  // measurements are stored in raw scene units; display multiplies by `scale`
  measurements: [],
  addMeasurement: (m) => {
    set({ measurements: [...get().measurements, m] });
    get().logAction("Misura aggiunta", m.summary ?? "");
  },
  removeMeasurement: (id) => {
    const ms = get().measurements;
    const i = ms.findIndex((m) => m.id === id);
    set({ measurements: ms.filter((m) => m.id !== id) });
    if (i >= 0) get().logAction("Misura eliminata", `misura ${i + 1}${ms[i].summary ? ` (${ms[i].summary})` : ""}`);
  },
  scale: 1,
  scaleRef: null,
  setScale: (scale, scaleRef) => {
    set({ scale, scaleRef });
    get().logAction(scaleRef ? "Scala corretta" : "Correzione di scala rimossa",
      scaleRef ? `riferimento reale ${scaleRef.real.toFixed(3)} m, misurato ${scaleRef.measured.toFixed(3)} m, fattore ${scale.toFixed(4)}, incertezza di scala ±${(scaleRef.sigmaRel * 100).toFixed(1)}%` : "torna la scala stimata automaticamente");
  },

  bookmarks: [],
  addBookmark: (b) => {
    set({ bookmarks: [...get().bookmarks, b].sort((a, c) => a.t - c.t) });
    get().logAction("Istante segnato", `${(b.t - get().caseData.timeStart).toFixed(2)} s: ${b.label}`);
  },
  removeBookmark: (id) => {
    const b = get().bookmarks.find((x) => x.id === id);
    set({ bookmarks: get().bookmarks.filter((x) => x.id !== id) });
    if (b) get().logAction("Istante eliminato", b.label);
  },

  // layers
  layers: { surface: true, points: false, projection: true, tracks: true, trails: true, uncertainty: true, frustums: true, grid: true, boxes: true, fadeUncertain: true, fill: true, sprites: false, people3d: true, generated: true, buildings: false, apron: true, detail: false },
  toggleLayer: (k) => set({ layers: { ...get().layers, [k]: !get().layers[k] } }),

  // camera view requests for the 3D view
  viewRequest: null, // { kind: "camera", camId } | { kind: "focus", point:[x,y,z] } | { kind: "top" }
  requestView: (viewRequest) => set({ viewRequest: { ...viewRequest, nonce: Math.random() } }),

  faceFollow: false,
  setFaceFollow: (faceFollow) => set({ faceFollow }),
  colorFilter: { upper: "", lower: "" },
  setColorFilter: (f) => set({ colorFilter: { ...get().colorFilter, ...f } }),

  personMode: "roto",
  setPersonMode: (personMode) => set({ personMode }),
  presenting: false,
  setPresenting: (presenting) => {
    set({ presenting, ...(presenting ? { playing: true, selectedTrack: null, tool: "orbit" } : {}) });
    if (presenting) get().requestView({ kind: "overview" });
  },
  sideOpen: true,
  setSideOpen: (sideOpen) => set({ sideOpen }),
  videoOpen: true,
  setVideoOpen: (videoOpen) => set({ videoOpen }),

  panel: "subjects", // left panel tab: subjects | measures | case
  setPanel: (panel) => set({ panel }),
  dialog: null,
  setDialog: (dialog) => set({ dialog }),
}));
// handle for automated UI tests and the browser console
if (typeof window !== "undefined") window.__sopralluogo = useStore;
