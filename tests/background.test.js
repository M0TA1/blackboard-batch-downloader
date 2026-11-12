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
    tabs: { get: async id => ({ id, url, title: '课程内容' }), create: async () => ({ id: 123 }) },
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

test('selected files open one folder-download tab and folder progress appears in popup state', async () => {
  const { handle, state } = setup();
  await handle({ type: 'SCAN_PAGE', tabId: 12 }, sender);
  const prepared = await handle({ type: 'PREPARE_FOLDER_DOWNLOAD', fileIds: ['f1'] }, sender);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.tabId, 123);
  assert.equal(state.folderPlan.files[0].url, file.url);
  const owner = { ...sender, tab: { id: 123 }, url: `chrome-extension://our-extension/downloader.html#${prepared.planId}` };
  assert.equal((await handle({ type: 'GET_FOLDER_PLAN', planId: prepared.planId }, owner)).ok, true);
  const snapshot = await handle({ type: 'GET_STATE' }, sender);
  assert.equal(snapshot.batch.mode, 'folder');
  assert.equal((await handle({ type: 'START_DOWNLOADS', fileIds: ['f1'] }, sender)).ok, false);
  const stopped = await handle({ type: 'STOP_DOWNLOADS' }, sender);
  assert.equal(stopped.batch.jobs[0].status, 'cancelled');
});

test('a folder download request cannot bypass scan selection or source-page validation', async () => {
  const { handle, navigate, state } = setup();
  await handle({ type: 'SCAN_PAGE', tabId: 12 }, sender);
  assert.equal((await handle({ type: 'PREPARE_FOLDER_DOWNLOAD', fileIds: ['unknown'] }, sender)).ok, false);
  navigate('https://school.example/next');
  assert.equal((await handle({ type: 'PREPARE_FOLDER_DOWNLOAD', fileIds: ['f1'] }, sender)).ok, false);
  assert.equal(state.folderPlan, undefined);
});
