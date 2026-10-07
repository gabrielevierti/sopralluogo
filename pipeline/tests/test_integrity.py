import json, shutil
from pathlib import Path

from sopralluogo.integrity import verify, case_fingerprint
from sopralluogo.models import sha256_file


def make_case(tmp: Path) -> Path:
    c = tmp / "caso"
    (c / "cameras").mkdir(parents=True)
    (c / "scene.json").write_text("{}")
    (c / "cameras" / "a.bin").write_bytes(b"\x00\x01" * 1000)
    orig = tmp / "video.mp4"
    orig.write_bytes(b"video")
    m = {"inputs": [{"file_name": "video.mp4", "sha256": sha256_file(orig)}],
         "outputs": [{"path": p, "sha256": sha256_file(c / p)} for p in ("scene.json", "cameras/a.bin")]}
    (c / "manifest.json").write_text(json.dumps(m))
    return c


def test_intact(tmp_path):
    c = make_case(tmp_path)
    (c / "workspace.json").write_text("{}")  # operator file: allowed
    r = verify(c, [tmp_path / "video.mp4"])
    assert r["intact"] and r["ok"] == 2 and r["operator_files"] == ["workspace.json"]
    assert r["fingerprint"] == case_fingerprint(c)


def test_changed_missing_added(tmp_path):
    c = make_case(tmp_path)
    (c / "cameras" / "a.bin").write_bytes(b"x")
    (c / "scene.json").unlink()
    (c / "extra.jpg").write_bytes(b"y")
    r = verify(c)
    assert not r["intact"]
    assert r["changed"] == ["cameras/a.bin"] and r["missing"] == ["scene.json"] and r["added"] == ["extra.jpg"]


def test_rewritten_manifest_changes_fingerprint(tmp_path):
    c = make_case(tmp_path)
    before = case_fingerprint(c)
    (c / "cameras" / "a.bin").write_bytes(b"tampered")
    m = json.loads((c / "manifest.json").read_text())
    m["outputs"][1]["sha256"] = sha256_file(c / "cameras" / "a.bin")
    (c / "manifest.json").write_text(json.dumps(m))
    r = verify(c)
    assert r["intact"]                      # files agree with the (rewritten) manifest...
    assert r["fingerprint"] != before       # ...but the fingerprint on record exposes it


def test_wrong_original(tmp_path):
    c = make_case(tmp_path)
    other = tmp_path / "altro.mp4"
    other.write_bytes(b"diverso")
    r = verify(c, [other])
    assert not r["intact"] and r["originals"][0]["matches"] is None
