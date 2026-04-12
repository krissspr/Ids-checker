from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import tempfile
import os
from checker import run_ids_check

app = FastAPI(title="IDS Checker API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://ids-checker.vercel.app",
        "http://localhost:3000",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
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
    return {"test": "API is working", "files": [ifc_file.filename, ids_file.filename]}
