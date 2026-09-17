"""Run: py -m unittest discover -s tests   (needs outputs/ built and `anthropic` installed; no API key required)"""
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

try:
    import llm_agent  # noqa: E402
except ImportError as e:  # anthropic not installed
    llm_agent = None
    SKIP = f"llm_agent unavailable: {e}"
else:
    SKIP = None if llm_agent.DB.exists() else "outputs/upi_analytics.db not built"


@unittest.skipIf(SKIP, SKIP or "")
class SqlToolGuard(unittest.TestCase):
    """The agents' SQL tool must stay read-only and must never hand personal identifiers to the model."""

    @classmethod
    def setUpClass(cls):
        cls.db = sqlite3.connect(f"file:{llm_agent.DB}?mode=ro", uri=True)
        cls.db.set_authorizer(llm_agent.Tools._authorize)

    def test_aggregate_select_is_allowed(self):
        rows = self.db.execute("SELECT kyc_status, COUNT(*) FROM fact_transactions GROUP BY 1").fetchall()
        self.assertEqual(sum(n for _, n in rows), 20000)

    def test_views_are_readable(self):
        self.assertTrue(self.db.execute("SELECT merchant_category, dispute_rate FROM v_category_disputes").fetchall())

    def test_private_columns_are_blocked(self):
        for query in ("SELECT pan FROM dim_users", "SELECT aadhaar_last4 FROM dim_users", "SELECT utr FROM fact_transactions",
                      "SELECT settlement_account_last4 FROM dim_merchants", "SELECT * FROM dim_users"):
            with self.subTest(query=query), self.assertRaises(sqlite3.DatabaseError):
                self.db.execute(query).fetchall()

    def test_writes_are_blocked(self):
        for query in ("DELETE FROM dim_users", "UPDATE fact_transactions SET amount = 0", "DROP TABLE dim_users",
                      "CREATE TABLE x (a)", "ATTACH DATABASE ':memory:' AS m", "PRAGMA writable_schema = 1"):
            with self.subTest(query=query), self.assertRaises(sqlite3.DatabaseError):
                self.db.execute(query)


if __name__ == "__main__":
    unittest.main()
