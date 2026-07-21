---
name: BRAC HR daily stats aggregation
description: Admin dashboard reads pre-aggregated DailyStats day partitions instead of table scans; table + IAM must exist in AWS.
---

The admin insights endpoint reads a date-bucketed `<prefix>DailyStats` DynamoDB table (PK `day` YYYY-MM-DD UTC, SK `sk`: `totals` counters, `q#<normalized>` per-question counts, `e#<ts>#<id>` no-result/thumbs-down events). Stats are written fire-and-forget on chat and feedback events.

**Why:** table scans over Messages/Feedback got slow and were truncated at 20k items; day-partition queries are bounded and exact.

**How to apply:**
- DynamoDB tables are provisioned out-of-band in AWS — the `DailyStats` table must be created manually (PK `day` S, SK `sk` S), and the app role needs `dynamodb:Query/UpdateItem/PutItem` on it.
- The insights route falls back to the legacy scan only while DailyStats is empty for the window; history from before this feature shipped never appears in aggregated counts unless backfilled.
- Any new dashboard metric must get its own write hook + record shape here; it cannot be derived retroactively.
- New persisted record types should reuse this table under a synthetic non-date partition key rather than provisioning another table (tables + IAM are managed out-of-band in AWS and easy to forget). Audit-style writes must be transactional with the mutation they record — best-effort audit writes were rejected in review.
