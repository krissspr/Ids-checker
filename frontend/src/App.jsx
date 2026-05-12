import { useState, useEffect, useRef } from "react";

// ── Trimble Modus colors ──────────────────────────────────────────────────────
const M = {
  blue: "#0063a3", blueDark: "#0e416c", blueLight: "#217cbb", bluePale: "#dcedf9",
  yellow: "#fbad26", yellowDark: "#e49325", yellowPale: "#fff5e4",
  gray: "#252a2e", gray9: "#353a40", gray8: "#464b52", gray6: "#6a6e79",
  gray3: "#a3a6b1", gray1: "#cbcdd6", gray0: "#e0e1e9", grayLight: "#f1f1f6",
  white: "#ffffff", green: "#1e8a44", greenDark: "#006638", greenPale: "#e0eccf",
  red: "#da212c", redDark: "#ab1f26", redPale: "#fbd4d7",
};

const API_BASE = process.env.REACT_APP_API_URL || "https://ids-checker-api.railway.app";

// ── Pyodide hook ──────────────────────────────────────────────────────────────
function usePyodide() {
  const pyodideRef = useRef(null);
  const loadingPromiseRef = useRef(null);
  const [pyStatus, setPyStatus] = useState("idle"); // idle | loading | ready | error

  const load = () => {
    // Return existing promise if already loading/loaded
    if (loadingPromiseRef.current) return loadingPromiseRef.current;

    loadingPromiseRef.current = (async () => {
      if (pyodideRef.current) return pyodideRef.current;
      setPyStatus("loading");
      try {
        if (!window.loadPyodide) {
          await new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/pyodide.js";
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
          });
        }
        const pyodide = await window.loadPyodide({
          indexURL: "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/",
        });
        await pyodide.loadPackage(["micropip", "numpy"]);
        await pyodide.runPythonAsync(`
import micropip
await micropip.install(
  "https://ifcopenshell.github.io/wasm-wheels/ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl",
  keep_going=True
)
await micropip.install(["elementpath", "xmlschema", "ifctester"], deps=False)
        `);
        pyodideRef.current = pyodide;
        setPyStatus("ready");
        return pyodide;
      } catch (e) {
        console.error("Pyodide load failed:", e);
        setPyStatus("error");
        loadingPromiseRef.current = null; // allow retry
        throw e;
      }
    })();

    return loadingPromiseRef.current;
  };

  const validate = async (ifcBytes, idsText, onStep) => {
    if (!pyodideRef.current) throw new Error("Pyodide ikke klar");
    const py = pyodideRef.current;

    onStep?.("Skriver IFC til filsystem…");
    py.FS.writeFile("/model.ifc", new Uint8Array(ifcBytes));
    py.FS.writeFile("/rules.ids", new TextEncoder().encode(idsText));

    onStep?.("Kjører IDS-validering…");
    const result = await py.runPythonAsync(`
import json, ifcopenshell, ifcopenshell.express
from ifctester import ids
import js

# Register IFC4X3_ADD2 schema at runtime if not already available
def ensure_schema(schema_name):
    try:
        ifcopenshell.ifcopenshell_wrapper.schema_by_name(schema_name)
        return True
    except Exception:
        return False

if not ensure_schema("IFC4X3_ADD2"):
    try:
        from pyodide.http import pyfetch
        resp = await pyfetch("https://raw.githubusercontent.com/buildingSMART/IFC4.3.x-output/master/IFC.exp")
        exp_text = await resp.string()
        with open("/IFC4X3_ADD2.exp", "w") as f:
            f.write(exp_text)
        schema = ifcopenshell.express.parse("/IFC4X3_ADD2.exp")
        ifcopenshell.register_schema(schema)
    except Exception as e:
        pass  # fallback will handle it

ifc_model = ifcopenshell.open("/model.ifc")
specs = ids.open("/rules.ids")
specs.validate(ifc_model)

result_specs = []
for spec in specs.specifications:
    failing = []
    for entity in spec.failed_entities:
        try:
            name = getattr(entity, "Name", None) or "(uten navn)"
            guid = getattr(entity, "GlobalId", None)
            ifc_type = entity.is_a()
        except:
            name = str(entity)
            guid = None
            ifc_type = "ukjent"

        datatype_issue = False
        for req in spec.requirements:
            for reason in (getattr(req, "failed_reasons", []) or []):
                r = str(reason).lower()
                if any(kw in r for kw in ["datatype","ifclabel","ifctext","ifcreal","ifcinteger","type mismatch"]):
                    datatype_issue = True
                    break

        failing.append({"guid": guid, "type": ifc_type, "name": name, "datatype_issue": datatype_issue, "reason": ""})

    passed = len(spec.passed_entities)
    failed = len(spec.failed_entities)
    total = passed + failed

    # requirements_detail
    reqs = []
    for req in spec.requirements:
        cn = req.__class__.__name__
        card = getattr(req, "cardinality", "required") or "required"
        if card == "optional":
            continue
        if cn == "Property":
            pset = str(getattr(req, "propertySet", {}) or "")
            if hasattr(getattr(req, "propertySet", None), "args"):
                pset = req.propertySet.args[0] if req.propertySet.args else pset
            prop = str(getattr(req, "baseName", {}) or "")
            if hasattr(getattr(req, "baseName", None), "args"):
                prop = req.baseName.args[0] if req.baseName.args else prop
            data_type = str(getattr(req, "dataType", "") or "")
            instructions = str(getattr(req, "instructions", "") or "")
            val_obj = getattr(req, "value", None)
            enum_vals = []
            pattern = None
            bounds = {}
            if val_obj is not None:
                t = getattr(val_obj, "type", None)
                opts = getattr(val_obj, "options", None)
                if t == "enumeration" and opts:
                    enum_vals = list(opts) if not isinstance(opts, dict) else list(opts.keys())
                elif t == "pattern" and opts:
                    pattern = str(opts) if not isinstance(opts, dict) else str(list(opts.keys())[0])
                elif t == "bounds" and isinstance(opts, dict):
                    bounds = opts
            # krav_tekst
            if enum_vals:
                krav = f"Skal ha en av følgende verdier: {', '.join(str(v) for v in enum_vals)}"
            elif bounds:
                parts = []
                if "minExclusive" in bounds: parts.append(f"Større enn {bounds['minExclusive']}")
                if "minInclusive" in bounds: parts.append(f"Minst {bounds['minInclusive']}")
                if "maxExclusive" in bounds: parts.append(f"Mindre enn {bounds['maxExclusive']}")
                if "maxInclusive" in bounds: parts.append(f"Maks {bounds['maxInclusive']}")
                krav = ", ".join(parts) if parts else "Skal fylles ut"
            elif pattern:
                krav = "Skal fylles ut"
            else:
                krav = "Skal fylles ut"
            if data_type:
                krav += f" | Datatype: {data_type}"
            reqs.append({"type": "Property", "pset": pset, "name": prop, "enum_values": enum_vals, "pattern": pattern, "bounds": bounds, "data_type": data_type, "instructions": instructions, "cardinality": card, "krav_tekst": krav, "description": f"{pset}.{prop}"})

    # applicability_detail
    appl = {"pset": None, "objekttype": None, "entity": None}
    for facet in spec.applicability:
        cn2 = facet.__class__.__name__
        if cn2 == "Entity":
            appl["entity"] = str(getattr(facet, "name", "") or "")
        elif cn2 == "Property":
            p2 = str(getattr(facet, "baseName", "") or "")
            v2 = str(getattr(facet, "value", "") or "")
            if p2.lower() in ("objekttype","type","objecttype"):
                appl["objekttype"] = v2

    result_specs.append({
        "name": spec.name,
        "status": "passed" if spec.status else "failed",
        "applicability": str(spec.name),
        "applicability_detail": appl,
        "requirement": "",
        "requirements_detail": reqs,
        "failed_req_names": [],
        "passed": passed, "failed": failed, "total": total,
        "no_objects": total == 0,
        "failures": failing[:50],
        "more_failures": max(0, len(failing) - 50),
    })

total_passed = sum(1 for s in result_specs if s["status"] == "passed")
total_failed = sum(1 for s in result_specs if s["status"] == "failed")
json.dumps({"summary": {"passed": total_passed, "failed": total_failed, "total": total_passed + total_failed}, "specifications": result_specs})
`);
    return JSON.parse(result);
  };

  const updateProperties = async (requirements, guids, outputFilename, onStep) => {
    if (!pyodideRef.current) throw new Error("Pyodide ikke klar");
    const py = pyodideRef.current;

    // Check that model.ifc exists in virtual FS
    try { py.FS.stat("/model.ifc"); } catch {
      throw new Error("IFC-fil ikke funnet i Pyodide – kjør validering først");
    }

    onStep?.("Redigerer egenskaper i IFC…");

    // Pass requirements and guids as JSON
    py.globals.set("requirements_json", JSON.stringify(requirements));
    py.globals.set("guids_json", JSON.stringify(guids));

    await py.runPythonAsync(`
import json, ifcopenshell, ifcopenshell.api

req_list = json.loads(requirements_json)
guid_list = json.loads(guids_json)

# IFC datatype mapping
DATATYPE_MAP = {
    "IfcLabel": lambda v: ifcopenshell.util.element.get_pset,  # handled below
    "IfcText": str,
    "IfcIdentifier": str,
    "IfcReal": float,
    "IfcInteger": int,
    "IfcBoolean": lambda v: v.lower() in ("true", "1", "ja", "yes"),
    "IfcLengthMeasure": float,
    "IfcAreaMeasure": float,
    "IfcVolumeMeasure": float,
    "IfcMassMeasure": float,
    "IfcPositiveLengthMeasure": float,
    "IfcPlaneAngleMeasure": float,
    "IfcCountMeasure": int,
}

def cast_value(value, data_type, schema):
    """Cast value to correct IFC type."""
    if not data_type:
        return value
    dt = data_type.strip()
    try:
        ifc_type = schema.declaration_by_name(dt)
        if ifc_type:
            return ifc_type(value)
    except Exception:
        pass
    # Fallback: basic Python types
    if dt in ("IfcReal", "IfcLengthMeasure", "IfcAreaMeasure", "IfcVolumeMeasure",
              "IfcMassMeasure", "IfcPositiveLengthMeasure", "IfcPlaneAngleMeasure"):
        return float(value)
    if dt in ("IfcInteger", "IfcCountMeasure"):
        return int(value)
    if dt == "IfcBoolean":
        return value.lower() in ("true", "1", "ja", "yes")
    return value  # string fallback (IfcLabel, IfcText etc)

model = ifcopenshell.open("/model.ifc")
schema = model.schema_identifier
ifc_schema = ifcopenshell.ifcopenshell_wrapper.schema_by_name(schema)
updated = 0

for guid in guid_list:
    try:
        entity = model.by_guid(guid)
    except Exception:
        continue
    if entity is None:
        continue

    for req in req_list:
        pset_name = req.get("pset", "")
        prop_name = req.get("name", "")
        prop_value = req.get("value", "")
        data_type = req.get("data_type", "")

        if not pset_name or not prop_name or prop_value == "":
            continue

        # Cast to correct IFC type
        try:
            typed_value = cast_value(prop_value, data_type, ifc_schema)
        except Exception:
            typed_value = prop_value

        # Find or create pset
        psets = ifcopenshell.util.element.get_psets(entity)
        if pset_name in psets:
            pset_obj = model.by_id(psets[pset_name]["id"])
            ifcopenshell.api.run("pset.edit_pset", model,
                pset=pset_obj,
                properties={prop_name: typed_value},
            )
        else:
            pset_obj = ifcopenshell.api.run("pset.add_pset", model,
                product=entity, name=pset_name)
            ifcopenshell.api.run("pset.edit_pset", model,
                pset=pset_obj,
                properties={prop_name: typed_value},
            )

    updated += 1

model.write("/model_korrigert.ifc")
print(f"Updated {updated} objects", flush=True)
`);

    onStep?.("Leser korrigert fil…");
    const outBytes = py.FS.readFile("/model_korrigert.ifc");
    return outBytes;
  };

  return { pyStatus, load, validate, updateProperties };
}

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
  if (!window.parent || window.parent === window) { log.warn("Dev mode"); return null; }
  try {
    const WorkspaceAPI = await import("trimble-connect-workspace-api");
    let accessToken = null;
    const api = await WorkspaceAPI.connect(window.parent, (event, args) => {
      log.info(`TC event: ${event}`, args);
      if (event === "extension.accessToken") accessToken = args?.data;
    }, 10000);
    log.ok("Connected");
    const token = await api.extension.requestPermission("accesstoken");
    log.info("Token:", token?.substring?.(0, 20) + "...");
    if (token && token !== "pending" && token !== "denied") accessToken = token;
    return { api, getAccessToken: () => accessToken };
  } catch (e) { log.error("TC connect failed:", e.message); return null; }
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
        const fileKeys = file ? Object.keys(file) : [];
        log.info("FILE KEYS:", fileKeys.join(", "));
        log.info("FILE SNAPSHOT:", JSON.stringify(file));
        const innerFile = file?.file || file;
        const fileName = innerFile?.name || file?.name || "";
        if (fileName.toLowerCase().endsWith(".ifc")) {
          const fileId = innerFile?.id || innerFile?.versionId || file?.id || modelId;
          const parentId = innerFile?.parentId || null;
          const projectId = innerFile?.projectId || null;
          let tcHost = null;
          const thumb = innerFile?.thumbnailUrl?.[0] || innerFile?.thumbnailUrl;
          if (thumb) { try { tcHost = new URL(thumb).host; } catch(e) {} }
          log.info(`FILE → id:${fileId} | parentId:${parentId} | host:${tcHost}`);
          ifcModels.push({ modelId, name: fileName, fileId, parentId, projectId, size: innerFile?.size, tcHost });
          log.ok(`IFC: ${fileName}`);
        }
      } catch (e) { log.warn(`getLoadedModel failed:`, e.message); }
    }
    log.ok(`${ifcModels.length} models found`);
    log.end();
    return ifcModels;
  } catch (e) { log.error("detectLoadedModels failed:", e.message); log.end(); return []; }
}

async function markObjectsInViewer(api, modelId, guids) {
  log.group(`markObjects (${guids.length})`);
  try {
    const runtimeIds = await api.viewer.convertToObjectRuntimeIds(modelId, guids);
    log.info("runtimeIds:", runtimeIds);
    const valid = runtimeIds.filter(Boolean);
    if (!valid.length) { log.warn("No valid IDs"); log.end(); return { success: false, message: "Ingen objekter funnet" }; }
    await api.viewer.setSelection({ modelObjectIds: [{ modelId, objectRuntimeIds: valid }] }, "set");
    await api.viewer.setCamera({ modelObjectIds: [{ modelId, objectRuntimeIds: valid }] }, { animationTime: 500 });
    log.ok(`Marked ${valid.length}`);
    log.end();
    return { success: true, count: valid.length };
  } catch (e) { log.error("mark failed:", e.message); log.end(); return { success: false, message: e.message }; }
}

// ── Mock data ─────────────────────────────────────────────────────────────────
const DEV_MODELS = [{ modelId: "dev-1", name: "Arkitektur_K11.ifc", fileId: "file-1", size: 18400000 }];
const DEV_IDS = [{ id: "ids-a", name: "Byggherre_krav_v2.ids", versionDate: "2025-03-28" }];

