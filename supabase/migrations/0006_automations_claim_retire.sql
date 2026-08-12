-- Make one-time automations fire AT MOST ONCE.
--
-- The original claim_due_automations (0005) only set claimed_at and left status
-- 'active'; the runner marked a one-time row 'done' AFTER sending. If that later
-- write failed (or the send threw after delivering), the row stayed 'active' and
-- re-fired once the 10-minute lease lapsed — the user saw the same reminder again
-- and again.
--
-- Fix: retire a one-time row in the SAME atomic UPDATE that claims it. Once a row is
-- handed to the runner it is already 'done', so nothing downstream can resurrect it.
-- Recurring (cron) rows are unchanged: they just take the lease and the runner
-- advances them to their next occurrence after a successful send.
create or replace function claim_due_automations(p_limit int default 10)
returns setof automations as $$
  update automations a
     set claimed_at = now(),
         status      = case when a.schedule_kind = 'once' then 'done'::automation_status else a.status end,
         last_run_at = case when a.schedule_kind = 'once' then now() else a.last_run_at end,
         run_count   = case when a.schedule_kind = 'once' then a.run_count + 1 else a.run_count end
   where a.id in (
     select id from automations
      where status = 'active'
        and next_run_at <= now()
        and (claimed_at is null or claimed_at < now() - interval '10 minutes')
      order by next_run_at
      limit p_limit
      for update skip locked
   )
  returning a.*;
$$ language sql;
