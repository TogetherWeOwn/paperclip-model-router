from __future__ import annotations

import importlib.util
import sys
import json
import pathlib
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "check_lane_docs.py"
FIXTURES = pathlib.Path(__file__).parent / "data" / "tog2135"
SPEC = importlib.util.spec_from_file_location("check_lane_docs", SCRIPT)
assert SPEC and SPEC.loader
check_lane_docs = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = check_lane_docs
SPEC.loader.exec_module(check_lane_docs)


class LaneDocumentValidationTest(unittest.TestCase):
    def documents(self):
        return {
            path.name: json.loads(path.read_text())
            for path in FIXTURES.glob("*.json")
        }

    def validate(self, documents):
        errors = []
        for lane in check_lane_docs.LANES:
            errors.extend(check_lane_docs.validate_document(lane, documents.get(lane.document)))
        return errors

    def test_frozen_six_document_fixture_passes(self):
        self.assertEqual([], self.validate(self.documents()))

    def test_missing_zai_document_fails(self):
        documents = self.documents()
        documents.pop("zai.json")
        self.assertIn("zai.json: document must be a JSON object", self.validate(documents))

    def test_null_document_fails(self):
        documents = self.documents()
        documents["codex.json"] = None
        self.assertIn("codex.json: document must be a JSON object", self.validate(documents))

    def test_absent_or_invalid_weight_fails(self):
        for value in (None, 0, -1, True, "1"):
            with self.subTest(value=value):
                documents = self.documents()
                documents["codex.json"]["records"][0]["weight"] = value
                self.assertTrue(any("weight must be" in error for error in self.validate(documents)))

    def test_missing_governing_window_and_duration_fail(self):
        documents = self.documents()
        documents["opencode-go.json"]["records"][0].pop("governing_window")
        self.assertTrue(any("governing_window" in error for error in self.validate(documents)))

        documents = self.documents()
        documents["opencode-go.json"]["records"][0]["window_seconds"].pop("monthly")
        self.assertTrue(any("window_seconds" in error for error in self.validate(documents)))

    def test_provider_exposed_governing_reset_must_not_be_null(self):
        documents = self.documents()
        documents["kimi.json"]["records"][0]["weekly_resets_at"] = None
        self.assertTrue(any("weekly_resets_at must be" in error for error in self.validate(documents)))

    def test_zen_free_requires_explicit_null_governing_window(self):
        documents = self.documents()
        documents["zen-free.json"]["records"][0]["governing_window"] = "weekly"
        self.assertTrue(any("free lane governing_window must be null" in error for error in self.validate(documents)))

    def test_directory_loader_rejects_missing_and_malformed_files(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = pathlib.Path(raw)
            with self.assertRaisesRegex(check_lane_docs.ValidationError, "required document is missing"):
                check_lane_docs.load_directory(directory, check_lane_docs.LANES[0])
            (directory / "claude.json").write_text("not-json")
            with self.assertRaisesRegex(check_lane_docs.ValidationError, "malformed JSON"):
                check_lane_docs.load_directory(directory, check_lane_docs.LANES[0])


if __name__ == "__main__":
    unittest.main()
