"""Exercise the exact self-contained Kaggle resolver without importing GPU code."""
import ast
from collections import defaultdict
import os
from pathlib import Path

import pytest

SOURCE = Path(__file__).parents[1] / "kaggle" / "train_emotion_head.py"
tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "AudioIndex")
namespace = dict(Path=Path, os=os, defaultdict=defaultdict)
exec(compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE), "exec"), namespace)
AudioIndex = namespace["AudioIndex"]


def test_direct_and_repackaged_paths(tmp_path):
    direct = tmp_path / "crowd" / "wavs" / "crowd.wav"
    nested = tmp_path / "podcast" / "audio" / "nested" / "podcast.wav"
    for p in (direct, nested):
        p.parent.mkdir(parents=True)
        p.write_bytes(b"fixture")
    index = AudioIndex(tmp_path)
    assert index.resolve(tmp_path / "crowd", "wavs/crowd.wav") == str(direct)
    assert index.resolve(tmp_path / "podcast", r"wavs\podcast.wav") == str(nested)
    assert index.by_name is not None


def test_missing_and_ambiguous_fail(tmp_path):
    with pytest.raises(FileNotFoundError):
        AudioIndex(tmp_path).resolve(tmp_path, "wavs/missing.wav")
    for name in ("a", "b"):
        (tmp_path / name).mkdir()
        (tmp_path / name / "same.wav").write_bytes(b"fixture")
    with pytest.raises(FileNotFoundError, match="found 2"):
        AudioIndex(tmp_path).resolve(tmp_path, "wavs/same.wav")


@pytest.mark.parametrize("path", ["../escape.wav", "/absolute.wav", "C:/absolute.wav"])
def test_reject_escape(tmp_path, path):
    with pytest.raises(ValueError):
        AudioIndex(tmp_path).resolve(tmp_path, path)
