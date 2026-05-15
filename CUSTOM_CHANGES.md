# 自定义修改清单（上游合并参考）

> 本文档记录了对上游仓库 `QLHazyCoder/codex-oauth-automation-extension` 的所有自定义修改。
> 合并上游更新时，可搜索 `[CUSTOM]` 标记快速定位所有自定义代码。

---

## 一、自定义新增文件（无冲突风险）

这些文件完全独立于上游代码，合并时不会产生冲突：

| 文件 | 说明 |
|------|------|
| `sidepanel/team-auth-addon.html` | Team 自定义认证独立页面 |
| `sidepanel/team-auth-addon.css` | Team 自定义认证样式 |
| `sidepanel/team-auth-addon.js` | Team 自定义认证主控制器 |
| `sidepanel/team-auth-steps.js` | Team 认证步骤实现（邀请/清理成员、QQ 邮箱轮询、邀请邮件获取失败自动重发等） |
| `sidepanel/team-auth-utils.js` | Team 认证工具函数（含通用重试 `withRetry`） |
| `sidepanel/team-auth-scheduler.js` | Team 自定义认证定时调度器 |
| `sidepanel/team-auth-entry.js` | Sidepanel 入口按钮注入（零侵入 DOM 注入） |
| `content/workspace-auto-select.js` | Workspace 选择页自动跳过（OAuth 登录后选择个人帐户） |
| `icons/transit-station-320.png` | 自定义图标 |
| `icons/transit-station.svg` | 自定义图标 |

---

## 二、已修改的上游文件（需合并时注意）

### 1. `manifest.json`（2 处修改）

**无 [CUSTOM] 标记**（JSON 不支持注释）。

```
第 7 行: "incognito": "spanning",
    → 目的：启用无痕窗口访问权限，使扩展在 spanning 模式下运行

第 58 行: "content/workspace-auto-select.js"
    → 目的：注册 workspace 自动选择 content script
```

### 2. `sidepanel/sidepanel.html`（1 处修改）

```
第 1652-1653 行:
    <!-- [CUSTOM] Team Auth 自定义认证入口按钮注入 -->
    <script src="team-auth-entry.js"></script>
    → 目的：加载 Team Auth 入口脚本
```

### 3. `background/steps/open-chatgpt.js`（3 处修改）

```
第 44 行: [CUSTOM] getStep1NonIncognitoStoreIds 函数
    → 目的：新增函数，仅收集非无痕 cookie store
    → 原始代码：无此函数

第 88 行: [CUSTOM] collectStep1Cookies 中使用 getStep1NonIncognitoStoreIds
    → 目的：替换原始的 getAllCookieStores 遍历逻辑
    → 原始代码：直接遍历所有 cookie stores

第 159 行: [CUSTOM] 移除 browsingData.removeCookies 补扫
    → 目的：避免清除无痕窗口中的主账号 cookies
    → 原始代码：此处有一段 browsingData.removeCookies 调用
```

### 4. `background/tab-runtime.js`（4 处修改）

```
第 133 行: [CUSTOM] .filter((tab) => !tab.incognito)
    → 目的：closeObsoleteSourceTabs 时排除无痕标签页
    → 原始代码：无此 filter

第 535 行: [CUSTOM] getNormalWindowId 函数
    → 目的：获取非无痕窗口 ID，用于 tab 创建时指定 windowId
    → 原始代码：无此函数

第 545 行: [CUSTOM] createTabInNormalWindow 函数
    → 目的：在非无痕窗口中创建标签页，替代直接使用 chrome.tabs.create
    → 原始代码：无此函数

第 554/580/652 行: [CUSTOM] reuseOrCreateTab 无痕窗口隔离
    → 目的：创建 tab 时使用 createTabInNormalWindow；复用已有 tab 前检查是否在无痕窗口
    → 原始代码：直接使用 chrome.tabs.create({ url, active: true }) 无 windowId 指定
```

### 5. `content/signup-page.js`（5 处修改）

