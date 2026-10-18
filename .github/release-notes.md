## English

- **Fixes "Credential refresh is locked" that never cleared on a phone.** The refresh lock was a marker that never recorded who held it and was never taken over, so when the app was killed mid-refresh - which is routine on a phone - the lock stayed behind and every later sign-in answered `SERVER_CREDENTIALS_BUSY`, telling you to delete a file you cannot reach. The lock records its holder now, and a competitor reclaims it when that process is **gone**. A live instance is still respected, including one that is merely suspended, so two instances can never refresh the same one-use token.
- If you are stuck on the old version: stop every DSH instance on the device, remove `server-credentials.json.refresh-lock` from `<DSH_HOME>/remote/servers/*/device/`, and authorize again. With this version that recovery is automatic.
- Everything from **0.5.1** and **0.5.2** ships here too: sign-in only through the browser authorization you just completed, signed out is a state rather than an error, Codex off by default, and the narrow-screen status pill centred and aligned with the header.

## 中文

- **修复手机上永不消失的「凭据刷新被锁定」。** 那把刷新锁只是一个标记，既不记录持有者、也从不被回收，所以 App 在刷新期间被系统杀掉（手机上很常见）后锁就永久留下，之后每次登录都返回 `SERVER_CREDENTIALS_BUSY`，还要求你删除一个根本够不到的文件。现在锁里会记录持有者，竞争者只在那个进程**已不存在**时才接管；**活着的实例（包括被挂起的）依旧不抢占**，所以两个实例不可能同时消费同一个一次性 token。
- 若你还停在旧版本：先停掉该设备上所有 DSH 实例，删除 `<DSH_HOME>/remote/servers/*/device/` 下的 `server-credentials.json.refresh-lock`，再重新授权。用这一版后该恢复会自动完成。
- **0.5.1** 与 **0.5.2** 的全部内容同样包含在本版：登录只经你刚在浏览器完成的授权、未登录是状态而非错误、Codex 默认关闭，以及窄屏状态药丸居中并与头部对齐。

[Full changelog / 完整改动](https://github.com/blue-soda/ds-harness-remote/compare/v0.5.2...v0.5.3) · [Installation / 安装说明](https://github.com/blue-soda/ds-harness-remote/blob/v0.5.3/README.md)
