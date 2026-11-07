# Emotion head for call audio (stream D, issue 29).
#
# Runs as a Kaggle script kernel with a T4 GPU and internet on.
# 1. Collect labelled clips from Dusha (RU), KazEmoTTS (KZ) and RESD (RU dialogs).
# 2. Make every clip sound like a DEV call: telephone band (300 to 3400 Hz),
#    random gain, MP3 at 32/40/48 kbps, 16 kHz mono, light noise.
# 3. Run frozen emotion2vec+ large once per clip, keep the 1024 number
#    utterance embedding and its own 9 class scores (the zero shot baseline).
# 4. Train a small head (linear and 2 layer MLP) on the embeddings, calibrate
#    it with temperature scaling, and report macro F1 on held out sets.
#
# Our labels: angry, sad (includes fear and worry), positive, neutral.

import glob
import json
import math
import os
import random
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

MODE = "full"  # bounded full run; caps below are recorded in clips.csv
CAP = {"smoke": 25, "full": None}[MODE]
OUT = "/kaggle/working"
LABELS = ["angry", "sad", "positive", "neutral"]
MAX_SECONDS = 15.0
MIN_SECONDS = 0.6
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:7.0f}s]", *a, flush=True)


def sh(cmd):
    log("$", cmd)
    subprocess.run(cmd, shell=True, check=False)


class AudioIndex:
    """Resolve metadata paths against real files, including repackaged nested audio.

    Scan once per dataset only if a direct relative path fails. Never guess between
    multiple files with the same name or substitute a different audio format.
    """

    def __init__(self, root):
        self.root = Path(root).resolve()
        self.by_name = None

    def resolve(self, base, relative):
        relative = Path(str(relative).replace("\\", "/"))
        if relative.is_absolute() or ".." in relative.parts or ":" in str(relative):
            raise ValueError("Audio metadata must contain a safe relative path")
        direct = (Path(base) / relative).resolve()
        if not direct.is_relative_to(self.root):
            raise ValueError("Audio path escapes the dataset")
        if direct.is_file():
            return str(direct)
        if self.by_name is None:
            self.by_name = defaultdict(list)
            for directory, _, files in os.walk(self.root):
                for name in files:
                    if name.lower().endswith(".wav"):
                        self.by_name[name].append(str(Path(directory) / name))
        matches = self.by_name.get(relative.name, [])
        if len(matches) != 1:
            raise FileNotFoundError(
                f"Expected one audio file for {relative.name}; found {len(matches)}"
            )
        return matches[0]


sh("pip install -q funasr imageio-ffmpeg 2>&1 | tail -n 3")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import torch  # noqa: E402

FFMPEG = "ffmpeg"
if subprocess.run("ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libmp3lame", shell=True).returncode != 0:
    import imageio_ffmpeg

    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
log("ffmpeg:", FFMPEG, "gpu:", torch.cuda.is_available() and torch.cuda.get_device_name(0))


def find(root, want, maxdepth=4, is_dir=False):
    """Walk without descending into big audio folders."""
    hits = []
    base = root.rstrip("/").count("/")
    for d, dirs, files in os.walk(root):
        depth = d.count("/") - base
        dirs[:] = [x for x in dirs if x not in ("wavs",) and depth < maxdepth]
        names = dirs if is_dir else files
        for n in names:
            if want(n):
                hits.append(os.path.join(d, n))
    return sorted(hits)


log("inputs:", os.listdir("/kaggle/input"))
rows = []  # dicts: path, label, corpus, split, speaker, lang, raw

