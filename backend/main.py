from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask
import tempfile
import os
import json
import traceback
import httpx
from checker import run_ids_check
from updater import update_properties, upload_to_tc

app = FastAPI(title="IDS Checker API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    tb = traceback.format_exc()
    print(f"UNHANDLED ERROR: {exc}\n{tb}", flush=True)
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc), "traceback": tb},
    )


@app.on_event("startup")
async def startup():
    print("=== IDS Checker API starting ===", flush=True)
    try:
        import ifcopenshell
        print(f"ifcopenshell: {ifcopenshell.version}", flush=True)
        from ifctester import ids
        print("ifctester: OK", flush=True)
    except Exception as e:
        print(f"Import FAILED: {e}", flush=True)


@app.get("/health")
def health():
    return {"status": "ok"}


async def _download_ifc_from_tc(*args, **kwargs) -> str:
    raise HTTPException(
        400,
        "Direkte nedlasting fra TC er ikke støttet – last opp IFC-filen manuelt."
    )


@app.post("/validate")
async def validate(
    ids_file: UploadFile = File(...),
    tc_file_id: str = Form(None),
    tc_file_name: str = Form(None),
    tc_parent_id: str = Form(None),
    tc_project_id: str = Form(None),
    tc_access_token: str = Form(None),
    tc_region: str = Form("app"),
    tc_host: str = Form(None),
    ifc_file: UploadFile = File(None),
):
    if not tc_file_id and not ifc_file:
        raise HTTPException(400, "Send enten tc_file_id eller ifc_file")

    ifc_path = None
    ids_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".ids", delete=False) as tmp:
            tmp.write(await ids_file.read())
            ids_path = tmp.name

        if tc_file_id and tc_access_token:
            ifc_path = await _download_ifc_from_tc(
                tc_file_id, tc_access_token, tc_region, tc_host,
                tc_file_name, tc_parent_id, tc_project_id
            )
        else:
            with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as tmp:
                tmp.write(await ifc_file.read())
                ifc_path = tmp.name

        return run_ids_check(ifc_path, ids_path)

    finally:
        for p in [ifc_path, ids_path]:
            if p and os.path.exists(p):
                os.unlink(p)


@app.post("/update-properties")
async def update_props(
    tc_file_id: str = Form(None),
    tc_file_name: str = Form(None),
    tc_parent_id: str = Form(None),
    tc_access_token: str = Form(None),
    tc_region: str = Form("app"),
    tc_host: str = Form(None),
    tc_project_id: str = Form(None),
    tc_folder_id: str = Form(None),
    upload_to_project: str = Form("false"),
    ifc_file: UploadFile = File(None),
    # Multiple requirements as JSON array:
    # [{"pset": "Pset_WallCommon", "name": "FireRating", "value": "REI60"}, ...]
    requirements: str = Form(...),
    guids: str = Form(...),
    output_filename: str = Form("korrigert_modell.ifc"),
):
    ifc_path = None
    out_path = None

    try:
        guid_list = json.loads(guids)
        req_list = json.loads(requirements)
        print(f"update-properties: {len(req_list)} requirements, {len(guid_list)} guids", flush=True)
        for r in req_list:
            print(f"  {r.get('pset')}.{r.get('name')} = {r.get('value')}", flush=True)

        if tc_file_id and tc_access_token:
            ifc_path = await _download_ifc_from_tc(
                tc_file_id, tc_access_token, tc_region, tc_host,
                tc_file_name, tc_parent_id, tc_project_id
            )
        elif ifc_file:
            with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as tmp:
                tmp.write(await ifc_file.read())
                ifc_path = tmp.name
        else:
            raise HTTPException(400, "Send enten tc_file_id eller ifc_file")

        with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as tmp:
            out_path = tmp.name

        # Apply all requirements in one pass
        updated_count = update_multiple_properties(ifc_path, out_path, req_list, guid_list)

        if ifc_path and os.path.exists(ifc_path):
            os.unlink(ifc_path)
            ifc_path = None

        should_upload = upload_to_project.lower() == "true"
        if should_upload and tc_access_token and tc_project_id:
            try:
                tc_file = await upload_to_tc(
                    ifc_path=out_path,
                    filename=output_filename,
                    access_token=tc_access_token,
                    region=tc_region,
                    project_id=tc_project_id,
                    parent_folder_id=tc_folder_id or None,
                )
                return {
                    "success": True,
                    "updated_count": updated_count,
                    "tc_file": {
                        "id": tc_file.get("id"),
                        "name": tc_file.get("name"),
                        "parentId": tc_file.get("parentId"),
                    },
                    "message": f"Lastet opp til TC: {output_filename}",
                }
            except Exception as e:
                print(f"TC upload failed, falling back to download: {e}", flush=True)

        def cleanup():
            if out_path and os.path.exists(out_path):
                os.unlink(out_path)

        return FileResponse(
            path=out_path,
            filename=output_filename,
            media_type="application/octet-stream",
            background=BackgroundTask(cleanup),
        )

    except Exception:
        for p in [ifc_path, out_path]:
            if p and os.path.exists(p):
                os.unlink(p)
        raise


