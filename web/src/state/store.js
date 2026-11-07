// A small observable store. State objects are replaced, never mutated: set() builds a new object
// and notifies every subscriber once, with (state, previousState).

export function createStore(initial = {}) {
  let state = { ...initial };
  const listeners = new Set();

  return {
    get: () => state,
    // `partial` is an object, or a function of the current state returning one.
    set(partial) {
      const previous = state;
      state = { ...state, ...(typeof partial === "function" ? partial(state) : partial) };
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue; // unsubscribed by an earlier listener of this set
        try {
          listener(state, previous);
        } catch (error) {
          // One broken view must not stop the others from seeing the change.
          console.error(error);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// Calls fn(next, previous) when select(state) changes (Object.is). Returns an unsubscribe function.
export function watch(store, select, fn) {
  let previous = select(store.get());
  return store.subscribe((state) => {
    const next = select(state);
    if (Object.is(next, previous)) return;
    const old = previous;
    previous = next;
    fn(next, old);
  });
}

// Compact single-dialogue mode: embedded on a record that names its conversation. The queue and
// the navigation are not rendered at all.
export const isCompact = (state) => state.mode === "embedded" && Boolean(state.conversationId);
