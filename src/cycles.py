"""
Circular-laundering engine (masterplan M2): Tarjan SCC pruning -> length-bounded Johnson cycle enumeration
-> time-respecting, value-retaining validation -> ring scoring and overlap merge.

Laundered money leaves an account and comes back to it through a few hops, quickly, with most of its value
intact. The engine works on a directed account graph (one edge per ordered payer -> payee pair, carrying
every payment between them):

1. SCC pruning - an account can only sit on a cycle inside a strongly connected component of two or more
   accounts, so everything else is dropped first (networkx's non-recursive Tarjan implementation).
2. Enumeration - every elementary cycle of CYCLE_MIN_LEN..CYCLE_MAX_LEN accounts, per component
   (networkx.simple_cycles: Johnson's algorithm, with Gupta & Suzumura's blocking when length-bounded).
3. Validation - a structural cycle only counts if real payments walk it in time order, close within
   CYCLE_WINDOW_HOURS, and every hop forwards CYCLE_MIN_RETENTION..CYCLE_MAX_TOPUP of what it received.
4. Scoring (0-100) and merge - loops sharing most of their accounts are reported as one ring.
"""
import math
from bisect import bisect_right

import networkx as nx
import pandas as pd

import config

EPOCH = pd.Timestamp("1970-01-01")
RING_COLS = ["ring_id", "accounts", "n_accounts", "n_cycles", "instances", "shortest_cycle", "value_sent", "value_returned",
             "retention", "span_hours", "first_payment", "last_payment", "ring_score", "confidence", "top_cycle", "top_cycle_txns"]


def cycle_confidence(score: float) -> str:
    """Confidence label for circular rings, from the masterplan's score cut-offs."""
    if score >= config.CYCLE_CONFIDENCE_HIGH:
        return "HIGH"
    if score >= config.CYCLE_CONFIDENCE_MEDIUM:
        return "MEDIUM"
    return "LOW"


def build_graph(edges: pd.DataFrame) -> nx.DiGraph:
    """`edges` needs src, dst, amount, timestamp, txn_id. Payments on each edge are kept sorted by time."""
    df = edges.dropna(subset=["src", "dst", "amount", "timestamp"])
    df = df[(df.amount >= config.CYCLE_MIN_AMOUNT) & (df.src != df.dst)].sort_values("timestamp", kind="stable")
    G = nx.DiGraph()
    for (s, d), g in df.groupby(["src", "dst"], sort=False):
        G.add_edge(s, d, ts=((g.timestamp - EPOCH) / pd.Timedelta(seconds=1)).tolist(),
                   amt=g.amount.astype(float).tolist(), txn=g.txn_id.astype(str).tolist())
    return G


def prune(G: nx.DiGraph) -> list[nx.DiGraph]:
    """Strongly connected components that can hold a cycle (self-payments are dropped in build_graph)."""
    return [G.subgraph(c).copy() for c in nx.strongly_connected_components(G) if len(c) > 1]


def enumerate_cycles(components: list[nx.DiGraph]) -> tuple[list[list], bool]:
    """Elementary cycles within the length bound, rotated to start at the smallest account. Returns (cycles, cap_hit)."""
    out = []
    for H in components:
        for cyc in nx.simple_cycles(H, length_bound=config.CYCLE_MAX_LEN):
            if len(cyc) < config.CYCLE_MIN_LEN:
                continue
            i = cyc.index(min(cyc))
            out.append(cyc[i:] + cyc[:i])
            if len(out) >= config.CYCLE_MAX_CYCLES:
                return out, True
    return out, False


def _extend(hops, h, t_prev, a_prev, deadline):
    """Payment indices for hops[h:], each later than the previous and forwarding a valid share of it."""
    if h == len(hops):
        return []
    ts, amt = hops[h]["ts"], hops[h]["amt"]
    i = bisect_right(ts, t_prev)
    while i < len(ts) and ts[i] <= deadline:
        if config.CYCLE_MIN_RETENTION <= amt[i] / a_prev <= config.CYCLE_MAX_TOPUP:
            rest = _extend(hops, h + 1, ts[i], amt[i], deadline)
            if rest is not None:
                return [i] + rest
        i += 1
    return None


def validate(G: nx.DiGraph, cyc: list) -> list[dict]:
    """Time-respecting, value-retaining payment chains around `cyc` that share no payment."""
    k, window = len(cyc), config.CYCLE_WINDOW_HOURS * 3600
    chains = []
    for r in range(k):  # the money can enter the loop at any account
        order = cyc[r:] + cyc[:r]
        hops = [G[order[i]][order[(i + 1) % k]] for i in range(k)]
        for j, (t0, a0) in enumerate(zip(hops[0]["ts"], hops[0]["amt"])):
            rest = _extend(hops, 1, t0, a0, t0 + window)
            if rest is None:
                continue
            idx = [j] + rest
            chains.append({
                "path": order, "txns": [hops[h]["txn"][i] for h, i in enumerate(idx)],
                "start": t0, "end": hops[-1]["ts"][idx[-1]], "sent": a0, "returned": hops[-1]["amt"][idx[-1]],
            })
    # a payment can only belong to one instance, so repeats are counted on disjoint chains, earliest first
    used, instances = set(), []
    for ch in sorted(chains, key=lambda c: (c["start"], c["end"])):
        if used.isdisjoint(ch["txns"]):
            used.update(ch["txns"])
            instances.append(ch)
    return instances


