"""
Step 4b: Claude-powered risk agents over the payment graph and the SQLite model.

The deterministic graph agent in agent.py answers the example queries by intent routing. This module
puts Claude Opus 5 in charge of planning instead: it gets the graph traversals as tools, plus a
read-only SQL tool over outputs/upi_analytics.db, and a `delegate` tool to hand focused work to
specialist agents (analyst, investigator, reporter) whose findings it then synthesises.

    py -m pip install --user anthropic
    set ANTHROPIC_API_KEY=...          (or `ant auth login`)
    py src/llm_agent.py --ask "Which merchants look like they are colluding with repeat disputers?"
    py src/llm_agent.py                # interactive
    py src/llm_agent.py --demo         # runs a few open-ended questions -> outputs/agent_demo_llm.md

The dashboard (outputs/upi_risk_desk.html) runs the same agent team in the browser.
"""
import argparse
import io
import json
import sqlite3
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic

from agent import EXAMPLES, Agent, PaymentGraph

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "outputs" / "upi_analytics.db"
MODEL = "claude-opus-5"
PRIVATE_COLUMNS = {"pan", "aadhaar_last4", "settlement_account_last4", "utr"}  # never exposed to the model
MAX_ROWS = 200

CONTEXT = """You are part of a risk-operations agent team for one quarter (2026-01-01 to 2026-03-31) of cleaned UPI payments,
built for the TransOrg AgentIQ Datathon (Track 1).

Data (SQLite, already cleaned):
- fact_transactions(txn_id, timestamp, txn_date, txn_hour, user_id, merchant_id, amount, status SUCCESS/FAILED/PENDING, utr_status,
  merchant_category, kyc_status, risk_segment, user_in_kyc, merchant_in_master, chargeback_count, disputed_amount, is_disputed)
- fact_chargebacks(complaint_id, txn_id, link_status LINKED/..., user_id, merchant_id, disputed_amount, reason_category, is_fraud_reason,
  severity, resolution_status, is_open, channel, reporting_delay_days, reported_timestamp, merchant_category, kyc_status)
- dim_users(user_id, full_name, city, state, monthly_income, occupation, kyc_status, risk_segment, id_record_count)
- dim_merchants(merchant_id, merchant_name, merchant_category, business_type, city, merchant_status, settlement_account_type, onboarding_date)
- views v_merchant_risk, v_category_disputes; table data_quality_report(table, check, rows_affected, action)

Rules established by the pipeline — respect them:
- fact_chargebacks.user_id / merchant_id come from the linked transaction (txn_id). The complaint's own ids never match the payment.
- Dispute rate = transactions with ≥1 linked chargeback ÷ transactions (use fact_transactions.is_disputed).
- Fraud-type reasons: ACCOUNT_TAKEOVER, UNAUTHORIZED_TXN, FRAUD_SUSPECTED. Unresolved = OPEN, IN_PROGRESS, PENDING_BANK.
- 67.6% of payments have kyc_status NO_KYC_RECORD; 6,288 KYC ids map to several people (id_record_count > 1).
- Merchants absent from the master have merchant_in_master = 0. Money only flows user → merchant (no loops exist).
- Risk scores in the dashboard are explainable worklists; an out-of-time backtest shows AUC ≈ 0.5, so never present them as predictions.

Work: get every number from a tool, never invent ids or figures, prefer few well-chosen calls, run independent calls in parallel.
Answer: lead with the direct answer and the key number in **bold**, then brief bullets or a small table, money in ₹ with L (lakh) /
Cr (crore), and one recommended action for a risk team when relevant."""

ROLES = {
    "lead": "You are the Risk Lead. Answer simple questions yourself. For multi-part questions, deep dives or reports, delegate focused, "
            "self-contained tasks to specialists (in parallel when independent) and synthesise their findings — do not paste them verbatim.",
    "analyst": "You are the Analyst: KPIs, breakdowns, trends, rankings and comparisons, mostly via SQL.",
    "investigator": "You are the Investigator: deep dives on merchants, users, and rings via the graph tools. Weigh the evidence and "
                    "recommend a concrete action (block, step-up KYC, hold settlement, reserve, monitor).",
    "reporter": "You are the Reporter: crisp executive briefs for a Head of Risk — situation, top risks with numbers, confidence caveats, 3–5 actions.",
}


