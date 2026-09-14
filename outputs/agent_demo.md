# Graph agent – example queries
Property graph: 72,324 nodes / 106,406 edges (User, Transaction, Merchant, Category, Chargeback, Reason, KycStatus).

## Q: Show daily transaction volume trend.

**Daily transaction volume, 2026-01-01 → 2026-03-31** (90 days)

`▃▁▁▃▁▄▂▄▅▇▄▇▅▆▅▂▂▄▂▃▂▃▁▁▁▃▄▅▃▆▅▃▃▁▃▂▆▆▃▁▅▆▄▃▅▂▃▇▄▁▄▂▂▄▃▆▂▃▄▄▂▃▆▆▄▅▆▆▅▂▅▆▃▂▇▂▅▃▅▄▁▁▃▂▂▄▁▁▂▅`

Mean 222/day · min 198 · max 254

| Week of | Days | Txns | Txns/day | Value |
|---|---|---|---|---|
| 2026-01-01 | 4 | 834 | 208 | ₹1.05 Cr |
| 2026-01-05 | 7 | 1,582 | 226 | ₹1.98 Cr |
| 2026-01-12 | 7 | 1,612 | 230 | ₹2.02 Cr |
| 2026-01-19 | 7 | 1,471 | 210 | ₹1.84 Cr |
| 2026-01-26 | 7 | 1,581 | 226 | ₹1.93 Cr |
| 2026-02-02 | 7 | 1,549 | 221 | ₹1.89 Cr |
| 2026-02-09 | 7 | 1,569 | 224 | ₹2.00 Cr |
| 2026-02-16 | 7 | 1,546 | 221 | ₹1.92 Cr |
| 2026-02-23 | 7 | 1,573 | 225 | ₹1.97 Cr |
| 2026-03-02 | 7 | 1,619 | 231 | ₹2.00 Cr |
| 2026-03-09 | 7 | 1,582 | 226 | ₹1.97 Cr |
| 2026-03-16 | 7 | 1,566 | 224 | ₹1.99 Cr |
| 2026-03-23 | 7 | 1,473 | 210 | ₹1.88 Cr |
| 2026-03-30 | 2 | 443 | 222 | ₹54.44 L |


## Q: Show total transaction amount by merchant category.

**Total transaction amount by merchant category**

| Category | Txns | Amount | Share |
|---|---|---|---|
| Grocery | 5,838 | ₹7.37 Cr | 29.5% |
| Pharmacy | 3,013 | ₹3.70 Cr | 14.8% |
| Hotels & Lodging | 2,962 | ₹3.70 Cr | 14.8% |
| Transportation | 2,972 | ₹3.70 Cr | 14.8% |
| Restaurants | 2,991 | ₹3.69 Cr | 14.8% |
| Unknown | 1,516 | ₹1.98 Cr | 7.9% |
| Department Stores | 155 | ₹19.57 L | 0.8% |
| Books & Stationery | 145 | ₹18.29 L | 0.7% |
| Apparel | 147 | ₹16.77 L | 0.7% |
| Misc Retail | 132 | ₹15.71 L | 0.6% |
| Telecom | 129 | ₹13.86 L | 0.6% |


## Q: Compare successful vs failed transactions by day.

**Successful vs failed transactions** (weekly roll-up of daily counts; failed-rate sparkline is daily)

`▃▄▃▃▃▇▁▃▂▃▃▂▂▂▃▃▄▂▃▂▁▂▄▃▁▅▄▄▃▂▄▂▂▅▃▃▅▃▅▃▃▄▄▅▅▅▃▄▄▄▁▃▂▅▃▅▄▂▃▁▆▃▂▂▃▂▁▂▄▄▁▅▄▁▄▄▄▄▄▄▅▂▃▃▄▃▃▃▄▂`

| Week of | Success | Failed | Pending | Failed rate |
|---|---|---|---|---|
| 2026-01-01 | 714 | 84 | 36 | 10.1% |
| 2026-01-05 | 1354 | 157 | 71 | 9.9% |
| 2026-01-12 | 1398 | 144 | 70 | 8.9% |
| 2026-01-19 | 1263 | 122 | 86 | 8.3% |
| 2026-01-26 | 1342 | 158 | 81 | 10.0% |
| 2026-02-02 | 1306 | 163 | 80 | 10.5% |
| 2026-02-09 | 1317 | 175 | 77 | 11.2% |
| 2026-02-16 | 1319 | 148 | 79 | 9.6% |
| 2026-02-23 | 1338 | 156 | 79 | 9.9% |
| 2026-03-02 | 1366 | 149 | 104 | 9.2% |
| 2026-03-09 | 1371 | 148 | 63 | 9.4% |
| 2026-03-16 | 1312 | 169 | 85 | 10.8% |
| 2026-03-23 | 1270 | 138 | 65 | 9.4% |
| 2026-03-30 | 383 | 44 | 16 | 9.9% |


