// The job slots behind the batch bar and the apply dialog (review of #64): the lock is taken before
// the first await, a failed poll resumes the same job, and the slot lives in the store, so a view
// rebuilt while its job runs (navigation, a reopened dialog) sees the job and cannot start another.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../../src/state/store.js";
import { jobSlot } from "../../src/ui/job-runner.js";

const running = (id, done = 0) => ({ id, status: "running", total: 2, done, failed: 0 });
const settled = (id, failed = 0) => ({ id, status: "done", total: 2, done: 2 - failed, failed });
const networkError = () => Object.assign(new Error("offline"), { code: "network", retryable: true });

// An API whose start, poll and retry answers are queued by the test; every call is recorded.
function fakeApi() {
  const calls = { start: 0, retry: [], polls: [] };
  const answers = { polls: [] };
  return {
    calls,
    answers,
    startEvaluations: () => {
      calls.start += 1;
      return answers.start();
    },
    getJob: (id) => {
      calls.polls.push(id);
      const next = answers.polls.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? settled(id));
    },
    retryJob: (id) => {
      calls.retry.push(id);
      return Promise.resolve(running(id));
    },
  };
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const errorToasts = (store) => (store.get().toasts ?? []).filter((toast) => toast.kind === "error");
const OPTIONS = { pollMs: 1 };