// ── Timer hook ────────────────────────────────────────────────────────────────
function useTimer(running) {
  const [seconds, setSeconds] = useState(0);
  const ref = useRef(null);
  const startRef = useRef(null);

  useEffect(() => {
    if (running) {
      setSeconds(0);
      startRef.current = Date.now();
      // Use shorter interval and calculate from start time to survive blocking
      ref.current = setInterval(() => {
        setSeconds(Math.floor((Date.now() - startRef.current) / 1000));
      }, 200);
    } else {
      clearInterval(ref.current);
    }
    return () => clearInterval(ref.current);
  }, [running]);
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

// ── Icons ─────────────────────────────────────────────────────────────────────
const Icon = {
  Check: () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7.5" fill={M.green}/><path d="M4.5 8l2.5 2.5 4.5-5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Fail:  () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7.5" fill={M.red}/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  File:  ({color}) => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2.5A1 1 0 014 1.5h6l3.5 3.5V13.5a1 1 0 01-1 1H4a1 1 0 01-1-1V2.5z" stroke={color||M.gray6} strokeWidth="1.2"/><path d="M9.5 1.5v3.5H13" stroke={color||M.gray6} strokeWidth="1.2" strokeLinecap="round"/></svg>,
  Chevron: ({open}) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{transform:open?"rotate(90deg)":"rotate(0)",transition:"transform 0.18s"}}><path d="M4 2l4 4-4 4" stroke={M.gray6} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Upload: ({color}) => <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 13V5M7 8l3-3 3 3" stroke={color||M.blue} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 16h12" stroke={color||M.blue} strokeWidth="1.5" strokeLinecap="round"/></svg>,
  Spinner: ({color}) => <svg width="16" height="16" viewBox="0 0 20 20" fill="none" style={{animation:"spin 0.9s linear infinite"}}><circle cx="10" cy="10" r="8" stroke={M.gray1} strokeWidth="2.5"/><path d="M10 2a8 8 0 018 8" stroke={color||M.blue} strokeWidth="2.5" strokeLinecap="round"/></svg>,
  Mark:   () => <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M3.5 6l2 2 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Edit:   () => <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2-7 7H1.5v-2l7-7z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Back:   () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7l5 5" stroke={M.blue} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Download: () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v7M4 6l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  Clock: () => <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5.5" stroke={M.blue} strokeWidth="1.2"/><path d="M6.5 3.5V6.5l2 2" stroke={M.blue} strokeWidth="1.2" strokeLinecap="round"/></svg>,
};