@app.get("/project-members")
async def project_members(
    tc_project_id: str,
    tc_access_token: str,
    tc_region: str = "app",
    tc_host: str = None,
):
    if tc_host:
        base_url = f"https://{tc_host}/tc/api/2.0"
    else:
        base_url = f"https://{tc_region}.connect.trimble.com/tc/api/2.0"

    headers = {"Authorization": f"Bearer {tc_access_token}"}
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.get(
            f"{base_url}/projects/{tc_project_id}/members",
            headers=headers,
        )
        print(f"Members: {res.status_code} {res.text[:300]}", flush=True)
        if res.status_code == 200:
            data = res.json()
            members = data.get("list") or data.get("members") or (data if isinstance(data, list) else [])
            return {"members": [
                {"id": m.get("id"), "email": m.get("email"), "firstName": m.get("firstName",""), "lastName": m.get("lastName","")}
                for m in members
            ]}
        return {"members": []}


@app.post("/create-todos")
async def create_todos(
    tc_access_token: str = Form(...),
    tc_region: str = Form("app"),
    tc_host: str = Form(None),
    tc_project_id: str = Form(...),
    todos: str = Form(...),  # JSON array of todo objects
    assignee_id: str = Form(None),  # optional user ID to assign to
):
    """
    Creates one ToDo per failed spec in TC.
    todos = [{"title": "...", "description": "...", "spec_name": "..."}, ...]
    """
    # Use tc_host (app21) if provided – same server pattern as file downloads
    if tc_host:
        base_url = f"https://{tc_host}/tc/api/2.0"
    else:
        base_url = f"https://{tc_region}.connect.trimble.com/tc/api/2.0"

    headers = {
        "Authorization": f"Bearer {tc_access_token}",
        "Content-Type": "application/json",
    }
    print(f"Creating todos on: {base_url}", flush=True)

    todo_list = json.loads(todos)
    created = []
    failed = []

    async with httpx.AsyncClient(timeout=60) as client:
        for todo in todo_list:
            # Step 1: Create the ToDo
            body = {
                "label": "",
                "title": todo.get("title", "IDS Feil"),
                "description": todo.get("description", ""),
                "type": "ISSUE",
                "status": "NEW",
                "priority": "NORMAL",
                "projectId": tc_project_id,
                "assignees": [{"id": assignee_id}] if assignee_id else [],
            }

            print(f"Creating todo: {body['title']}", flush=True)
            res = await client.post(
                f"{base_url}/todos",
                json=body,
                headers=headers,
            )
            print(f"  → {res.status_code} {res.text[:300]}", flush=True)

            if res.status_code not in (200, 201):
                failed.append({"title": todo.get("title"), "status": res.status_code, "error": res.text[:200]})
                continue

            todo_data = res.json()
            todo_id = todo_data.get("id")
            print(f"  ToDo created: {todo_id}", flush=True)

            # Step 2: Add object links (source = model/objects, target = todo)
            guids = todo.get("guids", [])
            model_id = todo.get("modelId")
            if todo_id and guids and model_id:
                for guid in guids[:50]:  # max 50 objects per todo
                    link_body = {
                        "source": {
                            "id": model_id,
                            "versionId": model_id,
                            "objectId": guid,
                        },
                        "target": {
                            "id": todo_id,
                            "type": "TODO",
                        },
                    }
                    link_res = await client.post(
                        f"{base_url}/objectlinks",
                        json=link_body,
                        headers=headers,
                    )
                    print(f"  Objectlink {guid}: {link_res.status_code}", flush=True)

            created.append(todo_data)

    return {
        "created": len(created),
        "failed": len(failed),
        "todos": [{"id": t.get("id"), "label": t.get("label")} for t in created],
        "errors": failed,
    }


def update_multiple_properties(ifc_path, out_path, requirements, guids):
    """Apply multiple property updates in a single IFC file pass."""
    from updater import _get_pset_object, _add_pset_with_prop
    import ifcopenshell
    import ifcopenshell.api
    import ifcopenshell.util.element

    model = ifcopenshell.open(ifc_path)
    updated = 0

    for guid in guids:
        try:
            entity = model.by_guid(guid)
        except Exception:
            continue
        if entity is None:
            continue

        for req in requirements:
            pset_name = req.get("pset", "")
            prop_name = req.get("name", "")
            prop_value = req.get("value", "")

            if not pset_name or not prop_name or not prop_value:
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
