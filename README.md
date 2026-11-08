# dsh-web-AIchat

DeepSeek Harness 插件：左侧栏一个「AI Chat」入口，主区域顶部切换不同 AI 的官网聊天页面。

**当前版本：0.1.10，开发预览。** 使用各网站自己的账号与网页，不需要配置模型 API Key，不会把问题同时发送给多个模型。

## 功能

- 内置 DeepSeek、ChatGPT、Claude、Gemini、Grok、Kimi、豆包和通义千问。
- 顶部标签切换；首次点击时才加载该网站。
- 顶部 AI 标签支持左右拖拽排序，内置网站与自定义网站均可混排；释放时自动保存，下次打开保留顺序。拖动到目标标签左半边放在它前面，右半边放在它后面；靠近标签栏边缘可滚动。也可聚焦标签后按 `Alt + ← / →` 调整位置。
- 切换网站、离开面板再返回时，复用已打开的页面。
- 后退、前进、刷新、返回首页、复制网址、重新打开当前页面。
- 「管理网站」可添加 HTTPS 网站、删除内置或自定义网站；删除结果、排序和当前选择自动保存。已删除的内置网站可单独恢复，删除入口不会清除官网登录数据。
- 每个网站使用独立的原生网页容器和存储分区。
- Windows DSH Desktop 0.2.1-rc.3 / rc.4 / rc.5 及 0.2.2-alpha.2 / 0.2.2-rc.1 上自动配置登录保留，无需点击修复。插件加载后自动准备，首次完整退出后备份、启用持久化存储并自动重开一次。之后保留 Cookie（含 HttpOnly）、localStorage 和 IndexedDB；面板按实际分区显示是否已启用。
- 网页请求打开新窗口时显示链接，由用户选择是否在当前页打开。
- 插件面板及官网内部的中性背景、常见内容区和输入框背景透明，透出宿主皮肤和背景。
- 网页文字、边框、标签选中态和按钮使用 DSH 皮肤变量，跟随宿主主题即时变化；动态添加的网页内容也会自动适配。
- 工具栏的「跟随皮肤／官网原色」开关可随时恢复官网原始配色，选择会保存。
- 自动关闭 DeepSeek 官网可关闭的「使用环境异常」提醒：识别该提醒的标题及正文后，点击官网自己的关闭按钮，包含页面延迟弹出的情况；关闭动作独立于主题开关。

## 环境与限制

需要提供 `dshDesktop.protocolVersion === 1` 和 `dshDesktop.browser` 的官方 **DSH Desktop**。接口已对照 `0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.2-alpha.2`、`0.2.2-rc.1` 的官方 Desktop Browser guest 源码及本机 rc.1 安装验证。普通浏览器版 DSH 只能选择网站和复制网址，不会尝试 iframe 嵌入。

原版 DSH Desktop 0.2.1-rc.3 将 Browser guest 强制放在内存分区，仅更新网页代码无法解决重启后退出登录。0.1.6 在插件加载时自动准备针对该版本的兼容修复，无需打开设置页或点击按钮；只将 `dsh-web-aichat:<网站标识>` 分区改成稳定的 `persist:` 分区。其他浏览器分区及宿主隔离策略不变。网站通过 Chromium 原生存储保留登录数据，插件不导出、复制或回放登录令牌。

首次配置仍需完整退出 DSH 一次，工具不会强制关闭正在使用的程序或中断任务。配置完成前显示状态页，暂不打开临时登录网页；自动重开后再登录一次即可。原临时分区已丢失的登录数据无法恢复。之后正常退出再打开 DSH，仍在官网有效期内的登录状态会保留。网站主动退出、Cookie 过期、关闭即失效的会话 Cookie 或安全验证仍可能要求重新登录，无法保证永久在线。

网页内部的配色使用通用样式适配，保留品牌色、图片、代码区、验证码区域和第三方 iframe。登录跳转及其他域名不应用配色。透明部分由 Electron 网页容器与宿主背景合成，不复制或读取壁纸文件。少数使用 Shadow DOM、复杂渐变或特殊布局的区域可能保留官网配色，可切换「官网原色」。

自动关闭提醒只作用于 `https://chat.deepseek.com` 的这一条已确认可关闭提示，使用官网关闭动作，不改 User-Agent 或官网检测代码，也不操作登录、验证码、权限确认或其他弹窗。若官网更改标题、正文或关闭按钮结构，插件会保留无法识别的弹窗。