// ── Shared UI ─────────────────────────────────────────────────────────────────
function TabBar({ value, onChange, options }) {
  return (
    <div style={{ display:"flex", background:M.grayLight, borderRadius:4, padding:2, marginBottom:8, border:`1px solid ${M.gray0}` }}>
      {options.map(([key, label]) => (
        <button key={key} onClick={() => onChange(key)} style={{
          flex:1, padding:"5px 8px", fontSize:11, fontWeight:600, border:"none",
          cursor:"pointer", borderRadius:3, fontFamily:"inherit", transition:"all 0.15s",
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
      {file ? <div style={{fontSize:12,color,fontWeight:600,textAlign:"center"}}>{file.name}</div>
             : <div style={{fontSize:12,color:M.gray6,textAlign:"center",lineHeight:1.5}}>Dra <span style={{color}}>{label}</span> hit<br/><span style={{fontSize:10,color:M.gray3}}>eller klikk for å velge</span></div>}
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

// ── Requirement row with enum dropdown ────────────────────────────────────────
function RequirementRow({ req, value, onChange, datatype, onDatatypeChange }) {
  const [useCustom, setUseCustom] = useState(false);
  const hasEnum = req.enum_values && req.enum_values.length > 0;

  return (
    <div style={{ marginBottom:12 }}>
      <label style={{ fontSize:11, fontWeight:600, color:M.gray8, display:"block", marginBottom:4 }}>
        <span style={{ fontFamily:"monospace", background:M.grayLight, padding:"1px 5px", borderRadius:3 }}>
          {req.pset ? `${req.pset}.${req.name}` : req.name}
        </span>
      </label>

      {hasEnum && !useCustom ? (
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          <select
            value={value}
            onChange={e => onChange(e.target.value === "__custom__" ? "" : e.target.value)}
            style={{ flex:1, padding:"8px 10px", fontSize:12, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"inherit", color:M.gray, background:M.white, cursor:"pointer" }}
          >
            <option value="">— Velg verdi —</option>
            {req.enum_values.map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
            <option value="__custom__">✏️ Fyll inn selv...</option>
          </select>
        </div>
      ) : (
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          <input
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={req.krav_tekst || "Fyll inn verdi"}
            style={{ flex:1, padding:"8px 10px", fontSize:12, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"inherit", color:M.gray, background:M.white, outline:"none" }}
            onFocus={e => e.target.style.borderColor = M.blue}
            onBlur={e => e.target.style.borderColor = M.gray1}
          />
          {hasEnum && (
            <button onClick={() => { setUseCustom(false); onChange(""); }}
              style={{ fontSize:10, padding:"6px 8px", borderRadius:4, border:`1px solid ${M.gray1}`, background:M.white, color:M.blue, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}>
              ← Vis liste
            </button>
          )}
        </div>
      )}

      {/* Datatype selector */}
      <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:5 }}>
        <label style={{ fontSize:10, color:M.gray6, whiteSpace:"nowrap" }}>Datatype:</label>
        <select
          value={datatype || "IfcLabel"}
          onChange={e => onDatatypeChange(e.target.value)}
          style={{ flex:1, padding:"4px 8px", fontSize:11, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"monospace", color:M.gray, background:M.white, cursor:"pointer" }}
        >
          {IFC_DATATYPES.map(dt => (
            <option key={dt} value={dt}>{dt}</option>
          ))}
        </select>
      </div>

      {hasEnum && !useCustom && value === "" && (
        <div style={{ fontSize:10, color:M.gray6, marginTop:3 }}>
          Tillatte verdier: {req.enum_values.join(", ")}
        </div>
      )}
    </div>
  );
}

// ── Property Editor Page ──────────────────────────────────────────────────────
const IFC_DATATYPES = [
  "IfcLabel", "IfcText", "IfcIdentifier",
  "IfcReal", "IfcInteger", "IfcBoolean",
  "IfcLengthMeasure", "IfcAreaMeasure", "IfcVolumeMeasure",
  "IfcMassMeasure", "IfcPositiveLengthMeasure", "IfcPlaneAngleMeasure",
  "IfcCountMeasure",
];

function PropertyEditor({ spec, model, tc, devMode, onBack, pyUpdateProperties }) {
  const requirements = spec.requirements_detail || [];

  const [values, setValues] = useState(() => {
    const init = {};
    requirements.forEach((_, i) => { init[i] = ""; });
    return init;
  });

  // Per-requirement datatype override (prefilled from IDS)
  const [datatypes, setDatatypes] = useState(() => {
    const init = {};
    requirements.forEach((req, i) => { init[i] = req.data_type || "IfcLabel"; });
    return init;
  });

  const [phase, setPhase] = useState("edit");
  const [saving, setSaving] = useState(false);
  const [saveStep, setSaveStep] = useState(null);
  const [saveResult, setSaveResult] = useState(null);
  const [outputFilename, setOutputFilename] = useState(
    model?.name?.replace(".ifc", "_korrigert.ifc") || "korrigert_modell.ifc"
  );

  const [selectedFolder, setSelectedFolder] = useState(null);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [uploading, setUploading] = useState(false);

  const failedGuids = spec.failures.map(f => f.guid).filter(Boolean);
  const anyFilled = requirements.some((_, i) => (values[i] || "").trim().length > 0);
  const filledReqs = requirements
    .map((req, i) => ({ req, value: (values[i] || "").trim(), data_type: datatypes[i] || "" }))
    .filter(({ value }) => value.length > 0);
  const isSaving = saving || uploading;

  const handleUploadToTC = async () => {
    if (!selectedFolder) { setShowFolderPicker(true); return; }
    setUploading(true);
    setSaveResult(null);
    log.group("uploadToTC");
    try {
      const reqArray = filledReqs.map(({ req, value, data_type }) => ({
        pset: req.pset || "", name: req.name, value, data_type,
      }));
      const outBytes = await pyUpdateProperties(reqArray, failedGuids, outputFilename, setSaveStep);
      const result = await uploadFileToTC(tc, outBytes, outputFilename, selectedFolder.id);
      setSaveResult({ success: true, count: failedGuids.length, uploadedToTC: true, tcFile: result });
      log.ok("Uploaded:", result);
    } catch (e) {
      log.error("uploadToTC failed:", e.message);
      setSaveResult({ success: false, message: e.message });
    } finally {
      setUploading(false);
      setSaveStep(null);
      log.end();
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveResult(null);
    log.group("handleSave pyodide");
    try {
      const reqArray = filledReqs.map(({ req, value, data_type }) => ({
        pset: req.pset || "",
        name: req.name,
        value,
        data_type,
      }));

      // Use Pyodide if available
      if (pyUpdateProperties) {
        const outBytes = await pyUpdateProperties(reqArray, failedGuids, outputFilename, setSaveStep);
        // Download
        const blob = new Blob([outBytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = outputFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setSaveResult({ success: true, count: failedGuids.length });
      } else {
        // Fallback to Railway
        const token = tc?.getAccessToken();
        const project = await tc?.api?.project?.getCurrentProject().catch(() => null);
        const region = project?.location === "europe" ? "app.eu" : "app";
        const form = new FormData();
        form.append("tc_access_token", token || "");
        form.append("tc_region", region);
        if (model?.tcHost) form.append("tc_host", model.tcHost);
        form.append("tc_project_id", project?.id || "");
        form.append("upload_to_project", "false");
        form.append("requirements", JSON.stringify(reqArray));
        form.append("guids", JSON.stringify(failedGuids));
        form.append("output_filename", outputFilename);
        const res = await fetch(`${API_BASE}/update-properties`, { method: "POST", body: form });
        if (!res.ok) throw new Error(`Server svarte med ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = outputFilename;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setSaveResult({ success: true, count: failedGuids.length });
      }
    } catch (e) {
      log.error("handleSave failed:", e.message);
      setSaveResult({ success: false, message: e.message });
    } finally {
      setSaving(false);
      setSaveStep(null);
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
          <div style={{ fontSize:10, fontWeight:700, color:M.redDark, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Feilet regel</div>
          <div style={{ fontSize:13, fontWeight:600, color:M.gray, marginBottom:4 }}>{spec.name}</div>
          <div style={{ fontSize:11, color:M.gray8 }}>
            <span style={{ fontFamily:"monospace", background:M.redPale, padding:"1px 4px", borderRadius:2 }}>{spec.applicability}</span>
            {" · "}{spec.failed} objekt{spec.failed !== 1 ? "er" : ""} feiler
          </div>
        </div>

        {/* Failing objects */}
        <div>
          <div style={{ fontSize:10, fontWeight:700, color:M.gray6, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:8 }}>
            Objekter som feiler ({spec.failures.length}{spec.more_failures > 0 ? ` + ${spec.more_failures} til` : ""})
          </div>
          <div style={{ background:M.white, border:`1px solid ${M.gray0}`, borderRadius:4, overflow:"hidden", maxHeight:140, overflowY:"auto" }}>
            {spec.failures.map((f, i) => (
              <div key={i} style={{ display:"flex", gap:8, alignItems:"center", padding:"7px 10px", borderBottom:i<spec.failures.length-1?`1px solid ${M.grayLight}`:"none" }}>
                <div style={{ width:5, height:5, borderRadius:"50%", background:M.red, flexShrink:0 }}/>
                <div style={{ fontSize:11, color:M.gray, flex:1 }}>{f.name}</div>
                <div style={{ fontSize:10, fontFamily:"monospace", color:M.gray6 }}>{f.type}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Requirements */}
        <div>
          <div style={{ fontSize:10, fontWeight:700, color:M.gray6, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:10 }}>
            Egenskaper å sette ({requirements.length})
          </div>
          {requirements.length === 0 ? (
            <div style={{ fontSize:12, color:M.gray6 }}>Ingen redigerbare egenskaper funnet for denne regelen.</div>
          ) : (
            requirements.map((req, i) => (
              <RequirementRow
                key={i}
                req={req}
                value={values[i] || ""}
                onChange={v => setValues(prev => ({ ...prev, [i]: v }))}
                datatype={datatypes[i] || req.data_type || "IfcLabel"}
                onDatatypeChange={v => setDatatypes(prev => ({ ...prev, [i]: v }))}
              />
            ))
          )}
        </div>

        {/* Preview */}
        {anyFilled && (
          <div style={{ background:M.bluePale, border:`1px solid ${M.blue}40`, borderRadius:4, padding:10 }}>
            <div style={{ fontSize:10, fontWeight:700, color:M.blue, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:6 }}>Forhåndsvisning</div>
            {requirements.map((req, i) => (
              <div key={i} style={{ fontSize:11, color:M.gray8, marginBottom:3 }}>
                <span style={{ fontFamily:"monospace", color:M.blue }}>{req.pset ? `${req.pset}.${req.name}` : req.name}</span>
                {" = "}
                <span style={{ fontFamily:"monospace", color:M.greenDark }}>{values[i]}</span>
              </div>
            ))}
            <div style={{ fontSize:11, color:M.gray6, marginTop:4 }}>på <strong>{failedGuids.length} objekter</strong></div>
          </div>
        )}

        {/* Output filename */}
        <div>
          <label style={{ fontSize:11, fontWeight:600, color:M.gray8, display:"block", marginBottom:4 }}>Filnavn på korrigert fil</label>
          <input value={outputFilename} onChange={e => setOutputFilename(e.target.value)}
            style={{ width:"100%", padding:"8px 10px", fontSize:12, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"monospace", color:M.gray, background:M.white, outline:"none" }}
            onFocus={e => e.target.style.borderColor = M.blue}
            onBlur={e => e.target.style.borderColor = M.gray1}
          />
        </div>

        {/* Filnavn */}
        <div>
          <label style={{ fontSize:11, fontWeight:600, color:M.gray8, display:"block", marginBottom:4 }}>Filnavn på korrigert fil</label>
          <input value={outputFilename} onChange={e => setOutputFilename(e.target.value)}
            style={{ width:"100%", padding:"8px 10px", fontSize:12, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"monospace", color:M.gray, background:M.white, outline:"none" }}
            onFocus={e => e.target.style.borderColor = M.blue}
            onBlur={e => e.target.style.borderColor = M.gray1}
          />
        </div>

        {/* Save buttons */}
        {!saveResult && (
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {/* Download to PC */}
            <button
              disabled={!anyFilled || isSaving}
              onClick={handleSave}
              style={{ padding:"10px 0", borderRadius:4, border:`1px solid ${M.blue}`, cursor:anyFilled&&!isSaving?"pointer":"not-allowed", background:M.white, color:M.blue, fontFamily:"inherit", fontSize:12, fontWeight:600, display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"all 0.2s" }}
            >
              {saving
                ? <><Icon.Spinner color={M.blue}/> {saveStep || "Redigerer…"}</>
                : <><Icon.Download/> Last ned til PC</>
              }
            </button>

            {/* Upload to TC */}
            {tc && pyUpdateProperties && (
              <>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <button
                    disabled={!anyFilled || isSaving}
                    onClick={handleUploadToTC}
                    style={{ flex:1, padding:"10px 0", borderRadius:4, border:"none", cursor:anyFilled&&!isSaving?"pointer":"not-allowed", background:anyFilled&&!isSaving?M.blue:M.gray1, color:anyFilled&&!isSaving?M.white:M.gray6, fontFamily:"inherit", fontSize:12, fontWeight:600, display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"background 0.2s" }}
                  >
                    {uploading
                      ? <><Icon.Spinner color={M.white}/> {saveStep || "Laster opp…"}</>
                      : <><Icon.Upload color={M.white}/> Last opp til TC</>
                    }
                  </button>
                  <button
                    onClick={() => setShowFolderPicker(true)}
                    style={{ padding:"10px 12px", borderRadius:4, border:`1px solid ${M.gray1}`, background:selectedFolder?M.bluePale:M.white, color:selectedFolder?M.blue:M.gray6, cursor:"pointer", fontFamily:"inherit", fontSize:11, whiteSpace:"nowrap" }}
                  >
                    {selectedFolder ? `📁 ${selectedFolder.name}` : "📁 Velg mappe"}
                  </button>
                </div>
                {!selectedFolder && (
                  <div style={{ fontSize:10, color:M.gray6 }}>Velg en mappe i TC før opplasting</div>
                )}
              </>
            )}
          </div>
        )}

        {showFolderPicker && tc && (
          <FolderPicker
            tc={tc}
            onSelect={folder => { setSelectedFolder(folder); setShowFolderPicker(false); }}
            onClose={() => setShowFolderPicker(false)}
          />
        )}

        {saveResult && (
          <div style={{ padding:"10px 12px", borderRadius:4, fontSize:12, border:`1px solid ${saveResult.success?M.green:M.red}`, background:saveResult.success?M.greenPale:M.redPale, color:saveResult.success?M.greenDark:M.redDark, lineHeight:1.6 }}>
            {saveResult.success
              ? saveResult.uploadedToTC
                ? <><strong>✓ Lastet opp til TC!</strong><br/>{saveResult.count} objekter oppdatert – {saveResult.tcFile?.name}</>
                : <>✓ Korrigert IFC lastet ned – {saveResult.count} objekter oppdatert</>
              : `✕ ${saveResult.message}`
            }
            {saveResult.success && (
              <button onClick={() => setSaveResult(null)}
                style={{ display:"block", marginTop:8, fontSize:11, padding:"4px 10px", borderRadius:3, border:`1px solid ${M.green}`, background:M.white, color:M.greenDark, cursor:"pointer", fontFamily:"inherit" }}>
                Gjør en ny endring
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Folder Picker Modal ───────────────────────────────────────────────────────
function FolderPicker({ tc, onSelect, onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [path, setPath] = useState([]);
  const [currentFolderId, setCurrentFolderId] = useState(null);
  const [host, setHost] = useState(null);
  const [token, setToken] = useState(null);

  useEffect(() => {
    (async () => {
      const t = tc.getAccessToken();
      const project = await tc.api.project.getCurrentProject();
      const h = project?.location === "europe" ? "app21.connect.trimble.com" : "app.connect.trimble.com";
      setToken(t);
      setHost(h);

      const loadedModels = await tc.api.viewer.getModels("loaded").catch(() => []);
      if (loadedModels?.length > 0) {
        const fileId = loadedModels[0].id;
        const fileRes = await fetch(
          `https://${h}/tc/api/2.1/projects/${project.id}/${fileId}/versions`,
          { headers: { Authorization: `Bearer ${t}` } }
        );
        if (fileRes.ok) {
          const data = await fileRes.json();
          const parentId = data.items?.[0]?.parentId;
          if (parentId) {
            await loadFolder(parentId, "Prosjektmappe", t, h);
            return;
          }
        }
      }
      setLoading(false);
    })();
  }, []);

  const loadFolder = async (folderId, folderName, t, h) => {
    setLoading(true);
    const tok = t || token;
    const ho = h || host;
    const res = await fetch(
      `https://${ho}/tc/api/2.1/folders/${folderId}/items?tokenThumburl=false&sort=+name`,
      { headers: { Authorization: `Bearer ${tok}` } }
    );
    if (res.ok) {
      const data = await res.json();
      const list = (data.list || data.items || []).filter(i => i.type === "FOLDER");
      setItems(list);
      setCurrentFolderId(folderId);
      if (folderName) setPath(p => [...p, { id: folderId, name: folderName }]);
    }
    setLoading(false);
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ background:M.white, borderRadius:8, width:320, maxHeight:480, display:"flex", flexDirection:"column", boxShadow:"0 8px 32px rgba(0,0,0,0.2)" }}>
        <div style={{ padding:"12px 14px", borderBottom:`1px solid ${M.gray0}`, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ fontWeight:700, fontSize:13, color:M.gray }}>Velg mappe i TC</div>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer", fontSize:18, color:M.gray6, lineHeight:1 }}>×</button>
        </div>

        {/* Breadcrumb */}
        <div style={{ padding:"6px 12px", fontSize:11, color:M.gray6, borderBottom:`1px solid ${M.gray0}`, display:"flex", gap:4, flexWrap:"wrap" }}>
          {path.map((p, i) => (
            <span key={p.id} style={{ display:"flex", alignItems:"center", gap:4 }}>
              {i > 0 && <span>/</span>}
              <span style={{ cursor:"pointer", color:i===path.length-1?M.gray:M.blue }}
                onClick={() => {
                  const newPath = path.slice(0, i);
                  setPath(newPath);
                  loadFolder(p.id, null, null, null);
                }}>
                {p.name}
              </span>
            </span>
          ))}
        </div>

        {/* Folder list */}
        <div style={{ flex:1, overflowY:"auto", padding:"6px 8px" }}>
          {loading ? (
            <div style={{ padding:16, display:"flex", gap:8, alignItems:"center", color:M.gray6, fontSize:12 }}>
              <Icon.Spinner/> Laster…
            </div>
          ) : items.length === 0 ? (
            <div style={{ padding:12, fontSize:11, color:M.gray6 }}>Ingen undermapper</div>
          ) : items.map(item => (
            <div key={item.id}
              onClick={() => loadFolder(item.id, item.name, null, null)}
              style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 8px", borderRadius:4, cursor:"pointer", fontSize:12, color:M.gray }}
              onMouseEnter={e => e.currentTarget.style.background = M.bluePale}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <span>📁</span>
              <span style={{ flex:1 }}>{item.name}</span>
              <span style={{ fontSize:10, color:M.gray6 }}>→</span>
            </div>
          ))}
        </div>

        {/* Select current folder */}
        <div style={{ padding:"10px 12px", borderTop:`1px solid ${M.gray0}`, display:"flex", gap:8 }}>
          <button onClick={onClose}
            style={{ flex:1, padding:"8px 0", borderRadius:4, border:`1px solid ${M.gray1}`, background:M.white, color:M.gray6, cursor:"pointer", fontFamily:"inherit", fontSize:12 }}>
            Avbryt
          </button>
          <button
            disabled={!currentFolderId}
            onClick={() => onSelect({ id: currentFolderId, name: path[path.length-1]?.name || "Mappe" })}
            style={{ flex:2, padding:"8px 0", borderRadius:4, border:"none", background:currentFolderId?M.blue:M.gray1, color:currentFolderId?M.white:M.gray6, cursor:currentFolderId?"pointer":"not-allowed", fontFamily:"inherit", fontSize:12, fontWeight:600 }}>
            Velg denne mappen
          </button>
        </div>
      </div>
    </div>
  );
}

// ── TC Upload function ─────────────────────────────────────────────────────────
async function uploadFileToTC(tc, fileBytes, filename, folderId) {
  const token = tc.getAccessToken();
  const project = await tc.api.project.getCurrentProject();
  const host = project?.location === "europe" ? "app21.connect.trimble.com" : "app.connect.trimble.com";

  // Step 1: Initiate upload
  const initRes = await fetch(
    `https://${host}/tc/api/2.0/files/fs/upload?parentId=${folderId}&parentType=FOLDER`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: filename }),
    }
  );
  if (!initRes.ok) throw new Error(`Oppstart av opplasting feilet: ${initRes.status}`);
  const initData = await initRes.json();

  // Find source file upload URL
  const sourceContent = initData.contents?.find(c => c.type === "SOURCE" || !c.type);
  const uploadUrl = sourceContent?.url || initData.contents?.[0]?.url;
  if (!uploadUrl) throw new Error("Ingen upload-URL returnert fra TC");

  // Step 2: PUT file content (no Authorization header!)
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    body: new Blob([fileBytes], { type: "application/octet-stream" }),
  });
  if (!putRes.ok) throw new Error(`Opplasting feilet: ${putRes.status}`);

  return { fileId: initData.fileId, name: filename };
}

// ── ToDo editor (inline in SpecRow) ──────────────────────────────────────────
function TodoButton({ spec, onCreateTodo, tc }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState("idle");
  const [message, setMessage] = useState("");
  const [members, setMembers] = useState([]);
  const [assigneeId, setAssigneeId] = useState("");
  const [loadingMembers, setLoadingMembers] = useState(false);

  // Pre-fill with spec data, user can edit
  const defaultTitle = `IDS: ${spec.name}`;

  const buildDesc = () => {
    const reqs = spec.requirements_detail || [];
    const appl = spec.applicability_detail || {};
    const failedNames = new Set(spec.failed_req_names || []);

    if (reqs.length > 0) {
      const byPset = {};
      reqs.forEach(r => {
        // Skip optional requirements that don't have failures
        if (r.cardinality === "optional" && !failedNames.has(r.name)) return;
        const pset = r.pset || "Egenskaper";
        if (!byPset[pset]) byPset[pset] = [];
        byPset[pset].push(r);
      });

      const lines = [];
      Object.entries(byPset).forEach(([pset, props]) => {
        if (props.length === 0) return;

        // Header with objekttype if available
        const objekttype = appl.objekttype ? ` for objekter med objekttype: ${appl.objekttype}` : "";
        lines.push(`Feil i egenskapsdata${objekttype} i egenskapssett: ${pset}`);
        lines.push(``);
        lines.push(`Nedenfor listes egenskapene med hver sine krav.`);
        lines.push(``);
        props.forEach(r => {
          const krav = r.krav_tekst || "Skal fylles ut";
          lines.push(`${r.name}: --> ${krav}`);
        });
        lines.push(``);
      });

      lines.push(`Feilet: ${spec.failed} av ${spec.total} objekter`);
      return lines.join("\n");
    }
    return [
      `Krav: ${spec.requirement}`,
      ``,
      `Feilet: ${spec.failed} av ${spec.total} objekter`,
    ].join("\n");
  };

  const defaultDesc = buildDesc();

  const [title, setTitle] = useState(defaultTitle);
  const [desc, setDesc] = useState(defaultDesc);

  const handleOpen = async () => {
    setOpen(!open);
    setState("idle");
    setMessage("");
    if (!open && tc && members.length === 0) {
      setLoadingMembers(true);
      try {
        const token = tc.getAccessToken();
        const project = await tc.api.project.getCurrentProject();
        const region = project?.location === "europe" ? "app.eu" : "app";
        const res = await fetch(`${API_BASE}/project-members?tc_project_id=${project.id}&tc_access_token=${token}&tc_region=${region}`);
        if (res.ok) {
          const data = await res.json();
          setMembers(data.members || []);
          log.ok("Members loaded:", data.members?.length);
        }
      } catch (e) {
        log.warn("Could not load members:", e.message);
      } finally {
        setLoadingMembers(false);
      }
    }
  };

  const handle = async () => {
    setState("creating");
    try {
      const result = await onCreateTodo(spec, title, desc, assigneeId);
      if (result?.created > 0) {
        setState("done");
        setMessage(`✓ ToDo opprettet i TC`);
        setOpen(false);
      } else {
        setState("error");
        setMessage(`✕ ${result?.errors?.[0]?.error || "Ukjent feil"}`);
      }
    } catch (e) {
      setState("error");
      setMessage(`✕ ${e.message}`);
    }
  };

  if (state === "done") return (
    <div style={{ padding:"6px 10px", borderRadius:4, fontSize:11, background:M.greenPale, color:M.greenDark, border:`1px solid ${M.green}` }}>
      {message}
    </div>
  );

  return (
    <div>
      <button
        onClick={handleOpen}
        style={{ padding:"7px 10px", borderRadius:4, border:`1px solid ${M.blue}40`, background:open?M.bluePale:M.white, color:M.blueDark, fontFamily:"inherit", fontSize:11, fontWeight:600, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6, width:"100%", transition:"all 0.15s" }}
      >
        📋 {open ? "Lukk ToDo-editor" : "Lag ToDo i TC"}
      </button>

      {open && (
        <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:8, padding:10, background:M.grayLight, borderRadius:4, border:`1px solid ${M.gray0}` }}>

          {/* Title */}
          <div>
            <label style={{ fontSize:10, fontWeight:700, color:M.gray6, textTransform:"uppercase", letterSpacing:"0.06em", display:"block", marginBottom:4 }}>Tittel</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              style={{ width:"100%", padding:"7px 9px", fontSize:12, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"inherit", color:M.gray, background:M.white, outline:"none" }}
              onFocus={e => e.target.style.borderColor = M.blue}
              onBlur={e => e.target.style.borderColor = M.gray1}
            />
          </div>

          {/* Description */}
          <div>
            <label style={{ fontSize:10, fontWeight:700, color:M.gray6, textTransform:"uppercase", letterSpacing:"0.06em", display:"block", marginBottom:4 }}>Beskrivelse</label>
            <textarea
              value={desc}
              onChange={e => setDesc(e.target.value)}
              rows={8}
              style={{ width:"100%", padding:"7px 9px", fontSize:11, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"monospace", color:M.gray, background:M.white, outline:"none", resize:"vertical", lineHeight:1.5 }}
              onFocus={e => e.target.style.borderColor = M.blue}
              onBlur={e => e.target.style.borderColor = M.gray1}
            />
          </div>

          {/* Assignee */}
          <div>
            <label style={{ fontSize:10, fontWeight:700, color:M.gray6, textTransform:"uppercase", letterSpacing:"0.06em", display:"block", marginBottom:4 }}>
              Tildel til <span style={{ fontWeight:400 }}>(valgfritt)</span>
            </label>
            {loadingMembers ? (
              <div style={{ fontSize:11, color:M.gray6, display:"flex", gap:6, alignItems:"center" }}><Icon.Spinner/> Laster medlemmer…</div>
            ) : (
              <select
                value={assigneeId}
                onChange={e => setAssigneeId(e.target.value)}
                style={{ width:"100%", padding:"7px 9px", fontSize:12, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"inherit", color:M.gray, background:M.white, cursor:"pointer" }}
              >
                <option value="">— Ingen tildeling —</option>
                {members.map(m => (
                  <option key={m.id} value={m.id}>{m.firstName} {m.lastName} ({m.email})</option>
                ))}
              </select>
            )}
          </div>

          {/* Object link info */}
          <div style={{ fontSize:10, color:M.gray6 }}>
            🔗 {spec.failures.filter(f => f.guid).length} objekter kobles til ToDo-en
          </div>

          {/* Error */}
          {state === "error" && (
            <div style={{ padding:"6px 9px", borderRadius:4, fontSize:11, background:M.redPale, color:M.redDark, border:`1px solid ${M.red}` }}>
              {message}
            </div>
          )}

          {/* Create button */}
          <button
            onClick={handle}
            disabled={state === "creating" || !title.trim()}
            style={{ padding:"8px 0", borderRadius:4, border:"none", cursor:state==="creating"||!title.trim()?"not-allowed":"pointer", background:title.trim()&&state!=="creating"?M.blue:M.gray1, color:title.trim()&&state!=="creating"?M.white:M.gray6, fontFamily:"inherit", fontSize:12, fontWeight:600, display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"background 0.2s" }}
          >
            {state === "creating"
              ? <><Icon.Spinner color={M.white}/> Oppretter ToDo…</>
              : <>📋 Opprett ToDo i TC</>
            }
          </button>
        </div>
      )}
    </div>
  );
}

