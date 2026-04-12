import { useState, useEffect, useRef } from "react";

// ── Trimble Modus colors ──────────────────────────────────────────────────────
const M = {
  blue:       "#0063a3",
  blueDark:   "#0e416c",
  blueLight:  "#217cbb",
  bluePale:   "#dcedf9",
  yellow:     "#fbad26",
  yellowDark: "#e49325",
  yellowPale: "#fff5e4",
  gray:       "#252a2e",
  gray9:      "#353a40",
  gray8:      "#464b52",
  gray6:      "#6a6e79",
  gray3:      "#a3a6b1",
  gray1:      "#cbcdd6",
  gray0:      "#e0e1e9",
  grayLight:  "#f1f1f6",
  white:      "#ffffff",
  green:      "#1e8a44",
  greenDark:  "#006638",
  greenPale:  "#e0eccf",
  red:        "#da212c",
  redDark:    "#ab1f26",
  redPale:    "#fbd4d7",
};

const API_BASE = process.env.REACT_APP_API_URL || "https://ids-checker-api.railway.app";

// ── Debug logger ──────────────────────────────────────────────────────────────
const log = {
  info:  (...a) => console.log( "%c[IDS]", "color:#0063a3;font-weight:bold", ...a),
  ok:    (...a) => console.log( "%c[IDS]", "color:#1e8a44;font-weight:bold", ...a),
  warn:  (...a) => console.warn("%c[IDS]", "color:#e49325;font-weight:bold", ...a),
  error: (...a) => console.error("%c[IDS]", "color:#da212c;font-weight:bold", ...a),
  group: (l)   => console.group(`%c[IDS] ${l}`, "color:#0063a3;font-weight:bold"),
  end:   ()    => console.groupEnd(),
};

// ── TC connection ─────────────────────────────────────────────────────────────
async function connectToTC() {
  log.info("Connecting to TC...");
  if (!window.parent || window.parent === window) {
    log.warn("Not in iframe – dev mode");
    return null;
  }
  try {
    const WorkspaceAPI = await import("trimble-connect-workspace-api");
    let accessToken = null;
    const api = await WorkspaceAPI.connect(window.parent, (event, args) => {
      log.info(`TC event: ${event}`, args);
      if (event === "extension.accessToken") accessToken = args?.data;
    }, 10000);
    log.ok("Connected", api);
    const token = await api.extension.requestPermission("accesstoken");
    log.info("Token result:", token);
    if (token && token !== "pending" && token !== "denied") accessToken = token;
    return { api, getAccessToken: () => accessToken };
  } catch (e) {
    log.error("TC connect failed:", e.message);
    return null;
  }
}

async function detectLoadedModels(api) {
  log.group("detectLoadedModels");
  try {
    const all = await api.viewer.getModels();
    log.info("getModels():", JSON.stringify(all));
    const loaded = await api.viewer.getModels("loaded").catch(() => null);
    log.info("getModels('loaded'):", JSON.stringify(loaded));
    const models = loaded || all || [];
    const ifcModels = [];
    for (const m of models) {
      log.info("Model entry:", JSON.stringify(m));
      const modelId = m.modelId || m.id || m.fileId;
      if (!modelId) continue;
      try {
        const file = await api.viewer.getLoadedModel(modelId);
        log.info(`getLoadedModel(${modelId}):`, JSON.stringify(file));
        if (file?.name?.toLowerCase().endsWith(".ifc")) {
          log.info("file object full:", JSON.stringify(file));
          ifcModels.push({ 
            modelId, 
            name: file.name, 
            fileId: file.id || file.fileId || file.versionId || modelId,
            size: file.size 
          });
          log.ok(`IFC found: ${file.name}`);
        }
      } catch (e) { log.warn(`getLoadedModel failed:`, e.message); }
    }
    log.ok(`${ifcModels.length} IFC models found`);
    log.end();
    return ifcModels;
  } catch (e) {
    log.error("detectLoadedModels failed:", e.message);
    log.end();
    return [];
  }
}

async function markObjectsInViewer(api, modelId, guids) {
  log.group(`markObjects (${guids.length})`);
  log.info("modelId:", modelId, "guids:", guids);
  try {
    const runtimeIds = await api.viewer.convertToObjectRuntimeIds(modelId, guids);
    log.info("runtimeIds:", runtimeIds);
    const valid = runtimeIds.filter(Boolean);
    if (!valid.length) { log.warn("No valid IDs"); log.end(); return { success: false, message: "Ingen objekter funnet i visningen" }; }
    await api.viewer.setSelection({ modelObjectIds: [{ modelId, objectRuntimeIds: valid }] }, "set");
    await api.viewer.setCamera({ modelObjectIds: [{ modelId, objectRuntimeIds: valid }] }, { animationTime: 500 });
    log.ok(`Marked ${valid.length} objects`);
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
];
const DEV_IDS = [
  { id: "ids-a", name: "Byggherre_krav_v2.ids", versionDate: "2025-03-28" },
];

// ── Timer hook ────────────────────────────────────────────────────────────────
function useTimer(running) {
  const [seconds, setSeconds] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    if (running) { setSeconds(0); ref.current = setInterval(() => setSeconds(s => s + 1), 1000); }
    else clearInterval(ref.current);
    return () => clearInterval(ref.current);
  }, [running]);
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

