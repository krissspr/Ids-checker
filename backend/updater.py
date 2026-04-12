import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.element
import httpx
import os


def update_properties(
    ifc_path: str,
    out_path: str,
    pset_name: str,
    prop_name: str,
    prop_value: str,
    guids: list,
) -> int:
    """
    Opens an IFC file, sets pset_name.prop_name = prop_value
    on all entities matching the given GUIDs, saves to out_path.
    Returns number of entities updated.
    """
    model = ifcopenshell.open(ifc_path)
    updated = 0

    for guid in guids:
        try:
            entity = model.by_guid(guid)
        except Exception:
            continue
        if entity is None:
            continue

        pset_obj = _get_pset_object(model, entity, pset_name)
        if pset_obj:
            ifcopenshell.api.run(
                "pset.edit_pset", model,
                pset=pset_obj,
                properties={prop_name: prop_value},
            )
        else:
            pset_obj = ifcopenshell.api.run(
                "pset.add_pset", model,
                product=entity,
                name=pset_name,
            )
            ifcopenshell.api.run(
                "pset.edit_pset", model,
                pset=pset_obj,
                properties={prop_name: prop_value},
            )
        updated += 1

    model.write(out_path)
    return updated


def _get_pset_object(model, entity, pset_name: str):
    for rel in getattr(entity, "IsDefinedBy", []):
        if rel.is_a("IfcRelDefinesByProperties"):
            pset = rel.RelatingPropertyDefinition
            if pset.is_a("IfcPropertySet") and pset.Name == pset_name:
                return pset
    return None


async def upload_to_tc(
    ifc_path: str,
    filename: str,
    access_token: str,
    region: str,
    project_id: str,
    parent_folder_id: str = None,
) -> dict:
    """
    Uploads a file to Trimble Connect using the two-step upload process:
    1. POST /files  → creates a file record, gets an upload URL
    2. PUT upload URL → uploads the actual file content

    Returns the created file object from TC.
    """
    base_url = f"https://{region}.connect.trimble.com/tc/api/2.0"
    headers = {"Authorization": f"Bearer {access_token}"}
    file_size = os.path.getsize(ifc_path)

    # Step 1: Create file record in TC
    payload = {
        "name": filename,
        "projectId": project_id,
        "size": file_size,
        "contentType": "application/octet-stream",
    }
    if parent_folder_id:
        payload["parentId"] = parent_folder_id

    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.post(
            f"{base_url}/files",
            json=payload,
            headers=headers,
        )
        if res.status_code not in (200, 201):
            raise Exception(f"TC create file failed: {res.status_code} {res.text}")

        file_record = res.json()
        upload_url = file_record.get("uploadUrl") or file_record.get("url")

        if not upload_url:
            raise Exception(f"No upload URL in TC response: {file_record}")

        # Step 2: Upload the actual file content
        with open(ifc_path, "rb") as f:
            file_content = f.read()

        upload_res = await client.put(
            upload_url,
            content=file_content,
            headers={"Content-Type": "application/octet-stream"},
        )
        if upload_res.status_code not in (200, 201, 204):
            raise Exception(f"TC file upload failed: {upload_res.status_code}")

    return file_record