## Q: Which merchant has the highest chargeback count?

**MCH9572** has the highest chargeback count (5, ₹23,982 disputed).

| Merchant | Name | Category | Txns | Chargebacks | Disputed | CB/txn | Fraud-type |
|---|---|---|---|---|---|---|---|
| MCH9572 | (not in master) | Unknown | 4 | 5 | ₹23,982 | 50% | 3 |
| MCH5530 | (not in master) | Pharmacy | 4 | 4 | ₹15,775 | 75% | 3 |
| MCH3587 | Sagar-Raval | Hotels & Lodging | 5 | 4 | ₹10,230 | 60% | 2 |
| MCH3478 | (not in master) | Grocery | 3 | 3 | ₹31,214 | 67% | 1 |
| MCH6858 | (not in master) | Grocery | 3 | 3 | ₹23,194 | 67% | 0 |
| MCH8540 | Tiwari Ltd | Grocery | 3 | 3 | ₹22,249 | 33% | 2 |
| MCH7697 | (not in master) | Restaurants | 8 | 3 | ₹21,530 | 25% | 0 |
| MCH3285 | Prasad, Luthra and Suri | Transportation | 5 | 3 | ₹19,560 | 60% | 0 |
| MCH6538 | (not in master) | Grocery | 4 | 3 | ₹17,815 | 50% | 1 |
| MCH5097 | Sathe Inc | Hotels & Lodging | 3 | 3 | ₹17,476 | 33% | 2 |


## Q: Which merchant category has the highest disputed amount?

**Grocery** has the highest disputed amount: ₹29.38 L across 759 chargebacks.

| Category | Chargebacks | Disputed | CB/txn ratio | Txns |
|---|---|---|---|---|
| Grocery | 759 | ₹29.38 L | 12.4% | 5,838 |
| Restaurants | 404 | ₹15.16 L | 12.8% | 2,991 |
| Transportation | 434 | ₹14.99 L | 13.4% | 2,972 |
| Pharmacy | 374 | ₹12.95 L | 11.5% | 3,013 |
| Hotels & Lodging | 361 | ₹12.90 L | 11.6% | 2,962 |
| Unknown | 181 | ₹6.11 L | 11.2% | 1,516 |
| Apparel | 28 | ₹1.68 L | 17.0% | 147 |
| Department Stores | 21 | ₹88,416 | 13.5% | 155 |
| Misc Retail | 21 | ₹55,469 | 13.6% | 132 |
| Telecom | 12 | ₹49,098 | 9.3% | 129 |
| Books & Stationery | 12 | ₹24,230 | 8.3% | 145 |


## Q: Show chargeback reason distribution.

**Chargeback reason distribution** (2,800 complaints; fraud-type = 37.2%)

| Reason | Complaints | Share | Disputed |
|---|---|---|---|
| GENERAL_DISPUTE | 376 | 13.4% | ₹14.18 L |
| NOT_DELIVERED | 375 | 13.4% | ₹13.35 L |
| UNAUTHORIZED_TXN ⚑ | 371 | 13.2% | ₹14.04 L |
| DUPLICATE_DEBIT | 352 | 12.6% | ₹12.32 L |
| ACCOUNT_TAKEOVER ⚑ | 344 | 12.3% | ₹11.07 L |
| SERVICE_NOT_PROVIDED | 329 | 11.8% | ₹12.08 L |
| FRAUD_SUSPECTED ⚑ | 327 | 11.7% | ₹12.30 L |
| WRONG_AMOUNT | 326 | 11.6% | ₹11.39 L |


## Q: Show top 10 users by disputed amount.

**Top 10 users by disputed amount**