// ── Icons ─────────────────────────────────────────────────────────────────────
const Icon = {
  Check: () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7.5" fill={M.green}/><path d="M4.5 8l2.5 2.5 4.5-5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Fail:  () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7.5" fill={M.red}/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  File:  ({color}) => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2.5A1 1 0 014 1.5h6l3.5 3.5V13.5a1 1 0 01-1 1H4a1 1 0 01-1-1V2.5z" stroke={color||M.gray6} strokeWidth="1.2"/><path d="M9.5 1.5v3.5H13" stroke={color||M.gray6} strokeWidth="1.2" strokeLinecap="round"/></svg>,
  Chevron: ({open}) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{transform: open?"rotate(90deg)":"rotate(0)",transition:"transform 0.18s"}}><path d="M4 2l4 4-4 4" stroke={M.gray6} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Upload: ({color}) => <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 13V5M7 8l3-3 3 3" stroke={color||M.blue} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 16h12" stroke={color||M.blue} strokeWidth="1.5" strokeLinecap="round"/></svg>,
  Spinner: ({color}) => <svg width="16" height="16" viewBox="0 0 20 20" fill="none" style={{animation:"spin 0.9s linear infinite"}}><circle cx="10" cy="10" r="8" stroke={M.gray1} strokeWidth="2.5"/><path d="M10 2a8 8 0 018 8" stroke={color||M.blue} strokeWidth="2.5" strokeLinecap="round"/></svg>,
  Mark:   () => <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M3.5 6l2 2 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Edit:   () => <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2-7 7H1.5v-2l7-7z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Back:   () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7l5 5" stroke={M.blue} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Download: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v7M4 6l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  Clock:  () => <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5.5" stroke={M.blue} strokeWidth="1.2"/><path d="M6.5 3.5V6.5l2 2" stroke={M.blue} strokeWidth="1.2" strokeLinecap="round"/></svg>,
};

// ── Shared UI ─────────────────────────────────────────────────────────────────
function TabBar({ value, onChange, options }) {
  return (
    <div style={{ display:"flex", background:M.grayLight, borderRadius:4, padding:2, marginBottom:8, border:`1px solid ${M.gray0}` }}>
      {options.map(([key, label]) => (
        <button key={key} onClick={() => onChange(key)} style={{
          flex:1, padding:"5px 8px", fontSize:11, fontWeight:600,
          border:"none", cursor:"pointer", borderRadius:3, fontFamily:"inherit", transition:"all 0.15s",
          background: value===key ? M.white : "transparent",
          color: value===key ? M.blue : M.gray6,
          boxShadow: value===key ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
        }}>{label}</button>
      ))}
    </div>
  );
}

function UploadZone({ file, onFile, accept, label }) {
  const color = accept === ".ifc" ? M.blue : "#7c3aed";
  return (
    <label style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6, border:`1.5px dashed ${file?color:M.gray1}`, borderRadius:4, padding:"18px 12px", cursor:"pointer", background:file?`${color}08`:M.grayLight, transition:"all 0.15s" }}>
      <input type="file" accept={accept} style={{display:"none"}} onChange={e => { const f=e.target.files?.[0]; if(f) onFile(f); }}/>
      <Icon.Upload color={file?color:M.gray3}/>
      {file
        ? <div style={{fontSize:12,color,fontWeight:600,textAlign:"center"}}>{file.name}</div>
        : <div style={{fontSize:12,color:M.gray6,textAlign:"center",lineHeight:1.5}}>Dra <span style={{color}}>{label}</span> hit<br/><span style={{fontSize:10,color:M.gray3}}>eller klikk for å velge</span></div>
      }
    </label>
  );
}

