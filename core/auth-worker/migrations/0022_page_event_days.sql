-- THE DAY'S BUDGET OF THE PAGE RECORDS FROM OUTSIDE (src/page-events.ts `outsideReserved`): how
-- many records from anyone who is no member the mind took on one UTC day, at most 5,000. A batch
-- reserves its records in the one statement that adds them, so two batches at once are counted
-- one after the other. Rows of days before yesterday are deleted as a batch is counted.
create table page_event_days (
  -- the UTC day, `YYYY-MM-DD`
  day text primary key,
  records integer not null
);