# ============================================================ tools
class Tools:
    def __init__(self):
        self.pg = PaymentGraph()
        self.agent = Agent(self.pg)
        self.db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, check_same_thread=False)
        self.db.set_authorizer(self._authorize)
        self.lock = threading.Lock()

    @staticmethod
    def _authorize(action, arg1, arg2, _db, _trigger):
        if action == sqlite3.SQLITE_READ and arg2 in PRIVATE_COLUMNS:
            return sqlite3.SQLITE_DENY
        if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION):
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY

    def sql_query(self, query):
        with self.lock:  # tool calls run in parallel threads; one sqlite connection must not be used concurrently
            cur = self.db.execute(query)
            cols = [c[0] for c in cur.description or []]
            rows = cur.fetchmany(MAX_ROWS + 1)
        return {"columns": cols, "rows": rows[:MAX_ROWS], "truncated": len(rows) > MAX_ROWS}

    def graph_answer(self, question):
        return self.agent.ask(question)

    def merchant_profile(self, merchant_id):
        mid = merchant_id.strip().upper().replace("-", "").replace(" ", "")
        if mid not in self.pg.G:
            raise ValueError(f"{merchant_id} is not in the graph")
        p = self.pg.merchant_profile(mid)
        users = sorted({self.pg.user_of_txn(t) for t in self.pg.txns_of_merchant(mid)})
        shared = {}
        for u in users:
            for t in self.pg.txns_of_user(u):
                m = self.pg.merchant_of_txn(t)
                if m != mid:
                    shared[m] = shared.get(m, 0) + 1
        return {**p, "payers": users[:50], "payers_total": len(users),
                "merchants_sharing_payers": sorted(shared.items(), key=lambda kv: -kv[1])[:15]}

    def user_profile(self, user_id):
        uid = user_id.strip().upper().replace("-", "").replace(" ", "")
        if uid not in self.pg.G:
            raise ValueError(f"{user_id} is not in the graph")
        return self.pg.user_profile(uid)

    def find_rings(self):
        return self.agent.clusters("rings")


TOOL_SPECS = {
    "sql_query": {
        "description": "Run one read-only SQLite SELECT over the cleaned model (tables and rules in your instructions). Returns at most "
                       f"{MAX_ROWS} rows. Personal identifiers (PAN, Aadhaar, account numbers, UTR) are blocked, so name columns explicitly "
                       "instead of SELECT * on dim_users, dim_merchants or fact_transactions.",
        "input_schema": {"type": "object", "required": ["query"], "properties": {"query": {"type": "string"}}},
    },
    "graph_answer": {
        "description": "Ask the deterministic graph agent one of its known questions (trends, category/KYC/reason/severity breakdowns, "
                       "top merchants/users, delayed disputes, rings, or an MCH####/USR##### lookup). Returns markdown computed by "
                       "traversing the property graph.",
        "input_schema": {"type": "object", "required": ["question"], "properties": {"question": {"type": "string"}}},
    },
    "merchant_profile": {
        "description": "Graph profile of one merchant: payments, chargebacks, fraud-type count, ratio, its payers and the other merchants "
                       "those payers also paid (possible collusion).",
        "input_schema": {"type": "object", "required": ["merchant_id"], "properties": {"merchant_id": {"type": "string"}}},
    },
    "user_profile": {
        "description": "Graph profile of one user: KYC, payments, chargebacks, fraud-type count and the merchants paid.",
        "input_schema": {"type": "object", "required": ["user_id"], "properties": {"user_id": {"type": "string"}}},
    },
    "find_rings": {
        "description": "Connected components of dispute-touched users and merchants (≥4 members), ranked by risk.",
        "input_schema": {"type": "object", "properties": {}},
    },
}
DELEGATE = {
    "name": "delegate",
    "description": "Hand a focused, self-contained task to a specialist (analyst, investigator or reporter) and get its findings back. "
                   "Call several in one turn to run them in parallel.",
    "input_schema": {"type": "object", "required": ["agent", "task"],
                     "properties": {"agent": {"type": "string", "enum": ["analyst", "investigator", "reporter"]}, "task": {"type": "string"}}},
}
AGENT_TOOLS = {
    "lead": ["delegate", "sql_query", "graph_answer"],
    "analyst": ["sql_query", "graph_answer"],
    "investigator": ["merchant_profile", "user_profile", "find_rings", "sql_query"],
    "reporter": ["sql_query", "graph_answer", "find_rings"],
}


