"""
Step 4 (optional): graph-first analytics agent.

The cleaned star schema is loaded into a property graph (networkx MultiDiGraph):

    (User)-[:PAID]->(Transaction)-[:TO]->(Merchant)-[:IN_CATEGORY]->(Category)
    (Transaction)-[:DISPUTED_BY]->(Chargeback)-[:HAS_REASON]->(Reason)
    (User)-[:HAS_KYC]->(KycStatus)

Every answer is produced by traversing that graph (not by re-querying the CSVs), so entity questions
("who is connected to this merchant?", "find rings") and aggregate questions share one model.
A deterministic intent router maps natural-language questions to graph queries; an LLM can be
swapped in as the router later without touching the query layer.

Usage:
    py src/agent.py                       # interactive
    py src/agent.py --ask "Which merchant has the highest chargeback count?"
    py src/agent.py --demo                # runs all example queries -> outputs/agent_demo.md
"""
import argparse
import io
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import networkx as nx
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CLEAN = ROOT / "outputs" / "clean"
FRAUD = {"ACCOUNT_TAKEOVER", "UNAUTHORIZED_TXN", "FRAUD_SUSPECTED"}
SPARK = "▁▂▃▄▅▆▇█"


def nz(v):
    return 0.0 if v is None or pd.isna(v) else float(v)


def inr(v):
    if v is None or pd.isna(v):
        return "—"
    if abs(v) >= 1e7:
        return f"₹{v / 1e7:.2f} Cr"
    if abs(v) >= 1e5:
        return f"₹{v / 1e5:.2f} L"
    return f"₹{v:,.0f}"


def spark(values):
    lo, hi = min(values), max(values)
    return "".join(SPARK[int((v - lo) / (hi - lo + 1e-9) * (len(SPARK) - 1))] for v in values)


def md_table(rows, cols):
    head = "| " + " | ".join(c for c, _ in cols) + " |\n|" + "|".join("---" for _ in cols) + "|\n"
    return head + "".join("| " + " | ".join(str(f(r)) for _, f in cols) + " |\n" for r in rows)


