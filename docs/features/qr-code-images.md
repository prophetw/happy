# 手机从相册识别二维码

iOS / Android App 的连接电脑、关联账户扫码入口提供三个选项：使用相机扫描、
照片图库、取消。选择照片图库后，可选取保存的二维码图片或截图，识别成功后沿用
当前入口的授权流程。

选图使用已有的 `expo-image-picker` 系统照片选择器，识别使用 `expo-camera` 的
`scanFromURLAsync`。图片在设备本地识别，不上传图片；相册路径不请求相机权限或
完整照片图库访问权限。未新增原生依赖或修改授权接口，Web 入口保持原有行为。

连接电脑仅接受 `happy://terminal?` 二维码，关联账户仅接受 `happy:///account?`
二维码。图片中有多个二维码时，使用第一个符合当前入口的二维码。无二维码、用途
不匹配和选图 / 识别失败分别提示错误；取消选图不发起授权。识别期间阻止重复选图。
图片无法识别时，可选择更清晰的图片，或先裁剪至二维码区域。

实现位于 `packages/happy-app/sources/hooks/useScanQrCode.ts`，由
`useConnectTerminal` 和 `useConnectAccount` 共用。相关自动化测试为
`sources/hooks/useScanQrCode.test.ts`，模拟原生模块验证选图到授权的调用链。
系统选图界面、真实图片解码及最终连接结果需在 iOS / Android 真机验收。