网站的可访问性、验证码、地区限制、OAuth 登录及反嵌入规则由各官网决定。依赖独立弹窗及 `window.opener` 的登录流程可能无法在当前页完成；可复制官网地址到外部浏览器使用。外部浏览器的登录不会自动同步到插件。宿主原有的下载、麦克风、摄像头等限制继续生效。

本版本已通过构建与自动化测试；**尚未在实际 DSH 内逐站验证登录与聊天**。这里列出的入口不代表各网站的所有功能均已验证可用。

0.1.2 已在独立 Electron 44.7.0 测试容器中验证透明合成：截图像素确认宿主深浅背景可穿透网页及输入区，文字跟随配色变化；新增内容、官网原色恢复及未发送草稿保留也通过。

0.1.3 已使用修复后的真实 DesktopBrowserGuests 实现，分别启动两个 Electron 44.7.0 进程，验证持久化 HttpOnly Cookie、localStorage、IndexedDB 跨重启保留和不同网站分区隔离。测试未延长官网会话有效期，未使用实际账号凭据。

0.1.5 已在独立的 Windows Electron 44.7.0 安装副本中验证完整流程：未修复安装的检测、安装包内工具准备、等待退出、备份和修复、自动重开，以及再次完整重启后的 HttpOnly Cookie、localStorage、IndexedDB 保留。该验证使用官方原始 DesktopBrowserGuests 代码和测试数据，不代表已验证其他电脑上的实际 DeepSeek 账号会话。

0.1.6 已在新的未修复 Windows 安装副本中验证：插件加载后自动准备，全程未调用准备接口或点击修复；完整退出后自动完成设置并重新打开，再次完整启动后 HttpOnly Cookie、localStorage 和 IndexedDB 均保留。测试另外覆盖长时间使用、插件停用、加载过程中卸载和失败后停止自动重试。

## 桌面兼容性（0.1.10）

本版本适配 [DSH 0.2.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)。登录存储工具显式支持 0.2.1-rc.3、rc.4、rc.5、0.2.2-alpha.2 和 0.2.2-rc.1；版本不在列表内或分区实现、主入口、完整性配置不匹配时仍拒绝修改。

上述五个官方 tag 的 `browser-guests.ts` 与 `preload-browser.ts` 内容分别完全相同。rc.5 已使用本机发行版的原始 guest 代码和 Electron 可执行程序，在隔离测试目录验证自动配置及跨重启存储；rc.4 和 alpha.2 通过源码对照及版本/归档测试，尚未逐一做完整桌面运行验收。

0.2.2-rc.1 已使用本机发行版的原始 guest 代码与 Electron 可执行程序，在独立测试安装目录验证自动准备、备份、修改、自动重开，以及再次完整启动后的 HttpOnly Cookie、localStorage 和 IndexedDB 保留。检查同时确认 Host HTTP 路由、认证方法及关闭消息仍兼容。未对各官网真实账号逐一做登录验收。

升级插件或 DSH 后，旧版本留下的失败或等待任务会重新评估；相同插件和宿主版本的失败仍停止自动重试。网站、删除列表、标签顺序及皮肤设置保持原有配置格式。状态页现在显示检测到的 DSH 版本。

## 安装

