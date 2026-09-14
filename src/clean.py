"""
Track 1 - UPI Fraud Ring & Merchant Analytics
Step 1: clean + standardize the four raw sources, build an analytics-ready star schema.

Strategy: never silently drop messy rows. Every repair is recorded as a flag column
and summarised in outputs/data_quality_report.csv. Rows are removed only when they are
exact/ID duplicates (which would inflate revenue and dispute metrics).
"""
import json
import re
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "outputs"
CLEAN = OUT / "clean"
CLEAN.mkdir(parents=True, exist_ok=True)

DATA_START = pd.Timestamp("2026-01-01")
DATA_END = pd.Timestamp("2026-03-31 23:59:59")   # observed transaction window
AS_OF = DATA_END

QUALITY = []  # (table, check, rows_affected, action)


def log(table, check, n, action):
    QUALITY.append({"table": table, "check": check, "rows_affected": int(n), "action": action})


def is_blank(v):
    return v is None or (isinstance(v, float) and np.isnan(v)) or str(v).strip().upper() in {"", "NA", "N/A", "NULL", "NONE", "NAN", "-"}


# ---------------------------------------------------------------- IDs
def norm_user_id(v):
    """USR12345 / usr12345 / USR-12345 / USR 12345 / usr_12345 / 12345 -> USR12345"""
    if is_blank(v):
        return None
    d = re.sub(r"\D", "", str(v))
    return f"USR{d}" if len(d) == 5 else None


def norm_merchant_id(v):
    """MCH1234 / mch1234 / MCH-1234 / MCH 1234 / 1234 -> MCH1234"""
    if is_blank(v):
        return None
    d = re.sub(r"\D", "", str(v))
    return f"MCH{d}" if len(d) == 4 else None


def norm_txn_id(v):
    """TXN00001234 / TXN-00001234 / TXN1234 -> TXN00001234 (8-digit zero padded)"""
    if is_blank(v):
        return None
    d = re.sub(r"\D", "", str(v))
    return f"TXN{int(d):08d}" if d and len(d) <= 8 else None


# ---------------------------------------------------------------- money
def parse_amount(v):
    """Returns (abs_amount, was_negative, was_invalid). Handles ₹ / Rs. / INR, commas, k-suffix."""
    if is_blank(v):
        return np.nan, False, False
    if isinstance(v, (int, float)):
        x = float(v)
    else:
        s = str(v).strip().replace("₹", "").replace(",", "")
        s = re.sub(r"(?i)^(rs\.?|inr)\s*", "", s).strip()
        mult = 1.0
        if s.lower().endswith("k"):
            mult, s = 1000.0, s[:-1]
        try:
            x = float(s) * mult
        except ValueError:
            return np.nan, False, True
    return abs(x), x < 0, False


# ---------------------------------------------------------------- dates
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def parse_ts(v):
    """
    Returns (Timestamp|NaT, has_time).
    Conventions verified by profiling (no counter-examples in any file):
      YYYY-MM-DD HH:MM:SS | YYYY/MM/DD | DD/MM/YYYY [HH:MM:SS | HH:MM AM] |
      MM-DD-YYYY [HH:MM:SS AM] | DD-Mon-YYYY | unix epoch seconds (may be negative for DOBs)
    """
    if is_blank(v):
        return pd.NaT, False
    s = str(v).strip()
    try:
        if re.fullmatch(r"-?\d{6,11}", s):
            return pd.Timestamp(int(s), unit="s"), True   # naive epoch seconds; negative = pre-1970 DOB
        m = re.fullmatch(r"(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?", s)
        if m:
            y, mo, d, hh, mi, ss = m.groups()
            return pd.Timestamp(int(y), int(mo), int(d), int(hh or 0), int(mi or 0), int(ss or 0)), hh is not None
        m = re.fullmatch(r"(\d{2})([/-])(\d{2})\2(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?(?: ?([AaPp][Mm]))?)?", s)
        if m:
            a, sep, b, y, hh, mi, ss, ap = m.groups()
            day, mon = (int(a), int(b)) if sep == "/" else (int(b), int(a))
            h = int(hh or 0)
            if ap:
                h = h % 12 + (12 if ap.lower() == "pm" else 0)
            return pd.Timestamp(int(y), mon, day, h, int(mi or 0), int(ss or 0)), hh is not None
        m = re.fullmatch(r"(\d{1,2})-([A-Za-z]{3})-(\d{4})", s)
        if m:
            return pd.Timestamp(int(m.group(3)), MONTHS[m.group(2).lower()], int(m.group(1))), False
    except (ValueError, KeyError):
        pass
    return pd.NaT, False


def parse_ts_col(series):
    parsed = [parse_ts(v) for v in series]
    return (pd.Series([p[0] for p in parsed], index=series.index, dtype="datetime64[ns]"),
            pd.Series([p[1] for p in parsed], index=series.index, dtype=bool))


