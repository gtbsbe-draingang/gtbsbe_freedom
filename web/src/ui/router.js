// Hash routes. Ids contain ":" and sometimes "/" (`DEV:p1-ru-001`), so every id is one encoded
// path segment: split first, decode after. All parameters are strings, as they are in the URL.
//
//   workspace  #/            #/c/:id
//   checklists #/checklists  checklist #/checklists/:checklistId/:version  editor …/edit
//   appeals    #/appeals     appeal #/appeals/:id
//   compare    #/compare?from_checklist&from_version&to_checklist&to_version&group_id
//   analytics  #/analytics   accuracy #/accuracy
// Anything else parses as { name: "notfound" }.

const COMPARE_KEYS = ["from_checklist", "from_version", "to_checklist", "to_version", "group_id"];
const VERSION = /^\d+$/;

const NAV_OF = {
  workspace: "workspace",
  checklists: "checklists",
  checklist: "checklists",
  editor: "checklists",
  compare: "checklists",
  appeals: "appeals",
  appeal: "appeals",
  analytics: "analytics",
  accuracy: "accuracy",
};

// The nav item that stays highlighted on a route, or null.
export const navFor = (routeName) => NAV_OF[routeName] ?? null;

export const sameRoute = (a, b) => a?.name === b?.name && JSON.stringify(a?.params ?? {}) === JSON.stringify(b?.params ?? {});

const route = (name, params = {}) => ({ name, params });

export function parseRoute(hash) {
  const raw = typeof hash === "string" ? hash : "";
  const body = raw.startsWith("#") ? raw.slice(1) : raw;
  const queryAt = body.indexOf("?");
  const path = (queryAt < 0 ? body : body.slice(0, queryAt)).replace(/^\/+/, "").replace(/\/+$/, "");
  const search = queryAt < 0 ? "" : body.slice(queryAt + 1);
  const notFound = route("notfound", { path: raw });

  let segments;
  try {
    segments = path === "" ? [] : path.split("/").map(decodeURIComponent);
  } catch {
    return notFound;
  }
  if (segments.some((segment) => segment === "")) return notFound;

  const [head, a, b, c] = segments;
  const n = segments.length;
  if (n === 0) return route("workspace");
  if (head === "c" && n === 2) return route("workspace", { id: a });
  if (head === "checklists") {
    if (n === 1) return route("checklists");
    if (n === 3 && VERSION.test(b)) return route("checklist", { checklistId: a, version: b });
    if (n === 4 && VERSION.test(b) && c === "edit") return route("editor", { checklistId: a, version: b });
    return notFound;
  }
  if (head === "appeals") {
    if (n === 1) return route("appeals");
    if (n === 2) return route("appeal", { id: a });
    return notFound;
  }
  if (head === "compare" && n === 1) {
    const query = new URLSearchParams(search);
    const params = {};
    for (const key of COMPARE_KEYS) {
      const value = query.get(key);
      if (value) params[key] = value;
    }
    return route("compare", params);
  }
  if ((head === "analytics" || head === "accuracy") && n === 1) return route(head);
  return notFound;
}

const encoded = (params, key) => {
  const value = params?.[key];
  if (value === undefined || value === null || value === "") throw new TypeError(`href: missing ${key}`);
  return encodeURIComponent(String(value));
};

export function href(name, params = {}) {
  switch (name) {
    case "workspace":
      return params?.id ? `#/c/${encoded(params, "id")}` : "#/";
    case "checklists":
      return "#/checklists";
    case "checklist":
      return `#/checklists/${encoded(params, "checklistId")}/${encoded(params, "version")}`;
    case "editor":
      return `#/checklists/${encoded(params, "checklistId")}/${encoded(params, "version")}/edit`;
    case "appeals":
      return "#/appeals";
    case "appeal":
      return `#/appeals/${encoded(params, "id")}`;
    case "compare": {
      const query = new URLSearchParams();
      for (const key of COMPARE_KEYS) {
        const value = params?.[key];
        if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
      }
      const text = query.toString();
      return text ? `#/compare?${text}` : "#/compare";
    }
    case "analytics":
      return "#/analytics";
    case "accuracy":
      return "#/accuracy";
    default:
      throw new TypeError(`href: unknown route ${JSON.stringify(name)}`);
  }
}