describe("jobSlot", () => {
  test("the lock is taken before the first await: a second start sends nothing", async () => {
    const store = createStore();
    const api = fakeApi();
    const pending = deferred();
    api.answers.start = () => pending.promise;
    const slot = jobSlot(store, api, "batch", OPTIONS);
    const first = slot.start(() => api.startEvaluations());
    assert.equal(slot.busy(), true);
    assert.equal(slot.state().lock, "starting");
    assert.equal(await slot.start(() => api.startEvaluations()), null);
    assert.equal(api.calls.start, 1);
    pending.resolve(running("j1"));
    await first;
    assert.equal(slot.busy(), false);
  });

  test("a settled job frees the slot, keeps its numbers and bumps queueRefresh once", async () => {
    const store = createStore({ queueRefresh: 4 });
    const api = fakeApi();
    api.answers.start = () => Promise.resolve(running("j1"));
    api.answers.polls.push(running("j1", 1), settled("j1", 1));
    const slot = jobSlot(store, api, "batch", OPTIONS);
    const job = await slot.start(() => api.startEvaluations());
    assert.equal(job.status, "done");
    assert.deepEqual(slot.state().job, { id: "j1", done: 1, total: 2, failed: 1, running: false, items: [] });
    assert.equal(slot.state().lock, null);
    assert.equal(store.get().queueRefresh, 5);
    assert.deepEqual(api.calls.polls, ["j1", "j1"]);
  });

  test("the slot keeps each dialogue's status and evaluation id, for the batch board", async () => {
    const store = createStore();
    const api = fakeApi();
    const items = [
      { conversation: "DEV:a", status: "done", error: null, evaluation_id: "e1", extra: "dropped" },
      { conversation: "DEV:b", status: "failed", error: "timeout", evaluation_id: null },
    ];
    api.answers.start = () => Promise.resolve({ ...settled("j1", 1), items });
    const slot = jobSlot(store, api, "batch", OPTIONS);
    await slot.start(() => api.startEvaluations());
    assert.deepEqual(slot.state().job.items, [
      { conversation: "DEV:a", status: "done", evaluation_id: "e1", error: null },
      { conversation: "DEV:b", status: "failed", evaluation_id: null, error: "timeout" },
    ]);
  });

  test("a view rebuilt while the job runs shares its slot: it sees the job and cannot start another", async () => {
    const store = createStore();
    const api = fakeApi();
    api.answers.start = () => Promise.resolve(running("j1"));
    const release = deferred();
    api.getJob = (id) => {
      api.calls.polls.push(id);
      return release.promise.then(() => settled(id));
    };
    const before = jobSlot(store, api, "batch", OPTIONS); // the bar that started the job
    const done = before.start(() => api.startEvaluations());
    await new Promise((resolve) => setTimeout(resolve, 5)); // polling now
    const after = jobSlot(store, api, "batch", OPTIONS); // the bar built on return to the workspace
    assert.equal(after.busy(), true);
    assert.equal(after.state().lock, "watching");
    assert.equal(after.state().job.id, "j1");
    assert.equal(await after.start(() => api.startEvaluations()), null);
    assert.equal(api.calls.start, 1);
    release.resolve();
    await done;
    assert.equal(after.busy(), false);
    assert.equal(after.state().job.running, false);
  });

  test("slots with different keys are independent", async () => {
    const store = createStore();
    const api = fakeApi();
    const pending = deferred();
    api.answers.start = () => pending.promise;
    const batch = jobSlot(store, api, "batch", OPTIONS);
    const apply = jobSlot(store, api, "apply:c1:2", OPTIONS);
    const first = batch.start(() => api.startEvaluations());
    assert.equal(apply.busy(), false);
    pending.resolve(settled("j1"));
    await first;
  });

  test("a failed poll keeps the job; resume polls the same id and nothing new can start meanwhile", async () => {
    const store = createStore();
    const api = fakeApi();
    api.answers.start = () => Promise.resolve(running("j1"));
    api.answers.polls.push(networkError());
    const slot = jobSlot(store, api, "batch", OPTIONS);
    assert.equal(await slot.start(() => api.startEvaluations()), null);
    assert.equal(slot.state().lock, "interrupted");
    assert.equal(slot.state().job.id, "j1");
    const [toast] = errorToasts(store);
    assert.equal(typeof toast.retry, "function", "the toast offers recovery");
    assert.equal(await slot.start(() => api.startEvaluations()), null, "no new job while the old one may still run");
    assert.equal(await slot.retry(), null, "nor a retry");
    const job = await toast.retry(); // the toast's retry is resume
    assert.equal(job.status, "done");
    assert.equal(api.calls.start, 1);
    assert.deepEqual(api.calls.polls, ["j1", "j1"]);
    assert.equal(slot.busy(), false);
  });

  test("resume after not_found frees the slot; another network failure keeps it interrupted", async () => {
    const store = createStore();
    const api = fakeApi();
    api.answers.start = () => Promise.resolve(running("j1"));
    api.answers.polls.push(networkError(), networkError(), Object.assign(new Error("gone"), { code: "not_found", retryable: false }));
    const slot = jobSlot(store, api, "batch", OPTIONS);
    await slot.start(() => api.startEvaluations());
    await slot.resume();
    assert.equal(slot.state().lock, "interrupted");
    assert.equal(slot.state().job.id, "j1");
    await slot.resume();
    assert.equal(slot.state().lock, null);
    assert.equal(slot.state().job, null);
    assert.equal(await slot.resume(), null, "nothing left to resume");
  });

  test("a start that fails before a job exists frees the slot; the toast's retry repeats the request", async () => {
    const store = createStore();
    const api = fakeApi();
    api.answers.start = () => Promise.reject(networkError());
    const slot = jobSlot(store, api, "batch", OPTIONS);
    let again = 0;
    await slot.start(() => api.startEvaluations(), { again: () => (again += 1) });
    assert.equal(slot.busy(), false);
    errorToasts(store)[0].retry();
    assert.equal(again, 1);
  });

  test("retry asks retryJob for the settled job's id, once", async () => {
    const store = createStore();
    const api = fakeApi();
    api.answers.start = () => Promise.resolve(settled("j1", 1));
    const slot = jobSlot(store, api, "batch", OPTIONS);
    await slot.start(() => api.startEvaluations());
    const first = slot.retry();
    assert.equal(slot.state().lock, "starting");
    assert.equal(await slot.retry(), null);
    await first;
    assert.deepEqual(api.calls.retry, ["j1"]);
  });

  test("meta is kept with the job; reset forgets a settled job but never a running one", async () => {
    const store = createStore();
    const api = fakeApi();
    const pending = deferred();
    api.answers.start = () => pending.promise;
    const slot = jobSlot(store, api, "apply:c1:2", OPTIONS);
    const first = slot.start(() => api.startEvaluations(), { meta: { target: "dev" } });
    slot.reset();
    assert.deepEqual(slot.state().meta, { target: "dev" });
    pending.resolve(settled("j1"));
    await first;
    assert.deepEqual(slot.state().meta, { target: "dev" });
    slot.reset();
    assert.equal(slot.state(), null);
  });

  test("watch reports the slot's changes and stops when unsubscribed", async () => {
    const store = createStore();
    const api = fakeApi();
    api.answers.start = () => Promise.resolve(settled("j1"));
    const slot = jobSlot(store, api, "batch", OPTIONS);
    const locks = [];
    const stop = slot.watch((next) => locks.push(next?.lock ?? null));
    await slot.start(() => api.startEvaluations());
    stop();
    const seen = locks.length;
    slot.reset();
    assert.deepEqual(locks.filter((lock, i) => lock !== locks[i - 1]), ["starting", "watching", null]);
    assert.equal(locks.length, seen, "no calls after unsubscribing");
  });
});