# ---------------------------------------------------------------- lookups
STATUS_MAP = {
    "SUCCESS": "SUCCESS", "S": "SUCCESS", "TXN_SUCCESS": "SUCCESS", "COMPLETED": "SUCCESS",
    "FAILED": "FAILED", "TXN_FAILED": "FAILED", "FAIL": "FAILED", "DECLINED": "FAILED", "F": "FAILED",
    "PENDING": "PENDING", "PROCESSING": "PENDING", "INITIATED": "PENDING",
}
MCC_CATEGORY = {
    4131: "Transportation", 4814: "Telecom", 5311: "Department Stores", 5411: "Grocery",
    5699: "Apparel", 5812: "Restaurants", 5912: "Pharmacy", 5942: "Books & Stationery",
    5999: "Misc Retail", 7011: "Hotels & Lodging",
}
RAW_CATEGORY_TO_MCC = {
    **dict.fromkeys(["apparel", "clothing", "cloths", "fashion", "garments"], 5699),
    **dict.fromkeys(["book store", "books", "books_stationery", "stationery"], 5942),
    **dict.fromkeys(["bus/taxi", "transport", "transportation", "transprt", "travel"], 4131),
    **dict.fromkeys(["chemist", "medical", "medical_store", "pharmacies", "pharmacy"], 5912),
    **dict.fromkeys(["department store", "department stores", "dept_store", "retail"], 5311),
    **dict.fromkeys(["eating place", "food", "food_services", "restaurant", "restaurants"], 5812),
    **dict.fromkeys(["groceries", "grocery", "grocery stores", "grocery_store", "kirana"], 5411),
    **dict.fromkeys(["hospitality", "hotel", "hotel_lodging", "hotels"], 7011),
    **dict.fromkeys(["misc retail", "miscellaneous", "other", "retail other"], 5999),
    **dict.fromkeys(["mobile recharge", "phone service", "telecom"], 4814),
}
CITY_MAP = {
    "bombay": "Mumbai", "mumbay": "Mumbai", "mumbai": "Mumbai", "poona": "Pune", "pune": "Pune",
    "hyd": "Hyderabad", "hyderabad": "Hyderabad", "ldh": "Ludhiana", "ludhiana": "Ludhiana",
    "jalandar": "Jalandhar", "jalandhar": "Jalandhar", "lko": "Lucknow", "lucknow": "Lucknow",
    "calcutta": "Kolkata", "kolkata": "Kolkata", "jpr": "Jaipur", "jaipur": "Jaipur",
    "asr": "Amritsar", "amritsar": "Amritsar", "madras": "Chennai", "chennai": "Chennai",
    "blr": "Bengaluru", "bangalore": "Bengaluru", "bengaluru": "Bengaluru",
    "dilli": "Delhi", "new delhi": "Delhi", "delhi": "Delhi",
}
CITY_STATE = {
    "Mumbai": "Maharashtra", "Pune": "Maharashtra", "Hyderabad": "Telangana", "Ludhiana": "Punjab",
    "Jalandhar": "Punjab", "Amritsar": "Punjab", "Lucknow": "Uttar Pradesh", "Kolkata": "West Bengal",
    "Jaipur": "Rajasthan", "Chennai": "Tamil Nadu", "Bengaluru": "Karnataka", "Delhi": "Delhi",
}
KYC_STATUS_MAP = {
    **dict.fromkeys(["VERIFIED", "V", "APPROVED", "KYC_DONE", "DONE"], "VERIFIED"),
    **dict.fromkeys(["PENDING", "P"], "PENDING"),
    **dict.fromkeys(["IN_PROGRESS", "UNDER REVIEW"], "IN_REVIEW"),
    **dict.fromkeys(["REJECTED", "R", "REJECT", "FAILED"], "REJECTED"),
}
MERCHANT_STATUS_MAP = {
    **dict.fromkeys(["ACTIVE", "ENABLED", "LIVE", "A"], "ACTIVE"),
    **dict.fromkeys(["INACTIVE", "DISABLED", "I"], "INACTIVE"),
    "CLOSED": "CLOSED",
    **dict.fromkeys(["SUSPENDED", "HOLD", "S"], "SUSPENDED"),
    "BLOCKED": "BLOCKED",
}
SEVERITY_MAP = {
    **dict.fromkeys(["P1", "CRIT", "CRITICAL"], "CRITICAL"),
    **dict.fromkeys(["P2", "H", "HIGH"], "HIGH"),
    **dict.fromkeys(["P3", "M", "MEDIUM"], "MEDIUM"),
    **dict.fromkeys(["P4", "L", "LOW"], "LOW"),
}
RESOLUTION_MAP = {
    "OPEN": "OPEN", "IN_PROGRESS": "IN_PROGRESS", "IN PROGRESS": "IN_PROGRESS", "WIP": "IN_PROGRESS",
    "PENDING BANK": "PENDING_BANK", "PENDING_BANK": "PENDING_BANK", "RESOLVED": "RESOLVED",
    "CLOSED": "CLOSED", "REJECTED": "REJECTED",
}
REASON_MAP = {
    **dict.fromkeys(["dup_debit", "duplicate debit", "charged twice", "double debit"], "DUPLICATE_DEBIT"),
    **dict.fromkeys(["ato", "account takeover", "account hacked", "login compromised"], "ACCOUNT_TAKEOVER"),
    **dict.fromkeys(["unauthorised", "unauthorized transaction", "unauth txn", "unauthorized_transaction", "not done by me"], "UNAUTHORIZED_TXN"),
    **dict.fromkeys(["fraud", "fraud suspected", "scam", "suspicious transaction"], "FRAUD_SUSPECTED"),
    **dict.fromkeys(["merchant not delivered", "item not received", "not delivered", "delivery issue"], "NOT_DELIVERED"),
    **dict.fromkeys(["service not provided", "no service", "service failed", "merchant service issue"], "SERVICE_NOT_PROVIDED"),
    **dict.fromkeys(["wrong amount", "amount mismatch", "incorrect amount", "extra amount deducted"], "WRONG_AMOUNT"),
    **dict.fromkeys(["customer dispute", "complaint", "customer issue", "dispute raised"], "GENERAL_DISPUTE"),
}
FRAUD_REASONS = {"ACCOUNT_TAKEOVER", "UNAUTHORIZED_TXN", "FRAUD_SUSPECTED"}
CHANNEL_MAP = {"EMAIL": "Email", "BRANCH": "Branch", "IVR": "IVR", "CHATBOT": "Chatbot", "APP": "App", "CALL CENTER": "Call Center"}
BUSINESS_TYPE_MAP = {"INDIVIDUAL": "Individual", "PARTNERSHIP": "Partnership", "SOLE_PROPRIETOR": "Sole Proprietor", "PRIVATE_LIMITED": "Private Limited"}


