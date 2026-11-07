// Checking and completing a checklist body that createChecklist / saveChecklistVersion receive.
// Light structural checks (the editor has its own validation); the mock rejects what the schema
// would reject, with the code `invalid_checklist`.
import { fingerprint } from "../../domain/fingerprint.js";

export class ChecklistBodyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChecklistBodyError";
  }
}

const isText = (v) => typeof v === "string" && v.trim() !== "";
const need = (ok, message) => {
  if (!ok) throw new ChecklistBodyError(message);
};

function nextCriterionId(taken) {
  let n = taken.size + 1;
  while (taken.has(`c${String(n).padStart(2, "0")}`)) n += 1;
  return `c${String(n).padStart(2, "0")}`;
}

/**
 * Sections and criteria for a new version: `body` fields win, `fallback` (the source version)
 * fills the gaps. Criteria keep their ids; one without an id gets a new one. Fingerprints are
 * always recomputed.
 * @returns {Promise<{name: string, description: string | null, channel: string, guidance: string, rounding: number, sections: object[], criteria: object[]}>}
 */
export async function completeBody(body, fallback = null) {
  const b = body ?? {};
  const name = b.name ?? fallback?.name;
  need(isText(name), "name is required");
  const channel = b.channel ?? fallback?.channel ?? "any";
  need(["any", "chat", "call"].includes(channel), "channel must be any, chat or call");

  const sections = structuredClone(b.sections ?? fallback?.sections ?? []);
  need(Array.isArray(sections) && sections.length > 0, "at least one section is required");
  sections.forEach((s, i) => {
    need(s && isText(s.id) && typeof s.title === "string", `section ${i}: id and title are required`);
    if (!Number.isInteger(s.order)) s.order = i + 1;
  });
  const sectionIds = new Set(sections.map((s) => s.id));
  need(sectionIds.size === sections.length, "section ids must be unique");

  const rawCriteria = structuredClone(b.criteria ?? fallback?.criteria ?? []);
  need(Array.isArray(rawCriteria) && rawCriteria.length > 0, "at least one criterion is required");
  const taken = new Set(rawCriteria.map((c) => c?.id).filter(isText));
  const seen = new Set();

  const criteria = [];
  for (const [i, raw] of rawCriteria.entries()) {
    need(raw !== null && typeof raw === "object", `criterion ${i}: not an object`);
    const c = { ...raw };
    if (!isText(c.id)) c.id = nextCriterionId(taken);
    taken.add(c.id);
    need(!seen.has(c.id), `criterion ${c.id}: duplicate id`);
    seen.add(c.id);
    const where = `criterion ${c.id}`;
    need(sectionIds.has(c.section_id), `${where}: unknown section_id`);
    need(isText(c.title), `${where}: title is required`);
    c.answer_type ??= "yes_no";
    need(c.answer_type === "yes_no" || c.answer_type === "scale", `${where}: answer_type must be yes_no or scale`);
    c.kind ??= "scored";
    need(c.kind === "scored" || c.kind === "gross_error", `${where}: kind must be scored or gross_error`);
    c.scale_steps = c.answer_type === "scale" ? c.scale_steps ?? [] : [];
    if (c.answer_type === "scale") {
      need(Array.isArray(c.scale_steps) && c.scale_steps.length >= 2, `${where}: a scale needs at least two steps`);
      need(c.scale_steps.every((s) => Number.isFinite(s?.value) && typeof s.label === "string"), `${where}: steps are {value, label}`);
      c.scale_steps.sort((a, b) => a.value - b.value);
      need(new Set(c.scale_steps.map((s) => s.value)).size === c.scale_steps.length, `${where}: duplicate step values`);
    }
    c.weight = c.kind === "gross_error" ? 0 : c.weight ?? 0;
    need(Number.isFinite(c.weight) && c.weight >= 0, `${where}: weight must be a number from 0`);
    c.na_allowed = c.na_allowed === true;
    c.na_condition = c.na_allowed ? c.na_condition ?? null : null;
    c.kinds = c.kind === "gross_error" && Array.isArray(c.kinds) ? c.kinds : [];
    c.wording = typeof c.wording === "string" ? c.wording : "";
    c.guidance = typeof c.guidance === "string" && c.guidance !== "" ? c.guidance : null; // null when empty
    if (!Number.isInteger(c.order)) c.order = i + 1;
    if (c.model === undefined || c.model === null) delete c.model;
    c.fingerprint = await fingerprint(c);
    criteria.push(c);
  }

  return {
    name,
    description: b.description !== undefined ? b.description : fallback?.description ?? null,
    channel,
    guidance: typeof b.guidance === "string" ? b.guidance : fallback?.guidance ?? "", // the contract: a string, "" when none
    rounding: Number.isInteger(b.rounding) ? b.rounding : fallback?.rounding ?? 2,
    sections,
    criteria,
  };
}
