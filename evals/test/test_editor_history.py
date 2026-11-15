"""Controls for target isolation and local history suggestions. The ML dependency is optional."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@unittest.skipUnless(importlib.util.find_spec("sklearn"), "history experiments use scikit-learn")
class EditorHistoryTests(unittest.TestCase):
    def test_range_ends_and_continuation(self):
        import numpy as np
        from editor_history import suggest_ranges
        self.assertEqual(suggest_ranges(np.array([.99, .99, .01, .01, .99])), [[0, 1], [4, 4]])
        self.assertEqual(suggest_ranges(np.array([.01, .01])), [])

    def test_source_overlap_is_rejected_before_loading_any_reference(self):
        from editor_history import build
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("target", "different-name"):
                directory = root / name
                (directory / "evidence").mkdir(parents=True)
                media = dict(id="mic", hash=hashlib.sha256(b"same recording").hexdigest())
                (directory / "case.json").write_text(json.dumps(dict(id=name, projectId=name, media=[media], dialogueMedia=["mic"])))
                (directory / "evidence/mic.json").write_text(json.dumps(dict(mediaId="mic", words=[
                    dict(text="hello", start=0, end=.2)])))
            manifest = root / "history.json"
            manifest.write_text(json.dumps([dict(caseDir="different-name", reference="does-not-exist")]))
            with self.assertRaisesRegex(ValueError, "distinct"):
                build(manifest, root / "target")


if __name__ == "__main__":
    unittest.main()