```
第 2582 行: [CUSTOM] isCombinedVerificationProfilePage() 函数
    → 目的：识别验证码+姓名/年龄同页的组合表单
    → 原始代码：无此函数

第 2599 行: [CUSTOM] /about-you/ 路径匹配
    → 目的：新的 OpenAI 注册页 URL 格式适配
    → 原始代码：仅匹配 /create-account/profile

第 2678 行: [CUSTOM] getStep4PostVerificationState URL 优先判断
    → 目的：URL 匹配时直接视为已通过验证码阶段
    → 原始代码：仅通过 DOM 状态判断

第 2693 行: [CUSTOM] 组合表单守卫
    → 目的：组合表单上验证码和姓名/年龄同时存在时，不提前进入步骤 5
    → 原始代码：无此守卫（直接判断 isStep5Ready）

第 6122 行: [CUSTOM] step5 循环式 about-you 页面 timeout 重试
    → 目的：about-you 页面加载时可能连续出现 Operation timed out，
            需循环点击重试按钮直到页面正常加载（最多 10 轮）
    → 原始代码：无此重试逻辑
```


### 6. `tests/signup-verification-state-guard.test.js`（3 处修改）

```
第 108/171/223 行: [CUSTOM] 组合表单 mock 函数
    → 目的：为新增的 isCombinedVerificationProfilePage 提供测试 mock
    → 原始代码：无此 mock
```

### 7. `tests/step4-submit-retry-recovery.test.js`（3 处修改）

```
第 64/119/172 行: [CUSTOM] 组合表单 mock 函数
    → 目的：同上
    → 原始代码：无此 mock
```

### 8. `background/steps/wait-registration-success.js`（2 处修改）

```
第 41 行: [CUSTOM] getStep6NonIncognitoStoreIds 函数
    → 目的：新增函数，仅收集非无痕 cookie store（与步骤 1 的 open-chatgpt.js 保持一致）
    → 原始代码：无此函数

第 88 行: [CUSTOM] collectStep6Cookies 中使用 getStep6NonIncognitoStoreIds
    → 目的：替换原始的 getAllCookieStores 遍历逻辑，避免清除无痕窗口中主账号 cookies
    → 原始代码：直接遍历所有 cookie stores

第 125 行: [CUSTOM] 移除 browsingData.removeCookies 补扫
    → 目的：避免清除无痕窗口中的主账号 cookies（同步骤 1 的处理）
    → 原始代码：此处有一段 browsingData.removeCookies 调用
```

### 9. `background/steps/fetch-signup-code.js`（2 处修改）

```
第 32 行: [CUSTOM] ensureContentScriptReadyOnTab / SIGNUP_PAGE_INJECT_FILES 依赖
    → 目的：步骤4执行前确保 content script 已在目标标签页上注入
    → 原始代码：无此依赖

第 134 行: [CUSTOM] ensureContentScriptReadyOnTab 调用
    → 目的：页面从 chatgpt.com 导航到验证码页后，动态注入的 content script
            被销毁。如果新页面不在 manifest content_scripts 的 matches 范围内，
            需手动重新注入，否则 PREPARE_SIGNUP_VERIFICATION 消息返回 undefined
    → 原始代码：无此调用
```

### 10. `background.js`（1 处修改）

```
第 10690 行: [CUSTOM] step4Executor 依赖注入
    → 目的：向 createStep4Executor 传入 ensureContentScriptReadyOnTab 和
            SIGNUP_PAGE_INJECT_FILES 依赖
    → 原始代码：step4Executor 创建时无此两项依赖
```

---

## 三、合并上游更新 Checklist

1. `git fetch upstream && git merge upstream/master`
2. 如遇冲突，搜索 `[CUSTOM]` 定位自定义代码
3. 对于 `manifest.json`：确保 `"incognito": "spanning"` 和 `workspace-auto-select.js` 仍存在
4. 对于 `signup-page.js`：确保 4 处 `[CUSTOM]` 标记的代码块完整
5. 对于 `wait-registration-success.js`：确保 3 处 `[CUSTOM]` 标记的代码块完整
6. 运行测试验证：`node --test tests/`
