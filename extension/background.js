import { FolderSession } from './folder-session.js';

const isWebPage = url => /^https?:\/\//i.test(url || '');
const SCAN_POLICY_VERSION = 1;

export function createMessageHandler(api, folder = new FolderSession(api)) {
  let serial = Promise.resolve();
  const enqueue = action => {
    const result = serial.then(action);
    serial = result.catch(() => {});
    return result;
  };
  const currentScan = async () => {
    const { scan } = await api.storage.session.get('scan');
    if (scan && scan.scanPolicyVersion !== SCAN_POLICY_VERSION) {
      await api.storage.session.set({ scan: null });
      return null;
    }
    return scan || null;
  };
  const selectedFiles = async message => {
    const scan = await currentScan();
    if (!scan) throw new Error('请先扫描当前页面。');
    if (message.sourceTabId !== scan.sourceTabId || message.scanTimestamp !== scan.scannedAt) throw new Error('课程页面的扫描结果已更新，请重新扫描并选择文件。');
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
      sender = await folder.resolvePanelSender(sender, message?.panelUrl);
      switch (message?.type) {
        case 'GET_STATE': {
          await folder.reconcilePanel();
          const scan = await currentScan();
          return { ok: true, scan, batch: await folder.current(), documentId: sender.documentId || null };
        }
        case 'SCAN_PAGE': {
          if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error('无法确定当前标签页。');
          const tab = await api.tabs.get(message.tabId);
          if (!isWebPage(tab.url)) throw new Error('请在已登录的 Blackboard 网页中使用插件，浏览器设置页和新标签页无法扫描。');
          const results = await api.scripting.executeScript({ target: { tabId: message.tabId, frameIds: [0] }, files: ['file-types.js', 'scanner.js'] });
          const result = results?.[0]?.result;
          if (!result || !Array.isArray(result.files)) throw new Error('页面扫描未返回文件清单，请刷新课程页后重试。');
          // The scanner traverses accessible same-origin frames itself; cross-origin frames become warnings.
          const scan = { ...result, scanPolicyVersion: SCAN_POLICY_VERSION, pageUrl: tab.url, title: result.title || tab.title || '当前页面', sourceTabId: tab.id };
          const after = await api.tabs.get(tab.id);
          if (after.url !== tab.url) throw new Error('扫描时页面已切换，请重新扫描。');
          await api.storage.session.set({ scan });
          return { ok: true, scan, batch: await folder.current() };
        }
        case 'PREPARE_PANEL_DOWNLOAD': {
          const { scan, selected } = await selectedFiles(message);
          return { ok: true, ...await folder.preparePanel(selected, scan, sender) };
        }
        case 'END_PANEL_DOWNLOAD': return { ok: true, batch: await folder.endPanel(message.planId, sender) };
        case 'FOLDER_PROGRESS': return { ok: true, batch: await folder.update(message, sender) };
        case 'STOP_DOWNLOADS': {
          await folder.reconcilePanel();
          return { ok: true, batch: await folder.stop() };
        }
        default: throw new Error('不支持此操作。');
      }
    } catch (error) {
      return { ok: false, error: error.message || '操作失败，请刷新页面后重试。' };
    }
  };
  const handle = (message, sender) => enqueue(() => process(message, sender));
  handle.reconcilePanel = () => enqueue(() => folder.reconcilePanel());
  return handle;
}

export function installBackground(api) {
  const folder = new FolderSession(api);
  const handle = createMessageHandler(api, folder);
  // Retire the former browser-download queue without restarting any old jobs.
  const ready = api.storage.session.set({ batch: null }).then(() => handle.reconcilePanel());
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    ready.then(() => handle(message, sender)).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  });
  api.action?.onClicked?.addListener(async tab => {
    // Must run directly in the action gesture, before awaiting storage or messages.
    try {
      await api.sidePanel.open({ windowId: tab.windowId });
      await api.runtime.sendMessage({ type: 'PANEL_SOURCE', tabId: tab.id, windowId: tab.windowId });
    } catch (error) {
      if (!/Receiving end does not exist|Could not establish connection/.test(error.message || '')) console.error('侧边栏打开失败', error);
    }
  });
  api.sidePanel?.onClosed?.addListener(() => {
    ready.then(() => handle.reconcilePanel()).catch(error => console.error('侧边栏关闭状态更新失败', error));
  });
  return { folder, handle, ready };
}

if (globalThis.chrome?.runtime?.onMessage) installBackground(chrome);