# ============================================================ graph
class PaymentGraph:
    def __init__(self):
        t = pd.read_csv(CLEAN / "fact_transactions.csv", parse_dates=["timestamp", "txn_date"])
        c = pd.read_csv(CLEAN / "fact_chargebacks.csv", parse_dates=["transaction_timestamp", "reported_timestamp"])
        u = pd.read_csv(CLEAN / "dim_users.csv")
        m = pd.read_csv(CLEAN / "dim_merchants.csv")
        G = nx.MultiDiGraph()
        for r in u.itertuples():
            G.add_node(r.user_id, label="User", name=r.full_name, kyc=r.kyc_status, risk=r.risk_segment, city=r.city)
            G.add_edge(r.user_id, f"KYC:{r.kyc_status}", key="HAS_KYC")
        for r in m.itertuples():
            G.add_node(r.merchant_id, label="Merchant", name=r.merchant_name, status=r.merchant_status, category=r.merchant_category)
        for r in t.itertuples():
            if r.user_id not in G:
                G.add_node(r.user_id, label="User", name=None, kyc="NO_KYC_RECORD", risk=None, city=None)
                G.add_edge(r.user_id, "KYC:NO_KYC_RECORD", key="HAS_KYC")
            if r.merchant_id not in G:
                G.add_node(r.merchant_id, label="Merchant", name=None, status=None, category=None)
            G.add_node(r.txn_id, label="Transaction", amount=r.amount, status=r.status, ts=r.timestamp, date=r.txn_date,
                       category=r.merchant_category, utr=r.utr_status, kyc=r.kyc_status)
            G.add_edge(r.user_id, r.txn_id, key="PAID")
            G.add_edge(r.txn_id, r.merchant_id, key="TO")
            G.add_edge(r.txn_id, f"CAT:{r.merchant_category}", key="IN_CATEGORY")
        for r in c.itertuples():
            G.add_node(r.complaint_id, label="Chargeback", amount=r.disputed_amount, reason=r.reason_category, severity=r.severity,
                       status=r.resolution_status, delay=r.reporting_delay_days, linked=r.link_status == "LINKED",
                       user=r.user_id, merchant=r.merchant_id, category=r.merchant_category)
            if r.link_status == "LINKED":
                G.add_edge(r.txn_id, r.complaint_id, key="DISPUTED_BY")
            G.add_edge(r.complaint_id, f"REASON:{r.reason_category}", key="HAS_REASON")
        for n in list(G.nodes):
            if ":" in n and "label" not in G.nodes[n]:
                G.nodes[n]["label"] = n.split(":")[0].title()
        self.G = G
        self.categories = sorted({n[4:] for n in G if n.startswith("CAT:")})

    # ---------- primitives
    def nodes(self, label):
        return [n for n in self.G.nodes if self.G.nodes[n].get("label") == label]

    def successors_by(self, node, rel):
        """Neighbours reached by an outgoing edge of type `rel` (edge keys are relationship names)."""
        return [v for v, keys in self.G.succ[node].items() if rel in keys]

    def predecessors_by(self, node, rel):
        """Neighbours pointing at `node` through an edge of type `rel`."""
        return [u for u, keys in self.G.pred[node].items() if rel in keys]

    def txns_of_merchant(self, mid):
        return self.predecessors_by(mid, "TO")

    def txns_of_user(self, uid):
        return self.successors_by(uid, "PAID")

    def chargebacks_of_txn(self, tid):
        return self.successors_by(tid, "DISPUTED_BY")

    def merchant_of_txn(self, tid):
        return self.successors_by(tid, "TO")[0]

    def user_of_txn(self, tid):
        return self.predecessors_by(tid, "PAID")[0]

    def merchant_profile(self, mid):
        txns = self.txns_of_merchant(mid)
        cbs = [cb for tx in txns for cb in self.chargebacks_of_txn(tx)]
        disputed_txns = sum(1 for tx in txns if self.chargebacks_of_txn(tx))
        return {"merchant": mid, "name": self.G.nodes[mid].get("name"), "status": self.G.nodes[mid].get("status"),
                "category": Counter(self.G.nodes[tx]["category"] for tx in txns).most_common(1)[0][0] if txns else None,
                "txns": len(txns), "amount": sum(self.G.nodes[tx]["amount"] for tx in txns),
                "chargebacks": len(cbs), "disputed": sum(nz(self.G.nodes[cb]["amount"]) for cb in cbs),
                "ratio": disputed_txns / len(txns) if txns else 0, "fraud": sum(self.G.nodes[cb]["reason"] in FRAUD for cb in cbs)}

    def user_profile(self, uid):
        txns = self.txns_of_user(uid)
        cbs = [cb for tx in txns for cb in self.chargebacks_of_txn(tx)]
        d = self.G.nodes[uid]
        return {"user": uid, "name": d.get("name"), "kyc": d.get("kyc"), "txns": len(txns),
                "amount": sum(self.G.nodes[tx]["amount"] for tx in txns), "chargebacks": len(cbs),
                "disputed": sum(nz(self.G.nodes[cb]["amount"]) for cb in cbs), "fraud": sum(self.G.nodes[cb]["reason"] in FRAUD for cb in cbs),
                "merchants": sorted({self.merchant_of_txn(tx) for tx in txns})}


