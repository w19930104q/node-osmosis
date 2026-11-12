# 导航上下文隔离修复 — 交付说明

针对 `rchipka/node-osmosis@baed7239` 的修复。原始问题：`paginate` 把页码
`count` 挂在共享的 request 上，`follow` 的并发分支又复用同一文档上下文，
分支一多就无法确认某条数据来自哪一次跳转。

## 一、核心设计：Navigation 上下文树

新增 `lib/Navigation.js`。每次 `Command.request` 触发的 HTTP 请求都创建一个
**独立的 Navigation 子上下文**，其父节点是发起该请求的页面：

- **隔离（各自私有）**：页码 `count`、请求参数、最终 `location`、`response`、
  重定向记录 `redirects`、停止状态 `stopped`。
- **继承（克隆而非共享）**：`cookies`、`headers` 从父导航深拷贝，子导航之后
  写入任何 cookie/header 都不会污染兄弟分支或父页面。
- **链根（chainRoot）共享**：访问历史 `urls` 与已提交页数 `submitted` 挂在链
  根上，使翻页循环检测与 `limit` 预算在同一条翻页链的各页之间延续。
- **`follow` 开新链**：每个被跟进的链接调用 `branch()`，拥有独立的预算与历史，
  因此一个页面里多个 `follow` 分支的 `limit` 互不挤占，但仍继承父页 cookie/header。
- **停止沿父链传播**：`isStopped()` 向上遍历父链；`stop()` 只停本链，兄弟分支
  已排队的请求照常运行，实例级 `instance.stopped` 不受影响。

`Navigation.clone` 使用 `for-in` 而非 `Object.keys`，因为 osmosis 的选项通过
`Object.create(getOpts())` 形成原型链，cookie/header 的有效键可能是继承来的
可枚举属性。

## 二、各文件改动

### `lib/Navigation.js`（新增）
上下文对象，含 `branch / track / hasVisited / submittedPages / stop /
isStopped / setCookies / setRequestHeaders / addRedirect`，以及静态
`clone` 与 `fromDocument`（从 libxmljs Document/Element 解析所属导航）。

### `lib/Command.js`
- `start` 在执行命令前检查所属导航 `isStopped()`，已停的链不再启动后续命令。
- `request` 是隔离的核心：
  - 先把 `opts.cookies` / `opts.headers` 物化为自有属性（克隆），打断原型链上
    的共享对象别名；
  - 基于父导航 `new Navigation(...)`，`follow` 时 `branch()`；
  - 有上下文时，referer 写入克隆后的 header；cookie 按“继承罐在前、显式配置在
    后”合并，保持历史上的 header 插入顺序；
  - 每次排队前 `chainRoot.submitted++`（`limit` 按**已提交页面**计数）；
  - 响应回来后把 navigation 绑定到 document；代理轮换逻辑保持不变。

### `lib/Request.js`
- `url` 视为**不可变**：每次尝试克隆出独立的 `location` / `requestParams` /
  `requestOpts`，重定向只改本地 `location`，重试因此永远重发发起页的原始请求。
- `cloneParams` 保留 `null/undefined`（needle 会把非空 data 字符串化并盖掉 URL
  自带 query）；`cloneLocation` 始终暴露 `params` 对象，使
  `document.request.params.page` 在无参 GET 下也可用。
- 成功回调把响应、cookie、请求头、最终 location 绑定到对应 navigation。
- **重定向记录**：每次尝试开始时清空 `navigation.redirects`（重试不累积旧跳）；
  事件做逐跳尽力记录，响应回来后 `reconcileRedirects` 用权威的“发起 URL / 最终
  URL”纠正首尾，保证单跳跨域重定向的 from/to 始终准确。

### `lib/commands/paginate.js`
- 页码取自 `navigation.count`，不再用共享 request 上的 count；
- 两处 `limit` 判断都以 `submittedPages()`（已提交页数）为准；
- 循环检测只对 **GET + 链接型选择器** 且 URL 已访问过生效——POST 表单、参数型/
  函数型翻页本就会以不同 body/参数重访同一路径，不应误判；
