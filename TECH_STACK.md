# CQA Hackathon: Tech Stack

The stack we chose for the Freedom Broker Conversation Quality Analytics prototype.
Written 2026-11-07. Model facts were checked against vendor pages and model cards that day. Data facts were measured on the DEV set (65 records).

Requirements this stack is built around:

1. Score the operator in **Kazakh, Russian and English**, including mixed KZ/RU conversations.
2. For calls, judge **intention, empathy, emotion and intonation**, which needs the audio as well as the words.
3. When a call arrives as **audio only** (no transcript), STT builds the transcript as a fallback.
4. Prove each component works with measured results, not assumptions (section 9).

## TL;DR

| Layer | Choice |
|---|---|
| UI | Vanilla HTML, CSS and JS, built as Web Components (ready to wrap as a Dynamics 365 web resource). WaveSurfer.js 7 with the Regions plugin for the call player |
| Backend | Python 3.12, FastAPI, Pydantic v2, httpx, SQLite |
| **Brain**: scores every chat and call | **Qwen3.8-2.4T-A95B** (FP8, local), or the same model through the API as **qwen3.8-max**. Practical tier: **Qwen3.8-27B** (FP8). Votes 3 times per conversation |
| **Ear**: describes how each exchange sounds, in KZ, RU and EN | **Qolda-AVL-34B** or **Qolda-AVL-9B** (ISSAI), picked by test |
| **Emotion specialist**: per-turn emotion from the voice | **emotion2vec+ large** (frozen) with a classifier we train on **Dusha** (Russian) and **KazEmoTTS** (Kazakh), plus audeering's arousal/valence model. Trains on a 6 GB laptop GPU |
| Measurements | Silero VAD and Parselmouth (Praat): pitch, loudness, pace, overlaps, delays |
| Transcript to audio alignment | Our own per-call shift estimator on VAD segments. It works the same for every language |
| STT fallback (audio only) | pyannote `speaker-diarization-community-1` plus `issai/whisper-turbo`; the brain decides which speaker is the operator |
| Scoring | Plain Python. No model computes totals |

**Only the brain decides.** The ear, the emotion specialist and the measurements produce evidence. An emotional moment counts only when at least two independent signals agree (section 3.3).

---

## 1. What the data forces

- **Calls are mono.** All 5 DEV recordings are MP3, 16 kHz, 1 channel, 32 to 48 kbps, 5 to 11 minutes long. Operator, client and IVR bot share one track. When a transcript is supplied, speaker identity comes from its labels (`operator`, `client`, `bot`, `system`). When it is not, we must diarize (section 5).
- **In DEV, all Kazakh is text.** DEV has 15 KZ chats, 15 EN chats, 30 RU chats and 5 RU calls. The only Kazakh audio is the IVR bot's greeting at the start of each call (a system event says "The dialog language changed from kk-KZ to ru-RU"), and the bot is not scored. Control calls may still be Kazakh, so every audio component must handle Kazakh speech.
- **Transcripts are supplied.** The brief says call transcripts are provided, and the control set at hour 23 is described as "дополнительные транскрипты". The audio-only path is insurance; ask the organizers whether it will be needed.
- **Transcripts are ASR output.** Expect recognition errors, Kazakh and Russian mixed in one call, and masked names (`[Имя скрыто]`). The IVR's Kazakh greeting is rendered as garbled Russian ("Сами тебе Фридом брокер за кошки для нас"). Judges must not penalise the operator for transcription noise.
- **`audio_url` is a player page, not a file.** It returns HTML whose `<audio><source src>` is a Dynamics 365 SAS link that expires after about 1 hour. Fetch the page, download the MP3 once, cache it as `cache/audio/{conversation_id}.mp3`, and serve it from our backend. The cached file does not expire; only the link does.
- **Transcript timestamps mark the end of each utterance, shifted by a constant per call.** We matched non-system turns to speech segments from a simple energy VAD. A single shift per call explains them:

  | Call | Shift | Median error vs segment end | Turns within 1 s |
  |---|---|---|---|
  | p4-ru-001 | 10.2 s | 0.23 s | 79% |
  | p4-ru-002 | 29.4 s | 1.17 s | 46% |
  | p4-ru-003 | 8.9 s | 0.26 s | 65% |
  | p4-ru-004 | 14.6 s | 0.27 s | 69% |
  | p4-ru-005 | 8.7 s | 0.52 s | 62% |

  Matching against segment starts fits worse (median 0.6 to 1.4 s), so the timestamps are utterance ends. p4-ru-002 contains a long hold, which hurts the fit. Silero VAD should tighten all of these. The method uses only timing, so it works the same on Kazakh.

---

## 2. Models

### 2.1 Brain: Qwen3.8

| Tier | Model | Notes |
|---|---|---|
| **Best** | `Qwen/Qwen3.8-2.4T-A95B` (FP8 build) | Qwen's first open "Max-class" model, August 2026. 2.4T parameters, 95B active per token. Text only. Thinking is always on (`xhigh` effort by default; `medium` and `low` also available). 262k context. Custom licence `qwen3.8-max`, not Apache 2.0 |
| **Best, through the API** | `qwen3.8-max` on Alibaba Model Studio | The official version built on Qwen3.8-2.4T-A95B, with non-thinking mode and 1M context added. $2 per 1M input tokens and $6 per 1M output (International). No GPUs needed; transcripts leave the machine, so ask the organizers first |
| **Practical** | `Qwen/Qwen3.8-27B-FP8` | Same generation, dense 27B, Apache 2.0, 262k context, thinking on by default. Fits a 48 GB card |

