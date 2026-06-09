import ifcopenshell
from ifctester import ids

_EXCLUDED_IFC_TYPES = frozenset({"IfcPresentationLayerAssignment"})


def run_ids_check(ifc_path: str, ids_path: str) -> dict:
    ifc_model = ifcopenshell.open(ifc_path)
    specs = ids.open(ids_path)
    specs.validate(ifc_model)

    result_specs = []

    for spec in specs.specifications:
        failing_instances = []
        excluded_count = 0

        for entity in spec.failed_entities:
            try:
                ifc_type = entity.is_a() if hasattr(entity, 'is_a') else "ukjent"
            except Exception:
                ifc_type = "ukjent"

            try:
                guid = getattr(entity, 'GlobalId', None)
            except Exception:
                guid = None

            print(f"  failed entity: type={ifc_type} guid={guid}", flush=True)

            if ifc_type in _EXCLUDED_IFC_TYPES or guid is None:
                excluded_count += 1
                continue

            try:
                name = getattr(entity, 'Name', None) or "(uten navn)"
            except Exception:
                name = str(entity)

            # Detect datatype failures by checking all requirement facets
            datatype_issue = False
            reason_text = ""
            try:
                for req in spec.requirements:
                    # IfcTester stores reasons per-facet, not per-entity
                    # Check both failed_reasons and any results attribute
                    reasons = []
                    for attr in ['failed_reasons', 'results', 'failures']:
                        val = getattr(req, attr, None)
                        if val:
                            reasons = val if isinstance(val, list) else [val]
                            break

                    for reason in reasons:
                        r = str(reason)
                        print(f"  reason: {r[:150]}", flush=True)
                        if any(kw in r.lower() for kw in [
                            "datatype", "data type", "ifclabel", "ifctext",
                            "ifcinteger", "ifcreal", "ifcboolean", "type mismatch",
                            "incorrect data type", "wrong type", "expected type",
                        ]):
                            datatype_issue = True
                            reason_text = r[:200]
                            break
            except Exception as e:
                print(f"  datatype check error: {e}", flush=True)

            failing_instances.append({
                "guid": guid,
                "type": ifc_type,
                "name": name,
                "datatype_issue": datatype_issue,
                "reason": reason_text,
            })

        passed = len(spec.passed_entities)
        failed = len(spec.failed_entities) - excluded_count
        total = passed + failed

        # Detect "no objects found" – spec applies to nothing
        no_objects = total == 0

        requirements_detail = _extract_requirements(spec)
        applicability_detail = _extract_applicability_detail(spec)

        # Which requirement names actually have failures (for optional filtering)
        failed_req_names = set()
        for req in spec.requirements:
            if getattr(req, 'failed_reasons', None):
                prop = _get_value(getattr(req, "baseName", "")) or _get_value(getattr(req, "name", ""))
                if prop:
                    failed_req_names.add(prop)

        result_specs.append({
            "name": spec.name,
            "status": "passed" if failed == 0 else "failed",
            "applicability": _describe_applicability(spec),
            "applicability_detail": applicability_detail,
            "requirement": _describe_requirements(spec),
            "requirements_detail": requirements_detail,
            "failed_req_names": list(failed_req_names),
            "passed": passed,
            "failed": failed,
            "total": total,
            "no_objects": no_objects,
            "failures": failing_instances[:50],
            "more_failures": max(0, len(failing_instances) - 50),
        })

    total_passed = sum(1 for s in result_specs if s["status"] == "passed")
    total_failed = sum(1 for s in result_specs if s["status"] == "failed")

    return {
        "summary": {
            "passed": total_passed,
            "failed": total_failed,
            "total": total_passed + total_failed,
        },
        "specifications": result_specs,
    }


def _req_failing(req) -> list:
    """Return [{guid, name, type}] for entities that failed this specific requirement facet."""
    failed = getattr(req, "failed_entities", None) or set()
    result = []
    for entity in failed:
        try:
            ifc_type = entity.is_a() if hasattr(entity, "is_a") else "ukjent"
            if ifc_type in _EXCLUDED_IFC_TYPES:
                continue
            result.append({
                "guid": getattr(entity, "GlobalId", None),
                "name": getattr(entity, "Name", None) or "(uten navn)",
                "type": ifc_type,
            })
        except Exception:
            pass
    return result


