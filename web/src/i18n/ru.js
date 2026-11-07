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

  "queue.search": "Поиск по ID или тексту диалога",
  "queue.searchLabel": "Поиск по очереди",
  "queue.filters": "Фильтры очереди",
  "queue.filter.all": "Все",
  "queue.filter.chats": "Чаты",
  "queue.filter.calls": "Звонки",
  "queue.filter.disputed": "Спорные",
  "queue.filter.new": "Новые",
  "queue.language": "Язык диалога",
  "queue.language.all": "Все языки",
  "queue.list": "Диалоги",
  "queue.shown": "Показано {shown} из {total}",
  "queue.loading": "Загружаю очередь…",
  "queue.importing": "Загружаю набор {group}…",
  "queue.loadFailed": "Не удалось загрузить очередь",
  "queue.retry": "Повторить",
  "queue.empty": "Очередь пуста",
  "queue.emptyNote": "Загрузите набор данных, и диалоги появятся здесь.",
  "queue.noMatch": "Ничего не найдено",
  "queue.noMatchNote": "Измените поиск или фильтры.",
  "queue.select": "Выбрать диалог {id}",
  "queue.channel.chat": "чат",
  "queue.channel.call": "звонок",
  "queue.group": "Набор данных: {group}",
  "queue.language.title": "Язык диалога",
  "queue.score.none": "не оценён",
  "queue.score.notCalculated": "не рассчитывается",
  "queue.tag.appeal": "апелляция",
  "queue.tag.appeals": "апелляции: {n}",
  "queue.tag.grossError": "грубая ошибка",
  "queue.tag.needsReview": "на проверку",
  "queue.tag.needsReviewTitle": "Модель не уверена в части критериев",

  "view.soon": "Раздел ещё не готов.",
  "notfound.title": "Страница не найдена",
  "notfound.home": "К оценке диалогов",

  "toast.retry": "Повторить",
  "toast.close": "Закрыть",
  "error.network": "Нет связи с сервером. Проверьте подключение и повторите.",
  "error.timeout": "Сервер не ответил вовремя. Повторите попытку.",
  "error.bad_response": "Сервер вернул неожиданный ответ.",
  "error.model_key_missing": "Нужен ключ модели: новую оценку запустить нельзя.",
  "error.invalid_request": "Запрос заполнен неверно. Проверьте данные.",
  "error.na_not_allowed": "Для этого критерия ответ «N/A» недопустим.",
  "error.step_not_in_scale": "Такого шага нет в шкале критерия.",
  "error.bad_answer": "Недопустимый ответ для этого критерия.",
  "error.reason_required": "Укажите причину решения.",
  "error.invalid_checklist": "Чек-лист заполнен неверно. Исправьте отмеченные поля.",
  "error.appeal_already_decided": "По этой апелляции уже принято решение.",
  "error.appeal_already_open": "По этому критерию уже есть открытая апелляция.",
  "error.checklist_locked": "Эта версия чек-листа заблокирована. Сохраните её как новый чек-лист.",
  "error.organizer_url_missing": "Не задан адрес источника данных: загрузить группу нельзя.",
  "error.role_not_allowed": "Это действие недоступно для вашей роли.",
  "error.not_found": "Не найдено: запись удалена или ссылка устарела.",
  "error.organizer_error": "Источник данных не ответил. Повторите попытку позже.",
  "error.no_records": "В файле нет ни одной записи.",
  "error.bad_record": "В файле есть некорректная запись.",
  "error.bad_record_at": "Запись №{n} в файле некорректна.",
  "error.internal_error": "Ошибка на сервере. Повторите попытку позже.",
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