- On its card, Qwen3.8-Max scores **82.8 on IFBench** (instruction following), the top score in that table, ahead of GPT 5.6 Sol at 72.7. Strict rubric judging leans on exactly that skill. Qwen3.8-27B reports 79.5 versus 69.1 for Qwen3.6-27B, but in a different evaluation setup, so the two cards' numbers are not directly comparable.
- **Three votes.** The brain scores every conversation 3 times with different seeds. Each criterion takes the majority answer. A split on a critical criterion, or three different answers on any criterion, marks it `review_required`. This also turns the model's sampling randomness into a measured confidence signal.
- Use the sampling the model cards recommend (for the 2.4T model: `temperature=1.0, top_p=0.95, top_k=20`). Thinking models degrade under greedy decoding. Store the seed and the full output of every vote.
- Use the default `xhigh` reasoning effort for final scoring and `medium` during development.
- Structured output: served locally with vLLM, pass `response_format={"type": "json_schema", ...}` so the schema is enforced. Model Studio does not document JSON Schema support for qwen3.8-max, so on the API put the schema in the prompt, validate with Pydantic and allow one repair retry.
- Serving: follow the Qwen3.8 recipes on recipes.vllm.ai (or the SGLang cookbook) for the exact version and flags:
  ```bash
  vllm serve Qwen/Qwen3.8-27B-FP8 --max-model-len 65536
  ```
- The brain also assigns speaker roles in the STT fallback and helps with checklist editing.
- **Kazakh:** no Qwen3.8 card names Kazakh or publishes a language list. The KZ chat bake-off (section 9.4) compares Qwen3.8-27B, qwen3.8-max and ISSAI's Kazakh-tuned Qwen3.5 instruct models (listed on huggingface.co/issai).

### 2.2 Ear: Qolda-AVL (ISSAI)

The only open-weight model we found whose card explicitly takes **Kazakh speech**. Qwen's own open omni model, Qwen3-Omni-30B-A3B, does not understand Kazakh speech, and Qwen has not released weights for its newer omni models.

- "Qolda-AVL is a 34B audio-vision-language model designed to operate in Kazakh, Russian, and English." Apache 2.0.
- Built on Qwen3-VL-32B-Thinking (the 9B version on Qwen3-VL-8B-Thinking), with an audio branch from a fine-tuned Whisper-large-v3-turbo encoder and an audio projector.
- The audio branch was trained for speech recognition, speech translation, audio classification and sound captioning, not mainly for judging delivery. That is why it describes and never scores, and why emotion has its own specialist (section 2.3).
- The card says: "The model was not trained to answer questions posed directly in the audio. Provide a detailed text instruction alongside the audio." We always send a text instruction with the clip transcript.

Results from the Qolda cards (higher is better except WER):

| Task | Qolda-AVL-9B | Qolda-AVL-34B |
|---|---|---|
| Kazakh ASR, WER | **14.5%** | 16.9% |
| Russian ASR, WER | 11.0% | **10.8%** |
| English ASR, WER | 6.3% | **6.0%** |
| SAKURA emotion, single, Kazakh | **47.27** | 45.58 |
| SAKURA emotion, multi, Kazakh | 36.95 | **39.20** |
| SAKURA emotion, single, Russian | 44.80 | **47.60** |
| SAKURA gender, single, Kazakh | 82.80 | **84.20** |

The SAKURA benchmark paper reports emotion as the hardest track for every audio LLM it tested, so these scores are not unusually poor; they are why emotion gets a trained specialist. The contrast test (section 9.5) decides between 9B and 34B.

Serving and limits:

- vLLM needs ISSAI's fork, `github.com/IS2AI/vLLM-Qolda-AVL`. Its README names only the 5B checkpoint and does not state the base vLLM version, so bring it up first. The fallback is plain Transformers (`AutoModelForCausalLM`, `trust_remote_code=True`, bfloat16).
- The card's code loads `batyrme/Qolda-AVL-34B`; the published repos are `issai/Qolda-AVL-34B` and `issai/Qolda-AVL-9B`. Use the `issai` ones.
- Audio goes in through `chat/completions` as `input_audio` (base64 WAV). The example serve command allows one audio clip per prompt (`--limit-mm-per-prompt '{"audio": 1, "image": 1}'`).
- The Whisper encoder hears **30 second windows**, and the cards state no longer limit. We therefore send short exchange clips (section 4.2), never whole calls.
- The backbone is a Thinking model; the card does not say how to turn thinking off. Allow about 4,000 output tokens per clip (the card example uses `max_new_tokens=4096`).

### 2.3 Emotion specialist

General audio LLMs are weak at emotion: SAKURA finds emotion the hardest track for all of them, the multilingual CAMEO benchmark's best zero-shot system reached a macro F1 of only 0.20, and a 2026 study on natural speech found near-zero recall for anger, sadness and fear with off-the-shelf emotion models. The fix is a small model trained on our languages and our audio conditions.

