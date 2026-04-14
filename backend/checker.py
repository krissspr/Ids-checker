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
            failing_instances.append({
                "guid": guid,
                "type": ifc_type,
                "name": name,
            })

        passed = len(spec.passed_entities)
        failed = len(spec.failed_entities)
        total = passed + failed

        # Extract all requirements with enum options
        requirements_detail = _extract_requirements(spec)

        result_specs.append({
            "name": spec.name,
            "status": "passed" if spec.status else "failed",
            "applicability": _describe_applicability(spec),
            "requirement": _describe_requirements(spec),
            "requirements_detail": requirements_detail,
            "passed": passed,
            "failed": failed,
            "total": total,
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
    """
    Extracts all requirements from a spec with full detail including
    enum options when available.

    Returns list of dicts:
    {
        "type": "Property" | "Attribute" | "Classification" | "Material",
        "pset": "Pset_WallCommon",
        "name": "FireRating",
        "enum_values": ["REI30", "REI60", "REI90"],  # empty if no enum
        "pattern": None,  # regex pattern if applicable
        "description": "Pset_WallCommon.FireRating",
    }
    """
    result = []

    for req in spec.requirements:
        class_name = req.__class__.__name__

        if class_name == "Property":
            pset = _get_value(getattr(req, "propertySet", ""))
            prop = _get_value(getattr(req, "baseName", ""))
            enum_values = _extract_enum(getattr(req, "value", None))
            pattern = _extract_pattern(getattr(req, "value", None))
            instructions = getattr(req, "instructions", None) or ""

            result.append({
                "type": "Property",
                "pset": pset,
                "name": prop,
                "enum_values": enum_values,
                "pattern": pattern,
                "instructions": str(instructions) if instructions else "",
                "description": f"{pset}.{prop}",
            })

        elif class_name == "Attribute":
            attr_name = _get_value(getattr(req, "name", ""))
            enum_values = _extract_enum(getattr(req, "value", None))
            instructions = getattr(req, "instructions", None) or ""
            result.append({
                "type": "Attribute",
                "pset": None,
                "name": attr_name,
                "enum_values": enum_values,
                "pattern": None,
                "instructions": str(instructions) if instructions else "",
                "description": attr_name,
            })

        elif class_name == "Classification":
            result.append({
                "type": "Classification",
                "pset": None,
                "name": "Classification",
                "enum_values": [],
                "pattern": None,
                "description": "Klassifisering påkrevd",
            })

        elif class_name == "Material":
            result.append({
                "type": "Material",
                "pset": None,
                "name": "Material",
                "enum_values": [],
                "pattern": None,
                "description": "Materiale påkrevd",
            })

    return result


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
