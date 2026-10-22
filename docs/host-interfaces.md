# 宿主接口 ↔ 真实宿主用例对照

本页回答一个问题：**这个插件用到宿主的哪些东西，哪条用例对真实宿主真调过它**。

跑法只有一条命令，只认一个环境变量：

```powershell
$env:DSH_HOST_ROOT = 'C:\path\to\.build\desktop\dsh-plugin-desktop'
npm run check:host
```

`DSH_HOST_ROOT` 指 staged 宿主的 `dsh-plugin-desktop` 目录。仓库内部把它映射到旧名
`DSH_RUNTIME_ROOT`（T0047 之前的三个契约文件读这个名字），门禁不需要知道。本地想一次
跑多个宿主时可以用 `DSH_HOST_ROOTS`（`;` 或 `,` 分隔），这只是本地便利，门禁不传。

**没有 `DSH_HOST_ROOT` 时，30 条用例全部报 `NOT EXECUTED`，退出码 1。** 没跑过的腿不是
通过的腿。`npm test` / `npm run test:cases` 也会把它们单列成 `not-executed`，既不算通
过，也不因此变红——它们归 `check:host` 管。

## 用例设计口径（T0047 A″）

为了让下一次上游升级不必连带改一堆用例：

- **只断言插件真正依赖的东西**：它调的接口、它读的字段、它订阅的事件。不断言宿主全
  貌——不比事件词表大小、不逐字比 endpoint 清单、不锁宿主内部字段的数量或顺序。
- **形状校验优先用宿主自己的 schema / 校验器**（`WebServer.Config`、工具运行时的
  `assertObjectJsonSchema` 与 `validateJsonSchemaValue`），不手写期望对象。宿主没有发布
  值校验器的地方（`agent-default-model` 的选择），用宿主自己的往返代替。
- **宿主新增一律兼容**：新增适配器方法由继承自动可用，新增 settings 条目被忽略，新增
  事件不会被订阅。没有一条用例因为宿主变大而变红。
- 每条用例的标题和注释写明它护住的是哪一条依赖，红了能一眼看出该改插件还是宿主破了契约。
- 反向对照（同源围栏、工具入参、适配器继承）保留，但只碰插件自己走的那条路径。

## 真实到什么程度

`scripts/host-contract-harness.mjs` 的 `liveHost` 在 DSH 0.2 线上用**宿主自己的
`boot()`** 起一个一次性 profile：真实 Loader、真实 settings 服务、真实 web server、真实
llm 注册表、真实文件凭据服务、真实附件存储、真实工具运行时、真实 Agent 注册表、真实
`llm-pi-ai`，并且**由宿主的 Loader 按镜像 `cordis.patch.yml` 的条目激活本插件**。

DSH 0.1.5 没有 `@deepseek-ai/dsh-config-editor`、也没有 `@deepseek-ai/dsh-hmr`，profile
起不来；那条线用 `mode: 'services'`：同一批真实服务类挂在真实 Context 上，settings 用宿主
真实的 `SettingsProvider`（只有它的文档持久化换成内存，否则会写到用户的 profile），插件
经自己导出的 `apply` 进入。每条用例都会打印自己跑在哪种模式下。

**被打桩的只有三处，都不是宿主接口**：

| 边界 | 为什么 |
|---|---|
| TokensAPI 自己（`https://tokensapi.ai/v1` 的目录读取） | 插件的出网 HTTP。契约用例不该花付费额度、也不该依赖网络 |
| 某些用例停在受管线路后面的上游适配器 wire | 那些用例测的是插件的转发，不是 pi-ai |
| 0.1.5 上 settings 的文档落盘 | 真实 provider 会写用户的 profile 文档 |

## 对照表

“用例”列的编号对应 `test/test_cases.csv` 里的行（编号、标题、前置条件、步骤、预期都在那里）。

### 宿主侧（`dsh/index.js`）

