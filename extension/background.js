import { DownloadQueue } from './queue.js';

const isWebPage = url => /^https?:\/\//i.test(url || '');

export function createMessageHandler(api, queue) {
  return async (message, sender) => {
    try {
      if (sender?.id !== api.runtime.id || !sender.url?.startsWith(api.runtime.getURL(''))) throw new Error('仅允许插件界面执行此操作。');
      switch (message?.type) {
        case 'GET_STATE': {
          const { scan = null } = await api.storage.session.get('scan');
          return { ok: true, scan, batch: queue.snapshot() };
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
          return { ok: true, scan, batch: queue.snapshot() };
        }
        case 'START_DOWNLOADS': {
          const { scan } = await api.storage.session.get('scan');
          if (!scan) throw new Error('请先扫描当前页面。');
          const tab = await api.tabs.get(scan.sourceTabId);
          if (tab.url !== scan.pageUrl) throw new Error('原页面已切换，请重新扫描后选择文件。');
          if (!Array.isArray(message.fileIds) || !message.fileIds.length || message.fileIds.some(id => typeof id !== 'string')) throw new Error('请选择要下载的文件。');
          const files = new Map(scan.files.map(file => [file.id, file]));
          const selected = [...new Set(message.fileIds)].map(id => files.get(id));
          if (selected.some(file => !file)) throw new Error('所选文件已不在扫描结果中，请重新扫描。');
          return { ok: true, batch: await queue.start(selected) };
        }
        case 'STOP_DOWNLOADS': return { ok: true, batch: await queue.stop() };
        default: throw new Error('不支持此操作。');
      }
    } catch (error) {
      return { ok: false, error: error.message || '操作失败，请刷新页面后重试。' };
    }
  };
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
  return { queue, ready };
}

if (globalThis.chrome?.runtime?.onMessage) installBackground(chrome);
