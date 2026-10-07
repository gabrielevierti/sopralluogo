/* Verification of the case from the viewer: same checks as `sopralluogo verify`. */
import { useStore } from "./store.js";
import { sha256Of } from "./sha256.js";

const OPERATOR_FILES = new Set(["workspace.json"]);

export async function runIntegrity() {
  const st = useStore.getState();
  const c = st.caseData;
  if (!c.manifest) return;
  const files = c.manifest.outputs.filter((o) => !o.path.endsWith("_dev_cache.pkl"));
  const totalBytes = files.reduce((a, o) => a + (o.size_bytes ?? 0), 0);
  const changed = [], missing = [];
  let doneBytes = 0;
  for (let i = 0; i < files.length; i++) {
    const o = files[i];
    const base = doneBytes;
    const progress = (bytes) => useStore.getState().setIntegrity({ status: "running", done: i, total: files.length, file: o.path, bytes: base + bytes, totalBytes });
    progress(0);
    try {
      const got = await sha256Of(c.src, o.path, o.size_bytes, progress);
      if (got !== o.sha256) changed.push(o.path);
    } catch {
      missing.push(o.path);
    }
    doneBytes += o.size_bytes ?? 0;
  }
  // files added after the analysis (only knowable when the folder was opened locally)
  const present = await c.src.list?.();
  const listed = new Set(files.map((o) => o.path));
  const added = present ? present.filter((p) => !listed.has(p) && p !== "manifest.json" && !OPERATOR_FILES.has(p) && !p.startsWith(".")) : [];
  const ok = !changed.length && !missing.length && !added.length;
  const result = { status: ok ? "ok" : "bad", total: files.length, changed, missing, added, at: new Date().toISOString(), listingChecked: !!present };
  useStore.getState().setIntegrity(result);
  useStore.getState().logAction("Verifica di integrita'", ok
    ? `${files.length} file corrispondono al manifest; impronta del caso ${c.fingerprint}`
    : `${changed.length} modificati, ${missing.length} mancanti, ${added.length} aggiunti`);
  return result;
}