def upper_key(v):
    return None if is_blank(v) else re.sub(r"\s+", " ", str(v).strip()).upper()


def parse_mcc(v):
    if is_blank(v):
        return None
    d = re.sub(r"\D", "", str(v).split(".")[0])
    return int(d) if d and int(d) in MCC_CATEGORY else None


def fix_name(v):
    if is_blank(v):
        return None
    s = re.sub(r"\s+", " ", str(v)).strip()
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s)                       # AyushmanRavi -> Ayushman Ravi
    s = re.sub(r"(?<=[A-Za-z])0(?=[A-Za-z])", "o", s)                 # Gh0sh -> Ghosh
    s = re.sub(r"(?<=[A-Za-z])1(?=\b|[A-Za-z])", "l", s)              # Ba1 -> Bal
    s = re.sub(r"(?i)(?<=[a-z])(llc|inc|ltd)\b", r" \1", s)           # KalaLLC -> Kala LLC
    s = re.sub(r"\s+", " ", s)
    words = []
    for w in s.split(" "):
        lw = w.lower().strip(",")
        if lw in {"llc", "inc", "ltd"}:
            words.append({"llc": "LLC", "inc": "Inc", "ltd": "Ltd"}[lw] + ("," if w.endswith(",") else ""))
        elif lw == "and":
            words.append("and")
        else:
            words.append("-".join(p[:1].upper() + p[1:].lower() for p in w.split("-")))
    return " ".join(words)


def pick_canonical(df, key, recency_col, table):
    """ID collisions (same normalized ID, different records). Keep most recent record, then most complete."""
    df = df.copy()
    df["_complete"] = df.notna().sum(axis=1)
    df["_rec"] = df[recency_col].fillna(pd.Timestamp("1900-01-01"))
    df = df.sort_values([key, "_rec", "_complete"], ascending=[True, False, False])
    df["id_record_count"] = df.groupby(key)[key].transform("size")
    df["is_canonical"] = ~df.duplicated(key, keep="first")
    n_coll = (df["id_record_count"] > 1).sum()
    log(table, "ID collisions (same normalized ID, conflicting attributes)", n_coll,
        "all rows kept in *_all_records.csv; dimension uses most-recent then most-complete record; id_record_count flags ambiguity")
    return df.drop(columns=["_complete", "_rec"])


