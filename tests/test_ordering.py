from __future__ import annotations

import sys
from pathlib import Path
import unittest
from decimal import Decimal


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

import app  # noqa: E402


class LibraryOrderingRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.library = app.scan_library()

    def _series(self, name: str) -> dict:
        return next(series for series in self.library["series"] if series["name"] == name)

    def test_current_inventory_counts_remain_intact(self) -> None:
        self.assertEqual(sum(len(series["chapters"]) + len(series["appendix"]) for series in self.library["series"]), 1341)
        self.assertEqual(sum(series["totalImages"] for series in self.library["series"]), 91946)
        self.assertEqual(self._series("败者为寇")["totalImages"], 7398)

    def test_all_story_chapters_are_monotonic_by_explicit_order(self) -> None:
        """The reader must not append a lower-numbered special group after a later chapter."""
        series = self._series("史上最强")
        order = [Decimal(item["orderKey"][1:]) for item in series["chapters"]]
        self.assertEqual(order, sorted(order))
        by_number = {item["number"]: item["orderKey"] for item in series["chapters"]}
        self.assertLess(Decimal(by_number["373"][1:]), Decimal(by_number["374"][1:]))
        self.assertLess(Decimal(by_number["409"][1:]), Decimal(by_number["410"][1:]))

    def test_baizhe_decimal_chapter_is_in_story_chain(self) -> None:
        series = self._series("败者为寇")
        numbers = [Decimal(item["number"]) for item in series["chapters"]]
        self.assertLess(numbers.index(Decimal("28")), numbers.index(Decimal("28.5")))
        self.assertLess(numbers.index(Decimal("28.5")), numbers.index(Decimal("29")))
        self.assertEqual(len(series["appendix"]), 6)

    def test_exact_decimal_order_keys_support_insertions(self) -> None:
        self.assertLess(app.parse_order_key("S0001.5")[1], app.parse_order_key("S0002")[1])
        self.assertEqual(app.format_order_key("S", Decimal("1.5")), "S0001.5")

    def test_prologues_precede_main_story(self) -> None:
        series = self._series("我独自升级")
        self.assertTrue(series["chapters"][0]["folder"].startswith("我独自升级_序章_"))


if __name__ == "__main__":
    unittest.main()
