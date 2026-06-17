from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from core.config_loader import load_config
from core.extraction import extract_multiple_bills
from core.models import ProposalRequest
from core.pipeline import generate_proposal_artifacts

app = FastAPI(title="Aspan Proposal Engine", version="0.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/extract-bill")
async def extract_bill_endpoint(files: list[UploadFile] = File(...)):
    config = load_config()
    if not files:
        raise HTTPException(status_code=400, detail="Upload at least one bill file.")

    with tempfile.TemporaryDirectory() as temp_dir:
        saved_paths: list[str] = []
        for file in files:
            if not file.filename:
                continue
            target = Path(temp_dir) / Path(file.filename).name
            with target.open("wb") as handle:
                shutil.copyfileobj(file.file, handle)
            saved_paths.append(str(target))
        bill = extract_multiple_bills(saved_paths, config)
    return bill.model_dump(mode="json")


@app.post("/generate-proposal")
def generate_proposal_endpoint(request: ProposalRequest):
    config = load_config()
    try:
        response = generate_proposal_artifacts(request.bill, request.client, config)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Proposal generation failed: {exc}") from exc

    path = Path(response.output_pptx_path)
    if not path.exists():
        raise HTTPException(status_code=500, detail="Proposal file was not created.")
    return FileResponse(
        path,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        filename=path.name,
    )

