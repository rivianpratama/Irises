// Moved to src/services/linqMedia.ts so the attachments service (Ops' read_chat_attachment) can
// reuse the verified Linq fetch without importing from agents/. Re-exported here for path
// stability — mm/client.ts and the existing tests keep importing from this module unchanged.
export * from '../../services/linqMedia.js';
