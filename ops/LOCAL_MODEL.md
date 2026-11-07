# Local main model: Qwen3.8-27B-FP8 on vLLM

**Decision (7 November 2026):** the demo and the control set are evaluated by
`Qwen/Qwen3.8-27B-FP8`, served by vLLM on our own GPU. The evaluator code is
unchanged; it reaches vLLM through vLLM's Anthropic-compatible `/v1/messages`
endpoint. Claude stays one `.env` change away, and the code default is still
`claude-haiku-5-5`, so a fresh clone without a GPU keeps working.

## Why

Measured on all 65 DEV dialogues with the official checklist v1 and the same
evaluator code (masking, prompts, answer checking, one retry, Python scoring):

| Model | Where | Agreement with references | Planted violations | All 65 dialogues | Cost |
|---|---|---|---|---|---|
| Claude Haiku 5.5 | Claude API | 80.7% | 21 / 25 | about 11 min | $0.27 |
| Claude Sonnet 5.5 | Claude API | 79.5% | 23 / 25 | 10 min 40 s | $3.31 |
| Qwen3.8-27B (BF16) | our GPU | 88.0% | 21 / 25 | about 22 min | $0 |
| **Qwen3.8-27B-FP8** | **our GPU** | **88.2%** | **20 / 25** | **15 min 13 s** | **$0** |

- **Agreement** is with the 517 undisputed answers in `data/reference/dev_labels.json`
  (the #25 readings approved). The labels were drafted with Opus 5.5 (#24), so agreement
  measures closeness to those references, not organiser ground truth. The 25 planted
  violations (`backend/quality/planted.py`) are the model-independent check.
- FP8 and BF16 give the same answer on 92.5% of the 520 criteria (part of the difference is
  sampling at temperature 0.7). FP8 is about 1.5× faster and needs half the weight memory.
- **Evaluate with `official-chat` v3.** On v1, Haiku beats Qwen on c07 (87.7% vs 64.6%) because
  v1 lacks the approved #25 goodbye rule; Qwen FP8 on v2 gets 91.3% overall on 517 labels.
  v3 adds the c08 rule below. Qwen FP8 with it: c08 100% (all 8 planted gross errors, 0 false
  flags, against 5 of 8 on v2), planted violations 23 of 25, overall 90.9%.
- Every model-backed feature works on the local model: evaluation, dialogue information,
  translation (KZ/EN → RU), appeal with second opinion, reviewer decision, v1 → v2 comparison,
  analytics, accuracy report, CSV export, and the «Звонки» checklist with audio alignment.
- Fixed in v3: confidential disclosures were marked c03 «Нет» but missed as c08 gross errors
  (`p1-kz-015` by every model; `p1-en-014`, `p1-ru-009` by Qwen). v3's c08 guidance names the
  case.

Where the comparison ran: the JupyterHub pod `jupyter-amirizimov`, one NVIDIA H200 shared with
other pods (55 GB and 99–100% use held by them).

## Serve the model

vLLM 0.33 in its own environment. Download the official checkpoint once (31 GB):

```sh
hf download Qwen/Qwen3.8-27B-FP8 --local-dir ~/models/Qwen3.8-27B-FP8
```

Start it (about 3.5 minutes until it answers):

```sh
export VLLM_USE_DEEP_GEMM=0   # DeepGEMM compiles kernels at start and needs a CUDA toolkit
vllm serve ~/models/Qwen3.8-27B-FP8 \
  --served-model-name Qwen3.8-27B-FP8 --host 127.0.0.1 --port 8038 \
  --max-model-len 32768 --gpu-memory-utilization 0.55 --max-num-seqs 32 \
  --enable-prefix-caching --reasoning-parser qwen3 \
  --default-chat-template-kwargs '{"enable_thinking": false}' \
  --override-generation-config '{"temperature": 0.7, "top_p": 0.8, "top_k": 20}'
```

- 0.55 of an H200 holds 28 GiB of weights and a 44 GiB KV cache (579k tokens).
- Thinking is off by default; the evaluator's `effort` (low or medium) still reaches the chat
  template. Qwen's template rejects `high` (only low, medium, xhigh); the evaluator never sends it.
- vLLM turns the evaluator's `output_config.format` into constrained JSON decoding, so answers
  always match the schema.

## Point the backend at it

`backend/.env` (git-ignored):

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8038
ANTHROPIC_API_KEY=local
DEFAULT_MODEL=Qwen3.8-27B-FP8
PRICES={"Qwen3.8-27B-FP8":{"input":"0","output":"0"},"claude-haiku-5-5":{"input":"0.10","output":"0.50"},"claude-sonnet-5-5":{"input":"2.00","output":"10.00"}}
MAX_PARALLEL_CALLS=32
MODEL_TIMEOUT_SECONDS=300
```

- `ANTHROPIC_BASE_URL` is a setting read from `.env` and passed to the Anthropic client. An
  `ANTHROPIC_BASE_URL` in `.env` alone did nothing before this setting existed, because
  pydantic-settings does not export `.env` values to the SDK.
- `ANTHROPIC_API_KEY` must be non-empty; vLLM ignores its value.
- `PRICES` replaces the whole table, so keep the Claude entries in it.
- `MODEL_TIMEOUT_SECONDS=300`: the default 60 s suits the Claude API. On a shared GPU a long
  answer (1,600–2,100 tokens on calls) takes 60–100 s, and at 60 s every such call timed out,
  retried and failed (22 of 130 evaluations in the first run).
- A restart of the backend fails the job items it was running with `interrupted`; the job's
  retry (`POST /jobs/{id}/retry`) finishes them.

**Back to Claude:** start with `uv run cqa-serve --llm-api`. It ignores `ANTHROPIC_BASE_URL` and
`DEFAULT_MODEL` and evaluates with `claude-haiku-5-5` on the Claude API, so `ANTHROPIC_API_KEY` in
`.env` must be the real key. For good: remove `ANTHROPIC_BASE_URL`, set the real `ANTHROPIC_API_KEY` and
`DEFAULT_MODEL=claude-haiku-5-5` (or Sonnet), restart.

## Results files

The organisers' results file records how the model ran. With the local model:

```sh
uv run python -m quality.control_run --group <control group_id> --model-mode local --out ../results/prod/results.json --expect 10
uv run python -m quality.results_export --group <group> --mode local ...
```

Run `control_run` on the machine that serves the backend, next to vLLM.

## Speed

| | BF16, 16 parallel | FP8, 32 parallel |
|---|---|---|
| Generation, all requests together | median 392 tok/s | 410–830 tok/s |
| One criterion call, median / 90th percentile | 35 s / 103 s | 41 s / 74 s |
| One dialogue in the UI | 30–60 s (chat), 1–2 min (call) | about the same per dialogue, more in parallel |

Each request gets 19–30 tok/s on the shared GPU whatever our parallelism; the other pods' load
sets it. Next steps for speed, in order: a GPU we do not share, then MTP speculative decoding
(the FP8 checkpoint ships the MTP layers).
