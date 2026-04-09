import ifcopenshell
from ifctester import ids, reporter
import json


def run_ids_check(ifc_path: str, ids_path: str) -> dict:
    """
    Runs IfcTester validation and returns a structured dict with:
    - summary: total passed/failed counts
    - specifications: list of each IDS spec with results and failing instances
    """
    # Load IFC model
    ifc_model = ifcopenshell.open(ifc_path)

    # Load and parse IDS file
    specs = ids.open(ids_path)

    # Run validation
    specs.validate(ifc_model)

    # Build structured response
    result_specs = []

    for spec in specs.specifications:
        failing_instances = []

        for requirement in spec.requirements:
            for ifc_entity, results in requirement.failed_entities.items():
                for entity in results:
                    # Get a human-readable name for the failing object
                    name = getattr(entity, "Name", None) or getattr(entity, "LongName", None)
                    guid = getattr(entity, "GlobalId", None)

                    failing_instances.append({
                        "guid": guid,
                        "type": entity.is_a(),
                        "name": name or "(uten navn)",
                    })

        total = spec.passed_count + spec.failed_count
        result_specs.append({
            "name": spec.name,
            "status": "passed" if spec.status else "failed",
            "applicability": _describe_applicability(spec),
            "requirement": _describe_requirements(spec),
            "passed": spec.passed_count,
            "failed": spec.failed_count,
            "total": total,
            "failures": failing_instances[:50],  # cap at 50 per spec
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
            pset = getattr(facet, "propertySet", {}).get("simpleValue", "")
            prop = getattr(facet, "baseName", {}).get("simpleValue", "")
            parts.append(f"{pset}.{prop}")
        else:
            parts.append(class_name)
    return ", ".join(filter(None, parts)) or "Alle objekter"


def _describe_requirements(spec) -> str:
    """Returns a human-readable requirements description."""
    parts = []
    for req in spec.requirements:
        class_name = req.__class__.__name__
        if class_name == "Property":
            pset = getattr(req, "propertySet", {}).get("simpleValue", "")
            prop = getattr(req, "baseName", {}).get("simpleValue", "")
            value = getattr(req, "value", None)
            if value:
                val_str = value.get("simpleValue", "")
                parts.append(f"{pset}.{prop} = {val_str}")
            else:
                parts.append(f"{pset}.{prop} er påkrevd")
        elif class_name == "Attribute":
            name = getattr(req, "name", {}).get("simpleValue", "")
            parts.append(f"{name} er påkrevd")
        elif class_name == "Classification":
            parts.append("Klassifisering er påkrevd")
        elif class_name == "Material":
            parts.append("Materiale er påkrevd")
        else:
            parts.append(class_name)
    return "; ".join(filter(None, parts)) or "Se IDS-fil for detaljer"
