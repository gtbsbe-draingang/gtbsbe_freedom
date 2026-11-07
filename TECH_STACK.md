# CQA Hackathon: Tech Stack

The proposed stack for the Freedom Broker Conversation Quality Analytics prototype.
Updated 2026-11-07 for fully local inference, admin-created checklists and a **140 GB total VRAM ceiling**. GPU count, model and interconnect are not yet known; deployment discovers them instead of assuming one large GPU. Model recommendations are based on published cards, not a completed benchmark on our server. DEV measurements below are retained from the earlier investigation.

Requirements this stack is built around:

1. Admins create and version their own checklists and criteria. The official eight-criterion checklist is a starter template, not a fixed evaluator or a limit on criterion count.
2. Score the operator in **Kazakh, Russian and English**, including mixed KZ/RU conversations, using the selected checklist's definitions, scales and applicability rules.
3. Use audio when a criterion requires delivery, emotion or intonation evidence. Missing required evidence is distinct from failure and N/A.
4. All model inference stays on our machines. No hosted model fallback. Initial model downloads and the organizers' data import still need network access; cached inputs can be evaluated offline.
5. Stay within **140 GB aggregate VRAM**, targeting **at most 120 GB measured peak** and preserving about 20 GB headroom. Each GPU must also fit its own assigned workload.
6. Keep audio-only STT as a secondary path because the brief supplies transcripts. Prove accuracy, latency and memory use with measurements (section 9).

## Status on 7 November 2026: what the prototype actually runs

The rest of this document is the **target architecture** for fully local inference. The
prototype that ships for the defence does not use local models: it calls **Claude Haiku 5.5
through the Claude API**. Results files say `mode: external_api`; never present the demo as local.