| Part | Choice |
|---|---|
| Backbone (frozen) | `emotion2vec/emotion2vec_plus_large`. Challenger in the bake-off: `microsoft/wavlm-large`, the best encoder across 32 datasets in EmoBox |
| Classifier | Logistic regression or a 2-layer MLP on mean-pooled embeddings, with class weights for imbalance, then temperature scaling for calibrated probabilities |
| Training data | **Dusha** (Russian, about 350 h, acted and real podcast speech) and **KazEmoTTS** (Kazakh, about 75 h, acted, 3 narrators). English audio is not in DEV; add CREMA-D later if English calls appear |
| Arousal and valence | `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`, used as is. Licence CC BY-NC-SA: fine for the hackathon demo, not for production |
| Output per turn | Probabilities for `angry`, `sad` (includes worried), `positive`, `neutral`; arousal, valence, dominance; each also as a change from that speaker's average in the call |

Label mapping:

| Our label | Dusha | KazEmoTTS |
|---|---|---|
| angry | angry | angry |
| sad (incl. worried) | sad | sad, fearful |
| positive | positive | happy |
| neutral | neutral | neutral |
| dropped | other | surprised (valence is ambiguous) |

Training recipe. **The backbone stays frozen; only the small classifier is trained.**

1. Convert every training clip to the DEV call format on the CPU with FFmpeg: 16 kHz mono, telephone band-pass (300 to 3400 Hz), MP3 re-encode at a random 32, 40 or 48 kbps, random gain, light noise. Without this, a model trained on clean audio drifts on real calls.
2. Split by speaker. Dusha keeps its official split; its real podcast test part is the honest natural-speech test. KazEmoTTS has 3 narrators, so use leave-one-speaker-out (3 folds).
3. Run the frozen backbone once over every clip and save one 1024-number embedding per clip (GPU, inference only). The emotion2vec README does this through FunASR:
   ```python
   from funasr import AutoModel
   m = AutoModel(model="emotion2vec/emotion2vec_plus_large", hub="hf")
   res = m.generate("clip.wav", granularity="utterance", extract_embedding=True)
   vec = res[0]["feats"]  # 1024-dim utterance embedding
   ```
4. Train the classifier on the saved embeddings (the CPU is enough), then calibrate it with temperature scaling.
5. At inference, run on aligned turns. Skip turns under 1 s; average windows for turns over 10 s.
6. Check each dataset's licence before training.

Compute for training:

| Step | Runs on | Needs |
|---|---|---|
| Audio conversion | CPU (FFmpeg, one process per core) | No GPU |
| Embedding extraction | GPU, inference only | About 0.6 GB of weights in FP16, plus 1 to 3 GB for a batch of 5 to 10 s clips. A 6 GB GPU is enough |
| Classifier training | CPU | 1 to 2 GB of RAM for all embeddings |
| audeering arousal/valence | GPU, inference only | About 1.2 GB |

- **Checked on our dev laptop:** RTX 4050 Laptop GPU with 6 GB, and PyTorch 2.5.1 sees CUDA. That is enough for the whole emotion specialist, Whisper and pyannote. It cannot run Qolda or the brain.
- **Time (estimate, not yet measured):** 2 to 5 hours for all of Dusha plus KazEmoTTS on that laptop, mostly embedding extraction and audio decoding. Classifier training takes minutes.
- **Disk is the real limit, not VRAM.** About 425 hours of 16 kHz audio is roughly 50 GB uncompressed, before the downloaded archives, and the laptop had 49 GB free on 2026-11-07. Process one Dusha part at a time: download, convert, embed, then delete the audio. Embeddings for every clip take about 1 GB.
- **Start with a subset:** Dusha's podcast part, about 50,000 Dusha crowd clips, and all of KazEmoTTS. Add more data only if the scores on the DEV call turns (section 9.3) improve.
- **Fine-tuning the backbone** is a later option, worth it only if the frozen version scores poorly on DEV turns. On 8 GB: a full fine-tune of the large model (about 300M parameters) is possible but tight, with gradient checkpointing, 8-bit Adam, clips of 6 s or less, and a batch of 4 with gradient accumulation. On 6 GB: LoRA on the large model, or a full fine-tune of `emotion2vec_plus_base` (about 90M parameters). Much of the training data is acted speech, so fine-tuning risks learning acting styles rather than real emotion.

Operator warmth or coldness is not a trained label (no dataset has it). It comes from the fusion of valence, the measurements and the ear's notes (section 3.3).

### 2.4 Why no Qwen omni model

- `Qwen3-Omni-30B-A3B` (Sept 2025) is still the newest open-weight Qwen omni model, and its 19 speech input languages exclude Kazakh.
- `qwen3.5-omni-plus` and `qwen3.8-omni-flash` understand Kazakh speech but exist only on the API, so they are not part of this plan (section 13).
- The transcript already supplies the words. Qolda covers the sound in all three languages, and the emotion specialist covers what audio LLMs are weakest at.

### 2.5 Evidence is turn ids, never model-generated seconds

The brain returns `turn_ids`. The backend converts them to `[start, end]` seconds using the alignment (section 4.2) or the STT timestamps (section 5). The "Listen" button plays from 2 s before the turn to 1 s after it.

---

## 3. Kazakh: intention, empathy, emotion, intonation

### 3.1 Judge in the original language

Never translate Kazakh into Russian before judging. Translation erases the signals we score: сіз versus сен, address terms, register and politeness particles. The brain reads the original and the ear hears the original. Explanations are written in the UI language (Russian), and the evidence is quoted in the original Kazakh.

### 3.2 Observe first, then score

