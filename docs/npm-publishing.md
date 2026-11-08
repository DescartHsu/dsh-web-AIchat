# 发布到 npm 并使用 DSH 原生更新

本包名为 `dsh-web-aichat`。0.1.13 首次 npm 发布尚待维护者注册、验证邮箱和登录；不要在发布前通知用户已可按包名安装。

## 首次发布

1. 在 [npm 官网](https://www.npmjs.com/signup) 注册维护者账号、验证邮箱，并按 npm 要求配置发布认证。账号密码、验证码和 Token 由维护者本人输入，不提交到仓库，也不粘贴到聊天中。
2. 在维护者本机终端登录官方仓库：

   ```powershell
   pnpm login --registry=https://registry.npmjs.org/
   pnpm whoami --registry=https://registry.npmjs.org/
   ```

3. 从干净且已同步的 main 分支验证并打包：

   ```powershell
   pnpm install --frozen-lockfile
   pnpm test
   pnpm pack
   ```

   检查包名、版本、`lib/`、`cordis.patch.yml` 和第三方许可说明，并扫描解压内容中的凭据。`files` 白名单只包含运行文件及必要说明；不包含工作目录、测试资料或账号配置。

4. 发布前重新确认包名没有被他人占用，并更新 README 的待发布状态。确认代码提交、CI 与待发包对应后，发布公开包：

   ```powershell
   pnpm publish --access public --registry=https://registry.npmjs.org/
   ```

   `prepublishOnly` 会重新运行测试；发布认证由维护者在本机完成。若提示账号认证或二次验证，完成 npm 官方流程；不要为了发布降低账号保护。

5. 读取官方 registry，确认版本及 latest 标签，下载包并比对内容后，再宣布发布完成。若发布返回超时，先查 registry；不要仅因超时就反复上传或更改版本。

   ```powershell
   pnpm view dsh-web-aichat version dist-tags dist.integrity --registry=https://registry.npmjs.org/
   ```

## DSH 首次迁移验收

先备份 profile 的 package.json、pnpm-lock.yaml、pnpm-workspace.yaml 和 Cordis 配置（若存在）。用 DSH 自身的插件管理器将本地/GitHub tarball 来源替换为包名安装，不直接改正在运行的 profile。

核对本包的来源已是 registry、版本正确，其他依赖和配置没有被改动；启用并确认 AI Chat 入口。打开本插件详情，确认原生版本区自动检查。再核对网站、隐藏列表、排序与浏览器持久化存储。不要删除登录存储来迁移安装来源。

原生更新资格由宿主安装来源判断，不靠插件注册更新 UI。新版本不应重新添加 GitHub 更新服务或自定义版本卡片。首次只有一个 npm 版本时，原生区显示已是最新版本；以后发布更高版本才有升级候选。

## 后续版本

更新 package.json 版本和说明，完成测试、包内容检查、敏感信息扫描及 CI，然后发布到同一 npm 包名。只发 GitHub Release 不会更新 npm，不能让 DSH 原生更新发现新版。

如以后配置 GitHub Actions 可信发布，应在 npm 的本包设置中明确授权对应仓库和工作流后再启用；当前仓库没有自动发布 npm 的工作流，也不保存 npm Token。

参考：[npm 公开包发布](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)、[npm 发布认证](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)、[pnpm publish](https://pnpm.io/cli/publish)。
