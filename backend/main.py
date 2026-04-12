from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import tempfile
import os
import httpx
from checker import run_ids_check

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


@app.post("/validate")
async def validate(
    ids_file: UploadFile = File(...),
    # Option A: TC downloads directly (avoids large file through browser)
    tc_file_id: str = Form(None),
    tc_access_token: str = Form(None),
    tc_region: str = Form("app"),  # "app" = US/global, "app.eu" = Europe
    # Option B: direct upload fallback
    ifc_file: UploadFile = File(None),
):
    if not tc_file_id and not ifc_file:
        raise HTTPException(400, "Send enten tc_file_id eller ifc_file")
    if not ids_file.filename.endswith(".ids"):
        raise HTTPException(400, "ids_file må være en .ids-fil")

    ifc_path = None
    ids_path = None

    try:
        with tempfile.NamedTemporaryFile(suffix=".ids", delete=False) as tmp:
            tmp.write(await ids_file.read())
            ids_path = tmp.name

        if tc_file_id and tc_access_token:
            # Backend fetches IFC from TC – no browser size limit
            base_url = f"https://{tc_region}.connect.trimble.com/tc/api/2.0"
            async with httpx.AsyncClient(timeout=180) as client:
                res = await client.get(
                    f"{base_url}/files/{tc_file_id}/download",
                    headers={"Authorization": f"Bearer {tc_access_token}"},
                    follow_redirects=True,
                )
                if res.status_code != 200:
                    raise HTTPException(502, f"Kunne ikke laste ned IFC fra TC: {res.status_code}")
                with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as tmp:
                    tmp.write(res.content)
                    ifc_path = tmp.name
        else:
            if not ifc_file.filename.endswith(".ifc"):
                raise HTTPException(400, "ifc_file må være en .ifc-fil")
            with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as tmp:
                tmp.write(await ifc_file.read())
                ifc_path = tmp.name

        return run_ids_check(ifc_path, ids_path)

    finally:
        if ifc_path and os.path.exists(ifc_path):
            os.unlink(ifc_path)
        if ids_path and os.path.exists(ids_path):
            os.unlink(ids_path)