# Dusha: raw per annotator rows; aggregate by majority vote.
DUSHA_MAP = {"angry": "angry", "sad": "sad", "positive": "positive", "neutral": "neutral"}
audio_indexes = {}
try:
    tsvs = find("/kaggle/input", lambda n: n.startswith("raw_") and n.endswith(".tsv"), maxdepth=5)
    log("dusha tsv:", tsvs)
    for tsv in tsvs:
        part = os.path.basename(tsv)[4:-4]  # crowd_train, podcast_test, ...
        df = pd.read_csv(tsv, sep="\t")
        if "hash_id" not in df.columns:
            log("skip", tsv, list(df.columns))
            continue
        base = os.path.dirname(tsv)
        log(part, "columns", list(df.columns))
        # strict majority of at least 2 votes; a gold label wins when present
        v = df.dropna(subset=["annotator_emo"]).groupby(["hash_id", "annotator_emo"]).size().rename("n").reset_index()
        v["tot"] = v.groupby("hash_id")["n"].transform("sum")
        top = v.sort_values("n", ascending=False).drop_duplicates("hash_id")
        top = top[(top["tot"] >= 2) & (top["n"] / top["tot"] > 0.5)].set_index("hash_id")["annotator_emo"]
        lab = top.astype(str)
        if "golden_emo" in df:
            gold = df.dropna(subset=["golden_emo"]).drop_duplicates("hash_id").set_index("hash_id")["golden_emo"]
            lab = gold.astype(str).combine_first(lab)
        first = df.drop_duplicates("hash_id").set_index("hash_id")
        first = first.loc[first.index.intersection(lab.index)]
        first["label_raw"] = lab.loc[first.index]
        first = first[first["label_raw"].isin(DUSHA_MAP.keys())]
        if "duration" in first:
            first = first[first["duration"].astype(float) >= MIN_SECONDS]
        root = next((p for p in Path(tsv).parents if p.name == "dusha-dataset"), Path(base))
        index = audio_indexes.setdefault(str(root), AudioIndex(root))
        for hid, r in first.iterrows():
            ap = str(r["audio_path"])
            path = index.resolve(base, ap)
            spk = str(r["source_id"]) if "source_id" in first and pd.notna(r["source_id"]) else hid
            rows.append(dict(path=path, label=DUSHA_MAP[r["label_raw"]], corpus="dusha_" + part.split("_")[0],
                             split=part.split("_")[1], speaker=spk, lang="ru", raw=r["label_raw"]))
        log(tsv, "rows", len(df), "clips kept", len(first))
except Exception:
    # A partial corpus must never silently produce apparently valid full scores.
    raise RuntimeError("Dusha manifest failed; training stopped before embedding") from None

# KazEmoTTS: EmoKaz/<speaker>/<split>/<speaker>_<emotion>_<id>.wav
KZ_MAP = {"angry": "angry", "sad": "sad", "scared": "sad", "fearful": "sad", "fear": "sad",
          "happy": "positive", "neutral": "neutral"}
try:
    roots = find("/kaggle/input", lambda n: n.lower() in ("emokaz", "kazemotts"), maxdepth=3, is_dir=True)
    log("kazemotts roots:", roots)
    seen = set()
    for r in roots:
        for w in glob.glob(os.path.join(r, "**", "*.wav"), recursive=True):
            parts = os.path.basename(w)[:-4].split("_")
            if len(parts) < 3 or w in seen:
                continue
            seen.add(w)
            spk, emo = parts[0], parts[1].lower()
            if emo not in KZ_MAP:
                continue
            rows.append(dict(path=w, label=KZ_MAP[emo], corpus="kazemotts", split="all",
                             speaker=spk, lang="kz", raw=emo))
    log("kazemotts clips", len(seen))
except Exception as e:
    log("KAZEMOTTS FAILED", repr(e))

# RESD: train.csv / test.csv with an emotion column and a path or name column.
RESD_MAP = {"anger": "angry", "sadness": "sad", "fear": "sad", "happiness": "positive",
            "enthusiasm": "positive", "neutral": "neutral"}
