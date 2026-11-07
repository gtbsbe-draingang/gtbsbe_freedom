// Localized bindings update only owned text nodes and accessible attributes. No form or view is
// recreated, and listeners, drafts, focus, playback and in-flight jobs keep their original state.
import {captureMessage,onLanguageChange,currentLanguage,t} from './ru.js';
const texts = new WeakMap();
const attributes = new WeakMap();
const ATTRIBUTES = new Set(['title','placeholder','aria-label','aria-valuetext']);
export function bindLocalizedNode(node,value) {
  const read = captureMessage(value);
  node.textContent = read();
  texts.set(node,{read,rendered:node.textContent});
}
export function setLocalizedText(element,value) {
  const read = captureMessage(value);
  const rendered = element.closest?.('[data-i18n-verbatim]') ? String(value ?? '') : read();
  element.textContent = rendered;
  texts.set(element,{read,rendered});
}
export function setLocalizedAttribute(element,name,value) {
  if (!ATTRIBUTES.has(name)) {element.setAttribute(name,String(value)); return;}
  const read = captureMessage(value);
  const rendered = element.closest?.('[data-i18n-verbatim]') ? String(value) : read();
  element.setAttribute(name,rendered);
  let bindings = attributes.get(element);
  if (!bindings) attributes.set(element,bindings=new Map());
  bindings.set(name,{read,rendered});
}
export function localizeRoot(root) {
  root.lang = currentLanguage();
  for (const element of [root,...root.querySelectorAll('*')]) {
    if (element.closest('[data-i18n-verbatim]')) continue;
    const text = texts.get(element);
    if (text && element.textContent === text.rendered) {
      const next = text.read();
      if (next !== text.rendered) element.textContent = next;
      text.rendered = next;
    }
    for (const node of element.childNodes) {
      if (node.nodeType !== 3) continue;
      const binding = texts.get(node);
      if (binding && node.textContent === binding.rendered) {
        const next = binding.read();
        if (next !== binding.rendered) node.textContent = next;
        binding.rendered = next;
      }
    }
    for (const [name,binding] of attributes.get(element) ?? []) {
      if (element.getAttribute(name) !== binding.rendered) continue;
      const next = binding.read();
      if (next !== binding.rendered) element.setAttribute(name,next);
      binding.rendered = next;
    }
  }
}
export function bindRootLanguage(root) {
  const refresh = () => {
    localizeRoot(root);
    for (const select of root.querySelectorAll('[data-test="ui-language"]')) {
      select.value = currentLanguage();
      select.setAttribute('aria-label',t('language.label'));
    }
    if (document.querySelector('.cqa') === root && !root.classList.contains('cqa--compact')) {
      document.documentElement.lang = currentLanguage();
      document.title = t('app.title');
    }
  };
  refresh();
  return onLanguageChange(refresh);
}