The brain's JSON starts with `client_intents` and `observations` blocks, and only then lists `criteria`. Because the model writes in order, it commits to evidence before it scores.

1. **Client intents.** What the client wants, in the brain's own words, with turn ids, and whether it was resolved (`yes`, `partly`, `no`).
2. **Emotional moments.** Candidate moments come from the fusion rule (section 3.3). The brain confirms or rejects each one and adds any it reads in the words.
3. **Operator response to each moment.** Did the operator acknowledge it, change pace or tone, apologise where appropriate, and then act on it?

Empathy is then scored per moment ("acknowledged and acted", "acknowledged only", "ignored") instead of by spotting polite phrases. A polite phrase with no action, or said in a flat or rushed tone, does not count as empathy.

### 3.3 Fusion rule: two signals or it did not happen

A **client emotional moment** is proposed when at least two of these agree on the same turn:

| Signal | Starting threshold (tune on DEV labels) |
|---|---|
| Emotion specialist | p(angry) or p(sad) at least 0.6, or a rise of at least 0.3 over the client's call average |
| Measurements | Loudness at least 6 dB or pitch at least 3 semitones above the client's baseline, a clear speaking-rate jump, or talking over the operator |
| Ear | Qolda's note gives a non-neutral client state |
| Words | The transcript shows distress: repeating the problem ("үшінші рет айтып тұрмын", "третий раз объясняю"), complaints, threats to leave |

The same rule, applied to operator turns, proposes **operator irritation** (angry probability, loudness or pace spike, talking over the client, ear says irritated). **Operator warmth** is the combination of positive valence, calm pace, the ear's `warmth` field and the words. A single signal on its own is passed to the brain as low confidence and is never enough to fail a criterion.

### 3.4 What the checklist must decide for Kazakh (do not leave it to the model)

- **Formality.** Сіз is formal and сен is informal (вы and ты in Russian). Is an operator's сен a violation, or only when the client did not use it first?
- **Address terms.** Аға, апа, әпке, бауырым, қарындас, ханым, мырза. Are kinship terms warm and acceptable, or too familiar for a broker?
- **Language choice.** The IVR lets the client pick a language. If the client chose Kazakh and the operator answers in Russian, is that a violation? Mixing Kazakh and Russian within a conversation is normal and must not be penalised by itself.
- **Empathy examples** to give the brain as illustrations, not keyword rules. Kazakh: "Түсінемін", "Кешіріңіз", "Алаңдамаңыз", "Өкінішке қарай", "Күткеніңізге рақмет". Russian: "Понимаю вас", "Приношу извинения", "Спасибо за ожидание".

### 3.5 Intonation rules and measurements

- Kazakh yes/no questions are marked by particles (ма, ме, ба, бе, па, пе), so rising pitch is not a reliable question marker. Do not infer "question" or "uncertainty" from pitch rises alone.
- Compare a speaker only with themselves in the same call. Pitch, loudness and emotion scores are measured against that speaker's own average in the call, never against other speakers, languages or calls.
- Telephone audio is compressed, mono and 16 kHz, which flattens loudness. "Raised voice" means a jump relative to the speaker's baseline, ideally combined with talking over the other person. One loud word is not enough.
- Describe behaviour, not inner states: "the operator speeds up and talks over the client's unfinished question in t034", not "the operator is angry, 92%". No penalty for accent or dialect.

Measured per turn (Parselmouth plus Silero VAD):

| Feature | How |
|---|---|
| Pitch level and range | Median and 10th to 90th percentile spread, in semitones relative to the speaker's call median |
| Loudness | Mean and peak, in dB relative to the speaker's call median |
| Speaking rate | Vowel letters per second of speech. In Kazakh and Russian Cyrillic, vowel count is close to syllable count (а ә е ё и і о ө у ұ ү ы э ю я) |
| Response delay | Gap between the end of the other speaker's turn and this speaker's next speech |
| Overlap | Seconds of speech that start while the other speaker is still talking |
| Silence | Gaps over 5 s, with any system "hold" event that explains them |

---

## 4. Pipelines

### 4.1 Chats (`channel = "agent chat"`)

1. Fetch the record. Give every turn an id (`t001`, `t002`, and so on) and keep the original timestamp.
2. The brain scores every criterion from the transcript, 3 votes.
3. Validate, combine votes, score and store.

### 4.2 Calls with a transcript (`channel = "voice call"`)

1. Fetch the record, resolve the player page, then download and cache the MP3.
2. Run ffprobe to get duration and channel count. If a stereo file ever shows up, keep both channels and check which one carries the operator turns.
3. Run Silero VAD to get speech segments.
4. **Align.** Grid-search a shift between −10 and +45 s in 0.05 s steps. For each shift, take the median distance between `turn_time − shift` and the nearest segment end; keep the shift with the smallest median. A turn's interval runs from the previous turn's end to its own end, snapped to the VAD segments. Store the median error as the call's alignment confidence.
5. **Measurements** for every client and operator turn (section 3.5).
6. **Emotion specialist** on every client and operator turn (section 2.3).
7. **Cut exchange clips.** Each clip is the client turn(s) just before an operator reply plus the reply itself, capped at 30 s. A longer reply is split into 30 s windows with 2 s of overlap. Turns without a preceding client turn (greeting, closing) get their own clip. Export each clip with FFmpeg as 16 kHz mono WAV.
8. **Ear.** Qolda gets one clip per request, with the clip's transcript lines and the measurements and emotion scores for those turns, and returns a delivery note (section 6). Run the clips in parallel; vLLM batches them.
9. **Fusion** (section 3.3) proposes the emotional moments.
10. **Brain**, 3 votes. It gets the transcript as lines like `[t012 | 00:41.2 to 00:46.8 | operator] text`, the per-turn evidence table (measurements, emotion scores, ear notes), the proposed moments and the full checklist, and returns the scored JSON.
11. Validate, combine votes, apply the review signals (section 4.4), score and store.

