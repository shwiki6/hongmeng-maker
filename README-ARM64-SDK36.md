# SDK 36 ARM64 Ubuntu 工具

工作流 [`Build SDK 36 ARM64 tools`](.github/workflows/build-arm64-sdk36-tools.yml)
在 `ubuntu-24.04-arm` 上运行，编译的是能在 Ubuntu ARM64/glibc 环境运行的
`aapt2`，不是 Termux 的 Android 动态链接版本。

构建前会使用 SDK 36 的 `android.jar` 执行 AAPT2 资源编译和链接验证。成功后，
Actions artifact 和 GitHub Release 会提供：

- ARM64 `aapt2`
- ARM64 `zipalign`
- Java `apksigner`（由 SDK 36 提供）
- `apktool_2.11.1.jar`
- ARM64 `adb`（如果 SDK 包提供）
- SHA-256 校验文件

在当前设备下载 Release 压缩包后，解压并将其中的工具放入 `PATH`。不要使用
`aapt2-termux` Release 中请求 `/system/bin/linker64` 的二进制替换 Ubuntu 的
`aapt2`。
