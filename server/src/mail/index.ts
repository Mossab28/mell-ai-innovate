export { startSmtp } from "./smtp.ts";
export { ingestMail, checkAuth, type AuthCheck, type Envelope } from "./ingest.ts";
export { runInbox, handleConfirm, releaseHeld, parseGmailConfirm, confirmForwarding } from "./process.ts";
export { MAIL_TOOL_SPECS, MAIL_TOOLS, runMailTool } from "./tools.ts";
export { MAIL_GUIDE, GOOGLE_UNAVAILABLE_WITH_MAIL, mailContext } from "./prompt.ts";
export { installMailRuntime, mailRuntime } from "./runtime.ts";
export { ensureAddress, addressOf, mailOn } from "./address.ts";