### 4.3 Calls with audio only

Run section 5 to build the transcript, then continue from step 5 of section 4.2. Times come from STT, so step 4 (shift alignment) is skipped.

### 4.4 Review signals

A criterion is marked `review_required` when:

- the brain's 3 votes split on a critical criterion, or give three different answers;
- the brain itself marks it as uncertain;
- the decision rests on a single evidence signal (section 3.3);
- the ear's note contradicts the measurements or the emotion specialist, for example "calm" while loudness is 8 dB above baseline and p(angry) is 0.8;
- Qolda's own transcript of a clip differs strongly from the supplied transcript (character error rate above 50%), so the alignment or the transcript is wrong for that turn;
- the call's alignment error is above 1 s;
- in the audio-only path, the brain is unsure which speaker is the operator.

---

## 5. STT fallback (audio only)

| Step | Tool | Notes |
|---|---|---|
| Channel check | ffprobe | If there are 2 channels with one speaker each, transcribe each channel separately and skip diarization |
| Speech detection | Silero VAD | Same as the main path |
| Diarization | `pyannote/speaker-diarization-community-1` (pyannote.audio 4) | Expect 2 or 3 speakers: operator, client, and possibly the IVR bot. Gated on Hugging Face; accept the terms and set `HF_TOKEN` |
| ASR | **`issai/whisper-turbo`** | ISSAI's Whisper turbo: accurate Kazakh while keeping Russian, English and Turkish. Trained on KSC2, which includes Kazakh/Russian code-switched speech. Gives word timestamps and a language tag per segment |
| Cross-check | Qolda-AVL (already loaded) | Re-transcribes doubtful Kazakh turns at no extra cost. It returns text only, so Whisper stays the source of timestamps |
| Role assignment | Brain | Reads the first turns of each speaker. The operator names the company and themselves, asks verification questions and offers help. The bot plays menu prompts at the start ("нажмите 2"). The rest is the client. Low confidence marks the evaluation `review_required` |
| Output | Same transcript schema | Adds `start`, `end`, `lang`, `asr_confidence` and `source: "stt"`. The UI labels the transcript as machine-generated |

ASR bake-off candidates (section 9.7): `issai/whisper-turbo`, `shyngys879/kazakh-whisper-large-v3-turbo` (self-reported 11.8% WER on FLEURS Kazakh; Kazakh-only fine-tune), `nur-dev/Qwen3-ASR-0.6B-kk-ru-en` (gated community fine-tune), `alibiserikbay/kazakh-russian-mixed-stt` (single-pass code switching; partly private training data), `ai-sage/GigaAM-v3` (Russian only, trained with call-center speech), and Qolda-AVL-9B itself. `Qwen3-ASR` and `Qwen3-ForcedAligner` do not support Kazakh.

---

## 6. Contracts

### Checklist config (one JSON per version, edited in the UI)

```json
{
  "checklist_id": "default",
  "version": 3,
  "rounding": "half_up_1",
  "sections": [{ "id": "service", "title": "Обслуживание" }],
  "criteria": [
    {
      "id": "empathy",
      "section": "service",
      "title": "Эмпатия и реакция на эмоции клиента",
      "definition": "...",
      "answer_type": "scale",
      "scale": [0, 1, 2],
      "weight": 15,
      "na_allowed": true,
      "na_rule": "Клиент не проявлял эмоций и не высказывал недовольства",
      "critical": false,
      "evidence_mode": "both",
      "pass_conditions": "...",
      "fail_conditions": "...",
      "exclusions": "...",
      "language_notes": { "kk": "Сен в адрес клиента считается нарушением", "ru": "..." }
    }
  ]
}
```

Fill the real criteria, weights, scales, N/A rules and rounding from the organizers' checklist PDF. `language_notes` carries the Kazakh decisions from section 3.4. `evidence_mode` tells the brain whether a criterion depends on the words, the delivery, or both.

### Per-turn evidence (built by the backend for every call turn)

```json
{
  "turn_id": "t031",
  "speaker": "client",
  "start": 312.4,
  "end": 318.9,
  "measurements": { "pitch_st": 2.1, "loudness_db": 7.4, "rate_vps": 5.8, "overlap_s": 0.6, "delay_s": 0.2 },
  "emotion": {
    "probs": { "angry": 0.71, "sad": 0.08, "positive": 0.02, "neutral": 0.19 },
    "arousal": 0.74, "valence": 0.28, "dominance": 0.66,
    "angry_vs_speaker_avg": 0.42
  }
}
```

### Ear note (one per clip, validated with Pydantic)

```json
{
  "clip_id": "c07",
  "turn_ids": ["t031", "t032"],
  "heard_text": "...",
  "client": { "state": "frustrated", "cues": ["louder", "repeats the question"] },
  "operator": {
    "pace": "normal",
    "warmth": "warm",
    "irritation": false,
    "talks_over_client": false,
    "clarity": "clear",
    "cues": ["slows down after the complaint", "soft «түсінемін»"]
  },
  "confidence": "medium"
}
```