# ================================================================ KYC
def clean_kyc():
    raw = pd.read_csv(ROOT / "track1_kyc_records.csv", dtype=str, keep_default_na=False)
    n0 = len(raw)
    dups = raw.duplicated().sum()
    raw = raw.drop_duplicates()
    log("kyc", "exact duplicate rows", dups, "removed")
    k = pd.DataFrame(index=raw.index)
    k["user_id"] = raw["user_id"].map(norm_user_id)
    log("kyc", "user_id non-canonical format (usr_/USR-/space/bare digits)", (raw["user_id"] != k["user_id"]).sum(), "standardized to USR#####")
    bad_id = k["user_id"].isna()
    log("kyc", "user_id unparseable", bad_id.sum(), "excluded from dimension (no key)")
    k["user_id_raw"] = raw["user_id"]
    k["full_name"] = raw["full_name"].map(fix_name)

    pan = raw["pan"].str.replace(r"[\s-]", "", regex=True).str.upper()
    valid_pan = pan.str.fullmatch(r"[A-Z]{5}\d{4}[A-Z]")
    k["pan"] = pan.where(valid_pan)
    k["pan_status"] = np.select([raw["pan"].map(is_blank), valid_pan], ["MISSING", "VALID"], "INVALID")
    log("kyc", "PAN with spaces/hyphens/lowercase", (raw["pan"].str.contains(r"[\s-]|[a-z]", regex=True)).sum(), "stripped and upper-cased")
    log("kyc", "PAN missing", (k.pan_status == "MISSING").sum(), "pan_status=MISSING")
    log("kyc", "PAN invalid pattern (not AAAAA9999A)", (k.pan_status == "INVALID").sum(), "value nulled, pan_status=INVALID")

    a = raw["aadhaar"].str.replace(r"[\s-]", "", regex=True).str.upper()
    masked = a.str.fullmatch(r"X{8}\d{4}")
    valid_a = a.str.fullmatch(r"\d{12}")
    k["aadhaar_last4"] = a.str[-4:].where(valid_a | masked)
    k["aadhaar_status"] = np.select([raw["aadhaar"].map(is_blank), valid_a, masked], ["MISSING", "VALID", "MASKED"], "INVALID")
    log("kyc", "Aadhaar missing", (k.aadhaar_status == "MISSING").sum(), "aadhaar_status=MISSING")
    log("kyc", "Aadhaar invalid length (10/13 digits)", (k.aadhaar_status == "INVALID").sum(), "aadhaar_status=INVALID; only last-4 stored for privacy")
    log("kyc", "Aadhaar pre-masked XXXX-XXXX-####", (k.aadhaar_status == "MASKED").sum(), "aadhaar_status=MASKED")

    dob, _ = parse_ts_col(raw["date_of_birth"])
    age = (AS_OF - dob).dt.days / 365.25
    bad_dob = dob.notna() & ((age < 18) | (age > 100))
    log("kyc", "DOB impossible (age <18 or >100 at 2026-03-31)", bad_dob.sum(), "dob nulled, dob_invalid=True")
    k["date_of_birth"] = dob.where(~bad_dob).dt.date
    k["dob_invalid"] = bad_dob
    k["age"] = age.where(~bad_dob).round(1)

    k["city"] = raw["city"].str.strip().str.lower().map(CITY_MAP)
    log("kyc", "city alias/case variants (Bombay, BLR, Dilli...)", (raw["city"] != k["city"]).sum(), "mapped to canonical city")
    k["state"] = raw["state"].str.strip()
    k["city_state_mismatch"] = k["city"].map(CITY_STATE) != k["state"]
    log("kyc", "city/state inconsistent", k.city_state_mismatch.sum(), "flagged")

    inc = raw["monthly_income"].map(parse_amount)
    k["monthly_income"] = [x[0] for x in inc]
    k["income_was_negative"] = [x[1] for x in inc]
    log("kyc", "income with ₹/Rs./INR/commas/k-suffix", raw["monthly_income"].str.contains(r"[^\d-]", regex=True).sum(), "parsed to numeric INR")
    log("kyc", "income missing / 'Not Available'", k.monthly_income.isna().sum(), "left null (not imputed)")
    log("kyc", "income negative", k.income_was_negative.sum(), "sign error -> absolute value, flagged")
    k["occupation"] = raw["occupation"].str.strip().str.title()

    signup, _ = parse_ts_col(raw["signup_timestamp"])
    future = signup > AS_OF
    log("kyc", "signup timestamp missing", signup.isna().sum(), "left null")
    log("kyc", "signup after data window (future)", future.sum(), "flagged signup_in_future")
    k["signup_timestamp"] = signup
    k["signup_in_future"] = future
    k["kyc_status"] = raw["kyc_status"].map(upper_key).map(KYC_STATUS_MAP).fillna("UNKNOWN")
    log("kyc", "kyc_status variants (V, APPROVED, KYC_DONE, R, ...)", len(k), "mapped to VERIFIED/PENDING/IN_REVIEW/REJECTED")
    k["risk_segment"] = raw["risk_segment"].str.strip().str.upper()
    k = k[~bad_id]
    allrec = pick_canonical(k, "user_id", "signup_timestamp", "kyc")
    allrec.to_csv(CLEAN / "kyc_all_records.csv", index=False)
    dim = allrec[allrec.is_canonical].drop(columns=["is_canonical"]).reset_index(drop=True)
    print(f"KYC: {n0} raw -> {len(allrec)} records -> {len(dim)} users")
    return dim


