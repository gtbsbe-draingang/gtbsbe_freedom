"""Listening check for line-to-audio offsets (#28). Opt-in; uses the private DEV recordings.

Run from backend/:
  uv run python tests/manual/alignment_check.py --audio-dir <private audio dir> --dev <dev.json> --out <dir>
It computes offsets with the production `audio.pipeline.analyse`, samples lines from every call
and writes `<out>/alignment-check.html`. Open it in a browser, play each sample and mark whether
the line starts within about 2 s of where playback starts; "Download results" saves a JSON file.
The page refers to the recordings by their local path; nothing is uploaded or committed.
"""
import argparse
import html
import json
import random
import sys
from pathlib import Path

PAGE = """<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Alignment check</title>
<style>body{{font:15px system-ui,sans-serif;margin:24px;max-width:980px}}tr td{{padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top}}
button{{font:inherit}}.call{{margin-top:28px}}.t{{font-variant-numeric:tabular-nums;white-space:nowrap}}</style></head><body>
<h1>Line-to-audio check (#28)</h1>
<p>For each row press <b>Play</b>: playback starts at the computed offset and stops after 6 s.
Mark <b>yes</b> if the quoted line starts within about 2 s of where playback started (a little early is fine),
<b>no</b> if it starts later or much earlier, <b>?</b> if you cannot tell. Then press <b>Download results</b>.</p>
<p>Method: {method}. Samples: {count}.</p>
{calls}
<p><button id="dl">Download results</button> <span id="done"></span></p>
<script>
const rows=[...document.querySelectorAll('tr[data-id]')];
let stopTimer=null;
for(const r of rows){{
  r.querySelector('.play').addEventListener('click',()=>{{
    for(const a of document.querySelectorAll('audio'))a.pause();
    const a=document.getElementById(r.dataset.audio);a.currentTime=Math.max(0,+r.dataset.t);a.play();
    clearTimeout(stopTimer);stopTimer=setTimeout(()=>a.pause(),6000);}});
}}
function count(){{const n=rows.filter(r=>r.querySelector('input:checked')).length;document.getElementById('done').textContent=n+' of '+rows.length+' marked';}}
document.addEventListener('change',count);count();
document.getElementById('dl').addEventListener('click',()=>{{
  const out=rows.map(r=>({{id:r.dataset.id,seconds:+r.dataset.t,mark:(r.querySelector('input:checked')||{{}}).value||null}}));
  const b=new Blob([JSON.stringify({{method:{method_json},checked_at:new Date().toISOString(),rows:out}},null,2)],{{type:'application/json'}});
  const l=document.createElement('a');l.href=URL.createObjectURL(b);l.download='alignment-check-results.json';l.click();}});
</script></body></html>"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio-dir", type=Path, required=True)
    parser.add_argument("--dev", type=Path, required=True, help="the private DEV dataset JSON")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--per-call", type=int, default=6)
    parser.add_argument("--seed", type=int, default=28)
    args = parser.parse_args()

    from app.models import Message
    from audio.pipeline import analyse
    from audio.vad import load_mono

    data = json.loads(args.dev.read_text(encoding="utf-8"))
    records = data["data"]["records"] if "data" in data else data
    calls = [r for r in records if r.get("channel") == "voice call"]
    method = "speech activity: per-speaker delay, onset nearest the length guess (#93)"
    rng = random.Random(args.seed)
    sections, total = [], 0
    for record in sorted(calls, key=lambda r: r["conversation_id"]):
        cid = record["conversation_id"]
        mp3 = args.audio_dir / f"{cid}.mp3"
        if not mp3.is_file():
            print(f"{cid}: no recording, skipped", file=sys.stderr)
            continue
        transcript = [Message(**m) for m in record["transcript"]]
        samples = load_mono(mp3, 16000)
        offsets, _ = analyse(transcript, samples, 16000)
        at = {o.message_index: o.seconds for o in offsets}
        pool = [i for i, m in enumerate(record["transcript"])
                if m["speaker"] in ("client", "operator") and i in at and len(m["text"].split()) >= 3]
        picked = sorted(rng.sample(pool, min(args.per_call, len(pool))))
        rows = []
        for i in picked:
            m = record["transcript"][i]
            rid = f"{cid}#{i}"
            radios = "".join(f'<label><input type="radio" name="{rid}" value="{v}"> {v}</label> ' for v in ("yes", "no", "?"))
            rows.append(f'<tr data-id="{rid}" data-audio="a-{cid}" data-t="{at[i]}"><td><button class="play">Play</button></td>'
                        f'<td class="t">{at[i]:.1f} s</td><td>[{i}] {m["speaker"]}: «{html.escape(m["text"][:160])}»</td><td>{radios}</td></tr>')
        total += len(rows)
        sections.append(f'<div class="call"><h2>{cid}</h2><audio id="a-{cid}" preload="auto" src="{mp3.resolve().as_uri()}"></audio>'
                        f'<table>{"".join(rows)}</table></div>')
        print(f"{cid}: {len(rows)} samples", file=sys.stderr)
    args.out.mkdir(parents=True, exist_ok=True)
    page = PAGE.format(method=html.escape(method), method_json=json.dumps(method), count=total, calls="".join(sections))
    (args.out / "alignment-check.html").write_text(page, encoding="utf-8")
    print(args.out / "alignment-check.html")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
