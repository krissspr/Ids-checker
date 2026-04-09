from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import tempfile
import os
from checker import run_ids_check

app = FastAPI(title="IDS Checker API")

# Allow requests from the React frontend (Vercel URL goes here in production)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Replace with your Vercel URL in production
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/validate")
async def validate(
    ifc_file: UploadFile = File(...),
    ids_file: UploadFile = File(...),
):
    """
    Accepts an IFC file and an IDS file, runs IfcTester validation,
    and returns a structured JSON report.
    """
    if not ifc_file.filename.endswith(".ifc"):
        raise HTTPException(400, "Filen må være en .ifc-fil")
    if not ids_file.filename.endswith(".ids"):
        raise HTTPException(400, "Filen må være en .ids-fil")

    # Write uploads to temp files (IfcOpenShell needs file paths, not streams)
    with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as tmp_ifc:
        tmp_ifc.write(await ifc_file.read())
        ifc_path = tmp_ifc.name

    with tempfile.NamedTemporaryFile(suffix=".ids", delete=False) as tmp_ids:
        tmp_ids.write(await ids_file.read())
        ids_path = tmp_ids.name

    try:
        result = run_ids_check(ifc_path, ids_path)
        return result
    finally:
        os.unlink(ifc_path)
        os.unlink(ids_path)
