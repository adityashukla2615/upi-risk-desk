"""Run: py -m unittest discover -s tests"""
import sys
import unittest
from pathlib import Path
from unittest import mock

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import config  # noqa: E402
from cycles import cycle_confidence, detect_rings  # noqa: E402

T0 = pd.Timestamp("2026-01-01")


def edges(*rows):
    """rows: (src, dst, amount, hours after T0)."""
    return pd.DataFrame([{"src": s, "dst": d, "amount": a, "timestamp": T0 + pd.Timedelta(hours=h), "txn_id": f"T{i}"}
                         for i, (s, d, a, h) in enumerate(rows)])


class CircularRings(unittest.TestCase):
    def test_three_account_loop_is_found(self):
        rings, stats = detect_rings(edges(("A", "B", 10_000, 0), ("B", "C", 9_500, 2), ("C", "A", 9_000, 5)))
        self.assertEqual(len(rings), 1)
        r = rings.iloc[0]
        self.assertEqual(r.accounts, "A B C")
        self.assertEqual(r.top_cycle, "A -> B -> C -> A")
        self.assertEqual(r.top_cycle_txns, "T0 T1 T2")
        self.assertAlmostEqual(r.retention, 0.9)
        self.assertEqual(stats["validated_cycles"], 1)

    def test_loop_entered_mid_cycle_is_found(self):
        rings, _ = detect_rings(edges(("A", "B", 9_000, 5), ("B", "C", 10_000, 0), ("C", "A", 9_500, 2)))
        self.assertEqual(rings.iloc[0].top_cycle, "B -> C -> A -> B")

    def test_one_way_user_to_merchant_payments_have_no_cycles(self):
        rows = [(f"USR{u}", f"MCH{m}", 5_000, u + m) for u in range(5) for m in range(3)]
        rings, stats = detect_rings(edges(*rows))
        self.assertTrue(rings.empty)
        self.assertEqual(stats["cyclic_components"], 0)
        self.assertEqual(stats["structural_cycles"], 0)

    def test_payments_out_of_time_order_are_rejected(self):
        rings, stats = detect_rings(edges(("A", "B", 10_000, 5), ("B", "C", 10_000, 2), ("C", "A", 10_000, 1)))
        self.assertTrue(rings.empty)
        self.assertEqual((stats["structural_cycles"], stats["validated_cycles"]), (1, 0))

    def test_value_leaking_out_is_rejected(self):
        rings, _ = detect_rings(edges(("A", "B", 10_000, 0), ("B", "C", 5_000, 1), ("C", "A", 5_000, 2)))
        self.assertTrue(rings.empty)

    def test_value_growing_beyond_top_up_is_rejected(self):
        rings, _ = detect_rings(edges(("A", "B", 10_000, 0), ("B", "A", 20_000, 1)))
        self.assertTrue(rings.empty)

    def test_loop_slower_than_window_is_rejected(self):
        late = config.CYCLE_WINDOW_HOURS + 1
        rings, _ = detect_rings(edges(("A", "B", 10_000, 0), ("B", "C", 10_000, 1), ("C", "A", 10_000, late)))
        self.assertTrue(rings.empty)

    def test_small_payments_are_ignored(self):
        amt = config.CYCLE_MIN_AMOUNT / 2
        rings, stats = detect_rings(edges(("A", "B", amt, 0), ("B", "A", amt, 1)))
        self.assertTrue(rings.empty)
        self.assertEqual(stats["payments_in_graph"], 0)

    def test_scc_pruning_drops_accounts_off_the_loop(self):
        _, stats = detect_rings(edges(("D", "A", 10_000, 0), ("A", "B", 10_000, 1), ("B", "C", 10_000, 2),
                                      ("C", "A", 10_000, 3), ("C", "E", 10_000, 4)))
        self.assertEqual(stats["accounts"], 5)
        self.assertEqual(stats["accounts_in_cyclic_components"], 3)

    def test_length_bound_is_respected(self):
        names = "ABCDEFG"
        loop = [(names[i], names[(i + 1) % 7], 10_000, i) for i in range(7)]
        with mock.patch.object(config, "CYCLE_MAX_LEN", 6):
            rings, stats = detect_rings(edges(*loop))
        self.assertTrue(rings.empty)
        self.assertEqual(stats["cyclic_components"], 1)
        self.assertEqual(stats["structural_cycles"], 0)
        with mock.patch.object(config, "CYCLE_MAX_LEN", 7):
            rings, _ = detect_rings(edges(*loop))
        self.assertEqual(len(rings), 1)

    def test_overlapping_loops_merge_into_one_ring(self):
        rings, stats = detect_rings(edges(("A", "B", 10_000, 0), ("B", "C", 9_800, 1), ("C", "A", 9_600, 2),
                                          ("B", "D", 9_800, 1.5), ("D", "A", 9_600, 2.5)))
        self.assertEqual(stats["validated_cycles"], 2)
        self.assertEqual(len(rings), 1)
        self.assertEqual((rings.iloc[0].accounts, rings.iloc[0].n_cycles), ("A B C D", 2))

    def test_separate_loops_stay_separate(self):
        rings, _ = detect_rings(edges(("A", "B", 10_000, 0), ("B", "C", 10_000, 1), ("C", "A", 10_000, 2),
                                      ("X", "Y", 10_000, 0), ("Y", "X", 10_000, 1)))
        self.assertEqual(sorted(rings.accounts), ["A B C", "X Y"])
        self.assertEqual(list(rings.ring_id), ["CR001", "CR002"])

    def test_repeated_loop_counts_instances_and_scores_higher(self):
        once = edges(("A", "B", 10_000, 0), ("B", "C", 9_500, 2), ("C", "A", 9_000, 5))
        twice = edges(("A", "B", 10_000, 0), ("B", "C", 9_500, 2), ("C", "A", 9_000, 5),
                      ("A", "B", 10_000, 24), ("B", "C", 9_500, 26), ("C", "A", 9_000, 29))
        r1, r2 = detect_rings(once)[0].iloc[0], detect_rings(twice)[0].iloc[0]
        self.assertEqual((r1.instances, r2.instances), (1, 2))
        self.assertGreater(r2.ring_score, r1.ring_score)

    def test_fast_full_value_round_trip_is_high_confidence(self):
        rings, _ = detect_rings(edges(("A", "B", 50_000, 0), ("B", "A", 50_000, 1)))
        self.assertEqual(rings.iloc[0].confidence, "HIGH")

    def test_confidence_cut_offs(self):
        with mock.patch.object(config, "CYCLE_CONFIDENCE_HIGH", 70), mock.patch.object(config, "CYCLE_CONFIDENCE_MEDIUM", 40):
            self.assertEqual([cycle_confidence(s) for s in (100, 70, 69.9, 40, 39.9, 0)],
                             ["HIGH", "HIGH", "MEDIUM", "MEDIUM", "LOW", "LOW"])


if __name__ == "__main__":
    unittest.main()
