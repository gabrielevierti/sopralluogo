import { useEffect, useRef, useState } from "react";
import { useStore } from "./store.js";
import { loadCase, urlSource, filesSource } from "./caseLoader.js";
import Scene3D, { disposeTextures } from "./Scene3D.jsx";
import Timeline, { stepFrame } from "./Timeline.jsx";
import SidePanel, { SideTab } from "./SidePanel.jsx";
import { VideoPanel, Clock, disposeVideos } from "./Video.jsx";
import { TopBar, ToolHint, Dialogs, GeneratedLegend } from "./Chrome.jsx";
import { runIntegrity } from "./integrity.js";

async function readEntries(entry, prefix = "") {
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej));
    f.relPath = prefix + entry.name;
    return [f];
  }
  const reader = entry.createReader();
  const all = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    all.push(...batch);
  }
  const out = [];
  for (const e of all) out.push(...(await readEntries(e, prefix + entry.name + "/")));
  return out;
}

function PlanArt() {
  // a plan view of a surveyed scene: camera wedge, walked paths, evidence markers
  return (
    <svg viewBox="0 0 600 700" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <pattern id="g" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke="#243142" strokeWidth="1" />
        </pattern>
        <pattern id="g5" width="100" height="100" patternUnits="userSpaceOnUse">
          <path d="M100 0H0V100" fill="none" stroke="#2f3f52" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="600" height="700" fill="url(#g)" />
      <rect width="600" height="700" fill="url(#g5)" />
      <path d="M380 70h200v260H380z M40 90h190v120H40z" fill="#223042" stroke="#3b4d62" />
      <path d="M300 640 L40 250 L560 250 Z" fill="rgba(244,196,48,0.05)" stroke="rgba(244,196,48,0.35)" strokeDasharray="4 5" />
      <circle cx="300" cy="640" r="7" fill="#f4c430" />
      <path d="M90 300 C170 360 240 380 330 470 S470 560 520 600" fill="none" stroke="#5cc8e8" strokeWidth="2.5" />
      <path d="M520 290 C450 330 400 330 350 380 S260 450 200 560" fill="none" stroke="#e86f5c" strokeWidth="2.5" />
      <path d="M140 270 C200 300 260 290 330 320" fill="none" stroke="#8fd16a" strokeWidth="2.5" strokeDasharray="1 0" />
      <circle cx="330" cy="470" r="22" fill="none" stroke="#5cc8e8" strokeOpacity="0.6" />
      <circle cx="350" cy="380" r="16" fill="none" stroke="#e86f5c" strokeOpacity="0.6" />
      <path d="M330 470 L350 380" stroke="#5cc8e8" strokeWidth="1.5" strokeDasharray="5 4" />
      <rect x="352" y="414" width="58" height="20" rx="3" fill="#5cc8e8" />
      <text x="381" y="429" textAnchor="middle" fontFamily="Barlow Condensed" fontWeight="600" fontSize="14" fill="#06202a">9,24 m</text>
      {[[330, 470, 1], [350, 380, 2], [330, 320, 3]].map(([x, y, k]) => (
        <g key={k} transform={`translate(${x - 13} ${y - 40})`}>
          <path d="M13 0 L26 22 H0 Z" fill="#f4c430" />
          <text x="13" y="19" textAnchor="middle" fontFamily="Barlow Condensed" fontWeight="700" fontSize="12" fill="#231c05">{k}</text>
        </g>
      ))}
    </svg>
  );
}

