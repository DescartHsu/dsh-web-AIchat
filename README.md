# dsh-web-AIchat

DeepSeek Harness 插件：左侧栏一个「AI Chat」入口，主区域顶部切换不同 AI 的官网聊天页面。

**当前版本：0.1.2，开发预览。** 使用各网站自己的账号与网页，不需要配置模型 API Key，不会把问题同时发送给多个模型。

## 功能

- 内置 DeepSeek、ChatGPT、Claude、Gemini、Grok、Kimi、豆包和通义千问。
- 顶部标签切换；首次点击时才加载该网站。
- 切换网站、离开面板再返回时，复用已打开的页面。
- 后退、前进、刷新、返回首页、复制网址、重新打开当前页面。
- 「管理网站」可添加 HTTPS 网站、移除自定义入口；保存入口与上次选择。
- 每个网站使用独立的原生网页容器和存储分区。
- 网页请求打开新窗口时显示链接，由用户选择是否在当前页打开。
- 插件面板及官网内部的中性背景、常见内容区和输入框背景透明，透出宿主皮肤和背景。
- 网页文字、边框、标签选中态和按钮使用 DSH 皮肤变量，跟随宿主主题即时变化；动态添加的网页内容也会自动适配。
- 工具栏的「跟随皮肤／官网原色」开关可随时恢复官网原始配色，选择会保存。

## 环境与限制

需要提供 `dshDesktop.protocolVersion === 1` 和 `dshDesktop.browser` 的官方 **DSH Desktop**。接口按本机 `0.2.1-rc.3` 和官方 Desktop Browser guest 协议实现。普通浏览器版 DSH 只能选择网站和复制网址，不会尝试 iframe 嵌入。

页面保留限于当前桌面应用进程。官方分区是进程内存分区，**重启 DSH 后可能需要重新登录**。本版本不读取、导出或复制官网 Cookie、localStorage 或登录令牌，也不复用参考插件的登录快照。

网页内部的配色使用通用样式适配，保留品牌色、图片、代码区、验证码区域和第三方 iframe。登录跳转及其他域名不应用配色。透明部分由 Electron 网页容器与宿主背景合成，不复制或读取壁纸文件。少数使用 Shadow DOM、复杂渐变或特殊布局的区域可能保留官网配色，可切换「官网原色」。

网站的可访问性、验证码、地区限制、OAuth 登录及反嵌入规则由各官网决定。依赖独立弹窗及 `window.opener` 的登录流程可能无法在当前页完成；可复制官网地址到外部浏览器使用。外部浏览器的登录不会自动同步到插件。宿主原有的下载、麦克风、摄像头等限制继续生效。

本版本已通过构建与自动化测试；**尚未在实际 DSH 内逐站验证登录与聊天**。这里列出的入口不代表各网站的所有功能均已验证可用。

0.1.2 已在独立 Electron 44.7.0 测试容器中验证透明合成：截图像素确认宿主深浅背景可穿透网页及输入区，文字跟随配色变化；新增内容、官网原色恢复及未发送草稿保留也通过。

## 安装

从本仓库构建本地安装包：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm pack
```

在 DSH Desktop 的「插件 → 添加插件」中输入生成的 `dsh-web-aichat-0.1.2.tgz` **绝对路径**，按宿主提示启用或重启。之后点击左侧「AI Chat」。也可以输入已构建项目的绝对目录。

仓库名按项目要求使用 `dsh-web-AIchat`；npm 包名按命名规则使用小写 `dsh-web-aichat`。仓库与包均按私有开发设置，未发布到 npm。不要将私有 GitHub 链接当成已发布的 npm 安装包。

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
| `src/index.js` | 无额外服务端路由的 Host 入口 |
| `cordis.patch.yml` | 插件包注册 |
| `test/` | 生命周期、URL 校验、构建后 UI 集成测试 |

自动化测试覆盖多个标签的独立分区、页面复用、迟到租约回收、加载失败重试、卸载清理、弹窗 URL 校验、侧栏与主区域注册，以及无 Desktop bridge 时的提示。测试使用模拟 bridge，不替代真实 Desktop 验收。

手动验收：在空闲的 DSH Desktop 中安装，逐个打开官网并手动登录；输入未发送的草稿后切换标签及其他 DSH 面板，确认页面保留；检查窄窗口布局、错误提示和插件禁用后的清理。请勿将实际聊天内容、登录信息或浏览器配置提交到仓库。

## 参考

- 本机 `dsh-deepseek-web-preview` 0.2.0：侧栏入口、主区域面板、页面保留的使用方式。
- [官方 Desktop guest 管理](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/src/browser-guests.ts)
- [官方 Desktop browser bridge](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/src/preload-browser.ts)

第三方参考的许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目新代码暂未授予开源许可；公开仓库前可另行选择许可证。
