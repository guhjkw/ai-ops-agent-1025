"""Builds index.html from index.src.html with data/inbox.json embedded (so the page also works opened off disk)."""
import json, pathlib
root = pathlib.Path(__file__).resolve().parent
data = json.loads((root / "data" / "inbox.json").read_text())
blob = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
src = (root / "index.src.html").read_text()
assert src.count("__FALLBACK__") == 1
(root / "index.html").write_text(src.replace("__FALLBACK__", blob))
print("index.html", len((root / "index.html").read_text()), "bytes")
