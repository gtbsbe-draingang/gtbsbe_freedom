import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waveformPeaks, speakerWindows, splitWaveform } from '../../src/domain/waveform.js';

test('waveform reflects recorded energy, preserves silence, and does not cancel opposite stereo phases', () => {
  assert.deepEqual(waveformPeaks([new Float32Array([0,0,1,1])], 2), [0,1]);
  assert.deepEqual(waveformPeaks([new Float32Array([1,1]),new Float32Array([-1,-1])], 1), [1]);
  assert.deepEqual(waveformPeaks([new Float32Array(4)], 2), [0,0]);
  assert.deepEqual(waveformPeaks([], 2), []);
});
test('speaker rows follow transcript boundaries, excluding unknown offsets and system events', () => {
  const turns = [{speaker:'client'},{speaker:'operator'},{speaker:'system'},{speaker:'client'}];
  const windows = speakerWindows(turns, [0,2,5,null], 8);
  assert.deepEqual(windows, [{role:'client',from:0,to:2},{role:'operator',from:2,to:5}]);
  assert.deepEqual(splitWaveform([1,1,1,1,1,1,1,1], windows, 8, 'operator'), [0,0,1,1,1,0,0,0]);
});
test('equal starts belong to the later turn and out-of-order turns are sorted', () => {
  assert.deepEqual(speakerWindows([{speaker:'client'},{speaker:'operator'},{speaker:'client'}],[2,2,0],4),[
    {role:'client',from:0,to:2},{role:'operator',from:2,to:4}]);
  assert.deepEqual(speakerWindows([],[],0),[]);
});
