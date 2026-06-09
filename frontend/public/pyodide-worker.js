/* Pyodide Web Worker — runs IFC/IDS validation off the main thread */
importScripts("https://cdn.jsdelivr.net/pyodide/v0.28.3/full/pyodide.js");

let pyodide = null;

async function initPyodide() {
    pyodide = await loadPyodide({
        indexURL: "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/",
    });
    self.postMessage({ type: "step", message: "Installerer pakker…" });
    await pyodide.loadPackage(["micropip", "numpy"]);
    await pyodide.runPythonAsync(`
import micropip
await micropip.install(
  "https://ifcopenshell.github.io/wasm-wheels/ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl",
  keep_going=True
)
await micropip.install(["elementpath", "xmlschema", "ifctester"], deps=False)
`);
}

const VALIDATE_PY = `
import json, ifcopenshell, ifcopenshell.express
from ifctester import ids

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

_EXCLUDED_IFC_TYPES = frozenset({"IfcPresentationLayerAssignment"})

# DEBUG: print per-requirement failures to find which req actually fires
for spec in specs.specifications:
    if spec.status:
        continue
    print(f"DEBUG SPEC FAIL: {spec.name}")
    for req in spec.requirements:
        cn = req.__class__.__name__
        prop = getattr(req, "baseName", None)
        pset = getattr(req, "propertySet", None)
        prop_str = str(prop) if prop else cn
        pset_str = str(pset) if pset else ""
        failed_ents = getattr(req, "failed_entities", set())
        reasons = getattr(req, "failed_reasons", []) or []
        print(f"  REQ {pset_str}.{prop_str}: failed={len(failed_ents)} reasons={[str(r)[:120] for r in list(reasons)[:3]]}")

result_specs = []
for spec in specs.specifications:
    failing = []
    excluded_count = 0
    for entity in spec.failed_entities:
        try:
            ifc_type = entity.is_a()
        except:
            ifc_type = "ukjent"

        try:
            guid = getattr(entity, "GlobalId", None)
        except:
            guid = None

        if ifc_type in _EXCLUDED_IFC_TYPES or guid is None:
            excluded_count += 1
            continue

        try:
            name = getattr(entity, "Name", None) or "(uten navn)"
        except:
            name = str(entity)

        datatype_issue = False
        for req in spec.requirements:
            for reason in (getattr(req, "failed_reasons", []) or []):
                r = str(reason).lower()
                if any(kw in r for kw in ["datatype","ifclabel","ifctext","ifcreal","ifcinteger","type mismatch"]):
                    datatype_issue = True
                    break

        failing.append({"guid": guid, "type": ifc_type, "name": name, "datatype_issue": datatype_issue, "reason": ""})

    passed = len(spec.passed_entities)
    failed = len(spec.failed_entities) - excluded_count
    total = passed + failed

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
                opts = getattr(val_obj, "options", None)
                if isinstance(opts, dict):
                    if "enumeration" in opts:
                        enum_vals = [str(v) for v in opts["enumeration"]]
                    elif "pattern" in opts:
                        pattern = str(opts["pattern"])
                    elif any(k in opts for k in ["minExclusive", "minInclusive", "maxExclusive", "maxInclusive"]):
                        bounds = {k: opts[k] for k in ["minExclusive", "minInclusive", "maxExclusive", "maxInclusive"] if k in opts}
                elif isinstance(opts, list):
                    enum_vals = [str(v) for v in opts]
                else:
                    t = getattr(val_obj, "type", None)
                    if t == "enumeration" and opts:
                        enum_vals = [str(v) for v in opts]
                    elif t == "pattern" and opts:
                        pattern = str(opts)
                    elif t == "bounds" and isinstance(opts, dict):
                        bounds = opts
            if enum_vals:
                krav = f"Skal v\xe6re en av f\xf8lgende verdier: [{', '.join(str(v) for v in enum_vals)}]"
            elif bounds:
                parts = []
                if "minExclusive" in bounds: parts.append(f"St\xf8rre enn {bounds['minExclusive']}")
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
            _req_ents = list(getattr(req, 'failed_entities', set()) or set())
            if not _req_ents:
                # Newer ifctester does not populate req.failed_entities —
                # call the facet directly on each spec-level failing entity
                for _e in spec.failed_entities:
                    try:
                        if not bool(req(_e)):
                            _req_ents.append(_e)
                    except Exception:
                        pass
            _req_failing = []
            for _e in _req_ents:
                try:
                    _e_type = _e.is_a()
                    _e_guid = getattr(_e, "GlobalId", None)
                    if _e_type in _EXCLUDED_IFC_TYPES or _e_guid is None:
                        continue
                    _req_failing.append({"guid": _e_guid, "name": getattr(_e, "Name", None) or "(uten navn)", "type": _e_type})
                except Exception:
                    pass
            reqs.append({"type": "Property", "pset": pset, "name": prop, "enum_values": enum_vals, "pattern": pattern, "bounds": bounds, "data_type": data_type, "instructions": instructions, "cardinality": card, "krav_tekst": krav, "description": f"{pset}.{prop}", "failing": _req_failing})

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
        "status": "passed" if failed == 0 else "failed",
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
`;