# ============================================================ agent
class Agent:
    def __init__(self, pg: PaymentGraph):
        self.pg, self.G = pg, pg.G
        self._mprof = None
        self.intents = [
            (r"(daily|per day).*(volume|count|transactions)|transaction volume trend", self.daily_volume),
            (r"average transaction value", self.avg_value_trend),
            (r"success.*fail|fail.*success|failed transactions? by day", self.success_vs_failed),
            (r"category.*(highest|most).*(disput|chargeback)|(highest|most) disputed amount.*category", self.category_disputes),
            (r"(amount|value).*(by|per) (merchant )?category|category.*(amount|value)", self.amount_by_category),
            (r"(highest|most|top).*chargeback.to.transaction ratio|ratio.*merchant", self.merchant_ratio),
            (r"merchant.*(highest|most).*chargeback|top merchants? by chargeback", self.merchant_cb_count),
            (r"reason", self.reason_distribution),
            (r"top \d* ?users?.*disput|users? by disputed amount", self.top_users_amount),
            (r"kyc status.*(highest|most).*amount|amount.*kyc", self.kyc_amount),
            (r"severity", self.severity),
            (r"after \d+ days?|delay", self.delayed_disputes),
            (r"ring|cluster|connected|fraud network", self.clusters),
            (r"\bMCH ?-?\d{4}\b", self.merchant_lookup),
            (r"\bUSR ?-?\d{5}\b", self.user_lookup),
        ]

    def mprof(self):
        if self._mprof is None:
            self._mprof = [self.pg.merchant_profile(m) for m in self.pg.nodes("Merchant") if self.pg.txns_of_merchant(m)]
        return self._mprof

    def ask(self, q):
        for pattern, fn in self.intents:
            if re.search(pattern, q, flags=re.IGNORECASE):
                return fn(q)
        return ("I can answer questions about transaction trends, failures, merchant categories, chargebacks, reasons, severity, "
                "KYC, reporting delays, rings/clusters, or a specific MCH#### / USR##### id. Try: "
                "'Which merchant has the highest chargeback count?'")

    # ---------- intents
    def _daily(self):
        agg = defaultdict(lambda: {"n": 0, "amt": 0.0, "SUCCESS": 0, "FAILED": 0, "PENDING": 0})
        for t in self.pg.nodes("Transaction"):
            d = self.G.nodes[t]
            a = agg[d["date"].date()]
            a["n"] += 1; a["amt"] += d["amount"]; a[d["status"]] += 1
        return dict(sorted(agg.items()))

    def _weekly(self, daily):
        w = defaultdict(lambda: {"n": 0, "amt": 0.0, "SUCCESS": 0, "FAILED": 0, "PENDING": 0, "days": 0})
        for day, a in daily.items():
            k = max(pd.Timestamp(day).to_period("W-SUN").start_time.date(), min(daily))
            for f in ("n", "amt", "SUCCESS", "FAILED", "PENDING"):
                w[k][f] += a[f]
            w[k]["days"] += 1
        return w

    def daily_volume(self, q):
        d = self._daily()
        counts = [a["n"] for a in d.values()]
        w = self._weekly(d)
        rows = [{"week": k, **v} for k, v in w.items()]
        return (f"**Daily transaction volume, {min(d)} → {max(d)}** ({len(d)} days)\n\n`{spark(counts)}`\n\n"
                f"Mean {sum(counts) / len(counts):.0f}/day · min {min(counts)} · max {max(counts)}\n\n"
                + md_table(rows, [("Week of", lambda r: r["week"]), ("Days", lambda r: r["days"]), ("Txns", lambda r: f"{r['n']:,}"),
                                  ("Txns/day", lambda r: f"{r['n'] / r['days']:.0f}"), ("Value", lambda r: inr(r["amt"]))]))

    def avg_value_trend(self, q):
        w = self._weekly(self._daily())
        rows = [{"week": k, "avg": v["amt"] / v["n"], "n": v["n"]} for k, v in w.items()]
        return ("**Average transaction value by week**\n\n`" + spark([r["avg"] for r in rows]) + "`\n\n"
                + md_table(rows, [("Week of", lambda r: r["week"]), ("Txns", lambda r: f"{r['n']:,}"), ("Avg value", lambda r: f"₹{r['avg']:,.0f}")]))

    def success_vs_failed(self, q):
        w = self._weekly(self._daily())
        rows = [{"week": k, **v} for k, v in w.items()]
        d = self._daily()
        return ("**Successful vs failed transactions** (weekly roll-up of daily counts; failed-rate sparkline is daily)\n\n"
                f"`{spark([a['FAILED'] / a['n'] for a in d.values()])}`\n\n"
                + md_table(rows, [("Week of", lambda r: r["week"]), ("Success", lambda r: r["SUCCESS"]), ("Failed", lambda r: r["FAILED"]),
                                  ("Pending", lambda r: r["PENDING"]), ("Failed rate", lambda r: f"{r['FAILED'] / r['n']:.1%}")]))

    def _category_stats(self):
        s = defaultdict(lambda: {"txns": 0, "amount": 0.0, "cbs": 0, "disputed": 0.0, "disputed_txns": 0})
        for cat_node in (f"CAT:{c}" for c in self.pg.categories):
            cat = cat_node[4:]
            for tx in self.pg.predecessors_by(cat_node, "IN_CATEGORY"):
                s[cat]["txns"] += 1
                s[cat]["amount"] += self.G.nodes[tx]["amount"]
                cbs = self.pg.chargebacks_of_txn(tx)
                s[cat]["cbs"] += len(cbs)
                s[cat]["disputed_txns"] += bool(cbs)
                s[cat]["disputed"] += sum(nz(self.G.nodes[cb]["amount"]) for cb in cbs)
        return s

    def amount_by_category(self, q):
        s = sorted(self._category_stats().items(), key=lambda kv: -kv[1]["amount"])
        return "**Total transaction amount by merchant category**\n\n" + md_table(s, [
            ("Category", lambda r: r[0]), ("Txns", lambda r: f"{r[1]['txns']:,}"), ("Amount", lambda r: inr(r[1]["amount"])),
            ("Share", lambda r: f"{r[1]['amount'] / sum(x[1]['amount'] for x in s):.1%}")])

    def category_disputes(self, q):
        s = sorted(self._category_stats().items(), key=lambda kv: -kv[1]["disputed"])
        top = s[0]
        return (f"**{top[0]}** has the highest disputed amount: {inr(top[1]['disputed'])} across {top[1]['cbs']} chargebacks.\n\n"
                + md_table(s, [("Category", lambda r: r[0]), ("Chargebacks", lambda r: r[1]["cbs"]), ("Disputed", lambda r: inr(r[1]["disputed"])),
                               ("CB/txn ratio", lambda r: f"{r[1]['disputed_txns'] / r[1]['txns']:.1%}"), ("Txns", lambda r: f"{r[1]['txns']:,}")]))

    def _merchant_table(self, rows):
        return md_table(rows, [("Merchant", lambda r: r["merchant"]), ("Name", lambda r: r["name"] if isinstance(r["name"], str) else "(not in master)"),
                               ("Category", lambda r: r["category"]), ("Txns", lambda r: r["txns"]), ("Chargebacks", lambda r: r["chargebacks"]),
                               ("Disputed", lambda r: inr(r["disputed"])), ("CB/txn", lambda r: f"{r['ratio']:.0%}"), ("Fraud-type", lambda r: r["fraud"])])

    def merchant_cb_count(self, q):
        rows = sorted(self.mprof(), key=lambda r: (-r["chargebacks"], -r["disputed"]))[:10]
        ties = sum(1 for r in self.mprof() if r["chargebacks"] == rows[0]["chargebacks"])
        return (f"**{rows[0]['merchant']}** has the highest chargeback count ({rows[0]['chargebacks']}, {inr(rows[0]['disputed'])} disputed)"
                + (f"; {ties - 1} other merchant(s) tie on count, ranked by disputed amount." if ties > 1 else ".") + "\n\n" + self._merchant_table(rows))

    def merchant_ratio(self, q):
        min_txns = 3
        rows = sorted((r for r in self.mprof() if r["txns"] >= min_txns), key=lambda r: (-r["ratio"], -r["chargebacks"]))[:10]
        return (f"**{rows[0]['merchant']}** has the highest chargeback-to-transaction ratio ({rows[0]['ratio']:.0%} of {rows[0]['txns']} payments disputed). "
                f"Merchants with fewer than {min_txns} payments are excluded so one dispute on one payment does not read as 100%.\n\n" + self._merchant_table(rows))

    def reason_distribution(self, q):
        cnt: Counter[str] = Counter()
        amt: defaultdict[str, float] = defaultdict(float)
        for cb in self.pg.nodes("Chargeback"):
            d = self.G.nodes[cb]
            cnt[d["reason"]] += 1; amt[d["reason"]] += nz(d["amount"])
        total = sum(cnt.values())
        rows = cnt.most_common()
        return (f"**Chargeback reason distribution** ({total:,} complaints; fraud-type = {sum(cnt[r] for r in FRAUD) / total:.1%})\n\n"
                + md_table(rows, [("Reason", lambda r: r[0] + (" ⚑" if r[0] in FRAUD else "")), ("Complaints", lambda r: r[1]),
                                  ("Share", lambda r: f"{r[1] / total:.1%}"), ("Disputed", lambda r: inr(amt[r[0]]))]))

    def top_users_amount(self, q):
        n = int(m.group(1)) if (m := re.search(r"top (\d+)", q, re.IGNORECASE)) else 10
        disputing = {self.pg.user_of_txn(t) for t in self.pg.nodes("Transaction") if self.pg.chargebacks_of_txn(t)}
        rows = sorted((self.pg.user_profile(u) for u in disputing), key=lambda r: -r["disputed"])[:n]
        return f"**Top {n} users by disputed amount**\n\n" + md_table(rows, [
            ("User", lambda r: r["user"]), ("Name", lambda r: r["name"] if isinstance(r["name"], str) else "(no KYC record)"), ("KYC", lambda r: r["kyc"]),
            ("Txns", lambda r: r["txns"]), ("Chargebacks", lambda r: r["chargebacks"]), ("Disputed", lambda r: inr(r["disputed"])), ("Fraud-type", lambda r: r["fraud"])])

    def kyc_amount(self, q):
        s = defaultdict(lambda: {"users": 0, "txns": 0, "amount": 0.0, "disputed_txns": 0})
        for kyc_node in (n for n in self.G if n.startswith("KYC:")):
            k = kyc_node[4:]
            for user in self.pg.predecessors_by(kyc_node, "HAS_KYC"):
                txns = self.pg.txns_of_user(user)
                if not txns:
                    continue
                s[k]["users"] += 1
                s[k]["txns"] += len(txns)
                s[k]["amount"] += sum(self.G.nodes[t]["amount"] for t in txns)
                s[k]["disputed_txns"] += sum(bool(self.pg.chargebacks_of_txn(t)) for t in txns)
        rows = sorted(s.items(), key=lambda kv: -kv[1]["amount"])
        verified = [r for r in rows if r[0] != "NO_KYC_RECORD"]
        return (f"**{rows[0][0]}** carries the highest transaction amount ({inr(rows[0][1]['amount'])}). Among users that do have a KYC record, "
                f"**{verified[0][0]}** is highest ({inr(verified[0][1]['amount'])}).\n\n"
                + md_table(rows, [("KYC status", lambda r: r[0]), ("Transacting users", lambda r: f"{r[1]['users']:,}"), ("Txns", lambda r: f"{r[1]['txns']:,}"),
                                  ("Amount", lambda r: inr(r[1]["amount"])), ("Dispute rate", lambda r: f"{r[1]['disputed_txns'] / r[1]['txns']:.1%}")]))

    def severity(self, q):
        order = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
        s = defaultdict(lambda: {"n": 0, "amt": 0.0, "open": 0, "fraud": 0, "delay": []})
        for cb in self.pg.nodes("Chargeback"):
            d = self.G.nodes[cb]
            x = s[d["severity"]]
            x["n"] += 1; x["amt"] += nz(d["amount"]); x["open"] += d["status"] in ("OPEN", "IN_PROGRESS", "PENDING_BANK"); x["fraud"] += d["reason"] in FRAUD
            if pd.notna(d["delay"]):
                x["delay"].append(d["delay"])
        rows = [(k, s[k]) for k in order if k in s]
        return "**Chargebacks by severity level**\n\n" + md_table(rows, [
            ("Severity", lambda r: r[0]), ("Complaints", lambda r: r[1]["n"]), ("Disputed", lambda r: inr(r[1]["amt"])),
            ("Still open", lambda r: f"{r[1]['open'] / r[1]['n']:.0%}"), ("Fraud-type", lambda r: f"{r[1]['fraud'] / r[1]['n']:.0%}"),
            ("Mean delay", lambda r: f"{sum(r[1]['delay']) / len(r[1]['delay']):.1f} d")])

    def delayed_disputes(self, q):
        days = int(m.group(1)) if (m := re.search(r"after (\d+)", q, re.IGNORECASE)) else 7
        rows = sorted((dict(id=cb, **self.G.nodes[cb]) for cb in self.pg.nodes("Chargeback")
                       if pd.notna(self.G.nodes[cb]["delay"]) and self.G.nodes[cb]["delay"] > days), key=lambda r: -r["delay"])
        by_reason = Counter(r["reason"] for r in rows)
        return (f"**{len(rows):,} disputes were reported more than {days} days after the payment** "
                f"(most common reason: {by_reason.most_common(1)[0][0]}). Longest 12:\n\n"
                + md_table(rows[:12], [("Complaint", lambda r: r["id"]), ("Merchant", lambda r: r["merchant"]), ("Reason", lambda r: r["reason"]),
                                       ("Severity", lambda r: r["severity"]), ("Disputed", lambda r: inr(r["amount"])), ("Delay", lambda r: f"{r['delay']:.0f} d"),
                                       ("Status", lambda r: r["status"])]))

    def clusters(self, q):
        # project the property graph onto users & merchants joined by disputed payments' endpoints
        disputed = [t for t in self.pg.nodes("Transaction") if self.pg.chargebacks_of_txn(t)]
        touched = {self.pg.user_of_txn(t) for t in disputed} | {self.pg.merchant_of_txn(t) for t in disputed}
        P = nx.Graph()
        for t in self.pg.nodes("Transaction"):
            u, m = self.pg.user_of_txn(t), self.pg.merchant_of_txn(t)
            if u in touched and m in touched:
                P.add_edge(u, m)
        comps = []
        for comp in nx.connected_components(P):
            if len(comp) < 4:
                continue
            users = [n for n in comp if n.startswith("USR")]
            merchants = [n for n in comp if n.startswith("MCH")]
            cbs = [cb for u in users for t in self.pg.txns_of_user(u) if self.pg.merchant_of_txn(t) in comp for cb in self.pg.chargebacks_of_txn(t)]
            fraud = sum(self.G.nodes[cb]["reason"] in FRAUD for cb in cbs)
            comps.append({"users": users, "merchants": merchants, "cbs": len(cbs), "fraud": fraud,
                          "disputed": sum(nz(self.G.nodes[cb]["amount"]) for cb in cbs),
                          "unverified": sum(self.G.nodes[u]["kyc"] != "VERIFIED" for u in users)})
        comps.sort(key=lambda c: -(c["cbs"] * 2 + c["fraud"] * 3 + c["unverified"] + c["disputed"] / 10000))
        return (f"**{len(comps)} suspicious clusters** (connected components of ≥4 dispute-touched users/merchants). Top 8:\n\n"
                + md_table(comps[:8], [("Users", lambda c: len(c["users"])), ("Merchants", lambda c: " ".join(sorted(c["merchants"]))),
                                       ("Chargebacks", lambda c: c["cbs"]), ("Fraud-type", lambda c: c["fraud"]), ("Disputed", lambda c: inr(c["disputed"])),
                                       ("Unverified users", lambda c: c["unverified"])]))

    def merchant_lookup(self, q):
        found = re.search(r"MCH ?-?(\d{4})", q, re.IGNORECASE)
        if found is None:
            return "Give a merchant id in the form MCH1234."
        mid = "MCH" + found.group(1)
        if mid not in self.G:
            return f"{mid} does not appear in transactions or the merchant master."
        p = self.pg.merchant_profile(mid)
        users = sorted({self.pg.user_of_txn(t) for t in self.pg.txns_of_merchant(mid)})
        shared = Counter(m for u in users for t in self.pg.txns_of_user(u) for m in [self.pg.merchant_of_txn(t)] if m != mid)
        return (f"**{mid}** · {p['name'] if isinstance(p['name'], str) else 'not in merchant master'} · status {p['status']} · {p['category']}\n\n"
                f"- {p['txns']} payments worth {inr(p['amount'])}\n- {p['chargebacks']} chargebacks ({p['fraud']} fraud-type), {inr(p['disputed'])} disputed, "
                f"CB/txn {p['ratio']:.0%}\n- Paying users: {', '.join(users) or '—'}\n"
                f"- Other merchants those users also paid: {', '.join(m for m, _ in shared.most_common(5)) or '—'}")

    def user_lookup(self, q):
        found = re.search(r"USR ?-?(\d{5})", q, re.IGNORECASE)
        if found is None:
            return "Give a user id in the form USR12345."
        uid = "USR" + found.group(1)
        if uid not in self.G:
            return f"{uid} does not appear in transactions or KYC."
        p = self.pg.user_profile(uid)
        return (f"**{uid}** · {p['name'] if isinstance(p['name'], str) else 'no KYC record'} · KYC {p['kyc']}\n\n"
                f"- {p['txns']} payments worth {inr(p['amount'])} to {', '.join(p['merchants']) or '—'}\n"
                f"- {p['chargebacks']} chargebacks ({p['fraud']} fraud-type), {inr(p['disputed'])} disputed")


