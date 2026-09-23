// The schema-echo guard — telling a turn's real actions apart from a weak model reciting its own
// tool list back at us.
//
// Observed live (2026-09-15 17:45). The convo model (deepseek-v4-flash on the toolsViaJson envelope)
// returned one real `delegate_to_ops` and then eleven more `tool_calls` entries, one per offered
// tool, every arg null — the shape of the schema it had just been shown, not of anything it meant to
// do. Null args are stripped at the parse boundary (pipeline/bubbleJson.ts extractToolCalls), so all
// eleven arrived at dispatch as `{ name, input: {} }` and were RUN: six handlers answered empty
// input with a `failed` or `nothing_found` outcome, Fallfirm voiced one bubble each, and because a
// correction outcome replaces the model's own text the user read eight phantom bubbles instead of
// the reply they were waiting on. `update_memory{}` also fired the engine's remember pass with the
// user's own message through its `input.request ?? textToSend` fallback.
//
// "Drop the calls with no args" is the wrong rule on its own, and that is the whole difficulty:
// `list_automations` and `cancel_research` are legitimately argless (no `required` in their schemas,
// and a cancel that names nothing stops the one look they asked for, convo/shared.ts pickResearch), so a
// rule like that would break real turns to fix this one. What is actually diagnostic is the ENVELOPE
// SHAPE: a model doing work asks for one thing, or two things it named; a model echoing its schema
// produces a run of argless calls. So there are two rules, and one of them reads the whole envelope.
//
// PURE, and deliberately so: the dispatch path decides what to do with a dropped call (convo/
// shared.ts records the receipt and runs the turn off the kept list), while this module only has to
// answer which calls are real, which is a question a test can ask directly.

import type { LlmToolCall, LlmToolDef } from '../../llm/types.js';

export type DropReason = 'required_args_missing' | 'schema_echo';

export interface DroppedCall {
  name: string;
  reason: DropReason;
}

/** No args at all. Nulls are already stripped upstream, so a key here means the model filled it. */
function isEmpty(call: LlmToolCall): boolean {
  return Object.keys(call.input ?? {}).length === 0;
}

/** The tool's own `required` list, read defensively: inputSchema is an untyped JSON-schema bag. */
function requiredArgs(tool: LlmToolDef): unknown[] {
  const req = (tool.inputSchema as { required?: unknown }).required;
  return Array.isArray(req) ? req : [];
}

/**
 * Split one envelope's tool calls into the ones this turn actually meant and the ones that are a
 * recitation of the schema. Two rules:
 *
 *   R1 (per call) — empty input against a tool that REQUIRES args. Without them the handler can
 *      only produce an error or a nothing-found bubble, so the call cannot be intent whatever else
 *      the envelope holds. This is why it needs no second call to fire.
 *   R2 (the envelope) — two or more empty-input calls on OFFERED tools riding together. No real
 *      turn needs two argless tools at once, so the run itself is the signal, and every
 *      empty-input call in it goes. This is the half that catches `list_automations{}` and
 *      `cancel_research{}` inside a dump while leaving a LONE one of either standing as the real
 *      request it is.
 *
 * PRECEDENCE: R1 wins a call that matches both. Its reason is true of the call on its own, with no
 * reference to what else the model wrote, which makes the reported reason stable no matter what the
 * rest of the envelope looked like.
 *
 * Never dropped: a call WITH args (args are intent, even inside a dump), and a name the offered tool
 * list does not carry — the envelope's `name` enum forbids invented tools, and dispatch ignores an
 * unknown name anyway, so guessing at one here would only hide a different bug. `kept` holds the
 * envelope's own order.
 */
export function dropSchemaEcho(
  calls: LlmToolCall[],
  tools: LlmToolDef[],
): { kept: LlmToolCall[]; dropped: DroppedCall[] } {
  const kept: LlmToolCall[] = [];
  const dropped: DroppedCall[] = [];
  // R2 reads the whole envelope, so the count has to be in hand before any call is judged. It
  // counts only the empties this guard would otherwise judge — an OFFERED name — because an
  // invented name is kept whatever the envelope looks like, and counting one would let a single
  // hallucinated entry flip R2 and drop the legitimate lone `list_automations{}` beside it.
  const emptyCount = calls.reduce(
    (n, call) => (isEmpty(call) && tools.some(t => t.name === call.name) ? n + 1 : n), 0,
  );

  for (const call of calls) {
    const tool = tools.find(t => t.name === call.name);
    if (!isEmpty(call) || !tool) {
      kept.push(call);
      continue;
    }
    if (requiredArgs(tool).length) dropped.push({ name: call.name, reason: 'required_args_missing' });
    else if (emptyCount >= 2) dropped.push({ name: call.name, reason: 'schema_echo' });
    else kept.push(call);
  }

  return { kept, dropped };
}
