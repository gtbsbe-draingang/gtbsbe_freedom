// Evaluation jobs that outlive the view that started them (R9).
//
//   followJob(api, first, onTick, {pollMs}?) -> Promise<job>
//     Polls a job until it is over, calling onTick(job, running) after every answer (and once at
//     the start). A failed poll throws; the caller keeps the job id and can follow it again.
//
//   jobSlot(store, api, key, {pollMs}?) -> { state, busy, start, resume, retry, reset, watch }
//     One job at a time per slot (the batch bar is "batch"; the apply dialog has one slot per
//     checklist version). The slot lives in store state `jobs[key]`, not in the view: leaving the
//     workspace or closing a dialog destroys the view, never the job. A rebuilt view reads the same
//     slot, so it shows the job's progress and cannot start a second job while one is open.
//
//     state() -> null | { lock, job, meta }
//       lock  null | "starting" | "watching" | "interrupted" | "resuming", taken synchronously,
//             before the first await, and released on one path each:
//               "starting"     the start (or retry) request is pending: no job id yet
//               "watching"     polling the job
//               "interrupted"  a poll failed: the job may still run on the server, so nothing new
//                              may start; recovery polls the same job id again (resume), it never
//                              starts another job
//               "resuming"     the recovery poll is pending
//       job   null | { id, done, total, failed, running }: the slot's last job
//       meta  what the view passed to start() (the apply dialog keeps its target there)
//     start(request, {again, meta}?)  request() returns the new job; a failure before a job id
//                                     exists frees the slot and the toast's retry calls again()
//     resume()   after "interrupted": polls the same job id and follows it to the end
//     retry()    «Повторить неудачные» on a settled job: api.retryJob(id)
//     reset()    forgets a settled job (a new selection or target starts a new batch)
//     watch(fn)  fn(next, previous) when the slot changes; returns the unsubscribe function
//
// A settled job bumps `queueRefresh`, whether or not a view still shows it.
import { watch } from "../state/store.js";
import { jobSettled } from "./scorecard.js";
import { toastError } from "./toast.js";

export const POLL_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function followJob(api, first, onTick, { pollMs = POLL_MS } = {}) {
  let job = first;
  onTick(job, !jobSettled(job));
  while (!jobSettled(job)) {
    await sleep(pollMs);
    job = await api.getJob(job.id);
    onTick(job, !jobSettled(job));
  }
  return job;
}

const snapshot = (job, running) => ({ id: job.id, done: job.done ?? 0, total: job.total ?? 0, failed: job.failed ?? 0, running });

export function jobSlot(store, api, key, { pollMs = POLL_MS } = {}) {
  const state = () => store.get().jobs?.[key] ?? null;
  // patch: fields to change, or null to forget the slot.
  const put = (patch) =>
    store.set((current) => {
      const jobs = { ...(current.jobs ?? {}) };
      if (patch === null) delete jobs[key];
      else jobs[key] = { lock: null, job: null, meta: null, ...jobs[key], ...patch };
      return { jobs };
    });
  const busy = () => (state()?.lock ?? null) !== null;

  // Polls the job to the end; it keeps going with no view on screen: the totals must still refresh.
  async function follow(first) {
    put({ lock: "watching", job: snapshot(first, !jobSettled(first)) });
    try {
      const job = await followJob(api, first, (tick, running) => put({ job: snapshot(tick, running) }), { pollMs });
      put({ lock: null, job: snapshot(job, false) });
      store.set((current) => ({ queueRefresh: (current.queueRefresh ?? 0) + 1 }));
      return job;
    } catch (error) {
      put({ lock: "interrupted" });
      toastError(store, error, { retry: resume });
      return null;
    }
  }

  async function resume() {
    const slot = state();
    const id = slot?.job?.id;
    if (!id || slot.lock !== "interrupted") return null;
    put({ lock: "resuming" });
    let job;
    try {
      job = await api.getJob(id);
    } catch (error) {
      const gone = error?.code === "not_found"; // the server forgot the job: nothing left to watch
      put(gone ? { lock: null, job: null } : { lock: "interrupted" });
      toastError(store, error, { retry: gone ? undefined : resume });
      return null;
    }
    return follow(job);
  }

  async function start(request, { again, meta } = {}) {
    if (busy()) return null;
    put(meta === undefined ? { lock: "starting" } : { lock: "starting", meta });
    let first;
    try {
      first = await request();
    } catch (error) {
      put({ lock: null });
      toastError(store, error, { retry: again });
      return null;
    }
    return follow(first);
  }

  function retry() {
    const id = state()?.job?.id;
    if (busy() || !id) return Promise.resolve(null);
    return start(() => api.retryJob(id), { again: retry });
  }

  function reset() {
    if (!busy() && state() !== null) put(null);
  }

  return { state, busy, start, resume, retry, reset, watch: (fn) => watch(store, (current) => current.jobs?.[key] ?? null, fn) };
}
