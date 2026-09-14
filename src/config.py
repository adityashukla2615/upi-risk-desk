"""Tunable thresholds for the circular-laundering engine (src/cycles.py)."""

# ---------------------------------------------------------------------- graph & enumeration
CYCLE_MIN_LEN = 2               # A -> B -> A round trip is the shortest loop
CYCLE_MAX_LEN = 6               # accounts per loop; longer loops are rare and blow up enumeration
CYCLE_MAX_CYCLES = 200_000      # hard stop on structural cycles per run
CYCLE_MIN_AMOUNT = 1_000.0      # ₹; smaller payments are left out of the graph

# ---------------------------------------------------------------------- validation
CYCLE_WINDOW_HOURS = 72         # first payment to last payment of one loop
CYCLE_MIN_RETENTION = 0.80      # each hop forwards at least 80% of what it received...
CYCLE_MAX_TOPUP = 1.05          # ...and at most 105% (small top-ups allowed)

# ---------------------------------------------------------------------- scoring & merge
CYCLE_CONFIDENCE_HIGH = 70      # ring score is 0-100
CYCLE_CONFIDENCE_MEDIUM = 40
RING_MERGE_JACCARD = 0.5        # loops sharing at least half their accounts become one ring
