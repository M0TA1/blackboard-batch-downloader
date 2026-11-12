import { DownloadQueue } from './queue.js';
import { FolderSession, isActiveBatch } from './folder-session.js';

const isWebPage = url => /^https?:\/\//i.test(url || '');

export function createMessageHandler(api, queue, folder = new FolderSession(api)) {
  let serial = Promise.resolve();
  const enqueue = action => {
    const result = serial.then(action);
    serial = result.catch(() => {});
    return result;
  };
  const latestBatch = async () => {
    const native = queue.snapshot();
    const current = await folder.current();
    return current && (!native || current.createdAt >= native.createdAt) ? current : native;
  };
  const selectedFiles = async message => {
    const { scan } = await api.storage.session.get('scan');
    if (!scan) throw new Error('请先扫描当前页面。');
    const tab = await api.tabs.get(scan.sourceTabId);
    if (tab.url !== scan.pageUrl) throw new Error('原页面已切换，请重新扫描后选择文件。');
    if (!Array.isArray(message.fileIds) || !message.fileIds.length || message.fileIds.some(id => typeof id !== 'string')) throw new Error('请选择要下载的文件。');
    const files = new Map(scan.files.map(file => [file.id, file]));
    const selected = [...new Set(message.fileIds)].map(id => files.get(id));
    if (selected.some(file => !file)) throw new Error('所选文件已不在扫描结果中，请重新扫描。');
    return { scan, selected };
  };
  const process = async (message, sender) => {
    try {
      if (sender?.id !== api.runtime.id || !sender.url?.startsWith(api.runtime.getURL(''))) throw new Error('仅允许插件界面执行此操作。');
      switch (message?.type) {
        case 'GET_STATE': {
          const { scan = null } = await api.storage.session.get('scan');
          return { ok: true, scan, batch: await latestBatch() };
        }
        case 'SCAN_PAGE': {
          if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error('无法确定当前标签页。');
          const tab = await api.tabs.get(message.tabId);
          if (!isWebPage(tab.url)) throw new Error('请在已登录的 Blackboard 网页中使用插件，浏览器设置页和新标签页无法扫描。');
          const results = await api.scripting.executeScript({ target: { tabId: message.tabId, frameIds: [0] }, files: ['file-types.js', 'scanner.js'] });
          const result = results?.[0]?.result;
          if (!result || !Array.isArray(result.files)) throw new Error('页面扫描未返回文件清单，请刷新课程页后重试。');
          // The scanner traverses accessible same-origin frames itself; cross-origin frames become warnings.
          const scan = { ...result, pageUrl: tab.url, title: result.title || tab.title || '当前页面', sourceTabId: tab.id };
          const after = await api.tabs.get(tab.id);
          if (after.url !== tab.url) throw new Error('扫描时页面已切换，请重新扫描。');
          await api.storage.session.set({ scan });
          return { ok: true, scan, batch: await latestBatch() };
        }
        case 'START_DOWNLOADS': {
          if (isActiveBatch(await folder.current())) throw new Error('当前文件夹下载尚未结束，请先完成或停止该批次。');
          const { selected } = await selectedFiles(message);
          const batch = await queue.start(selected);
          await folder.clear();
          return { ok: true, batch };
        }
        case 'PREPARE_FOLDER_DOWNLOAD': {
          if (isActiveBatch(queue.snapshot())) throw new Error('当前浏览器下载尚未结束，请先等待完成。');
          const { scan, selected } = await selectedFiles(message);
          return { ok: true, ...await folder.prepare(selected, scan) };
        }
        case 'GET_FOLDER_PLAN': return { ok: true, ...await folder.get(message.planId, sender) };
        case 'FOLDER_PROGRESS': return { ok: true, batch: await folder.update(message, sender) };
        case 'STOP_DOWNLOADS': {
          const batch = await folder.current();
          return { ok: true, batch: isActiveBatch(batch) ? await folder.stop() : await queue.stop() || batch };
        }
        default: throw new Error('不支持此操作。');
      }
    } catch (error) {
      return { ok: false, error: error.message || '操作失败，请刷新页面后重试。' };
    }
  };
  const handle = (message, sender) => enqueue(() => process(message, sender));
  handle.closeFolderTab = tabId => enqueue(() => folder.closeTab(tabId));
  handle.folderTabLoading = tabId => enqueue(() => folder.navigateTab(tabId));
  return handle;
}

export function installBackground(api) {
  const queue = new DownloadQueue({
    load: async () => (await api.storage.session.get('batch')).batch,
    save: batch => api.storage.session.set({ batch }),
    download: options => api.downloads.download(options),
    search: query => api.downloads.search(query),
  });
  const ready = queue.restore();
  const handle = createMessageHandler(api, queue);
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    ready.then(() => handle(message, sender)).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  });
  const update = delta => {
    ready.then(() => queue.handleChanged(delta)).catch(error => console.error('下载状态更新失败', error));
  };
  api.downloads.onChanged.addListener(update);
  api.downloads.onErased.addListener(id => update({ id }));
  api.tabs.onRemoved?.addListener(tabId => {
    ready.then(() => handle.closeFolderTab(tabId)).catch(error => console.error('下载页关闭状态更新失败', error));
  });
  api.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      ready.then(() => handle.folderTabLoading(tabId)).catch(error => console.error('下载页导航状态更新失败', error));
    }
  });
  return { queue, ready };
}

if (globalThis.chrome?.runtime?.onMessage) installBackground(chrome);
