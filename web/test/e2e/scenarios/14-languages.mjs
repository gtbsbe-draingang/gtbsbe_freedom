import assert from 'node:assert/strict';
export const name='languages';
export const path='/#/checklists/new/0/edit';
export const viewports=[[1400,900],[600,800]];
const s=name=>`[data-test="${name}"]`;
async function until(page,expression){const deadline=Date.now()+8000;while(!await page.eval(expression)){if(Date.now()>deadline)throw new Error('language state timeout');await page.sleep(25)}}
async function choose(page,lang){await page.eval(`(()=>{const select=document.querySelector('${s('ui-language')}');select.value='${lang}';select.dispatchEvent(new Event('change',{bubbles:true}));})()`)}
export async function run(page){
  await page.waitFor(s('editor-save'),10000);
  await page.eval(`window.__noReload=42;window.__draftField=document.querySelector('[data-test="editor-name"]')`);
  // Locate the draft name by its label if its test hook changes; keep the actual node identity.
  const field=await page.eval(`(()=>{const field=document.querySelector('[data-test="editor-name"]')||document.querySelector('[data-test="editor"] input');window.__draftField=field;field.value='Оценка';field.dispatchEvent(new Event('input',{bubbles:true}));return field.getAttribute('data-test')})()`);
  await choose(page,'en');
  assert.equal(await page.text(s('nav-workspace')),'Evaluation');
  assert.equal(await page.text(s('editor-save')),'Create checklist');
  assert.equal(await page.eval('document.documentElement.lang'),'en');
  assert.equal(await page.eval('window.__noReload'),42,'switch does not reload');
  assert.equal(await page.eval(`window.__draftField===document.querySelector('[data-test="${field}"]') && window.__draftField.value==='Оценка'`),true,'draft node and content survive');
  assert.equal(await page.eval('location.hash'),'#/checklists/new/0/edit');
  await choose(page,'kk');assert.equal(await page.text(s('nav-workspace')),'Бағалау');assert.equal(await page.text(s('editor-save')),'Тексеру парағын жасау');
  assert.equal(await page.eval('window.__draftField.value'),'Оценка');
  await choose(page,'ru');assert.equal(await page.text(s('editor-save')),'Создать чек-лист');
  await page.eval(`(()=>{for(const [test,value] of [['crit-title','Custom criterion'],['crit-wording','Check the conversation']]){const field=document.querySelector('[data-test="'+test+'"]');if(field){field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));}}})()`);
  // Save the retained draft after switching; the backend receives the original data.
  await page.click(s('editor-save'));
  await page.waitFor(s('editor-saved'),10000);
  assert.ok(await page.eval(`window.__cqaTest.api.listChecklists().then(rows=>rows.some(row=>row.name==='Оценка'))`));
  for(const [lang,nav] of [['en','Evaluation'],['kk','Бағалау'],['ru','Оценка']]){
    await choose(page,lang);assert.equal(await page.text(s('nav-workspace')),nav);
    for(const [route,test] of [['checklists','checklist-create'],['appeals','appeals-empty'],['analytics','reports-ready'],['compare','compare-page']]){
      await page.eval(`location.hash='#/${route}'`);
      await page.waitFor(s(test),10000);
      assert.equal(await page.eval(`document.documentElement.scrollWidth<=innerWidth`),true,`${lang}/${route}: no overflow`);
    }
  }
  // A conversation's original text never becomes interface text, even when it matches a label.
  await page.eval(`(async()=>{await window.__cqaTest.api.importDataset('DEV');const api=window.__cqaTest.api;const real=api.getConversation;api.getConversation=async id=>{const c=await real(id);return {...c,transcript:c.transcript.map((m,i)=>i===0?{...m,text:'Оценка'}:m)}};location.hash='#/c/DEV%3Ap1-ru-001'})()`);
  await page.waitFor('.cqa-msg-text',10000);
  await choose(page,'en');assert.equal(await page.text('.cqa-msg-text'),'Оценка');
  await page.eval(`(async()=>{const imported=await window.__cqaTest.api.uploadConversations({records:[{conversation_id:'123.45',channel:'agent chat',language:'RU',transcript:[{speaker:'client',timestamp:'00:00',text:'Оценка'}]}]});location.hash='#/c/'+encodeURIComponent(imported.group_id+':123.45')})()`);
  await until(page, `document.querySelector('[data-test="transcript-title"]')?.textContent==='123.45'`);
  await choose(page,'kk');assert.equal(await page.text(s('transcript-title')),'123.45','numeric-looking identifiers remain verbatim');
  await choose(page,'en');
  await page.goto('/?reload=language#/' );await page.waitFor(s('ui-language'),10000);
  assert.equal(await page.text(s('nav-workspace')),'Evaluation','preference survives reload');
  await page.goto('/?language=kk#/');await page.waitFor(s('ui-language'),10000);
  assert.equal(await page.text(s('nav-workspace')),'Бағалау','explicit host language wins over saved preference');
}
