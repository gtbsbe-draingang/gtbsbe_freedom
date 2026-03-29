import streamlit as st
import requests

st.title("Essay Checker")

essay = st.text_area("Paste your essay")

if st.button("Check"):
    res = requests.post(
        "http://127.0.0.1:8000/check",
        json={"essay_text": essay, "source_texts": []}
    )
    st.json(res.json())
