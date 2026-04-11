import { useState, useEffect, useRef } from "react";

const API_BASE = process.env.REACT_APP_API_URL || "https://ids-checker-api.railway.app";

// ── Trimble Connect 3D Extension ──────────────────────────────────────────────
// Runs as a 3D Viewer extension, giving access to both project and viewer APIs.
async function connectToTC() {
  if (!window.parent || window.parent === window) return null;
  try {
    const WorkspaceAPI = await import("trimble-connect-workspace-api");
    let accessToken = null;

    const api = await WorkspaceAPI.connect(
      window.parent,
      (event, args) => {
        if (event === "extension.accessToken") accessToken = args?.data;
      },
      10000
    );

    // Request access token – needed for file downloads
    const token = await api.extension.requestPermission("accesstoken");
    if (token && token !== "pending" && token !== "denied") accessToken = token;

    return { api, getAccessToken: () => accessToken };
  } catch (e) {
    console.log("TC connect failed (dev mode):", e.message);
    return null;
  }
}

// Get all currently loaded IFC models from the 3D viewer
async function getLoadedIfcModels(api) {
  try {
    // "loaded" filter returns only models currently visible in viewer
    const models = await api.viewer.getModels("loaded");
    const ifcModels = [];
    for (const model of models) {
      try {
        const file = await api.viewer.getLoadedModel(model.modelId);
        if (file?.name?.toLowerCase().endsWith(".ifc")) {
          ifcModels.push({
            modelId: model.modelId,
            name: file.name,
            fileId: file.id,
            size: file.size,
          });
        }
      } catch {
        // Skip models we can't read
      }
    }
    return ifcModels;
  } catch (e) {
    console.log("getModels failed:", e.message);
    return [];
  }
}

