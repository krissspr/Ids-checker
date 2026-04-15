import ifcopenshell
from ifctester import ids


def run_ids_check(ifc_path: str, ids_path: str) -> dict:
    ifc_model = ifcopenshell.open(ifc_path)
    specs = ids.open(ids_path)
    specs.validate(ifc_model)

    result_specs = []

    for spec in specs.specifications:
        failing_instances = []

        for entity in spec.failed_entities:
            try:
                name = getattr(entity, 'Name', None) or "(uten navn)"
                guid = getattr(entity, 'GlobalId', None)
                ifc_type = entity.is_a() if hasattr(entity, 'is_a') else "ukjent"
            except Exception:
                name = str(entity)
                guid = None
                ifc_type = "ukjent"

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
        failed = len(spec.failed_entities)
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
            "status": "passed" if spec.status else "failed",
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
            })

    return result


def _extract_bounds(value_obj) -> dict:
    """Extract min/max bounds from a restriction object."""
    if value_obj is None:
        return {}
    if hasattr(value_obj, 'type') and getattr(value_obj, 'type', None) == 'bounds':
        opts = getattr(value_obj, 'options', {}) or {}
        return opts if isinstance(opts, dict) else {}
    return {}


def _build_krav_tekst(value_obj, enum_values, pattern, bounds, instructions, data_type) -> str:
    """Build a human-readable requirement description from IDS constraint."""
    parts = []

    # Enumeration
    if enum_values:
        parts.append(f"Tillatte verdier: {', '.join(enum_values)}")

    # Pattern
    elif pattern:
        if pattern in ('.+', '.+?', '.*', '.'):
            parts.append("Skal oppgis")
        else:
            parts.append(f"Mønster: {pattern}")

    # Bounds
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

    # Simple value
    elif value_obj is not None:
        simple = _get_value(value_obj)
        if simple:
            parts.append(f"Verdi: {simple}")
        else:
            parts.append("Skal oppgis")
    else:
        parts.append("Skal oppgis")

    # Instructions override/append
    if instructions:
        parts = [instructions]  # instructions takes full priority if set

    # Datatype suffix
    if data_type:
        parts.append(f"Datatype: {data_type}")

    return " | ".join(parts) if parts else "Skal oppgis"


def _extract_enum(value_obj) -> list:
    """Extract enumeration values from an IDS value/restriction object."""
    if value_obj is None:
        return []

    # If it's a Restriction object with enumeration type
    if hasattr(value_obj, 'type') and getattr(value_obj, 'type', None) == 'enumeration':
        opts = getattr(value_obj, 'options', [])
        if isinstance(opts, list):
            return [str(v) for v in opts]

    # If it's a dict representation
    if isinstance(value_obj, dict):
        # Check for restriction with enumeration
        restriction = value_obj.get('restriction', [])
        if isinstance(restriction, list):
            enums = []
            for r in restriction:
                if isinstance(r, dict) and r.get('@base') == 'xs:string':
                    for item in r.get('xs:enumeration', []):
                        if isinstance(item, dict):
                            enums.append(item.get('@value', ''))
                        else:
                            enums.append(str(item))
            if enums:
                return enums

    # If it's already a list (some versions of ifctester)
    if isinstance(value_obj, list):
        return [str(v) for v in value_obj]

    return []


def _extract_pattern(value_obj) -> str:
    """Extract pattern from an IDS value/restriction object."""
    if value_obj is None:
        return None
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