| 宿主接口 | 插件依赖的是什么 | 用例 |
|---|---|---|
| `export const inject = ['tools','agents','attachments','llm','credentials']` | Loader 的硬门槛：有一个名字解析不到，条目被挂起，插件整体不运行 | HOST-002 |
| `ctx.llm.registerAdapter(ids, adapter)` | 发布 `modlens-tokensapi` 包装线路 | HOST-003 |
| `ctx.llm.listProviders()` | 读当前被路由的线路，判断上游是否已挂载 | HOST-003 |
| `ctx.llm.listModels(provider)` | 读一条线路的目录，桥接成孪生目录 | HOST-003、HOST-020…022 |
| `ctx.llm.resolveModelInfo(provider, model, signal)` | 读 `provider`/`id`/`inputModalities` | HOST-004 |
| `ctx.llm.prepareCall(config, signal)`（注册表） | 把一次调用绑定到受管线路的同一代适配器 | HOST-004 |
| `LlmAdapter.prototype.prepareCall(provider, model, signal)`（基类，继承） | 包装器必须经自己的 `resolveModel` 解析，返回桥接孪生模型 | HOST-023 |
| `ctx.llm.providerRetryPolicy(provider)` | 原样转发上游策略（dsh 在注册时快照它） | HOST-005 |
| `ctx.llm.imageRequestPricing(provider, model)` | 原样转发上游图片计价，供压缩与 TokenMeter | HOST-006、UP-001、UP-002 |
| `ctx.llm.stream(options)` + `llm/stream` 瀑布 | 路由切换写入未落地时在这里挡住调用，再 `yield* next()` | HOST-007 |
| 宿主 `LlmAdapter` 基类本体 | 包装器是它的实例，基类声明的每个方法都能作答（新增方法自动继承） | HOST-023 |
| `ctx.credentials.describe(ref).configured` | 认证门禁的判定 | HOST-008 |
| `ctx.credentials.set(ref, value)` | 保存 Key 与验证指纹 | HOST-008、HOST-009 |
| `ctx.credentials.resolve(ref).value` | 出网 Bearer（只读 `.value`） | HOST-008 |
| `ctx.on('credentials/reference-updated')` | 凭据变化后重算目录（DSH 0.2.1 的 `set` 不发 `llm/adapters-updated`，T0033） | HOST-009、HOST-021 |
| `ctx.on('llm/adapters-updated')` | 拓扑变化后重算包装与目录 | HOST-003、HOST-022 |
| `ctx.on('credentials/record-updated')` | 与上面同一组协调触发器 | HOST-009（与另两个事件同一条协调路径） |
| `ctx.on('agent/pre-step')`（waterfall + `next()`） | 文本模型遇到图片块时改写消息集，`next()` 之后执行 | HOST-010、LANG-007 |
| `ctx.attachments.readImage(ref, signal)` → `.data`、`.ref.mediaType` | 读粘贴图片的字节与媒体类型 | HOST-010 |
| `ctx.attachments.saveImage(input)` → `.attachmentId`/`.mediaType` | 用例侧用它造真实引用；插件读回的就是这种引用 | HOST-010 |
| `ctx.tools.register(definition)`（裸 JSON Schema） | `modlens_read_image` 必须被宿主的 schema 准入接受并渲染给模型 | HOST-011 |
| `ctx.webServer.register({kind:'exact', path, handler})` | 浏览器半边唯一的入口；三条路由 | HOST-012 |
| `/tokens/model-manager` GET/POST 的回包字段 | 浏览器半边读 `provider`/`authenticated`/`mainModel`/`mainProvider`/`models` | HOST-012、HOST-031…034 |
| 同源回环围栏（`host`/`origin`/`sec-fetch-site`） | 路由只答同源回环 | HOST-013（反向对照） |
| `scope.settings.register(ns, schema, {base})`（0.1） | 0.1 线上注册自己的命名空间 | HOST-014 |
| `scope.settings.get(ns)`（0.1） | 0.1 线上读回保存的选择 | HOST-014 |
| `scope.settings.describe()` → `{ns, value}`（0.2） | 0.2 线上读自己的条目、`llm-pi-ai` 条目与宿主默认模型 | HOST-014、HOST-015 |
| `scope.settings.update(entryId, patch)`（0.2） | 真正写 `llm-pi-ai` 线路 | HOST-014 |
| `scope.settings.replace(ns, value)`（0.2） | 整份写回自己的条目（`update` 的合并会让删掉的 per-model 覆盖复活） | HOST-014 |
| `scope.settings.configure({auto:false}, owner)` | 让设置页别再生成一份无防护的表单 | HOST-014 |
| `scope.settings.mutate(ns, ops)` | 宿主提供时才转发，可选 | HOST-014（可用性） |
| `agent-default-model` 条目的 `provider`/`model` | 启动时以宿主持久化的默认模型为准 | HOST-015 |
| `scope.agentDefaultModel.saveSelection({provider, model})` | 把用户的选择写回宿主默认模型 | HOST-015 |
| `ctx.inject([...], scope => …)` | 作用域注入：服务不在就不跑闭包（headless 不受影响） | HOST-002、HOST-012、HOST-014 |
| `ctx.effect` / `scope.effect` / `ctx.fiber` | 给 `configure` 的策略找正确的归属 fiber 并挂 disposer | HOST-014 |
| 宿主 `TokenMeter` / `BasicCompactionEngine` 对包装线路的计量与压缩 | 包装线路必须能被宿主自己的计量与压缩吃下 | UP-001、UP-002 |
| 宿主 settings 驱动的界面语言（`locale`） | 缓存失败提示要跟着宿主语言走 | LANG-007 |