| User | Name | KYC | Txns | Chargebacks | Disputed | Fraud-type |
|---|---|---|---|---|---|---|
| USR57633 | (no KYC record) | NO_KYC_RECORD | 1 | 1 | ₹44,047 | 0 |
| USR21423 | (no KYC record) | NO_KYC_RECORD | 1 | 1 | ₹41,458 | 1 |
| USR65475 | Caleb Lata | VERIFIED | 2 | 2 | ₹37,318 | 2 |
| USR64018 | Warinder Verma | VERIFIED | 1 | 1 | ₹36,675 | 1 |
| USR58627 | (no KYC record) | NO_KYC_RECORD | 2 | 4 | ₹34,493 | 3 |
| USR50629 | (no KYC record) | NO_KYC_RECORD | 1 | 1 | ₹33,976 | 0 |
| USR57502 | (no KYC record) | NO_KYC_RECORD | 1 | 2 | ₹30,866 | 0 |
| USR16089 | Matthew Baral | VERIFIED | 1 | 2 | ₹29,841 | 1 |
| USR19722 | Balvan Sengupta | VERIFIED | 1 | 1 | ₹27,331 | 0 |
| USR14076 | Lopa Arya | VERIFIED | 1 | 2 | ₹27,003 | 1 |


## Q: Show average transaction value trend over time.

**Average transaction value by week**

`▅▄▄▄▁▁▇▃▅▃▃▆▇▁`

| Week of | Txns | Avg value |
|---|---|---|
| 2026-01-01 | 834 | ₹12,554 |
| 2026-01-05 | 1,582 | ₹12,505 |
| 2026-01-12 | 1,612 | ₹12,506 |
| 2026-01-19 | 1,471 | ₹12,515 |
| 2026-01-26 | 1,581 | ₹12,212 |
| 2026-02-02 | 1,549 | ₹12,216 |
| 2026-02-09 | 1,569 | ₹12,720 |
| 2026-02-16 | 1,546 | ₹12,445 |
| 2026-02-23 | 1,573 | ₹12,544 |
| 2026-03-02 | 1,619 | ₹12,373 |
| 2026-03-09 | 1,582 | ₹12,422 |
| 2026-03-16 | 1,566 | ₹12,677 |
| 2026-03-23 | 1,473 | ₹12,772 |
| 2026-03-30 | 443 | ₹12,288 |


## Q: Which KYC status has the highest transaction amount?

**NO_KYC_RECORD** carries the highest transaction amount (₹16.95 Cr). Among users that do have a KYC record, **VERIFIED** is highest (₹6.19 Cr).

| KYC status | Transacting users | Txns | Amount | Dispute rate |
|---|---|---|---|---|
| NO_KYC_RECORD | 12,079 | 13,522 | ₹16.95 Cr | 11.9% |
| VERIFIED | 4,454 | 4,978 | ₹6.19 Cr | 13.2% |
| PENDING | 543 | 615 | ₹75.39 L | 8.9% |
| REJECTED | 481 | 521 | ₹61.98 L | 15.0% |
| IN_REVIEW | 321 | 364 | ₹45.84 L | 14.0% |


## Q: Compare chargebacks by severity level.

**Chargebacks by severity level**

| Severity | Complaints | Disputed | Still open | Fraud-type | Mean delay |
|---|---|---|---|---|---|
| CRITICAL | 213 | ₹8.58 L | 57% | 39% | 8.6 d |
| HIGH | 604 | ₹20.09 L | 53% | 41% | 7.6 d |
| MEDIUM | 1024 | ₹36.78 L | 54% | 36% | 7.8 d |
| LOW | 959 | ₹35.27 L | 52% | 36% | 8.3 d |


## Q: Show disputes reported after 7 days.

**666 disputes were reported more than 7 days after the payment** (most common reason: UNAUTHORIZED_TXN). Longest 12:

