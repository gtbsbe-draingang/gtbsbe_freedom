import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measurementsFor } from '../../src/ui/voice-measurements.js';
const voice = {channel:'voice call',transcript:[{}, {}, {}],voice_measurements:[{message_index:0},{message_index:1},{message_index:2},{message_index:8}]};
test('voice features follow the criterion evidence and checked range only', () => {
  assert.deepEqual(measurementsFor(voice,{evidence:[{message_index:1}]}), [{message_index:1}]);
  assert.deepEqual(measurementsFor(voice,{checked_range:{from:1,to:2}}), [{message_index:1},{message_index:2}]);
  assert.deepEqual(measurementsFor(voice,{}), []);
  assert.deepEqual(measurementsFor({...voice,channel:'agent chat'},{evidence:[{message_index:1}]}), []);
});
