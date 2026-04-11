import ifcopenshell
from ifctester import ids, reporter
import json


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

        result_specs.append({
            "name": spec.name,
            "status": "passed" if spec.status else "failed",
            "applicability": _describe_applicability(spec),
            "requirement": _describe_requirements(spec),
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

def _get_value(attr):
    """Safely extract a value regardless of whether it's a string or dict."""
    if attr is None:
        return ""
    if isinstance(attr, str):
        return attr
    if isinstance(attr, dict):
        return attr.get("simpleValue", "") or attr.get("value", "")
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
def _describe_applicability(spec) -> str:
    """Returns a human-readable applicability description."""
    parts = []
    for facet in spec.applicability:
        class_name = facet.__class__.__name__
        if class_name == "Entity":
            parts.append(getattr(facet, "name", {}).get("simpleValue", ""))
        elif class_name == "Classification":
            parts.append(f"Klassifikasjon: {getattr(facet, 'value', {}).get('simpleValue', '')}")
        elif class_name == "Property":
            pset_obj = getattr(facet, "propertySet", {})
            if isinstance(pset_obj, dict):
                pset = pset_obj.get("simpleValue", "")
            else:
                pset = str(pset_obj)
            prop_obj = getattr(facet, "baseName", {})
            if isinstance(prop_obj, dict):
                prop = prop_obj.get("simpleValue", "")
            else:
                prop = str(prop_obj)
            parts.append(f"{pset}.{prop}")
        else:
            parts.append(class_name)
    return ", ".join(filter(None, parts)) or "Alle objekter"


