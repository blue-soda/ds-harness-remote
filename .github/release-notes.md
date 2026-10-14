## English

- **Fixes the Remote status pill on narrow screens.** Below 760px it was anchored 88px from the right edge - where the harness has already collapsed its own row - so it sat visibly off-centre, and its text rode about 4px lower than the "open sidebar" button beside it, because that branch's border and padding grew a rule declared as `height:28px` to 36px. The pill is centred on the viewport now, and both branches keep the same 28px outer height, so the text shares the header's centre line. Wide screens are unchanged.
- Everything from **0.5.1** ships in this version too: signing in registers a device only through the browser authorization you just completed, being signed out is a state rather than an error (the card offers its sign-in button, with no error text), and Codex is off by default - turn it on in the DeepSeek Remote settings card.

## 中文

- **修复窄屏下 Remote 状态药丸的位置。** 760px 以下它被固定在距右边 88px 处（而 Harness 此时已收起自己那一行），因此明显偏右；文字又比旁边的「打开侧边栏」按钮低约 4px，原因是该分支的边框与内边距把一个声明为 `height:28px` 的规则撑到了 36px。现在药丸在视口中居中，且两支保持相同的 28px 外框高度，文字与头部共用同一条中线。宽屏表现不变。
- **0.5.1** 的全部内容同样包含在这一版里：登录只有经你刚在浏览器完成的授权才会注册设备；未登录是状态而非错误（卡片显示登录按钮、不报错）；Codex 默认关闭，可在 DeepSeek Remote 设置卡片中开启。

[Full changelog / 完整改动](https://github.com/blue-soda/ds-harness-remote/compare/v0.5.1...v0.5.2) · [Installation / 安装说明](https://github.com/blue-soda/ds-harness-remote/blob/v0.5.2/README.md)
