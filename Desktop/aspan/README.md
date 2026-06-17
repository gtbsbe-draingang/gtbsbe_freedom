# Aspan Proposal Engine

## Project Overview

Aspan Proposal Engine is a first-version internal tool for producing editable solar/PPA PowerPoint proposals from utility bills, client information, approved Aspan facts, and deterministic solar economics.

The demo UI is Streamlit, not Gradio. The rest of the pipeline remains the same: core Python engine, thin FastAPI wrapper, and n8n orchestration that calls FastAPI.

## Architecture

The project has three operating layers:

1. Bill Intelligence extracts structured bill fields from uploaded PDF or image bills.
2. The deterministic solar economics engine calculates PV sizing, production, tariffs, and savings.
3. The grounded proposal writer creates client-facing prose using only approved facts and already calculated numbers.

LLMs are used only for extraction and narrative. Python owns all financial and engineering calculations. The Streamlit app and FastAPI API both call the same core modules.

## Why Calculations Are Deterministic

Financial and engineering calculations are implemented in `core/calc_engine.py` and covered by pytest tests. Claude is never allowed to calculate, modify, estimate, or improve the numbers. This keeps the proposal auditable and makes the assumptions appendix defensible for CFO review.

## Why V1 Uses A Facts Pack Instead Of Full RAG

V1 intentionally avoids embeddings, chunking, vector databases, and retrieval ranking. The approved Markdown facts in `knowledge_base/` are small enough to inject directly into the narrative prompt. This prevents hallucinated Aspan-specific claims while avoiding unnecessary RAG complexity. Full RAG is a v2 feature once there is a larger proposal library.

## Setup Instructions

Use the provided virtual environment:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Copy `.env.example` to `.env` and add your Anthropic key if you want live Claude extraction and narrative.

## Environment Variables

```env
ANTHROPIC_API_KEY=your_api_key_here
ANTHROPIC_VISION_MODEL=claude-3-5-sonnet-latest
ANTHROPIC_TEXT_MODEL=claude-3-5-sonnet-latest
```

Without `ANTHROPIC_API_KEY`, the system uses fallback bill extraction and deterministic fallback narrative so the demo still runs.

## Run Tests

```powershell
.\.venv\Scripts\python.exe -m pytest
```

The highest-priority tests are in `tests/test_calc_engine.py`.

## Run FastAPI

```powershell
.\.venv\Scripts\python.exe -m uvicorn api.main:app --reload --port 8000
```

Endpoints:

- `GET /health`
- `POST /extract-bill`
- `POST /generate-proposal`

## Run Streamlit UI

```powershell
.\.venv\Scripts\streamlit.exe run ui/app.py
```

The Streamlit app supports bill upload, editable bill review, client inputs, assumptions review, calculation preview, proposal generation, and PPTX download.

## n8n Workflow

Import `automation/aspan_proposal_workflow.json` into n8n. The workflow:

1. Receives a webhook request with a bill file and client JSON.
2. Calls FastAPI `POST /extract-bill`.
3. Calls FastAPI `POST /generate-proposal`.
4. Returns the generated PPTX file.

n8n does not run Python business logic.

## Generate A Sample Proposal

```powershell
.\.venv\Scripts\python.exe scripts/generate_sample.py
```

The script uses dummy confirmed bill data and writes an editable PowerPoint into `outputs/`.

## Folder Structure

```text
api/                  FastAPI wrapper
automation/           n8n workflow export
core/                 Models, config, extraction, calculations, grounding, narrative, PPTX, logging
knowledge_base/       Approved facts pack Markdown files
reference_materials/  Optional style references by metadata
templates/            Placeholder PowerPoint template
outputs/              Generated PPTX files
cache/                NASA POWER and upload cache
logs/                 JSONL proposal run log
tests/                Pytest coverage for core assumptions and calculations
ui/                   Streamlit demo app
```

## Assumptions And Limitations

- Utility bill extraction depends on Claude when `ANTHROPIC_API_KEY` is set.
- Missing or unreadable bill values fall back to documented low-confidence defaults.
- Missing roof area uses a conservative fallback in full proposal calculation.
- Missing grid capacity does not dominate PV sizing.
- NASA POWER failures fall back to `default_specific_yield_kwh_per_kwp`.
- The generated PowerPoint uses editable native shapes, text, tables, and charts.
- The placeholder template includes TODO metadata until official brand assets are provided.

## V2 Roadmap

1. Full RAG over a large library of past proposals
2. User authentication
3. CRM integration
4. Automated email sending
5. Multi-user proposal history dashboard
6. Better country-specific tariff and diesel databases
7. More advanced PV simulation
8. Aspan-branded design system after receiving official templates
9. Approval workflow before sending proposals
10. Cloud deployment