try:
    csvs = [c for c in find("/kaggle/input", lambda n: n in ("train.csv", "test.csv"), maxdepth=3)
            if "resd" in c.lower()]
    log("resd csv:", csvs)
    for c in csvs:
        df = pd.read_csv(c)
        log(c, list(df.columns), df.head(2).to_dict("records"))
        base = os.path.dirname(c)
        split = os.path.basename(c)[:-4]
        ecol = next(k for k in df.columns if df[k].astype(str).str.lower().isin(RESD_MAP.keys() | {"disgust"}).mean() > 0.8)
        n0 = len(rows)
        wav_index = {os.path.basename(w): w for w in glob.glob(os.path.join(base, split, "**", "*.wav"), recursive=True)}
        for rec in df.to_dict("records"):
            emo = str(rec[ecol]).lower()
            if emo not in RESD_MAP:
                continue
            path = None
            for k, v in rec.items():
                v = str(v)
                if v.endswith(".wav"):
                    cand = os.path.join(base, v)
                    path = cand if os.path.exists(cand) else wav_index.get(os.path.basename(v))
                    break
            if path is None and "name" in rec:
                path = wav_index.get(str(rec["name"]) + ".wav")
            if not path:
                continue
            spk = os.path.basename(path).split(" ")[0]
            rows.append(dict(path=path, label=RESD_MAP[emo], corpus="resd", split=split,
                             speaker=spk, lang="ru", raw=emo))
        log(c, "clips kept", len(rows) - n0)
except Exception as e:
    log("RESD FAILED", repr(e))

meta = pd.DataFrame(rows)
log("all clips before caps:\n", meta.groupby(["corpus", "split", "label"]).size().unstack(fill_value=0))

# Caps keep the run inside a few GPU hours and soften the neutral majority.
FULL_CAPS = {("dusha_crowd", "train"): 12000, ("dusha_crowd", "test"): 2500,
             ("dusha_podcast", "train"): 6000, ("dusha_podcast", "test"): 3000}
