import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../extension/background.js';

const file = { id: 'f1', url: 'https://school.example/notes.pdf?token=abc', name: '课程.pdf', extension: 'pdf', source: '课程页' };
const sender = { id: 'our-extension', url: 'chrome-extension://our-extension/popup.html' };
function setup() {
  const state = {};
  const starts = [];
  let url = 'https://school.example/course';
  const api = {
    runtime: { id: 'our-extension', getURL: (path) => `chrome-extension://our-extension/${path}` },
    storage: { session: { get: async key => ({ [key]: structuredClone(state[key]) }), set: async values => Object.assign(state, structuredClone(values)) } },
    tabs: { get: async id => ({ id, url, title: '课程内容' }) },
    scripting: { executeScript: async () => [{ result: { files: [file], pageUrl: url, title: '课程内容', warnings: [], scannedAt: 1 } }] },
  };
  const queue = { snapshot: () => null, start: async files => { starts.push(files); return { jobs: [] }; }, stop: async () => null };
  return { handle: createMessageHandler(api, queue), state, starts, navigate: value => { url = value; } };
}

test('scan caches only returned files and downloads selected IDs with original signed URL', async () => {
  const { handle, state, starts } = setup();
  assert.equal((await handle({ type: 'SCAN_PAGE', tabId: 12 }, sender)).ok, true);
  assert.equal(state.scan.files.length, 1);
  assert.equal((await handle({ type: 'START_DOWNLOADS', fileIds: ['f1'] }, sender)).ok, true);
  assert.equal(starts[0][0].url, 'https://school.example/notes.pdf?token=abc');
});

test('download requests cannot introduce URLs that were not scanned', async () => {
  const { handle, starts } = setup();
  await handle({ type: 'SCAN_PAGE', tabId: 12 }, sender);
  assert.equal((await handle({ type: 'START_DOWNLOADS', fileIds: ['other'], url: 'https://evil.example' }, sender)).ok, false);
  assert.equal(starts.length, 0);
});

test('navigation invalidates previous scan before starting a download', async () => {
  const { handle, navigate, starts } = setup();
  await handle({ type: 'SCAN_PAGE', tabId: 12 }, sender);
  navigate('https://school.example/another-course');
  assert.equal((await handle({ type: 'START_DOWNLOADS', fileIds: ['f1'] }, sender)).ok, false);
  assert.equal(starts.length, 0);
});

test('restricted pages and non-extension senders are rejected', async () => {
  const { handle, navigate } = setup();
  navigate('chrome://extensions');
  assert.equal((await handle({ type: 'SCAN_PAGE', tabId: 12 }, sender)).ok, false);
  assert.equal((await handle({ type: 'GET_STATE' }, { id: 'different' })).ok, false);
});
