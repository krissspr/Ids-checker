import { useState, useEffect, useRef } from "react";

// ── Trimble Modus color tokens ────────────────────────────────────────────────
// Source: https://modus-v1.trimble.com/foundations/color-palette/
const M = {
  blue:        "#0063a3",  // Trimble Blue – primary actions
  blueDark:    "#0e416c",  // Blue Dark – header/nav
  blueLight:   "#217cbb",  // Blue Light – hover states
  bluePale:    "#dcedf9",  // Blue Pale – selected backgrounds
  yellow:      "#fbad26",  // Trimble Yellow – warning accent
  yellowDark:  "#e49325",  // Yellow Dark – warning color
  yellowPale:  "#fff5e4",  // Yellow Pale – warning background
  gray:        "#252a2e",  // Trimble Gray – primary text
  gray9:       "#353a40",
  gray8:       "#464b52",
  gray6:       "#6a6e79",  // Secondary text, default icon
  gray3:       "#a3a6b1",
  gray1:       "#cbcdd6",
  gray0:       "#e0e1e9",  // Borders
  grayLight:   "#f1f1f6",  // Panel background
  white:       "#ffffff",
  green:       "#1e8a44",  // Success
  greenDark:   "#006638",
  greenPale:   "#e0eccf",
  red:         "#da212c",  // Error / Danger
  redDark:     "#ab1f26",
  redPale:     "#fbd4d7",
};

const API_BASE = process.env.REACT_APP_API_URL || "https://ids-checker-api.railway.app";

// ── Debug logger – always visible in browser console ─────────────────────────
const log = {
  info:  (...a) => console.log( "%c[IDS]", "color:#0063a3;font-weight:bold", ...a),
  ok:    (...a) => console.log( "%c[IDS]", "color:#1e8a44;font-weight:bold", ...a),
  warn:  (...a) => console.warn("%c[IDS]", "color:#e49325;font-weight:bold", ...a),
  error: (...a) => console.error("%c[IDS]", "color:#da212c;font-weight:bold", ...a),
  group: (label) => console.group(`%c[IDS] ${label}`, "color:#0063a3;font-weight:bold"),
  end:   () => console.groupEnd(),
};

// ── TC connection ─────────────────────────────────────────────────────────────
async function connectToTC() {
  log.info("Connecting to TC Workspace API...");
  if (!window.parent || window.parent === window) {
    log.warn("Not running in iframe – entering dev mode");
    return null;
  }
  try {
    const WorkspaceAPI = await import("trimble-connect-workspace-api");
    log.info("WorkspaceAPI imported");
    let accessToken = null;

    const api = await WorkspaceAPI.connect(
      window.parent,
      (event, args) => {
        log.info(`TC event: ${event}`, args);
        if (event === "extension.accessToken") accessToken = args?.data;
      },
      10000
    );
    log.ok("Connected to TC API", api);

    const token = await api.extension.requestPermission("accesstoken");
    log.info("requestPermission result:", token);
    if (token && token !== "pending" && token !== "denied") accessToken = token;

    return { api, getAccessToken: () => accessToken };
  } catch (e) {
    log.error("TC connect failed:", e.message);
    return null;
  }
}

