// Opt-in native Chrome playback against the real API and five private DEV MP3s.
// Start backend/tests/manual/audio_browser_server.py first. No organizer URLs leave it.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { launch } from './cdp.mjs';

const origin = process.env.AUDIO_CHECK_ORIGIN || 'http://127.0.0.1:8766';
const browser = await launch();
const results = [];
try {
  await browser.goto(`${origin}/_audio_check`);
  const version = await browser.send('Browser.getVersion');
  for (let i = 1; i <= 5; i++) {
    const call = `p4-ru-${String(i).padStart(3, '0')}`;
    const path = `/api/conversations/DEV:${call}/audio`;
    const { result, exceptionDetails } = await browser.send('Runtime.evaluate', {
      userGesture: true, awaitPromise: true, returnByValue: true,
      expression: `(async () => {
        const audio = document.createElement('audio');
        audio.controls = true;
        document.body.replaceChildren(audio);
        const event = (name) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(name + ' timeout')), 15000);
          audio.addEventListener(name, () => { clearTimeout(timer); resolve(); }, {once:true});
          audio.addEventListener('error', () => { clearTimeout(timer); reject(new Error('media error')); }, {once:true});
        });
        const metadata = event('loadedmetadata');
        audio.src = ${JSON.stringify(path)};
        await metadata;
        await audio.play();
        await new Promise(resolve => setTimeout(resolve, 600));
        const played = audio.currentTime;
        audio.pause();
        const target = Math.min(30, audio.duration / 2);
        const seeking = event('seeked');
        audio.currentTime = target;
        await seeking;
        const sought = audio.currentTime;
        await audio.play();
        await new Promise(resolve => setTimeout(resolve, 600));
        const resumed = audio.currentTime;
        audio.pause();
        const ranges = [];
        for (const range of ['bytes=1024-2047', 'bytes=-512', 'bytes=999999999-']) {
          const response = await fetch(${JSON.stringify(path)}, {headers:{Range:range}});
          ranges.push({range,status:response.status,contentRange:response.headers.get('content-range'),
            bytes:(await response.arrayBuffer()).byteLength});
        }
        const duration = audio.duration;
        audio.removeAttribute('src'); audio.load();
        return {duration,played,target,sought,resumed,ranges};
      })()`,
    });
    assert.ok(!exceptionDetails, exceptionDetails?.exception?.description);
    const data = result.value;
    assert.ok(data.duration > 30 && data.played > 0.2, `${call}: playback`);
    assert.ok(Math.abs(data.sought - data.target) < 0.5, `${call}: seek`);
    assert.ok(data.resumed > data.sought + 0.2, `${call}: resume`);
    assert.deepEqual(data.ranges.map(r => r.status), [206, 206, 416]);
    assert.deepEqual(data.ranges.map(r => r.bytes), [1024, 512, 0]);
    assert.match(data.ranges[0].contentRange, /^bytes 1024-2047\/\d+$/);
    results.push({call, ...data});
  }
  const retries = await (await fetch(`${origin}/_audio_check/stats`)).json();
  for (const {call} of results) {
    assert.equal(retries[call].resolutions, 2, `${call}: fresh resolution after expiry`);
    assert.equal(retries[call].expired, 1, `${call}: exactly one expired response`);
    assert.ok(retries[call].ranges >= 3);
  }
  const report = {scope:'Native Chrome + real API + real DEV recordings; upstream replay, not live organizer or product UI acceptance',
    browser:version.product, checkedAt:new Date().toISOString(), results, retries};
  if (process.env.AUDIO_CHECK_OUTPUT) writeFileSync(process.env.AUDIO_CHECK_OUTPUT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
