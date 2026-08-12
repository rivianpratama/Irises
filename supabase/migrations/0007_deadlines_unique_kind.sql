-- Make a deal's deadline singular per kind, so its 48h reminder stops duplicating.
--
-- The bug: upsertDeadline (misnamed) did a plain INSERT, minting a fresh deadline id every
-- time promoteDeadlines ran. Because the Autonome reminder's dedupe key is derived as
-- `${deadline.id}|48h`, a fresh id defeated the dedupe: every contract document that re-stated
-- the same deadline (offer -> counter -> addendum -> executed) created ANOTHER 48h automation,
-- all with the same fire time. The runner then fired them all in one tick — the user saw the
-- same "inspection deadline in 48h" reminder several times at once.
--
-- Fix (app side): upsertDeadline now upserts on (deal_id, kind), keeping a stable id. This
-- migration (1) collapses the duplicate deadline rows that already accumulated and (2) adds the
-- unique index that makes the app-side upsert race-proof.
--
-- Apply with: supabase db push   (or paste into the SQL editor). Idempotent; run in one txn.

-- 1. Collapse duplicate deadlines, keeping the most-recently-created row per (deal_id, kind).
--    Deleting a duplicate cascades (0001_init deadlines FKs are ON DELETE CASCADE) to its child
--    48h automation — which is exactly the duplicate reminder we want to purge. The auto-generated
--    48h reminder is the ONLY automation that ever carries a deadline_id (no user/convo/ops path
--    stamps one), so the cascade cannot destroy a user-created reminder.
with ranked as (
  select id,
         row_number() over (partition by deal_id, kind order by created_at desc, id desc) as rn
    from deadlines
)
delete from deadlines
 where id in (select id from ranked where rn > 1);

-- 2. Enforce one deadline per (deal_id, kind) going forward so upsertDeadline keeps a stable id.
--    (Full uniqueness is safe here: promoteDeadlines emits exactly one row per kind and never
--    marks a deadline completed, and re-promotion never resets completed — so a completed deadline
--    is simply updated in place, not paired with a second open one.)
create unique index if not exists uq_deadlines_deal_kind on deadlines(deal_id, kind);