def score_cycle(length: int, span_s: float, retention: float, instances: int, value: float) -> float:
    """0-100: tight (25) + fast (25) + value kept (25) + repeated (15) + large (10)."""
    L = config.CYCLE_MAX_LEN
    tight = 25 * (L - length + 1) / max(L - 1, 1)
    fast = 25 * max(0.0, 1 - span_s / (config.CYCLE_WINDOW_HOURS * 3600))
    floor = config.CYCLE_MIN_RETENTION ** length   # least a loop that passed validation can return
    kept = 25 * (min(1.0, max(0.0, (retention - floor) / (1 - floor))) if floor < 1 else 1.0)
    repeated = 15 * min(instances - 1, 3) / 3
    large = 10 * min(1.0, max(0.0, math.log10(max(value, 1) / config.CYCLE_MIN_AMOUNT) / 2))
    return round(tight + fast + kept + repeated + large, 1)


def merge_rings(cycles: list[dict]) -> list[list[dict]]:
    """Union loops whose account sets overlap by Jaccard >= RING_MERGE_JACCARD."""
    parent = list(range(len(cycles)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    by_account = {}
    for i, c in enumerate(cycles):
        for a in c["accounts"]:
            by_account.setdefault(a, []).append(i)
    for i, c in enumerate(cycles):
        mine = set(c["accounts"])
        for j in {j for a in mine for j in by_account[a] if j > i}:
            other = set(cycles[j]["accounts"])
            if len(mine & other) / len(mine | other) >= config.RING_MERGE_JACCARD:
                parent[root(j)] = root(i)
    groups = {}
    for i in range(len(cycles)):
        groups.setdefault(root(i), []).append(cycles[i])
    return list(groups.values())


def _iso(seconds):
    return (EPOCH + pd.Timedelta(seconds=seconds)).strftime("%Y-%m-%d %H:%M:%S")


def detect_rings(edges: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Run the whole engine. Returns (rings, stats) - rings has RING_COLS and may be empty."""
    G = build_graph(edges)
    components = prune(G)
    structural, cap_hit = enumerate_cycles(components)

    cycles = []
    for cyc in structural:
        inst = validate(G, cyc)
        if not inst:
            continue
        best = max(inst, key=lambda c: (c["returned"] / c["sent"], c["start"] - c["end"]))
        retention, span = best["returned"] / best["sent"], best["end"] - best["start"]
        cycles.append({
            "accounts": cyc, "path": best["path"], "txns": best["txns"], "instances": len(inst),
            "sent": sum(c["sent"] for c in inst), "returned": sum(c["returned"] for c in inst),
            "start": min(c["start"] for c in inst), "end": max(c["end"] for c in inst), "span": span,
            "score": score_cycle(len(cyc), span, retention, len(inst), best["sent"]),
        })

    rows = []
    for group in merge_rings(cycles):
        top = max(group, key=lambda c: (c["score"], -len(c["accounts"])))
        accounts = sorted({a for c in group for a in c["accounts"]})
        sent, returned = sum(c["sent"] for c in group), sum(c["returned"] for c in group)
        rows.append({
            "accounts": " ".join(map(str, accounts)), "n_accounts": len(accounts), "n_cycles": len(group),
            "instances": sum(c["instances"] for c in group), "shortest_cycle": min(len(c["accounts"]) for c in group),
            "value_sent": round(sent, 2), "value_returned": round(returned, 2), "retention": round(returned / sent, 4),
            "span_hours": round(top["span"] / 3600, 2),
            "first_payment": _iso(min(c["start"] for c in group)), "last_payment": _iso(max(c["end"] for c in group)),
            "ring_score": top["score"], "confidence": cycle_confidence(top["score"]),
            "top_cycle": " -> ".join(map(str, top["path"] + top["path"][:1])), "top_cycle_txns": " ".join(top["txns"]),
        })
    rings = pd.DataFrame(rows, columns=[c for c in RING_COLS if c != "ring_id"])
    if len(rings):
        rings = rings.sort_values(["ring_score", "value_sent"], ascending=False, ignore_index=True)
    rings.insert(0, "ring_id", [f"CR{i + 1:03d}" for i in range(len(rings))])

    stats = {
        "accounts": G.number_of_nodes(), "account_pairs": G.number_of_edges(),
        "payments_in_graph": sum(len(d["ts"]) for _, _, d in G.edges(data=True)),
        "cyclic_components": len(components), "accounts_in_cyclic_components": sum(H.number_of_nodes() for H in components),
        "structural_cycles": len(structural), "enumeration_cap_hit": cap_hit, "validated_cycles": len(cycles),
        "rings": len(rings), "high_confidence": int((rings.confidence == "HIGH").sum()),
        "medium_confidence": int((rings.confidence == "MEDIUM").sum()),
    }
    return rings, stats
