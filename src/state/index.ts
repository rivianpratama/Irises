// The data layer now lives in src/db. The conversation/profile shim
// (src/state/conversation.js) is kept for the original import path; this barrel
// re-exports the full data layer (conversations, profiles, automations...).
export * from '../db/index.js';
