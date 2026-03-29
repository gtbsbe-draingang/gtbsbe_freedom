from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer, util
from transformers import pipeline


app = FastAPI(title="Hackathon Essay Checker MVP")

# Lazy-loaded globals so the server starts quickly.
_embedding_model: SentenceTransformer | None = None
_ai_detector: Any | None = None


class CheckRequest(BaseModel):
    essay_text: str = Field(..., min_length=50, description="Essay text to analyze")
    source_texts: list[str] = Field(
        default_factory=list,
        description="Potential source texts to compare against",
    )


class SentenceMatch(BaseModel):
    essay_sentence: str
    source_index: int
    source_excerpt: str
    similarity_score: float


class CheckResponse(BaseModel):
    ai_label: str
    ai_score: float
    plagiarism_score: float
    suspicious_sentences: list[SentenceMatch]
    summary: str


@dataclass
class MatchResult:
    essay_sentence: str
    source_index: int
    source_excerpt: str
    similarity_score: float


def get_embedding_model() -> SentenceTransformer:
    global _embedding_model
    if _embedding_model is None:
        _embedding_model = SentenceTransformer("all-MiniLM-L6-v2")
    return _embedding_model


def get_ai_detector() -> Any:
    global _ai_detector
    if _ai_detector is None:
        # Lightweight baseline detector for hackathon demos.
        _ai_detector = pipeline(
            "text-classification",
            model="roberta-base-openai-detector",
            truncation=True,
            max_length=512,
        )
    return _ai_detector


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p.strip() for p in parts if len(p.strip()) > 20]



def normalize_score(value: float) -> float:
    return round(max(0.0, min(1.0, value)), 4)



def detect_ai_probability(text: str) -> tuple[str, float]:
    detector = get_ai_detector()
    result = detector(text[:4000])[0]
    label = str(result.get("label", "UNKNOWN"))
    score = float(result.get("score", 0.0))

    # Many HF detectors return labels like "Real" / "Fake" or similar.
    # For demo purposes we map likely AI-ish labels to a unified output.
    aiish = {"FAKE", "LABEL_1", "AI", "GENERATED"}
    is_ai = label.upper() in aiish or "FAKE" in label.upper() or "AI" in label.upper()

    final_label = "likely_ai" if is_ai else "likely_human"
    final_score = score if is_ai else 1 - score
    return final_label, normalize_score(final_score)



def find_similarity_matches(
    essay_text: str,
    source_texts: list[str],
    threshold: float = 0.72,
) -> tuple[float, list[MatchResult]]:
    if not source_texts:
        return 0.0, []

    model = get_embedding_model()
    essay_sentences = split_sentences(essay_text)
    if not essay_sentences:
        return 0.0, []

    source_sentences: list[tuple[int, str]] = []
    for source_idx, source in enumerate(source_texts):
        for sent in split_sentences(source):
            source_sentences.append((source_idx, sent))

    if not source_sentences:
        return 0.0, []

    essay_embeddings = model.encode(essay_sentences, convert_to_tensor=True)
    source_embeddings = model.encode([s for _, s in source_sentences], convert_to_tensor=True)
    cosine_matrix = util.cos_sim(essay_embeddings, source_embeddings)

    matches: list[MatchResult] = []
    suspicious_count = 0

    for essay_idx, essay_sentence in enumerate(essay_sentences):
        row = cosine_matrix[essay_idx]
        best_idx = int(row.argmax())
        best_score = float(row[best_idx])
        if best_score >= threshold:
            suspicious_count += 1
            source_index, source_excerpt = source_sentences[best_idx]
            matches.append(
                MatchResult(
                    essay_sentence=essay_sentence,
                    source_index=source_index,
                    source_excerpt=source_excerpt,
                    similarity_score=round(best_score, 4),
                )
            )

    plagiarism_score = suspicious_count / max(1, len(essay_sentences))
    return normalize_score(plagiarism_score), matches[:10]



def build_summary(ai_label: str, ai_score: float, plagiarism_score: float, matches: int) -> str:
    ai_text = (
        f"AI detector suggests {ai_label.replace('_', ' ')} with confidence {ai_score:.2f}."
    )
    plag_text = f"Similarity-based plagiarism score is {plagiarism_score:.2f}."
    match_text = f"Found {matches} suspicious sentence matches."
    disclaimer = (
        " This is a hackathon MVP and should be treated as a heuristic, not a final academic judgment."
    )
    return ai_text + " " + plag_text + " " + match_text + disclaimer


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/check", response_model=CheckResponse)
def check_essay(payload: CheckRequest) -> CheckResponse:
    essay_text = payload.essay_text.strip()
    if len(essay_text) < 50:
        raise HTTPException(status_code=400, detail="Essay text is too short.")

    ai_label, ai_score = detect_ai_probability(essay_text)
    plagiarism_score, matches = find_similarity_matches(essay_text, payload.source_texts)

    return CheckResponse(
        ai_label=ai_label,
        ai_score=ai_score,
        plagiarism_score=plagiarism_score,
        suspicious_sentences=[SentenceMatch(**m.__dict__) for m in matches],
        summary=build_summary(ai_label, ai_score, plagiarism_score, len(matches)),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)