# ================================================================ MERCHANTS
def clean_merchants():
    raw = pd.read_csv(ROOT / "track1_merchants_master.csv", dtype=str, keep_default_na=False)
    n0 = len(raw)
    dups = raw.duplicated().sum()
    raw = raw.drop_duplicates()
    log("merchants", "exact duplicate rows", dups, "removed")
    m = pd.DataFrame(index=raw.index)
    m["merchant_id"] = raw["merchant_id"].map(norm_merchant_id)
    log("merchants", "merchant_id non-canonical format", (raw["merchant_id"] != m["merchant_id"]).sum(), "standardized to MCH####")
    m["merchant_id_raw"] = raw["merchant_id"]
    m["merchant_name"] = raw["merchant_name"].map(fix_name)
    log("merchants", "merchant name typos (digit-for-letter, joined LLC, case)", (raw["merchant_name"] != m["merchant_name"]).sum(), "normalized")

    code = raw["mcc"].map(parse_mcc)
    cat_mcc = raw["merchant_category"].str.strip().str.lower().map(RAW_CATEGORY_TO_MCC)
    m["mcc"] = code.fillna(cat_mcc).astype("Int64")
    m["mcc_source"] = np.select([code.notna(), cat_mcc.notna()], ["mcc_field", "inferred_from_category"], "unknown")
    log("merchants", "MCC formatted as MCC-####, 0####, ####.0", raw["mcc"].str.fullmatch(r"(MCC-|0)\d{4}|\d{4}\.0").sum(), "stripped to 4-digit int")
    log("merchants", "MCC missing/'misc'/'NA'/'UNKNOWN'", code.isna().sum(), "inferred from merchant_category (1:1 mapping verified)")
    m["mcc_category_conflict"] = code.notna() & cat_mcc.notna() & (code != cat_mcc)
    log("merchants", "MCC contradicts category text", m.mcc_category_conflict.sum(), "MCC code trusted, flagged")
    m["merchant_category"] = m["mcc"].map(lambda x: MCC_CATEGORY.get(x) if pd.notna(x) else "Unknown")
    log("merchants", "category text variants (82 spellings)", len(m), "collapsed to 10 MCC-aligned categories")
    m["merchant_category_raw"] = raw["merchant_category"]
    m["business_type"] = raw["business_type"].str.upper().str.replace(r"[\s-]", "_", regex=True).map(BUSINESS_TYPE_MAP)
    m["city"] = raw["city"].str.strip().str.lower().map(CITY_MAP)
    m["state"] = raw["state"].str.strip()
    m["city_state_mismatch"] = m["city"].map(CITY_STATE) != m["state"]
    onb, _ = parse_ts_col(raw["onboarding_date"])
    m["onboarding_date"] = onb
    m["onboarding_in_future"] = onb > AS_OF
    log("merchants", "onboarding date missing", onb.isna().sum(), "left null")
    log("merchants", "onboarding date after data window", m.onboarding_in_future.sum(), "flagged")

    acct = raw["settlement_account"].str.strip().str.upper()
    m["settlement_account_type"] = np.select(
        [acct.map(is_blank), acct.str.fullmatch(r"X{4}\d{4}"), acct.str.fullmatch(r"\d{9,18}"), acct.str.fullmatch(r"[A-Z]{4}\d{13}")],
        ["MISSING", "MASKED", "ACCOUNT_NUMBER", "VIRTUAL_ACCOUNT"], "INVALID")
    m["settlement_account_last4"] = acct.str[-4:].where(m.settlement_account_type.isin(["MASKED", "ACCOUNT_NUMBER", "VIRTUAL_ACCOUNT"]))
    log("merchants", "settlement account missing ('', NA)", (m.settlement_account_type == "MISSING").sum(), "flagged - payout risk")

    m["merchant_status"] = raw["merchant_status"].map(upper_key).map(MERCHANT_STATUS_MAP).fillna("UNKNOWN")
    log("merchants", "merchant_status variants (Enabled, Live, A, Hold, ...)", len(m), "mapped to ACTIVE/INACTIVE/CLOSED/SUSPENDED/BLOCKED")
    t = raw["declared_avg_ticket_size"].map(parse_amount)
    m["declared_avg_ticket_size"] = [x[0] for x in t]
    m["ticket_size_was_negative"] = [x[1] for x in t]
    log("merchants", "declared ticket size negative", m.ticket_size_was_negative.sum(), "absolute value, flagged")
    m = m[m.merchant_id.notna()]
    allrec = pick_canonical(m, "merchant_id", "onboarding_date", "merchants")
    allrec.to_csv(CLEAN / "merchants_all_records.csv", index=False)
    dim = allrec[allrec.is_canonical].drop(columns=["is_canonical"]).reset_index(drop=True)
    print(f"Merchants: {n0} raw -> {len(allrec)} records -> {len(dim)} merchants")
    return dim


