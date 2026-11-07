// State of the mock: one JSON document in `localStorage` (key `cqa-mock-v1`), or in memory when
// storage is missing, blocked (a Dynamics form can do that) or throws. Reads and writes are
// wrapped in try/catch, so the mock behaves the same either way, only without a reload surviving.
//
// Conversations loaded from the dev data are kept in `volatile`, never written: they are large
// and `getConversation` re-imports the group when one is missing after a reload.

export const STORAGE_KEY = "cqa-mock-v1";
const SCHEMA = 1;

const ARRAYS = ["checklists", "evaluations", "appeals", "jobs"];
const OBJECTS = ["seq", "conversations", "hashes", "evalMeta", "appealMeta", "jobMeta", "translations"];

const emptyState = () => ({
  schema: SCHEMA,
  seq: {}, // id counters per prefix
  conversations: {}, // id -> conversation (not the dev ones)
  hashes: {}, // id -> transcript hash, for every conversation seen
  checklists: [], // [{checklist_id, versions: [checklist version, ...]}]
  evaluations: [], // in creation order
  evalMeta: {}, // evaluation id -> {hash, fps: {criterion_id: fingerprint}}
  appeals: [],
  appealMeta: {}, // appeal id -> {ready_at}
  jobs: [],
  jobMeta: {}, // job id -> {checklist_id, version, mode, cursor}
  translations: {}, // "id|to" -> messages
});

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The storage to use: the one given (null forces memory), else localStorage when it works. */
export function resolveStorage(option) {
  if (option !== undefined) return option;
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const probe = `${STORAGE_KEY}-probe`;
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

function load(backend, key) {
  if (!backend) return emptyState();
  try {
    const parsed = JSON.parse(backend.getItem(key));
    if (!isPlainObject(parsed) || parsed.schema !== SCHEMA) return emptyState();
    if (!ARRAYS.every((k) => Array.isArray(parsed[k])) || !OBJECTS.every((k) => isPlainObject(parsed[k]))) {
      return emptyState();
    }
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

/**
 * @param {{storage?: Storage | null, key?: string}} [options]
 */
export function openStore({ storage, key = STORAGE_KEY } = {}) {
  const backend = resolveStorage(storage);
  const state = load(backend, key);
  const volatile = {};
  let dirty = false;
  let failed = false;

  return {
    state,
    volatile,
    /** True while writes to the backend succeed. */
    get persistent() {
      return backend !== null && !failed;
    },
    /** Marks the state changed; `flush()` writes it. */
    touch() {
      dirty = true;
    },
    flush() {
      if (!dirty) return;
      dirty = false;
      if (!backend) return;
      try {
        backend.setItem(key, JSON.stringify(state));
        failed = false;
      } catch {
        failed = true; // quota, blocked, private mode: carry on in memory
      }
    },
    /** "ev-0007": a counter per prefix, kept in the state so ids continue after a reload. */
    nextId(prefix) {
      state.seq[prefix] = (state.seq[prefix] ?? 0) + 1;
      dirty = true;
      return `${prefix}-${String(state.seq[prefix]).padStart(4, "0")}`;
    },
  };
}