rng = random.Random(0)
keep = []
for (corpus, split, label), g in meta.groupby(["corpus", "split", "label"]):
    idx = list(g.index)
    rng.shuffle(idx)
    cap = CAP if CAP else FULL_CAPS.get((corpus, split))
    if corpus == "kazemotts" and not CAP:
        # at most 2500 per narrator and raw emotion
        sub = g.loc[idx].groupby(["speaker", "raw"]).head(2500).index.tolist()
        keep += sub
        continue
    if corpus == "kazemotts" and CAP:
        keep += g.loc[idx].groupby(["speaker", "raw"]).head(max(1, CAP // 4)).index.tolist()
        continue
    keep += idx[:cap] if cap else idx
meta = meta.loc[sorted(keep)].reset_index(drop=True)
required_parts = {(c, s) for c in ("dusha_crowd", "dusha_podcast", "resd") for s in ("train", "test")}
present_parts = set(zip(meta["corpus"], meta["split"]))
if not required_parts.issubset(present_parts) or "kazemotts" not in set(meta["corpus"]):
    raise RuntimeError(f"Required corpus partitions missing: {sorted(required_parts - present_parts)}")
missing = [p for p in meta["path"] if not os.path.isfile(p)]
if missing:
    raise RuntimeError(f"Manifest contains {len(missing)} missing audio files; training stopped")
meta["clip_id"] = np.arange(len(meta))
log("clips after caps:\n", meta.groupby(["corpus", "split", "label"]).size().unstack(fill_value=0))
meta.to_csv(f"{OUT}/clips.csv", index=False)


def phone_audio(path, seed):
    """Clip as a DEV call would sound: band limited, MP3 coded, 16 kHz mono, light noise."""
    r = random.Random(seed)
    gain = r.uniform(-6.0, 6.0)
    kbps = r.choice([32, 40, 48])
    snr = r.uniform(20.0, 40.0)
    enc = [FFMPEG, "-nostdin", "-loglevel", "error", "-i", path, "-t", str(MAX_SECONDS),
           "-af", f"highpass=f=300,lowpass=f=3400,volume={gain:.1f}dB",
           "-ar", "16000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", f"{kbps}k", "-f", "mp3", "pipe:1"]
    mp3 = subprocess.run(enc, capture_output=True, check=True).stdout
    dec = [FFMPEG, "-nostdin", "-loglevel", "error", "-f", "mp3", "-i", "pipe:0",
           "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1"]
    pcm = subprocess.run(dec, input=mp3, capture_output=True, check=True).stdout
    x = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
    if len(x) < int(MIN_SECONDS * 16000):
        return None
    power = float(np.mean(x ** 2)) + 1e-10
    x = x + np.random.default_rng(seed).normal(0.0, math.sqrt(power / 10 ** (snr / 10)), x.shape).astype(np.float32)
    return x


class Clips(torch.utils.data.Dataset):
    def __init__(self, df):
        self.paths = df["path"].tolist()
        self.ids = df["clip_id"].tolist()

    def __len__(self):
        return len(self.paths)

    def __getitem__(self, i):
        try:
            return self.ids[i], phone_audio(self.paths[i], self.ids[i])
        except Exception:
            return self.ids[i], None


from funasr import AutoModel  # noqa: E402

e2v = AutoModel(model="emotion2vec/emotion2vec_plus_large", hub="hf", disable_update=True)
loader = torch.utils.data.DataLoader(Clips(meta), batch_size=None, shuffle=False, collate_fn=lambda s: s,
                                     num_workers=os.cpu_count() or 4, prefetch_factor=16)
SHARD = 5000
os.makedirs(f"{OUT}/emb", exist_ok=True)
buf_id, buf_emb, buf_zs = [], [], []
zs_labels = None
failed = 0
failed_ids = []
shard_no = 0


def flush():
    global buf_id, buf_emb, buf_zs, shard_no
    if not buf_id:
        return
    np.savez(f"{OUT}/emb/shard_{shard_no:03d}.npz", clip_id=np.array(buf_id),
             emb=np.stack(buf_emb).astype(np.float16), zs=np.stack(buf_zs).astype(np.float32))
    shard_no += 1
    buf_id, buf_emb, buf_zs = [], [], []


log("embedding", len(meta), "clips")
for n, (cid, wav) in enumerate(loader):
    if wav is None:
        failed += 1
        failed_ids.append(int(cid))
        continue
    with torch.no_grad():
        res = e2v.generate(wav, granularity="utterance", extract_embedding=True,
                           disable_pbar=True, disable_log=True)[0]
    if zs_labels is None:
        zs_labels = [str(s) for s in res["labels"]]
        log("emotion2vec labels:", zs_labels)
    buf_id.append(cid)
    buf_emb.append(np.asarray(res["feats"], dtype=np.float32).reshape(-1))
    buf_zs.append(np.asarray(res["scores"], dtype=np.float32))
    if len(buf_id) >= SHARD:
        flush()
    if n % 2000 == 0:
        log(f"{n}/{len(meta)} done, {failed} failed")
flush()
log("embedding finished,", failed, "failed")
coverage = []
for (corpus, split), group in meta.groupby(["corpus", "split"]):
    failures = int(group["clip_id"].isin(failed_ids).sum())
    coverage.append(dict(corpus=corpus, split=split, total=len(group), failed=failures))
with open(f"{OUT}/coverage.json", "w") as f:
    json.dump(dict(mode=MODE, partitions=coverage, failed_clip_ids=failed_ids), f, indent=2)
if any(c["failed"] / c["total"] > 0.01 for c in coverage):
    raise RuntimeError("More than 1% of a partition failed decoding; see coverage.json; no scores published")

# Load everything back.
parts = [np.load(f) for f in sorted(glob.glob(f"{OUT}/emb/shard_*.npz"))]
cid = np.concatenate([p["clip_id"] for p in parts])
E = np.concatenate([p["emb"] for p in parts]).astype(np.float32)
ZS = np.concatenate([p["zs"] for p in parts])
m = meta.set_index("clip_id").loc[cid].reset_index()
y = m["label"].map({l: i for i, l in enumerate(LABELS)}).to_numpy()
log("embeddings", E.shape)


def zero_shot(scores):
    """Map emotion2vec's own 9 classes onto our 4."""
    def col(name):
        hits = [i for i, l in enumerate(zs_labels) if name in l.lower()]
        return scores[:, hits].sum(1) if hits else np.zeros(len(scores))
    s = np.stack([col("angry"), col("sad") + col("fear"), col("happy"), col("neutral")], 1)
    return s.argmax(1)


def macro_f1(t, p):
    f = []
    for k in range(len(LABELS)):
        tp = np.sum((t == k) & (p == k))
        fp = np.sum((t != k) & (p == k))
        fn = np.sum((t == k) & (p != k))
        if tp + fn == 0:
            continue
        f.append(0.0 if tp == 0 else 2 * tp / (2 * tp + fp + fn))
    return float(np.mean(f)) if f else float("nan")


def report(t, p):
    cm = np.zeros((4, 4), int)
    for a, b in zip(t, p):
        cm[a, b] += 1
    per = {}
    for k, l in enumerate(LABELS):
        tp, fp, fn = cm[k, k], cm[:, k].sum() - cm[k, k], cm[k, :].sum() - cm[k, k]
        per[l] = None if tp + fn == 0 else round(float(2 * tp / max(1, 2 * tp + fp + fn)), 3)
    return {"n": int(len(t)), "macro_f1": round(macro_f1(t, p), 4),
            "accuracy": round(float(np.mean(t == p)), 4), "f1_per_class": per, "confusion": cm.tolist()}


DEV = "cuda" if torch.cuda.is_available() else "cpu"


def fit_head(Xtr, ytr, Xva, yva, kind, epochs=60):
    """Linear or 2 layer MLP with class weighted cross entropy and early stopping on val macro F1."""
    mu, sd = Xtr.mean(0), Xtr.std(0) + 1e-6
    norm = lambda X: torch.tensor((X - mu) / sd, dtype=torch.float32, device=DEV)  # noqa: E731
    xt, xv = norm(Xtr), norm(Xva)
    yt = torch.tensor(ytr, device=DEV)
    counts = np.bincount(ytr, minlength=4).astype(np.float32)
    w = torch.tensor(counts.sum() / np.maximum(counts, 1) / 4, device=DEV)
    if kind == "linear":
        net = torch.nn.Linear(E.shape[1], 4)
    else:
        net = torch.nn.Sequential(torch.nn.Dropout(0.2), torch.nn.Linear(E.shape[1], 256), torch.nn.GELU(),
                                  torch.nn.Dropout(0.3), torch.nn.Linear(256, 4))
    net = net.to(DEV)
    opt = torch.optim.AdamW(net.parameters(), lr=1e-3, weight_decay=1e-2)
    best, best_state, bad = -1.0, None, 0
    for ep in range(epochs):
        net.train()
        perm = torch.randperm(len(xt), device=DEV)
        for i in range(0, len(xt), 512):
            b = perm[i:i + 512]
            loss = torch.nn.functional.cross_entropy(net(xt[b]), yt[b], weight=w)
            opt.zero_grad()
            loss.backward()
            opt.step()
        net.eval()
        with torch.no_grad():
            pv = net(xv).argmax(1).cpu().numpy()
        f = macro_f1(yva, pv)
        if f > best:
            best, bad = f, 0
            best_state = {k: v.detach().clone() for k, v in net.state_dict().items()}
        else:
            bad += 1
            if bad >= 8:
                break
    net.load_state_dict(best_state)
    net.eval()
    # temperature scaling on the validation logits
    with torch.no_grad():
        lv = net(xv)
    yv = torch.tensor(yva, device=DEV)
    logT = torch.zeros(1, device=DEV, requires_grad=True)
    o = torch.optim.LBFGS([logT], lr=0.1, max_iter=100)

    def closure():
        o.zero_grad()
        l = torch.nn.functional.cross_entropy(lv / logT.exp(), yv)
        l.backward()
        return l

    o.step(closure)
    T = float(logT.exp())

    def predict(X):
        with torch.no_grad():
            return torch.softmax(net(norm(X)) / T, 1).cpu().numpy()

    return predict, dict(net=net, mu=mu, sd=sd, T=T, val_macro_f1=best)


def group_val(idx, frac=0.1, seed=0):
    """Hold out whole speakers for validation."""
    spk = m.loc[idx, "corpus"] + "/" + m.loc[idx, "speaker"].astype(str)
    uniq = sorted(spk.unique())
    random.Random(seed).shuffle(uniq)
    hold = set(uniq[: max(1, int(len(uniq) * frac))])
    va = spk.isin(hold).to_numpy()
    return np.asarray(idx)[~va], np.asarray(idx)[va]


C, S, SPK = m["corpus"].to_numpy(), m["split"].to_numpy(), m["speaker"].astype(str).to_numpy()
is_test = np.isin(S, ["test"])
tests = {name: np.where((C == c) & (S == "test"))[0]
         for name, c in [("dusha_crowd_test", "dusha_crowd"), ("dusha_podcast_test", "dusha_podcast"),
                         ("resd_test", "resd")]}
tests = {k: v for k, v in tests.items() if len(v)}
kz = np.where(C == "kazemotts")[0]
ru_train = np.where((C != "kazemotts") & (S != "test"))[0]
results = {"mode": MODE, "labels": LABELS, "clips": int(len(m)), "failed_clips": failed,
           "counts": m.groupby(["corpus", "split", "label"]).size().reset_index().values.tolist()}

# Zero shot baseline: emotion2vec+ alone, no training.
zs_pred = zero_shot(ZS)
results["zero_shot"] = {k: report(y[v], zs_pred[v]) for k, v in tests.items()}
for s in sorted(set(SPK[kz])):
    v = kz[SPK[kz] == s]
    results["zero_shot"][f"kazemotts_{s}"] = report(y[v], zs_pred[v])

for kind in ["linear", "mlp"]:
    res = {}
    # Russian sets: train on all non test clips (including all KazEmoTTS), test on official test parts.
    tr, va = group_val(np.concatenate([ru_train, kz]))
    pred, info = fit_head(E[tr], y[tr], E[va], y[va], kind)
    for k, v in tests.items():
        res[k] = report(y[v], pred(E[v]).argmax(1))
    # Kazakh: leave one narrator out, Russian training data always included.
    for s in sorted(set(SPK[kz])):
        held = kz[SPK[kz] == s]
        tr, va = group_val(np.concatenate([ru_train, kz[SPK[kz] != s]]))
        p2, _ = fit_head(E[tr], y[tr], E[va], y[va], kind)
        res[f"kazemotts_{s}"] = report(y[held], p2(E[held]).argmax(1))
        if kind == "linear":
            # same narrator held out, but no Kazakh in training at all
            tr, va = group_val(ru_train)
            p3, _ = fit_head(E[tr], y[tr], E[va], y[va], kind)
            res[f"kazemotts_{s}_ru_only"] = report(y[held], p3(E[held]).argmax(1))
    results[kind] = res
    log(kind, json.dumps({k: v["macro_f1"] for k, v in res.items()}))

# Final heads: everything except the official test parts.
final = {}
for kind in ["linear", "mlp"]:
    tr, va = group_val(np.where(~is_test)[0])
    _, info = fit_head(E[tr], y[tr], E[va], y[va], kind)
    sd = {k: v.cpu().numpy() for k, v in info["net"].state_dict().items()}
    np.savez(f"{OUT}/head_{kind}.npz", mean=info["mu"], std=info["sd"], temperature=info["T"],
             labels=np.array(LABELS), **{k.replace(".", "_"): v for k, v in sd.items()})
    final[kind] = {"temperature": info["T"], "val_macro_f1": round(info["val_macro_f1"], 4)}
results["final_heads"] = final
results["seconds"] = round(time.time() - T0)
results["emotion2vec_labels"] = zs_labels
with open(f"{OUT}/metrics.json", "w") as f:
    json.dump(results, f, indent=1)
log("done", json.dumps({k: results[k] for k in ("final_heads", "seconds")}))