EXAMPLES = [
    "Show daily transaction volume trend.",
    "Show total transaction amount by merchant category.",
    "Compare successful vs failed transactions by day.",
    "Which merchant has the highest chargeback count?",
    "Which merchant category has the highest disputed amount?",
    "Show chargeback reason distribution.",
    "Show top 10 users by disputed amount.",
    "Show average transaction value trend over time.",
    "Which KYC status has the highest transaction amount?",
    "Compare chargebacks by severity level.",
    "Show disputes reported after 7 days.",
    "Which merchant has the highest chargeback-to-transaction ratio?",
    "Find suspicious fraud rings in the payment graph.",
]


def main():
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--ask")
    ap.add_argument("--demo", action="store_true")
    args = ap.parse_args()
    pg = PaymentGraph()
    agent = Agent(pg)
    print(f"graph loaded: {pg.G.number_of_nodes():,} nodes, {pg.G.number_of_edges():,} edges", file=sys.stderr)
    if args.ask:
        print(agent.ask(args.ask))
    elif args.demo:
        top_merchant = min(agent.mprof(), key=lambda r: (-r["chargebacks"], -r["disputed"]))["merchant"]
        qs = EXAMPLES + [f"Tell me about {top_merchant}."]
        out = ["# Graph agent – example queries\n",
               (f"Property graph: {pg.G.number_of_nodes():,} nodes / {pg.G.number_of_edges():,} edges "
                "(User, Transaction, Merchant, Category, Chargeback, Reason, KycStatus).\n")]
        for q in qs:
            out.append(f"\n## Q: {q}\n\n{agent.ask(q)}\n")
        path = ROOT / "outputs" / "agent_demo.md"
        path.write_text("".join(out), encoding="utf-8")
        print("".join(out))
        print(f"\nwrote {path}", file=sys.stderr)
    else:
        print("Ask about payments, disputes, merchants or users (blank line to quit).")
        while (q := input("> ").strip()):
            print(agent.ask(q), "\n")


if __name__ == "__main__":
    main()