function ModelRow({ model, selected, onSelect, badge }) {
  return (
    <button onClick={() => onSelect(model)} style={{ display:"flex", alignItems:"center", gap:10, width:"100%", padding:"8px 10px", borderRadius:4, border:`1px solid ${selected?M.blue:M.gray0}`, cursor:"pointer", background:selected?M.bluePale:M.white, transition:"all 0.15s", textAlign:"left", marginBottom:4 }}>
      <Icon.File color={M.blue}/>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:12,fontWeight:500,color:M.gray,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{model.name}</div>
        {badge && <span style={{fontSize:10,background:M.blue,color:M.white,borderRadius:3,padding:"1px 5px",fontWeight:600}}>{badge}</span>}
      </div>
      {selected && <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.5" fill={M.blue}/><path d="M4 7l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
    </button>
  );
}

function IdsRow({ file, selected, onSelect }) {
  const color = "#7c3aed";
  return (
    <button onClick={() => onSelect(file)} style={{ display:"flex", alignItems:"center", gap:10, width:"100%", padding:"8px 10px", borderRadius:4, border:`1px solid ${selected?color:M.gray0}`, cursor:"pointer", background:selected?"#f3f0fe":M.white, transition:"all 0.15s", textAlign:"left", marginBottom:4 }}>
      <Icon.File color={color}/>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:12,fontWeight:500,color:M.gray,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{file.name}</div>
        {file.versionDate && <div style={{fontSize:10,color:M.gray6}}>{file.versionDate}</div>}
      </div>
      {selected && <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.5" fill={color}/><path d="M4 7l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
    </button>
  );
}

// ── Property Editor Page ──────────────────────────────────────────────────────
function PropertyEditor({ spec, model, tc, devMode, onBack }) {
  // Parse which pset + property is required from the spec
  // requirement example: "Pset_WallCommon.FireRating er påkrevd"
  const parseRequirement = () => {
    const req = spec.requirement || "";
    const match = req.match(/^([^.]+)\.([^\s=]+)/);
    if (match) return { pset: match[1], prop: match[2] };
    return { pset: "", prop: "" };
  };

  const { pset: defaultPset, prop: defaultProp } = parseRequirement();

  const [psetName, setPsetName] = useState(defaultPset);
  const [propName, setPropName] = useState(defaultProp);
  const [propValue, setPropValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  // Upload destination
  const [uploadMode, setUploadMode] = useState("download"); // "download" | "tc"
  const [tcFolderId, setTcFolderId] = useState("");
  const [outputFilename, setOutputFilename] = useState(
    model?.name?.replace(".ifc", "_korrigert.ifc") || "korrigert_modell.ifc"
  );

  const failedGuids = spec.failures.map(f => f.guid).filter(Boolean);

  log.info("PropertyEditor opened for spec:", spec.name);
  log.info("Parsed pset:", defaultPset, "prop:", defaultProp);
  log.info("Failed GUIDs:", failedGuids);
  log.info("model:", model);

  const handleSave = async () => {
    if (!propValue.trim()) return;
    setSaving(true);
    setSaveResult(null);
    log.group("handleSave properties");
    log.info("pset:", psetName, "prop:", propName, "value:", propValue);
    log.info("uploadMode:", uploadMode, "fileId:", model?.fileId);

    try {
      const token = tc?.getAccessToken();
      const project = await tc?.api?.project?.getCurrentProject();
      log.info("project:", project);

      const form = new FormData();
      form.append("tc_file_id", model?.fileId || "");
      form.append("tc_access_token", token || "");
      const region = project?.location === "europe" ? "app.eu" : "app";
      form.append("tc_region", region);
      log.info("TC region:", region);
      form.append("tc_project_id", project?.id || "");
      form.append("tc_folder_id", tcFolderId || "");
      form.append("upload_to_project", uploadMode === "tc" ? "true" : "false");
      form.append("pset_name", psetName);
      form.append("prop_name", propName);
      form.append("prop_value", propValue);
      form.append("guids", JSON.stringify(failedGuids));
      form.append("output_filename", outputFilename);

      const res = await fetch(`${API_BASE}/update-properties`, { method: "POST", body: form });
      log.info("Response status:", res.status);
      log.info("Content-Type:", res.headers.get("content-type"));

      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.detail || `Server svarte med ${res.status}`);
      }

      const contentType = res.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        // Uploaded to TC
        const data = await res.json();
        log.ok("Uploaded to TC:", data);
        setSaveResult({ success: true, count: failedGuids.length, uploadedToTC: true, tcFile: data.tc_file });
      } else {
        // File download
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = outputFilename;
        a.click();
        URL.revokeObjectURL(url);
        log.ok("Download triggered");
        setSaveResult({ success: true, count: failedGuids.length, uploadedToTC: false });
      }
    } catch (e) {
      log.error("handleSave failed:", e.message);
      setSaveResult({ success: false, message: e.message });
    } finally {
      setSaving(false);
      log.end();
    }
  };

  return (
    <div style={{ flex:1, overflow:"auto", display:"flex", flexDirection:"column" }}>

      {/* Sub-header */}
      <div style={{ padding:"10px 14px", borderBottom:`1px solid ${M.gray0}`, background:M.white, display:"flex", alignItems:"center", gap:10 }}>
        <button onClick={onBack} style={{ display:"flex", alignItems:"center", gap:4, background:"none", border:"none", cursor:"pointer", color:M.blue, fontSize:12, fontWeight:600, padding:0, fontFamily:"inherit" }}>
          <Icon.Back /> Tilbake
        </button>
        <div style={{ width:1, height:16, background:M.gray1 }}/>
        <div style={{ fontSize:12, fontWeight:600, color:M.gray, flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          Oppdater egenskaper
        </div>
      </div>

      <div style={{ padding:14, display:"flex", flexDirection:"column", gap:14, flex:1, overflow:"auto" }}>

        {/* Rule info */}
        <div style={{ background:M.redPale, border:`1px solid ${M.redDark}40`, borderRadius:4, padding:12 }}>
          <div style={{ fontSize:10, fontWeight:700, color:M.redDark, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>
            Feilet regel
          </div>
          <div style={{ fontSize:13, fontWeight:600, color:M.gray, marginBottom:4 }}>{spec.name}</div>
          <div style={{ fontSize:11, color:M.gray8 }}>
            <span style={{ fontFamily:"monospace", background:M.redPale, padding:"1px 4px", borderRadius:2 }}>{spec.applicability}</span>
            {" · "}{spec.failed} objekt{spec.failed !== 1 ? "er" : ""} feiler
          </div>
        </div>

        {/* Failing objects list */}
        <div>
          <div style={{ fontSize:10, fontWeight:700, color:M.gray6, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:8 }}>
            Objekter som feiler ({spec.failures.length})
          </div>
          <div style={{ background:M.white, border:`1px solid ${M.gray0}`, borderRadius:4, overflow:"hidden", maxHeight:160, overflowY:"auto" }}>
            {spec.failures.map((f, i) => (
              <div key={i} style={{ display:"flex", gap:8, alignItems:"center", padding:"7px 10px", borderBottom: i < spec.failures.length-1 ? `1px solid ${M.grayLight}` : "none" }}>
                <div style={{ width:5, height:5, borderRadius:"50%", background:M.red, flexShrink:0 }}/>
                <div style={{ fontSize:11, color:M.gray, flex:1 }}>{f.name}</div>
                <div style={{ fontSize:10, fontFamily:"monospace", color:M.gray6 }}>{f.type}</div>
              </div>
            ))}
            {spec.more_failures > 0 && (
              <div style={{ padding:"6px 10px", fontSize:10, color:M.gray6, background:M.grayLight }}>
                + {spec.more_failures} flere ikke vist
              </div>
            )}
          </div>
        </div>

        {/* Property inputs */}
        <div>
          <div style={{ fontSize:10, fontWeight:700, color:M.gray6, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:10 }}>
            Ny egenskap
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

            {/* Pset name */}
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:M.gray8, display:"block", marginBottom:4 }}>
                Egenskapssett (Pset)
              </label>
              <input
                value={psetName}
                onChange={e => setPsetName(e.target.value)}
                placeholder="f.eks. Pset_WallCommon"
                style={{ width:"100%", padding:"8px 10px", fontSize:12, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"monospace", color:M.gray, outline:"none", background:M.white }}
                onFocus={e => e.target.style.borderColor = M.blue}
                onBlur={e => e.target.style.borderColor = M.gray1}
              />
            </div>

            {/* Property name */}
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:M.gray8, display:"block", marginBottom:4 }}>
                Egenskapsnavn
              </label>
              <input
                value={propName}
                onChange={e => setPropName(e.target.value)}
                placeholder="f.eks. FireRating"
                style={{ width:"100%", padding:"8px 10px", fontSize:12, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"monospace", color:M.gray, outline:"none", background:M.white }}
                onFocus={e => e.target.style.borderColor = M.blue}
                onBlur={e => e.target.style.borderColor = M.gray1}
              />
            </div>

            {/* Property value */}
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:M.gray8, display:"block", marginBottom:4 }}>
                Verdi
              </label>
              <input
                value={propValue}
                onChange={e => setPropValue(e.target.value)}
                placeholder="f.eks. REI60"
                style={{ width:"100%", padding:"8px 10px", fontSize:12, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"inherit", color:M.gray, outline:"none", background:M.white }}
                onFocus={e => e.target.style.borderColor = M.blue}
                onBlur={e => e.target.style.borderColor = M.gray1}
              />
            </div>
          </div>
        </div>

        {/* Preview */}
        {psetName && propName && propValue && (
          <div style={{ background:M.bluePale, border:`1px solid ${M.blue}40`, borderRadius:4, padding:10 }}>
            <div style={{ fontSize:10, fontWeight:700, color:M.blue, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:6 }}>
              Forhåndsvisning
            </div>
            <div style={{ fontSize:11, color:M.gray8, lineHeight:1.6 }}>
              Setter <span style={{ fontFamily:"monospace", background:M.white, padding:"1px 4px", borderRadius:2, color:M.blue }}>{psetName}.{propName}</span> = <span style={{ fontFamily:"monospace", background:M.white, padding:"1px 4px", borderRadius:2, color:M.greenDark }}>{propValue}</span><br/>
              på <strong>{failedGuids.length} objekter</strong> i <span style={{ fontFamily:"monospace" }}>{model?.name}</span>
            </div>
          </div>
        )}

        {/* Output filename */}
        <div>
          <label style={{ fontSize:11, fontWeight:600, color:M.gray8, display:"block", marginBottom:4 }}>
            Filnavn på korrigert fil
          </label>
          <input
            value={outputFilename}
            onChange={e => setOutputFilename(e.target.value)}
            style={{ width:"100%", padding:"8px 10px", fontSize:12, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"monospace", color:M.gray, outline:"none", background:M.white }}
            onFocus={e => e.target.style.borderColor = M.blue}
            onBlur={e => e.target.style.borderColor = M.gray1}
          />
        </div>

        {/* Destination */}
        <div>
          <div style={{ fontSize:11, fontWeight:600, color:M.gray8, marginBottom:8 }}>Lagre til</div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>

            <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", padding:"8px 10px", borderRadius:4, border:`1px solid ${uploadMode==="download"?M.blue:M.gray0}`, background:uploadMode==="download"?M.bluePale:M.white }}>
              <input type="radio" name="uploadMode" value="download" checked={uploadMode==="download"} onChange={() => setUploadMode("download")} style={{ accentColor:M.blue }}/>
              <div>
                <div style={{ fontSize:12, fontWeight:600, color:M.gray }}>Last ned til PC</div>
                <div style={{ fontSize:10, color:M.gray6 }}>Fil lastes ned til din nedlastingsmappe</div>
              </div>
            </label>

            <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", padding:"8px 10px", borderRadius:4, border:`1px solid ${uploadMode==="tc"?M.blue:M.gray0}`, background:uploadMode==="tc"?M.bluePale:M.white }}>
              <input type="radio" name="uploadMode" value="tc" checked={uploadMode==="tc"} onChange={() => setUploadMode("tc")} style={{ accentColor:M.blue }}/>
              <div>
                <div style={{ fontSize:12, fontWeight:600, color:M.gray }}>Last opp til TC-prosjektet</div>
                <div style={{ fontSize:10, color:M.gray6 }}>Filen lastes opp direkte til prosjektet</div>
              </div>
            </label>
          </div>

          {uploadMode === "tc" && (
            <div style={{ marginTop:8 }}>
              <label style={{ fontSize:11, fontWeight:600, color:M.gray8, display:"block", marginBottom:4 }}>
                Mappe-ID i TC <span style={{ fontWeight:400, color:M.gray6 }}>(valgfritt – tomt = rotmappen)</span>
              </label>
              <input
                value={tcFolderId}
                onChange={e => setTcFolderId(e.target.value)}
                placeholder="f.eks. folder-abc123"
                style={{ width:"100%", padding:"8px 10px", fontSize:12, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"monospace", color:M.gray, outline:"none", background:M.white }}
                onFocus={e => e.target.style.borderColor = M.blue}
                onBlur={e => e.target.style.borderColor = M.gray1}
              />
              <div style={{ fontSize:10, color:M.gray6, marginTop:4 }}>
                Mappe-ID finner du i TC URL-en når du åpner en mappe: /folders/<strong>FOLDER-ID</strong>
              </div>
            </div>
          )}
        </div>

        {/* Save button */}
        <button
          disabled={!propValue.trim() || saving}
          onClick={handleSave}
          style={{
            padding:"10px 0", borderRadius:4, border:"none",
            cursor: propValue.trim() && !saving ? "pointer" : "not-allowed",
            background: propValue.trim() && !saving ? M.blue : M.gray1,
            color: propValue.trim() && !saving ? M.white : M.gray6,
            fontFamily:"inherit", fontSize:13, fontWeight:600,
            display:"flex", alignItems:"center", justifyContent:"center", gap:8,
            transition:"background 0.2s",
          }}
        >
          {saving
            ? <><Icon.Spinner color={M.white}/> {uploadMode === "tc" ? "Laster opp til TC…" : "Genererer korrigert IFC…"}</>
            : uploadMode === "tc"
              ? <><Icon.Upload color={M.white}/> Last opp korrigert IFC til TC</>
              : <><Icon.Download/> Last ned korrigert IFC</>
          }
        </button>

        {/* Result */}
        {saveResult && (
          <div style={{ padding:"10px 12px", borderRadius:4, fontSize:12, border:`1px solid ${saveResult.success?M.green:M.red}`, background:saveResult.success?M.greenPale:M.redPale, color:saveResult.success?M.greenDark:M.redDark, lineHeight:1.6 }}>
            {saveResult.success
              ? saveResult.uploadedToTC
                ? <><strong>✓ Lastet opp til TC!</strong><br/>{saveResult.count} objekter oppdatert. Filen er nå tilgjengelig i prosjektet.</>
                : <>✓ Korrigert IFC lastet ned – {saveResult.count} objekter oppdatert</>
              : `✕ ${saveResult.message}`
            }
          </div>
        )}
      </div>
    </div>
  );
}