### 浏览器侧（`dsh/client.js`）

| 宿主接口 | 插件依赖的是什么 | 用例 |
|---|---|---|
| `ctx.inject(['slots','sessions','modelDirectories'], …)` | 三个服务齐备才装设置区与会话投影 | HOST-031…034 |
| `scope.modelDirectories.directoryFor(sessionId)` | 拿到会话的模型目录 | HOST-031…034 |
| 目录的 `select(selection)` 结果 `{ok}` | 菜单只在宿主的 `select()` 落定时关闭（T0041） | HOST-030…034 |
| 目录的 `load()` | 路由切换后重载目录 | HOST-031、HOST-034 |
| 目录的 `store` 的 `getSnapshot`/`update`/`subscribe` | 受管目录投影挂在宿主 store 上 | HOST-031…034 |
| 宿主 `dsh-client-store` 的 store 引擎（zustand / immer） | 座位与受管投影跑在宿主真实的 copy-on-write store 上，而不是替身 | HOST-036，并见下方缺口 |
| `scope.sessions.list.getSnapshot()` / `subscribe()` | 0.1 读 `current`，0.2 由目录解析器回报会话 | HOST-030…034 |
| `scope.sessions.subagentAddress(id)` | 带地址的子代理会话不暴露模型选择 | HOST-030…034 |
| `scope.slots.register(def, Component)` / `slots.inject('settings.section', …)` | 设置页的「模型」区 | 见下方缺口 |

## 已知缺口（显式报出，不计通过）

| 缺口 | 影响 | 怎么报的 |
|---|---|---|
| DSH 0.1 线的 composer 座位 | `verify-composer-model-menu.mjs` 的座位夹具按 DSH 0.2 的会话投影面（`next`/`lastUsed`）搭的；0.1 的座位读另一套面 | 整文件在 0.1 宿主上报 `NOT EXECUTED on DSH 0.1.5-rc.2: …`，`check:host` 把带线号理由的未执行单列出来、不计通过。0.1 线上的 composer 行为本页不覆盖 |
| `settings.section` 插槽声明 | 插槽由宿主 shell 声明，staged 宿主的包里没有可直接挂载的声明链；手写声明等于抄被测对象 | 浏览器侧的插槽注册没有真实宿主用例，上表最后一行即此缺口。座位侧（`modelDirectories`/`sessions`）是真实宿主构件 |
| `zustand` / `immer` | staged 宿主的渲染层是预构建的，不带这两个包，所以这两个包由本仓库自己钉住（devDependencies `zustand` 4.5.7、`immer` 10.2.0），座位夹具只从本仓库的 `node_modules` 解析 | HOST-036 守住两件事：两个包都装在本仓库内、解析路径不出本仓库；大版本与宿主 `dsh-client-store` 声明的一致（只判大版本——两条受支持的线本身就不一致：0.2.0-rc.2 声明 `~4.4.7`、0.2.1-rc.2 声明 `~4.5.7`；宿主哪天不再声明则只记录不判红）。没装时整文件报 `NOT EXECUTED: install this repository's dependencies first; not in node_modules: …`，**没有线号，`check:host` 视为失败**，不会悄悄跳过 |

## 门禁有效性

用例不能是空转。最近一次实测：把包装器转发的 `ctx.llm.providerRetryPolicy` 改成一个宿主
没有的方法名，在 DSH 0.2.1-rc.2 上只有 HOST-005 变红，其余 28 条仍绿；改回即全绿。
`CHANGELOG.md` 的 0.2.27 条目记录了这次实测。

HOST-036 同样做过变异验证（0.2.28）：把本仓库 `node_modules/zustand` 改名后，在 harness
的 pnpm store **仍有一份 zustand 4.4.7** 的情况下，HOST-030…035 报 `NOT EXECUTED`、
HOST-036 变红（`passed 23, failed 1`）；改回即 30/30。这证明本仓库之外的目录确实不再参与
解析——这正是 T0051 的根因：之前那份 pnpm store 门禁从不安装，于是本机绿、CI 上那六条
整轮 `NOT EXECUTED`。反向也测过：把 harness pnpm store 里的 zustand / immer 两个条目临时
改名，`check:host` 仍是 30/30。
