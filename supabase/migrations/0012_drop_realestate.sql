-- 0012 — Drop the real-estate domain layer.
--
-- The assistant was generalized from a real-estate multi-agent build into a domain-neutral
-- "do-anything" assistant. The full multi-agent architecture is kept; only the real-estate
-- deal/contract/property/contact tables + enums + the reminder-claim RPC are retired here.
--
-- Additive migration — 0001 is left untouched. Order + cascade so FK dependents drop cleanly
-- (reminders/deadlines/contract_facts/deal_parties reference deals; deal_parties references
-- contacts; deals references properties).
--
-- KEPT (generic tables, not touched): chats, messages, user_profiles, agent_memory,
-- sent_messages, token_usage, automations, diagnostic_turns, emails, the memory tiers,
-- reflexion state, gmail_oauth_tokens, oauth_state, workflows.

drop table if exists reminders, deadlines, contract_facts, deal_parties, deals, contacts, properties cascade;

drop type if exists deal_status, deal_side, contact_role, deadline_kind, reminder_status cascade;

-- The reminder-claim RPC (defined in 0001) fed the retired reminders table; the Autonome
-- automations runner replaced it long ago.
drop function if exists claim_due_reminders(int);
