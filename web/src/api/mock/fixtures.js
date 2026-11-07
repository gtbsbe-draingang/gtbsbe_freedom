// The data the mock starts from, imported as JSON so esbuild bundles it: the official checklist
// seed (no fingerprints yet; persist/index computes them on load) and the contract's example
// dialogues. Only the files named here are bundled; data/dev.json never is.
import officialSeed from "../../../../checklists/official-chat-v1.json" with { type: "json" };
import chatRu from "../../../../contract/examples/conversation.chat-ru.json" with { type: "json" };
import callRu from "../../../../contract/examples/conversation.call-ru.json" with { type: "json" };

export const OFFICIAL_SEED = officialSeed;

/** The checklist the queue shows totals for, and the one accuracy and analytics read. */
export const DEFAULT_CHECKLIST = Object.freeze({
  checklist_id: officialSeed.checklist_id,
  version: officialSeed.version,
});

export const MODEL = "mock";

// Fields normalizeRecord and the mock set themselves; the rest is the organisers' record.
const OWN_FIELDS = ["id", "created_at", "group_id", "status", "facts", "audio", "audio_unavailable_reason"];

/**
 * The example dialogues as organisers' records: what `importDataset(group)` loads when the group
 * is not DEV-with-a-data-url. A fresh copy each call.
 * @returns {object[]}
 */
export function exampleRecords() {
  return [chatRu, callRu].map((conversation) => {
    const record = structuredClone(conversation);
    for (const field of OWN_FIELDS) delete record[field];
    return record;
  });
}
