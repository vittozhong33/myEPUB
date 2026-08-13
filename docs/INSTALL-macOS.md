# myEPUB macOS 安装说明

## 适用设备

- macOS
- Apple Silicon 芯片 Mac：M1、M2、M3、M4
- 不需要安装 Node.js、Rust、Tauri 或任何开发工具

## 推荐安装方式

1. 下载 `myEPUB_0.1.0_mac_arm64_installer.dmg`
2. 双击打开 DMG 文件
3. 双击 `myEPUB Installer.pkg`
4. 按安装器提示完成安装
5. 从 `应用程序` 中打开 `myEPUB`

## 如果 macOS 提示无法打开

当前安装包还没有 Apple Developer ID 签名和公证。第一次打开时，macOS 可能会提示“无法验证开发者”。

处理方式：

1. 打开 `系统设置`
2. 进入 `隐私与安全性`
3. 找到关于 `myEPUB` 的拦截提示
4. 点击 `仍要打开`
5. 再次打开 `myEPUB`

也可以在 `应用程序` 中右键点击 `myEPUB`，选择 `打开`。

## 重要说明

- 安装包只安装 myEPUB 应用本身。
- 导入的 EPUB 图书会保存在你自己的 Mac 本地，不会上传到网络。
- 当前版本是 Apple Silicon 版，不适用于 Intel Mac。
- 如果想让安装过程完全没有安全提示，需要使用 Apple Developer ID 对应用进行签名和公证。

