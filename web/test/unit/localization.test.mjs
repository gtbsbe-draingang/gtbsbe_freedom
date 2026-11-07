import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {catalogs,setLanguage,currentLanguage,normalizeLanguage,storedLanguage,t,tp,captureMessage,formatNumber,formatDate} from '../../src/i18n/ru.js';
afterEach(()=>setLanguage('ru',{persist:false}));
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();
test('all three catalogs contain every key with the same placeholders',()=>{
  const keys=Object.keys(catalogs.ru).sort();
  for(const lang of ['en','kk']) {
    assert.deepEqual(Object.keys(catalogs[lang]).sort(),keys);
    for(const key of keys){
      assert.ok(catalogs[lang][key].trim(),`${lang}:${key}`);
      assert.deepEqual(placeholders(catalogs[lang][key]),placeholders(catalogs.ru[key]),`${lang}:${key}`);
    }
  }
  assert.ok(keys.length>=477);
});
test('live message recipes use the correct plural rules and nested UI labels, preserving data parameters',()=>{
  const count=captureMessage(tp('batch.dialogs',21));
  const role=captureMessage(t('role.current',{role:t('role.controller')}));
  const name=captureMessage(t('editor.saved',{name:'Оценка',version:2}));
  setLanguage('en',{persist:false});
  assert.equal(count(),'21 conversations');
  assert.equal(role(),'Role: Controller');
  assert.ok(name().includes('“Оценка”'));
  setLanguage('kk',{persist:false});
  assert.equal(count(),'21 диалог');
  assert.equal(tp('batch.dialogs',1),'1 диалог');
});
test('numbers and dates follow selected locale, including after an in-place switch',()=>{
  const number=captureMessage(formatNumber(1234.5,{minimumFractionDigits:2}));
  const date=captureMessage(formatDate('2026-11-07T12:30:00Z',{timeZone:'UTC'}));
  assert.equal(number(),'1234,50');
  const ru=date();setLanguage('en',{persist:false});
  assert.equal(number(),'1234.50');assert.notEqual(date(),ru);
  setLanguage('kk',{persist:false});assert.equal(number(),'1234,50');
  assert.equal(formatDate('not-a-date'),'—');assert.equal(formatDate(null),'—');
});
test('blocked storage still allows an in-session preference; invalid languages do not change it',()=>{
  const prior=globalThis.localStorage;
  globalThis.localStorage={getItem(){throw new Error('blocked')},setItem(){throw new Error('blocked')}};
  try {
    assert.equal(storedLanguage(),null);assert.equal(setLanguage('en'),true);
    assert.equal(currentLanguage(),'en');assert.equal(setLanguage('invalid'),false);assert.equal(currentLanguage(),'en');
  } finally {globalThis.localStorage=prior;}
  assert.equal(normalizeLanguage('kk-KZ'),'kk');assert.equal(normalizeLanguage('KZ'),'kk');assert.equal(normalizeLanguage('en-US'),'en');
});
test('gross-error kinds show readable, live-translated names; unknown kinds show the id without underscores',async()=>{
  const {grossKindsText}=await import('../../src/i18n/ru.js');
  const official=['insult','paid_service_outside_company','confidential_disclosure'];
  for(const lang of ['ru','en','kk']) {
    setLanguage(lang,{persist:false});
    for(const kind of official) assert.ok(catalogs[lang][`grossKind.${kind}`]?.trim(),`${lang}:${kind}`);
    assert.doesNotMatch(grossKindsText(official),/_/);
  }
  setLanguage('ru',{persist:false});
  const badge=captureMessage(t('scorecard.grossOnKinds',{kinds:grossKindsText(['paid_service_outside_company'])}));
  assert.equal(badge(),'грубая ошибка: предложение платной услуги в обход компании');
  setLanguage('en',{persist:false});
  assert.equal(badge(),'gross error: offering a paid service outside the company');
  assert.equal(grossKindsText(['insult',' my_custom-kind ']),'insulting the client, my custom kind');
  assert.equal(grossKindsText([]),'');
});