def _extract_requirements(spec) -> list:
    result = []

    for req in spec.requirements:
        class_name = req.__class__.__name__

        if class_name == "Property":
            pset = _get_value(getattr(req, "propertySet", ""))
            prop = _get_value(getattr(req, "baseName", ""))
            value_obj = getattr(req, "value", None)
            cardinality = getattr(req, "cardinality", "required") or "required"
            instructions = str(getattr(req, "instructions", "") or "")
            data_type = str(getattr(req, "dataType", "") or "")

            if cardinality == "optional":
                continue

            enum_values = _extract_enum(value_obj)
            pattern = _extract_pattern(value_obj)
            bounds = _extract_bounds(value_obj)
            krav_tekst = _build_krav_tekst(value_obj, enum_values, pattern, bounds, instructions, data_type)
            print(f"  {prop}: value_obj_type={type(value_obj).__name__} restriction_type={getattr(value_obj,'type',None)} options={getattr(value_obj,'options',None)} enum={enum_values} pattern={pattern} bounds={bounds} → krav={krav_tekst}", flush=True)

            result.append({
                "type": "Property",
                "pset": pset,
                "name": prop,
                "enum_values": enum_values,
                "pattern": pattern,
                "bounds": bounds,
                "data_type": data_type,
                "instructions": instructions,
                "cardinality": cardinality,
                "krav_tekst": krav_tekst,
                "description": f"{pset}.{prop}",
                "failing": _req_failing(req),
            })

        elif class_name == "Attribute":
            attr_name = _get_value(getattr(req, "name", ""))
            value_obj = getattr(req, "value", None)
            cardinality = getattr(req, "cardinality", "required") or "required"
            instructions = str(getattr(req, "instructions", "") or "")
            data_type = str(getattr(req, "dataType", "") or "")

            if cardinality == "optional":
                continue

            enum_values = _extract_enum(value_obj)
            pattern = _extract_pattern(value_obj)
            bounds = _extract_bounds(value_obj)
            krav_tekst = _build_krav_tekst(value_obj, enum_values, pattern, bounds, instructions, data_type)

            result.append({
                "type": "Attribute",
                "pset": None,
                "name": attr_name,
                "enum_values": enum_values,
                "pattern": pattern,
                "bounds": bounds,
                "data_type": data_type,
                "instructions": instructions,
                "cardinality": cardinality,
                "krav_tekst": krav_tekst,
                "description": attr_name,
                "failing": _req_failing(req),
            })

        elif class_name == "Classification":
            result.append({
                "type": "Classification",
                "pset": None,
                "name": "Classification",
                "enum_values": [],
                "pattern": None,
                "bounds": {},
                "data_type": "",
                "instructions": "",
                "cardinality": "required",
                "krav_tekst": "Klassifisering påkrevd",
                "description": "Klassifisering påkrevd",
                "failing": _req_failing(req),
            })

        elif class_name == "Material":
            result.append({
                "type": "Material",
                "pset": None,
                "name": "Material",
                "enum_values": [],
                "pattern": None,
                "bounds": {},
                "data_type": "",
                "instructions": "",
                "cardinality": "required",
                "krav_tekst": "Materiale påkrevd",
                "description": "Materiale påkrevd",
                "failing": _req_failing(req),
            })

    return result


def _extract_bounds(value_obj) -> dict:
    """Extract min/max bounds from a restriction object."""
    if value_obj is None:
        return {}

    # Restriction object with type='bounds'
    if hasattr(value_obj, 'type') and getattr(value_obj, 'type', None) == 'bounds':
        opts = getattr(value_obj, 'options', {}) or {}
        if isinstance(opts, dict):
            return opts

    # Restriction object where options is a dict directly
    if hasattr(value_obj, 'options'):
        opts = getattr(value_obj, 'options', {})
        if isinstance(opts, dict) and any(k in opts for k in [
            'minExclusive', 'minInclusive', 'maxExclusive', 'maxInclusive'
        ]):
            return opts

    # String representation contains bounds keywords – parse it
    raw = str(value_obj)
    if any(k in raw for k in ['minExclusive', 'minInclusive', 'maxExclusive', 'maxInclusive']):
        import re
        result = {}
        for key in ['minExclusive', 'minInclusive', 'maxExclusive', 'maxInclusive']:
            m = re.search(rf"'{key}':\s*'?([0-9.]+)'?", raw) or \
                re.search(rf'"{key}":\s*"?([0-9.]+)"?', raw)
            if m:
                try:
                    result[key] = float(m.group(1))
                except ValueError:
                    result[key] = m.group(1)
        if result:
            return result

    return {}


def _build_krav_tekst(value_obj, enum_values, pattern, bounds, instructions, data_type) -> str:
    """Build a human-readable requirement description from IDS constraint."""
    parts = []

    if enum_values:
        parts.append(f"Skal være en av følgende verdier: [{', '.join(enum_values)}]")

    elif bounds:
        b = []
        if 'minExclusive' in bounds:
            b.append(f"Større enn {bounds['minExclusive']}")
        if 'minInclusive' in bounds:
            b.append(f"Minst {bounds['minInclusive']}")
        if 'maxExclusive' in bounds:
            b.append(f"Mindre enn {bounds['maxExclusive']}")
        if 'maxInclusive' in bounds:
            b.append(f"Maks {bounds['maxInclusive']}")
        if b:
            parts.append(", ".join(b))
        else:
            parts.append("Skal fylles ut")

    elif pattern:
        # Any pattern means "must be filled in" – don't expose regex to user
        parts.append("Skal fylles ut")

    elif value_obj is not None:
        simple = _get_value(value_obj)
        # If value looks like a regex pattern or is empty, show "Skal fylles ut"
        import re as _re
        is_pattern = bool(simple and _re.search(r'[.+*?\\[\]{}()|^$]', simple))
        if simple and not is_pattern and not simple.startswith('('):
            parts.append(f"Verdi: {simple}")
        else:
            parts.append("Skal fylles ut")

    else:
        parts.append("Skal fylles ut")

    # Datatype suffix
    if data_type:
        parts.append(f"Datatype: {data_type}")

    return " | ".join(parts) if parts else "Skal fylles ut"


