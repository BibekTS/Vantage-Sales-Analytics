import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadLabelMap,
  createCustomizer,
  createStreamCustomizer,
} from './customize.mjs';

const LABELS = { Spotter: 'DataAnalyzer', Liveboard: 'Dashboard' };
const { customize } = createCustomizer(LABELS);

test('replaces a term on word boundaries only', () => {
  assert.equal(customize('Ask Spotter a question'), 'Ask DataAnalyzer a question');
  assert.equal(customize('Spotters and SpotterX stay'), 'Spotters and SpotterX stay');
  assert.equal(customize('(Spotter) and Spotter.'), '(DataAnalyzer) and DataAnalyzer.');
});

test('preserves case', () => {
  assert.equal(customize('spotter'), 'dataAnalyzer');
  assert.equal(customize('Spotter'), 'DataAnalyzer');
  assert.equal(customize('SPOTTER'), 'DATAANALYZER');
  assert.equal(customize('the liveboard'), 'the dashboard');
});

test('never substitutes inside a URL', () => {
  const url = 'https://acme.thoughtspot.cloud/spotter/liveboard/abc';
  assert.equal(customize(`Open ${url} now`), `Open ${url} now`);
  assert.equal(
    customize(`Spotter says: ${url}`),
    `DataAnalyzer says: ${url}`,
  );
});

test('never substitutes inside a markdown link target', () => {
  const md = 'See [the Spotter answer](https://host/spotter/answer/1) for Liveboard details.';
  assert.equal(
    customize(md),
    'See [the DataAnalyzer answer](https://host/spotter/answer/1) for Dashboard details.',
  );
});

test('holdback buffer joins a term split across two chunks', () => {
  const s = createStreamCustomizer(LABELS);
  let out = s.push('Spot');
  out += s.push('ter is great');
  out += s.flush();

  assert.equal(out, 'DataAnalyzer is great');
  assert.ok(out.includes('DataAnalyzer'));
});

test('holdback survives a term split across three chunks', () => {
  const s = createStreamCustomizer(LABELS);
  const out = ['Spo', 'tt', 'er rocks'].map((c) => s.push(c)).join('') + s.flush();
  assert.equal(out, 'DataAnalyzer rocks');
});

test('streamed output equals whole-text output', () => {
  const source = 'Your Liveboard is ready. Spotter found 3 rows — see https://h/spotter/x for the liveboard.';
  const s = createStreamCustomizer(LABELS);
  let streamed = '';
  for (let i = 0; i < source.length; i += 5) streamed += s.push(source.slice(i, i + 5));
  streamed += s.flush();

  assert.equal(streamed, customize(source));
});

test('a URL split across chunks keeps its protection', () => {
  const s = createStreamCustomizer(LABELS);
  const out =
    ['Open https://h/spot', 'ter/liveboard/1 in Spotter'].map((c) => s.push(c)).join('') +
    s.flush();
  assert.equal(out, 'Open https://h/spotter/liveboard/1 in DataAnalyzer');
});

test('streaming is chunk-size independent', () => {
  const source =
    'Spotter opened the Liveboard at https://h/spotter/liveboard/1 — see [the Spotter view](https://h/spotter/v) or www.spotter.io/liveboard.';
  for (let size = 1; size <= 17; size++) {
    const s = createStreamCustomizer(LABELS);
    let streamed = '';
    for (let i = 0; i < source.length; i += size) streamed += s.push(source.slice(i, i + size));
    streamed += s.flush();
    assert.equal(streamed, customize(source), `chunk size ${size}`);
  }
});

test('flush is idempotent and resets the buffer', () => {
  const s = createStreamCustomizer(LABELS);
  s.push('Spot');
  assert.equal(s.flush(), 'Spot');
  assert.equal(s.flush(), '');
});

test('loadLabelMap reads the shipped labels.json', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'labels.json');
  const map = loadLabelMap(file);
  assert.equal(map.Spotter, 'DataAnalyzer');
  assert.equal(map.Liveboard, 'Dashboard');
});

test('empty label map is a no-op passthrough', () => {
  const { customize: noop } = createCustomizer({});
  assert.equal(noop('Spotter stays'), 'Spotter stays');
});