Enums: `pace` is `slow`, `normal` or `fast`; `warmth` is `warm`, `neutral` or `cold`; `clarity` is `clear`, `mumbled` or `unclear_audio`; `confidence` is `low`, `medium` or `high`.

### Brain output (one per vote, validated with Pydantic)

```json
{
  "language_detected": ["kk", "ru"],
  "client_intents": [
    { "intent": "Не проходит вывод средств", "turn_ids": ["t008", "t012"], "resolved": "partly" }
  ],
  "observations": [
    { "turn_ids": ["t031"], "who": "client", "kind": "emotional_moment",
      "signals": ["emotion", "measurements", "words"],
      "note": "Третий раз объясняет проблему, говорит громче и быстрее." },
    { "turn_ids": ["t032"], "who": "operator", "kind": "response",
      "signals": ["ear", "words"],
      "note": "«Түсінемін, кешіріңіз», спокойный темп, затем предлагает решение." }
  ],
  "criteria": [
    {
      "criterion_id": "empathy",
      "status": "assessed",
      "answer": 2,
      "explanation": "Оператор признал раздражение клиента в t032 и сразу перешёл к решению.",
      "evidence_turn_ids": ["t031", "t032"],
      "checked_turn_range": null,
      "na_reason": null,
      "review_required": false
    }
  ]
}
```

`status` is one of `assessed`, `not_applicable` or `insufficient_evidence`. Validation checks:

- every criterion appears exactly once;
- `answer` is in the criterion's scale;
- `not_applicable` is used only where `na_allowed` is true, and comes with `na_reason`;
- every turn id exists in the transcript;
- a "missed action" answer comes with `checked_turn_range`.

---

## 7. Scoring (code, not a model)

- Map each answer to points and normalise scales to 0..1, then multiply by the weight.
- N/A criteria drop out, and their weight is shared among the applicable criteria.
- A critical error is flagged separately and is applied the way the checklist says.
- Rounding follows the checklist.
- Appeals store the original result, the reviewer's decision and reason, and the final result. Every change triggers a recompute.

---

## 8. Hardware

Estimates: weights are parameters times bytes per parameter, plus about 15% for KV cache (about 32k context) and activations. The 2.4T model is a mixture of experts: only 95B parameters are active per token, but all 2.4T must sit in memory. vLLM prints the real numbers at startup; check them on the actual GPUs.

| Component | Precision | VRAM |
|---|---|---|
| Qwen3.8-2.4T-A95B | FP8 | about 2.8 TB (5.5 TB in BF16) |
| Qwen3.8-27B | FP8 | about 40 GB |
| Qolda-AVL-34B | BF16 (no official FP8) | about 85 GB |
| Qolda-AVL-9B | BF16 | about 22 GB |
| emotion2vec+ large, audeering A/V/D | FP16 | about 4 GB together |
| issai/whisper-turbo, pyannote | FP16 | about 4 GB (pyannote can also run on CPU) |
| Silero VAD, Parselmouth | | CPU only |

| Stack | Total | Hardware |
|---|---|---|
| **Best, all local**: 2.4T brain + Qolda-34B + specialists | about 2.9 TB | 3 nodes of 8× H200, or 2 nodes of 8× B200 |
| **Best, brain on the API**: qwen3.8-max + Qolda-34B + specialists | about 95 GB | 1× H200, or 2× 80 GB GPUs |
| **Practical**: Qwen3.8-27B + Qolda-34B + specialists | about 135 GB | 1× H200 (tight; split memory between the vLLM servers) or 2× 80 GB GPUs |
| **Minimum**: Qwen3.8-27B + Qolda-9B + specialists | about 70 GB | 1× 80 GB GPU |

Without a GPU cluster, the realistic way to run the best brain is the `qwen3.8-max` API.

Training needs far less: the emotion specialist trains on a 6 GB GPU because its backbone stays frozen (section 2.3). The limit there is disk space for the audio, about 50 GB if processed all at once.

---

## 9. Testing plan

Every component gets a measured result, and every component must show it improves the final scores (section 9.8). Tune on part of the data and report on the rest; the control set at hour 23 is the real held-out test.

### 9.1 Gold labels (start on day one, in parallel with the build)