// Download a file from TC using access token
async function downloadTCFile(accessToken, fileId, fileName) {
  const res = await fetch(
    `https://app.connect.trimble.com/tc/api/2.0/files/${fileId}/download`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Nedlasting feilet: ${res.status}`);
  const blob = await res.blob();
  return new File([blob], fileName);
}

// Mark failing objects in the 3D viewer using GUIDs
async function markObjectsInViewer(api, modelId, guids) {
  try {
    // Convert IFC GlobalIds (external) to viewer runtime IDs
    const runtimeIds = await api.viewer.convertToObjectRuntimeIds(modelId, guids);
    const validIds = runtimeIds.filter((id) => id != null);

    if (validIds.length === 0) {
      return { success: false, message: "Ingen objekter funnet i visningen" };
    }

    // Set selection – "set" replaces current selection
    await api.viewer.setSelection(
      { modelObjectIds: [{ modelId, objectRuntimeIds: validIds }] },
      "set"
    );

    // Zoom camera to fit selected objects
    await api.viewer.setCamera(
      { modelObjectIds: [{ modelId, objectRuntimeIds: validIds }] },
      { animationTime: 500 }
    );

    return { success: true, count: validIds.length };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ── Mock data for dev mode ────────────────────────────────────────────────────
const DEV_LOADED_MODELS = [
  { modelId: "mock-1", name: "Arkitektur_K11.ifc", fileId: "1", size: 18400000 },
];
const DEV_IDS = [
  { id: "a", name: "Byggherre_krav_v2.ids", versionDate: "2025-03-28" },
  { id: "b", name: "LOD300_leveranse.ids", versionDate: "2025-02-15" },
];

// ── Timer hook ────────────────────────────────────────────────────────────────
function useTimer(running) {
  const [seconds, setSeconds] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    if (running) {
      setSeconds(0);
      ref.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } else {
      clearInterval(ref.current);
    }
    return () => clearInterval(ref.current);
  }, [running]);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Icons ────────────────────────────────────────────────────────────────────
const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <circle cx="7" cy="7" r="6.5" fill="#16a34a" />
    <path d="M4 7l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const FailIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <circle cx="7" cy="7" r="6.5" fill="#dc2626" />
    <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
const FileIcon = ({ color = "#64748b" }) => (
  <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
    <path d="M3 2a1 1 0 011-1h5.5L12 4.5V13a1 1 0 01-1 1H4a1 1 0 01-1-1V2z" stroke={color} strokeWidth="1.2" />
    <path d="M8.5 1v3.5H12" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);
const ChevronIcon = ({ open }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
    style={{ transform: open ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.2s" }}>
    <path d="M4 2l4 4-4 4" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const UploadIcon = ({ color = "#6366f1" }) => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path d="M9 12V4M6 7l3-3 3 3" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 14h12" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
const SpinnerIcon = ({ color = "white" }) => (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" style={{ animation: "spin 0.9s linear infinite" }}>
    <circle cx="10" cy="10" r="8" stroke="#334155" strokeWidth="2" />
    <path d="M10 2a8 8 0 018 8" stroke={color} strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const MarkIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />
    <path d="M3.5 6l2 2 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ── Reusable UI components ────────────────────────────────────────────────────
function TabBar({ value, onChange, options }) {
  return (
    <div style={{ display: "flex", gap: 2, marginBottom: 8, background: "#0f172a", borderRadius: 7, padding: 3 }}>
      {options.map(([key, label]) => (
        <button key={key} onClick={() => onChange(key)} style={{
          flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, border: "none",
          cursor: "pointer", borderRadius: 5, transition: "all 0.15s", fontFamily: "inherit",
          background: value === key ? "#1e293b" : "transparent",
          color: value === key ? "#e2e8f0" : "#64748b",
        }}>{label}</button>
      ))}
    </div>
  );
}

function UploadZone({ file, onFile, accept, color, label }) {
  return (
    <label style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
      border: `1.5px dashed ${file ? color : "#1e293b"}`,
      borderRadius: 8, padding: "20px 14px", cursor: "pointer",
      background: file ? `${color}08` : "transparent", transition: "all 0.15s",
    }}>
      <input type="file" accept={accept} style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
      <UploadIcon color={file ? color : "#6366f1"} />
      {file
        ? <div style={{ fontSize: 12, color, fontWeight: 600 }}>{file.name}</div>
        : <div style={{ fontSize: 12, color: "#64748b", textAlign: "center" }}>
            Dra og slipp <span style={{ color }}>{label}</span> hit<br />
            <span style={{ fontSize: 10 }}>eller klikk for å velge</span>
          </div>
      }
    </label>
  );
}

function ModelRow({ model, selected, onSelect, badge }) {
  return (
    <button onClick={() => onSelect(model)} style={{
      display: "flex", alignItems: "center", gap: 10, width: "100%",
      padding: "8px 10px", borderRadius: 6, border: "none", cursor: "pointer",
      background: selected ? "#0ea5e910" : "transparent",
      outline: selected ? "1.5px solid #0ea5e9" : "1.5px solid transparent",
      transition: "all 0.15s", textAlign: "left", marginBottom: 3,
    }}>
      <FileIcon color="#0ea5e9" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: "#e2e8f0", fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {model.name}
        </div>
        {badge && (
          <div style={{ fontSize: 9, marginTop: 2, background: "#0ea5e920", color: "#0ea5e9", borderRadius: 3, padding: "1px 5px", display: "inline-block", fontWeight: 700 }}>
            {badge}
          </div>
        )}
      </div>
      {selected && <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#0ea5e9", flexShrink: 0 }} />}
    </button>
  );
}

function FileRow({ file, selected, onSelect, type }) {
  const color = type === "ids" ? "#8b5cf6" : "#0ea5e9";
  const date = file.versionDate ? file.versionDate.slice(0, 10) : "";
  return (
    <button onClick={() => onSelect(file)} style={{
      display: "flex", alignItems: "center", gap: 10, width: "100%",
      padding: "8px 10px", borderRadius: 6, border: "none", cursor: "pointer",
      background: selected ? `${color}10` : "transparent",
      outline: selected ? `1.5px solid ${color}` : "1.5px solid transparent",
      transition: "all 0.15s", textAlign: "left", marginBottom: 3,
    }}>
      <FileIcon color={color} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: "#e2e8f0", fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {file.name}
        </div>
        {date && <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>{date}</div>}
      </div>
      {selected && <div style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />}
    </button>
  );
}

// ── SpecRow with "Mark in TC" button ─────────────────────────────────────────
function SpecRow({ spec, index, onMark, canMark }) {
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markResult, setMarkResult] = useState(null);
  const pct = spec.total > 0 ? Math.round((spec.passed / spec.total) * 100) : 100;

  const handleMark = async () => {
    if (!onMark || marking) return;
    setMarking(true);
    setMarkResult(null);
    const guids = spec.failures.map((f) => f.guid).filter(Boolean);
    const result = await onMark(guids);
    setMarkResult(result);
    setMarking(false);
  };

  return (
    <div style={{
      background: "#0f172a", borderRadius: 8, overflow: "hidden",
      border: `1px solid ${spec.status === "passed" ? "#16a34a22" : "#dc262622"}`,
      marginBottom: 6, animation: "fadeUp 0.3s ease both",
      animationDelay: `${index * 0.04}s`,
    }}>
      <button onClick={() => spec.failures?.length > 0 && setOpen(!open)} style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%",
        padding: "10px 12px", background: "transparent", border: "none",
        cursor: spec.failures?.length > 0 ? "pointer" : "default", textAlign: "left",
      }}>
        {spec.status === "passed" ? <CheckIcon /> : <FailIcon />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0", marginBottom: 2 }}>{spec.name}</div>
          <div style={{ fontSize: 10, color: "#64748b", fontFamily: "'IBM Plex Mono', monospace" }}>{spec.applicability}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: spec.status === "passed" ? "#16a34a" : "#dc2626" }}>
            {spec.passed}/{spec.total}
          </div>
          <div style={{ width: 48, height: 3, background: "#1e293b", borderRadius: 2, marginTop: 3 }}>
            <div style={{ width: `${pct}%`, height: "100%", background: spec.status === "passed" ? "#16a34a" : "#dc2626", borderRadius: 2, transition: "width 0.6s ease" }} />
          </div>
        </div>
        {spec.failures?.length > 0 && <ChevronIcon open={open} />}
      </button>

      {open && spec.failures?.length > 0 && (
        <div style={{ borderTop: "1px solid #1e293b", padding: "8px 12px 10px" }}>
          <div style={{ fontSize: 10, color: "#64748b", marginBottom: 8 }}>KRAV: {spec.requirement}</div>

          {spec.failures.map((f, i) => (
            <div key={i} style={{
              display: "flex", gap: 8, alignItems: "center", padding: "4px 0",
              borderBottom: i < spec.failures.length - 1 ? "1px solid #0f172a" : "none",
            }}>
              <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#dc2626", flexShrink: 0 }} />
              <div style={{ fontSize: 11, color: "#94a3b8", flex: 1 }}>{f.name}</div>
              <div style={{ fontSize: 10, fontFamily: "'IBM Plex Mono', monospace", color: "#475569" }}>{f.type}</div>
            </div>
          ))}

          {spec.more_failures > 0 && (
            <div style={{ fontSize: 10, color: "#64748b", marginTop: 6 }}>
              + {spec.more_failures} flere feil ikke vist
            </div>
          )}

          {/* Mark in TC button */}
          {canMark && spec.failures.some((f) => f.guid) && (
            <button onClick={handleMark} disabled={marking} style={{
              width: "100%", marginTop: 10, padding: "7px 10px",
              borderRadius: 6, border: "1px solid #dc262640", background: "#dc262610",
              color: "#ef4444", fontFamily: "inherit", fontSize: 11, fontWeight: 600,
              cursor: marking ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              transition: "all 0.15s",
            }}>
              {marking ? <><SpinnerIcon color="#ef4444" /> Markerer…</> : <><MarkIcon /> Marker {spec.failures.length} objekter i TC</>}
            </button>
          )}

          {markResult && (
            <div style={{
              marginTop: 6, padding: "6px 10px", borderRadius: 5, fontSize: 10,
              background: markResult.success ? "#16a34a15" : "#dc262615",
              color: markResult.success ? "#16a34a" : "#dc2626",
              border: `1px solid ${markResult.success ? "#16a34a30" : "#dc262630"}`,
            }}>
              {markResult.success
                ? `✓ ${markResult.count} objekter markert i visningen`
                : `✕ ${markResult.message}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────────────────
export default function IDSChecker() {
  const [tc, setTc] = useState(null);
  const [devMode, setDevMode] = useState(false);

  // IFC model state – loaded from viewer OR uploaded
  const [loadedModels, setLoadedModels] = useState([]);  // from TC viewer
  const [selectedModel, setSelectedModel] = useState(null); // TC model object
  const [uploadedIfc, setUploadedIfc] = useState(null);
  const [ifcTab, setIfcTab] = useState("viewer");
  const [loadingModels, setLoadingModels] = useState(true);

  // IDS state
  const [projectIds, setProjectIds] = useState([]);
  const [selectedIds, setSelectedIds] = useState(null);
  const [uploadedIds, setUploadedIds] = useState(null);
  const [idsTab, setIdsTab] = useState("upload");

  // Validation state
  const [isRunning, setIsRunning] = useState(false);
  const [loadingStep, setLoadingStep] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [filterFailed, setFilterFailed] = useState(false);

  const timer = useTimer(isRunning);

  // Connect to TC and detect loaded models
  useEffect(() => {
    (async () => {
      const tcConn = await connectToTC();

      if (!tcConn) {
        setDevMode(true);
        setLoadedModels(DEV_LOADED_MODELS);
        setProjectIds(DEV_IDS);
        // Auto-select first model in dev mode
        setSelectedModel(DEV_LOADED_MODELS[0]);
        setLoadingModels(false);
        return;
      }

      setTc(tcConn);

      // MIDLERTIDIG DEBUG - slett etter testing
try {
  const all = await tcConn.api.viewer.getModels();
  console.log("ALL MODELS:", JSON.stringify(all));
  const loaded = await tcConn.api.viewer.getModels("loaded");
  console.log("LOADED MODELS:", JSON.stringify(loaded));
} catch(e) {
  console.log("getModels ERROR:", e.message);
}

// Get IFC models currently open in 3D viewer
const models = await getLoadedIfcModels(tcConn.api);

      // Get IFC models currently open in 3D viewer
      const models = await getLoadedIfcModels(tcConn.api);
      setLoadedModels(models);

      // Auto-suggest first loaded model
      if (models.length > 0) {
        setSelectedModel(models[0]);
      }

      setLoadingModels(false);
    })();
  }, []);

  const activeIfc = ifcTab === "upload" ? uploadedIfc : selectedModel;
  const activeIds = idsTab === "upload" ? uploadedIds : selectedIds;
  const canRun = activeIfc && activeIds;
  const canMark = !devMode && tc && selectedModel && ifcTab === "viewer";

  const handleMark = async (guids) => {
    if (!tc || !selectedModel) return { success: false, message: "Ingen modell valgt" };
    return await markObjectsInViewer(tc.api, selectedModel.modelId, guids);
  };

  const handleRun = async () => {
    setError(null);
    setResults(null);
    setIsRunning(true);

    try {
      let ifcFile, idsFile;
      const token = tc?.getAccessToken();

      setLoadingStep("Laster IFC-fil…");
      if (ifcTab === "upload") {
        ifcFile = uploadedIfc;
      } else if (!devMode && token && selectedModel?.fileId) {
        ifcFile = await downloadTCFile(token, selectedModel.fileId, selectedModel.name);
      } else {
        // Dev mode placeholder
        ifcFile = new File(["placeholder"], selectedModel?.name || "model.ifc");
      }

      setLoadingStep("Henter IDS-regelsett…");
      if (idsTab === "upload") {
        idsFile = uploadedIds;
      } else if (!devMode && token && selectedIds?.id) {
        idsFile = await downloadTCFile(token, selectedIds.id, selectedIds.name);
      } else {
        idsFile = new File(["placeholder"], selectedIds?.name || "rules.ids");
      }

      setLoadingStep("Validerer mot IDS-regler…");
      const form = new FormData();
      form.append("ifc_file", ifcFile);
      form.append("ids_file", idsFile);

      const res = await fetch(`${API_BASE}/validate`, { method: "POST", body: form });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.detail || `Server svarte med ${res.status}`);
      }
      setResults(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setIsRunning(false);
      setLoadingStep(null);
    }
  };

  const specs = results
    ? filterFailed ? results.specifications.filter((s) => s.status === "failed") : results.specifications
    : [];

  return (
    <div style={{ fontFamily: "'IBM Plex Sans', sans-serif", background: "#080f1a", minHeight: "100vh", color: "#e2e8f0", display: "flex", flexDirection: "column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0f172a; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
      `}</style>

      {/* Header */}
      <div style={{ padding: "14px 18px 12px", borderBottom: "1px solid #1e293b", display: "flex", alignItems: "center", gap: 10, background: "linear-gradient(180deg,#0d1b2e,#080f1a)" }}>
        <div style={{ width: 28, height: 28, borderRadius: 7, background: "linear-gradient(135deg,#6366f1,#0ea5e9)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2 4h10M2 7h6M2 10h8" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="11" cy="10" r="2.5" stroke="white" strokeWidth="1.2" />
            <path d="M10.2 10l.6.6 1.2-1.2" stroke="white" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9" }}>IDS Regelsjekker</div>
          <div style={{ fontSize: 10, color: "#475569" }}>
            {devMode ? "Utviklingsmodus" : "Trimble Connect 3D"}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Step 1 – IFC */}
        <section>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "#475569", textTransform: "uppercase", marginBottom: 8 }}>
            1 · IFC-fil
          </div>
          <TabBar
            value={ifcTab}
            onChange={setIfcTab}
            options={[["viewer", "Åpen i viewer"], ["upload", "Last opp"]]}
          />

          {ifcTab === "viewer" ? (
            loadingModels ? (
              <div style={{ fontSize: 11, color: "#475569", display: "flex", gap: 6, alignItems: "center" }}>
                <SpinnerIcon color="#6366f1" /> Henter modeller fra viewer…
              </div>
            ) : loadedModels.length === 0 ? (
              <div style={{ fontSize: 11, color: "#475569", padding: "10px 0", lineHeight: 1.6 }}>
                Ingen IFC-filer er lastet i 3D-vieweren.{"\n"}Åpne en modell i TC og prøv igjen, eller last opp manuelt.
              </div>
            ) : (
              <>
                {loadedModels.length === 1 && (
                  <div style={{ fontSize: 10, color: "#0ea5e9", marginBottom: 6 }}>
                    ✓ Fant modell åpen i viewer – foreslår å kjøre sjekk på denne
                  </div>
                )}
                {loadedModels.map((m) => (
                  <ModelRow
                    key={m.modelId}
                    model={m}
                    selected={selectedModel?.modelId === m.modelId}
                    onSelect={setSelectedModel}
                    badge={loadedModels.length === 1 ? "Aktiv i viewer" : null}
                  />
                ))}
              </>
            )
          ) : (
            <UploadZone file={uploadedIfc} onFile={setUploadedIfc} accept=".ifc" color="#0ea5e9" label=".ifc-fil" />
          )}
        </section>

        {/* Step 2 – IDS */}
        <section>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "#475569", textTransform: "uppercase", marginBottom: 8 }}>
            2 · IDS-regelsett
          </div>
          <TabBar
            value={idsTab}
            onChange={setIdsTab}
            options={[["upload", "Last opp"], ["project", "Fra prosjektet"]]}
          />
          {idsTab === "project" ? (
            projectIds.length === 0 ? (
              <div style={{ fontSize: 11, color: "#475569" }}>Ingen .ids-filer funnet i prosjektet.</div>
            ) : (
              projectIds.map((f) => (
                <FileRow key={f.id} file={f} selected={selectedIds?.id === f.id} onSelect={setSelectedIds} type="ids" />
              ))
            )
          ) : (
            <UploadZone file={uploadedIds} onFile={setUploadedIds} accept=".ids" color="#8b5cf6" label=".ids-fil" />
          )}
        </section>

        {/* Run button */}
        <button disabled={!canRun || isRunning} onClick={handleRun} style={{
          padding: "11px 0", borderRadius: 8, border: "none",
          cursor: canRun && !isRunning ? "pointer" : "not-allowed",
          background: canRun && !isRunning ? "linear-gradient(135deg,#6366f1,#0ea5e9)" : "#1e293b",
          color: canRun && !isRunning ? "white" : "#334155",
          fontFamily: "inherit", fontSize: 13, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          transition: "opacity 0.2s",
        }}>
          {isRunning ? <><SpinnerIcon /> {loadingStep}</> : "▶  Kjør IDS-sjekk"}
        </button>

        {/* Timer + info */}
        {isRunning && (
          <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: 14, animation: "fadeUp 0.3s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "#475569", textTransform: "uppercase" }}>Tid brukt</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <circle cx="6" cy="6" r="5" stroke="#6366f1" strokeWidth="1.2" />
                  <path d="M6 3.5V6l1.5 1.5" stroke="#6366f1" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
                <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: "#6366f1" }}>{timer}</div>
              </div>
            </div>
            <div style={{ borderTop: "1px solid #1e293b", paddingTop: 10, display: "flex", gap: 8, alignItems: "flex-start" }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
                <circle cx="7" cy="7" r="6" stroke="#b45309" strokeWidth="1.2" />
                <path d="M7 4.5V7" stroke="#b45309" strokeWidth="1.2" strokeLinecap="round" />
                <circle cx="7" cy="9.5" r="0.7" fill="#b45309" />
              </svg>
              <div style={{ fontSize: 11, color: "#92400e", lineHeight: 1.5 }}>
                Store IFC-filer kan ta <strong style={{ color: "#b45309" }}>1–3 minutter</strong>. Du kan fortsette å jobbe i TC mens sjekken kjører.
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ background: "#450a0a", border: "1px solid #dc2626", borderRadius: 8, padding: 12, fontSize: 12, color: "#fca5a5" }}>
            <strong>Feil:</strong> {error}
          </div>
        )}

        {/* Results */}
        {results && (
          <div style={{ animation: "fadeUp 0.4s ease" }}>
            {/* Summary */}
            <div style={{ background: "linear-gradient(135deg,#0d1b2e,#0f172a)", borderRadius: 10, padding: 14, marginBottom: 12, border: "1px solid #1e293b" }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "#475569", textTransform: "uppercase", marginBottom: 10 }}>Resultat</div>
              <div style={{ display: "flex", gap: 10 }}>
                {[["Bestått", results.summary.passed, "#16a34a"], ["Feilet", results.summary.failed, "#dc2626"], ["Totalt", results.summary.total, "#6366f1"]].map(([label, val, color]) => (
                  <div key={label} style={{ flex: 1, textAlign: "center", background: "#080f1a", borderRadius: 7, padding: "8px 4px" }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: "'IBM Plex Mono', monospace" }}>{val}</div>
                    <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: "#475569" }}>{activeIfc?.name}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#16a34a", fontFamily: "'IBM Plex Mono', monospace" }}>
                    {results.summary.total > 0 ? Math.round((results.summary.passed / results.summary.total) * 100) : 100}%
                  </span>
                </div>
                <div style={{ height: 4, background: "#1e293b", borderRadius: 2 }}>
                  <div style={{ height: "100%", borderRadius: 2, background: "linear-gradient(90deg,#16a34a,#22c55e)", width: `${results.summary.total > 0 ? Math.round((results.summary.passed / results.summary.total) * 100) : 100}%`, transition: "width 1s ease" }} />
                </div>
              </div>
            </div>

            {/* Filter + canMark info */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "#475569", textTransform: "uppercase" }}>
                Spesifikasjoner ({specs.length})
              </div>
              <button onClick={() => setFilterFailed(!filterFailed)} style={{
                fontSize: 10, padding: "3px 8px", borderRadius: 4, border: "none", cursor: "pointer",
                background: filterFailed ? "#dc262620" : "#1e293b",
                color: filterFailed ? "#ef4444" : "#64748b",
                fontFamily: "inherit", fontWeight: 600,
                outline: filterFailed ? "1px solid #dc262640" : "none",
              }}>
                {filterFailed ? "✕ Kun feil" : "Vis kun feil"}
              </button>
            </div>

            {canMark && (
              <div style={{ fontSize: 10, color: "#0ea5e9", marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
                <MarkIcon /> Klikk på en feilet regel for å markere objekter i viewer
              </div>
            )}

            {specs.map((spec, i) => (
              <SpecRow
                key={spec.name}
                spec={spec}
                index={i}
                onMark={canMark ? handleMark : null}
                canMark={canMark}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