# ================================================================ TRANSACTIONS
def clean_transactions(dim_users, dim_merchants):
    raw = pd.read_csv(ROOT / "track1_upi_transactions.csv", dtype=str, keep_default_na=False)
    n0 = len(raw)
    t = pd.DataFrame(index=raw.index)
    t["txn_id"] = raw["txn_id"].map(norm_txn_id)
    ts, has_time = parse_ts_col(raw["timestamp"])
    t["timestamp"] = ts
    t["has_time"] = has_time
    log("transactions", "timestamp in non-ISO format (DD/MM, MM-DD AM/PM, epoch, date-only)", (~raw["timestamp"].str.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}")).sum(), "parsed with per-format rules")
    log("transactions", "timestamp date-only (no time)", (~has_time).sum(), "kept for daily metrics, excluded from hourly")
    log("transactions", "timestamp unparseable", ts.isna().sum(), "left null")
    t["timestamp_out_of_window"] = ts.notna() & ((ts < DATA_START) | (ts > DATA_END))
    log("transactions", "timestamp outside 2026-01-01..2026-03-31", t.timestamp_out_of_window.sum(), "flagged")
    t["user_id"] = raw["user_id"].map(norm_user_id)
    t["merchant_id"] = raw["merchant_id"].map(norm_merchant_id)
    amt = raw["amount"].map(parse_amount)
    t["amount"] = [x[0] for x in amt]
    t["amount_was_negative"] = [x[1] for x in amt]
    t["amount_invalid"] = pd.Series([x[2] for x in amt], index=t.index) | t["amount"].isna()
    log("transactions", "amount with ₹/Rs./INR/commas", raw["amount"].str.contains(r"[^\d.-]", regex=True).sum(), "parsed to numeric INR")
    log("transactions", "amount negative", t.amount_was_negative.sum(), "treated as sign error -> absolute value, flagged (no refund status exists)")
    log("transactions", "amount blank/invalid", t.amount_invalid.sum(), "kept, excluded from value metrics")

    utr = raw["utr"].str.replace(r"[\s-]", "", regex=True).str.upper()
    t["utr"] = utr.where(utr.str.fullmatch(r"UTR\d{10}"))
    t["utr_status"] = np.select([raw["utr"].map(is_blank), utr.str.fullmatch(r"UTR\d{10}")], ["MISSING", "VALID"], "INVALID")
    log("transactions", "UTR with spaces/hyphens", raw["utr"].str.contains(r"[\s-]", regex=True).sum(), "stripped")
    log("transactions", "UTR missing", (t.utr_status == "MISSING").sum(), "utr_status=MISSING (kept)")
    log("transactions", "UTR invalid format", (t.utr_status == "INVALID").sum(), "utr_status=INVALID (kept)")

    t["status"] = raw["status"].map(upper_key).map(STATUS_MAP).fillna("UNKNOWN")
    log("transactions", "status variants (S, TXN_SUCCESS, Declined, Initiated...)", len(t), "mapped to SUCCESS/FAILED/PENDING")
    t["status_raw"] = raw["status"]

    # ---- duplicates (after normalization so format-only differences are caught)
    key_cols = ["txn_id", "timestamp", "user_id", "merchant_id", "amount", "utr", "status"]
    exact = t.duplicated(key_cols)
    dup_amount = t.loc[exact, "amount"].sum()
    t = t[~exact]
    log("transactions", "duplicate transaction rows", exact.sum(), f"removed (would inflate value by INR {dup_amount:,.0f})")
    iddup = t.duplicated("txn_id")
    t = t[~iddup]
    log("transactions", "same txn_id with different content", iddup.sum(), "removed (kept first)")

    mcc = raw.loc[t.index, "mcc"].map(parse_mcc)
    master_mcc = t["merchant_id"].map(dim_merchants.set_index("merchant_id")["mcc"])
    t["mcc"] = mcc.fillna(master_mcc).astype("Int64")
    t["mcc_source"] = np.select([mcc.notna(), master_mcc.notna()], ["txn_field", "merchant_master"], "unknown")
    log("transactions", "MCC blank", mcc.isna().sum(), f"filled from merchant master where linked ({(mcc.isna() & master_mcc.notna()).sum()}), else Unknown")
    t["merchant_category"] = t["mcc"].map(lambda x: MCC_CATEGORY.get(x) if pd.notna(x) else "Unknown")
    t["mcc_conflicts_master"] = mcc.notna() & master_mcc.notna() & (mcc != master_mcc)
    log("transactions", "txn MCC differs from merchant master MCC", t.mcc_conflicts_master.sum(), "txn MCC kept (point-in-time), flagged")

    t["user_in_kyc"] = t["user_id"].isin(dim_users["user_id"])
    t["merchant_in_master"] = t["merchant_id"].isin(dim_merchants["merchant_id"])
    log("transactions", "user_id not found in KYC (orphan FK)", (~t.user_in_kyc).sum(), "kept; kyc_status = NO_KYC_RECORD")
    log("transactions", "merchant_id not found in merchant master (orphan FK)", (~t.merchant_in_master).sum(), "kept; category from txn MCC")
    t["utr_duplicated"] = t["utr"].notna() & t.duplicated("utr", keep=False)
    log("transactions", "same UTR reused across different txn_ids", t.utr_duplicated.sum(), "flagged")
    t["txn_date"] = t["timestamp"].dt.normalize()
    t["txn_hour"] = t["timestamp"].dt.hour.where(t["has_time"]).astype("Int64")
    print(f"Transactions: {n0} raw -> {len(t)}")
    return t.reset_index(drop=True)


# ================================================================ CHARGEBACKS
def clean_chargebacks(txn, dim_users, dim_merchants):
    raw = pd.DataFrame(json.loads((ROOT / "track1_chargebacks.json").read_text(encoding="utf-8")))
    n0 = len(raw)
    exact = raw.astype(str).duplicated()
    raw = raw[~exact]
    log("chargebacks", "exact duplicate complaints", exact.sum(), "removed")
    iddup = raw["complaint_id"].str.upper().duplicated()
    raw = raw[~iddup]
    log("chargebacks", "duplicate complaint_id with differing content", iddup.sum(), "removed (kept first)")

    c = pd.DataFrame(index=raw.index)
    c["complaint_id"] = raw["complaint_id"].str.strip().str.upper()
    c["txn_id"] = raw["txn_id"].map(norm_txn_id)
    tx = txn.set_index("txn_id")
    linked = c["txn_id"].isin(tx.index)
    c["link_status"] = np.select([raw["txn_id"].map(is_blank), linked], ["MISSING_TXN_ID", "LINKED"], "TXN_NOT_FOUND")
    log("chargebacks", "txn_id format variants (TXN-, short TXN#####)", (raw["txn_id"].astype(str) != c["txn_id"]).sum(), "normalized to TXN########")
    log("chargebacks", "txn_id missing", (c.link_status == "MISSING_TXN_ID").sum(), "kept, excluded from ratio numerators")
    log("chargebacks", "txn_id not found in transactions (orphan FK)", (c.link_status == "TXN_NOT_FOUND").sum(), "kept, excluded from ratio numerators")

    c["reported_user_id"] = raw["user_id"].map(norm_user_id)
    c["reported_merchant_id"] = raw["merchant_id"].map(norm_merchant_id)
    c["user_id"] = c["txn_id"].map(tx["user_id"]).where(linked, c["reported_user_id"])
    c["merchant_id"] = c["txn_id"].map(tx["merchant_id"]).where(linked, c["reported_merchant_id"])
    c["user_mismatch"] = linked & (c["reported_user_id"] != c["user_id"])
    c["merchant_mismatch"] = linked & (c["reported_merchant_id"] != c["merchant_id"])
    log("chargebacks", "user_id format variants", (raw["user_id"].astype(str) != c["reported_user_id"]).sum(), "standardized to USR#####")
    log("chargebacks", "complaint user_id differs from linked transaction's user", c.user_mismatch.sum(), "transaction is source of truth for attribution; reported IDs retained")
    log("chargebacks", "complaint merchant_id differs from linked transaction's merchant", c.merchant_mismatch.sum(), "transaction is source of truth for attribution; reported IDs retained")

    txn_amt = c["txn_id"].map(tx["amount"])
    a = raw["disputed_amount"].map(parse_amount)
    amt = pd.Series([x[0] for x in a], index=c.index)
    c["disputed_amount_imputed"] = amt.isna() & txn_amt.notna()
    c["disputed_amount"] = amt.fillna(txn_amt)
    c["disputed_amount_was_negative"] = [x[1] for x in a]
    c["txn_amount"] = txn_amt
    c["dispute_exceeds_txn"] = c["disputed_amount"] > txn_amt + 0.01
    log("chargebacks", "disputed amount with ₹/Rs./INR/commas (string)", raw["disputed_amount"].map(lambda v: isinstance(v, str) and bool(re.search(r"[^\d.\-]", v))).sum(), "parsed to numeric INR")
    log("chargebacks", "disputed amount blank", amt.isna().sum(), f"imputed with linked txn amount ({c.disputed_amount_imputed.sum()}), else null")
    log("chargebacks", "disputed amount negative", c.disputed_amount_was_negative.sum(), "absolute value, flagged")
    log("chargebacks", "disputed amount exceeds transaction amount", c.dispute_exceeds_txn.sum(), "flagged (possible over-claim)")

    # Delay anchor: the complaint's own transaction_timestamp (what the customer disputed). Using the
    # linked txn timestamp instead makes 1,057 complaints "reported before the payment" vs 60 with this
    # anchor, so the complaint log is the more consistent clock. Fallback to linked txn when blank.
    cb_txn_ts, _ = parse_ts_col(raw["transaction_timestamp"])
    linked_ts = c["txn_id"].map(tx["timestamp"])
    c["linked_txn_timestamp"] = linked_ts
    c["transaction_timestamp"] = cb_txn_ts.fillna(linked_ts)
    c["complaint_txn_ts_differs"] = linked & cb_txn_ts.notna() & ((cb_txn_ts.dt.normalize() - linked_ts.dt.normalize()).abs() > pd.Timedelta(days=1))
    c["reported_timestamp"], _ = parse_ts_col(raw["reported_timestamp"])
    c["bank_response_timestamp"], _ = parse_ts_col(raw["bank_response_timestamp"])
    log("chargebacks", "complaint transaction_timestamp missing", cb_txn_ts.isna().sum(), f"filled from linked transaction ({(cb_txn_ts.isna() & linked_ts.notna()).sum()})")
    delay = (c["reported_timestamp"] - c["transaction_timestamp"]).dt.total_seconds() / 86400
    c["reported_before_txn"] = delay < -1          # date-only values can legitimately sit <1 day earlier
    c["reporting_delay_days"] = delay.where(~c["reported_before_txn"]).clip(lower=0).round(2)
    resp = (c["bank_response_timestamp"] - c["reported_timestamp"]).dt.total_seconds() / 86400
    c["response_before_report"] = resp < -1
    c["bank_response_days"] = resp.where(~c["response_before_report"]).clip(lower=0).round(2)
    log("chargebacks", "complaint's transaction date differs from linked txn by >1 day", c.complaint_txn_ts_differs.sum(), "complaint date used for delay; linked_txn_timestamp retained")
    log("chargebacks", "reported timestamp missing", c.reported_timestamp.isna().sum(), "delay left null")
    log("chargebacks", "complaint reported before transaction (impossible)", c.reported_before_txn.sum(), "delay nulled, flagged")
    log("chargebacks", "bank response before complaint (impossible)", c.response_before_report.sum(), "response time nulled, flagged")

    c["reason_code_raw"] = raw["reason_code"]
    c["reason_category"] = raw["reason_code"].astype(str).str.strip().str.lower().map(REASON_MAP).fillna("OTHER")
    c["is_fraud_reason"] = c["reason_category"].isin(FRAUD_REASONS)
    log("chargebacks", "reason_code variants (34 spellings)", len(c), "mapped to 8 reason categories")
    text = raw["complaint_text"].astype(str).str.strip()
    c["complaint_text_note"] = text.str.extract(r"(call dropped|pls check asap|urgent)\s*$", flags=re.IGNORECASE)[0].str.lower()
    t2 = (text.str.replace(r"\s*(call dropped|pls check asap|urgent|NA)\s*$", "", regex=True, flags=re.IGNORECASE)
              .str.replace(r"\bcust\b", "customer", regex=True, flags=re.IGNORECASE)
              .str.replace(r"\btxn\b", "transaction", regex=True, flags=re.IGNORECASE))
    c["complaint_text"] = t2.str.lower().str.capitalize().str.replace(r"\bupi pin\b", "UPI PIN", regex=True)
    log("chargebacks", "complaint text case/abbreviation/trailing-noise variants", (text != c["complaint_text"]).sum(), "normalized; trailing notes moved to complaint_text_note")
    c["severity"] = raw["severity"].map(upper_key).map(SEVERITY_MAP).fillna("UNKNOWN")
    c["resolution_status"] = raw["resolution_status"].map(upper_key).map(RESOLUTION_MAP).fillna("UNKNOWN")
    c["is_open"] = c["resolution_status"].isin(["OPEN", "IN_PROGRESS", "PENDING_BANK"])
    c["channel"] = raw["channel"].map(upper_key).map(CHANNEL_MAP).fillna("Unknown")
    log("chargebacks", "severity (P1..P4, H/M/L, CRIT) / resolution / channel variants", len(c), "mapped to canonical enums")
    c["txn_status"] = c["txn_id"].map(tx["status"])
    c["merchant_category"] = c["txn_id"].map(tx["merchant_category"]).where(linked, c["merchant_id"].map(dim_merchants.set_index("merchant_id")["merchant_category"]))
    c["merchant_category"] = c["merchant_category"].fillna("Unknown")
    print(f"Chargebacks: {n0} raw -> {len(c)}  (linked {linked.sum()})")
    return c.reset_index(drop=True)


def main():
    users = clean_kyc()
    merchants = clean_merchants()
    txn = clean_transactions(users, merchants)
    cb = clean_chargebacks(txn, users, merchants)

    # conformed attributes on the fact tables
    txn = txn.merge(users[["user_id", "kyc_status", "risk_segment"]], on="user_id", how="left")
    txn[["kyc_status", "risk_segment"]] = txn[["kyc_status", "risk_segment"]].fillna("NO_KYC_RECORD")
    cbt = cb[cb.link_status == "LINKED"].groupby("txn_id").agg(chargeback_count=("complaint_id", "size"), disputed_amount=("disputed_amount", "sum"))
    txn = txn.merge(cbt, left_on="txn_id", right_index=True, how="left")
    txn["chargeback_count"] = txn["chargeback_count"].fillna(0).astype(int)
    txn["is_disputed"] = txn["chargeback_count"] > 0
    cb = cb.merge(users[["user_id", "kyc_status", "risk_segment"]], on="user_id", how="left")
    cb[["kyc_status", "risk_segment"]] = cb[["kyc_status", "risk_segment"]].fillna("NO_KYC_RECORD")

    users.to_csv(CLEAN / "dim_users.csv", index=False)
    merchants.to_csv(CLEAN / "dim_merchants.csv", index=False)
    txn.to_csv(CLEAN / "fact_transactions.csv", index=False)
    cb.to_csv(CLEAN / "fact_chargebacks.csv", index=False)
    q = pd.DataFrame(QUALITY)
    q.to_csv(OUT / "data_quality_report.csv", index=False)

    db_path = OUT / "upi_analytics.db"
    db_path.unlink(missing_ok=True)
    db = sqlite3.connect(db_path)
    for name, df in [("dim_users", users), ("dim_merchants", merchants), ("fact_transactions", txn), ("fact_chargebacks", cb), ("data_quality_report", q)]:
        d = df.copy()
        for col in d.columns:
            if str(d[col].dtype).startswith("datetime"):
                d[col] = d[col].dt.strftime("%Y-%m-%d %H:%M:%S")
            elif str(d[col].dtype) in ("Int64", "boolean"):
                d[col] = d[col].astype(object).where(d[col].notna(), None)
            elif d[col].dtype == object:
                d[col] = d[col].map(lambda v: None if v is None or (isinstance(v, float) and np.isnan(v)) else str(v))
        d.to_sql(name, db, index=False)
    db.executescript("""
    CREATE INDEX ix_txn_user ON fact_transactions(user_id);
    CREATE INDEX ix_txn_merch ON fact_transactions(merchant_id);
    CREATE INDEX ix_cb_txn ON fact_chargebacks(txn_id);
    CREATE UNIQUE INDEX ix_users ON dim_users(user_id);
    CREATE UNIQUE INDEX ix_merch ON dim_merchants(merchant_id);
    CREATE VIEW v_merchant_risk AS
      SELECT t.merchant_id, t.merchant_category, COUNT(*) AS txn_count, SUM(t.amount) AS txn_amount,
             SUM(t.chargeback_count) AS chargeback_count, SUM(COALESCE(t.disputed_amount,0)) AS disputed_amount,
             1.0*SUM(t.is_disputed)/COUNT(*) AS chargeback_to_txn_ratio
      FROM fact_transactions t GROUP BY t.merchant_id, t.merchant_category;
    CREATE VIEW v_category_disputes AS
      SELECT merchant_category, COUNT(*) AS txn_count, SUM(is_disputed) AS disputed_txns,
             1.0*SUM(is_disputed)/COUNT(*) AS dispute_rate, SUM(COALESCE(disputed_amount,0)) AS disputed_amount
      FROM fact_transactions GROUP BY merchant_category;
    """)
    db.commit()
    db.close()
    pd.set_option("display.width", 250, "display.max_colwidth", 90)
    print(q.to_string())


if __name__ == "__main__":
    main()