def _extract_enum(value_obj) -> list:
    """Extract enumeration values from an IDS value/restriction object."""
    if value_obj is None:
        return []

    # New ifctester: options is a dict with type as key, e.g. {'enumeration': ['H1', 'H2']}
    if hasattr(value_obj, 'options'):
        opts = value_obj.options
        if isinstance(opts, dict) and 'enumeration' in opts:
            return [str(v) for v in opts['enumeration']]
        if isinstance(opts, list):
            return [str(v) for v in opts]

    # Old ifctester: type attribute set to 'enumeration'
    if hasattr(value_obj, 'type') and getattr(value_obj, 'type', None) == 'enumeration':
        opts = getattr(value_obj, 'options', [])
        if isinstance(opts, list):
            return [str(v) for v in opts]

    # If it's already a list
    if isinstance(value_obj, list):
        return [str(v) for v in value_obj]

    return []


def _extract_pattern(value_obj) -> str:
    """Extract pattern from an IDS value/restriction object."""
    if value_obj is None:
        return None
    # New ifctester: options is {'pattern': '...'}
    if hasattr(value_obj, 'options'):
        opts = value_obj.options
        if isinstance(opts, dict) and 'pattern' in opts:
            return str(opts['pattern'])
    # Old ifctester: type == 'pattern'
    if hasattr(value_obj, 'type') and getattr(value_obj, 'type', None) == 'pattern':
        return str(getattr(value_obj, 'options', ''))
    return None


def _get_value(attr) -> str:
    if attr is None:
        return ""
    if isinstance(attr, str):
        return attr
    if isinstance(attr, dict):
        return attr.get("simpleValue", "") or attr.get("value", "")
    # Handle Restriction objects that have a simpleValue
    if hasattr(attr, 'simpleValue'):
        return str(attr.simpleValue)
    return str(attr)


def _extract_applicability_detail(spec) -> dict:
    """Extract pset name and Objekttype value from applicability facets."""
    result = {"pset": None, "objekttype": None, "entity": None}
    for facet in spec.applicability:
        class_name = facet.__class__.__name__
        if class_name == "Entity":
            result["entity"] = _get_value(getattr(facet, "name", ""))
        elif class_name == "Property":
            pset = _get_value(getattr(facet, "propertySet", ""))
            prop = _get_value(getattr(facet, "baseName", ""))
            value = _get_value(getattr(facet, "value", ""))
            result["pset"] = pset
            if prop.lower() in ("objekttype", "type", "objecttype"):
                result["objekttype"] = value
    return result


def _describe_applicability(spec) -> str:
    parts = []
    for facet in spec.applicability:
        class_name = facet.__class__.__name__
        if class_name == "Entity":
            parts.append(_get_value(getattr(facet, "name", "")))
        elif class_name == "Classification":
            parts.append(f"Klassifikasjon: {_get_value(getattr(facet, 'value', ''))}")
        elif class_name == "Property":
            pset = _get_value(getattr(facet, "propertySet", ""))
            prop = _get_value(getattr(facet, "baseName", ""))
            parts.append(f"{pset}.{prop}")
        else:
            parts.append(class_name)
    return ", ".join(filter(None, parts)) or "Alle objekter"


def _describe_requirements(spec) -> str:
    parts = []
    for req in spec.requirements:
        class_name = req.__class__.__name__
        if class_name == "Property":
            pset = _get_value(getattr(req, "propertySet", ""))
            prop = _get_value(getattr(req, "baseName", ""))
            value = _get_value(getattr(req, "value", ""))
            if value:
                parts.append(f"{pset}.{prop} = {value}")
            else:
                parts.append(f"{pset}.{prop} er påkrevd")
        elif class_name == "Attribute":
            parts.append(f"{_get_value(getattr(req, 'name', ''))} er påkrevd")
        elif class_name == "Classification":
            parts.append("Klassifisering er påkrevd")
        elif class_name == "Material":
            parts.append("Materiale er påkrevd")
        else:
            parts.append(class_name)
    return "; ".join(filter(None, parts)) or "Se IDS-fil"
