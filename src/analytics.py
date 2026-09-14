"""
Step 2: business metrics, risk scoring and suspicious-cluster detection on the cleaned model.
Writes outputs/metrics.json (dashboard feed) and outputs/risk/*.csv (analyst worklists).
"""
import json
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CLEAN = ROOT / "outputs" / "clean"
RISK = ROOT / "outputs" / "risk"
RISK.mkdir(parents=True, exist_ok=True)

NOT_ACTIVE = {"INACTIVE", "CLOSED", "SUSPENDED", "BLOCKED"}
UNVERIFIED_KYC = {"PENDING", "IN_REVIEW", "REJECTED"}


def load():
    t = pd.read_csv(CLEAN / "fact_transactions.csv", parse_dates=["timestamp", "txn_date"])
    c = pd.read_csv(CLEAN / "fact_chargebacks.csv", parse_dates=["transaction_timestamp", "reported_timestamp", "bank_response_timestamp"])
    u = pd.read_csv(CLEAN / "dim_users.csv", parse_dates=["signup_timestamp"])
    m = pd.read_csv(CLEAN / "dim_merchants.csv", parse_dates=["onboarding_date"])
    return t, c, u, m


def rate(num, den):
    return float(num) / float(den) if den else 0.0


def records(df, n=None):
    df = df.head(n) if n else df
    out = []
    for row in df.to_dict("records"):
        clean = {}
        for k, v in row.items():
            if isinstance(v, (pd.Timestamp,)):
                clean[k] = None if pd.isna(v) else v.strftime("%Y-%m-%d")
            elif isinstance(v, (np.floating, float)):
                clean[k] = None if np.isnan(v) else round(float(v), 4)
            elif isinstance(v, (np.integer,)):
                clean[k] = int(v)
            elif isinstance(v, (np.bool_,)):
                clean[k] = bool(v)
            else:
                clean[k] = v
        out.append(clean)
    return out


