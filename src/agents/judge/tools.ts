import type { LlmToolDef } from '../../llm/types.js';

// The Judge's structured verdict. The Judge MUST call this on every email it reads (the
// persona makes that load-bearing). The voiced surfacing message — when the email is
// important — is the model's TEXT output in the same turn; this tool carries the decision.
export const FLAG_EMAIL_TOOL: LlmToolDef = {
  name: 'flag_email',
  description: [
    'Record your verdict on the email you just read. Call this EVERY time, for every email, important or not.',
    'When important=true, you must ALSO write the surfacing message as your text reply (it goes to the user unprompted).',
    'When important=false, write NO text at all — stay silent. Be strict: most newsletters, digests, lead blasts, drip/marketing, and social notifications are NOT important.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      important: { type: 'boolean', description: 'true only if the user would genuinely want to know / act on this now.' },
      severity: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'Impact if missed. critical=could miss a hard/legal deadline, move money (any wire/payment instruction or suspected fraud), or a genuine emergency. high=important, action needed soon. medium=routine but real. low=noise.',
      },
      category: {
        type: 'string',
        enum: ['action_required', 'deadline', 'financial', 'security', 'appointment', 'personal', 'work', 'receipt', 'notification', 'newsletter', 'marketing', 'social', 'spam', 'other'],
        description: 'Best-fit category for the email.',
      },
      suspected_fraud: { type: 'boolean', description: 'true if it shows wire-fraud / business-email-compromise / phishing signals (changed bank details, domain near-spoof, urgency + off-hours, credential request, etc.).' },
      deadline_date: { type: 'string', description: 'ISO date YYYY-MM-DD if a concrete time-bound deadline is stated or clearly implied, else null. NEVER invent one.' },
      deadline_label: { type: 'string', description: 'Short label for the deadline/action if any (e.g. "reply by", "pay invoice", "renew subscription"), else null.' },
      summary: { type: 'string', description: 'One short line of what the user needs to know — facts only, drawn from the email, no invention.' },
      suggest_reminder: { type: 'boolean', description: 'true if a reminder would genuinely help (there is a future deadline/obligation). If true, your message should mention a reminder is within reach (a statement, never a "want me to?" question).' },
    },
    required: ['important', 'severity', 'category', 'suspected_fraud', 'summary', 'suggest_reminder'],
  },
};