# ============================================================ agent loop
class Team:
    def __init__(self, verbose=True):
        self.client = anthropic.Anthropic()
        self.tools = Tools()
        self.verbose = verbose

    def log(self, depth, text):
        if self.verbose:
            print("  " * depth + text, file=sys.stderr, flush=True)

    def tool_defs(self, agent):
        return [DELEGATE if n == "delegate" else {"name": n, **TOOL_SPECS[n]} for n in AGENT_TOOLS[agent]]

    def run_tool(self, agent, block, depth):
        name, args = block.name, block.input or {}
        try:
            if name not in AGENT_TOOLS[agent]:
                raise ValueError(f"tool {name} is not available to {agent}")
            if name == "delegate":
                self.log(depth, f"↳ {agent} delegates to {args.get('agent')}: {args.get('task', '')[:100]}")
                out = self.run(args["agent"], [{"role": "user", "content": args["task"]}], depth + 1)
            else:
                self.log(depth, f"ƒ {agent} → {name}({json.dumps(args, ensure_ascii=False)[:120]})")
                out = getattr(self.tools, name)(**args)
            content = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False, default=str)
            return {"type": "tool_result", "tool_use_id": block.id, "content": content[:30000]}
        except Exception as e:  # noqa: BLE001 — tool errors go back to the model so it can correct its call
            return {"type": "tool_result", "tool_use_id": block.id, "content": f"Error: {e}", "is_error": True}

    def run(self, agent, messages, depth=0):
        system = f"{CONTEXT}\n\n{ROLES[agent]}"
        for _ in range(12):
            with self.client.beta.messages.stream(
                model=MODEL, max_tokens=16000, system=system, tools=self.tool_defs(agent), messages=messages,
                thinking={"type": "adaptive"}, output_config={"effort": "low" if depth else "medium"},
                cache_control={"type": "ephemeral"}, betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            ) as stream:
                if depth == 0 and self.verbose:
                    for text in stream.text_stream:
                        print(text, end="", flush=True)
                message = stream.get_final_message()
            messages.append({"role": "assistant", "content": message.content})
            if message.stop_reason == "refusal":
                return "The request was declined by the model's safety system."
            if message.stop_reason == "pause_turn":
                continue
            uses = [b for b in message.content if b.type == "tool_use"]
            if not uses:
                return "".join(b.text for b in message.content if b.type == "text")
            if depth == 0 and self.verbose:
                print(file=sys.stderr)
            with ThreadPoolExecutor(max_workers=4) as pool:  # parallel tool calls and parallel delegation
                results = list(pool.map(lambda b: self.run_tool(agent, b, depth), uses))
            messages.append({"role": "user", "content": results})
        return "Stopped after too many tool rounds."


DEMO = [
    "Give me an executive risk brief for the quarter with the five actions that matter most.",
    "Are there merchants that share an unusual number of disputing customers? Investigate the strongest case.",
    "Do rejected or missing-KYC customers dispute more than verified ones, and is it worth blocking them?",
    EXAMPLES[11],
]


def main():
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8")
    if isinstance(sys.stderr, io.TextIOWrapper):
        sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--ask")
    ap.add_argument("--demo", action="store_true")
    args = ap.parse_args()
    try:
        team = Team()
    except anthropic.AnthropicError as e:
        raise SystemExit(f"Claude client unavailable ({e}). Set ANTHROPIC_API_KEY or run `ant auth login`.")
    try:
        if args.ask:
            team.run("lead", [{"role": "user", "content": args.ask}])
            print()
        elif args.demo:
            out = ["# Claude risk agents – open-ended queries\n", f"Model: `{MODEL}` · team: lead → analyst / investigator / reporter\n"]
            for q in DEMO:
                print(f"\n## {q}\n", flush=True)
                answer = team.run("lead", [{"role": "user", "content": q}])
                out.append(f"\n## Q: {q}\n\n{answer}\n")
            path = ROOT / "outputs" / "agent_demo_llm.md"
            path.write_text("".join(out), encoding="utf-8")
            print(f"\nwrote {path}", file=sys.stderr)
        else:
            history = []
            print("Ask the risk agents (blank line to quit).")
            while (q := input("\n> ").strip()):
                history.append({"role": "user", "content": q})
                team.run("lead", history)
                print()
    except TypeError as e:  # raised by the SDK when no credential source is configured at all
        if "authentication" not in str(e):
            raise
        raise SystemExit("No Anthropic credentials found. Set ANTHROPIC_API_KEY or run `ant auth login`.")
    except anthropic.AuthenticationError:
        raise SystemExit("Anthropic API key rejected. Set ANTHROPIC_API_KEY or run `ant auth login`.")
    except anthropic.APIConnectionError:
        raise SystemExit("Could not reach the Anthropic API.")
    except anthropic.APIStatusError as e:
        raise SystemExit(f"Anthropic API error {e.status_code}: {e.message}")


if __name__ == "__main__":
    main()