const UPDATE_PY = `
import json, ifcopenshell, ifcopenshell.api, ifcopenshell.util.element

req_list = json.loads(requirements_json)
guid_list = json.loads(guids_json)

def cast_value(value, data_type, schema):
    if not data_type:
        return value
    dt = data_type.strip()
    try:
        ifc_type = schema.declaration_by_name(dt)
        if ifc_type:
            return ifc_type(value)
    except Exception:
        pass
    if dt in ("IfcReal", "IfcLengthMeasure", "IfcAreaMeasure", "IfcVolumeMeasure",
              "IfcMassMeasure", "IfcPositiveLengthMeasure", "IfcPlaneAngleMeasure"):
        return float(value)
    if dt in ("IfcInteger", "IfcCountMeasure"):
        return int(value)
    if dt == "IfcBoolean":
        return value.lower() in ("true", "1", "ja", "yes")
    return value

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

        try:
            typed_value = cast_value(prop_value, data_type, ifc_schema)
        except Exception:
            typed_value = prop_value

        psets = ifcopenshell.util.element.get_psets(entity)
        if pset_name in psets:
            pset_obj = model.by_id(psets[pset_name]["id"])
            ifcopenshell.api.run("pset.edit_pset", model, pset=pset_obj, properties={prop_name: typed_value})
        else:
            pset_obj = ifcopenshell.api.run("pset.add_pset", model, product=entity, name=pset_name)
            ifcopenshell.api.run("pset.edit_pset", model, pset=pset_obj, properties={prop_name: typed_value})

    updated += 1

model.write("/model_korrigert.ifc")
print(f"Updated {updated} objects")
`;

self.onmessage = async (e) => {
    const { type, ...payload } = e.data;

    if (type === "load") {
        try {
            self.postMessage({ type: "step", message: "Laster Python-miljø…" });
            await initPyodide();
            self.postMessage({ type: "ready" });
        } catch (err) {
            self.postMessage({ type: "error", context: "load", message: String(err) });
        }
        return;
    }

    if (!pyodide) {
        self.postMessage({ type: "error", context: type, message: "Pyodide ikke klar" });
        return;
    }

    if (type === "validate") {
        try {
            self.postMessage({ type: "step", message: "Skriver IFC til filsystem…" });
            pyodide.FS.writeFile("/model.ifc", new Uint8Array(payload.ifcBytes));
            pyodide.FS.writeFile("/rules.ids", new TextEncoder().encode(payload.idsText));
            self.postMessage({ type: "step", message: "Kjører IDS-validering…" });
            const result = await pyodide.runPythonAsync(VALIDATE_PY);
            self.postMessage({ type: "validate_result", data: JSON.parse(result) });
        } catch (err) {
            self.postMessage({ type: "error", context: "validate", message: String(err) });
        }
        return;
    }

    if (type === "run_python") {
        try {
            for (const {path, data} of (payload.files || [])) {
                pyodide.FS.writeFile(path, data instanceof Uint8Array ? data : new Uint8Array(data));
            }
            for (const [key, value] of Object.entries(payload.globals || {})) {
                pyodide.globals.set(key, value);
            }
            const result = await pyodide.runPythonAsync(payload.code);
            self.postMessage({ type: "python_result", result: String(result) });
        } catch (err) {
            self.postMessage({ type: "error", context: "run_python", message: String(err) });
        }
        return;
    }

    if (type === "fs_read") {
        try {
            const bytes = pyodide.FS.readFile(payload.path);
            self.postMessage({ type: "fs_read_result", bytes: bytes.buffer }, [bytes.buffer]);
        } catch (err) {
            self.postMessage({ type: "error", context: "fs_read", message: String(err) });
        }
        return;
    }

    if (type === "update_properties") {
        try {
            self.postMessage({ type: "step", message: "Redigerer egenskaper i IFC…" });
            pyodide.globals.set("requirements_json", JSON.stringify(payload.requirements));
            pyodide.globals.set("guids_json", JSON.stringify(payload.guids));
            await pyodide.runPythonAsync(UPDATE_PY);
            const outBytes = pyodide.FS.readFile("/model_korrigert.ifc");
            self.postMessage({ type: "update_result", bytes: outBytes.buffer }, [outBytes.buffer]);
        } catch (err) {
            self.postMessage({ type: "error", context: "update_properties", message: String(err) });
        }
        return;
    }
};
