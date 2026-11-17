# Chrome Web Store Listing — Blackboard 批量下载

> Last Updated: 2026-11-13 · Draft · Not submitted

## Store Listing

**Extension Name:** Blackboard 批量下载

**Short Description:** 扫描当前 Blackboard 页面的课程附件，勾选文件后一次选择保存文件夹并批量下载。

**Detailed Description:**

查找当前已加载课程页面中的 PDF、演示文稿、文档、表格及其他附件，搜索、筛选并勾选后批量保存。

在侧边栏中选择一次文件夹，将整批附件保存到该文件夹，原课程页保持可见。重名文件自动编号。下载时保持侧边栏打开。

仅访问当前用户有权获取的附件，不自动遍历整个课程，不绕过教师或学校的下载限制。不同学校部署可能需要适配。

**Category:** Productivity

**Single Purpose:** 让用户检索当前课程页的可访问附件，选择后批量保存到本机。

**Primary Language:** 简体中文

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|---|---|---|---|
| Store Icon | 128×128 PNG | Not created | — |
| Store Screenshot | 1280×800 or 640×400 | Needs preparation | — |

## Permissions Justification

| Permission | Type | Justification |
|---|---|---|
| activeTab | permissions | After the user invokes the extension, scan the active course page for attachment links without permanent access to all sites. |
| scripting | permissions | Inject bundled link-scanning scripts into the selected course page and read accessible same-origin embedded content. |
| storage | permissions | Keep scan results, selection and current batch progress in the local browser session across side-panel and service-worker lifetimes. |
| sidePanel | permissions | Show the attachment list and download progress beside the user's course page, without navigating to a new tab. |
| http://*/*, https://*/* | optional_host_permissions | Schools and attachment hosts vary. Only request the specific origins of selected attachments after an explicit click in the side panel. This allows credentialed attachment retrieval for writing to the chosen directory; no all-site access is silently granted. |

## Privacy & Data Use

This is a draft disclosure to verify against the final submission form.

- Attachment names, URLs, selected IDs and job status are processed on-device and retained in session storage. The selected folder's name may appear in session status; its handle stays in the active side panel's memory.
- Downloaded file bytes are streamed from the attachment host directly into the directory chosen by the user. No developer server, telemetry, cloud upload or advertising service is used.
- Network requests contact the selected attachment websites. The browser may attach existing login cookies; the extension does not use the cookies API, read passwords or save credentials.
- Optional site grants are limited to the requested attachment origins and can be revoked in the browser's extension settings. They are not automatically removed after a batch.
- Closing or refreshing the owning side panel interrupts unfinished folder writes. Existing files are not intentionally overwritten; name collisions get numbered suffixes.

### Data Use Certification

- [x] No sale of user data.
- [x] Data used only to find and save the user's selected attachments.
- [x] No creditworthiness or lending use.

## Privacy Policy

**Privacy Policy URL:** Pending; no public privacy page has been published yet.

## Distribution

**Visibility:** Pending user choice for store submission.
**Regions:** Pending.

## Developer Info

**Publisher Name:** M0TA1 (confirm before store submission).
**Contact Email:** Pending user-provided publishing contact.
**Support URL:** https://github.com/M0TA1/blackboard-batch-downloader/issues
**Homepage URL:** https://github.com/M0TA1/blackboard-batch-downloader

## Version History

| Version | Date | Changes | Status |
|---|---|---|---|
| 0.5.0 | 2026-11-13 | Side-panel directory saving only; remove alternate download pages, browser download flow and downloads permission. | Draft |
| 0.4.0 | 2026-11-13 | Native side panel keeps the course page visible during file selection and folder downloads. | Draft |
| 0.3.0 | 2026-11-13 | One chosen folder per batch; optional per-site attachment access; retain browser download mode. | Draft |
| 0.2.1 | 2026-11-11 | Last-row scrolling fix. | Local/GitHub snapshot only |

## Review Notes

Not ready for submission: final store assets, public privacy policy, developer contact and open-source license are pending. Native directory-picker selection, site-permission consent and the user's actual school environment require real-user verification in addition to automated tests. Folder downloads require the owning side panel to stay open. Minimum Chrome version is 116. External redirects may require school-specific compatibility work.
