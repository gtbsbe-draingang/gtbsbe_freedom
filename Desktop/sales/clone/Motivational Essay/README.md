# AI & Plagiarism Essay Checker (Hackathon MVP)

A lightweight essay analysis tool that combines **AI-generated text detection and semantic plagiarism checking** using modern NLP models.

### `/Check`
* Method `POST`
* Payload:
    ```python
    {
        "essay_text": "Artificial intelligence is changing education. Students use tools to generate essays.",
        "source_texts": [ "Artificial intelligence is changing education in many ways.",
                            "Students use tools to generate essays for assignments." ]
    }
    ```
* Response:
    ```python
    {
        "ai_label": "likely_ai",
        "ai_score": 0.82, "plagiarism_score": 0.5,
        "suspicious_sentences": [
        {
            "essay_sentence": "Artificial intelligence is changing education.",
            "source_index": 0,
            "source_excerpt": "Artificial intelligence is changing education in many ways.",
            "similarity_score": 0.88
        } ],
        "summary": "AI detector suggests likely ai..."
    }
    ```

## Running the Program

### Server
    python -m uvicorn essay_checker_mvp:app --host 127.0.0.1 --port 8000 --reload

### Optional: Simple UI
    streamlit run ui.py

