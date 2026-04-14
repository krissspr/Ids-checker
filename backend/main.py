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


async def _download_ifc_from_tc(
    tc_file_id: str,
    tc_access_token: str,
    tc_region: str,
    tc_host: str = None,
    tc_file_name: str = None,
    tc_parent_id: str = None,
    tc_project_id: str = None,
) -> str:
    """
    Downloads the original IFC file from TC.
    TC converts IFC to TRIMBIM internally, so we look up the original
    file in the parent folder by name.
    """
    if tc_host:
        base_url = f"https://{tc_host}/tc/api/2.0"
    else:
        base_url = f"https://{tc_region}.connect.trimble.com/tc/api/2.0"

    headers = {"Authorization": f"Bearer {tc_access_token}"}
    print(f"TC base: {base_url} | file: {tc_file_name} | folder: {tc_parent_id}", flush=True)

    async with httpx.AsyncClient(timeout=180) as client:

        # Strategy 1: Use TC Search API to find the original IFC file by name
        # This avoids needing to know the exact folder listing endpoint
        if tc_file_name and tc_project_id:

            # First probe users/me and project to confirm token/server works
            me_res = await client.get(f"{base_url}/users/me", headers=headers)
            print(f"users/me: {me_res.status_code} | {me_res.text[:200]}", flush=True)

            proj_res = await client.get(f"{base_url}/projects/{tc_project_id}", headers=headers)
            print(f"project: {proj_res.status_code} | {proj_res.text[:300]}", flush=True)

            # Try TC Search API – searches for file by name in a project
            search_url = f"{base_url}/search?projectId={tc_project_id}&query={tc_file_name}&type=file&limit=20"
            print(f"Search: {search_url}", flush=True)
            try:
                sr = await client.get(search_url, headers=headers)
                print(f"Search response: {sr.status_code} | {sr.text[:500]}", flush=True)

                if sr.status_code == 200:
                    data = sr.json()
                    results = (data.get("list") or data.get("files") or
                               data.get("results") or data.get("items") or
                               (data if isinstance(data, list) else []))
                    target = tc_file_name.lower()
                    for f in results:
                        name = (f.get("name") or "").lower()
                        ftype = (f.get("type") or f.get("runtimeType") or "").upper()
                        fid = f.get("id") or f.get("versionId")
                        print(f"  Search result: {name} type:{ftype} id:{fid}", flush=True)
                        if name == target and "TRIMBIM" not in ftype:
                            dl = await client.get(
                                f"{base_url}/files/{fid}/download",
                                headers=headers,
                                follow_redirects=True,
                            )
                            print(f"  Download: {dl.status_code} {len(dl.content)} bytes", flush=True)
                            if dl.status_code == 200:
                                with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as tmp:
                                    tmp.write(dl.content)
                                    return tmp.name
            except Exception as e:
                print(f"Search failed: {e}", flush=True)

            # Try folder listing with known TC API patterns
            if tc_parent_id:
                folder_urls = [
                    f"{base_url}/projects/{tc_project_id}/nodes?parent={tc_parent_id}&limit=200",
                    f"{base_url}/projects/{tc_project_id}/nodes?parentId={tc_parent_id}&limit=200",
                    f"{base_url}/files?project={tc_project_id}&folder={tc_parent_id}&limit=200",
                    f"{base_url}/folders/{tc_parent_id}?projectId={tc_project_id}",
                ]
                for url in folder_urls:
                    try:
                        r = await client.get(url, headers=headers)
                        print(f"Folder {url} → {r.status_code} | {r.text[:300]}", flush=True)
                        if r.status_code == 200:
                            data = r.json()
                            files = (data.get("list") or data.get("files") or
                                     data.get("nodes") or (data if isinstance(data, list) else []))
                            target = tc_file_name.lower()
                            for f in files:
                                name = (f.get("name") or "").lower()
                                ftype = (f.get("type") or f.get("runtimeType") or "").upper()
                                fid = f.get("id") or f.get("versionId")
                                print(f"  {name} type:{ftype} id:{fid}", flush=True)
                                if name == target and "TRIMBIM" not in ftype:
                                    dl = await client.get(
                                        f"{base_url}/files/{fid}/download",
                                        headers=headers, follow_redirects=True,
                                    )
                                    if dl.status_code == 200:
                                        with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as tmp:
                                            tmp.write(dl.content)
                                            return tmp.name
                            break
                    except Exception as e:
                        print(f"  Exception: {e}", flush=True)

        # Strategy 2: Direct download fallback
        print(f"Fallback: direct download {tc_file_id}", flush=True)
        res = await client.get(
            f"{base_url}/files/{tc_file_id}/download",
            headers=headers,
            follow_redirects=True,
        )
        print(f"Direct: {res.status_code} {len(res.content)} bytes", flush=True)
        if res.status_code == 200:
            with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as tmp:
                tmp.write(res.content)
                return tmp.name

        raise HTTPException(502, f"Kunne ikke laste ned IFC fra TC: {res.status_code}")


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