def scalar(v):
    if isinstance(v, dict):
        return {k: scalar(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [scalar(x) for x in v]
    if isinstance(v, (float, np.floating)):
        return None if np.isnan(v) else round(float(v), 4)
    if isinstance(v, (np.integer, np.bool_)):
        return v.item()
    return v


def find_spikes(t, linked, m):
    """Merchant-days with ≥3 payments and ≥3× the merchant's usual daily volume, plus disputes in the next 14 days."""
    md = t.groupby(["merchant_id", "txn_date"]).size().rename("day_txns").reset_index()
    mstats = t.groupby("merchant_id").agg(total_txns=("txn_id", "size"), active_days=("txn_date", "nunique"))
    md = md.join(mstats, on="merchant_id")
    md["baseline_per_active_day"] = (md.total_txns - md.day_txns) / (md.active_days - 1).clip(lower=1)
    spikes = md[(md.day_txns >= 3) & (md.day_txns >= 3 * md.baseline_per_active_day.clip(lower=1))].copy()
    cbm = linked[["merchant_id", "transaction_timestamp", "complaint_id", "disputed_amount"]]
    after = spikes.merge(cbm, on="merchant_id", how="left")
    win = (after.transaction_timestamp >= after.txn_date) & (after.transaction_timestamp < after.txn_date + pd.Timedelta(days=15))
    after = after[win].groupby(["merchant_id", "txn_date"]).agg(disputes_within_14d=("complaint_id", "nunique"), disputed_amount_14d=("disputed_amount", "sum"))
    spikes = spikes.merge(after, on=["merchant_id", "txn_date"], how="left").fillna({"disputes_within_14d": 0, "disputed_amount_14d": 0})
    spike_amt = t.groupby(["merchant_id", "txn_date"]).amount.sum().rename("day_amount")
    spikes = spikes.join(spike_amt, on=["merchant_id", "txn_date"]).merge(m[["merchant_id", "merchant_name", "merchant_status"]], on="merchant_id", how="left")
    return spikes.sort_values(["disputes_within_14d", "day_txns"], ascending=False)


def score_merchants(t, linked, m, spikes):
    cbm_agg = linked.groupby("merchant_id").agg(chargebacks=("complaint_id", "size"), disputed_amount=("disputed_amount", "sum"),
                                                fraud_chargebacks=("is_fraud_reason", "sum"), critical_high=("severity", lambda s: s.isin(["CRITICAL", "HIGH"]).sum()),
                                                distinct_disputing_users=("user_id", "nunique"))
    mr = t.groupby("merchant_id").agg(txns=("txn_id", "size"), amount=("amount", "sum"), failed_rate=("status", lambda s: (s == "FAILED").mean()),
                                      disputed_txns=("is_disputed", "sum"), category=("merchant_category", lambda s: s.mode().iat[0]),
                                      in_master=("merchant_in_master", "first")).join(cbm_agg).fillna({"chargebacks": 0, "disputed_amount": 0, "fraud_chargebacks": 0, "critical_high": 0, "distinct_disputing_users": 0})
    mr = mr.join(m.set_index("merchant_id")[["merchant_name", "merchant_status", "settlement_account_type", "id_record_count"]])
    mr["chargeback_to_txn_ratio"] = mr.disputed_txns / mr.txns
    spike_disp = spikes[spikes.disputes_within_14d > 0].merchant_id.unique()
    p90_amt = mr.loc[mr.chargebacks > 0, "disputed_amount"].quantile(0.9)
    signals = {
        "repeated_disputes(≥2)": (mr.chargebacks >= 2, 25),
        "3+_disputes": (mr.chargebacks >= 3, 10),
        "high_cb_ratio(≥30%,≥3 txns)": ((mr.chargeback_to_txn_ratio >= 0.3) & (mr.txns >= 3), 15),
        "fraud_type_dispute": (mr.fraud_chargebacks >= 1, 15),
        "top10%_disputed_amount": (mr.disputed_amount >= p90_amt, 10),
        "spike_then_dispute": (mr.index.isin(spike_disp), 10),
        "transacting_while_not_active": (mr.merchant_status.isin(NOT_ACTIVE), 10),
        "not_in_merchant_master": (~mr.in_master.astype(bool), 5),
        "missing_settlement_account": (mr.settlement_account_type == "MISSING", 5),
    }
    mr["risk_score"] = sum(np.where(mask, w, 0) for mask, w in signals.values())
    mr["risk_signals"] = [", ".join(k for k, (mask, _) in signals.items() if np.asarray(mask)[i]) for i in range(len(mr))]
    mr["risk_tier"] = pd.cut(mr.risk_score, [-1, 29, 49, 1000], labels=["LOW", "MEDIUM", "HIGH"])
    return mr.reset_index().sort_values(["risk_score", "disputed_amount"], ascending=False)


def score_users(t, linked, u):
    """Returns (scores, high-value chargeback threshold, users paying twice within 30 minutes)."""
    ts = t[t.has_time].sort_values(["user_id", "timestamp"])
    gap = ts.groupby("user_id").timestamp.diff().dt.total_seconds() / 60
    rapid_users = set(ts.loc[gap <= 30, "user_id"])

    hv_threshold = linked.disputed_amount.quantile(0.9)
    cbu = linked.groupby("user_id").agg(chargebacks=("complaint_id", "size"), disputed_amount=("disputed_amount", "sum"),
                                        max_disputed=("disputed_amount", "max"), fraud_chargebacks=("is_fraud_reason", "sum"),
                                        distinct_merchants_disputed=("merchant_id", "nunique"))
    ur = t.groupby("user_id").agg(txns=("txn_id", "size"), amount=("amount", "sum"), failed_txns=("status", lambda s: (s == "FAILED").sum()),
                                  kyc_status=("kyc_status", "first"), risk_segment=("risk_segment", "first")).join(cbu)
    ur = ur.fillna({"chargebacks": 0, "disputed_amount": 0, "max_disputed": 0, "fraud_chargebacks": 0, "distinct_merchants_disputed": 0})
    ur = ur.join(u.set_index("user_id")[["full_name", "city", "monthly_income", "id_record_count"]])
    usignals = {
        "repeated_disputes(≥2)": (ur.chargebacks >= 2, 30),
        f"high_value_chargeback(≥₹{hv_threshold:,.0f})": (ur.max_disputed >= hv_threshold, 15),
        "fraud_type_dispute": (ur.fraud_chargebacks >= 1, 15),
        "kyc_not_verified": (ur.kyc_status.isin(UNVERIFIED_KYC) & (ur.chargebacks > 0), 15),
        "no_kyc_record": ((ur.kyc_status == "NO_KYC_RECORD") & (ur.chargebacks > 0), 10),
        "high_risk_segment": (ur.risk_segment == "HIGH", 10),
        "rapid_repeat_payments(≤30min)": (ur.index.isin(rapid_users), 10),
        "multiple_failed_txns": (ur.failed_txns >= 2, 5),
        "disputed_more_than_income": ((ur.disputed_amount > ur.monthly_income) & ur.monthly_income.notna() & (ur.chargebacks > 0), 5),
    }
    ur["risk_score"] = sum(np.where(mask, w, 0) for mask, w in usignals.values())
    ur["risk_signals"] = [", ".join(k for k, (mask, _) in usignals.items() if np.asarray(mask)[i]) for i in range(len(ur))]
    ur["risk_tier"] = pd.cut(ur.risk_score, [-1, 29, 49, 1000], labels=["LOW", "MEDIUM", "HIGH"])
    return ur.reset_index().sort_values(["risk_score", "disputed_amount"], ascending=False), hv_threshold, rapid_users


# ---------------------------------------------------------------------- detection backtest
# The live scores use fraud-type disputes as an input, so checking them against the same quarter is
# circular. Instead: score on payments before the cutoff, using only chargebacks already reported by
# then, and check which entities draw fraud-type chargebacks on payments after it.
BACKTEST_CUTOFF = pd.Timestamp("2026-03-01")


def auc(score, label):
    """Chance a random fraud entity outscores a random clean one (ties count half)."""
    label = np.asarray(label, bool)
    pos, neg = int(label.sum()), int((~label).sum())
    if not pos or not neg:
        return np.nan
    ranks = pd.Series(np.asarray(score, float)).rank().to_numpy()
    return (ranks[label].sum() - pos * (pos + 1) / 2) / (pos * neg)


def evaluate(scored, key, population, fraud_ids, disputed_ids, kind):
    s = scored[scored[key].isin(population)].copy()
    s["fraud"] = s[key].isin(fraud_ids)
    s["disputed"] = s[key].isin(disputed_ids)
    base, hits = s.fraud.mean(), s.fraud.sum()

    def row(label, mask):
        g = s[np.asarray(mask, bool)]
        hit = g.fraud.mean() if len(g) else np.nan
        return {"entity": kind, "group": label, "entities": len(g), "fraud_hits": int(g.fraud.sum()), "hit_rate": hit,
                "lift": hit / base if base else np.nan, "recall": g.fraud.sum() / hits if hits else np.nan,
                "any_dispute_rate": g.disputed.mean() if len(g) else np.nan}

    tiers = [row(tier, s.risk_tier == tier) for tier in ("HIGH", "MEDIUM", "LOW")]
    tiers += [row("HIGH+MEDIUM", s.risk_tier.isin(["HIGH", "MEDIUM"])), row("ALL", np.ones(len(s)))]
    fired = s.risk_signals.fillna("").str.split(", ")
    names = sorted({x for xs in fired for x in xs if x})
    signals = [row(n, fired.apply(lambda xs: n in xs)) for n in names]
    summary = {"population": len(s), "fraud_entities": int(hits), "base_rate": base, "auc": auc(s.risk_score, s.fraud)}
    return tiers, signals, summary


def backtest(t, c, m, u, cutoff=BACKTEST_CUTOFF):
    linked = c[c.link_status == "LINKED"]
    train_t, test_t = t[t.timestamp < cutoff].copy(), t[t.timestamp >= cutoff]
    on_train = linked.txn_id.isin(train_t.txn_id)
    train_l = linked[on_train & (linked.reported_timestamp < cutoff)]
    per_txn = train_l.groupby("txn_id").size()
    train_t["chargeback_count"] = train_t.txn_id.map(per_txn).fillna(0).astype(int)
    train_t["is_disputed"] = train_t.chargeback_count > 0
    test_l = linked[linked.txn_id.isin(test_t.txn_id)]
    fraud_l = test_l[test_l.is_fraud_reason]

    scored = {"merchant": ("merchant_id", score_merchants(train_t, train_l, m, find_spikes(train_t, train_l, m))),
              "user": ("user_id", score_users(train_t, train_l, u)[0])}
    tiers, signals, info = [], [], {}
    for kind, (key, sc) in scored.items():
        # only entities seen in both windows can be scored and then caught
        population = set(train_t[key]) & set(test_t[key])
        tr, sg, sm = evaluate(sc, key, population, set(fraud_l[key]), set(test_l[key]), kind)
        tiers += tr; signals += sg
        high = tr[0]
        info[kind] = {**sm, "high_entities": high["entities"], "high_fraud_hits": high["fraud_hits"], "high_hit_rate": high["hit_rate"],
                      "high_lift": high["lift"], "high_recall": high["recall"]}
    tiers = pd.DataFrame(tiers)
    signals = pd.DataFrame(signals).rename(columns={"group": "signal"}).sort_values(["entity", "lift"], ascending=[True, False])
    info.update({
        "cutoff": str(cutoff.date()),
        "train_window": [str(train_t.timestamp.min().date()), str((cutoff - pd.Timedelta(days=1)).date())],
        "test_window": [str(cutoff.date()), str(test_t.timestamp.max().date())],
        "train_txns": len(train_t), "test_txns": len(test_t),
        "train_chargebacks_visible": len(train_l), "train_chargebacks_reported_later": int(on_train.sum() - len(train_l)),
        "test_chargebacks": len(test_l), "test_fraud_chargebacks": len(fraud_l),
    })
    return scalar(info), tiers, signals


HISTORY = ROOT / "outputs" / "metrics_history.csv"


def append_history(row):
    """One row per distinct result, so re-running on unchanged data keeps the original run date."""
    new = pd.DataFrame([row])
    if HISTORY.exists():
        hist = pd.read_csv(HISTORY)
        last = hist.iloc[-1]

        def same(k, v):
            old = last.get(k)
            if isinstance(v, str):
                return str(old) == v
            if pd.isna(v) or pd.isna(old):
                return pd.isna(v) and pd.isna(old)
            return bool(np.isclose(float(old), float(v)))

        if all(same(k, v) for k, v in row.items() if k != "run_at"):
            return hist
        hist = pd.concat([hist, new], ignore_index=True)
    else:
        hist = new
    hist.to_csv(HISTORY, index=False)
    return hist


def main():
    t, c, u, m = load()
    linked = c[c.link_status == "LINKED"]
    n = len(t)

    # ------------------------------------------------------------------ headline KPIs
    delay = c["reporting_delay_days"]
    kpi = {
        "txn_count": n,
        "txn_amount": t.amount.sum(),
        "success_amount": t.loc[t.status == "SUCCESS", "amount"].sum(),
        "avg_txn_value": t.amount.mean(),
        "success_rate": rate((t.status == "SUCCESS").sum(), n),
        "failed_rate": rate((t.status == "FAILED").sum(), n),
        "pending_rate": rate((t.status == "PENDING").sum(), n),
        "chargeback_count": len(c),
        "chargeback_linked": len(linked),
        "chargeback_amount": c.disputed_amount.sum(),
        "chargeback_linked_amount": linked.disputed_amount.sum(),
        "disputed_txns": int(t.is_disputed.sum()),
        "chargeback_to_txn_ratio": rate(t.is_disputed.sum(), n),
        "chargeback_to_txn_amount_ratio": rate(linked.disputed_amount.sum(), t.amount.sum()),
        "users": len(u), "merchants": len(m),
        "kyc_completion_rate": rate((u.kyc_status == "VERIFIED").sum(), len(u)),
        "kyc_rejection_rate": rate((u.kyc_status == "REJECTED").sum(), len(u)),
        "avg_reporting_delay_days": delay.mean(),
        "median_reporting_delay_days": delay.median(),
        "disputes_reported_after_7d": int((delay > 7).sum()),
        "fraud_reason_share": rate(c.is_fraud_reason.sum(), len(c)),
        "open_dispute_share": rate(c.is_open.sum(), len(c)),
        "missing_utr": int((t.utr_status == "MISSING").sum()),
        "duplicate_txns_removed": 400, "duplicate_amount_removed": 5186378,
        "txn_user_kyc_coverage": rate(t.user_in_kyc.sum(), n),
        "txn_merchant_master_coverage": rate(t.merchant_in_master.sum(), n),
    }

    # ------------------------------------------------------------------ trends
    daily = t.groupby("txn_date").agg(
        txns=("txn_id", "size"), amount=("amount", "sum"), avg_value=("amount", "mean"),
        success=("status", lambda s: (s == "SUCCESS").sum()), failed=("status", lambda s: (s == "FAILED").sum()),
        pending=("status", lambda s: (s == "PENDING").sum()), disputed=("is_disputed", "sum")).reset_index()
    daily["failed_rate"] = daily.failed / daily.txns
    th = t[t.has_time]
    hourly = th.groupby("txn_hour").agg(txns=("txn_id", "size"), failed=("status", lambda s: (s == "FAILED").sum()),
                                        pending=("status", lambda s: (s == "PENDING").sum())).reset_index()
    hourly["failed_rate"] = hourly.failed / hourly.txns
    weekday = t.assign(dow=t.timestamp.dt.day_name()).groupby("dow").agg(txns=("txn_id", "size"), failed=("status", lambda s: (s == "FAILED").sum()))
    weekday["failed_rate"] = weekday.failed / weekday.txns

    # ------------------------------------------------------------------ merchant categories
    cb_cat = linked.groupby("merchant_category").agg(chargebacks=("complaint_id", "size"), disputed_amount=("disputed_amount", "sum"),
                                                     fraud_chargebacks=("is_fraud_reason", "sum"))
    cat = t.groupby("merchant_category").agg(
        txns=("txn_id", "size"), amount=("amount", "sum"), avg_value=("amount", "mean"),
        failed_rate=("status", lambda s: (s == "FAILED").mean()), disputed_txns=("is_disputed", "sum"),
        merchants=("merchant_id", "nunique")).join(cb_cat).fillna(0).reset_index()
    cat["dispute_rate"] = cat.disputed_txns / cat.txns
    cat["chargeback_to_txn_ratio"] = cat.disputed_txns / cat.txns   # same definition as the overall KPI and merchant ratio
    cat["disputed_amount_share"] = cat.disputed_amount / cat.amount
    cat = cat.sort_values("amount", ascending=False)

    # ------------------------------------------------------------------ disputes
    def dist(col, frame=c):
        d = frame.groupby(col).agg(count=("complaint_id", "size"), amount=("disputed_amount", "sum"),
                                   avg_delay=("reporting_delay_days", "mean")).reset_index().sort_values("count", ascending=False)
        d["share"] = d["count"] / d["count"].sum()
        return d
    reasons, severity, resolution, channel = dist("reason_category"), dist("severity"), dist("resolution_status"), dist("channel")
    sev_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    severity = severity.sort_values("severity", key=lambda s: s.map(sev_order))
    reason_severity = pd.crosstab(c.reason_category, c.severity)
    delay_buckets = pd.cut(delay, [-0.01, 1, 3, 7, 15, 30, 10_000], labels=["≤1d", "1–3d", "3–7d", "7–15d", "15–30d", ">30d"]).value_counts().sort_index()
    delayed = c[delay > 7].sort_values("reporting_delay_days", ascending=False)[
        ["complaint_id", "txn_id", "user_id", "merchant_id", "merchant_category", "reason_category", "severity",
         "disputed_amount", "transaction_timestamp", "reported_timestamp", "reporting_delay_days", "resolution_status", "kyc_status"]]
    delayed.to_csv(RISK / "disputes_reported_after_7_days.csv", index=False)
    delay_by_reason = c.groupby("reason_category").reporting_delay_days.agg(["mean", "median", lambda s: (s > 7).mean()]).reset_index()
    delay_by_reason.columns = ["reason_category", "mean_delay", "median_delay", "share_over_7d"]

    # ------------------------------------------------------------------ KYC
    kyc_dist = u.kyc_status.value_counts().rename_axis("kyc_status").reset_index(name="users")
    kyc_dist["share"] = kyc_dist.users / len(u)
    kyc_txn = t.groupby("kyc_status").agg(txns=("txn_id", "size"), amount=("amount", "sum"), disputed_txns=("is_disputed", "sum"),
                                          failed_rate=("status", lambda s: (s == "FAILED").mean())).reset_index()
    kyc_txn["dispute_rate"] = kyc_txn.disputed_txns / kyc_txn.txns
    fraud_by_kyc = linked.groupby("kyc_status").agg(chargebacks=("complaint_id", "size"), fraud_share=("is_fraud_reason", "mean"),
                                                    avg_disputed=("disputed_amount", "mean")).reset_index()
    kyc_txn = kyc_txn.merge(fraud_by_kyc, on="kyc_status", how="left").sort_values("amount", ascending=False)
    risk_seg = t.groupby("risk_segment").agg(txns=("txn_id", "size"), dispute_rate=("is_disputed", "mean"), amount=("amount", "sum")).reset_index()

    # ------------------------------------------------------------------ UTR
    utr = t.groupby("utr_status").agg(txns=("txn_id", "size"), failed_rate=("status", lambda s: (s == "FAILED").mean()),
                                      pending_rate=("status", lambda s: (s == "PENDING").mean()),
                                      dispute_rate=("is_disputed", "mean"), amount=("amount", "sum")).reset_index()
    t[t.utr_status != "VALID"][["txn_id", "timestamp", "user_id", "merchant_id", "amount", "status", "utr_status", "is_disputed"]] \
        .to_csv(RISK / "transactions_missing_or_invalid_utr.csv", index=False)

    # ------------------------------------------------------------------ merchant spikes, merchant & user risk
    spikes = find_spikes(t, linked, m)
    spikes.to_csv(RISK / "merchant_transaction_spikes.csv", index=False)
    mr = score_merchants(t, linked, m, spikes)
    mr.to_csv(RISK / "merchant_risk_scores.csv", index=False)
    ur, hv_threshold, rapid_users = score_users(t, linked, u)
    ur.to_csv(RISK / "user_risk_scores.csv", index=False)

    # ------------------------------------------------------------------ does the scoring predict fraud? (time split)
    bt, bt_tiers, bt_signals = backtest(t, c, m, u)
    bt_tiers.to_csv(RISK / "backtest_tiers.csv", index=False)
    bt_signals.to_csv(RISK / "backtest_signals.csv", index=False)
    hv_customers = ur[ur.max_disputed >= hv_threshold].sort_values("disputed_amount", ascending=False)

    # ------------------------------------------------------------------ graph-first suspicious clusters
    # Bipartite user–merchant payment graph. A "cluster" is a connected component of the
    # dispute-touched subgraph: every user/merchant with ≥1 linked chargeback, plus all payment
    # edges among them. Rings show up as components where several users dispute several shared merchants.
    G = nx.Graph()
    for r in t.itertuples():
        a, b = f"U:{r.user_id}", f"M:{r.merchant_id}"
        if G.has_edge(a, b):
            G[a][b]["txns"] += 1; G[a][b]["amount"] += r.amount; G[a][b]["disputes"] += r.chargeback_count
        else:
            G.add_edge(a, b, txns=1, amount=r.amount, disputes=r.chargeback_count)
    touched = {f"U:{x}" for x in linked.user_id} | {f"M:{x}" for x in linked.merchant_id}
    H = G.subgraph(touched)
    clusters = []
    for comp in sorted(nx.connected_components(H), key=len, reverse=True):
        if len(comp) < 4:
            continue
        sub = H.subgraph(comp)
        users = sorted(x[2:] for x in comp if x.startswith("U:"))
        merchants = sorted(x[2:] for x in comp if x.startswith("M:"))
        cl = linked[linked.user_id.isin(users) & linked.merchant_id.isin(merchants)]
        hub = min(sub.nodes, key=lambda n: (-sub.degree[n], n))   # most links; ties broken by id so runs are reproducible
        clusters.append({
            "cluster_id": f"CL{len(clusters)+1:03d}", "nodes": len(comp), "users": len(users), "merchants": len(merchants),
            "payment_edges": sub.number_of_edges(), "txns": int(sub.size(weight="txns")),
            "amount": float(sub.size(weight="amount")),
            "chargebacks": len(cl), "disputed_amount": float(cl.disputed_amount.sum()),
            "fraud_chargebacks": int(cl.is_fraud_reason.sum()),
            "unverified_or_no_kyc_users": int(t[t.user_id.isin(users)].drop_duplicates("user_id").kyc_status.ne("VERIFIED").sum()),
            "hub_node": hub, "hub_degree": sub.degree[hub],
            "member_users": " ".join(users), "member_merchants": " ".join(merchants),
        })
    clusters = pd.DataFrame(clusters)
    if len(clusters):
        clusters["cluster_risk_score"] = (clusters.chargebacks * 2 + clusters.fraud_chargebacks * 3 + clusters.unverified_or_no_kyc_users
                                          + (clusters.disputed_amount / 10000)).round(1)
        clusters = clusters.sort_values(["cluster_risk_score", "chargebacks", "member_users"], ascending=[False, False, True])
        clusters["cluster_id"] = [f"CL{i+1:03d}" for i in range(len(clusters))]
    clusters.to_csv(RISK / "suspicious_clusters.csv", index=False)

    # duplicate-debit pattern: same user + merchant + amount within 24h (post-dedup)
    dd = t.sort_values("timestamp").copy()
    dd["prev_gap_h"] = dd.groupby(["user_id", "merchant_id", "amount"]).timestamp.diff().dt.total_seconds() / 3600
    dup_debits = dd[dd.prev_gap_h <= 24]

    # ------------------------------------------------------------------ top lists
    top_m_cb = mr[mr.chargebacks > 0].sort_values(["chargebacks", "disputed_amount"], ascending=False)
    top_m_amt = mr[mr.chargebacks > 0].sort_values("disputed_amount", ascending=False)
    top_m_ratio = mr[(mr.txns >= 3) & (mr.chargebacks > 0)].sort_values(["chargeback_to_txn_ratio", "chargebacks"], ascending=False)
    top_u_amt = ur[ur.chargebacks > 0].sort_values("disputed_amount", ascending=False)
    repeat_users = ur[ur.chargebacks >= 2].sort_values(["chargebacks", "disputed_amount"], ascending=False)
    repeat_merch = mr[mr.chargebacks >= 2]

    history = append_history({
        "run_at": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d %H:%M UTC"),
        "data_start": str(t.timestamp.min().date()), "data_end": str(t.timestamp.max().date()),
        "txn_count": n, "chargeback_to_txn_ratio": round(kpi["chargeback_to_txn_ratio"], 4),
        "fraud_reason_share": round(kpi["fraud_reason_share"], 4), "open_dispute_share": round(kpi["open_dispute_share"], 4),
        "high_risk_merchants": int((mr.risk_tier == "HIGH").sum()), "high_risk_users": int((ur.risk_tier == "HIGH").sum()),
        "suspicious_clusters": len(clusters), "bt_cutoff": bt["cutoff"],
        **{f"bt_{kind}_{f}": bt[kind][f] for kind in ("merchant", "user") for f in ("base_rate", "auc", "high_hit_rate", "high_lift", "high_recall")},
    })

    mcols = ["merchant_id", "merchant_name", "category", "merchant_status", "txns", "amount", "chargebacks", "disputed_amount",
             "chargeback_to_txn_ratio", "fraud_chargebacks", "risk_score", "risk_tier", "risk_signals"]
    ucols = ["user_id", "full_name", "kyc_status", "risk_segment", "txns", "amount", "chargebacks", "disputed_amount",
             "max_disputed", "fraud_chargebacks", "risk_score", "risk_tier", "risk_signals"]
    metrics = {
        "generated_for": "TransOrg AgentIQ Datathon – Track 1",
        "window": {"start": str(t.timestamp.min().date()), "end": str(t.timestamp.max().date())},
        "kpi": {k: (round(float(v), 6) if isinstance(v, (float, np.floating)) else int(v)) for k, v in kpi.items()},
        "daily": records(daily), "hourly": records(hourly),
        "weekday": records(weekday.reset_index()),
        "categories": records(cat), "reasons": records(reasons), "severity": records(severity),
        "resolution": records(resolution), "channel": records(channel),
        "reason_severity": {"index": list(reason_severity.index), "columns": list(reason_severity.columns), "data": reason_severity.values.tolist()},
        "delay_buckets": [{"bucket": str(k), "count": int(v)} for k, v in delay_buckets.items()],
        "delay_by_reason": records(delay_by_reason.sort_values("mean_delay", ascending=False)),
        "delayed_disputes": records(delayed, 25), "delayed_total": len(delayed),
        "kyc_dist": records(kyc_dist), "kyc_txn": records(kyc_txn), "risk_segment": records(risk_seg),
        "utr": records(utr),
        "top_merchants_cb": records(top_m_cb[mcols], 10), "top_merchants_amount": records(top_m_amt[mcols], 10),
        "top_merchants_ratio": records(top_m_ratio[mcols], 10),
        "high_risk_merchants": records(mr[mr.risk_tier == "HIGH"][mcols], 25),
        "high_risk_users": records(ur[ur.risk_tier == "HIGH"][ucols], 25),
        "top_users_amount": records(top_u_amt[ucols], 10),
        "repeat_dispute_users": records(repeat_users[ucols], 15),
        "high_value_customers": records(hv_customers[ucols], 15), "high_value_threshold": float(hv_threshold),
        "spikes": records(spikes[["merchant_id", "merchant_name", "merchant_status", "txn_date", "day_txns", "day_amount", "total_txns", "disputes_within_14d", "disputed_amount_14d"]], 15),
        "clusters": records(clusters.drop(columns=["member_users", "member_merchants"]) if len(clusters) else clusters, 12),
        "backtest": {**bt, "tiers": records(bt_tiers), "signals": records(bt_signals)},
        "history": records(history.tail(30)),
        "counts": {
            "high_risk_merchants": int((mr.risk_tier == "HIGH").sum()), "medium_risk_merchants": int((mr.risk_tier == "MEDIUM").sum()),
            "high_risk_users": int((ur.risk_tier == "HIGH").sum()), "medium_risk_users": int((ur.risk_tier == "MEDIUM").sum()),
            "repeat_dispute_users": len(repeat_users), "repeat_dispute_merchants": len(repeat_merch),
            "merchant_spikes": len(spikes), "spikes_followed_by_disputes": int((spikes.disputes_within_14d > 0).sum()),
            "suspicious_clusters": len(clusters), "rapid_repeat_users": len(rapid_users),
            "duplicate_debit_patterns": len(dup_debits),
            "dispute_exceeds_txn": int(c.dispute_exceeds_txn.sum()),
            "reported_before_txn": int(c.reported_before_txn.sum()),
            "chargebacks_unlinked": int((c.link_status != "LINKED").sum()),
        },
    }
    (ROOT / "outputs" / "metrics.json").write_text(json.dumps(metrics, indent=1, default=str, ensure_ascii=False), encoding="utf-8")

    pd.set_option("display.width", 220, "display.max_columns", 30, "display.max_colwidth", 70)
    print(json.dumps(metrics["kpi"], indent=1))
    print(json.dumps(metrics["counts"], indent=1))
    print("\nCATEGORIES\n", cat.round(4).to_string(index=False))
    print("\nREASONS\n", reasons.round(3).to_string(index=False))
    print("\nSEVERITY\n", severity.round(3).to_string(index=False))
    print("\nRESOLUTION\n", resolution.round(3).to_string(index=False))
    print("\nKYC TXN\n", kyc_txn.round(4).to_string(index=False))
    print("\nRISK SEG\n", risk_seg.round(4).to_string(index=False))
    print("\nUTR\n", utr.round(4).to_string(index=False))
    print("\nDELAY BUCKETS\n", delay_buckets.to_string(), "\n", delay_by_reason.round(2).to_string(index=False))
    print("\nHOURLY failed rate\n", hourly[["txn_hour", "txns", "failed_rate"]].round(3).T.to_string())
    print("\nWEEKDAY\n", weekday.round(3).to_string())
    print("\nTOP MERCHANTS\n", mr[mcols].head(12).to_string(index=False))
    print("\nTOP USERS\n", ur[ucols].head(12).to_string(index=False))
    print("\nCLUSTERS\n", clusters.drop(columns=["member_users", "member_merchants"]).head(10).to_string(index=False) if len(clusters) else "none")
    print("\nSPIKES\n", spikes.head(10).to_string(index=False))
    print("\nDAILY describe\n", daily[["txns", "amount", "failed_rate"]].describe().round(3).to_string())
    print("\nBACKTEST\n", json.dumps({k: v for k, v in bt.items()}, indent=1))
    print(bt_tiers.round(3).to_string(index=False))
    print(bt_signals.round(3).to_string(index=False))


if __name__ == "__main__":
    main()