| Complaint | Merchant | Reason | Severity | Disputed | Delay | Status |
|---|---|---|---|---|---|---|
| CBK0001281 | MCH6651 | WRONG_AMOUNT | MEDIUM | ₹18,360 | 100 d | REJECTED |
| CBK0001124 | MCH5118 | DUPLICATE_DEBIT | MEDIUM | ₹5,695 | 98 d | PENDING_BANK |
| CBK0000237 | MCH5896 | NOT_DELIVERED | LOW | ₹1,644 | 95 d | PENDING_BANK |
| CBK0001029 | MCH4045 | DUPLICATE_DEBIT | MEDIUM | ₹1,638 | 91 d | OPEN |
| CBK0000408 | MCH2897 | DUPLICATE_DEBIT | HIGH | ₹2,927 | 89 d | IN_PROGRESS |
| CBK0000951 | MCH5253 | NOT_DELIVERED | LOW | ₹1,302 | 84 d | CLOSED |
| CBK0000031 | MCH5416 | DUPLICATE_DEBIT | LOW | ₹373 | 83 d | RESOLVED |
| CBK0002427 | MCH4055 | WRONG_AMOUNT | LOW | ₹2,122 | 78 d | PENDING_BANK |
| CBK0000741 | MCH4059 | WRONG_AMOUNT | MEDIUM | ₹448 | 78 d | OPEN |
| CBK0000101 | MCH3632 | DUPLICATE_DEBIT | LOW | ₹3,506 | 73 d | IN_PROGRESS |
| CBK0000579 | MCH5925 | WRONG_AMOUNT | CRITICAL | ₹2,180 | 73 d | CLOSED |
| CBK0001644 | MCH6727 | NOT_DELIVERED | LOW | ₹8,373 | 73 d | REJECTED |


## Q: Which merchant has the highest chargeback-to-transaction ratio?

**MCH1744** has the highest chargeback-to-transaction ratio (100% of 3 payments disputed). Merchants with fewer than 3 payments are excluded so one dispute on one payment does not read as 100%.

| Merchant | Name | Category | Txns | Chargebacks | Disputed | CB/txn | Fraud-type |
|---|---|---|---|---|---|---|---|
| MCH1744 | Mani, Tara and Mane | Grocery | 3 | 3 | ₹3,299 | 100% | 2 |
| MCH3549 | Khalsa and Sons | Hotels & Lodging | 3 | 3 | ₹5,137 | 100% | 2 |
| MCH5278 | Sarraf, Peri and Ratti | Grocery | 3 | 3 | ₹6,304 | 100% | 0 |
| MCH5530 | (not in master) | Pharmacy | 4 | 4 | ₹15,775 | 75% | 3 |
| MCH4243 | Ramesh, Venkatesh and Ravel | Department Stores | 4 | 3 | ₹15,583 | 75% | 2 |
| MCH4067 | (not in master) | Grocery | 4 | 3 | ₹8,373 | 75% | 1 |
| MCH6678 | (not in master) | Transportation | 4 | 3 | ₹10,587 | 75% | 2 |
| MCH1508 | (not in master) | Hotels & Lodging | 4 | 3 | ₹5,140 | 75% | 1 |
| MCH3548 | Bhakta, Dhaliwal and Comar | Transportation | 3 | 3 | ₹14,355 | 67% | 0 |
| MCH6095 | Sahota, Misra and Kata | Hotels & Lodging | 3 | 3 | ₹3,415 | 67% | 1 |


## Q: Find suspicious fraud rings in the payment graph.

**121 suspicious clusters** (connected components of ≥4 dispute-touched users/merchants). Top 8:

| Users | Merchants | Chargebacks | Fraud-type | Disputed | Unverified users |
|---|---|---|---|---|---|
| 6 | MCH1366 MCH3712 MCH5530 MCH6414 | 8 | 4 | ₹19,639 | 4 |
| 6 | MCH1949 MCH3208 MCH5909 MCH6838 MCH7269 | 7 | 2 | ₹18,891 | 5 |
| 3 | MCH5128 MCH5134 MCH9506 | 5 | 3 | ₹20,025 | 3 |
| 4 | MCH1991 MCH4395 MCH8851 | 5 | 2 | ₹29,879 | 3 |
| 4 | MCH4243 MCH9044 | 4 | 3 | ₹15,851 | 3 |
| 3 | MCH6924 MCH8358 | 4 | 3 | ₹10,135 | 2 |
| 4 | MCH6858 MCH7800 MCH9219 | 5 | 1 | ₹30,789 | 3 |
| 3 | MCH1209 MCH9941 | 3 | 3 | ₹5,551 | 3 |


## Q: Tell me about MCH9572.

**MCH9572** · not in merchant master · status None · Unknown

- 4 payments worth ₹22,507
- 5 chargebacks (3 fraud-type), ₹23,982 disputed, CB/txn 50%
- Paying users: USR25593, USR39114, USR61630, USR95217
- Other merchants those users also paid: —