- 缺少“下一页”链接时干净 `done('no results ...')` 终止；
- 回调里把新文档的 `count` 显式置为 `count + 1`。

### `lib/commands/follow.js`
- 父链已停则立即结束；每个有效链接节点都以 `{ branch: true }` 发起独立链；
- 不做去重：重复链接按“每个链接节点一个请求”处理，结果靠 `_dataSortIndex`
  保持文档顺序（去重曾导致 `resume.js` 的 50 个相同链接用例失败）。

### `lib/commands/submit.js` / `lib/commands/login.js`
执行前检查所属导航 `isStopped()`，已停则结束；请求机制不变，navigation 在
`Command.request` 内自动建立，因此并发、重试、302 后仍绑定发起页。

### `index.js`
`request / queueRequest / dequeueRequest` 全程携带 navigation 参数；重试路径
复用同一个 navigation，保证一次逻辑请求的多次尝试归属同一上下文。

## 三、保留的既有能力

链式 API、`pause`/`resume`/`stop`、代理（含代理数组轮换）、data 顺序
（sortIndex 机制）均保持不变；`package.json` / `package-lock.json` 未改动。

## 四、本地门控 HTTP 回归

`test/navigation_context.js`，全部使用临时端口上的自建 HTTP 服务器，无外部
网络依赖，共 10 个用例 / 60 个断言，覆盖任务要求的全部场景：

| 用例 | 覆盖点 |
| --- | --- |
| `concurrent_branches_isolated` | 并发分支（4 分支 × 5 页，页码/预算互不串扰） |
| `post_pagination` | POST 表单翻页 `[1,2,3,4]` |
| `cross_host_redirect` | 跨端口 302：redirects、cookie 保持、绑定发起页 |
| `duplicate_links_keep_order` | 重复链接（每节点一请求，排序多重集断言） |
| `concurrent_follow_keeps_sort_index` | 并发 follow 后 sortIndex 仍为 0..4 |
| `stop_terminates_branch` | 停止后无更多数据 |
| `failure_retry_and_rerun` | 两次失败后重试成功，再独立重跑 |
| `pagination_loop_terminates` | 循环下一页自动终止 |
| `missing_next_link_terminates` | 缺省“下一页”链接正常终止 |
| `limit_counts_submitted_pages` | limit 按已提交页面计 `[1,2,3]` |

运行（需要 Node 8，libxmljs 0.19.5 预编译 ABI）：

```bash
export PATH=/path/to/node-v8.17.0-linux-x64/bin:$PATH
node ./node_modules/.bin/nodeunit test/navigation_context.js
```

门控文件连续 20 次运行均为 `OK: 60 assertions`。

## 五、已知环境限制（与本次修复无关，pristine 同样失败）

完整套件在本机（WSL2 + Node 8.17.0 + needle 1.6.0）下仅剩两个失败，在未修改
的 `baed7239` 基线上同样复现（基线下甚至表现为用例挂起 Undone）：

- `test/get.js` 的 `error_redirect`、`test/config.js` 的 `instance_cookies`。

根因是 needle 1.6.0 的两个既有缺陷：

1. **重定向事件竞态**：请求在 `.start()` 内同步发起，`redirect` 事件可能在
   调用方挂监听前就发出（实测本机回环约 1/3 的首跳事件丢失）。needle 的
   Needle 构造器是闭包私有、无 socket 前钩子、也不暴露重定向历史，外部无法
   100% 捕获多跳链的中间跳。本修复用权威 URL 兜底保证**单跳**重定向（门控
   覆盖的常见情形）from/to 永远正确；
2. **跨端口重定向的 socket 中断**（`Remote end closed socket abruptly`），
   属 needle 底层连接处理问题。

除上述两个既有环境失败外，原有 278 个断言与新增 60 个断言全部通过。
