// Checks and normalises a checklist draft from the editor (Review Focus 5). Browser-safe.
//
//   validateChecklist(draft) -> { value, errors: [{path, code}], warnings: [{code, sum?}] }
//
// `value` is the draft ready to send: numbers parsed (a decimal comma is accepted), scale steps
// sorted, the gross-error weight 0, no N/A condition when N/A is off, no steps on a yes/no
// criterion, no violation kinds on a scored one. Error codes: title_required, weight_invalid,
// scale_empty, scale_value_invalid, scale_duplicate, na_condition_required, section_missing,
// criteria_empty. The only warning is weight_sum (scored weights not adding up to 100), which
// never blocks saving: scoring rescales to 100 anyway.

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** A number from a field: numbers stay, "7,5" and " 7.5 " parse, anything else is NaN. */
export function parseNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const cleaned = value.trim().replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}

// Exact enough for a warning: weights have at most a few decimals.
const sumOf = (weights) => Math.round(weights.reduce((acc, w) => acc + w, 0) * 1e6) / 1e6;

export function validateChecklist(draft) {
  const errors = [];
  const warnings = [];
  const fail = (path, code) => errors.push({ path, code });
  const source = draft ?? {};

  if (text(source.name) === "") fail("name", "title_required");

  const sections = Array.isArray(source.sections) ? source.sections.map((s, i) => ({ ...s, order: Number.isInteger(s?.order) ? s.order : i + 1 })) : [];
  const sectionIds = new Set(sections.map((s) => s.id));

  const criteria = (Array.isArray(source.criteria) ? source.criteria : []).map((raw, i) => {
    const c = { ...raw };
    const path = `criteria.${i}`;
    const gross = c.kind === "gross_error";
    c.kind = gross ? "gross_error" : "scored";
    c.answer_type = c.answer_type === "scale" ? "scale" : "yes_no";

    if (text(c.title) === "") fail(`${path}.title`, "title_required");
    if (!sectionIds.has(c.section_id)) fail(`${path}.section_id`, "section_missing");

    if (gross) c.weight = 0;
    else {
      const weight = parseNumber(c.weight);
      if (!Number.isFinite(weight) || weight < 0) fail(`${path}.weight`, "weight_invalid");
      else c.weight = weight;
    }

    if (c.answer_type === "scale") {
      const steps = (Array.isArray(c.scale_steps) ? c.scale_steps : []).map((step) => ({ value: parseNumber(step?.value), label: typeof step?.label === "string" ? step.label : "" }));
      if (steps.some((step) => !Number.isFinite(step.value))) fail(`${path}.scale_steps`, "scale_value_invalid");
      else if (steps.length < 2) fail(`${path}.scale_steps`, "scale_empty");
      else if (new Set(steps.map((step) => step.value)).size !== steps.length) fail(`${path}.scale_steps`, "scale_duplicate");
      c.scale_steps = steps.sort((a, b) => a.value - b.value);
    } else c.scale_steps = [];

    c.na_allowed = c.na_allowed === true;
    if (c.na_allowed && text(c.na_condition) === "") fail(`${path}.na_condition`, "na_condition_required");
    c.na_condition = c.na_allowed ? text(c.na_condition) || null : null;

    c.kinds = gross ? (Array.isArray(c.kinds) ? c.kinds.map(text).filter(Boolean) : []) : [];
    c.wording = typeof c.wording === "string" ? c.wording : "";
    c.guidance = text(c.guidance) === "" ? null : c.guidance;
    if (!Number.isInteger(c.order)) c.order = i + 1;
    return c;
  });
  if (criteria.length === 0) fail("criteria", "criteria_empty");

  const scored = criteria.filter((c) => c.kind === "scored" && Number.isFinite(c.weight));
  const sum = sumOf(scored.map((c) => c.weight));
  if (scored.length > 0 && sum !== 100) warnings.push({ code: "weight_sum", sum });

  return { value: { ...source, sections, criteria }, errors, warnings };
}
