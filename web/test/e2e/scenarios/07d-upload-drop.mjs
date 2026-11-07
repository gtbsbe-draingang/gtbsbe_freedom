import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
export const name='upload-drop';
export const path='/?language=kk#/';
export const viewports=[[1400,900],[600,800]];
const example=readFileSync(new URL('../../../../contract/examples/conversation.chat-ru.json',import.meta.url),'utf8');
const s=name=>`[data-test="${name}"]`;
async function until(page,expression){const end=Date.now()+8000;while(!await page.eval(expression)){if(Date.now()>end)throw new Error('upload drop condition timed out');await page.sleep(25)}}
async function language(page,value){await page.eval(`(()=>{const el=document.querySelector('[data-test="ui-language"]');el.value='${value}';el.dispatchEvent(new Event('change',{bubbles:true}));})()`)}
async function drop(page,files,target=s('upload-dropzone')){
 return page.eval(`(()=>{const transfer=new DataTransfer();for(const f of ${JSON.stringify(files)})transfer.items.add(new File([f.text],f.name,{type:f.type??'application/json'}));const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer});document.querySelector(${JSON.stringify(target)}).dispatchEvent(event);return event.defaultPrevented})()`);
}
export async function run(page){
 await page.waitFor(s('queue-item'),10000);
 if(page.viewport[0]<900)await page.click(s('queue-toggle'));
 await page.click(s('open-loader'));await page.waitFor(s('upload-dropzone'));
 assert.equal(await page.text(s('choose-upload-file')),'Файл таңдау');
 assert.equal(await page.text(s('upload-filename')),'Файл таңдалмаған');
 assert.equal(await page.eval(`getComputedStyle(document.querySelector('[data-test="upload-file"]')).display`),'none','browser-language file UI is hidden');
 // The button delegates to the native input from a user action, retaining keyboard accessibility.
 await page.eval(`window.__picker=0;const input=document.querySelector('[data-test="upload-file"]');window.__realClick=input.click;input.click=()=>{window.__picker++}`);
 await page.click(s('choose-upload-file'));assert.equal(await page.eval('window.__picker'),1);
 await page.eval(`document.querySelector('[data-test="upload-file"]').click=window.__realClick`);
 await language(page,'ru');assert.equal(await page.text(s('choose-upload-file')),'Выбрать файл');assert.equal(await page.text(s('upload-filename')),'Файл не выбран');
 await language(page,'en');assert.equal(await page.text(s('choose-upload-file')),'Choose file');assert.equal(await page.text(s('upload-filename')),'No file selected');
 await page.eval(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['{}'],'test.json',{type:'application/json'}));const zone=document.querySelector('[data-test="upload-dropzone"]');zone.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`);
 assert.equal(await page.eval(`document.querySelector('[data-test="upload-dropzone"]').classList.contains('is-dragging')`),true);
 assert.match(await page.text(s('upload-dropzone')),/Release to upload/);
 await page.eval(`document.querySelector('[data-test="upload-dropzone"]').dispatchEvent(new DragEvent('dragleave',{bubbles:true}))`);
 assert.equal(await page.eval(`document.querySelector('[data-test="upload-dropzone"]').classList.contains('is-dragging')`),false);
 assert.equal(await drop(page,[{name:'image.png',text:'not json',type:'image/png'}]),true,'file drop prevents browser navigation');
 assert.match(await page.text(s('loader-error')),/Only JSON files/);
 await drop(page,[{name:'one.json',text:'{}'},{name:'two.json',text:'{}'}]);assert.match(await page.text(s('loader-error')),/one JSON file/);
 await drop(page,[{name:'broken.json',text:'{ not json'}]);await until(page,`document.querySelector('[data-test="loader-error"]')?.textContent.includes('not valid JSON')`);
 // A held upload proves the picker/drop paths share one lock and cannot double-import.
 await page.eval(`(()=>{const api=window.__cqaTest.api;const real=api.uploadConversations;window.__uploads=0;api.uploadConversations=async payload=>{window.__uploads++;if(window.__uploads===1)await new Promise(resolve=>{window.__release=resolve});return real(payload)}})()`);
 await drop(page,[{name:'Оценка.json',text:example}]);await until(page,'window.__uploads===1');
 assert.equal(await page.eval(`document.querySelector('[data-test="choose-upload-file"]').disabled`),true);
 await drop(page,[{name:'another.json',text:example}]);assert.equal(await page.eval('window.__uploads'),1,'drop while busy does not import again');
 await language(page,'kk');assert.equal(await page.text(s('upload-filename')),'Оценка.json','actual filename remains verbatim');
 await page.eval('window.__release()');await page.waitFor(s('import-summary'),10000);
 assert.equal(await page.eval(`document.querySelector('[data-test="upload-file"]').value`),'','same file can be picked again');
 assert.equal(await page.eval(`document.querySelector('[data-test="choose-upload-file"]').disabled`),false);
 // Re-select the same name through the picker; it runs through the same import path.
 await page.eval(`(()=>{const input=document.querySelector('[data-test="upload-file"]');const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(example)}],'Оценка.json',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await until(page,`window.__uploads===2 && !document.querySelector('[data-test="choose-upload-file"]').disabled`);
 assert.equal(await drop(page,[{name:'outside.json',text:example}],'.cqa-drawer-scrim'),true);
 assert.equal(await page.eval('window.__uploads'),2,'outside-panel drops do not upload or navigate');
 assert.equal(await page.eval(`document.documentElement.scrollWidth<=innerWidth`),true);
}