从本仓库构建本地安装包：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm pack
```

在 DSH Desktop 的「插件 → 添加插件」中输入生成的 `dsh-web-aichat-0.1.10.tgz` **绝对路径**，按宿主提示启用或重启。之后点击左侧「AI Chat」。也可以输入已构建项目的绝对目录。

### 自动保留登录

支持 Windows 官方 DSH Desktop 0.2.1-rc.3、0.2.1-rc.4、0.2.1-rc.5、0.2.2-alpha.2、0.2.2-rc.1，无需单独下载脚本或安装 Node.js：

1. 安装或更新插件，按宿主提示启用或重启，使新版插件加载；插件会自动准备首次配置，不需要点击修复或进入设置页。
2. 如果 AI Chat 显示首次设置提示，完成运行中的任务，从 **应用 → 退出** 完整退出 DSH。工具会自动备份、完成配置并重新打开一次；仅关闭窗口可能仍在托盘运行。
3. 确认 AI Chat 底部显示 **登录状态自动保留**，在 DeepSeek 等官网登录一次。以后正常打开即可继续使用有效的登录。

已经启用持久化存储的电脑会直接打开官网，不重复准备或修改。自动任务没有 15 分钟退出期限，长时间使用后退出也可完成；插件停用、卸载或热重载时取消旧任务，新版加载时重新检测。自动配置失败时显示原因，停止自动重试，避免退出和重开循环；状态页仅在失败时提供重试按钮。未知版本或安装目录不可写时不会伪装成已启用。

准备完成仅表示工具已就绪；只有实际网页使用持久化分区时，聊天区才显示登录已保留。可通过 **登录存储状态** 查看检测到的安装目录与进度；正常首次设置不需要点击该入口。

### 手动修复与回滚

以下工具支持上述已验证版本的 Windows 官方 DSH Desktop、0.2.1-rc.4、0.2.1-rc.5、0.2.2-alpha.2。先完整退出 DSH（包括托盘），然后运行：

```sh
node scripts/desktop-persistence.mjs --check "E:/DeepSeek Harness"
node scripts/desktop-persistence.mjs --apply "E:/DeepSeek Harness"
```

工具先验证安装版本和补丁位置，备份 `resources/app.asar` 并校验备份，再替换该文件中的分区选择逻辑；不改可执行程序、不调整 Electron fuses、不关闭完整性检查。未知版本或启用嵌入式 ASAR 校验的构建会拒绝修改。输出包含备份路径，回滚时完整退出 DSH 后使用：

```sh
node scripts/desktop-persistence.mjs --restore "E:/DeepSeek Harness" "工具输出的完整备份路径"
```

安装包内也包含此脚本，Release 提供独立副本作为手动备用方式。自动配置的任务及状态保存在 DSH 主目录的 `dsh-web-aichat/desktop-setup/`，备份位于原 `resources/app.asar` 旁。DSH 自身升级可能覆盖兼容修复；新版插件会重新检测支持情况，不会将旧补丁强行套用到未知版本。

仓库名按项目要求使用 `dsh-web-AIchat`；npm 包名按命名规则使用小写 `dsh-web-aichat`。仓库公开可访问，安装包通过 GitHub Release 提供，尚未发布到 npm。

## 开发

Node.js 22+，pnpm 11.25.0。运行时 React 由 DSH 提供；仓库中的 React、jsdom 仅用于测试，esbuild 用于打包。`lib/` 是构建产物，不提交到 Git。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm pack
```

| 文件 | 用途 |
| --- | --- |
| `src/client.js` | 侧栏注册、主面板、顶部标签、网站管理 |
| `src/guest-manager.js` | 原生网页租约、页面保留与释放 |
| `src/providers.js` | 内置网站、配置与 URL 校验 |
| `src/styles.css` | 面板样式 |
| `src/index.js` | Host 入口，注册登录修复服务 |
| `src/persistence-service.js` | 检测安装位置、鉴权的本机准备接口、启动独立工具 |
| `src/persistence-worker.mjs` | 等待完整退出、备份修复和重新打开桌面 |
| `scripts/desktop-persistence.mjs` | 版本校验、限定分区修改和回滚 |
| `cordis.patch.yml` | 插件包注册 |
| `test/` | 生命周期、URL 校验、构建后 UI 集成测试 |

自动化测试覆盖多个标签的独立分区、页面复用、迟到租约回收、加载失败重试、卸载清理、弹窗 URL 校验、侧栏与主区域注册，以及无 Desktop bridge 时的提示；还覆盖首次安装的启用入口、不同安装位置、完整打包工具、等待退出、失败与超时状态、接口鉴权。测试使用模拟 bridge，不替代真实 Desktop 验收。

手动验收：在空闲的 DSH Desktop 中安装，逐个打开官网并手动登录；输入未发送的草稿后切换标签及其他 DSH 面板，确认页面保留；拖动内置和自定义标签，确认排序不切换或重载当前聊天，重新打开后顺序保留；检查窄窗口布局、错误提示和插件禁用后的清理。请勿将实际聊天内容、登录信息或浏览器配置提交到仓库。

## 参考

- 本机 `dsh-deepseek-web-preview` 0.2.0：侧栏入口、主区域面板、页面保留的使用方式。
- [官方 Desktop guest 管理](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/src/browser-guests.ts)
- [官方 Desktop browser bridge](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/src/preload-browser.ts)

第三方参考的许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目新代码暂未授予开源许可。
