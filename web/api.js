export function connectionPath(id) {
  return id === "home-assistant"
    ? "/api/home-assistant"
    : `/api/integrations/${encodeURIComponent(id)}`;
}

export function createApi({
  onUnauthorized = () => {},
  fetch = globalThis.fetch,
} = {}) {
  return async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      if (response.status === 401) onUnauthorized();
      throw new Error(
        data.error || data.message || `Request failed (${response.status}).`,
      );
    }
    return data;
  };
}

/** Share only in-flight reads; later requests always fetch fresh device state. */
export function coalesceReads(api) {
  const pending = new Map();
  return function read(path) {
    if (!pending.has(path)) {
      const request = Promise.resolve()
        .then(() => api(path))
        .finally(() => pending.delete(path));
      pending.set(path, request);
    }
    return pending.get(path);
  };
}