// ── Viewer model detection ────────────────────────────────────────────────────
async function detectLoadedModels(api) {
  log.group("detectLoadedModels");

  // Try every known method to find loaded models
  const results = { raw: null, loaded: null, error: null };

  try {
    // Call without filter first – log everything
    const all = await api.viewer.getModels();
    log.info("getModels() (no filter):", JSON.stringify(all));
    results.raw = all;

    // Try with "loaded" string filter
    try {
      const loaded = await api.viewer.getModels("loaded");
      log.info('getModels("loaded"):', JSON.stringify(loaded));
      results.loaded = loaded;
    } catch (e) {
      log.warn('getModels("loaded") failed:', e.message);
    }

    // For each model, try to get file details
    const models = results.loaded || results.raw || [];
    log.info(`Processing ${models.length} models...`);

    const ifcModels = [];
    for (const m of models) {
      log.info("Model entry:", JSON.stringify(m));
      // modelId may be in different fields – log all keys
      const modelId = m.modelId || m.id || m.fileId || m.versionId;
      log.info(`  → using modelId: ${modelId}`);

      if (!modelId) continue;

      try {
        const file = await api.viewer.getLoadedModel(modelId);
        log.info(`  getLoadedModel(${modelId}):`, JSON.stringify(file));

        if (file?.name?.toLowerCase().endsWith(".ifc")) {
          ifcModels.push({
            modelId,
            name: file.name,
            fileId: file.id,
            size: file.size,
            versionId: m.versionId,
          });
          log.ok(`  ✓ IFC model found: ${file.name} (fileId: ${file.id})`);
        } else {
          log.warn(`  Not an IFC file: ${file?.name}`);
        }
      } catch (e) {
        log.warn(`  getLoadedModel(${modelId}) failed:`, e.message);
      }
    }

    log.ok(`Found ${ifcModels.length} IFC models`);
    log.end();
    return ifcModels;

  } catch (e) {
    log.error("getModels() failed completely:", e.message);
    results.error = e.message;
    log.end();
    return [];
  }
}

// ── Mark objects in viewer ────────────────────────────────────────────────────
async function markObjectsInViewer(api, modelId, guids) {
  log.group(`markObjectsInViewer (${guids.length} guids)`);
  log.info("modelId:", modelId);
  log.info("guids:", guids);

  try {
    const runtimeIds = await api.viewer.convertToObjectRuntimeIds(modelId, guids);
    log.info("runtimeIds:", runtimeIds);

    const valid = runtimeIds.filter((id) => id != null);
    log.info(`Valid runtime IDs: ${valid.length}/${runtimeIds.length}`);

    if (valid.length === 0) {
      log.warn("No valid runtime IDs found");
      log.end();
      return { success: false, message: "Ingen objekter funnet i visningen" };
    }

    await api.viewer.setSelection(
      { modelObjectIds: [{ modelId, objectRuntimeIds: valid }] },
      "set"
    );
    log.ok("setSelection called");

    await api.viewer.setCamera(
      { modelObjectIds: [{ modelId, objectRuntimeIds: valid }] },
      { animationTime: 500 }
    );
    log.ok("setCamera called");

    log.end();
    return { success: true, count: valid.length };
  } catch (e) {
    log.error("markObjects failed:", e.message);
    log.end();
    return { success: false, message: e.message };
  }
}