// ── Spec row ──────────────────────────────────────────────────────────────────
function SpecRow({ spec, index, onMark, canMark, onEditProps }) {
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markResult, setMarkResult] = useState(null);
  const pct = spec.total > 0 ? Math.round((spec.passed / spec.total) * 100) : 100;
  const passed = spec.status === "passed";

  const handleMark = async () => {
    if (!onMark || marking) return;
    setMarking(true);
    setMarkResult(null);
    const guids = spec.failures.map(f => f.guid).filter(Boolean);
    const result = await onMark(guids);
    setMarkResult(result);
    setMarking(false);
  };

  return (
    <div style={{ background:M.white, borderRadius:4, overflow:"hidden", border:`1px solid ${passed?M.greenPale:M.redPale}`, marginBottom:4, animation:"fadeUp 0.25s ease both", animationDelay:`${index*0.03}s` }}>

      <button onClick={() => spec.failures?.length > 0 && setOpen(!open)} style={{ display:"flex", alignItems:"center", gap:10, width:"100%", padding:"10px 12px", background:passed?M.greenPale:M.redPale, border:"none", cursor:spec.failures?.length>0?"pointer":"default", textAlign:"left" }}>
        {passed ? <Icon.Check/> : <Icon.Fail/>}
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:12,fontWeight:600,color:M.gray,marginBottom:1}}>{spec.name}</div>
          <div style={{fontSize:10,color:M.gray6,fontFamily:"monospace"}}>{spec.applicability}</div>
        </div>
        <div style={{textAlign:"right",flexShrink:0,marginRight:4}}>
          <div style={{fontSize:11,fontWeight:700,color:passed?M.greenDark:M.redDark}}>{spec.passed}/{spec.total}</div>
          <div style={{width:44,height:3,background:M.gray0,borderRadius:2,marginTop:3}}>
            <div style={{width:`${pct}%`,height:"100%",background:passed?M.green:M.red,borderRadius:2}}/>
          </div>
        </div>
        {spec.failures?.length > 0 && <Icon.Chevron open={open}/>}
      </button>

      {open && spec.failures?.length > 0 && (
        <div style={{padding:"10px 12px",background:M.white}}>
          <div style={{fontSize:10,color:M.gray6,marginBottom:8,fontStyle:"italic"}}>Krav: {spec.requirement}</div>

          {spec.failures.map((f, i) => (
            <div key={i} style={{ display:"flex", gap:8, alignItems:"center", padding:"4px 0", borderBottom:i<spec.failures.length-1?`1px solid ${M.grayLight}`:"none" }}>
              <div style={{width:5,height:5,borderRadius:"50%",background:M.red,flexShrink:0}}/>
              <div style={{fontSize:11,color:M.gray,flex:1}}>{f.name}</div>
              <div style={{fontSize:10,fontFamily:"monospace",color:M.gray6}}>{f.type}</div>
            </div>
          ))}

          {spec.more_failures > 0 && (
            <div style={{fontSize:10,color:M.gray6,marginTop:6}}>+ {spec.more_failures} flere ikke vist</div>
          )}

          {/* Action buttons */}
          <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:10}}>

            {/* Mark in TC */}
            {canMark && spec.failures.some(f => f.guid) && (
              <button onClick={handleMark} disabled={marking} style={{ padding:"7px 10px", borderRadius:4, border:`1px solid ${M.blue}`, background:marking?M.bluePale:M.white, color:M.blueDark, fontFamily:"inherit", fontSize:11, fontWeight:600, cursor:marking?"not-allowed":"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6, transition:"all 0.15s" }}>
                {marking ? <><Icon.Spinner color={M.blue}/> Markerer…</> : <><Icon.Mark/> Marker {spec.failures.length} objekter i TC</>}
              </button>
            )}

            {/* Edit properties */}
            {!passed && (
              <button onClick={() => onEditProps(spec)} style={{ padding:"7px 10px", borderRadius:4, border:`1px solid ${M.yellowDark}`, background:M.yellowPale, color:M.gray9, fontFamily:"inherit", fontSize:11, fontWeight:600, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6, transition:"all 0.15s" }}>
                <Icon.Edit/> Oppdater egenskaper
              </button>
            )}
          </div>

          {markResult && (
            <div style={{ marginTop:8, padding:"6px 10px", borderRadius:4, fontSize:11, background:markResult.success?M.greenPale:M.redPale, color:markResult.success?M.greenDark:M.redDark, border:`1px solid ${markResult.success?M.green:M.red}` }}>
              {markResult.success ? `✓ ${markResult.count} objekter markert i 3D-visningen` : `✕ ${markResult.message}`}
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

  // Property editor state
  const [editingSpec, setEditingSpec] = useState(null); // null = main view

  const timer = useTimer(isRunning);

  useEffect(() => {
    (async () => {
      const tcConn = await connectToTC();
      if (!tcConn) {
        log.info("Dev mode");
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
      if (models.length > 0) setSelectedModel(models[0]);
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

      if (idsTab === "upload" && uploadedIds) {
        form.append("ids_file", uploadedIds);
      } else {
        form.append("ids_file", new File(["placeholder"], selectedIds?.name || "rules.ids"));
        log.warn("IDS placeholder");
      }

      if (ifcTab === "viewer" && selectedModel && token && !devMode) {
        form.append("tc_file_id", selectedModel.fileId);
        form.append("tc_access_token", token);
        form.append("tc_region", "app");
        setLoadingStep("Backend laster IFC fra TC…");
        log.info("IFC via backend, fileId:", selectedModel.fileId);
      } else if (ifcTab === "upload" && uploadedIfc) {
        form.append("ifc_file", uploadedIfc);
        setLoadingStep("Laster opp IFC-fil…");
        log.info("IFC upload:", uploadedIfc.name);
      } else {
        form.append("ifc_file", new File(["placeholder"], selectedModel?.name || "model.ifc"));
        log.warn("Dev IFC placeholder");
        setLoadingStep("Dev modus…");
      }

      setLoadingStep("Validerer mot IDS-regler…");
      const res = await fetch(`${API_BASE}/validate`, { method: "POST", body: form });
      log.info("Response:", res.status);
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.detail || `Server svarte med ${res.status}`);
      }
      const data = await res.json();
      log.ok("Done:", data.summary);
      setResults(data);
    } catch (e) {
      log.error("Run failed:", e.message);
      setError(e.message);
    } finally {
      setIsRunning(false);
      setLoadingStep(null);
      log.end();
    }
  };

  const specs = results
    ? filterFailed ? results.specifications.filter(s => s.status === "failed") : results.specifications
    : [];

  // ── Header (always visible) ───────────────────────────────────────────────
  const header = (
    <div style={{ background:M.blueDark, padding:"0 16px", display:"flex", alignItems:"center", gap:10, height:48, flexShrink:0 }}>
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M3 5h14M3 10h9M3 15h11" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
        <circle cx="16" cy="14" r="3.5" stroke={M.yellow} strokeWidth="1.5"/>
        <path d="M14.8 14l.9.9 1.8-1.8" stroke={M.yellow} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      <div style={{flex:1}}>
        <div style={{fontSize:13,fontWeight:700,color:M.white}}>IDS Regelsjekker</div>
        <div style={{fontSize:10,color:`${M.white}99`}}>
          {editingSpec ? `Redigerer: ${editingSpec.name}` : devMode ? "Utviklingsmodus" : "Trimble Connect 3D"}
        </div>
      </div>
      {devMode && <span style={{fontSize:10,background:M.yellow,color:M.gray,borderRadius:3,padding:"2px 6px",fontWeight:700}}>DEV</span>}
    </div>
  );

  // ── Property editor view ──────────────────────────────────────────────────
  if (editingSpec) {
    return (
      <div style={{ fontFamily:"'Open Sans','Roboto',sans-serif", background:M.grayLight, minHeight:"100vh", color:M.gray, display:"flex", flexDirection:"column" }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;500;600;700&display=swap');
          * { box-sizing:border-box; margin:0; padding:0; }
          ::-webkit-scrollbar{width:6px} ::-webkit-scrollbar-track{background:${M.grayLight}} ::-webkit-scrollbar-thumb{background:${M.gray1};border-radius:3px}
          @keyframes spin{to{transform:rotate(360deg)}}
          @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        `}</style>
        {header}
        <PropertyEditor
          spec={editingSpec}
          model={selectedModel}
          tc={tc}
          devMode={devMode}
          onBack={() => setEditingSpec(null)}
        />
      </div>
    );
  }

  // ── Main view ─────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily:"'Open Sans','Roboto',sans-serif", background:M.grayLight, minHeight:"100vh", color:M.gray, display:"flex", flexDirection:"column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;500;600;700&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar{width:6px} ::-webkit-scrollbar-track{background:${M.grayLight}} ::-webkit-scrollbar-thumb{background:${M.gray1};border-radius:3px}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      `}</style>
      {header}

      <div style={{ flex:1, overflow:"auto", padding:14, display:"flex", flexDirection:"column", gap:14 }}>

        {/* Step 1 – IFC */}
        <section>
          <div style={{fontSize:10,fontWeight:700,color:M.gray6,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>1 · IFC-fil</div>
          <TabBar value={ifcTab} onChange={setIfcTab} options={[["viewer","Åpen i viewer"],["upload","Last opp"]]}/>
          {ifcTab === "viewer" ? (
            loadingModels
              ? <div style={{display:"flex",gap:8,alignItems:"center",padding:"10px 0",color:M.gray6,fontSize:12}}><Icon.Spinner/> Henter modeller…</div>
              : loadedModels.length === 0
                ? <div style={{background:M.yellowPale,border:`1px solid ${M.yellow}`,borderRadius:4,padding:10,fontSize:12,color:M.gray8}}><strong>Ingen IFC-modeller i viewer.</strong><br/>Åpne en modell i TC eller last opp manuelt.</div>
                : <>
                    {loadedModels.length === 1 && <div style={{fontSize:11,color:M.blue,marginBottom:6}}>✓ Foreslår sjekk på modell åpen i viewer</div>}
                    {loadedModels.map(m => <ModelRow key={m.modelId} model={m} selected={selectedModel?.modelId===m.modelId} onSelect={setSelectedModel} badge={loadedModels.length===1?"Aktiv i viewer":null}/>)}
                  </>
          ) : (
            <UploadZone file={uploadedIfc} onFile={setUploadedIfc} accept=".ifc" label=".ifc-fil"/>
          )}
        </section>

        {/* Step 2 – IDS */}
        <section>
          <div style={{fontSize:10,fontWeight:700,color:M.gray6,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>2 · IDS-regelsett</div>
          <TabBar value={idsTab} onChange={setIdsTab} options={[["upload","Last opp"],["project","Fra prosjektet"]]}/>
          {idsTab === "project"
            ? projectIds.length === 0
              ? <div style={{fontSize:12,color:M.gray6}}>Ingen .ids-filer funnet.</div>
              : projectIds.map(f => <IdsRow key={f.id} file={f} selected={selectedIds?.id===f.id} onSelect={setSelectedIds}/>)
            : <UploadZone file={uploadedIds} onFile={setUploadedIds} accept=".ids" label=".ids-fil"/>
          }
        </section>

        {/* Run button */}
        <button disabled={!canRun||isRunning} onClick={handleRun} style={{ padding:"10px 0", borderRadius:4, border:"none", cursor:canRun&&!isRunning?"pointer":"not-allowed", background:canRun&&!isRunning?M.blue:M.gray1, color:canRun&&!isRunning?M.white:M.gray6, fontFamily:"inherit", fontSize:13, fontWeight:600, display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"background 0.2s" }}>
          {isRunning ? <><Icon.Spinner color={M.white}/> {loadingStep}</> : "▶  Kjør IDS-sjekk"}
        </button>

        {/* Timer */}
        {isRunning && (
          <div style={{background:M.white,border:`1px solid ${M.gray0}`,borderRadius:4,padding:12,animation:"fadeUp 0.3s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:600,color:M.gray6,textTransform:"uppercase",letterSpacing:"0.06em"}}>Tid brukt</div>
              <div style={{display:"flex",alignItems:"center",gap:5}}><Icon.Clock/><div style={{fontSize:16,fontWeight:700,fontFamily:"monospace",color:M.blue}}>{timer}</div></div>
            </div>
            <div style={{borderTop:`1px solid ${M.grayLight}`,paddingTop:8,display:"flex",gap:8,alignItems:"flex-start"}}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{flexShrink:0,marginTop:1}}><circle cx="7" cy="7" r="6" stroke={M.yellowDark} strokeWidth="1.2"/><path d="M7 4.5V7" stroke={M.yellowDark} strokeWidth="1.2" strokeLinecap="round"/><circle cx="7" cy="9.5" r="0.7" fill={M.yellowDark}/></svg>
              <div style={{fontSize:11,color:M.gray8,lineHeight:1.5}}>Store IFC-filer kan ta <strong>1–3 minutter</strong>. Du kan jobbe videre i TC mens sjekken kjører.</div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{background:M.redPale,border:`1px solid ${M.red}`,borderRadius:4,padding:12,fontSize:12,color:M.redDark}}>
            <strong>Feil:</strong> {error}
          </div>
        )}

        {/* Results */}
        {results && (
          <div style={{animation:"fadeUp 0.3s ease"}}>
            <div style={{background:M.white,border:`1px solid ${M.gray0}`,borderRadius:4,padding:14,marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:700,color:M.gray6,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>Resultat</div>
              <div style={{display:"flex",gap:8,marginBottom:12}}>
                {[["Bestått",results.summary.passed,M.green,M.greenPale],["Feilet",results.summary.failed,M.red,M.redPale],["Totalt",results.summary.total,M.blue,M.bluePale]].map(([label,val,color,bg]) => (
                  <div key={label} style={{flex:1,textAlign:"center",background:bg,borderRadius:4,padding:"10px 6px",border:`1px solid ${color}40`}}>
                    <div style={{fontSize:24,fontWeight:700,color,fontFamily:"monospace",lineHeight:1}}>{val}</div>
                    <div style={{fontSize:10,color:M.gray6,marginTop:3}}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:M.gray6,marginBottom:4}}>
                <span>{activeIfc?.name}</span>
                <span style={{color:M.greenDark,fontWeight:700}}>{results.summary.total>0?Math.round((results.summary.passed/results.summary.total)*100):100}%</span>
              </div>
              <div style={{height:6,background:M.gray0,borderRadius:3,overflow:"hidden"}}>
                <div style={{height:"100%",borderRadius:3,background:M.green,width:`${results.summary.total>0?Math.round((results.summary.passed/results.summary.total)*100):100}%`,transition:"width 1s ease"}}/>
              </div>
            </div>

            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <div style={{fontSize:10,fontWeight:700,color:M.gray6,textTransform:"uppercase",letterSpacing:"0.08em"}}>Spesifikasjoner ({specs.length})</div>
              <button onClick={() => setFilterFailed(!filterFailed)} style={{ fontSize:10, padding:"3px 8px", borderRadius:3, border:`1px solid ${filterFailed?M.red:M.gray1}`, background:filterFailed?M.redPale:M.white, color:filterFailed?M.redDark:M.gray6, cursor:"pointer", fontFamily:"inherit", fontWeight:600 }}>
                {filterFailed?"✕ Kun feil":"Vis kun feil"}
              </button>
            </div>

            {specs.map((spec, i) => (
              <SpecRow key={spec.name} spec={spec} index={i} onMark={canMark?handleMark:null} canMark={canMark} onEditProps={setEditingSpec}/>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
