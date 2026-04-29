# Transjux for Safari

Transjux 是一个 Safari Web Extension，用于网页文本翻译：

- 划词翻译（气泡展示）
- 整页翻译（保留原文，在正文块下插入译文）
- 沉浸式阅读（可在弹窗中开启）
- 多服务配置（微软免费翻译 / OpenAI-compatible 接口）

## 主要功能

### 1) 划词翻译

- 选中文本后触发翻译
- 结果在页面内气泡显示
- 支持复制、固定、拖拽、尺寸记忆

### 2) 整页翻译

- 面向正文区域进行分块翻译
- 保留原网页结构与交互
- 可手动还原已插入译文

### 3) 沉浸式阅读

- 在弹窗中开启/关闭
- 开启后支持自动划词翻译
- 滚动到新区域时自动继续翻译
- 页面右下角有沉浸状态按钮

### 4) 翻译服务管理

- 支持多套 API 配置
- 支持快速切换当前服务
- 默认包含微软免费翻译配置

## 项目结构

```text
web-extension/
  manifest.json
  background.js
  content.js
  popup.html
  popup.js
  options.html
  options.js
  api.js
```

## 配置说明

### OpenAI-compatible

需要填写：

- Base URL
- API Key
- Model

注意：Model 必须是服务端可识别的模型名，不要使用本地相对路径（如 `./model/...`）。

### 微软免费翻译

默认可直接使用。

## 快捷键（建议）

- `Option + T`：翻译选区
- `Option + Shift + T`：翻译当前页
- `Option + I`：切换沉浸式阅读

具体生效键位以 Safari 扩展快捷键设置为准。

## License

Private project.
