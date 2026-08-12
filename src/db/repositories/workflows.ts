import { randomUUID } from 'node:crypto';
import { getSupabase, logDbError } from '../client.js';
import { mem } from '../memory.js';
import type { Workflow, WorkflowKind, WorkflowStatus } from '../types.js';

function rowToWorkflow(r: any): Workflow {
  return {
    id: r.id,
    agentHandle: r.agent_handle,
    chatId: r.chat_id ?? null,
    kind: r.kind,
    status: r.status,
    dealId: r.deal_id ?? null,
    state: r.state ?? {},
  };
}

export async function getActiveWorkflow(handle: string, kind: WorkflowKind): Promise<Workflow | null> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase.from('workflows').select('*')
        .eq('agent_handle', handle).eq('kind', kind)
        .not('status', 'in', '("done","cancelled")')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data ? rowToWorkflow(data) : null;
    } catch (error) {
      logDbError('getActiveWorkflow', error);
    }
  }
  return [...mem.workflows.values()]
    .find(w => w.agentHandle === handle && w.kind === kind && w.status !== 'done' && w.status !== 'cancelled') ?? null;
}

export async function upsertWorkflow(w: {
  id?: string;
  agentHandle: string;
  chatId?: string | null;
  kind: WorkflowKind;
  status?: WorkflowStatus;
  dealId?: string | null;
  state?: Record<string, unknown>;
}): Promise<Workflow> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      if (w.id) {
        const row: Record<string, unknown> = {};
        if (w.status !== undefined) row.status = w.status;
        if (w.state !== undefined) row.state = w.state;
        if (w.chatId !== undefined) row.chat_id = w.chatId;
        if (w.dealId !== undefined) row.deal_id = w.dealId;
        const { data, error } = await supabase.from('workflows').update(row).eq('id', w.id).select().single();
        if (error) throw error;
        return rowToWorkflow(data);
      }
      const { data, error } = await supabase.from('workflows').insert({
        agent_handle: w.agentHandle, chat_id: w.chatId ?? null, kind: w.kind,
        status: w.status ?? 'pending', deal_id: w.dealId ?? null, state: w.state ?? {},
      }).select().single();
      if (error) throw error;
      return rowToWorkflow(data);
    } catch (error) {
      logDbError('upsertWorkflow', error);
    }
  }
  const id = w.id ?? randomUUID();
  const existing = mem.workflows.get(id);
  const wf: Workflow = {
    id,
    agentHandle: w.agentHandle,
    chatId: w.chatId ?? existing?.chatId ?? null,
    kind: w.kind,
    status: w.status ?? existing?.status ?? 'pending',
    dealId: w.dealId ?? existing?.dealId ?? null,
    state: w.state ?? existing?.state ?? {},
  };
  mem.workflows.set(id, wf);
  return wf;
}
