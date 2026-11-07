import assert from "node:assert/strict";
export const name = "extras";
export const path = "/#/";
export const viewports = [[1400, 900], [600, 800]];
const s = (name) => `[data-test="${name}"]`;
async function until(page, expression) {
  const deadline = Date.now()+10000;
  while (!await page.eval(expression)) {
    if(Date.now()>deadline) throw new Error('extras condition timed out');
    await page.sleep(25);
  }
}
export async function run(page) {
  await page.waitFor(s("queue-item"),10000);
  assert.equal(await page.eval(`document.querySelector('${s("export-csv")}').tagName`), 'A');
  assert.ok(await page.eval(`document.querySelector('${s("export-csv")}').hasAttribute('href')`));
  for (const language of ['KZ','EN']) {
    await page.eval(`(async()=>{const rows=await window.__cqaTest.api.listConversations({group_id:'DEV'});location.hash='#/c/'+encodeURIComponent(rows.find(r=>r.language==='${language}').id)})()`);
    await page.waitFor(s("translate-toggle"),10000);
    await page.click(s("translate-toggle"));
    await until(page, `document.querySelectorAll('.msg-translation').length > 0`);
    assert.equal(await page.count('.msg-translation'),await page.count(s("msg")), 'one translation per original line');
    assert.equal(await page.count('.cqa-msg-text'),await page.count(s("msg")), 'originals remain');
    await page.click(s("translate-toggle"));
    assert.equal(await page.count('.msg-translation'),0);
    // A cached toggle works without a further API call.
    await page.eval(`window.__translationReal=window.__cqaTest.api.getTranslation;window.__cqaTest.api.getTranslation=()=>{throw new Error('cache should be used')}`);
    await page.click(s("translate-toggle"));
    assert.equal(await page.count('.msg-translation'),await page.count(s("msg")));
    await page.eval(`window.__cqaTest.api.getTranslation=window.__translationReal`);
  }
  // Failed translations leave the original visible and can be retried.
  await page.eval(`window.__cqaTest.api.getTranslation=async()=>{throw new Error('translation unavailable')};location.hash='#/'`);
  await page.waitFor(s('queue-item'),10000);
  await page.eval(`(async()=>{const rows=await window.__cqaTest.api.listConversations({group_id:'DEV'});location.hash='#/c/'+encodeURIComponent(rows.find(r=>r.language==='KZ').id)})()`);
  await page.waitFor(s('translate-toggle'),10000);
  await page.click(s('translate-toggle'));
  await until(page, `document.querySelector('${s('translate-toggle')}').textContent==='Повторить перевод'`);
  assert.equal(await page.count('.msg-translation'),0);
  await page.eval(`window.__cqaTest.api.getTranslation=window.__translationReal`);
  await page.click(s('translate-toggle'));
  await until(page, `document.querySelectorAll('.msg-translation').length>0`);

  // Use a real DEV recording with contract-shaped measurements and an evaluated criterion.
  await page.eval(`(async()=>{
    const {api}=window.__cqaTest;
    const id='DEV:p4-ru-001';
    const config=await api.getConfig();
    const job=await api.startEvaluations({conversations:[id],...config.default_checklist});
    for(let n=0;n<100;n++) { if((await api.getJob(job.id)).status==='done')break;await new Promise(r=>setTimeout(r,30)); }
    const real=api.getConversation;
    api.getConversation=async(id)=>{const c=await real(id);return id==='DEV:p4-ru-001'?{...c,voice_measurements:[{message_index:2,from_seconds:8,to_seconds:13.6,pitch_range:5.8,rate_wpm:142,pauses:0.6,overlap:0}]}:c};
    const results=api.listEvaluations;
    api.listEvaluations=async(filters)=>{const list=await results(filters);return list.map(e=>e.conversation===id?{...e,results:e.results.map((r,i)=>i===0?{...r,evidence:[{message_index:2,role:'supports',quote:''}]}:r)}:e)};
    location.hash='#/c/'+encodeURIComponent(id);
  })()`);
  await page.waitFor(s('voice-measurements'),10000);
  assert.match(await page.text(s('voice-measurements')), /Измеренные признаки \+ оценка модели/);
  await page.eval(`window.__cqaTest.store.set({pane:'scorecard'})`);
  await page.click(s('voice-seek'));
  await until(page, `Math.abs(document.querySelector('${s('player')} audio').currentTime-8)<0.5`);
  assert.equal(await page.eval(`window.__cqaTest.store.get().pane`),'transcript');
  assert.equal(await page.eval(`document.documentElement.scrollWidth <= innerWidth`),true);
  await page.eval(`location.hash='#/c/DEV%3Ap1-ru-001'`);
  await page.waitFor(s('transcript-msgs'),10000);
  await until(page, `document.querySelector('${s('transcript-title')}').textContent==='p1-ru-001'`);
  assert.equal(await page.count(s('translate-toggle')),0,'Russian needs no translation toggle');
  assert.equal(await page.count(s('voice-measurements')),0,'chat has no voice features');
}
