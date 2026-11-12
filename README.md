# Blackboard 批量下载插件

Chrome / Edge 的 Manifest V3 插件。扫描当前已加载页面中的课程附件，选择后批量下载。不需要服务器或 API Key。用户安装时不需要 Node.js。

## 安装

1. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。
2. 打开“开发者模式”，点击“加载已解压的扩展程序”。
3. 选择本项目的 **extension** 文件夹，确保该文件夹直接包含 `manifest.json`。
4. 在浏览器工具栏的扩展菜单中，将“Blackboard 批量下载”固定到工具栏。

也可以将 `dist/blackboard-batch-downloader-v0.2.1.zip` 解压到一个固定位置，再加载解压后的文件夹。插件未发布到扩展商店；不要将 ZIP 拖入浏览器当作商店安装包。

从旧版升级：若加载的就是本项目 `extension` 文件夹，在扩展管理页点击该插件的刷新按钮，然后重新打开插件并扫描；若从 ZIP 安装，先将新版解压到原来的安装位置，再刷新插件。

v0.2.1 修复文件较多时最后一行被裁切、滚动不到的问题，列表与下载进度使用同一个滚动区域，底部下载按钮保持可见。

## 使用

1. 在同一个浏览器窗口中登录学校 Blackboard，进入含有附件的课程内容页。
2. 展开需要的内容，等待加载。需要时先向下滚动，再点击工具栏的插件图标。
3. 插件会扫描当前页面。使用搜索和 PDF / 演示文稿 / 文档 / 表格筛选，勾选文件。
4. 点击“下载所选”。文件保存到浏览器下载目录中的 **Blackboard** 子文件夹。同名文件自动增加编号。
5. 关闭弹窗后，后台仍继续下载。再次打开可查看状态。“停止等待项”只停止尚未开始的任务；已开始的下载由浏览器继续管理。

分类为 PDF、演示文稿、文档、表格、**其他**。原有 PDF、PPT/PPTX、DOC/DOCX、XLS/XLSX、CSV 分类保持不变。其他包含 WAV / MP3 等音频、TXT / Markdown 文本、ZIP / RAR / 7Z 压缩包、图片、代码、JSON / IPYNB / MAT 等数据附件。更少见的扩展名在具有明确附件地址、文件名元数据或下载入口时也归入“其他”；不凭普通链接文字猜测任意网页是附件。

文件下载到本地，不需要插件解析或播放其内容。默认不勾选文件。“全选所见”和“取消所见”只影响当前筛选结果；隐藏的已选文件仍会下载，底部会显示数量。

切换课程页面后自动重新扫描；页面内容在原 URL 下动态更新时，请点击“重新扫描”。关闭整个浏览器会清除插件本次会话的扫描结果与等待队列；已启动下载的状态以浏览器下载列表为准。

## 扫描范围与故障处理

- 只扫描当前页已经加载到 DOM 的附件，不自动遍历课程、子文件夹或受条件限制的内容。
- 同源内嵌页面可扫描。跨域内嵌区域会显示扫描不完整提示；可以进入实际课程内容页再扫描。
- 部分 Blackboard Ultra 文件由点击按钮或预览器内部临时生成下载地址。没有原始链接或足够元数据的条目可能无法识别，需要真实学校页面后续适配。
- 仅查看或明确禁止下载的条目会排除；插件不绕过学校或教师的访问限制。
- Office 的 PDF 预览不会冒充原始 Office 附件。若服务器下载时返回 HTML 登录页或 PDF 预览副本，插件会报告失败；此时文件可能已经由浏览器保存，请检查目录。
- 登录失效：先重新登录课程页面，再扫描和下载。下载链接仍使用浏览器当前登录会话，不需要在插件中输入账号密码。
- 未发现文件：先展开附件所在内容，再重新扫描。遇到特殊学校页面，可以提供脱敏后的附件元素结构以增加适配规则。
- 浏览器设置页、新标签页、浏览器内置 PDF 查看器等受限页面不能注入脚本。请回到原课程内容页扫描。
- 学校管理策略、浏览器下载位置设置或安全拦截可能需要在浏览器下载列表中处理；插件不会自动绕过。

## 权限与数据

只申请 `activeTab`、`scripting`、`downloads` 和 `storage`。点击插件后才读取当前站点，不申请所有网站的常驻访问权限。扫描清单、勾选项和下载任务只保存在本机浏览器会话中，无遥测或上传服务。下载请求由浏览器携带该站点已有 Cookie，插件不直接读取 Cookie 或密码。

## 开发与验证

要求 Node.js 20+。运行时没有第三方依赖；linkedom 和 Playwright 仅用于开发测试。

```sh
npm ci
npm test
npx playwright install chromium
npm run test:e2e
npm run package
```

`tests/fixtures/course.html` 是人工构造的模拟课程页。浏览器集成测试使用隔离的临时 Chromium 用户目录，不修改日常 Chrome 配置。无头测试会复制插件到临时目录，并只在该测试副本中增加 `http://127.0.0.1/*` 权限；交付的插件仍只有 activeTab，不包含常驻站点权限。Playwright 在后台标签中渲染同一个 popup.html 并调用实际扩展 API，不能自动模拟工具栏赋予 activeTab 的用户点击。真实工具栏点击与用户学校页面仍需要安装后验证。

截图和下载文件保存在系统临时目录。测试使用小型占位内容验证下载流程，不验证 Office 软件打开文档的能力。

自动化验证使用本地模拟页。用户已反馈插件可在其 Blackboard 页面使用，但尚未完成多学校、不同 Original / Ultra 部署和真实 Edge 的全面验证，不承诺覆盖所有学校配置。当前版本可用于安装试用，特殊页面可能需要继续适配。版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 参考资料

- [Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
- [Chrome activeTab 权限](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Blackboard Ultra 文件查看与下载设置](https://help.blackboard.com/ja-jp/node/43261)
- [Blackboard Office 预览与原始附件](https://help.blackboard.com/ru-ru/node/43091)