- **Criteria:** two teammates independently score all 5 DEV calls and at least 30 chats (10 per language) with the checklist, then settle disagreements. Record their agreement before settling (Cohen's kappa); that is the human ceiling the system is compared to.
- **Turn emotion:** the same two label every client and operator turn in the 5 DEV calls (about 200 turns) with our 4 emotion labels plus operator warmth. Real Freedom Broker audio is the most honest emotion test we have.
- **Kazakh recordings:** see 9.5. A native Kazakh speaker labels them before seeing any output.

### 9.2 Alignment

- Metric: median error between aligned turn ends and Silero speech-segment ends, per call.
- Target: 0.5 s or better on every DEV call.
- Spot check: listen to 10 random "Listen" clips per call.

### 9.3 Emotion specialist

| Test set | What it shows | Report |
|---|---|---|
| Dusha podcast test part | Natural Russian speech | Macro F1 and confusion matrix; the published baseline is 0.54 macro F1 |
| KazEmoTTS, leave-one-speaker-out | Kazakh, acted (optimistic) | Macro F1 per held-out narrator |
| DEV turn labels (9.1) | Real calls | Macro F1 and agreement with the human labels |
| Kazakh recordings (9.5) | Our Kazakh phone audio | Whether p(angry) and valence separate the cold and warm versions |

Bake-off: emotion2vec+ large versus WavLM-large backbones, logistic regression versus MLP head, with and without the telephone augmentation. Each backbone and each audio variant needs its own extraction pass, so run the bake-off on the subset first. Keep the best on DEV turns, not on Dusha.

### 9.4 Brain

- **Agreement:** per criterion and per language, compare the voted answers with the settled gold labels (accuracy and Cohen's kappa). Target: at least the agreement between the two human annotators.
- **Kazakh bake-off:** on the KZ chats, compare Qwen3.8-27B, qwen3.8-max (or the 2.4T model) and ISSAI's Kazakh-tuned Qwen3.5. A native speaker also rates the explanations.
- **N/A:** precision and recall of `not_applicable` against gold.
- **Evidence:** for 50 random criteria, a human checks that the cited turns really support the explanation.
- **Stability:** how often a criterion's answer changes across the 3 votes. High flip rates point to unclear criterion definitions.

### 9.5 Ear and Kazakh delivery

1. **Contrast pairs.** Write 3 short Kazakh scripts and 1 mixed KZ/RU script (a complaint, a withdrawal problem, a confused new client). Two teammates act each script twice with **the same words**: once warm and attentive, once cold, rushed or dismissive.
2. **Word pairs.** Act the same script in the same calm tone, once with real acknowledgement and resolution and once with empty politeness and no help. This tests the brain, not the ear.
3. Record on a phone, then export as **mono 16 kHz MP3 at 32 to 48 kbps** to match the real calls.
4. Metric: the share of contrast pairs where the cold version gets a colder ear note, a lower valence and a worse delivery score. Suggested target: 80%.
5. Run Qolda-AVL-9B and Qolda-AVL-34B on the same pairs and keep the better one.
6. **Gate.** If neither size passes, the delivery criteria rely on the measurements and the emotion specialist, and are always marked `review_required`.

These recordings come from the team, with the team's consent, and stay out of the repo if anyone prefers that.

### 9.6 Review flags

- Rate: the share of criteria marked `review_required`. Suggested target: under 25%.
- Usefulness: of the criteria where the system disagrees with gold, the share that were flagged. A good flag catches most errors while staying under the rate target.

### 9.7 STT fallback

- **Kazakh WER and CER:** the scripts of the recordings in 9.5 are exact references, plus FLEURS Kazakh.
- **Russian:** FLEURS Russian, and the 5 DEV calls with their supplied transcripts as a rough reference (they are ASR output too).
- **Diarization:** speaker error on the 5 DEV calls, using the aligned supplied transcript as reference.
- **Role assignment:** share of calls where the operator is identified correctly.
- Run the DEV calls through the audio-only path and score them; compare with the scores from the supplied transcripts.

### 9.8 Ablations (does each component earn its place?)

Score the DEV calls and the Kazakh recordings four ways and compare agreement with gold on the delivery, emotion and empathy criteria:

1. transcript only;
2. plus measurements;
3. plus the emotion specialist;
4. plus Qolda's notes.

Drop any component that does not improve agreement. This table is also the strongest slide for the jury.

### 9.9 Speed

- Time per chat and per call, and total time for all 65 DEV records.
- Rehearse the control-set run: a resumable batch, results saved as they finish, all models warm before hour 23.

---

## 10. Cost per evaluation (the brief asks for it)

- **All local:** no API cost.
- **Brain through `qwen3.8-max`** (International prices: $2 per 1M input tokens, $6 per 1M output), 3 votes:
  - call: per vote about 15,000 tokens in (transcript, evidence table, notes, checklist) and about 10,000 out with full reasoning, so **about $0.27** for 3 votes;
  - chat: per vote about 5,000 in and 6,000 out, so **about $0.15** for 3 votes.
- The ear, the emotion specialist and STT always run locally.

Check the pricing page again before the defense.

---

## 11. Repo layout

```
backend/
  app.py              FastAPI routes, CORS-free proxy to the organizers' API
  datasource.py       GET by group_id, record normalisation, turn ids
  audio.py            player page to MP3, ffprobe, VAD, alignment, measurements, exchange clips
  stt.py              diarization, issai/whisper-turbo, role assignment
  models/
    brain.py          Qwen3.8 client (local vLLM or Model Studio), 3 votes, JSON Schema or repair retry
    ear.py            Qolda-AVL client (vLLM fork or Transformers), delivery notes
    emotion.py        emotion2vec+ with our trained head, audeering A/V/D
    prompts/          per-language notes for kk, ru and en
  fusion.py           two-signal rule for emotional moments
  review.py           review signals
  scoring.py          weights, N/A redistribution, critical errors, rounding
  schemas.py          Pydantic schemas
  db.py               SQLite: checklists, runs, results, appeals
training/emotion/
  prepare_data.py     Dusha and KazEmoTTS, label mapping, telephone augmentation
  extract.py          frozen backbone embeddings
  train_head.py       classifier, calibration
eval/
  gold/               human labels (criteria, turn emotion, Kazakh recordings)
  metrics.py          kappa, F1, WER, review flag stats
  ablations.py        section 9.8
  report.md           results table for the defense
frontend/
  index.html
  components/         cqa-list, cqa-card, cqa-transcript, cqa-player, cqa-checklist-editor, cqa-appeal
config/checklists/default.json
cache/audio/
```

---

## 12. Build order

1. **Questions to the organizers:** will any test call come without a transcript, and may transcripts be sent to Alibaba Cloud (only needed if the brain runs as qwen3.8-max)?
2. **Start gold labelling** (9.1) and the Kazakh recordings (9.5). They take the longest and block every metric.
3. Data plumbing, alignment and measurements. No models needed.
4. Brain on chats, with 3 votes and the scoring code. First agreement numbers.
5. Emotion specialist: data prep, embeddings, heads, bake-off (9.3). This can start right away on the 6 GB laptop; it does not wait for the big GPUs.
6. Qolda bring-up (the vLLM fork is the riskiest setup; fall back to Transformers), then the ear bake-off (9.5).
7. Full call pipeline, fusion and review flags, then the ablations (9.8).
8. STT fallback and its bake-off (9.7), if the organizers say audio-only calls are possible.
9. UI and the appeal flow, in parallel from step 3.
10. Rehearse the control-set run (9.9).

---

## 13. Alternatives considered

- **Qwen API omni models (`qwen3.5-omni-plus`, `qwen3.8-omni-flash`).** They hear Kazakh and judge words and tone together, but are API only. Removed by team decision, including as a backup listener: Qolda already covers Kazakh, Russian and English, and no published result shows the omni models reading Kazakh delivery better than Qolda.
- **Qwen3-Omni-30B-A3B as the ear.** Rejected: no Kazakh speech input.
- **Qolda-AVL-34B alone as both ear and brain.** Possible, but its Qwen3-VL backbone is a generation behind Qwen3.8 at reasoning, and rubric scoring is mostly reasoning.
- **Off-the-shelf emotion models as the emotion signal.** Kept only as the no-training fallback: emotion2vec+ large (9 classes) plus audeering A/V/D, treated as hints. They are not tuned for Russian, Kazakh or phone audio.
- **SenseVoice for emotion.** Its strong languages are Mandarin, Cantonese, English, Japanese and Korean; no Russian or Kazakh.
- **Qwen3.8-Flash-Next as the brain.** An experimental preview of the Qwen4 architecture with a non-Apache licence.
- **Text-only judging of calls.** Rejected: transcription throws away intonation and emotion.
- **Translate Kazakh to Russian, then judge.** Rejected: it erases сіз/сен, address terms and register (section 3.1).
- **gemini-3.8-flash.** A non-Qwen API that accepts audio. Not used, for the same reasons as the Qwen API omni models.

---

## Sources

- Qwen3.8-2.4T-A95B: https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B
- Qwen3.8-27B: https://huggingface.co/Qwen/Qwen3.8-27B
- Qwen3.8-Flash-Next: https://huggingface.co/Qwen/Qwen3.8-Flash-Next
- Alibaba Cloud Model Studio, model list: https://www.alibabacloud.com/help/en/model-studio/models
- Alibaba Cloud Model Studio, pricing: https://www.alibabacloud.com/help/en/model-studio/model-pricing
- Alibaba Cloud Model Studio, Qwen-Omni: https://www.alibabacloud.com/help/en/model-studio/qwen-omni
- Qolda-AVL-34B: https://huggingface.co/issai/Qolda-AVL-34B
- Qolda-AVL-9B: https://huggingface.co/issai/Qolda-AVL-9B
- Qolda-AVL-5B-GGUF (30 s windows): https://huggingface.co/issai/Qolda-AVL-5B-GGUF
- Qolda-AVL vLLM fork: https://github.com/IS2AI/vLLM-Qolda-AVL
- Qolda-AVL paper: https://doi.org/10.3390/bdcc10060192
- ISSAI models: https://huggingface.co/issai
- Qwen3-Omni-30B-A3B-Instruct: https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Instruct
- SAKURA benchmark: https://arxiv.org/abs/2505.13237
- CAMEO multilingual emotional speech: https://arxiv.org/abs/2505.11051
- EmoBox: https://www.isca-archive.org/interspeech_2024/ma24b_interspeech.pdf
- emotion2vec: https://aclanthology.org/2024.findings-acl.931.pdf
- Dusha dataset: https://arxiv.org/abs/2212.12266
- KazEmoTTS: https://arxiv.org/abs/2404.01033
- SER on natural speech, 2026 pilot study: https://arxiv.org/abs/2609.26054
- SenseVoice: https://github.com/QwenAudio/SenseVoice
- KSC2 corpus and ISSAI Whisper: https://www.isca-archive.org/interspeech_2022/mussakhojayeva22_interspeech.pdf
- pyannote speaker-diarization-community-1: https://huggingface.co/pyannote/speaker-diarization-community-1
- Kazakh Whisper large-v3 turbo: https://huggingface.co/shyngys879/kazakh-whisper-large-v3-turbo
- Kazakh Qwen3-ASR fine-tune: https://huggingface.co/nur-dev/Qwen3-ASR-0.6B-kk-ru-en
- Kazakh/Russian mixed STT: https://huggingface.co/alibiserikbay/kazakh-russian-mixed-stt
- GigaAM-v3: https://huggingface.co/ai-sage/GigaAM-v3
- Qwen3-ASR: https://pypi.org/project/qwen-asr/
