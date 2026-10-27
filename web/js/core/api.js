// HTTP + SSE client for the Wheelhouse server.
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await response.json();
  } catch { /* empty body */ }
  if (!response.ok) throw new ApiError(data?.error || `${method} ${path} failed (${response.status})`, response.status);
  return data;
}

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

export const api = {
  get: (path, params) => request("GET", path + qs(params)),
  post: (path, body = {}) => request("POST", path, body),
  put: (path, body = {}) => request("PUT", path, body),
  del: (path, params) => request("DELETE", path + qs(params), {}),
  // domain helpers
  config: () => api.get("/api/config"),
  catalog: (cwd, force) => api.get("/api/catalog", { cwd, force: force ? 1 : "" }),
  sessions: (cwd) => api.get("/api/sessions", { cwd }),
  session: (id, cwd) => api.get(`/api/sessions/${id}`, { cwd }),
  createSession: (cwd, meta, start = false) => api.post("/api/sessions", { cwd, meta, start }),
  startSession: (id, cwd, meta) => api.post(`/api/sessions/${id}/start`, { cwd, meta }),
  send: (id, payload) => api.post(`/api/sessions/${id}/messages`, payload),
  interrupt: (id) => api.post(`/api/sessions/${id}/interrupt`),
  control: (id, op, args = {}) => api.post(`/api/sessions/${id}/control`, { op, args }),
  respond: (id, requestId, answer) => api.post(`/api/sessions/${id}/respond`, { id: requestId, answer }),
  patchMeta: (id, patch) => api.post(`/api/sessions/${id}/meta`, { patch }),
  restart: (id, cwd, patch) => api.post(`/api/sessions/${id}/restart`, { cwd, patch }),
  closeSession: (id) => api.post(`/api/sessions/${id}/close`),
  rename: (id, title, cwd) => api.post(`/api/sessions/${id}/rename`, { title, cwd }),
  pin: (id, pinned) => api.post(`/api/sessions/${id}/pin`, { pinned }),
  archive: (id, archived) => api.post(`/api/sessions/${id}/archive`, { archived }),
  fork: (id, cwd, upToMessageId, title) => api.post(`/api/sessions/${id}/fork`, { cwd, upToMessageId, title }),
  deleteSession: (id, cwd) => api.del(`/api/sessions/${id}`, { cwd }),
  cli: (args, cwd, timeout) => api.post("/api/cli", { args, cwd, timeout }),
};

/** One shared SSE connection for cross-session events (state, attention, list changes). */
const listeners = new Map();
export function onServerEvent(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
}

let globalSource;
export function connectGlobalEvents(onStatus) {
  globalSource?.close();
  const source = new EventSource("/api/events");
  globalSource = source;
  const wire = (name) =>
    source.addEventListener(name, (event) => {
      let data = null;
      try { data = JSON.parse(event.data); } catch { /* ignore */ }
      for (const fn of listeners.get(name) || []) fn(data);
    });
  ["hello", "session.state", "session.attention", "sessions.changed"].forEach(wire);
  source.onopen = () => onStatus?.(true);
  source.onerror = () => onStatus?.(false);
}

/** Per-session stream; reconnects with the last seen seq so nothing is lost. */
export function openSessionStream(id, after, { onMessage, onGone, onState }) {
  let lastSeq = after || 0;
  let source;
  let closed = false;
  const connect = () => {
    if (closed) return;
    source = new EventSource(`/api/sessions/${id}/stream?after=${lastSeq}`);
    source.addEventListener("msg", (event) => {
      const entry = JSON.parse(event.data);
      if (entry.seq <= lastSeq) return;
      lastSeq = entry.seq;
      onMessage(entry);
    });
    source.addEventListener("gone", () => {
      source.close();
      onGone?.();
    });
    source.onopen = () => onState?.(true);
    source.onerror = () => {
      onState?.(false);
      // EventSource retries by itself; re-create it with the right `after` if it gave up.
      if (source.readyState === EventSource.CLOSED && !closed) setTimeout(connect, 1500);
    };
  };
  connect();
  return {
    close() {
      closed = true;
      source?.close();
    },
    get seq() {
      return lastSeq;
    },
  };
}