| Layer | Planned below | Built and running |
|---|---|---|
| UI | Web Components, WaveSurfer call player | Plain JS bundled to one `app.js` and one `app.css`, strict CSP, Dynamics mock form (e2e passes); own call player linked to the transcript (#77) |
| Backend | FastAPI, Pydantic, httpx, SQLite | As planned |
| Brain (judges criteria) | Qwen3.8-27B-FP8, local | **Claude Haiku 5.5 via the API** (per-criterion override, e.g. Sonnet 5.5); one call per criterion, JSON schema output, every quote checked against the transcript, one retry, then «проверить» |
| Ear (audio questions) | Qolda-AVL-9B, local | Not built |
| Emotion specialist | emotion2vec+ large plus a trained head | Training script only (`training/emotion/`); the first full Kaggle run stopped on missing Dusha podcast audio, a fixed run is in progress; not used by the app |
| Measurements | Silero VAD, Parselmouth | Energy-based speech detection plus Parselmouth pitch, rate and pauses; stored when alignment is on; overlap is null; the evaluator does not read them, so c09 is not scored |
| Transcript to audio alignment | Per-call shift, checked against hand-labelled boundaries | Per-call shift, length guess, faster-whisper word snapping; listening check 29 of 30 within about 2 s (`backend/audio/README.md`) |
| STT fallback, diarization | Whisper-family ASR, pyannote | Not built (the brief supplies transcripts) |
| Scoring | Plain Python | As planned: exact fractions, N/A redistribution, half-up rounding, gross error as a separate flag |
| Admin checklists | Versions, fingerprints, reuse | As planned: immutable versions, fingerprint reuse, weight-only change makes zero model calls, dry run, comparison |
| Hardware | 140 GB local VRAM | Not needed: hosted API |
| Cost (section 10) | Local compute only | About **$0.0041 per dialogue**: $0.2685 for the 65 DEV dialogues, 613 calls |
| Testing (section 9) | Human gold labels, ablations, latency | 520 draft reference labels; agreement 79.75% on the 479 undisputed ones; 21 of 25 planted violations caught (`data/reference/`); no human-reviewed gold set, ablations or capacity tests yet |

## TL;DR (target architecture)

| Layer | Choice |
|---|---|
| UI | Vanilla HTML, CSS and JS, built as Web Components (ready to wrap as a Dynamics 365 web resource). WaveSurfer.js 7 with the Regions plugin for the call player |
| Backend | Python 3.12, FastAPI, Pydantic v2, httpx, SQLite |
| **Brain**: evaluates runtime criteria | **Qwen/Qwen3.8-27B-FP8**, served locally. One initial assessment; targeted verification for critical, uncertain or contradictory results |
| **Ear**: answers criterion-specific audio questions in KZ, RU and EN | **issai/Qolda-AVL-9B**, BF16. Test 34B separately before considering an upgrade |
| **Optional emotion specialist** | Frozen **emotion2vec+ large** with a small classifier trained on **Dusha** and **KazEmoTTS**, only if it improves held-out call evaluations. audEERING is a deferred experiment |
| Measurements | Silero VAD and Parselmouth (Praat): pitch, loudness and pace. Speaker intervals are additionally required for overlaps and response delays |
| Transcript to audio alignment | Per-call shift estimator as an initial hypothesis, checked against manually labeled speaker boundaries |
| STT fallback (audio only) | Local Whisper-family ASR selected by KZ/RU/EN tests, plus pyannote `speaker-diarization-community-1`; exact ASR checkpoint remains to be validated |
| Scoring | Plain Python. No model computes totals |

The brain returns evidence-backed criterion answers. Code validates and scores them; reviewers can revise them. Audio observations are supporting evidence, not fixed extra criteria. See section 6 for dynamic configuration and section 8 for hardware and the Python/Rust/C++ decision.

---

## 1. What the data forces

- **Calls are mono.** All 5 DEV recordings are MP3, 16 kHz, 1 channel, 32 to 48 kbps, 5 to 11 minutes long. Operator, client and IVR bot share one track. When a transcript is supplied, speaker identity comes from its labels (`operator`, `client`, `bot`, `system`). When it is not, we must diarize (section 5).
- **In DEV, all Kazakh is text.** DEV has 15 KZ chats, 15 EN chats, 30 RU chats and 5 RU calls. The only Kazakh audio is the IVR bot's greeting at the start of each call (a system event says "The dialog language changed from kk-KZ to ru-RU"), and the bot is not scored. Control calls may still be Kazakh, so every audio component must handle Kazakh speech.
- **Transcripts are supplied.** The brief says call transcripts are provided, and the control set at hour 23 is described as "дополнительные транскрипты". Keep audio-only processing secondary unless an actual input needs it.
- **Transcripts are ASR output.** Expect recognition errors, Kazakh and Russian mixed in one call, and masked names (`[Имя скрыто]`). The IVR's Kazakh greeting is rendered as garbled Russian ("Сами тебе Фридом брокер за кошки для нас"). Judges must not penalise the operator for transcription noise.
- **`audio_url` is a player page, not a file.** It returns HTML whose `<audio><source src>` is a Dynamics 365 SAS link that expires after about 1 hour. Fetch the page, download the MP3 once, cache it as `cache/audio/{conversation_id}.mp3`, and serve it from our backend. The cached file does not expire; only the link does.
- **The DEV fit suggests transcript timestamps mark utterance ends with a per-call shift.** The earlier investigation matched non-system turns to speech segments from a simple energy VAD:

  | Call | Shift | Median error vs segment end | Turns within 1 s |
  |---|---|---|---|
  | p4-ru-001 | 10.2 s | 0.23 s | 79% |
  | p4-ru-002 | 29.4 s | 1.17 s | 46% |
  | p4-ru-003 | 8.9 s | 0.26 s | 65% |
  | p4-ru-004 | 14.6 s | 0.27 s | 69% |
  | p4-ru-005 | 8.7 s | 0.52 s | 62% |

  Matching against segment starts fits worse (median 0.6 to 1.4 s), supporting the utterance-end hypothesis on these five recordings. p4-ru-002 contains a long hold, which hurts the fit. Distance to the same VAD segments used for fitting is a fit residual, not independent alignment accuracy. Validate against manually marked boundaries before attributing emotion or interruptions to a speaker. The algorithm is language-independent; its accuracy on Kazakh remains to be measured.

---

## 2. Models

### 2.1 Brain: Qwen3.8-27B-FP8

- **Default:** `Qwen/Qwen3.8-27B-FP8`, an official FP8 checkpoint with Apache 2.0 licensing and configurable thinking. General benchmark results motivate testing; they do not establish accuracy on our languages or unseen criteria.
- **Local challenger:** `issai/Qwen3.5-35B-A3B-Kazakh`, evaluated separately on Kazakh and mixed-language examples. Do not keep a second large judge resident by default or assume adaptation guarantees better rubric judgments.
- Build each request from the immutable checklist version: wording, guidance, answer choices, applicability and required evidence. No criterion-specific Python branches such as `if criterion_id == "empathy"`.
- Use one initial assessment per conversation or bounded criterion group. Verify critical violations, low-confidence results and contradictory evidence with a targeted second request. Preserve both answers and disagreements for review; repeated samples are not independent judges or calibrated confidence.
- Generate a JSON Schema for the current criterion IDs and permitted answers, enforce it with the local server, then validate evidence and applicability in Python. Schema compliance does not prove semantic correctness.
- Start with a **32k total context budget**, including prompt and output. Count actual tokens and group large checklists before overflow; never silently truncate the conversation. Shared guidance and criterion dependencies travel with every affected group.
- Compare supported reasoning settings and output budgets on held-out criteria. Use the selected model card's sampling guidance and pin model, tokenizer, runtime, prompt and decoding settings in every run. Do not copy settings from the 2.4T model.
- Run a pinned compatible vLLM build in its own environment. Device placement, tensor parallelism, memory allocation and concurrency are deployment configuration discovered on the actual server (section 8).
- The 2.4T model is excluded: FP8 weights alone are roughly 2.4 TB. There is no hosted-model fallback.

### 2.2 Ear: Qolda-AVL (ISSAI)

Start with **Qolda-AVL-9B** because its card explicitly covers **Kazakh, Russian and English speech**. Treat Qolda-AVL-34B as a separate accuracy experiment, not an automatic upgrade. Supported languages alone do not establish reliable emotion, sarcasm or politeness judgments.

- "Qolda-AVL is a 34B audio-vision-language model designed to operate in Kazakh, Russian, and English." Apache 2.0.
- Built on Qwen3-VL-32B-Thinking (the 9B version on Qwen3-VL-8B-Thinking), with an audio branch from a fine-tuned Whisper-large-v3-turbo encoder and an audio projector.
- The audio branch was trained for speech recognition, speech translation, audio classification and sound captioning. Ask it for observable evidence relevant to the current criteria; the brain applies the rubric. The emotion specialist is optional (section 2.3).
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

These results do not show a consistent audio advantage for 34B. The contrast test and unseen audio-criterion tests (section 9.5) decide whether its extra latency and memory are justified.

Serving and limits:

- vLLM needs ISSAI's fork, `github.com/IS2AI/vLLM-Qolda-AVL`. Its README names only the 5B checkpoint and does not state the base vLLM version, so bring it up first. The fallback is plain Transformers (`AutoModelForCausalLM`, `trust_remote_code=True`, bfloat16).
- The card's code loads `batyrme/Qolda-AVL-34B`; the published repos are `issai/Qolda-AVL-34B` and `issai/Qolda-AVL-9B`. Use the `issai` ones.
- Audio goes in through `chat/completions` as `input_audio` (base64 WAV). The example serve command allows one audio clip per prompt (`--limit-mm-per-prompt '{"audio": 1, "image": 1}'`).
- Start with **30-second exchange clips** (section 4.2), consistent with the Whisper encoder window. This is an initial processing choice, not a verified maximum duration for every Qolda runtime. Retain context across windows and coverage of the full call when required.
- The backbone is a Thinking model; the card does not say how to turn thinking off. Its example uses `max_new_tokens=4096`; benchmark a bounded budget rather than reserving that much generated text for every clip automatically.
- Give Qolda the audio, transcript context and the current evidence question, **without classifier predictions or the judge's proposed answer**. Combine outputs afterward. Transcript-conditioned notes are still not statistically independent of transcript judgments.
- Retain original audio and clip provenance. A future criterion can require a new question; fixed `warmth` or emotion fields are not a complete representation of the recording.

### 2.3 Optional emotion specialist

Emotion classification is an experiment, not a prerequisite for dynamic criteria or the demo. Test frozen embeddings with a small classifier on our languages and recording conditions. Keep it only if it improves criterion-level results on held-out real calls. Its fixed emotion labels do not limit which criteria admins can create.

| Part | Choice |
|---|---|
| Backbone (frozen) | `emotion2vec/emotion2vec_plus_large`. Challenger in the bake-off: `microsoft/wavlm-large`, the best encoder across 32 datasets in EmoBox |
| Classifier | Logistic regression or a 2-layer MLP on mean-pooled embeddings, with class weights for imbalance, then temperature scaling for calibrated probabilities |
| Training data | **Dusha** (Russian, about 350 h, acted and real podcast speech) and **KazEmoTTS** (Kazakh, about 75 h, acted, 3 narrators). English audio is not in DEV; add CREMA-D later if English calls appear |
| Arousal and valence | Deferred experiment: `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`, trained on English MSP-Podcast. Published licence CC BY-NC-SA; do not assume local deployment removes its usage restrictions |
| Output per turn | Experimental probabilities for `angry`, `sad` (includes worried), `positive`, `neutral`, with speaker-relative changes. Arousal/valence/dominance exist only if that optional model is enabled and validated; absent outputs stay absent |

Label mapping:

| Our label | Dusha | KazEmoTTS |
|---|---|---|
| angry | angry | angry |
| sad (incl. worried) | sad | sad, fearful |
| positive | positive | happy |
| neutral | neutral | neutral |
| dropped | other | surprised (valence is ambiguous) |

Training recipe. **The backbone stays frozen; only the small classifier is trained.**

1. Test audio augmentation on the CPU with FFmpeg: 16 kHz mono, MP3 re-encode at 32, 40 or 48 kbps, random gain and light noise. Compare telephone band-pass (300 to 3400 Hz) with retaining the original bandwidth; a 16 kHz sample rate alone does not establish a narrowband telephone channel.
2. Split by speaker. Dusha keeps its official split; retain its podcast test part for natural-speech evaluation. KazEmoTTS has only 3 narrators, so use leave-one-speaker-out (3 folds); this cannot establish generalization to natural Kazakh customer calls. Separate our training, tuning and test clips by whole call and speaker, not randomly by turn.
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

- **Development laptop:** RTX 4050 Laptop GPU with 6 GB. Use it for small-batch embedding experiments and test optional workers sequentially; this is not the target deployment or a promise that all models fit simultaneously.
- **Time:** measure decoding and embedding throughput on a subset before estimating a full training run. Do not put the whole dataset download or training run on the demo's critical path.
- **Disk:** about 425 hours of 16 kHz, 16-bit mono audio is roughly 49 GB before archives and augmented copies. Stream dataset parts and measure embedding storage before a full run; avoid assuming the laptop has enough free space.
- **Start with a subset:** Dusha's podcast part, about 50,000 Dusha crowd clips, and all of KazEmoTTS. Add more data only if the scores on the DEV call turns (section 9.3) improve.
- **Fine-tuning the backbone** is outside the initial build. If later justified by held-out errors, measure training memory and generalization separately. Much of the training data is acted speech, so fitting acting styles is a risk.

The proposed classifier does not have a warmth or coldness label. Those judgments require the configured criterion, contextual evidence and separate validation; they cannot be read directly from an emotion probability.

### 2.4 Why no Qwen omni model

- The published speech-input language list for `Qwen3-Omni-30B-A3B` does not include Kazakh. Unsupported-language behavior must not be treated as established capability.
- Hosted omni models are excluded by the fully local requirement regardless of their language coverage.
- Qolda is the default candidate for acoustic evidence in all three languages. The optional emotion specialist must earn its place through held-out tests.

### 2.5 Evidence is turn ids, never model-generated seconds

The brain returns turn IDs. The backend maps them to verified `[start, end]` intervals from alignment (section 4.2) or STT (section 5). A precise "Listen" link can include 2 seconds before and 1 second after, clamped to recording bounds. If timing is uncertain, expose that uncertainty and the recording instead of a falsely precise citation.

---

## 3. Kazakh: intention, empathy, emotion, intonation

### 3.1 Judge in the original language

Never translate Kazakh into Russian before judging. Translation erases the signals we score: сіз versus сен, address terms, register and politeness particles. The brain reads the original and the ear hears the original. Explanations are written in the UI language (Russian), and the evidence is quoted in the original Kazakh.

### 3.2 Observe first, then apply the selected criterion

Ask for relevant observations before criterion answers. This encourages evidence-based assessment but does not guarantee that the evidence supports the answer. Intent and empathy observations are examples, not mandatory fields for every checklist.

1. **Client intents.** What the client wants, in the brain's own words, with turn ids, and whether it was resolved (`yes`, `partly`, `no`).
2. **Emotional moments.** Candidate moments come from the observations in section 3.3. The brain checks them against the criterion and adds relevant evidence from the words.
3. **Operator response to each moment.** Did the operator acknowledge it, change pace or tone, apologise where appropriate, and then act on it?

An admin may define a criterion around acknowledgment and action, or use a different definition. Apply that definition and its answer scale exactly. The official starter's empathy criterion is Yes/No with no N/A; it must not silently become a 0-2 emotional-delivery scale. Tone affects an answer only when the configured criterion calls for it.

### 3.3 Corroboration and uncertainty

A **possible acoustic emotional moment** can be proposed from these observations. Thresholds below are experimental starting points, not global scoring rules:

| Signal | Starting threshold (tune on DEV labels) |
|---|---|
| Emotion specialist | p(angry) or p(sad) at least 0.6, or a rise of at least 0.3 over the client's call average |
| Measurements | Loudness at least 6 dB or pitch at least 3 semitones above the client's baseline, a clear speaking-rate jump, or talking over the operator |
| Ear | Qolda's note gives a non-neutral client state |
| Words | The transcript shows distress: repeating the problem ("үшінші рет айтып тұрмын", "третий раз объясняю"), complaints, threats to leave |

Agreement can support a reviewable hypothesis, but these signals share audio, words and possible biases; they are not independent votes. A clear spoken or written complaint can establish expressed dissatisfaction without raised pitch or an angry classifier output. Conversely, loudness alone cannot establish irritation. Preserve conflicting observations and apply the criterion's evidence requirements; do not use a blanket two-signal rule to permit or prohibit every failure.

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

### 4.1 Plan work from the checklist

1. Load the selected immutable checklist version and the original conversation. Assign stable turn IDs; preserve timestamps and bot/system context.
2. Compile the criterion definitions, answer choices, applicability, evidence requirements and output schema (section 6). This is configuration processing, not training or executing admin-supplied code.
3. Look up reusable evidence and criterion answers with matching provenance. A weight-only edit recalculates points; a wording, scale, applicability, shared-guidance or evidence change invalidates affected assessments and their dependents.
4. Determine which criteria need transcript, audio, reliable timing or local reference documents. Transcript-only criteria on calls follow the chat path. Required but unavailable evidence produces `insufficient_evidence`, never an invented answer or automatic N/A.
5. Count prompt and output tokens. Group compatible criteria within the configured context limit. Keep shared guidance and dependencies; for a long conversation, use explicit evidence retrieval and coverage tracking rather than silent truncation. Claims of an absent action require coverage of the relevant full interval.
6. Run one initial assessment per group, validate it, and selectively verify uncertain or critical results. Save partial job progress so batches resume after a failure.
7. Compute scores in code, preserve review flags and store the checklist, model, prompt and evidence versions used.

### 4.2 Calls needing audio evidence

1. Cache the source recording. Inspect channels with ffprobe before downmixing; keep separate speaker channels when they exist.
2. Run Silero VAD. For supplied transcripts, grid-search an initial shift between -10 and +45 seconds in 0.05-second steps against speech-segment ends, as in the DEV investigation. Preserve its fit residual as a diagnostic, not an accuracy score.
3. Verify start/end boundaries and speaker attribution on manually labeled examples. Use diarization when speaker timing is unresolved, even if a transcript exists. The interval between consecutive transcript end times is not a reliable isolated speaker turn; VAD alone does not identify overlapping speakers.
4. Extract only requested measurements from reliable speaker intervals. Unknown overlap, delay or pitch stays unknown rather than becoming zero. Use an optional validated emotion classifier only for relevant criteria.
5. Cut contextual exchange clips, initially at most 30 seconds. Split longer exchanges with overlap and retain global timestamps and speaker context. Use whole-call coverage when a criterion asks about every occurrence, not just a selected moment.
6. Send Qolda the clip, transcript context and criterion-specific evidence questions. Do not feed it classifier probabilities, other model verdicts or proposed scores. Use bounded concurrency under the memory budget.
7. Combine the resulting observations and contradictions after the independent requests. Each observation records its source, clip, question, model revision and relevant turn IDs.
8. Give the brain the evidence and the original criterion definitions. Validate, selectively verify and score as in section 4.1. A new criterion may need fresh audio questions even when existing observations are cached.

### 4.3 Calls with audio only

If this secondary path is enabled, run section 5 to create a transcript and speaker intervals, then follow sections 4.1 and 4.2. Validate ASR timestamps instead of applying the supplied-transcript shift. Do not replace an existing supplied transcript automatically.

### 4.4 Review signals

Mark `review_required` for unsupported or contradictory evidence, unresolved speaker attribution, unreliable timing needed by the criterion, a critical finding awaiting verification, or disagreement between initial and verification assessments. Model-reported uncertainty is an additional hint, not a calibrated probability.

A strong mismatch between Qolda's heard text and the supplied transcript is a diagnostic: inspect transcription, alignment and recognition errors. It is not proof that one source is correct. Preserve both versions.

Do not manufacture an assessed answer when required evidence is missing. Keep `insufficient_evidence` distinct from `not_applicable`, and show unresolved results to the reviewer.

---

## 5. STT fallback (audio only, secondary)

The guide supplies transcripts. Build this path after the core dynamic evaluator unless an actual input requires it.

| Step | Tool | Notes |
|---|---|---|
| Channel inspection | ffprobe | Retain separate speaker channels when available |
| Speech detection | Silero VAD | Local inference |
| Diarization | `pyannote/speaker-diarization-community-1` | Download gated weights during setup, then load locally. Test speaker count and IVR handling; do not assume exactly two speakers |
| ASR | Local Whisper-family candidate selected on KZ/RU/EN and mixed speech | Validate download availability, runtime, timestamps and recognition accuracy before pinning a checkpoint |
| Cross-check | Qolda-AVL-9B on selected uncertain clips | Costs additional inference time; reuse its loaded weights but do not call it free |
| Role assignment | Brain plus transcript labels/channel evidence where available | Distinguish operator, client and IVR; unresolved attribution requires review |
| Output | Transcript with provenance | Preserve start/end, original text, detected language where supported, and model version. Do not label raw ASR scores as calibrated confidence |

The earlier default `issai/whisper-turbo` could not be verified during this review; it is not a deployment dependency until a working checkpoint and its card are confirmed. Evaluate the previously identified Kazakh Whisper and mixed-speech candidates separately; no single fine-tune is assumed to retain all three languages. Keep original supplied transcripts and generated alternatives distinguishable.

---

## 6. Dynamic checklist configuration and evaluation contracts

### 6.1 Admin-defined checklists

Admins create, copy and edit checklists through the UI. Every save creates an immutable version; existing evaluations and appeals retain their original version. The official PDF is an exact starter template, including binary empathy without N/A and two-decimal rounding. Admin-created copies can use different definitions and scales.

The existing frontend design, section 7, remains the API contract. Its checklist fields already include `wording`, `guidance`, `answer_type`, `scale_steps`, `weight`, `na_allowed`, `na_condition`, `kind` and a semantic `fingerprint`. Keep compatible names instead of introducing a second wire format. A partial custom-criterion example is:

```json
{
  "id": "hold_notice",
  "section_id": "service",
  "order": 1,
  "title": "Explains an expected wait",
  "wording": "Before placing the client on an explicit hold, explain why a wait is needed.",
  "answer_type": "yes_no",
  "scale_steps": [],
  "weight": 10,
  "na_allowed": true,
  "na_condition": "The conversation contains no explicit hold.",
  "kind": "scored",
  "kinds": [],
  "guidance": "A system hold event can identify the expected action. Ordinary pauses alone do not establish a hold."
}
```

Definitions and guidance are open-ended. The initial answer types remain `yes_no` and `scale`, with explicit labels for every permitted scale step. Weights need not sum to 100. The evaluator must not hardcode particular IDs, topics, criterion counts or a fixed eight-field model response.

### 6.2 Evidence requirements and applicability

Store explicit requirements with each criterion version; expose them in the editor through a coordinated contract extension. The model can suggest them, but must not silently rewrite the admin's criterion.

| Requirement | Evaluator behavior |
|---|---|
| Transcript | Read original-language turns and preserve bot/system context without scoring those speakers |
| Audio | Ask criterion-specific questions of the original recording; a text summary alone is insufficient |
| Speaker timing | Require verified intervals for interruption, delay or duration claims |
| Reference documents | Retrieve from admin-supplied, locally stored, versioned policies or product documents; quote the supporting passage |
| Multiple evidence sources | Specify required versus optional sources and preserve conflicts |

A criterion such as fee accuracy needs the applicable fee schedule. A voice-only recording cannot establish whether an operator smiled. Return missing capability or evidence explicitly; arbitrary wording does not make an arbitrary property observable.

N/A means the configured applicability condition was satisfied. `insufficient_evidence` means the system cannot establish an answer. Neither is equivalent to a failed criterion.

### 6.3 Compile the schema per evaluation

Generate a JSON Schema from the criterion group being evaluated: exactly its criterion IDs, allowed answers and status-dependent fields. An object keyed by criterion ID can enforce required keys; Python must still verify full group coverage, answer membership, citations and consistency after generation.

Internal model output example (not the frontend transport object):

```json
{
  "criteria": {
    "hold_notice": {
      "status": "assessed",
      "answer": "yes",
      "explanation": "The operator explained the verification wait before the hold began.",
      "evidence_turn_ids": ["t031", "t032"],
      "reference_ids": [],
      "checked_turn_range": null,
      "na_reason": null,
      "missing_evidence": [],
      "review_required": false
    }
  }
}
```

For a scale, the answer uses the permitted step value, not its array position. For N/A or insufficient evidence, the internal `answer` is null and the corresponding reason is required. The adapter maps internal turn IDs to the API's message indices and verified playback intervals.

Validation checks every expected criterion exactly once, allowed answers, applicability rules, real turn/reference IDs, and an inspected range for a missed action. A model cannot supply totals or fabricate timestamps. A valid JSON document is not itself proof of a valid assessment.

### 6.4 Evidence reuse and versioning

Cache source audio, verified intervals and low-level measurements separately from criterion-conditioned notes and answers. Cache keys include conversation/transcript/audio hashes, alignment revision, extractor model and prompt versions, criterion semantics, shared guidance, dependent criteria and referenced document versions as applicable.

- Weight-only changes reuse answers and recompute all affected totals and section weights.
- Wording, scale, N/A rules, evidence requirements, shared guidance or document changes invalidate affected answers and dependencies. A replaced criterion receives a new ID.
- A new audio question invalidates any claim that existing fixed emotion/warmth notes fully cover it.
- Reuse a reviewer's decided answer only when conversation/evidence and criterion semantics remain compatible. Record its originating appeal; do not rewrite historical results.
- A forced full run bypasses assessment reuse. Reusable immutable source files remain available.

### 6.5 Required API contract updates before implementation

The current frontend design still refers to model keys and has no unresolved-answer representation. Update its single API contract and consumers together when implementing this plan:

- expose readiness of local model endpoints and capabilities rather than a paid API key gate;
- add evidence requirements and versioned reference-document selection to criteria;
- represent insufficient evidence with a null answer/points and a review reason; never convert it to `no` or `na` to fit the old enum;
- mark an aggregate with unresolved scored criteria incomplete, keeping the final numeric total null until resolved;
- preserve the existing immutable versions, evidence links, appeals and recomputation behavior.

These are planned contract changes, not implemented endpoints. Keep optional criterion model overrides restricted to configured local endpoints.

---

## 7. Scoring (code, not a model)

For the initial contract, Yes gives fraction 1, No gives 0, and a permitted scale step gives `step / maximum_step`. Validate finite, nonnegative weights and scale values, a positive maximum, unique steps and explicit step meanings. Higher steps must mean better performance for scored criteria; a future alternative mapping needs an explicit contract extension.

For fully resolved scored criteria:

`total = 100 * sum(weight * fraction) / sum(applicable_weight)`

N/A drops out of both sums only when allowed by the criterion. Weights do not have to total 100. Use exact decimal/rational arithmetic and round half-up to two decimals under the initial contract. No applicable positive weight means a null total, not zero.

An unresolved scored criterion is not silently removed from the denominator. Keep the evaluation incomplete and the final total null until evidence or a reviewer resolves it; show already assessed criterion results separately. An unresolved gross-error check keeps the critical finding pending even if weighted criteria are resolved.

Gross-error criteria have zero weight and a separate flag; their Yes means a violation was detected. Under the starter and current contract they do not zero the total. Any future caps or alternative scoring effects must be explicit versioned configuration, not inferred by the model.

Appeals retain original model answers, reviewer decisions and reasons. Recompute totals from the effective answers and the exact checklist version; record original and final results separately.

---

## 8. Hardware and runtime: 140 GB aggregate VRAM

### 8.1 Capacity policy

**Hard ceiling: 140 GB total VRAM. Operational target: at most 120 GB measured peak, with about 20 GB headroom.** GPU count, per-device capacity, architecture, system RAM and interconnect are unknown. Do not treat aggregate memory as one automatically pooled allocation. Normalize reported GB/GiB to bytes before enforcing the budget.

Initial planning estimates, including weights, bounded caches and runtime buffers:

| Component | Precision | Initial runtime budget |
|---|---|---|
| Qwen3.8-27B | FP8 | 45-55 GB |
| Qolda-AVL-9B | BF16 | 25-35 GB |
| Optional emotion, ASR and diarization workers | Model-dependent | 5-10 GB shared, scheduled on demand |
| **Default active stack** | | **75-100 GB** |
| **Unallocated capacity at that estimate** | | **40-65 GB**, including the 20 GB reserve |

These are budgets to validate, not measured requirements or guaranteed fits. Do not estimate KV cache as a fixed percentage of weight memory. Prompt length, generated tokens, active sequences, model architecture and graph/workspace allocations matter.

Qolda-34B has roughly 68 GB of BF16 weights before overhead. Test it separately; simultaneous residency with the judge is permitted only if measured peak and per-device limits pass. Qwen3.8-2.4T-A95B is out of scope: FP8 weights alone need roughly 2.4 TB. No API fallback is allowed.

### 8.2 Placement without assuming a GPU topology

At deployment, inspect `nvidia-smi`, per-device free memory and GPU interconnects. Keep device IDs, tensor-parallel size, per-instance memory limits, context limits and concurrency configurable.

- If each model fits a different GPU, place them separately and run relevant stages concurrently within the total budget.
- If one large GPU holds both, give the two servers explicit separate allocations. Do not let both independently reserve nearly all device memory.
- If a model must span GPUs, use a supported partition and benchmark communication overhead. Unequal capacities and slow links can limit usable aggregate memory.
- If simultaneous residency fails, schedule stages and release an idle model before loading another. Measure cold-load cost; do not promise interactive latency from a configuration that swaps models for every request.
- Start the judge with a 32k total token limit and the listener with short clips and a bounded text context. Admit jobs by token/clip size and available capacity, queue excess work, and return progress.
- On memory pressure, reduce concurrent sequences or split criterion groups. Preserve required context and evidence. Change precision or model size only after accuracy validation.

vLLM memory controls are per instance; configure the relevant pinned version and check actual process peaks. FP8 kernel availability and speed depend on GPU architecture, so an A100 and H100 are not equivalent even at equal capacity. Keep the Qolda fork isolated from the judge's environment.

Download and pin weights and code before the demo. Verify readiness and run a cached-input evaluation with model-service internet access disabled. Signed data acquisition is a separate network operation.

### 8.3 Python, Rust and C++

Keep Python/FastAPI for orchestration, Pydantic for validation and the supported Python model integrations. vLLM's heavy operations use compiled GPU kernels; replacing the API service with Rust does not replace those kernels or automatically increase tokens per second. Existing FFmpeg/Praat/native operations handle bulk audio processing.

Rust is an option for a measured CPU bottleneck or a team preference. A C++ engine such as llama.cpp is a separate serving-engine experiment requiring model/audio support checks and matched-model, matched-precision accuracy and throughput tests. Neither rewrite is on the initial build path.

Prioritize selective model calls, bounded generation, batching, compatible prefix caching, cached audio evidence and weight-only recomputation. Prefix caching can reduce repeated prompt processing; it does not eliminate output decoding. Profile queueing, input processing, generation, audio work and CPU overhead separately before optimizing a language boundary.

---

## 9. Testing plan

These are planned checks, not completed results. Tune on a development split, reserve an untouched test split, and treat the organizers' hour-23 control set as the final external check. Keep calls/speakers together when splitting audio; five DEV calls give limited evidence, so report sample counts and uncertainty.

### 9.1 Human labels

Two teammates independently label all five DEV calls and at least 30 chats across RU/KZ/EN using the exact checklist version, then resolve disagreements. Record agreement before resolution as a human baseline, not a mathematical ceiling. A native Kazakh speaker checks Kazakh interpretations and explanations. Label optional emotion and delivery tasks separately from checklist outcomes.

### 9.2 Alignment and attribution

Compare predicted turn starts/ends against manually marked audio boundaries and speaker identity. Report median and tail error, incorrect speaker attribution and unknown intervals. Retain VAD fit residual only as a diagnostic. Listen to ten sampled evidence clips per call. An initial median target of 0.5 seconds is provisional; require better evidence or review for timing-sensitive criteria.

### 9.3 Optional emotion specialist

Compare frozen emotion2vec+ and WavLM embeddings, simple classifier heads and telephone augmentation on a subset first. Use separate tuning/test calls. Report macro F1 and confusion matrices on Dusha podcast test data, held-out KazEmoTTS narrators and our real-call labels. Three acted Kazakh narrators do not demonstrate natural-call generalization. Enable the specialist only if criterion-level accuracy improves, not merely its training-dataset emotion score.

### 9.4 Brain

- Per criterion and language: answer accuracy, appropriate categorical/ordinal agreement metrics and evidence correctness against human labels.
- N/A and insufficient evidence: distinguish both from failure; measure false applicability and fabricated answers.
- Critical violations: precision and recall, including false accusations caused by quoting the client's words as the operator's.
- Compare Qwen3.8-27B-FP8 and the local ISSAI Kazakh challenger under the same prompts and evidence. Load challengers separately within the memory ceiling.
- Compare one pass plus selective verification with three-sample voting as an experiment. Agreement across samples measures stability, not truth.
- Compare supported reasoning/output budgets and any alternate quantization on identical held-out cases. Pin versions and decoding parameters.

### 9.5 Ear and unseen audio criteria

Record Kazakh and mixed KZ/RU contrast pairs: the same words delivered warmly versus rushed or dismissively, and different words delivered in the same calm tone. Match the DEV recording format. Have native speakers label the pairs before viewing model results.

Test the exact criterion asked, including new audio questions absent from the original warmth/emotion schema. Use contrast-pair ordering and evidence correctness; do not require valence output from a component that is disabled. Benchmark 9B first and 34B separately if capacity permits. A failed audio test means unsupported judgments remain unresolved or require human review; measurements alone cannot substitute for every audio criterion.

### 9.6 Review behavior

Report review rate and how many actual errors review flags capture, with false-positive and false-negative counts. Tune on a separate split. Do not optimize a low review rate by forcing answers when required evidence is missing.

### 9.7 Optional STT fallback

Measure KZ/RU/EN WER/CER and mixed-language errors on reference transcripts. Supplied DEV ASR text is a rough comparison, not gold truth. Use manually labeled intervals for diarization evaluation. Test operator/client/IVR role assignment and compare downstream rubric answers between supplied-transcript and audio-only paths.

### 9.8 Ablations

On fixed labeled criteria, compare transcript evidence, added measurements, added Qolda observations, and an added emotion specialist. Test combinations rather than assuming the specialist must precede Qolda. For criteria requiring audio, a transcript-only baseline must abstain when evidence is unavailable. Report coverage alongside accuracy so abstentions cannot disguise errors. Retain components only when they add useful evidence or improve held-out results.

### 9.9 Latency, capacity and offline operation

- Measure cold startup, warm p50/p95 completion time, throughput and queue wait separately for chats and calls.
- Include different checklist sizes, long definitions, long transcripts, audio-heavy criteria and simultaneous jobs. Record input/output tokens, generated reasoning, model calls and cache reuse.
- Measure peak VRAM per GPU and in aggregate, including all worker processes, during the worst supported combination. Pass only below device limits and the 120 GB operational target; never exceed the 140 GB ceiling.
- Test bounded queues and recovery after an out-of-memory failure without silent truncation or model substitution.
- Rehearse a resumable control-set batch, a new-checklist evaluation, an appeal and a weight-only recalculation.
- Preload models and cached recordings, then run inference with outbound model-service network access disabled. Verify no hosted fallback occurs.

### 9.10 Dynamic criteria acceptance

Hold out whole criterion definitions from prompt tuning as well as holding out dialogues. Have admins create new checklists through the UI and verify them against human labels:

1. A new criterion ID and definition works without code changes or model training.
2. Editing a criterion's meaning, scale steps, N/A rule or shared guidance changes the assessment when expected, with exact permitted answers.
3. Weight-only edits reuse answers and recompute totals and section weights; all-N/A and zero-applicable-weight cases produce null totals.
4. A calm explicit complaint still satisfies a dissatisfaction condition without an acoustic anger signal.
5. A new audio criterion requests new evidence when cached notes do not cover it; unavailable audio produces insufficient evidence, not N/A.
6. A policy-dependent criterion cites the configured document version; missing policy evidence does not become a confident factual judgment.
7. Contradictory or ambiguous criterion wording is surfaced for clarification/review, not silently rewritten by the model.
8. Large checklists are grouped without dropping criteria or shared context. Absence claims identify the covered range.
9. Old evaluations retain their exact versions; changed semantics do not inherit incompatible cached answers or appeal decisions.
10. Text inside a transcript is evidence, not an instruction that can replace the admin's checklist.

---

## 10. Cost per evaluation

All model calls are local, so hosted inference fees are zero. Compute, storage and electricity still have costs. Record model calls, GPU time, batch duration, processed records and cache hits. For a rented server, an approximate allocated batch cost per record is `server_hourly_rate * batch_wall_hours / completed_records`; include startup/idle time in the billed interval and disclose the allocation method. Do not quote API prices for a service we do not use.

---

## 11. Proposed evaluator modules

This is a build plan, not a claim that these modules exist. Keep the frontend design's API contract authoritative and implement the coordinated extensions in section 6.5.

```text
backend/
  app.py              FastAPI routes and local model readiness
  datasource.py       Organizer import, normalization, stable turn IDs
  checklists.py       Admin definitions, immutable versions, fingerprints
  planner.py          Evidence requirements, dependencies, token-bounded groups
  audio.py            Cached recordings, verified timing, measurements, clips
  stt.py              Optional local ASR, diarization and speaker roles
  references.py       Local versioned reference documents and citations
  models/
    brain.py          Local judge, runtime JSON Schema, targeted verification
    ear.py            Qolda with criterion-specific audio questions
    emotion.py        Optional frozen encoder and validated classifier
    prompts/          Language guidance and versioned prompt templates
  fusion.py           Source provenance and contradictions, no fixed voting rule
  review.py           Review flags and unresolved evidence
  scoring.py          Exact arithmetic, N/A, separate critical flags, rounding
  schemas.py          Runtime and API validation
  cache.py            Evidence/assessment dependencies and invalidation
  db.py               Checklists, runs, references, results and appeals
training/emotion/     Optional subset preparation, embedding extraction, classifier
config/
  checklists/         Official starter and optional templates
  inference/          Local endpoints, devices, memory and context limits
cache/audio/         Private cached recordings, excluded from commits
eval/
  gold/               Human labels and held-out criterion definitions
  metrics.py          Answer, evidence, timing and review metrics
  ablations.py        Component and verification comparisons
  report.md           Measured accuracy, latency and memory; no assumed results
```

---

## 12. Build order

1. Implement versioned admin checklists and preserve the official checklist as a starter. Synchronize the API contract for local readiness, evidence requirements and unresolved answers.
2. Start human labeling and held-out criterion creation while building the evaluator. Separate tuning and test cases before inspecting model results.
3. Bring up the local judge. Discover the server topology automatically, pin runtime/model versions, configure explicit allocations and measure memory with realistic prompts.
4. Build the transcript path: runtime schema, evidence validation, deterministic scoring, reuse and selective verification. Demonstrate a completely new criterion from the UI.
5. Complete the result, evidence navigation and appeal flows, including a weight-only edit and recomputation.
6. Validate recording alignment and speaker intervals. Bring up Qolda-9B in an isolated environment and add criterion-specific audio requests.
7. Run audio and missing-evidence tests. Add local reference-document support for policy-dependent criteria.
8. Experiment with emotion classifiers, Qolda-34B and ASR only after the core paths work. Keep each only when its measured benefit justifies latency and memory.
9. Run combined-load and offline-inference checks under the 140 GB ceiling, targeting 120 GB peak.
10. Rehearse the control-set batch, changed-checklist test and five-minute demo on the pinned deployment.

No extra confirmation about the unknown GPU topology is required to continue the design. Exact process placement is resolved from the actual hardware during deployment.

---

## 13. Alternatives considered

- **Qwen3.8-2.4T-A95B:** excluded by the 140 GB VRAM limit for the intended GPU-resident service.
- **Hosted Qwen, Gemini or other inference APIs:** excluded by the fully local requirement, including fallback paths.
- **Qolda-AVL-34B:** a separately benchmarked challenger; no assumed improvement over 9B and no guaranteed co-resident fit.
- **Qolda alone as listener and judge:** possible experiment, but must pass unseen text and audio criteria tests before combining the roles.
- **Qwen3-Omni-30B-A3B:** its published speech language list does not establish Kazakh support, so it is not the default listener.
- **Off-the-shelf emotion predictions:** optional hints, never a replacement for criterion definitions or validation on our languages and audio conditions.
- **Three judge votes on every input:** an evaluation baseline, not the default. Repeated sampling does not provide independent evidence.
- **Rust API or C++ inference engine:** profile-driven options. A language rewrite is not assumed to accelerate GPU inference or support custom Qolda audio code.
- **Transcript-only call evaluation:** valid for transcript-only criteria; insufficient for criteria requiring acoustic evidence.
- **Translate Kazakh before judging:** avoid because politeness, register and code-switching can change. Explanations may be in the UI language while evidence remains in the original language.

---

## Sources

Local requirements: the hackathon guide, the official starter-checklist PDF, and the team's frontend design/API contract. Published sources below support model/runtime facts; our task accuracy, latency and memory remain to be measured.

- Qwen3.8-27B-FP8: https://huggingface.co/Qwen/Qwen3.8-27B-FP8
- Qwen3.8-2.4T-A95B parameter count: https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B
- ISSAI Kazakh judge challenger: https://huggingface.co/issai/Qwen3.5-35B-A3B-Kazakh
- Qolda-AVL-9B: https://huggingface.co/issai/Qolda-AVL-9B
- Qolda-AVL-34B: https://huggingface.co/issai/Qolda-AVL-34B
- Qolda-AVL-5B-GGUF audio window documentation: https://huggingface.co/issai/Qolda-AVL-5B-GGUF
- Qolda-AVL vLLM fork: https://github.com/IS2AI/vLLM-Qolda-AVL
- Qwen3-Omni speech languages: https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Instruct
- emotion2vec+ large: https://huggingface.co/emotion2vec/emotion2vec_plus_large
- audEERING A/V/D training and license: https://huggingface.co/audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim
- EmoBox encoder comparison: https://www.isca-archive.org/interspeech_2024/ma24b_interspeech.pdf
- Dusha dataset: https://arxiv.org/abs/2212.12266
- KazEmoTTS dataset: https://arxiv.org/abs/2404.01033
- pyannote local/offline diarization: https://huggingface.co/pyannote/speaker-diarization-community-1
- Kazakh Whisper candidate: https://huggingface.co/shyngys879/kazakh-whisper-large-v3-turbo
- Mixed-speech ASR candidate: https://huggingface.co/alibiserikbay/kazakh-russian-mixed-stt
- vLLM runtime JSON Schema: https://docs.vllm.ai/en/latest/features/structured_outputs/
- vLLM memory controls: https://docs.vllm.ai/en/latest/configuration/engine_args/
- vLLM FP8 hardware support: https://docs.vllm.ai/en/latest/features/quantization/llm_compressor/fp8/
- vLLM compilation: https://docs.vllm.ai/en/latest/design/torch_compile/
- vLLM prefix caching: https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/
- llama.cpp: https://github.com/ggml-org/llama.cpp
