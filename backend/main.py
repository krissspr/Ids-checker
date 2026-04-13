from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
import tempfile
import os
import json
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


@app.get("/health")
def health():
    return {"status": "ok"}


async def _download_ifc_from_tc(
    tc_file_id: str,
    tc_access_token: str,
    tc_region: str,
    tc_host: str = None,
) -> str:
    # Use explicit host if provided (TC may store files on specific servers)
    if tc_host:
        base_url = f"https://{tc_host}/tc/api/2.0"
    else:
        base_url = f"https://{tc_region}.connect.trimble.com/tc/api/2.0"

    # Try multiple download URL patterns – TC uses different endpoints
    # depending on file type (FILE vs TRIMBIM)
    url_patterns = [
        f"{base_url}/files/{tc_file_id}/download",
        f"{base_url}/files/{tc_file_id}/ifc",
        f"{base_url}/models/{tc_file_id}/download",
        f"{base_url}/data/{tc_file_id}",
    ]

    async with httpx.AsyncClient(timeout=180) as client:
        for url in url_patterns:
            print(f"Trying: {url}")
            res = await client.get(
                url,
                headers={"Authorization": f"Bearer {tc_access_token}"},
                follow_redirects=True,
            )
            print(f"  → {res.status_code} content-type: {res.headers.get('content-type','')}")
            if res.status_code == 200:
                with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as tmp:
                    tmp.write(res.content)
                    print(f"  → saved {len(res.content)} bytes to {tmp.name}")
                    return tmp.name

        raise HTTPException(502, f"Kunne ikke laste ned IFC fra TC – ingen URL fungerte for ID: {tc_file_id}")


@app.post("/validate")
async def validate(
    ids_file: UploadFile = File(...),
    tc_file_id: str = Form(None),
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
            ifc_path = await _download_ifc_from_tc(tc_file_id, tc_access_token, tc_region, tc_host)
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
    tc_access_token: str = Form(None),
    tc_region: str = Form("app"),
    tc_host: str = Form(None),
    tc_project_id: str = Form(None),
    tc_folder_id: str = Form(None),          # optional – upload to this folder
    upload_to_project: str = Form("false"),  # "true" = upload back to TC
    ifc_file: UploadFile = File(None),
    pset_name: str = Form(...),
    prop_name: str = Form(...),
    prop_value: str = Form(...),
    guids: str = Form(...),
    output_filename: str = Form("korrigert_modell.ifc"),
):
    ifc_path = None
    out_path = None

    try:
        guid_list = json.loads(guids)

        # Get IFC
        if tc_file_id and tc_access_token:
            ifc_path = await _download_ifc_from_tc(tc_file_id, tc_access_token, tc_region, tc_host)
        elif ifc_file:
            with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as tmp:
                tmp.write(await ifc_file.read())
                ifc_path = tmp.name
        else:
            raise HTTPException(400, "Send enten tc_file_id eller ifc_file")

        # Apply changes
        with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as tmp:
            out_path = tmp.name

        updated_count = update_properties(
            ifc_path, out_path, pset_name, prop_name, prop_value, guid_list
        )

        # Clean input immediately
        if ifc_path and os.path.exists(ifc_path):
            os.unlink(ifc_path)
            ifc_path = None

        # Upload back to TC if requested
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
                # Return JSON confirmation instead of file download
                return {
                    "success": True,
                    "updated_count": updated_count,
                    "tc_file": {
                        "id": tc_file.get("id"),
                        "name": tc_file.get("name"),
                        "parentId": tc_file.get("parentId"),
                    },
                    "message": f"Fil lastet opp til TC: {output_filename}",
                }
            except Exception as e:
                # Upload failed – fall back to download
                return FileResponse(
                    path=out_path,
                    filename=output_filename,
                    media_type="application/octet-stream",
                    background=BackgroundTask(lambda: os.path.exists(out_path) and os.unlink(out_path)),
                    headers={"X-Upload-Error": str(e)},
                )

        # Default: return as file download
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
