"""Step 3: package metrics + the row-level model into the interactive dashboard -> outputs/upi_risk_desk.html

The page recomputes every KPI, chart and table in the browser from the embedded rows, so the
global filters, cross-filtering and drill-downs need no server. String columns are dictionary
encoded to keep the file small.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "outputs"
CLEAN, RISK = OUT / "clean", OUT / "risk"


class Codes:
    """Maps category strings to small integer codes, keeping a fixed order where one is given."""

    def __init__(self, order=()):
        self.values = list(order)
        self.index = {v: i for i, v in enumerate(self.values)}

    def one(self, v):
        if v not in self.index:
            self.index[v] = len(self.values)
            self.values.append(v)
        return self.index[v]

    def code(self, s, missing="UNKNOWN"):
        return [self.one(str(v)) for v in s.fillna(missing)]


def need(path):
    if not path.exists():
        raise SystemExit(f"missing {path.relative_to(ROOT)} - run src/clean.py and src/analytics.py first")
    return path


def num(s, nd=2):
    return [None if pd.isna(v) else round(float(v), nd) for v in s]


def ints(s):
    return [int(v) for v in s]


def text(s):
    return [None if pd.isna(v) else str(v) for v in s]


def signal_bits(s, codes):
    return [sum(1 << codes.one(x) for x in str(v).split(", ") if x) if isinstance(v, str) else 0 for v in s]


def rows_payload():
    t = pd.read_csv(need(CLEAN / "fact_transactions.csv"), parse_dates=["timestamp", "txn_date"])
    c = pd.read_csv(need(CLEAN / "fact_chargebacks.csv"), parse_dates=["reported_timestamp"])
    mr = pd.read_csv(need(RISK / "merchant_risk_scores.csv"))
    ur = pd.read_csv(need(RISK / "user_risk_scores.csv"))
    dm = pd.read_csv(need(CLEAN / "dim_merchants.csv"), usecols=["merchant_id", "city"]).drop_duplicates("merchant_id")
    cl = pd.read_csv(need(RISK / "suspicious_clusters.csv"))

    start = t.txn_date.min().normalize()
    day = (t.txn_date.dt.normalize() - start).dt.days
    minute = np.where(t.has_time, t.timestamp.dt.hour * 60 + t.timestamp.dt.minute, -1)

    users = sorted(set(t.user_id) | set(ur.user_id))
    merchants = sorted(set(t.merchant_id) | set(mr.merchant_id))
    uidx = {v: i for i, v in enumerate(users)}
    midx = {v: i for i, v in enumerate(merchants)}

    cat, kyc = Codes(), Codes(["VERIFIED", "PENDING", "IN_REVIEW", "REJECTED", "NO_KYC_RECORD"])
    seg, status = Codes(["LOW", "MEDIUM", "HIGH", "NO_KYC_RECORD"]), Codes(["SUCCESS", "FAILED", "PENDING"])
    reason, sev, res, ch = Codes(), Codes(["CRITICAL", "HIGH", "MEDIUM", "LOW"]), Codes(), Codes()
    mstatus, settle, tier = Codes(), Codes(), Codes(["LOW", "MEDIUM", "HIGH"])
    msig, usig = Codes(), Codes()
    utr = Codes(["VALID", "MISSING", "INVALID"])  # a 0/1 "is missing" flag would silently count INVALID as valid

    txns = {
        "id": [int(x[3:]) for x in t.txn_id], "d": ints(day), "mi": ints(minute),
        "u": [uidx[x] for x in t.user_id], "m": [midx[x] for x in t.merchant_id], "a": num(t.amount),
        "s": status.code(t.status), "x": utr.code(t.utr_status, "MISSING"),
        "c": cat.code(t.merchant_category, "Unknown"), "k": kyc.code(t.kyc_status), "g": seg.code(t.risk_segment),
    }

    row = {v: i for i, v in enumerate(t.txn_id)}
    linked = c.link_status.eq("LINKED").to_numpy()
    own_cat, own_kyc = cat.code(c.merchant_category, "Unknown"), kyc.code(c.kyc_status)
    chargebacks = {
        "id": [int(x[3:]) for x in c.complaint_id],
        "t": [row.get(x, -1) if ok else -1 for x, ok in zip(c.txn_id, linked)],
        "a": num(c.disputed_amount), "ta": num(c.txn_amount),
        "r": reason.code(c.reason_category), "sv": sev.code(c.severity), "rs": res.code(c.resolution_status),
        "ch": ch.code(c.channel), "dl": num(c.reporting_delay_days, 3),  # 1 dp would turn 7.04 into 7.0 and drop it from "> 7 days"
        "op": ints(c.is_open.fillna(False)), "fr": ints(c.is_fraud_reason.fillna(False)),
        "rd": [None if pd.isna(v) else int((v.normalize() - start).days) for v in c.reported_timestamp],
        "c": [-1 if ok else v for v, ok in zip(own_cat, linked)],
        "k": [-1 if ok else v for v, ok in zip(own_kyc, linked)],
    }

    mr = mr.set_index("merchant_id").reindex(merchants)
    mcity = dm.set_index("merchant_id").city.reindex(merchants)
    merchant_rows = {
        "id": merchants, "name": text(mr.merchant_name), "city": text(mcity),
        "cat": cat.code(mr.category, "Unknown"), "st": mstatus.code(mr.merchant_status, "NOT_IN_MASTER"),
        "se": settle.code(mr.settlement_account_type, "UNKNOWN"),
        "score": ints(mr.risk_score.fillna(0)), "tier": tier.code(mr.risk_tier, "LOW"), "sig": signal_bits(mr.risk_signals, msig),
    }

    ur = ur.set_index("user_id").reindex(users)
    user_rows = {
        "id": users, "name": text(ur.full_name), "city": text(ur.city), "inc": num(ur.monthly_income, 0),
        "idc": ints(ur.id_record_count.fillna(0)),
        "score": ints(ur.risk_score.fillna(0)), "tier": tier.code(ur.risk_tier, "LOW"), "sig": signal_bits(ur.risk_signals, usig),
    }

    clusters = []
    for r in cl.to_dict("records"):
        # members missing from the transaction/risk tables would raise KeyError; drop them, and the cluster if a side empties
        us = [uidx[x] for x in str(r["member_users"]).split() if x in uidx]
        ms = [midx[x] for x in str(r["member_merchants"]).split() if x in midx]
        if not us or not ms:
            continue
        clusters.append({
            "id": str(r["cluster_id"]), "u": us, "m": ms,
            "score": round(float(r["cluster_risk_score"]), 1), "unv": int(r["unverified_or_no_kyc_users"]),
            "hub": str(r["hub_node"]), "hd": int(r["hub_degree"]),
        })

    return {
        "start": str(start.date()), "days": int(day.max()) + 1,
        "dict": {"cat": cat.values, "kyc": kyc.values, "seg": seg.values, "status": status.values, "reason": reason.values,
                 "sev": sev.values, "res": res.values, "ch": ch.values, "mstatus": mstatus.values, "settle": settle.values,
                 "tier": tier.values, "msig": msig.values, "usig": usig.values, "utr": utr.values},
        "t": txns, "c": chargebacks, "users": user_rows, "merchants": merchant_rows, "clusters": clusters,
    }


def embed(obj):
    # escaping every "<" (not just "</") also stops "<!--" or "<script" in the data from corrupting the script block
    s = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    return s.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def main():
    metrics = json.loads(need(OUT / "metrics.json").read_text(encoding="utf-8"))
    quality = json.loads(pd.read_csv(need(OUT / "data_quality_report.csv")).to_json(orient="records", force_ascii=False))
    html = need(ROOT / "dashboard" / "template.html").read_text(encoding="utf-8")
    for token, payload in (("/*__DATA__*/null", metrics), ("/*__QUALITY__*/null", quality), ("/*__ROWS__*/null", rows_payload())):
        if html.count(token) != 1:
            raise SystemExit(f"template must contain placeholder {token} exactly once")
        html = html.replace(token, embed(payload))
    out = OUT / "upi_risk_desk.html"
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