// ── Topic button (inline in SpecRow) ─────────────────────────────────────────
function TopicButton({ spec, onCreateTopic, tc }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState("idle");
  const [message, setMessage] = useState("");
  const [members, setMembers] = useState([]);
  const [assigneeId, setAssigneeId] = useState("");
  const [loadingMembers, setLoadingMembers] = useState(false);

  const defaultTitle = `IDS: ${spec.name}`;

  const buildDesc = () => {
    const reqs = spec.requirements_detail || [];
    const appl = spec.applicability_detail || {};
    const failedNames = new Set(spec.failed_req_names || []);
    if (reqs.length > 0) {
      const byPset = {};
      reqs.forEach(r => {
        if (r.cardinality === "optional" && !failedNames.has(r.name)) return;
        const pset = r.pset || "Egenskaper";
        if (!byPset[pset]) byPset[pset] = [];
        byPset[pset].push(r);
      });
      const lines = [];
      Object.entries(byPset).forEach(([pset, props]) => {
        if (props.length === 0) return;
        const objekttype = appl.objekttype ? ` for objekter med objekttype: ${appl.objekttype}` : "";
        lines.push(`Feil i egenskapsdata${objekttype} i egenskapssett: ${pset}`);
        lines.push(``);
        lines.push(`Nedenfor listes egenskapene med hver sine krav.`);
        lines.push(``);
        props.forEach(r => {
          lines.push(`${r.name}: --> ${r.krav_tekst || "Skal fylles ut"}`);
        });
        lines.push(``);
      });
      lines.push(`Feilet: ${spec.failed} av ${spec.total} objekter`);
      return lines.join("\n");
    }
    return [`Krav: ${spec.requirement}`, ``, `Feilet: ${spec.failed} av ${spec.total} objekter`].join("\n");
  };

  const [title, setTitle] = useState(defaultTitle);
  const [desc, setDesc] = useState(() => buildDesc());

  const handleOpen = async () => {
    setOpen(!open);
    setState("idle");
    setMessage("");
    if (!open && tc && members.length === 0) {
      setLoadingMembers(true);
      try {
        const token = tc.getAccessToken();
        const project = await tc.api.project.getCurrentProject();
        const region = project?.location === "europe" ? "app.eu" : "app";
        const res = await fetch(`${API_BASE}/project-members?tc_project_id=${project.id}&tc_access_token=${token}&tc_region=${region}`);
        if (res.ok) {
          const data = await res.json();
          setMembers(data.members || []);
        }
      } catch (e) {
        log.warn("Could not load members:", e.message);
      } finally {
        setLoadingMembers(false);
      }
    }
  };

  const handle = async () => {
    setState("creating");
    try {
      const result = await onCreateTopic(spec, title, desc, assigneeId);
      if (result?.created > 0) {
        setState("done");
        setMessage(`✓ Topic opprettet i TC`);
        setOpen(false);
      } else {
        setState("error");
        setMessage(`✕ ${result?.errors?.[0]?.error || "Ukjent feil"}`);
      }
    } catch (e) {
      setState("error");
      setMessage(`✕ ${e.message}`);
    }
  };

  if (state === "done") return (
    <div style={{ padding:"6px 10px", borderRadius:4, fontSize:11, background:M.greenPale, color:M.greenDark, border:`1px solid ${M.green}` }}>
      {message}
    </div>
  );

  return (
    <div>
      <button
        onClick={handleOpen}
        style={{ padding:"7px 10px", borderRadius:4, border:`1px solid ${M.blue}40`, background:open?M.bluePale:M.white, color:M.blueDark, fontFamily:"inherit", fontSize:11, fontWeight:600, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6, width:"100%", transition:"all 0.15s" }}
      >
        🗂 {open ? "Lukk BCF-editor" : "Lag Topic / BCF"}
      </button>

      {open && (
        <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:8, padding:10, background:M.grayLight, borderRadius:4, border:`1px solid ${M.gray0}` }}>
          <div>
            <label style={{ fontSize:10, fontWeight:700, color:M.gray6, textTransform:"uppercase", letterSpacing:"0.06em", display:"block", marginBottom:4 }}>Tittel</label>
            <input value={title} onChange={e => setTitle(e.target.value)}
              style={{ width:"100%", padding:"7px 9px", fontSize:12, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"inherit", color:M.gray, background:M.white, outline:"none" }}
              onFocus={e => e.target.style.borderColor = M.blue}
              onBlur={e => e.target.style.borderColor = M.gray1}
            />
          </div>

          <div>
            <label style={{ fontSize:10, fontWeight:700, color:M.gray6, textTransform:"uppercase", letterSpacing:"0.06em", display:"block", marginBottom:4 }}>Beskrivelse</label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={8}
              style={{ width:"100%", padding:"7px 9px", fontSize:11, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"monospace", color:M.gray, background:M.white, outline:"none", resize:"vertical", lineHeight:1.5 }}
              onFocus={e => e.target.style.borderColor = M.blue}
              onBlur={e => e.target.style.borderColor = M.gray1}
            />
          </div>

          <div>
            <label style={{ fontSize:10, fontWeight:700, color:M.gray6, textTransform:"uppercase", letterSpacing:"0.06em", display:"block", marginBottom:4 }}>
              Tildel til <span style={{ fontWeight:400 }}>(valgfritt)</span>
            </label>
            {loadingMembers ? (
              <div style={{ fontSize:11, color:M.gray6, display:"flex", gap:6, alignItems:"center" }}><Icon.Spinner/> Laster medlemmer…</div>
            ) : (
              <select value={assigneeId} onChange={e => setAssigneeId(e.target.value)}
                style={{ width:"100%", padding:"7px 9px", fontSize:12, borderRadius:4, border:`1px solid ${M.gray1}`, fontFamily:"inherit", color:M.gray, background:M.white, cursor:"pointer" }}>
                <option value="">— Ingen tildeling —</option>
                {members.map(m => (
                  <option key={m.id} value={m.tiduuid || m.id}>{m.firstName} {m.lastName} ({m.email})</option>
                ))}
              </select>
            )}
          </div>

          <div style={{ fontSize:10, color:M.gray6 }}>
            🔗 {spec.failures.filter(f => f.guid).length} objekter kobles til Topic-en
          </div>

          {state === "error" && (
            <div style={{ padding:"6px 9px", borderRadius:4, fontSize:11, background:M.redPale, color:M.redDark, border:`1px solid ${M.red}` }}>
              {message}
            </div>
          )}

          <button onClick={handle} disabled={state === "creating" || !title.trim()}
            style={{ padding:"8px 0", borderRadius:4, border:"none", cursor:state==="creating"||!title.trim()?"not-allowed":"pointer", background:title.trim()&&state!=="creating"?M.blue:M.gray1, color:title.trim()&&state!=="creating"?M.white:M.gray6, fontFamily:"inherit", fontSize:12, fontWeight:600, display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"background 0.2s" }}>
            {state === "creating" ? <><Icon.Spinner color={M.white}/> Oppretter Topic…</> : <>🗂 Opprett Topic / BCF i TC</>}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Spec row ──────────────────────────────────────────────────────────────────
function SpecRow({ spec, index, onMark, canMark, onEditProps, onCreateTodo, onCreateTopic, tc }) {
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

  const hasEditableReqs = spec.requirements_detail && spec.requirements_detail.length > 0;
  log.info(`SpecRow ${spec.name}: passed=${passed} onCreateTodo=${!!onCreateTodo} canMark=${canMark}`);

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
          <div style={{fontSize:10,color:M.gray6,marginBottom:8,fontStyle:"italic"}}>
            {spec.requirements_detail?.filter(r => r.cardinality !== "optional").map((r, i) => (
              <div key={i}>{r.pset ? `${r.pset}.${r.name}` : r.name}: {r.krav_tekst}</div>
            )) || <div>{spec.requirement}</div>}
          </div>

          {/* No objects warning */}
          {spec.no_objects && (
            <div style={{ padding:"6px 10px", borderRadius:4, fontSize:11, background:M.yellowPale, border:`1px solid ${M.yellow}`, color:M.gray8, marginBottom:8 }}>
              ⚠ Ingen objekter funnet som matcher denne regelen
            </div>
          )}

          {spec.failures.map((f, i) => (
            <div
              key={i}
              onClick={() => onMark && f.guid && onMark([f.guid])}
              style={{ display:"flex", gap:8, alignItems:"center", padding:"5px 6px", borderRadius:3, borderBottom:i<spec.failures.length-1?`1px solid ${M.grayLight}`:"none", cursor: onMark && f.guid ? "pointer" : "default", transition:"background 0.1s" }}
              onMouseEnter={e => { if (onMark && f.guid) e.currentTarget.style.background = M.bluePale; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
              title={onMark && f.guid ? "Klikk for å markere i viewer" : ""}
            >
              <div style={{width:5,height:5,borderRadius:"50%",background:M.red,flexShrink:0}}/>
              <div style={{fontSize:11,color:M.gray,flex:1}}>{f.name}</div>
              {f.datatype_issue && (
                <span style={{ fontSize:9, background:M.yellowPale, color:M.yellowDark, border:`1px solid ${M.yellow}`, borderRadius:3, padding:"1px 5px", fontWeight:700 }}>DATATYPE</span>
              )}
              <div style={{fontSize:10,fontFamily:"monospace",color:M.gray6}}>{f.type}</div>
              {onMark && f.guid && <div style={{fontSize:9,color:M.blue,opacity:0.6}}>↗</div>}
            </div>
          ))}
          {spec.more_failures > 0 && <div style={{fontSize:10,color:M.gray6,marginTop:6}}>+ {spec.more_failures} flere</div>}

          <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:10}}>
            {canMark && spec.failures.some(f => f.guid) && (
              <button onClick={handleMark} disabled={marking} style={{ padding:"7px 10px", borderRadius:4, border:`1px solid ${M.blue}`, background:marking?M.bluePale:M.white, color:M.blueDark, fontFamily:"inherit", fontSize:11, fontWeight:600, cursor:marking?"not-allowed":"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
                {marking ? <><Icon.Spinner color={M.blue}/> Markerer…</> : <><Icon.Mark/> Marker {spec.failures.length} objekter i TC</>}
              </button>
            )}
            {!passed && hasEditableReqs && (
              <button onClick={() => onEditProps(spec)} style={{ padding:"7px 10px", borderRadius:4, border:`1px solid ${M.yellowDark}`, background:M.yellowPale, color:M.gray9, fontFamily:"inherit", fontSize:11, fontWeight:600, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
                <Icon.Edit/> Oppdater egenskaper
              </button>
            )}
            {onCreateTodo && (
              <TodoButton spec={spec} onCreateTodo={onCreateTodo} tc={tc}/>
            )}
            {onCreateTopic && (
              <TopicButton spec={spec} onCreateTopic={onCreateTopic} tc={tc}/>
            )}
          </div>

          {markResult && (
            <div style={{ marginTop:8, padding:"6px 10px", borderRadius:4, fontSize:11, background:markResult.success?M.greenPale:M.redPale, color:markResult.success?M.greenDark:M.redDark, border:`1px solid ${markResult.success?M.green:M.red}` }}>
              {markResult.success ? `✓ ${markResult.count} objekter markert` : `✕ ${markResult.message}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Home Page ─────────────────────────────────────────────────────────────────
function HomePage({ onSelect, tc, devMode }) {
  const cards = [
    {
      id: "ids",
      icon: "✓",
      title: "IDS Validering",
      desc: "Valider IFC-modell mot IDS-regelsett. Finn feil, marker objekter i viewer, opprett ToDo og Topics.",
      color: M.blue,
      colorPale: M.bluePale,
    },
    {
      id: "props",
      icon: "✏",
      title: "Property Editor",
      desc: "Rediger egenskaper direkte på IFC-objekter og last ned korrigert modell.",
      color: "#e08c00",
      colorPale: M.yellowPale,
    },
    {
      id: "download",
      icon: "↓",
      title: "Last ned",
      desc: "Bla gjennom mapper i TC-prosjektet og last ned filer til din PC.",
      color: M.green,
      colorPale: M.greenPale,
    },
  ];

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:0, height:"100%", background:M.grayLight }}>
      {/* Header */}
      <div style={{ background:M.blueDark, padding:"18px 16px 14px", color:M.white }}>
        <div style={{ fontSize:16, fontWeight:700, letterSpacing:"-0.3px" }}>IDS Regelsjekker</div>
        <div style={{ fontSize:11, color:"#a8c8e8", marginTop:2 }}>
          {tc ? "Koblet til Trimble Connect" : devMode ? "Utviklermodus" : "Kobler til…"}
        </div>
      </div>

      {/* Cards */}
      <div style={{ padding:12, display:"flex", flexDirection:"column", gap:10, flex:1 }}>
        {cards.map(card => (
          <button
            key={card.id}
            onClick={() => onSelect(card.id)}
            style={{ background:M.white, border:`1px solid ${M.gray0}`, borderRadius:6, padding:"14px 14px", textAlign:"left", cursor:"pointer", fontFamily:"inherit", transition:"all 0.15s", display:"flex", gap:14, alignItems:"flex-start" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = card.color; e.currentTarget.style.background = card.colorPale; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = M.gray0; e.currentTarget.style.background = M.white; }}
          >
            <div style={{ width:36, height:36, borderRadius:8, background:card.colorPale, border:`1px solid ${card.color}40`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0, color:card.color }}>
              {card.icon}
            </div>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:M.gray, marginBottom:3 }}>{card.title}</div>
              <div style={{ fontSize:11, color:M.gray6, lineHeight:1.5 }}>{card.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Footer */}
      <div style={{ padding:"10px 16px", fontSize:10, color:M.gray6, borderTop:`1px solid ${M.gray0}`, background:M.white }}>
        Vegvesen · IDS Regelsjekker v1.0
      </div>
    </div>
  );
}

// ── Download Page ─────────────────────────────────────────────────────────────
function DownloadPage({ tc, onBack }) {
  const [folders, setFolders] = useState([]);
  const [currentFolder, setCurrentFolder] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [path, setPath] = useState([]);
  const [downloading, setDownloading] = useState(null);

  const loadFolder = async (folderId, folderName, existingToken, existingHost) => {
    setLoading(true);
    try {
      const token = existingToken || tc.getAccessToken();
      const project = existingToken ? null : await tc.api.project.getCurrentProject();
      const host = existingHost || (project?.location === "europe" ? "app21.connect.trimble.com" : "app.connect.trimble.com");
      const url = `https://${host}/tc/api/2.1/folders/${folderId}/items?tokenThumburl=false&sort=+name`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      log.info("loadFolder:", folderId, "→", res.status);
      if (res.ok) {
        const data = await res.json();
        log.info("folder keys:", Object.keys(data));
        log.info("folder data sample:", JSON.stringify(data).slice(0, 500));
        const list = data.list || data.items || [];
        setItems(list);
        setCurrentFolder(folderId);
        if (folderName) setPath(p => [...p, { id: folderId, name: folderName }]);
      }
    } catch (e) {
      log.error("loadFolder failed:", e.message);
    } finally {
      setLoading(false);
    }
  };

  const loadRoot = async () => {
    setLoading(true);
    try {
      const token = tc.getAccessToken();
      const project = await tc.api.project.getCurrentProject();
      const host = project?.location === "europe" ? "app21.connect.trimble.com" : "app.connect.trimble.com";

      // Get parentId from loaded models in viewer
      const loadedModels = await tc.api.viewer.getModels("loaded").catch(() => []);
      log.info("loadedModels:", loadedModels);

      if (loadedModels?.length > 0) {
        const fileId = loadedModels[0].id || loadedModels[0].fileId;
        log.info("Looking up file versions:", fileId);

        const fileRes = await fetch(
          `https://${host}/tc/api/2.1/projects/${project.id}/${fileId}/versions`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        log.info("versions lookup:", fileRes.status);
        if (fileRes.ok) {
          const fileData = await fileRes.json();
          const item = fileData.items?.[0];
          log.info("file item:", JSON.stringify(item).slice(0, 300));
          const parentId = item?.parentId;
          const parentName = item?.path?.[item.path.length - 1]?.name || "Prosjektmappe";
          log.info("parentId:", parentId, "parentName:", parentName);
          if (parentId) {
            await loadFolder(parentId, parentName, token, host);
            return;
          }
        }
      }

      log.warn("No loaded models found – cannot determine folder");
      setItems([]);
    } catch (e) {
      log.error("loadRoot failed:", e.message);
    } finally {
      setLoading(false);
    }
  };

  const downloadFile = async (item) => {
    setDownloading(item.id);
    try {
      const token = tc.getAccessToken();
      const project = await tc.api.project.getCurrentProject();
      const host = project?.location === "europe" ? "app21.connect.trimble.com" : "app.connect.trimble.com";
      const urlRes = await fetch(
        `https://${host}/tc/api/2.0/files/fs/${item.id}/downloadurl`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (urlRes.ok) {
        const urlData = await urlRes.json();
        const dlUrl = urlData.url;
        if (dlUrl) {
          const a = document.createElement("a");
          a.href = dlUrl;
          a.download = item.name;
          a.click();
          log.ok("Download started:", item.name);
        }
      } else {
        log.warn("downloadurl failed:", urlRes.status);
      }
    } catch (e) {
      log.error("downloadFile failed:", e.message);
    } finally {
      setDownloading(null);
    }
  };

  useEffect(() => { if (tc) loadRoot(); }, [tc]);

  const navigateTo = (idx) => {
    const target = path[idx];
    const newPath = path.slice(0, idx + 1);
    setPath(newPath.slice(0, -1));
    loadFolder(target.id, target.name);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", background:M.white }}>
      <div style={{ background:M.blueDark, padding:"12px 14px", display:"flex", alignItems:"center", gap:10 }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:M.white, cursor:"pointer", fontSize:16, padding:0, opacity:0.8 }}>←</button>
        <div style={{ color:M.white, fontWeight:700, fontSize:13 }}>Last ned fra TC</div>
      </div>

      {/* Breadcrumb */}
      <div style={{ padding:"8px 12px", display:"flex", alignItems:"center", gap:4, fontSize:11, color:M.gray6, borderBottom:`1px solid ${M.gray0}`, flexWrap:"wrap" }}>
        <span onClick={loadRoot} style={{ cursor:"pointer", color:M.blue }}>Rot</span>
        {path.map((p, i) => (
          <span key={p.id} style={{ display:"flex", alignItems:"center", gap:4 }}>
            <span style={{ color:M.gray6 }}>/</span>
            <span onClick={() => navigateTo(i)} style={{ cursor:"pointer", color:i === path.length-1 ? M.gray : M.blue }}>{p.name}</span>
          </span>
        ))}
      </div>

      {/* Items */}
      <div style={{ flex:1, overflowY:"auto", padding:"6px 8px" }}>
        {loading ? (
          <div style={{ display:"flex", gap:8, alignItems:"center", padding:16, color:M.gray6, fontSize:12 }}><Icon.Spinner/> Laster…</div>
        ) : items.length === 0 ? (
          <div style={{ padding:16, fontSize:12, color:M.gray6 }}>Ingen filer her</div>
        ) : items.map(item => {
          const isFolder = item.type === "FOLDER";
          const isFile = !isFolder;
          return (
            <div key={item.id}
              style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 8px", borderRadius:4, cursor:isFolder?"pointer":"default", transition:"background 0.1s" }}
              onClick={() => isFolder && loadFolder(item.id, item.name, null, null)}
              onMouseEnter={e => { if (isFolder) e.currentTarget.style.background = M.bluePale; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
              <span style={{ fontSize:16, flexShrink:0 }}>{isFolder ? "📁" : "📄"}</span>
              <div style={{ flex:1, fontSize:12, color:M.gray, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{item.name}</div>
              {isFile && (
                <button
                  onClick={e => { e.stopPropagation(); downloadFile(item); }}
                  disabled={downloading === item.id}
                  style={{ padding:"4px 10px", borderRadius:3, border:`1px solid ${M.blue}`, background:M.white, color:M.blue, fontSize:10, fontWeight:600, cursor:"pointer", fontFamily:"inherit", flexShrink:0, display:"flex", alignItems:"center", gap:4 }}
                >
                  {downloading === item.id ? <><Icon.Spinner color={M.blue}/> …</> : "↓ Last ned"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── PropertyEditorPage ────────────────────────────────────────────────────────
function PropertyEditorPage({ tc, devMode, loadPyodide, pyStatus, onBack }) {
  const DATA_TYPES =["","IfcLabel","IfcText","IfcIdentifier","IfcReal","IfcInteger","IfcBoolean","IfcLengthMeasure","IfcAreaMeasure","IfcVolumeMeasure","IfcPositiveLengthMeasure","IfcMassMeasure","IfcPlaneAngleMeasure","IfcCountMeasure"];

  function makeRule() {
    return {
      id: `r${Date.now()}${Math.random().toString(36).slice(2,5)}`,
      filter: { mode: "type", typeValue: "IfcWall", nameValue: "", propPset: "", propName: "", propValue: "" },
      properties: [{ pset: "", name: "", value: "", dataType: "" }],
    };
  }

  // ── IFC source
  const [ifcTab, setIfcTab] = useState("upload");
  const [uploadedIfc, setUploadedIfc] = useState(null);
  const [tcIfc, setTcIfc] = useState(null); // { name, bytes }
  // TC IFC browser
  const [tcIfcLoading, setTcIfcLoading] = useState(false);
  const [tcIfcItems, setTcIfcItems] = useState([]);
  const [tcIfcPath, setTcIfcPath] = useState([]);
  const [tcIfcToken, setTcIfcToken] = useState(null);
  const [tcIfcHost, setTcIfcHost] = useState(null);
  const [tcIfcDownloading, setTcIfcDownloading] = useState(null);
  const tcIfcInitDone = useRef(false);

  // ── Rules
  const [rules, setRules] = useState(() => [makeRule()]);
  const [matchCounts, setMatchCounts] = useState({});
  const [matchLoading, setMatchLoading] = useState({});

  // ── Run
  const [runStatus, setRunStatus] = useState("idle");
  const [runLog, setRunLog] = useState([]);
  const [resultBytes, setResultBytes] = useState(null);
  const [resultName, setResultName] = useState(null);

  // ── TC result upload
  const [showResultFolderPicker, setShowResultFolderPicker] = useState(false);
  const [tcUploadState, setTcUploadState] = useState("idle");

  // ── CSV
  const [showCsvSavePicker, setShowCsvSavePicker] = useState(false);
  const [csvSaveState, setCsvSaveState] = useState("idle");
  const [showCsvLoadFolderPicker, setShowCsvLoadFolderPicker] = useState(false);
  const [csvLoadFolder, setCsvLoadFolder] = useState(null);
  const [csvLoadItems, setCsvLoadItems] = useState(null);
  const [csvLoadLoading, setCsvLoadLoading] = useState(false);
  const [csvImportError, setCsvImportError] = useState(null);

  const activeIfcFile = ifcTab === "upload" ? uploadedIfc : tcIfc;
  const hasIfc = !!activeIfcFile;

  // ── TC IFC browser
  const tcIfcLoadFolder = async (folderId, folderName, tok, ho) => {
    setTcIfcLoading(true);
    try {
      const t = tok || tcIfcToken;
      const h = ho || tcIfcHost;
      const res = await fetch(
        `https://${h}/tc/api/2.1/folders/${folderId}/items?tokenThumburl=false&sort=+name`,
        { headers: { Authorization: `Bearer ${t}` } }
      );
      if (res.ok) {
        const data = await res.json();
        setTcIfcItems(data.list || data.items || []);
        if (folderName) setTcIfcPath(p => [...p, { id: folderId, name: folderName }]);
      }
    } finally { setTcIfcLoading(false); }
  };

  const tcIfcInit = async () => {
    if (tcIfcInitDone.current) return;
    tcIfcInitDone.current = true;
    setTcIfcLoading(true);
    try {
      const t = tc.getAccessToken();
      const project = await tc.api.project.getCurrentProject();
      const h = project?.location === "europe" ? "app21.connect.trimble.com" : "app.connect.trimble.com";
      setTcIfcToken(t);
      setTcIfcHost(h);
      const loadedModels = await tc.api.viewer.getModels("loaded").catch(() => []);
      if (loadedModels?.length > 0) {
        const fileId = loadedModels[0].id;
        const fileRes = await fetch(
          `https://${h}/tc/api/2.1/projects/${project.id}/${fileId}/versions`,
          { headers: { Authorization: `Bearer ${t}` } }
        );
        if (fileRes.ok) {
          const d = await fileRes.json();
          const parentId = d.items?.[0]?.parentId;
          const parentName = d.items?.[0]?.path?.[d.items[0].path.length - 1]?.name || "Prosjektmappe";
          if (parentId) { await tcIfcLoadFolder(parentId, parentName, t, h); return; }
        }
      }
    } finally { setTcIfcLoading(false); }
  };

  const tcIfcLoadFile = async (item) => {
    setTcIfcDownloading(item.id);
    try {
      const project = await tc.api.project.getCurrentProject();
      const h = tcIfcHost;
      const urlRes = await fetch(
        `https://${h}/tc/api/2.0/files/fs/${item.id}/downloadurl`,
        { headers: { Authorization: `Bearer ${tcIfcToken}` } }
      );
      if (urlRes.ok) {
        const { url } = await urlRes.json();
        const fileRes = await fetch(url);
        const bytes = new Uint8Array(await fileRes.arrayBuffer());
        setTcIfc({ name: item.name, bytes });
      }
    } finally { setTcIfcDownloading(null); }
  };

  // ── CSV helpers
  function serializeCSV(rulesList) {
    const header = ["RuleId","FilterMode","FilterTypeValue","FilterNameValue","FilterPropPset","FilterPropName","FilterPropValue","PropPset","PropName","PropValue","PropDataType"];
    const rows = [header];
    for (const rule of rulesList) {
      for (const prop of rule.properties) {
        rows.push([rule.id, rule.filter.mode, rule.filter.typeValue, rule.filter.nameValue, rule.filter.propPset, rule.filter.propName, rule.filter.propValue, prop.pset, prop.name, prop.value, prop.dataType]);
      }
    }
    return rows.map(r => r.map(cell => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  }

  function deserializeCSV(text) {
    const parseRow = (line) => {
      const res = []; let field = "", inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { if (inQ && line[i+1] === '"') { field += '"'; i++; } else inQ = !inQ; }
        else if (c === ',' && !inQ) { res.push(field); field = ""; }
        else field += c;
      }
      res.push(field); return res;
    };
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const headers = parseRow(lines[0]);
    const rows = lines.slice(1).map(l => Object.fromEntries(headers.map((h, i) => [h, parseRow(l)[i] ?? ""])));
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.RuleId)) {
        map.set(r.RuleId, {
          id: r.RuleId || `r${Date.now()}${Math.random().toString(36).slice(2,5)}`,
          filter: { mode: r.FilterMode || "type", typeValue: r.FilterTypeValue || "IfcWall", nameValue: r.FilterNameValue || "", propPset: r.FilterPropPset || "", propName: r.FilterPropName || "", propValue: r.FilterPropValue || "" },
          properties: [],
        });
      }
      const rule = map.get(r.RuleId);
      if (r.PropName) rule.properties.push({ pset: r.PropPset || "", name: r.PropName || "", value: r.PropValue || "", dataType: r.PropDataType || "" });
    }
    const result = Array.from(map.values());
    result.forEach(r => { if (!r.properties.length) r.properties.push({ pset:"", name:"", value:"", dataType:"" }); });
    return result;
  }

  const saveCsvToPc = () => {
    const blob = new Blob([serializeCSV(rules)], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "property_rules.csv"; a.click();
  };

  const loadCsvFromPc = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = deserializeCSV(ev.target.result);
      if (result) { setRules(result); setCsvImportError(null); } else setCsvImportError("Ugyldig CSV-format");
    };
    reader.readAsText(f);
    e.target.value = "";
  };

  const saveCsvToTc = async (folder) => {
    setShowCsvSavePicker(false); setCsvSaveState("uploading");
    try {
      await uploadFileToTC(tc, new TextEncoder().encode(serializeCSV(rules)), "property_rules.csv", folder.id);
      setCsvSaveState("done");
    } catch (e) { log.error("CSV TC save:", e.message); setCsvSaveState("error"); }
  };

  const loadCsvFolderSelected = async (folder) => {
    setShowCsvLoadFolderPicker(false); setCsvLoadFolder(folder); setCsvLoadLoading(true);
    try {
      const t = tc.getAccessToken();
      const project = await tc.api.project.getCurrentProject();
      const h = project?.location === "europe" ? "app21.connect.trimble.com" : "app.connect.trimble.com";
      const res = await fetch(`https://${h}/tc/api/2.1/folders/${folder.id}/items?tokenThumburl=false&sort=+name`, { headers: { Authorization: `Bearer ${t}` } });
      if (res.ok) {
        const data = await res.json();
        setCsvLoadItems((data.list || data.items || []).filter(i => i.type !== "FOLDER" && i.name?.toLowerCase().endsWith(".csv")));
      }
    } finally { setCsvLoadLoading(false); }
  };

  const loadCsvFileFromTc = async (item) => {
    try {
      const t = tc.getAccessToken();
      const project = await tc.api.project.getCurrentProject();
      const h = project?.location === "europe" ? "app21.connect.trimble.com" : "app.connect.trimble.com";
      const urlRes = await fetch(`https://${h}/tc/api/2.0/files/fs/${item.id}/downloadurl`, { headers: { Authorization: `Bearer ${t}` } });
      if (urlRes.ok) {
        const { url } = await urlRes.json();
        const text = await (await fetch(url)).text();
        const result = deserializeCSV(text);
        if (result) { setRules(result); setCsvLoadItems(null); setCsvLoadFolder(null); setCsvImportError(null); }
        else setCsvImportError("Ugyldig CSV-format");
      }
    } catch (e) { setCsvImportError(e.message); }
  };

  // ── Sjekk treff
  const checkMatches = async (rule) => {
    if (!hasIfc) return;
    setMatchLoading(m => ({ ...m, [rule.id]: true }));
    try {
      const py = await loadPyodide();
      let bytes;
      if (ifcTab === "upload" && uploadedIfc) bytes = new Uint8Array(await uploadedIfc.arrayBuffer());
      else if (tcIfc) bytes = tcIfc.bytes;
      if (!bytes) return;
      py.FS.writeFile("/model.ifc", bytes);
      py.globals.set("check_rule_json", JSON.stringify(rule));
      const count = await py.runPythonAsync(`
import json, ifcopenshell, ifcopenshell.util.element
rule = json.loads(check_rule_json)
filt = rule.get("filter", {})
filt_mode = filt.get("mode","type")
type_value = filt.get("typeValue","")
name_value = filt.get("nameValue","")
pf_pset = filt.get("propPset","")
pf_name = filt.get("propName","")
pf_value = filt.get("propValue","")
model = ifcopenshell.open("/model.ifc")
if filt_mode == "type":
    try:
        entities = model.by_type(type_value) if type_value else []
    except Exception:
        entities = []
elif filt_mode == "property":
    entities = list(model) if pf_pset else []
else:
    nv = name_value.lower()
    entities = [e for e in model if nv and nv in (getattr(e, "Name", "") or "").lower()] if nv else []
if filt_mode == "property" and pf_pset:
    filtered = []
    for ent in entities:
        psets = ifcopenshell.util.element.get_psets(ent)
        if pf_pset not in psets:
            continue
        if pf_name:
            found_val = psets[pf_pset].get(pf_name)
            if found_val is None:
                continue
            if pf_value and str(found_val) != pf_value:
                continue
        filtered.append(ent)
    entities = filtered
elif pf_name:
    filtered = []
    for ent in entities:
        psets = ifcopenshell.util.element.get_psets(ent)
        found_val = None
        if pf_pset:
            found_val = psets.get(pf_pset, {}).get(pf_name)
        else:
            for pd in psets.values():
                if pf_name in pd:
                    found_val = pd[pf_name]
                    break
        if pf_value:
            if str(found_val) == pf_value:
                filtered.append(ent)
        elif found_val is not None:
            filtered.append(ent)
    entities = filtered
str(len(entities))
`);
      setMatchCounts(m => ({ ...m, [rule.id]: parseInt(count) || 0 }));
    } catch (e) {
      log.error("checkMatches:", e.message);
      setMatchCounts(m => ({ ...m, [rule.id]: -1 }));
    } finally {
      setMatchLoading(m => ({ ...m, [rule.id]: false }));
    }
  };

  // ── Kjør alle regler
  const runAllRules = async () => {
    if (!hasIfc) return;
    setRunStatus("running"); setRunLog([]); setResultBytes(null);
    try {
      setRunLog(l => [...l, "Laster Python-miljø…"]);
      const py = await loadPyodide();
      let bytes;
      if (ifcTab === "upload" && uploadedIfc) bytes = new Uint8Array(await uploadedIfc.arrayBuffer());
      else bytes = tcIfc.bytes;
      setRunLog(l => [...l, "Skriver IFC til filsystem…"]);
      py.FS.writeFile("/model.ifc", bytes);
      py.globals.set("pe_rules_json", JSON.stringify(rules));
      setRunLog(l => [...l, "Kjører regler…"]);
      const resultJson = await py.runPythonAsync(`
import json, ifcopenshell, ifcopenshell.api, ifcopenshell.util.element
rules_list = json.loads(pe_rules_json)
model = ifcopenshell.open("/model.ifc")
try:
    schema_obj = ifcopenshell.ifcopenshell_wrapper.schema_by_name(model.schema_identifier)
except Exception:
    schema_obj = None

def cast_value(value, data_type):
    if not data_type or not value:
        return value
    dt = data_type.strip()
    if schema_obj:
        try:
            ifc_type = schema_obj.declaration_by_name(dt)
            if ifc_type:
                return ifc_type(value)
        except Exception:
            pass
    if dt in ("IfcReal","IfcLengthMeasure","IfcAreaMeasure","IfcVolumeMeasure","IfcMassMeasure","IfcPositiveLengthMeasure","IfcPlaneAngleMeasure"):
        return float(value)
    if dt in ("IfcInteger","IfcCountMeasure"):
        return int(value)
    if dt == "IfcBoolean":
        return value.lower() in ("true","1","ja","yes")
    return value

results = []
for rule in rules_list:
    filt = rule.get("filter", {})
    filt_mode = filt.get("mode","type")
    type_value = filt.get("typeValue","")
    name_value = filt.get("nameValue","")
    pf_pset = filt.get("propPset","")
    pf_name = filt.get("propName","")
    pf_value = filt.get("propValue","")
    props_to_set = rule.get("properties", [])
    if filt_mode == "type":
        try:
            entities = model.by_type(type_value) if type_value else []
        except Exception:
            entities = []
    elif filt_mode == "property":
        entities = list(model) if pf_pset else []
    else:
        nv = name_value.lower()
        entities = [e for e in model if nv and nv in (getattr(e, "Name", "") or "").lower()] if nv else []
    if filt_mode == "property" and pf_pset:
        filtered = []
        for ent in entities:
            psets = ifcopenshell.util.element.get_psets(ent)
            if pf_pset not in psets:
                continue
            if pf_name:
                found_val = psets[pf_pset].get(pf_name)
                if found_val is None:
                    continue
                if pf_value and str(found_val) != pf_value:
                    continue
            filtered.append(ent)
        entities = filtered
    elif pf_name:
        filtered = []
        for ent in entities:
            psets = ifcopenshell.util.element.get_psets(ent)
            found_val = None
            if pf_pset:
                found_val = psets.get(pf_pset, {}).get(pf_name)
            else:
                for pd in psets.values():
                    if pf_name in pd:
                        found_val = pd[pf_name]
                        break
            if pf_value:
                if str(found_val) == pf_value:
                    filtered.append(ent)
            elif found_val is not None:
                filtered.append(ent)
        entities = filtered
    updated_count = 0
    for ent in entities:
        for prop in props_to_set:
            pset_name = prop.get("pset","")
            prop_name = prop.get("name","")
            prop_value = prop.get("value","")
            data_type = prop.get("dataType","")
            if not pset_name or not prop_name or prop_value == "":
                continue
            try:
                typed_val = cast_value(str(prop_value), data_type)
            except Exception:
                typed_val = str(prop_value)
            psets_data = ifcopenshell.util.element.get_psets(ent)
            if pset_name in psets_data:
                pset_obj = model.by_id(psets_data[pset_name]["id"])
                ifcopenshell.api.run("pset.edit_pset", model, pset=pset_obj, properties={prop_name: typed_val})
            else:
                pset_obj = ifcopenshell.api.run("pset.add_pset", model, product=ent, name=pset_name)
                ifcopenshell.api.run("pset.edit_pset", model, pset=pset_obj, properties={prop_name: typed_val})
        updated_count += 1
    if filt_mode == "type":
        label = type_value
    elif filt_mode == "name":
        label = f"Navn:{name_value}"
    else:
        label = f"Pset:{pf_pset}" + (f".{pf_name}" if pf_name else "")
    results.append({"ruleId": rule.get("id",""), "label": label, "count": updated_count})
model.write("/pe_output.ifc")
json.dumps({"rules": results, "total": sum(r["count"] for r in results)})
`);
      const data = JSON.parse(resultJson);
      setRunLog(l => [...l, `Ferdig! ${data.total} objekter oppdatert.`]);
      data.rules.forEach(r => setRunLog(l => [...l, `  ${r.label}: ${r.count} objekter`]));
      const outBytes = py.FS.readFile("/pe_output.ifc");
      const baseName = (activeIfcFile?.name || "model").replace(/\.ifc$/i, "");
      setResultBytes(outBytes);
      setResultName(`${baseName}_korrigert.ifc`);
      setRunStatus("done");
    } catch (e) {
      setRunLog(l => [...l, `Feil: ${e.message}`]);
      setRunStatus("error");
    }
  };

  const downloadResult = () => {
    const blob = new Blob([resultBytes], { type: "application/octet-stream" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = resultName; a.click();
  };

  const uploadResultToTc = async (folder) => {
    setShowResultFolderPicker(false); setTcUploadState("uploading");
    try {
      await uploadFileToTC(tc, resultBytes, resultName, folder.id);
      setTcUploadState("done");
    } catch (e) { log.error("TC upload:", e.message); setTcUploadState("error"); }
  };

  const sectionLabel = (text) => (
    <div style={{ fontSize:10, fontWeight:700, color:M.gray6, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:8 }}>{text}</div>
  );

  const btnStyle = (color, outline) => ({
    fontSize:11, padding:"6px 12px", borderRadius:4,
    border:`1px solid ${color}`, background: outline ? M.white : color,
    color: outline ? color : M.white,
    cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:5,
  });

  return (
    <div style={{ display:"flex", flexDirection:"column", flex:1, minHeight:0, background:M.grayLight }}>

      {/* A: Header */}
      <div style={{ background:M.blueDark, padding:"10px 14px", display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:M.white, cursor:"pointer", fontSize:18, padding:0, opacity:0.8, lineHeight:1 }}>←</button>
        <div style={{ color:M.white, fontWeight:700, fontSize:13 }}>Property Editor</div>
      </div>

      <div style={{ flex:1, overflow:"auto", padding:14, display:"flex", flexDirection:"column", gap:14 }}>

        {/* B: IFC-kilde */}
        <section>
          {sectionLabel("IFC-kilde")}
          <TabBar
            value={ifcTab}
            onChange={v => { setIfcTab(v); if (v === "tc" && tc) tcIfcInit(); }}
            options={[["upload","Last opp fra PC"],["tc","Hent fra TC"]]}
          />
          {ifcTab === "upload" ? (
            <UploadZone file={uploadedIfc} onFile={setUploadedIfc} accept=".ifc" label=".ifc-fil"/>
          ) : !tc ? (
            <div style={{ fontSize:11, color:M.gray6, padding:12, background:M.white, borderRadius:4, border:`1px solid ${M.gray0}` }}>Ikke tilkoblet Trimble Connect</div>
          ) : (
            <div style={{ background:M.white, border:`1px solid ${M.gray0}`, borderRadius:4, display:"flex", flexDirection:"column", maxHeight:260, overflow:"hidden" }}>
              {tcIfc && (
                <div style={{ padding:"5px 10px", background:M.greenPale, borderBottom:`1px solid ${M.green}40`, fontSize:11, color:M.greenDark, display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
                  <Icon.File color={M.green}/> {tcIfc.name} — lastet
                </div>
              )}
              <div style={{ padding:"4px 10px", fontSize:10, color:M.gray6, borderBottom:`1px solid ${M.gray0}`, display:"flex", gap:4, flexWrap:"wrap", flexShrink:0 }}>
                {tcIfcPath.length === 0 ? <span style={{ color:M.gray3 }}>Rot</span> : tcIfcPath.map((p, i) => (
                  <span key={p.id} style={{ display:"flex", alignItems:"center", gap:4 }}>
                    {i > 0 && <span>/</span>}
                    <span style={{ cursor:"pointer", color:M.blue }} onClick={() => {
                      setTcIfcPath(tcIfcPath.slice(0, i + 1).slice(0, -1));
                      tcIfcLoadFolder(p.id, null, null, null);
                    }}>{p.name}</span>
                  </span>
                ))}
              </div>
              <div style={{ flex:1, overflowY:"auto", padding:"4px 6px" }}>
                {tcIfcLoading ? (
                  <div style={{ padding:12, display:"flex", gap:8, alignItems:"center", fontSize:11, color:M.gray6 }}><Icon.Spinner/> Laster…</div>
                ) : tcIfcItems.length === 0 ? (
                  <div style={{ padding:12, fontSize:11, color:M.gray6 }}>Ingen filer</div>
                ) : tcIfcItems.map(item => {
                  const isFolder = item.type === "FOLDER";
                  const isIfc = !isFolder && item.name?.toLowerCase().endsWith(".ifc");
                  return (
                    <div key={item.id}
                      style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 6px", borderRadius:4, cursor:isFolder?"pointer":"default" }}
                      onClick={() => isFolder && tcIfcLoadFolder(item.id, item.name, null, null)}
                      onMouseEnter={e => { if (isFolder) e.currentTarget.style.background = M.bluePale; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <span style={{ fontSize:14, flexShrink:0 }}>{isFolder ? "📁" : "📄"}</span>
                      <div style={{ flex:1, fontSize:11, color:M.gray, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{item.name}</div>
                      {isIfc && (
                        <button
                          onClick={e => { e.stopPropagation(); tcIfcLoadFile(item); }}
                          disabled={tcIfcDownloading === item.id}
                          style={{ padding:"3px 8px", borderRadius:3, border:`1px solid ${M.green}`, background:M.white, color:M.green, fontSize:10, fontWeight:600, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:4, flexShrink:0 }}
                        >
                          {tcIfcDownloading === item.id ? <><Icon.Spinner color={M.green}/> …</> : "Bruk"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* C: Regelbygger */}
        <section>
          {sectionLabel("Regelbygger")}
          {rules.map((rule, rIdx) => (
            <div key={rule.id} style={{ background:M.white, border:`1px solid ${M.gray0}`, borderRadius:6, marginBottom:10, overflow:"hidden" }}>
              <div style={{ background:M.bluePale, padding:"6px 10px", display:"flex", alignItems:"center", gap:8 }}>
                <div style={{ fontSize:11, fontWeight:700, color:M.blue, flex:1 }}>Regel {rIdx + 1}</div>
                {rules.length > 1 && (
                  <button onClick={() => setRules(r => r.filter(x => x.id !== rule.id))}
                    style={{ background:"none", border:"none", color:M.gray6, cursor:"pointer", fontSize:15, lineHeight:1, padding:"0 2px" }}>×</button>
                )}
              </div>
              {/* Filter section */}
              <div style={{ padding:"10px 10px 8px" }}>
                <div style={{ fontSize:10, fontWeight:600, color:M.gray6, marginBottom:6 }}>Filtre</div>
                <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                  {/* Mode toggle */}
                  <div style={{ display:"flex", borderRadius:3, border:`1px solid ${M.gray1}`, overflow:"hidden", flexShrink:0 }}>
                    {[["type","IFC-type"],["name","Navn"],["property","Egenskap"]].map(([val, label]) => (
                      <button key={val} onClick={() => setRules(r => r.map(x => x.id===rule.id ? {...x, filter:{...x.filter, mode:val}} : x))}
                        style={{ fontSize:10, padding:"4px 9px", border:"none", fontFamily:"inherit", cursor:"pointer", fontWeight:600,
                          background: rule.filter.mode===val ? M.blue : M.white,
                          color: rule.filter.mode===val ? M.white : M.gray6 }}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {rule.filter.mode === "type" ? (
                    <input placeholder="f.eks. IfcWall" value={rule.filter.typeValue}
                      onChange={e => setRules(r => r.map(x => x.id===rule.id ? {...x, filter:{...x.filter, typeValue:e.target.value}} : x))}
                      style={{ fontSize:11, padding:"4px 6px", border:`1px solid ${M.gray1}`, borderRadius:3, fontFamily:"inherit", flex:"1 1 140px", minWidth:0 }}/>
                  ) : rule.filter.mode === "name" ? (
                    <input placeholder="Navn inneholder…" value={rule.filter.nameValue}
                      onChange={e => setRules(r => r.map(x => x.id===rule.id ? {...x, filter:{...x.filter, nameValue:e.target.value}} : x))}
                      style={{ fontSize:11, padding:"4px 6px", border:`1px solid ${M.gray1}`, borderRadius:3, fontFamily:"inherit", flex:"1 1 140px", minWidth:0 }}/>
                  ) : (
                    <>
                      <input placeholder="Egenskapssett" value={rule.filter.propPset}
                        onChange={e => setRules(r => r.map(x => x.id===rule.id ? {...x, filter:{...x.filter, propPset:e.target.value}} : x))}
                        style={{ fontSize:11, padding:"4px 6px", border:`1px solid ${M.gray1}`, borderRadius:3, fontFamily:"inherit", flex:"1 1 140px", minWidth:0 }}/>
                      <input placeholder="Egenskap (valgfritt)" value={rule.filter.propName}
                        onChange={e => setRules(r => r.map(x => x.id===rule.id ? {...x, filter:{...x.filter, propName:e.target.value}} : x))}
                        style={{ fontSize:11, padding:"4px 6px", border:`1px solid ${M.gray1}`, borderRadius:3, fontFamily:"inherit", flex:"1 1 120px", minWidth:0 }}/>
                      <input placeholder="Verdi (valgfritt)" value={rule.filter.propValue}
                        onChange={e => setRules(r => r.map(x => x.id===rule.id ? {...x, filter:{...x.filter, propValue:e.target.value}} : x))}
                        style={{ fontSize:11, padding:"4px 6px", border:`1px solid ${M.gray1}`, borderRadius:3, fontFamily:"inherit", flex:"1 1 100px", minWidth:0 }}/>
                    </>
                  )}
                  {rule.filter.mode === "name" && <>
                    <input placeholder="Pset-filter (valgfritt)" value={rule.filter.propPset}
                      onChange={e => setRules(r => r.map(x => x.id===rule.id ? {...x, filter:{...x.filter, propPset:e.target.value}} : x))}
                      style={{ fontSize:11, padding:"4px 6px", border:`1px solid ${M.gray1}`, borderRadius:3, fontFamily:"inherit", flex:"1 1 120px", minWidth:0 }}/>
                    <input placeholder="Egenskap (valgfritt)" value={rule.filter.propName}
                      onChange={e => setRules(r => r.map(x => x.id===rule.id ? {...x, filter:{...x.filter, propName:e.target.value}} : x))}
                      style={{ fontSize:11, padding:"4px 6px", border:`1px solid ${M.gray1}`, borderRadius:3, fontFamily:"inherit", flex:"1 1 120px", minWidth:0 }}/>
                    <input placeholder="Verdi (valgfritt)" value={rule.filter.propValue}
                      onChange={e => setRules(r => r.map(x => x.id===rule.id ? {...x, filter:{...x.filter, propValue:e.target.value}} : x))}
                      style={{ fontSize:11, padding:"4px 6px", border:`1px solid ${M.gray1}`, borderRadius:3, fontFamily:"inherit", flex:"1 1 100px", minWidth:0 }}/>
                  </>}
                </div>
                <div style={{ marginTop:6, display:"flex", alignItems:"center", gap:8 }}>
                  <button onClick={() => checkMatches(rule)} disabled={!hasIfc || matchLoading[rule.id]}
                    style={{ fontSize:10, padding:"3px 10px", borderRadius:3, border:`1px solid ${M.blue}`, background:M.white, color:M.blue, cursor:hasIfc?"pointer":"not-allowed", fontFamily:"inherit", display:"flex", alignItems:"center", gap:4 }}>
                    {matchLoading[rule.id] ? <><Icon.Spinner color={M.blue}/> Sjekker…</> : "Sjekk treff"}
                  </button>
                  {matchCounts[rule.id] !== undefined && (
                    <span style={{ fontSize:10, color:matchCounts[rule.id] > 0 ? M.green : M.gray6 }}>
                      {matchCounts[rule.id] < 0 ? "Feil ved sjekk" : `${matchCounts[rule.id]} treff`}
                    </span>
                  )}
                </div>
              </div>
              {/* Properties section */}
              <div style={{ padding:"8px 10px 10px", borderTop:`1px solid ${M.gray0}` }}>
                <div style={{ fontSize:10, fontWeight:600, color:M.gray6, marginBottom:6 }}>Egenskaper å sette</div>
                {rule.properties.map((prop, pIdx) => (
                  <div key={pIdx} style={{ display:"flex", gap:5, marginBottom:5, flexWrap:"wrap" }}>
                    <input placeholder="Pset" value={prop.pset}
                      onChange={e => setRules(r => r.map(x => x.id===rule.id ? {...x, properties:x.properties.map((p,i)=>i===pIdx?{...p,pset:e.target.value}:p)} : x))}
                      style={{ fontSize:11, padding:"4px 6px", border:`1px solid ${M.gray1}`, borderRadius:3, fontFamily:"inherit", flex:"1 1 100px", minWidth:0 }}/>
                    <input placeholder="Navn" value={prop.name}
                      onChange={e => setRules(r => r.map(x => x.id===rule.id ? {...x, properties:x.properties.map((p,i)=>i===pIdx?{...p,name:e.target.value}:p)} : x))}
                      style={{ fontSize:11, padding:"4px 6px", border:`1px solid ${M.gray1}`, borderRadius:3, fontFamily:"inherit", flex:"1 1 100px", minWidth:0 }}/>
                    <input placeholder="Verdi" value={prop.value}
                      onChange={e => setRules(r => r.map(x => x.id===rule.id ? {...x, properties:x.properties.map((p,i)=>i===pIdx?{...p,value:e.target.value}:p)} : x))}
                      style={{ fontSize:11, padding:"4px 6px", border:`1px solid ${M.gray1}`, borderRadius:3, fontFamily:"inherit", flex:"1 1 80px", minWidth:0 }}/>
                    <select value={prop.dataType}
                      onChange={e => setRules(r => r.map(x => x.id===rule.id ? {...x, properties:x.properties.map((p,i)=>i===pIdx?{...p,dataType:e.target.value}:p)} : x))}
                      style={{ fontSize:11, padding:"4px 6px", border:`1px solid ${M.gray1}`, borderRadius:3, fontFamily:"inherit", flex:"1 1 130px", minWidth:0 }}>
                      {DATA_TYPES.map(t => <option key={t} value={t}>{t || "Datatype (valgfritt)"}</option>)}
                    </select>
                    {rule.properties.length > 1 && (
                      <button onClick={() => setRules(r => r.map(x => x.id===rule.id ? {...x, properties:x.properties.filter((_,i)=>i!==pIdx)} : x))}
                        style={{ background:"none", border:"none", color:M.gray6, cursor:"pointer", fontSize:15, padding:"0 4px", flexShrink:0, lineHeight:1 }}>×</button>
                    )}
                  </div>
                ))}
                <button
                  onClick={() => setRules(r => r.map(x => x.id===rule.id ? {...x, properties:[...x.properties,{pset:"",name:"",value:"",dataType:""}]} : x))}
                  style={{ fontSize:10, padding:"3px 8px", borderRadius:3, border:`1px solid ${M.gray1}`, background:M.white, color:M.gray6, cursor:"pointer", fontFamily:"inherit" }}>
                  + Egenskap
                </button>
              </div>
            </div>
          ))}
          <button onClick={() => setRules(r => [...r, makeRule()])}
            style={{ fontSize:11, padding:"6px 14px", borderRadius:4, border:`1px solid ${M.blue}`, background:M.white, color:M.blue, cursor:"pointer", fontFamily:"inherit", fontWeight:600 }}>
            + Legg til regel
          </button>
        </section>

        {/* D: CSV import/eksport */}
        <section>
          {sectionLabel("CSV import/eksport")}
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <button onClick={saveCsvToPc} style={btnStyle(M.blue, true)}>↓ Lagre til PC</button>
            <label style={{ ...btnStyle(M.blue, true), cursor:"pointer" }}>
              ↑ Laste fra PC
              <input type="file" accept=".csv" style={{ display:"none" }} onChange={loadCsvFromPc}/>
            </label>
            {tc && <>
              <button onClick={() => setShowCsvSavePicker(true)} style={btnStyle(M.blue, true)}>↑ Lagre til TC</button>
              <button onClick={() => setShowCsvLoadFolderPicker(true)} style={btnStyle(M.blue, true)}>↓ Laste fra TC</button>
            </>}
          </div>
          {csvSaveState === "done" && <div style={{ fontSize:10, color:M.green, marginTop:6 }}>✓ CSV lagret til TC</div>}
          {csvSaveState === "error" && <div style={{ fontSize:10, color:M.red, marginTop:6 }}>Feil ved lagring til TC</div>}
          {csvImportError && <div style={{ fontSize:10, color:M.red, marginTop:6 }}>{csvImportError}</div>}
          {csvLoadFolder && csvLoadItems !== null && (
            <div style={{ marginTop:8, background:M.white, border:`1px solid ${M.gray0}`, borderRadius:4, padding:10 }}>
              <div style={{ fontSize:11, fontWeight:600, color:M.gray, marginBottom:6 }}>CSV-filer i {csvLoadFolder.name}:</div>
              {csvLoadLoading ? (
                <div style={{ display:"flex", gap:6, alignItems:"center", fontSize:11, color:M.gray6 }}><Icon.Spinner/> Laster…</div>
              ) : csvLoadItems.length === 0 ? (
                <div style={{ fontSize:11, color:M.gray6 }}>Ingen CSV-filer i denne mappen</div>
              ) : csvLoadItems.map(item => (
                <button key={item.id} onClick={() => loadCsvFileFromTc(item)}
                  style={{ display:"block", width:"100%", textAlign:"left", padding:"5px 8px", marginBottom:4, borderRadius:3, border:`1px solid ${M.gray0}`, background:M.grayLight, cursor:"pointer", fontSize:11, color:M.gray, fontFamily:"inherit" }}>
                  📄 {item.name}
                </button>
              ))}
              <button onClick={() => { setCsvLoadFolder(null); setCsvLoadItems(null); }}
                style={{ marginTop:4, fontSize:10, color:M.gray6, background:"none", border:"none", cursor:"pointer", fontFamily:"inherit" }}>Lukk</button>
            </div>
          )}
        </section>

        {/* E: Kjør alle regler */}
        <section>
          {sectionLabel("Kjør alle regler")}
          {!hasIfc && <div style={{ fontSize:11, color:M.gray6, marginBottom:8 }}>Last inn en IFC-fil i IFC-kilde-seksjonen først.</div>}
          <button onClick={runAllRules} disabled={!hasIfc || runStatus === "running"}
            style={{ fontSize:12, padding:"8px 18px", borderRadius:4, border:"none", fontWeight:600, fontFamily:"inherit", display:"flex", alignItems:"center", gap:6,
              background:(!hasIfc||runStatus==="running") ? M.gray1 : M.blue,
              color:(!hasIfc||runStatus==="running") ? M.gray6 : M.white,
              cursor:(!hasIfc||runStatus==="running") ? "not-allowed" : "pointer" }}>
            {runStatus === "running" ? <><Icon.Spinner color={M.white}/> Kjører…</> : "▶ Kjør alle regler"}
          </button>
          {runLog.length > 0 && (
            <div style={{ marginTop:8, background:M.white, border:`1px solid ${M.gray0}`, borderRadius:4, padding:"8px 10px", fontSize:11, lineHeight:1.7, fontFamily:"monospace",
              color: runStatus === "error" ? M.red : M.gray }}>
              {runLog.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
          {runStatus === "done" && resultBytes && (
            <div style={{ marginTop:8, display:"flex", gap:8, flexWrap:"wrap" }}>
              <button onClick={downloadResult} style={btnStyle(M.green, true)}>↓ Last ned til PC</button>
              {tc && (
                <button onClick={() => { if (tcUploadState !== "done") setShowResultFolderPicker(true); }}
                  disabled={tcUploadState === "uploading"}
                  style={btnStyle(M.blue, true)}>
                  {tcUploadState === "uploading" ? <><Icon.Spinner color={M.blue}/> Laster opp…</> :
                   tcUploadState === "done" ? "✓ Lastet opp til TC" : "↑ Last opp til TC"}
                </button>
              )}
            </div>
          )}
        </section>

      </div>

      {showResultFolderPicker && <FolderPicker tc={tc} onSelect={uploadResultToTc} onClose={() => setShowResultFolderPicker(false)}/>}
      {showCsvSavePicker && <FolderPicker tc={tc} onSelect={saveCsvToTc} onClose={() => setShowCsvSavePicker(false)}/>}
      {showCsvLoadFolderPicker && <FolderPicker tc={tc} onSelect={loadCsvFolderSelected} onClose={() => setShowCsvLoadFolderPicker(false)}/>}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function IDSChecker() {
  const [page, setPage] = useState("home");
  const [tc, setTc] = useState(null);
  const { pyStatus, load: loadPyodide, validate: pyValidate, updateProperties: pyUpdateProperties } = usePyodide();
  const [devMode, setDevMode] = useState(false);
  const [loadedModels, setLoadedModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(null);
  const [uploadedIfc, setUploadedIfc] = useState(null);
  const [ifcTab, setIfcTab] = useState("upload");
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
  const [editingSpec, setEditingSpec] = useState(null);
  const timer = useTimer(isRunning);

  useEffect(() => {
    (async () => {
      // Load IDS files from Railway
      try {
        const res = await fetch(`${API_BASE}/ids-files`);
        if (res.ok) {
          const data = await res.json();
          setProjectIds(data.files || []);
        }
      } catch (e) {
        log.warn("Could not load IDS files from Railway:", e.message);
        if (devMode) setProjectIds(DEV_IDS);
      }

      const tcConn = await connectToTC();
      if (!tcConn) {
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

      // Preload Pyodide in background
      loadPyodide().catch(e => log.warn("Pyodide preload failed:", e.message));
    })();
  }, []);

  const activeIfc = ifcTab === "upload" ? uploadedIfc : selectedModel;
  const activeIds = idsTab === "upload" ? uploadedIds : selectedIds;
  const canRun = activeIds && (ifcTab === "upload" ? uploadedIfc : (ifcTab === "viewer" && selectedModel));
  // Marking works as long as a model is loaded in viewer – regardless of IFC upload tab
  const canMark = !devMode && tc && selectedModel;

  const handleMark = async (guids) => {
    if (!tc || !selectedModel) return { success: false, message: "Ingen modell valgt" };
    return await markObjectsInViewer(tc.api, selectedModel.modelId, guids);
  };

  const createTodo = async (spec, title, description, assigneeId = "") => {
    log.group("createTodo: " + spec.name);
    try {
      const token = tc.getAccessToken();
      const project = await tc.api.project.getCurrentProject();
      const region = project?.location === "europe" ? "app.eu" : "app";

      // Step 1: Mark failing objects in viewer so view captures them
      const guids = spec.failures.map(f => f.guid).filter(Boolean);
      if (guids.length > 0 && selectedModel) {
        log.info("Marking objects for view capture:", guids.length);
        await markObjectsInViewer(tc.api, selectedModel.modelId, guids);
        // Small delay to let viewer update
        await new Promise(r => setTimeout(r, 500));
      }

      const form = new FormData();
      form.append("tc_access_token", token);
      form.append("tc_region", region);
      form.append("tc_project_id", project.id);
      if (selectedModel?.tcHost) form.append("tc_host", selectedModel.tcHost);
      if (assigneeId) form.append("assignee_id", assigneeId);
      form.append("todos", JSON.stringify([{
        title,
        description,
        guids,
        modelId: selectedModel?.modelId || selectedModel?.fileId || "",
      }]));

      log.info("Creating todo:", title, "guids:", guids.length);
      const res = await fetch(`${API_BASE}/create-todos`, { method: "POST", body: form });
      const data = await res.json();
      log.ok("Result:", data);

      // Step 2: Create view from current viewer state and link to todo
      const todoId = data?.todos?.[0]?.id;
      if (todoId && tc.api.view?.createView) {
        log.info("Creating view linked to todo:", todoId);
        try {
          const view = await tc.api.view.createView({ todoId });
          log.ok("View created:", view);
        } catch (e) {
          log.warn("View creation failed (not critical):", e.message);
        }
      }

      log.end();
      return data;
    } catch (e) {
      log.error("createTodo failed:", e.message);
      log.end();
      throw e;
    }
  };

  const createTopic = async (spec, title, desc, assigneeId = "") => {
    log.group("createTopic: " + spec.name);
    try {
      const token = tc.getAccessToken();
      const project = await tc.api.project.getCurrentProject();
      const region = project?.location === "europe" ? "app.eu" : "app";

      const guids = spec.failures.map(f => f.guid).filter(Boolean);
      if (guids.length > 0 && selectedModel) {
        await markObjectsInViewer(tc.api, selectedModel.modelId, guids);
        await new Promise(r => setTimeout(r, 500));
      }

      const form = new FormData();
      form.append("tc_access_token", token);
      form.append("tc_region", region);
      form.append("tc_project_id", project.id);
      if (selectedModel?.tcHost) form.append("tc_host", selectedModel.tcHost);
      if (assigneeId) form.append("assignee_id", assigneeId);
      form.append("topics", JSON.stringify([{
        title,
        description: desc,
        guids,
        modelId: selectedModel?.modelId || selectedModel?.fileId || "",
      }]));

      log.info("Creating topic:", title, "guids:", guids.length);
      const res = await fetch(`${API_BASE}/create-topics`, { method: "POST", body: form });
      const data = await res.json();
      log.ok("Result:", data);
      log.end();
      return data;
    } catch (e) {
      log.error("createTopic failed:", e.message);
      log.end();
      throw e;
    }
  };

  const handleRun = async () => {
    setError(null);
    setResults(null);
    setIsRunning(true);
    log.group("handleRun");
    try {
      // Get IFC bytes
      let ifcBytes;
      if (ifcTab === "upload" && uploadedIfc) {
        setLoadingStep("Leser IFC-fil…");
        ifcBytes = await uploadedIfc.arrayBuffer();
        log.info("IFC upload:", uploadedIfc.name, ifcBytes.byteLength, "bytes");
      } else if (ifcTab === "viewer" && selectedModel) {
        setLoadingStep("Laster IFC fra TC…");
        const token = tc.getAccessToken();
        const project = await tc.api.project.getCurrentProject();
        const host = project?.location === "europe" ? "app21.connect.trimble.com" : "app.connect.trimble.com";
        const urlRes = await fetch(
          `https://${host}/tc/api/2.0/files/fs/${selectedModel.fileId}/downloadurl`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!urlRes.ok) throw new Error(`Kunne ikke hente nedlastings-URL: ${urlRes.status}`);
        const urlData = await urlRes.json();
        const dlUrl = urlData.url;
        if (!dlUrl) throw new Error("Ingen nedlastings-URL returnert");
        setLoadingStep("Laster ned IFC-fil fra TC…");
        const dlRes = await fetch(dlUrl);
        if (!dlRes.ok) throw new Error(`Nedlasting feilet: ${dlRes.status}`);
        ifcBytes = await dlRes.arrayBuffer();
        log.info("IFC from TC viewer:", selectedModel.name, ifcBytes.byteLength, "bytes");
      } else {
        throw new Error("Last opp en IFC-fil eller velg aktiv modell i viewer");
      }

      // Get IDS text
      let idsText;
      if (idsTab === "upload" && uploadedIds) {
        setLoadingStep("Leser IDS-fil…");
        idsText = await uploadedIds.text();
        log.info("IDS upload:", uploadedIds.name);
      } else if (idsTab === "project" && selectedIds) {
        setLoadingStep(`Laster IDS: ${selectedIds.name}…`);
        const res = await fetch(`${API_BASE}/ids-files/${selectedIds.name}`);
        if (!res.ok) throw new Error(`Kunne ikke laste IDS-fil: ${res.status}`);
        idsText = await res.text();
        log.info("IDS from Railway:", selectedIds.name);
      } else {
        throw new Error("Velg en IDS-fil for å validere");
      }

      // Load Pyodide if not ready (load() returns a promise)
      if (pyStatus !== "ready") {
        setLoadingStep("Laster Python-miljø (første gang tar ~30 sek)…");
        await loadPyodide();
      }

      // Run validation in Pyodide
      let data;
      try {
        data = await pyValidate(ifcBytes, idsText, setLoadingStep);
      } catch (e) {
        if (e.message?.includes("No schema named") || e.message?.includes("IFC4X3")) {
          // Fall back to Railway for unsupported schemas
          setLoadingStep("IFC4X3 – sender til Railway for validering…");
          log.warn("Pyodide schema error, falling back to Railway:", e.message);
          const form = new FormData();
          form.append("ifc_file", new File([ifcBytes], uploadedIfc.name));
          form.append("ids_file", new File([idsText], "rules.ids"));
          const res = await fetch(`${API_BASE}/validate`, { method: "POST", body: form });
          if (!res.ok) throw new Error(`Railway svarte med ${res.status}`);
          data = await res.json();
        } else {
          throw e;
        }
      }
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

  const header = (
    <div style={{ background:M.blueDark, padding:"0 16px", display:"flex", alignItems:"center", gap:10, height:48, flexShrink:0 }}>
      <button onClick={() => setPage("home")} style={{ background:"none", border:"none", color:M.white, cursor:"pointer", fontSize:16, padding:"0 4px 0 0", opacity:0.7, lineHeight:1 }}>←</button>
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
      <button onClick={() => window.location.reload()} title="Oppdater app" style={{background:"none",border:"none",color:M.white,cursor:"pointer",fontSize:16,padding:"0 0 0 4px",opacity:0.7,lineHeight:1}}>↺</button>
    </div>
  );

  const globalStyle = <style>{`@import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;500;600;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:${M.grayLight}}::-webkit-scrollbar-thumb{background:${M.gray1};border-radius:3px}@keyframes spin{to{transform:rotate(360deg)}}@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}`}</style>;

  if (page === "home") {
    return (
      <div style={{ fontFamily:"'Open Sans','Roboto',sans-serif", minHeight:"100vh", color:M.gray, display:"flex", flexDirection:"column" }}>
        {globalStyle}
        <HomePage onSelect={setPage} tc={tc} devMode={devMode}/>
      </div>
    );
  }

  if (page === "download") {
    return (
      <div style={{ fontFamily:"'Open Sans','Roboto',sans-serif", minHeight:"100vh", color:M.gray, display:"flex", flexDirection:"column" }}>
        {globalStyle}
        <DownloadPage tc={tc} onBack={() => setPage("home")}/>
      </div>
    );
  }

  if (page === "props") {
    return (
      <div style={{ fontFamily:"'Open Sans','Roboto',sans-serif", minHeight:"100vh", color:M.gray, display:"flex", flexDirection:"column" }}>
        {globalStyle}
        <PropertyEditorPage
          tc={tc}
          devMode={devMode}
          loadPyodide={loadPyodide}
          pyStatus={pyStatus}
          onBack={() => setPage("home")}
        />
      </div>
    );
  }

  if (editingSpec) {
    return (
      <div style={{ fontFamily:"'Open Sans','Roboto',sans-serif", background:M.grayLight, minHeight:"100vh", color:M.gray, display:"flex", flexDirection:"column" }}>
        {globalStyle}
        {header}
        <PropertyEditor spec={editingSpec} model={selectedModel} tc={tc} devMode={devMode} onBack={() => setEditingSpec(null)} pyUpdateProperties={pyUpdateProperties}/>
      </div>
    );
  }

  return (
    <div style={{ fontFamily:"'Open Sans','Roboto',sans-serif", background:M.grayLight, minHeight:"100vh", color:M.gray, display:"flex", flexDirection:"column" }}>
      {globalStyle}
      {header}

      <div style={{ flex:1, overflow:"auto", padding:14, display:"flex", flexDirection:"column", gap:14 }}>

        <section>
          <div style={{fontSize:10,fontWeight:700,color:M.gray6,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>1 · IFC-fil</div>
          <TabBar value={ifcTab} onChange={setIfcTab} options={[["viewer","Åpen i viewer"],["upload","Last opp"]]}/>
          {ifcTab === "viewer" ? (
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {/* Show active model */}
              {loadingModels ? (
                <div style={{display:"flex",gap:8,alignItems:"center",padding:"8px 0",color:M.gray6,fontSize:12}}><Icon.Spinner/> Henter modeller…</div>
              ) : loadedModels.length > 0 ? (
                <div style={{ background:M.bluePale, border:`1px solid ${M.blue}40`, borderRadius:4, padding:10 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:M.blue, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:6 }}>Aktiv modell i viewer</div>
                  {loadedModels.map(m => (
                    <div key={m.modelId} style={{ display:"flex", alignItems:"center", gap:8, fontSize:12, color:M.gray }}>
                      <Icon.File color={M.blue}/>
                      <span style={{ fontWeight:500 }}>{m.name}</span>
                    </div>
                  ))}
                  <div style={{ fontSize:11, color:M.blue, marginTop:6 }}>
                    ✓ Markering av objekter fungerer mot denne modellen
                  </div>
                </div>
              ) : (
                <div style={{ fontSize:11, color:M.gray6 }}>Ingen modell funnet i viewer</div>
              )}
              {/* Explain limitation */}
              <div style={{background:M.greenPale, border:`1px solid ${M.green}`, borderRadius:4, padding:10, fontSize:11, color:M.gray8, lineHeight:1.6}}>
                <strong>✓ IDS-validering støttes direkte fra viewer</strong><br/>
                Filen lastes ned fra TC til nettleseren og valideres lokalt – ingen data sendes til Railway.
              </div>
            </div>
          ) : (
            <UploadZone file={uploadedIfc} onFile={setUploadedIfc} accept=".ifc" label=".ifc-fil"/>
          )}
        </section>

        <section>
          <div style={{fontSize:10,fontWeight:700,color:M.gray6,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>2 · IDS-regelsett</div>
          <TabBar value={idsTab} onChange={setIdsTab} options={[["upload","Last opp"],["project","Tilgjengelige IDS-filer"]]}/>
          {idsTab === "project"
            ? projectIds.length === 0
              ? <div style={{fontSize:11,color:M.gray6,padding:"8px 0",lineHeight:1.6}}>
                  Ingen IDS-filer funnet.<br/>
                  <span style={{fontSize:10}}>Legg .ids-filer i <code>backend/ids/</code> og sørg for at Railway kjører.</span>
                </div>
              : projectIds.map(f => <IdsRow key={f.name} file={f} selected={selectedIds?.name===f.name} onSelect={setSelectedIds}/>)
            : <UploadZone file={uploadedIds} onFile={setUploadedIds} accept=".ids" label=".ids-fil"/>
          }
        </section>

        {pyStatus === "loading" && (
          <div style={{ fontSize:10, color:M.blue, display:"flex", alignItems:"center", gap:6, padding:"4px 0" }}>
            <Icon.Spinner color={M.blue}/> Laster Python-miljø…
          </div>
        )}
        {pyStatus === "error" && (
          <div style={{ fontSize:10, color:M.red, padding:"4px 0" }}>
            ⚠ Python-miljø feilet – prøv å laste siden på nytt
          </div>
        )}
        <button disabled={!canRun||isRunning} onClick={handleRun} style={{ padding:"10px 0", borderRadius:4, border:"none", cursor:canRun&&!isRunning?"pointer":"not-allowed", background:canRun&&!isRunning?M.blue:M.gray1, color:canRun&&!isRunning?M.white:M.gray6, fontFamily:"inherit", fontSize:13, fontWeight:600, display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"background 0.2s" }}>
          {isRunning ? <><Icon.Spinner color={M.white}/> {loadingStep}</> : "▶  Kjør IDS-sjekk"}
        </button>

        {isRunning && (
          <div style={{background:M.white,border:`1px solid ${M.gray0}`,borderRadius:4,padding:12,animation:"fadeUp 0.3s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:600,color:M.gray6,textTransform:"uppercase",letterSpacing:"0.06em"}}>Tid brukt</div>
              <div style={{display:"flex",alignItems:"center",gap:5}}><Icon.Clock/><div style={{fontSize:16,fontWeight:700,fontFamily:"monospace",color:M.blue}}>{timer}</div></div>
            </div>
            <div style={{borderTop:`1px solid ${M.grayLight}`,paddingTop:8,display:"flex",gap:8,alignItems:"flex-start"}}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{flexShrink:0,marginTop:1}}><circle cx="7" cy="7" r="6" stroke={M.yellowDark} strokeWidth="1.2"/><path d="M7 4.5V7" stroke={M.yellowDark} strokeWidth="1.2" strokeLinecap="round"/><circle cx="7" cy="9.5" r="0.7" fill={M.yellowDark}/></svg>
              <div style={{fontSize:11,color:M.gray8,lineHeight:1.5}}>Store IFC-filer kan ta <strong>1–3 minutter</strong>. Du kan jobbe videre i TC.</div>
            </div>
          </div>
        )}

        {error && (
          <div style={{background:M.redPale,border:`1px solid ${M.red}`,borderRadius:4,padding:12,fontSize:12,color:M.redDark}}>
            <strong>Feil:</strong> {error}
          </div>
        )}

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
              <SpecRow key={spec.name} spec={spec} index={i} onMark={canMark?handleMark:null} canMark={canMark} onEditProps={setEditingSpec} onCreateTodo={tc || devMode ? (spec, title, desc, assigneeId) => devMode ? Promise.resolve({created:1,errors:[]}) : createTodo(spec, title, desc, assigneeId) : null} onCreateTopic={tc ? (spec, title, desc, assigneeId) => createTopic(spec, title, desc, assigneeId) : null} tc={tc}/>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