function Landing({ onSource, status, error }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  const onDrop = async (e) => {
    e.preventDefault();
    setOver(false);
    const items = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const files = [];
    for (const it of items) files.push(...(await readEntries(it)));
    onSource(filesSource(files));
  };
  return (
    <div className="landing">
      <div className="landing-art"><PlanArt /></div>
      <main className="landing-main">
        <h1>Sopralluogo</h1>
        <p className="lead">
          Ricostruisci in 3D una scena ripresa da una o piu' telecamere: rivedi il video dentro la scena,
          segui i soggetti sulla pianta, misura distanze e velocita'.
        </p>
        <div className={`drop ${over ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)} onDrop={onDrop}>
          <p>Trascina qui la cartella di un caso, oppure</p>
          <button className="btn primary" onClick={() => inputRef.current.click()}>Apri cartella del caso</button>
          <input ref={inputRef} type="file" webkitdirectory="" directory="" multiple hidden
            onChange={(e) => e.target.files.length && onSource(filesSource([...e.target.files]))} />
          <p className="status">I file restano su questo computer: niente viene caricato in rete.</p>
        </div>
        {status && <p className="status">{status}</p>}
        {error && <p className="error">{error}</p>}
        <div>
          <p className="status" style={{ marginBottom: 6 }}>Per creare un caso da uno o piu' video:</p>
          <code className="cmd">sopralluogo process video1.mp4 video2.mp4 -o caso/</code>
        </div>
      </main>
    </div>
  );
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.("input, select, textarea") || e.metaKey || e.ctrlKey) return;
      const st = useStore.getState();
      if (!st.caseData || st.dialog) return;
      const k = e.key.toLowerCase();
      if (k === " ") { e.preventDefault(); st.setPlaying(!st.playing); }
      else if (k === "arrowleft") { e.preventDefault(); stepFrame(e.shiftKey ? -10 : -1); }
      else if (k === "arrowright") { e.preventDefault(); stepFrame(e.shiftKey ? 10 : 1); }
      else if (k === "escape") { st.setTool("orbit"); st.setSelectedTrack(null); if (st.presenting) st.setPresenting(false); }
      else if (k === "m") st.setTool("measure");
      else if (k === "k") st.setTool("calibrate");
      else if (k === "v") st.setTool("orbit");
      else if (k === "c") st.requestView({ kind: "camera", camId: st.selectedCam });
      else if (k === "t") st.requestView({ kind: "top" });
      else if (k === "o") st.requestView({ kind: "overview" });
      else if (k === "b") st.setDialog({ kind: "bookmark", t: st.time });
      else if (k === "p") st.setPresenting(!st.presenting);
      else if (k === "?" || k === "h") st.setDialog({ kind: "help" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  const caseData = useStore((s) => s.caseData);
  const presenting = useStore((s) => s.presenting);
  const sideOpen = useStore((s) => s.sideOpen);
  const setCase = useStore((s) => s.setCase);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  useShortcuts();

  const open = async (src) => {
    setError("");
    try {
      const c = await loadCase(src, setStatus);
      setStatus("");
      setCase(c);
      for (const m of c.workspace?.merges ?? []) useStore.getState().applyMerge(m.cam, m.into, m.from, { silent: true });
      setTimeout(() => useStore.getState().requestView({ kind: "overview" }), 50);
      // small cases are verified straight away; big ones on request (it reads every byte)
      const sizes = c.manifest?.outputs?.map((o) => o.size_bytes);
      if (sizes?.length && sizes.every((x) => x != null) && sizes.reduce((a, b) => a + b, 0) < 300 * 1048576)
        setTimeout(() => runIntegrity(), 1500);
      // first time: a short "how to" (remembered in this browser only)
      let seen = false;
      try { seen = localStorage.getItem("sopralluogo:help-seen") === "1"; localStorage.setItem("sopralluogo:help-seen", "1"); } catch { /* private mode */ }
      if (!seen) setTimeout(() => useStore.getState().setDialog({ kind: "help" }), 600);
    } catch (e) {
      console.error(e);
      setStatus("");
      setError(`Impossibile aprire il caso: ${e.message}`);
    }
  };

  useEffect(() => {
    const q = new URLSearchParams(location.search).get("case");
    if (q) open(urlSource(q));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!caseData) return <Landing onSource={open} status={status} error={error} />;
  return (
    <div className={`app ${presenting ? "presenting" : ""}`}>
      <Clock />
      <TopBar onClose={() => { disposeVideos(); disposeTextures(); useStore.setState({ caseData: null, playing: false, selectedTrack: null }); }} />
      <div className="stage">
        <Scene3D />
        {!presenting && (sideOpen ? <SidePanel /> : <SideTab />)}
        <VideoPanel />
        <ToolHint />
        <GeneratedLegend />
      </div>
      <Timeline />
      <Dialogs />
    </div>
  );
}
