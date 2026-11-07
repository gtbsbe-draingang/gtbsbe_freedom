# Interface languages

The interface supports Russian (`ru`), English (`en`) and Kazakh (`kk`, with `kz` accepted as an input alias). The header selector changes the interface in place. It does not reload the page, recreate forms, reset playback, refetch data, or alter evaluation requests.

The choice is saved in browser local storage as `cqa-language`. If storage is unavailable, it still works for the current session. Initial precedence is mount options (`language` or `lang`), URL parameters (`language` or `lang`), runtime config, saved choice, then Russian. For example: `/?language=kk#/checklists`. A host can also call the mount handle's `setLanguage('en')`. Language codes set the component's `lang`; the first standalone instance also sets the document language and title. Embedded components leave their host document language alone.

## Catalogs and text bindings

`src/i18n/messages-{ru,en,kk}.js` contain matching catalogs. `src/i18n/ru.js` is the shared runtime and compatibility import for `t`, `tp` and `format`. Every interface message must exist in all three catalogs with the same interpolation placeholders. The unit tests enforce this.

The DOM builder captures the localization recipe when it creates a text node or accessible attribute. On a language change, `src/i18n/dom.js` updates those bindings inside the mounted component, leaving the elements, listeners, focus, selections, form values and pending operations intact. There is no string substitution inside user content. Composed UI messages capture their nested message recipes; data interpolation parameters (names, criterion titles, identifiers, models and group names) remain verbatim.

Use `h(..., {text: t('key'), attrs: {'aria-label': t('key')}})` for new controls. For imperative updates, use `setLocalizedText(element, t('key'))` and `setLocalizedAttribute(element, 'title', t('key'))`. Native textContent writes bypass the binding and should only be used for content that is deliberately not localized.

Set `verbatim: true` on data-owned text: transcripts, checklist and section names, criterion wording, evidence quotes, model explanations, appeal comments, decision reasons and identifiers. This also protects content that happens to equal an interface label, such as a conversation message saying “Оценка”. Never translate editable input values while switching languages. New defaults are generated in the current language; after creation they belong to the draft.

Use `formatNumber` and `formatDate` for newly displayed numbers and human-readable dates. Recorded timestamps and audio clocks retain their technical format. Numeric score display bindings localize the already-rounded display text; deterministic score calculation and exported data formats do not change. Russian uses one/few/many plural forms, English singular/plural, and Kazakh one noun form after numerals.

## Validation

```bash
CQA_DATA_DIR=../data npm run check
```

The language browser scenarios cover all languages at desktop and 600 px, retained checklist drafts saved after switching, retained appeal/reviewer/import fields, unchanged model and transcript content, playback position, preference persistence and explicit host overrides. General browser checks enforce strict CSP and horizontal-overflow constraints.
