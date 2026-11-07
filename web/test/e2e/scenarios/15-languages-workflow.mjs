import assert from 'node:assert/strict';
export const name='languages-workflow';
export const path='/#/c/DEV%3Ap1-ru-001';
export const viewports=[[1400,900],[600,800]];
const s=name=>`[data-test="${name}"]`;
async function choose(page,lang){await page.eval(`(()=>{const s=document.querySelector('[data-test="ui-language"]');s.value='${lang}';s.dispatchEvent(new Event('change'));})()`)}
async function until(page,expression){const end=Date.now()+10000;while(!await page.eval(expression)){if(Date.now()>end)throw new Error('workflow language timeout');await page.sleep(25)}}
export async function run(page){
 await page.waitFor(s('run-eval'),10000);
 await until(page,`!document.querySelector('[data-test="run-eval"]').disabled`);
 await page.eval(`window.__cqaTest.store.set({pane:'scorecard'})`);
 await page.click(s('run-eval'));await page.waitFor(s('total'),10000);
 const original=await page.text(s('why'));
 const rawTotal=await page.text(s('total'));
 await choose(page,'en');assert.equal(await page.text(s('run-eval')),'Re-evaluate');assert.equal(await page.text(s('why')),original);
 assert.equal(await page.text(s('total')),rawTotal.replace(',','.'));
 await page.click(s('dispute'));await page.waitFor(s('appeal-comment'));
 await page.eval(`window.__comment=document.querySelector('[data-test="appeal-comment"]');window.__comment.value='Оценка';window.__comment.dispatchEvent(new Event('input',{bubbles:true}))`);
 await choose(page,'kk');assert.equal(await page.text(s('appeal-submit')),'Апелляция беру');
 assert.equal(await page.eval(`window.__comment===document.querySelector('[data-test="appeal-comment"]')&&window.__comment.value==='Оценка'`),true);
 await page.click(s('appeal-submit'));await until(page,`!document.querySelector('[data-test="appeal-drawer"]')`);
 const id=await page.eval(`window.__cqaTest.api.listAppeals().then(rows=>rows[0].id)`);
 await page.eval(`window.__cqaTest.store.set({role:'reviewer'});location.hash='#/appeals/'+encodeURIComponent('${id}')`);
 await page.waitFor(s('decision-reason'),10000);
 await page.eval(`window.__reason=document.querySelector('[data-test="decision-reason"]');window.__reason.value='Оценка';window.__reason.dispatchEvent(new Event('input',{bubbles:true}))`);
 await choose(page,'en');assert.equal(await page.text(s('decision-submit')),'Save decision');
 assert.equal(await page.eval(`window.__reason===document.querySelector('[data-test="decision-reason"]')&&window.__reason.value==='Оценка'`),true);
 assert.equal(await page.text(s('review-comment')),'Оценка','reviewed comments are data, not interface labels');
 // Error messages, import dialogs and their typed data also update without rebuilding.
 await page.eval(`location.hash='#/'`);await page.waitFor(s('queue-item'),10000);
 if(page.viewport[0]<900)await page.click(s('queue-toggle'));
 await page.click(s('open-loader'));await page.waitFor(s('loader'));
 await page.eval(`window.__group=document.querySelector('[data-test="group-id"]');window.__group.value='CONTROL-DRAFT'`);
 await choose(page,'kk');
 assert.equal(await page.eval(`window.__group===document.querySelector('[data-test="group-id"]')&&window.__group.value==='CONTROL-DRAFT'`),true);
 assert.equal(await page.eval(`document.querySelector('[data-test="group-id"]').placeholder`),'мысалы, CTRL');
 await page.click(s('loader-close'));
 // Waveform and native playback state survive switching because no player is remounted.
 await page.eval(`location.hash='#/c/DEV%3Ap4-ru-001'`);await page.waitFor(`${s('player')} audio`,10000);
 await until(page,`document.querySelector('audio').readyState>=1`);
 await page.eval(`window.__audio=document.querySelector('audio');window.__audio.currentTime=20`);
 await choose(page,'en');
 assert.equal(await page.eval(`window.__audio===document.querySelector('audio')&&Math.abs(window.__audio.currentTime-20)<1`),true);
 assert.equal(await page.eval(`document.querySelector('[data-test="player-play"]').getAttribute('aria-label')`),'Play');
 await choose(page,'ru');assert.equal(await page.eval(`document.documentElement.lang`),'ru');
}
