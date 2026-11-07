// Every UI string lives here and is read through t(key, params).
// Mock-generated "model" text is not UI chrome and lives in the mock module instead.
const messages = {
  "app.title": "Качество диалогов",
  "brand.name": "FREEDOM",

  "nav.label": "Разделы",
  "nav.workspace": "Оценка",
  "nav.checklists": "Чек-листы",
  "nav.appeals": "Апелляции",
  "nav.compare": "Сравнение",
  "nav.analytics": "Отчёты",
  "nav.accuracy": "Точность",

  "role.label": "Роль",
  "role.current": "Роль: {role}",
  "role.controller": "Контролёр",
  "role.reviewer": "Проверяющий",
  "theme.toggle": "Тёмная тема",
  "dataset.label": "Набор",
  "dataset.title": "Текущий набор данных",

  "workspace.queue": "Очередь",
  "workspace.queueClose": "Закрыть очередь",
  "workspace.tab.transcript": "Диалог",
  "workspace.tab.scorecard": "Оценка",
  "workspace.scorecard": "Оценка диалога",
  "workspace.pick": "Выберите диалог в очереди",

  "view.soon": "Раздел ещё не готов.",
  "notfound.title": "Страница не найдена",
  "notfound.home": "К оценке диалогов",

  "toast.retry": "Повторить",
  "toast.close": "Закрыть",
  "error.network": "Нет связи с сервером. Проверьте подключение и повторите.",
  "error.timeout": "Сервер не ответил вовремя. Повторите попытку.",
  "error.bad_response": "Сервер вернул неожиданный ответ.",
  "error.model_key_missing": "Нужен ключ модели: новую оценку запустить нельзя.",
  "error.generic": "Что-то пошло не так. Повторите попытку.",
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
