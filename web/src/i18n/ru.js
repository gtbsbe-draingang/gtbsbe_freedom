// Shared localization runtime; this compatibility path keeps existing UI imports stable.
import ru from './messages-ru.js';
import en from './messages-en.js';
import kk from './messages-kk.js';
export const catalogs = {ru, en, kk};
export const languages = ['ru', 'en', 'kk'];
const listeners = new Set();
const recipes = new Map();
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const DATA_PARAMS = new Set(['id','name','title','criterion','model','group','time']);
let language = 'ru';
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const code = value.toLowerCase().split(/[-_]/)[0];
  return code === 'kz' ? 'kk' : languages.includes(code) ? code : null;
}
export function storedLanguage() {
  try { return normalizeLanguage(globalThis.localStorage?.getItem('cqa-language')); } catch { return null; }
}
export const currentLanguage = () => language;
export const locale = () => ({ru:'ru-RU',en:'en-US',kk:'kk-KZ'})[language];
export function setLanguage(value, {persist = true} = {}) {
  const next = normalizeLanguage(value);
  if (!next) return false;
  if (persist) { try { globalThis.localStorage?.setItem('cqa-language',next); } catch { /* Session preference still works. */ } }
  if (next === language) return true;
  language = next;
  for (const listener of [...listeners]) listener(next);
  return true;
}
export function onLanguageChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function format(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g,(placeholder,name)=>has(params,name)?String(params[name]):placeholder);
}
function remember(value, read) {
  recipes.set(value, read);
  if (recipes.size > 12000) recipes.delete(recipes.keys().next().value);
  return value;
}
export function formatNumber(value, options = {}) {
  const read = () => new Intl.NumberFormat(locale(), {useGrouping:false,...options}).format(value);
  return remember(read(), read);
}
export function formatDate(value, options = {}) {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const read = () => new Intl.DateTimeFormat(locale(), {dateStyle:'medium',timeStyle:'short',...options}).format(date);
  return remember(read(),read);
}
function messageReader(key, params, plural) {
  const values = {...params};
  const nested = new Map(Object.entries(values).flatMap(([name,value]) => !DATA_PARAMS.has(name) && recipes.has(value) ? [[name, recipes.get(value)]] : []));
  return () => {
    const selected = plural ? `${key}.${pluralForm(values.n)}` : key;
    const catalog = catalogs[language];
    if (!has(catalog,selected)) return selected;
    const localized = Object.fromEntries(Object.entries(values).map(([name,value]) => [name,
      nested.has(name) ? nested.get(name)() : !DATA_PARAMS.has(name) && typeof value === "string" && numericReader(value) ? numericReader(value)() : typeof value === 'number' && !DATA_PARAMS.has(name) ? new Intl.NumberFormat(locale(),{useGrouping:false,maximumFractionDigits:8}).format(value) : value]));
    return format(catalog[selected],localized);
  };
}
export function t(key, params) {
  if (!has(catalogs[language],key)) return key;
  const read = messageReader(key,params);
  return remember(read(),read);
}
// Gross-error kinds are checklist ids. The official ones have catalog names (grossKind.<id>); a kind
// typed into the checklist editor shows its id with underscores and dashes read as spaces.
function grossKindName(kind) {
  const id = String(kind ?? '').trim();
  const key = `grossKind.${id}`;
  return has(catalogs[language],key) ? catalogs[language][key] : id.replace(/[_-]+/g,' ').trim();
}
export function grossKindsText(kinds) {
  const list = Array.isArray(kinds) ? kinds : [];
  const read = () => list.map(grossKindName).filter(Boolean).join(', ');
  return remember(read(),read);
}
export function pluralForm(n) {
  if (language === 'kk') return 'many'; // Numerals take the same noun form in Kazakh.
  const form = new Intl.PluralRules(locale()).select(Number(n));
  return form === 'one' || form === 'few' ? form : 'many';
}
export function tp(base,n,params={}) {
  const read = messageReader(base,{...params,n},true);
  return remember(read(),read);
}
// Capture a rendered UI message's recipe at creation time, including composed status lines.
// Capturing (rather than reverse-translating at switch time) disambiguates identical labels.
function numericReader(text) {
  const match = /^([+−-]?)(\d+)(?:([.,])(\d+))?( ?%?)$/.exec(text);
  if (!match) return null;
  const places = match[4]?.length ?? 0;
  const value = Number(match[2]+(match[4] ? '.'+match[4] : ''));
  return () => match[1]+new Intl.NumberFormat(locale(),{useGrouping:false,minimumFractionDigits:places,maximumFractionDigits:places}).format(value)+match[5];
}
export function captureMessage(value) {
  const text = String(value ?? '');
  if (recipes.has(text)) return recipes.get(text);
  const number = numericReader(text);
  if (number) return number;
  const pieces = text.split(/( · | → )/);
  const readers = pieces.map((part) => recipes.get(part));
  if (readers.some(Boolean)) return () => pieces.map((part,i) => readers[i] ? readers[i]() : part).join('');
  return () => text;
}

// Known server status notes (for example the demo-reference warning) also have catalog entries.
for (const catalog of Object.values(catalogs)) {
  for (const [key,value] of Object.entries(catalog)) {
    if (!value.includes('{')) recipes.set(value,messageReader(key));
  }
}
