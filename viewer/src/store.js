import { create } from "zustand";

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
      caseData,
      time: caseData.timeStart,
      selectedCam: caseData.cameras[0]?.id,
      measurements: caseData.workspace?.measurements ?? [],
      bookmarks: caseData.workspace?.bookmarks ?? [],
      scale: caseData.workspace?.scale ?? 1,
      scaleRef: caseData.workspace?.scaleRef ?? null,
    }),

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

  // tools: orbit | measure | calibrate
  tool: "orbit",
  pending: [], // points picked for the current tool
  setTool: (tool) => set({ tool, pending: [] }),
  addPending: (p) => set({ pending: [...get().pending, p] }),
  clearPending: () => set({ pending: [] }),

  // measurements are stored in raw scene units; display multiplies by `scale`
  measurements: [],
  addMeasurement: (m) => set({ measurements: [...get().measurements, m] }),
  removeMeasurement: (id) => set({ measurements: get().measurements.filter((m) => m.id !== id) }),
  scale: 1,
  scaleRef: null,
  setScale: (scale, scaleRef) => set({ scale, scaleRef }),

  bookmarks: [],
  addBookmark: (b) => set({ bookmarks: [...get().bookmarks, b].sort((a, c) => a.t - c.t) }),
  removeBookmark: (id) => set({ bookmarks: get().bookmarks.filter((b) => b.id !== id) }),

  // layers
  layers: { surface: true, points: false, projection: true, tracks: true, trails: true, uncertainty: true, frustums: true, grid: true, boxes: true },
  toggleLayer: (k) => set({ layers: { ...get().layers, [k]: !get().layers[k] } }),

  // camera view requests for the 3D view
  viewRequest: null, // { kind: "camera", camId } | { kind: "focus", point:[x,y,z] } | { kind: "top" }
  requestView: (viewRequest) => set({ viewRequest: { ...viewRequest, nonce: Math.random() } }),

  panel: "subjects", // left panel tab: subjects | measures | case
  setPanel: (panel) => set({ panel }),
  dialog: null,
  setDialog: (dialog) => set({ dialog }),
}));
// handle for automated UI tests and the browser console
if (typeof window !== "undefined") window.__sopralluogo = useStore;