// ── Mock data ─────────────────────────────────────────────────────────────────
const DEV_MODELS = [
  { modelId: "dev-1", name: "Arkitektur_K11.ifc", fileId: "file-1", size: 18400000 },
  { modelId: "dev-2", name: "RIB_konstruksjon.ifc", fileId: "file-2", size: 9100000 },
];
const DEV_IDS = [
  { id: "ids-a", name: "Byggherre_krav_v2.ids", versionDate: "2025-03-28" },
  { id: "ids-b", name: "LOD300_leveranse.ids", versionDate: "2025-02-15" },
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

// ── Icons ─────────────────────────────────────────────────────────────────────
const Icon = {
  Check: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7.5" fill={M.green} />
      <path d="M4.5 8l2.5 2.5 4.5-5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Fail: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7.5" fill={M.red} />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  File: ({ color }) => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 2.5A1 1 0 014 1.5h6l3.5 3.5V13.5a1 1 0 01-1 1H4a1 1 0 01-1-1V2.5z" stroke={color || M.gray6} strokeWidth="1.2" />
      <path d="M9.5 1.5v3.5H13" stroke={color || M.gray6} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  Chevron: ({ open }) => (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
      style={{ transform: open ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.18s" }}>
      <path d="M4 2l4 4-4 4" stroke={M.gray6} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Upload: ({ color }) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path d="M10 13V5M7 8l3-3 3 3" stroke={color || M.blue} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 16h12" stroke={color || M.blue} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Spinner: ({ color }) => (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" style={{ animation: "spin 0.9s linear infinite" }}>
      <circle cx="10" cy="10" r="8" stroke={M.gray1} strokeWidth="2.5" />
      <path d="M10 2a8 8 0 018 8" stroke={color || M.blue} strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  ),
  Viewer: () => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1" y="1" width="12" height="12" rx="2" stroke={M.blue} strokeWidth="1.2" />
      <path d="M4 7c0-1.66 1.34-3 3-3s3 1.34 3 3-1.34 3-3 3-3-1.34-3-3z" stroke={M.blue} strokeWidth="1.2" />
      <circle cx="7" cy="7" r="1" fill={M.blue} />
    </svg>
  ),
  Mark: () => (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.5 6l2 2 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Clock: () => (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <circle cx="6.5" cy="6.5" r="5.5" stroke={M.blue} strokeWidth="1.2" />
      <path d="M6.5 3.5V6.5l2 2" stroke={M.blue} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
};

// ── UI components ─────────────────────────────────────────────────────────────
function TabBar({ value, onChange, options }) {
  return (
    <div style={{ display: "flex", background: M.grayLight, borderRadius: 4, padding: 2, marginBottom: 8, border: `1px solid ${M.gray0}` }}>
      {options.map(([key, label]) => (
        <button key={key} onClick={() => onChange(key)} style={{
          flex: 1, padding: "5px 8px", fontSize: 11, fontWeight: 600,
          border: "none", cursor: "pointer", borderRadius: 3,
          fontFamily: "inherit", transition: "all 0.15s",
          background: value === key ? M.white : "transparent",
          color: value === key ? M.blue : M.gray6,
          boxShadow: value === key ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
        }}>{label}</button>
      ))}
    </div>
  );
}

function UploadZone({ file, onFile, accept, label }) {
  const color = accept === ".ifc" ? M.blue : "#7c3aed";
  return (
    <label style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
      border: `1.5px dashed ${file ? color : M.gray1}`,
      borderRadius: 4, padding: "18px 12px", cursor: "pointer",
      background: file ? `${color}08` : M.grayLight, transition: "all 0.15s",
    }}>
      <input type="file" accept={accept} style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
      <Icon.Upload color={file ? color : M.gray3} />
      {file
        ? <div style={{ fontSize: 12, color, fontWeight: 600, textAlign: "center" }}>{file.name}</div>
        : <div style={{ fontSize: 12, color: M.gray6, textAlign: "center", lineHeight: 1.5 }}>
            Dra <span style={{ color }}>{label}</span> hit<br />
            <span style={{ fontSize: 10, color: M.gray3 }}>eller klikk for å velge</span>
          </div>
      }
    </label>
  );
}

function ModelRow({ model, selected, onSelect, badge }) {
  return (
    <button onClick={() => onSelect(model)} style={{
      display: "flex", alignItems: "center", gap: 10, width: "100%",
      padding: "8px 10px", borderRadius: 4, border: `1px solid ${selected ? M.blue : M.gray0}`,
      cursor: "pointer", background: selected ? M.bluePale : M.white,
      transition: "all 0.15s", textAlign: "left", marginBottom: 4,
    }}>
      <Icon.File color={M.blue} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: M.gray, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {model.name}
        </div>
        {badge && (
          <span style={{ fontSize: 10, background: M.blue, color: M.white, borderRadius: 3, padding: "1px 5px", fontWeight: 600 }}>
            {badge}
          </span>
        )}
      </div>
      {selected && (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="6.5" fill={M.blue} />
          <path d="M4 7l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

function IdsFileRow({ file, selected, onSelect }) {
  const color = "#7c3aed";
  return (
    <button onClick={() => onSelect(file)} style={{
      display: "flex", alignItems: "center", gap: 10, width: "100%",
      padding: "8px 10px", borderRadius: 4, border: `1px solid ${selected ? color : M.gray0}`,
      cursor: "pointer", background: selected ? "#f3f0fe" : M.white,
      transition: "all 0.15s", textAlign: "left", marginBottom: 4,
    }}>
      <Icon.File color={color} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: M.gray, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {file.name}
        </div>
        {file.versionDate && <div style={{ fontSize: 10, color: M.gray6 }}>{file.versionDate}</div>}
      </div>
      {selected && (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="6.5" fill={color} />
          <path d="M4 7l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

// ── Spec row ──────────────────────────────────────────────────────────────────
function SpecRow({ spec, index, onMark, canMark }) {
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markResult, setMarkResult] = useState(null);
  const pct = spec.total > 0 ? Math.round((spec.passed / spec.total) * 100) : 100;
  const passed = spec.status === "passed";

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
      background: M.white, borderRadius: 4, overflow: "hidden",
      border: `1px solid ${passed ? M.greenPale : M.redPale}`,
      marginBottom: 4, animation: "fadeUp 0.25s ease both",
      animationDelay: `${index * 0.03}s`,
    }}>
      <button onClick={() => spec.failures?.length > 0 && setOpen(!open)} style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%",
        padding: "10px 12px", background: passed ? M.greenPale : M.redPale,
        border: "none", cursor: spec.failures?.length > 0 ? "pointer" : "default",
        textAlign: "left",
      }}>
        {passed ? <Icon.Check /> : <Icon.Fail />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: M.gray, marginBottom: 1 }}>{spec.name}</div>
          <div style={{ fontSize: 10, color: M.gray6, fontFamily: "monospace" }}>{spec.applicability}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0, marginRight: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: passed ? M.greenDark : M.redDark }}>
            {spec.passed}/{spec.total}
          </div>
          <div style={{ width: 44, height: 3, background: M.gray0, borderRadius: 2, marginTop: 3 }}>
            <div style={{ width: `${pct}%`, height: "100%", background: passed ? M.green : M.red, borderRadius: 2 }} />
          </div>
        </div>
        {spec.failures?.length > 0 && <Icon.Chevron open={open} />}
      </button>

      {open && spec.failures?.length > 0 && (
        <div style={{ padding: "10px 12px", background: M.white }}>
          <div style={{ fontSize: 10, color: M.gray6, marginBottom: 8, fontStyle: "italic" }}>
            Krav: {spec.requirement}
          </div>
          {spec.failures.map((f, i) => (
            <div key={i} style={{
              display: "flex", gap: 8, alignItems: "center", padding: "4px 0",
              borderBottom: i < spec.failures.length - 1 ? `1px solid ${M.grayLight}` : "none",
            }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: M.red, flexShrink: 0 }} />
              <div style={{ fontSize: 11, color: M.gray, flex: 1 }}>{f.name}</div>
              <div style={{ fontSize: 10, fontFamily: "monospace", color: M.gray6 }}>{f.type}</div>
            </div>
          ))}

          {spec.more_failures > 0 && (
            <div style={{ fontSize: 10, color: M.gray6, marginTop: 6 }}>
              + {spec.more_failures} flere feil ikke vist
            </div>
          )}

          {canMark && spec.failures.some((f) => f.guid) && (
            <button onClick={handleMark} disabled={marking} style={{
              width: "100%", marginTop: 10, padding: "7px 10px",
              borderRadius: 4, border: `1px solid ${M.red}`,
              background: marking ? M.redPale : M.white,
              color: M.redDark, fontFamily: "inherit", fontSize: 11, fontWeight: 600,
              cursor: marking ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              transition: "all 0.15s",
            }}>
              {marking
                ? <><Icon.Spinner color={M.red} /> Markerer…</>
                : <><Icon.Mark /> Marker {spec.failures.length} objekter i TC</>
              }
            </button>
          )}

          {markResult && (
            <div style={{
              marginTop: 6, padding: "6px 10px", borderRadius: 4, fontSize: 11,
              background: markResult.success ? M.greenPale : M.redPale,
              color: markResult.success ? M.greenDark : M.redDark,
              border: `1px solid ${markResult.success ? M.green : M.red}`,
            }}>
              {markResult.success
                ? `✓ ${markResult.count} objekter markert i 3D-visningen`
                : `✕ ${markResult.message}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function IDSChecker() {
  const [tc, setTc] = useState(null);
  const [devMode, setDevMode] = useState(false);

  const [loadedModels, setLoadedModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(null);
  const [uploadedIfc, setUploadedIfc] = useState(null);
  const [ifcTab, setIfcTab] = useState("viewer");
  const [loadingModels, setLoadingModels] = useState(true);

  const [projectIds, setProjectIds] = useState([]);
  const [selectedIds, setSelectedIds] = useState(null);
  const [uploadedIds, setUploadedIds] = useState(null);
  const [idsTab, setIdsTab] = useState("upload");

  const [isRunning, setIsRunning] = useState(false);
  const [loadingStep, setLoadingStep] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [filterFailed, setFilterFailed] = useState(false);

  const timer = useTimer(isRunning);

  useEffect(() => {
    (async () => {
      const tcConn = await connectToTC();

      if (!tcConn) {
        log.info("Dev mode – using mock data");
        setDevMode(true);
        setLoadedModels(DEV_MODELS);
        setSelectedModel(DEV_MODELS[0]);
        setProjectIds(DEV_IDS);
        setLoadingModels(false);
        return;
      }

      setTc(tcConn);

      const models = await detectLoadedModels(tcConn.api);
      setLoadedModels(models);
      if (models.length > 0) {
        setSelectedModel(models[0]);
        log.ok("Auto-selected model:", models[0].name);
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
    log.group("handleRun");

    try {
      const token = tc?.getAccessToken();
      const form = new FormData();

      // IDS file – always uploaded directly (small XML file, no size issues)
      log.info("idsTab:", idsTab);
      if (idsTab === "upload" && uploadedIds) {
        form.append("ids_file", uploadedIds);
        log.info("IDS: using uploaded file", uploadedIds.name);
      } else if (idsTab === "project" && selectedIds) {
        // For now append as file – could also pass file_id if needed
        form.append("ids_file", new File(["placeholder"], selectedIds.name));
        log.warn("IDS from project not yet implemented – using placeholder");
      }

      // IFC – pass fileId + token so backend downloads directly from TC
      log.info("ifcTab:", ifcTab, "selectedModel:", selectedModel);
      if (ifcTab === "viewer" && selectedModel && token && !devMode) {
        form.append("tc_file_id", selectedModel.fileId);
        form.append("tc_access_token", token);
        form.append("tc_region", "app"); // TODO: detect region dynamically
        log.info("IFC: backend will download from TC", selectedModel.fileId);
        setLoadingStep("Backend laster IFC fra TC…");
      } else if (ifcTab === "upload" && uploadedIfc) {
        form.append("ifc_file", uploadedIfc);
        log.info("IFC: using uploaded file", uploadedIfc.name);
        setLoadingStep("Laster opp IFC-fil…");
      } else {
        form.append("ifc_file", new File(["placeholder"], selectedModel?.name || "model.ifc"));
        log.warn("Dev mode – using placeholder IFC");
        setLoadingStep("Dev mode – placeholder IFC…");
      }

      setLoadingStep("Validerer mot IDS-regler…");
      log.info("Calling API:", `${API_BASE}/validate`);

      const res = await fetch(`${API_BASE}/validate`, { method: "POST", body: form });
      log.info("Response status:", res.status);

      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.detail || `Server svarte med ${res.status}`);
      }

      const data = await res.json();
      log.ok("Validation complete:", data.summary);
      setResults(data);
    } catch (e) {
      log.error("handleRun failed:", e.message);
      setError(e.message);
    } finally {
      setIsRunning(false);
      setLoadingStep(null);
      log.end();
    }
  };

  const specs = results
    ? filterFailed ? results.specifications.filter((s) => s.status === "failed") : results.specifications
    : [];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: "'Open Sans', 'Roboto', sans-serif", background: M.grayLight, minHeight: "100vh", color: M.gray, display: "flex", flexDirection: "column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${M.grayLight}; }
        ::-webkit-scrollbar-thumb { background: ${M.gray1}; border-radius: 3px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeUp { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
      `}</style>

      {/* Header – Trimble Blue Dark */}
      <div style={{ background: M.blueDark, padding: "0 16px", display: "flex", alignItems: "center", gap: 10, height: 48, flexShrink: 0 }}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M3 5h14M3 10h9M3 15h11" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="16" cy="14" r="3.5" stroke={M.yellow} strokeWidth="1.5" />
          <path d="M14.8 14l.9.9 1.8-1.8" stroke={M.yellow} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: M.white, letterSpacing: "0.01em" }}>IDS Regelsjekker</div>
          <div style={{ fontSize: 10, color: `${M.white}99` }}>
            {devMode ? "Utviklingsmodus" : "Trimble Connect 3D"}
          </div>
        </div>
        {devMode && (
          <span style={{ fontSize: 10, background: M.yellow, color: M.gray, borderRadius: 3, padding: "2px 6px", fontWeight: 700 }}>
            DEV
          </span>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Step 1 – IFC */}
        <section>
          <div style={{ fontSize: 10, fontWeight: 700, color: M.gray6, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
            1 · IFC-fil
          </div>
          <TabBar value={ifcTab} onChange={setIfcTab} options={[["viewer", "Åpen i viewer"], ["upload", "Last opp"]]} />

          {ifcTab === "viewer" ? (
            loadingModels ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 0", color: M.gray6, fontSize: 12 }}>
                <Icon.Spinner /> Henter modeller fra viewer…
              </div>
            ) : loadedModels.length === 0 ? (
              <div style={{ background: M.yellowPale, border: `1px solid ${M.yellow}`, borderRadius: 4, padding: 10, fontSize: 12, color: M.gray8 }}>
                <strong>Ingen IFC-modeller funnet i 3D-vieweren.</strong><br />
                Åpne en modell i TC og refresh, eller last opp manuelt.
              </div>
            ) : (
              <>
                {loadedModels.length === 1 && (
                  <div style={{ fontSize: 11, color: M.blue, marginBottom: 6, display: "flex", gap: 5, alignItems: "center" }}>
                    <Icon.Viewer /> Foreslår sjekk på modell åpen i viewer
                  </div>
                )}
                {loadedModels.map((m) => (
                  <ModelRow key={m.modelId} model={m} selected={selectedModel?.modelId === m.modelId} onSelect={setSelectedModel}
                    badge={loadedModels.length === 1 ? "Aktiv i viewer" : null} />
                ))}
              </>
            )
          ) : (
            <UploadZone file={uploadedIfc} onFile={setUploadedIfc} accept=".ifc" label=".ifc-fil" />
          )}
        </section>

        {/* Step 2 – IDS */}
        <section>
          <div style={{ fontSize: 10, fontWeight: 700, color: M.gray6, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
            2 · IDS-regelsett
          </div>
          <TabBar value={idsTab} onChange={setIdsTab} options={[["upload", "Last opp"], ["project", "Fra prosjektet"]]} />

          {idsTab === "project" ? (
            projectIds.length === 0
              ? <div style={{ fontSize: 12, color: M.gray6 }}>Ingen .ids-filer funnet i prosjektet.</div>
              : projectIds.map((f) => <IdsFileRow key={f.id} file={f} selected={selectedIds?.id === f.id} onSelect={setSelectedIds} />)
          ) : (
            <UploadZone file={uploadedIds} onFile={setUploadedIds} accept=".ids" label=".ids-fil" />
          )}
        </section>

        {/* Run button – Trimble Blue */}
        <button disabled={!canRun || isRunning} onClick={handleRun} style={{
          padding: "10px 0", borderRadius: 4, border: "none",
          cursor: canRun && !isRunning ? "pointer" : "not-allowed",
          background: canRun && !isRunning ? M.blue : M.gray1,
          color: canRun && !isRunning ? M.white : M.gray6,
          fontFamily: "inherit", fontSize: 13, fontWeight: 600,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          transition: "background 0.2s",
        }}>
          {isRunning ? <><Icon.Spinner color={M.white} /> {loadingStep}</> : "▶  Kjør IDS-sjekk"}
        </button>

        {/* Timer + info */}
        {isRunning && (
          <div style={{ background: M.white, border: `1px solid ${M.gray0}`, borderRadius: 4, padding: 12, animation: "fadeUp 0.3s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: M.gray6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Tid brukt</div>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <Icon.Clock />
                <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: M.blue }}>{timer}</div>
              </div>
            </div>
            <div style={{ borderTop: `1px solid ${M.grayLight}`, paddingTop: 8, display: "flex", gap: 8, alignItems: "flex-start" }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
                <circle cx="7" cy="7" r="6" stroke={M.yellowDark} strokeWidth="1.2" />
                <path d="M7 4.5V7" stroke={M.yellowDark} strokeWidth="1.2" strokeLinecap="round" />
                <circle cx="7" cy="9.5" r="0.7" fill={M.yellowDark} />
              </svg>
              <div style={{ fontSize: 11, color: M.gray8, lineHeight: 1.5 }}>
                Store IFC-filer kan ta <strong>1–3 minutter</strong>. Du kan jobbe videre i TC mens sjekken kjører.
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ background: M.redPale, border: `1px solid ${M.red}`, borderRadius: 4, padding: 12, fontSize: 12, color: M.redDark }}>
            <strong>Feil:</strong> {error}
          </div>
        )}

        {/* Results */}
        {results && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>

            {/* Summary card */}
            <div style={{ background: M.white, border: `1px solid ${M.gray0}`, borderRadius: 4, padding: 14, marginBottom: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: M.gray6, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                Resultat
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                {[
                  ["Bestått", results.summary.passed, M.green, M.greenPale],
                  ["Feilet", results.summary.failed, M.red, M.redPale],
                  ["Totalt", results.summary.total, M.blue, M.bluePale],
                ].map(([label, val, color, bg]) => (
                  <div key={label} style={{ flex: 1, textAlign: "center", background: bg, borderRadius: 4, padding: "10px 6px", border: `1px solid ${color}40` }}>
                    <div style={{ fontSize: 24, fontWeight: 700, color, fontFamily: "monospace", lineHeight: 1 }}>{val}</div>
                    <div style={{ fontSize: 10, color: M.gray6, marginTop: 3 }}>{label}</div>
                  </div>
                ))}
              </div>

              {/* Progress bar */}
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: M.gray6, marginBottom: 4 }}>
                <span>{activeIfc?.name}</span>
                <span style={{ color: M.greenDark, fontWeight: 700 }}>
                  {results.summary.total > 0 ? Math.round((results.summary.passed / results.summary.total) * 100) : 100}%
                </span>
              </div>
              <div style={{ height: 6, background: M.gray0, borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 3, background: M.green,
                  width: `${results.summary.total > 0 ? Math.round((results.summary.passed / results.summary.total) * 100) : 100}%`,
                  transition: "width 1s ease",
                }} />
              </div>
            </div>

            {/* Filter + list header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: M.gray6, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Spesifikasjoner ({specs.length})
              </div>
              <button onClick={() => setFilterFailed(!filterFailed)} style={{
                fontSize: 10, padding: "3px 8px", borderRadius: 3,
                border: `1px solid ${filterFailed ? M.red : M.gray1}`,
                background: filterFailed ? M.redPale : M.white,
                color: filterFailed ? M.redDark : M.gray6,
                cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
              }}>
                {filterFailed ? "✕ Kun feil" : "Vis kun feil"}
              </button>
            </div>

            {canMark && (
              <div style={{ fontSize: 11, color: M.blue, marginBottom: 8, display: "flex", gap: 5, alignItems: "center" }}>
                <Icon.Mark /> Klikk på en feilet regel for å markere objekter i viewer
              </div>
            )}

            {specs.map((spec, i) => (
              <SpecRow key={spec.name} spec={spec} index={i} onMark={canMark ? handleMark : null} canMark={canMark} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
