// Every UI string lives here and is read through t(key, params).
// Mock-generated "model" text is not UI chrome and lives in the mock module instead.
const messages = {
  "app.title": "Качество диалогов",
};

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Replaces {name} with params.name. A placeholder without a parameter stays as written, and a
// substituted value is never expanded again.
export function format(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (placeholder, name) => (has(params, name) ? String(params[name]) : placeholder));
}

// A missing key returns the key itself and logs nothing.
export function t(key, params) {
  return has(messages, key) ? format(messages[key], params) : key;
}
