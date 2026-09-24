# 风景画廊 · Flickr Landscape Gallery

为 `H:\HDownload\Flickr` 中的 3,688 张风景原片(约 132 GB)构建的本地画廊。
零依赖纯前端(无构建框架、无外部请求),支持双击直开,也提供带热更新的一键服务器。

## 打开方式

**推荐:双击 `H:\HDownload\Flickr-Gallery\start-gallery.cmd`** — 会弹出**文件夹选择菜单**:

```
  ════════════════════════════════════════════════════════════
    风景画廊 · Landscape Gallery — 选择要浏览的文件夹
  ════════════════════════════════════════════════════════════
    1) Flickr 风景集(默认)     3688 张   H:\HDownload\Flickr
  ────────────────────────────────────────────────────────────
    N) 选择新文件夹…  (弹窗浏览;也可把文件夹拖进本窗口)
    E) 配置文件位置: …\folders.json
    Q) 退出
```

- 输入序号 → 打开已记住的文件夹；**`N` → 弹出系统文件夹选择窗口**
- 或**把文件夹直接拖到 `start-gallery.cmd` 上**，直接打开它
- 选定后启动服务器(默认 `http://127.0.0.1:8420`)并自动打开浏览器
- **热更新已启用**:只有真正构成页面的那 6 个文件(`index.html` / `styles.css` / `app.js` / `config.js` / `data.js` / `folders.json`,以及 `sets/<id>/data.js`)变化才刷新页面。
  早期实现监听整个目录,任何其它写入(日志、`.gitignore`、杂物文件)都会让所有标签页刷新——现已改为**白名单**。
- `--no-reload` 同时关闭监听与注入的刷新客户端。**跑测试请用它**,否则中途的热重载会打断测试步骤:
  `node build\server.js --no-open --no-reload`

**关闭:双击 `stop-gallery.cmd`** — 停止全部画廊服务实例(含历史残留;端口顺延可能产生多个),并验证端口已释放。

> ⚠️ **修改代码前建议先关闭服务**:运行中的服务器会监听目录并读取文件,与编辑器的原子替换争用文件句柄,
> 可能导致写入报 `EIO / Win32 1175`。关闭后编辑即可正常写入(实测确认)。

**备用:直接双击 `index.html`**(file:// 协议同样完整可用,通过相对路径访问同盘的 `../Flickr` 原图)。

## 文件夹配置(folders.json)

画廊根目录下的 `folders.json` 就是文件夹清单,启动时读取它做菜单,你也可以直接编辑:

```json
{
  "_help": "在这里增删条目即可。name 是菜单里显示的名字,path 是图片文件夹。",
  "default": "H:\\HDownload\\Flickr",
  "folders": [
    { "name": "Flickr 风景集(默认)", "path": "H:\\HDownload\\Flickr", "count": 3688 },
    { "name": "旅行照片",            "path": "H:\\Photos\\Trip2024" },
    { "name": "壁纸",                "path": "D:\\Wallpapers" }
  ]
}
```

- **每打开一个文件夹,它会被自动记录进来**(带 `lastUsed` 时间),下次直接在菜单里选
- 手工增删条目后立即生效;`count` 是缓存的图片数,会自动刷新
- 只支持 json 里的这些字段,写错格式时会自动回退到默认配置(不会崩)

## 查看其他文件夹(多数据集)

同一个画廊可以浏览**任意文件夹**里的照片,各自拥有独立的清单与缩略图,互不干扰:

```bat
start-gallery.cmd                              :: 弹出菜单选择文件夹
start-gallery.cmd "H:\Photos\Trip2024"         :: 直接打开该文件夹
start-gallery.cmd "D:\Wallpapers" --rebuild    :: 强制重建该文件夹的数据集
start-gallery.cmd "H:\Photos" --port 8500      :: 指定端口
start-gallery.cmd --list                       :: 只列出已配置的文件夹
```

**更简单:把文件夹直接拖到 `start-gallery.cmd` 上即可。**

首次查看某个文件夹时会自动扫描其中的 jpg/jpeg(含子文件夹,**每个子文件夹 = 一个可筛选的“收藏集”**),
并生成缩略图与预览(约每张 1 秒),存放在 `sets\<数据集名>\` 下:

```
Flickr-Gallery\sets\gallery-test-41870f\
├── data.js                该文件夹的清单(标题 / EXIF / GPS / 模糊占位)
└── assets\thumbs|preview  该文件夹的缩略图与预览
```

再次打开同一文件夹会**直接复用**已构建的数据集(加 `--rebuild` 可强制重建)。
默认画廊仍使用根目录的 `data.js` / `assets\`,完全不受影响。

## 功能

- **Flickr 式自适应行网格** — 行高可通过密度滑杆实时调节(120–420px),布局随窗口自适应
- **点击即原图** — 网格用 640px WebP 缩略图快速浏览;点击照片后**立即加载原始文件**(36–78MB,9504×6336 级),无任何中间画质层
- **秒开切换(双缓冲 + 预取 + 分级过渡)** — 从网格打开:**0ms 出画面**(用网格里已解码的 640px 缩略图打底,再升到 2560px 预览,最后原图淡入);灯箱内切换:预取命中 **0ms**、冷切换 40–170ms 见画面。鼠标在卡片上停留 120ms 即开始预取原图,点击几乎瞬时
- **专业灯箱** — 光标处滚轮缩放、拖拽平移(自动贴边)、双击 适应⇄100%、双指捏合、滑动切图
- **EXIF 信息面板** — 相机/镜头/焦距/光圈/快门/ISO/拍摄时间/GPS,一键跳转 OpenStreetMap 拍摄点与 Flickr 原页面
- **筛选与检索** — 收藏集、标题/文件名搜索、方向(横/竖/方/全景)、**年份(EXIF 自动生成)**、相机机型、五种排序
- **收藏与精选** — 照片星标收藏(卡片角标 / 灯箱 `S` 键),「只看收藏」筛选,跨会话持久保存
- **便捷按钮** — 🎲 随机看一张(`R`)、▶ 一键播放(`P`)、只看收藏(`F`)、一键重置筛选
- **统计面板** — 帮助弹窗内含年份/相机/方向分布与收藏数
- **幻灯片播放** — 空格键或播放按钮,**原图完全加载后**才开始倒计时,5 秒/张
- **深链分享** — 每张照片有 `#p=<id>` 直达链接,可通过「复制本页链接」分享定位
- **偏好持久化** — 主题、密度、筛选、排序、收藏、面板开关均自动保存于 localStorage
- **可访问性** — 完整键盘操作(按 `?` 查看帮助)、ARIA 标注、焦点管理(inert/focus)、遵循 prefers-reduced-motion

## 键盘快捷键

| 键 | 作用 | 作用域 |
|---|---|---|
| `R` | 随机看一张 | 首页 |
| `P` | 从第一张开始播放 | 首页 |
| `F` | 只看收藏 | 首页 |
| `/` | 聚焦搜索 | 全局 |
| `?` | 帮助与统计 | 全局 |
| `←` `→` | 上一张 / 下一张 | 灯箱 |
| `Home` `End` | 第一张 / 最后一张 | 灯箱 |
| `空格` | 幻灯片播放 / 暂停 | 灯箱 |
| `S` | 收藏当前照片 | 灯箱 |
| `I` `T` `F` | 信息面板 / 缩略图条 / 全屏 | 灯箱 |
| `+` `-` `0` `1` | 放大 / 缩小 / 适应 / 100% | 灯箱 |
| `Esc` | 关闭灯箱或清空筛选 | 全局 |

## 访问防护(服务器模式)

`build/server.js` 对 `/Flickr/` 与 `/assets/` 路由启用:

- **Referer 白名单** — 仅允许本机页面(`localhost` / `127.0.0.1` / `[::1]`)引用媒体;复制图片 URL 到别处或直接 curl 访问一律 **403**
- `Content-Disposition: inline` + `X-Content-Type-Options: nosniff` — 不触发下载、不做 MIME 嗅探
- **HTTP Range(206)** — 大文件断点续传与更稳的读取

> 浏览器本质上无法阻止截图或对已显示图片的另存;上述措施针对的是**直接下载、外链盗用与抓取**。

## 日志与行为埋点

### 分级日志(默认精简,`--debug` 开详细)

```bat
start-gallery.cmd                 :: 默认:只输出必要信息(info)
start-gallery.cmd --debug         :: 详细:进度/热更新/请求/客户端事件
start-gallery.cmd --quiet         :: 只输出错误
set GALLERY_LOG=debug && start-gallery.cmd      :: 环境变量等效写法
```

输出格式(带毫秒时间戳、级别、模块):

```
[2026-09-23 23:32:24.569] [INFO ] [build] images to process: 3688
[2026-09-23 23:32:24.747] [INFO ] [build] 完成:3688 张,缓存命中 0,失败 0,耗时 2557.6s
[2026-09-23 23:32:45.483] [DEBUG] [hot-reload] "app.js" changed → refreshing 1 client(s)
```

级别:`error < warn < info < debug`。构建进度每 500 张出一条 info 摘要,逐条进度属于 debug。

### 日志文件(自动落盘,离线回看)

服务器启动时会**同时把同一批记录写入文件**,所以用 `start-gallery.cmd` 起的后台服务即使关掉了窗口,日志也不会丢:

```
H:\HDownload\Flickr-Gallery\logs\gallery-YYYYMMDD.log        (每天一个,超过 4MB 自动分卷,只保留最近 5 个)
```

启动横幅会打印实际路径;`--no-log-file` 可关闭。文件里同时有服务器路由记录和**浏览器上报的全部行为埋点**(带 `[client]` 前缀),因此可以直接离线分析交互延迟:

```powershell
# 最慢的点击响应
Select-String logs\*.log -Pattern '\[client\] click' | ForEach-Object { if ($_ -match '"target":"([^"]+)".*"ms":(\d+)') { [pscustomobject]@{target=$Matches[1];ms=[int]$Matches[2]} } } |
  Sort-Object ms -Descending | Select-Object -First 10
```

排查体验问题的推荐姿势:先看 **warn/error**(`original.error` / `thumb.slow` / `js.error`),再看 **click 与 photo.paint 的 ms 分布**,最后用 `--debug` 起服务复现一次,拿到 `photo.nav` / `photo.preview` 级别的细节。

### Web 行为埋点(页面事件 → 同一套日志)

前端采集真实交互,经 `navigator.sendBeacon` **批量上报**(最多 20 条 / 1.5 秒一批)到 `/__log`,服务器用同一日志器写出:

| 事件 | 级别 | 延迟字段与含义 |
|---|---|---|
| `page.firstPaint` | info | `ms` 首屏网格行渲染完成(从页面开始加载算起) |
| `page.ready` | info | `ms` 启动完成(数据解析+渲染就绪) |
| `click` | info | **`ms` = 事件 → 下一帧绘制完成**(每个按钮/筛选/卡片的 UI 响应延迟) |
| `filter.apply` | info | `ms` 筛选/搜索/排序/密度应用耗时 + `results` 结果数 + 当前条件 |
| `photo.open` | info | 打开的照片 key / 序号 / 总数 |
| `photo.paint` | info | **`ms` = 本次导航 → 屏幕出现画面**(按图计;`cached:true` 表示预取命中;`sinceOpen` 为距首次打开灯箱的累计值,仅首图有意义) |
| `photo.loaded` | info | `ms` = 导航 → 原图完全就绪;`cached` 标记是否预取命中 |
| `photo.preview` | debug | `ms` 缩略图打底 → 2560px 预览升级完成 |
| `photo.nav` | debug | 每次翻页(方向/序号) |
| `original.retry` | **warn** | 原图首次加载失败后自动重试一次(外置硬盘偶发读失败) |
| `thumb.slow` | **warn** | 缩略图加载超过 2 秒(异常检测,含 key) |
| `thumb.error` / `original.error` | **error** | 图片加载失败(含 key,可直接定位坏文件) |
| `js.error` / `js.rejection` | **error** | 前端异常 |

**延迟基线(本机实测,1440×900;数值取自日志中 `[client]` 埋点,跨多次运行)**

| 指标 | 数值 |
|---|---|
| 页面就绪(`page.ready`) | ~100 – 135 ms(解析 2.2MB 数据 + 首屏) |
| **交互响应合计(`click:*`,753 次采样)** | **均值 78 ms**;中位 12 – 138 ms 视目标而定(卡片 138 / 关闭 124 / 芯片 56 / 收藏星 17) |
| 交互最差(解码争用窗口) | ~500 ms |
| 点击 → 出现画面 | **0 ms**(网格里已解码的缩略图打底) |
| 原图就绪 · 预取命中 | **均值 17 ms**(中位 1ms)← 翻页手感 |
| 原图就绪 · 冷读 | 均值 376 ms,中位 87 ms,最差 ~3.5 s(受 52MB/s USB 盘 + 40–60MP 解码限制) |
| 筛选 / 搜索 / 排序 | 均值 23 ms(548 次采样,中位 25ms) |

> **中断样本会被剔除**:`performance.now()` 在 Windows 休眠期间继续计时,唤醒后所有等待中的加载都会报出几小时的"耗时"(日志中实测 12,835,448 ms ≈ 3.57 h)。
> 三处聚合(服务端 `latency.js`、页内 `STATS`、离线 `log-stats.js`)都把 >60s 的样本单独计为**中断样本**并排除在均值之外,否则一条样本就能把均值毁掉。
> 同理 `thumb.slow` 在休眠场景下不再误报。

优化过程中由日志/事件套件定位并修掉的问题见下一节;其中"显示错图""幻灯片起不来""缩放被吞"这三类,
在修复前都是**用户可感知但难以复现**的间歇故障。

示例输出:

```
[INFO ] [client] page.ready {"photos":3688,"ms":148}
[INFO ] [client] click {"target":"randomBtn","tag":"button"}
[INFO ] [client] photo.open {"k":"sain00359","index":2029,"of":3688}
[INFO ] [client] photo.loaded {"k":"sain00359","ms":474}
[DEBUG] [client] photo.nav {"dir":1,"index":2030}
[INFO ] [client] photo.loaded {"k":"sain00358","ms":0}     ← 预取命中
```

- **file:// 模式自动关闭**(没有服务器接收)
- 服务器不支持该端点时**自动停用**(避免 404 噪音)
- 复测工具:`node build/telemetry-test.js 8420`(驱动一轮真实交互后即可在服务器日志里看到上述事件)

### 事件延迟均值的记录与查看

同一批埋点会被聚合成**各事件的均值**,有三个入口:

| 入口 | 用法 | 说明 |
|---|---|---|
| 日志 | 服务每 60s 写一行 `[stats]`(近 60s 窗口) | `--stats-sec 0` 关闭,`--stats-sec N` 改周期 |
| 接口 | `http://127.0.0.1:8420/__stats` | JSON:每个事件的 次数/均值/最小/最大(自服务启动累计) |
| 离线 | `node build\log-stats.js --record` | 解析 `logs\*.log`,输出 均值/中位/p95/最大 表并写 `latency-report.md` |

```
[INFO ] [stats] 事件延迟均值(近 60s): click=95(n=51,max=934) filter.apply=21(n=33,max=32)
       photo.paint=0(n=16,max=0) photo.loaded/冷读=354(n=10,max=1659) photo.loaded/预取命中=21(n=3,max=60)
```

聚合规则(`build/latency.js` 与页面内 `STATS`、`log-stats.js` 三处口径一致):`click` 按点击目标拆分;
`photo.loaded` / `photo.paint` 按 **预取命中 / 冷读** 拆分——把两者平均在一起会把翻页手感和外置硬盘读取速度都掩盖掉。

## 统计面板(页内,快捷键 `Y`)

顶栏 **📊** 按钮或按 `Y` 打开,打开期间每 3 秒自动刷新,`Esc` 或点击背景关闭。

- **本次会话**:页面内测量的 次数 / 均值 / 中位 / p95 / 最大,超预算的均值标黄;顶部四个摘要格(采样数、总体均值、事件种类、最慢单次)
- **服务器累计**:`GET /__stats` 的数据,含预取命中/冷读拆分
- **复制 Markdown**:一键导出表格,便于贴进 issue 或报告
- 无服务器(file://)时只显示会话数据,并给出提示
- 供测试读取:`window.__galleryStats()`(只读快照)

## 测试套件

先启动服务,**测试建议用无热重载模式**(否则中途刷新会打断步骤):

```
node build\server.js --no-open --no-reload
```

然后双击 `test-gallery.cmd`(或按需指定套件):

| 套件 | 命令 | 规模 | 耗时 |
|---|---|---|---|
| 回归套件 | `test-gallery.cmd smoke` | 32 项断言,真实鼠标点击 | ~40 秒 |
| 事件覆盖套件 | `test-gallery.cmd events` | 83 项事件断言 + 延迟预算 | ~8 分钟 |
| 全部 | `test-gallery.cmd` | 顺序执行,任一失败即中止 | ~9 分钟 |

事件覆盖套件两阶段:

- **阶段一** 加载 / 收藏集 / 搜索 / 排序 / 方向 / 年份 / 相机 / 密度 / 主题 / 随机 / 播放 / 收藏 / 复制清单 / 帮助 / 灯箱翻页与边界 / 缩放(键盘·滚轮·徽章) / 信息面板 / 缩略图条 / 幻灯片 / 关闭 / 全局快捷键 / 卡片键盘 / 深链
- **阶段二** 显示正确性(缩略图条跳转后**可见层必须真的是目标照片**、原图解码不得吞掉缩放)+ 拖拽平移 / 双击缩放 / 点击背景关闭 / 复制原图路径与链接 / 搜索清除 / 回到顶部 / 悬停预热 / 右键·拖拽·Ctrl+S 防护 / 全屏键 / **统计面板(打开·表结构·无横向溢出·复制 Markdown·Y 键开合)** / 偏好持久化

延迟预算(超出只标 ⚠,不判失败;失败仅发生在断言不成立时):

| 类别 | 预算 |
|---|---|
| 纯 UI 事件(点击 / 开关 / 面板) | 250 ms |
| 筛选 / 搜索 / 排序 / 密度 | 600 ms |
| 图片绘制与翻页 | 400 ms |
| 主题切换 | 400 ms |
| 缩放(键盘 / 滚轮 / 双击 / 拖拽) | 900 ms |
| 需要等待解码的步骤 | 700 ms |

套件开跑前先测**环境基线**(`evaluate + rAF` 往返中位数):本机空闲约 10–20 ms,外置 USB 硬盘繁忙时可达 90 ms。所有数值都是墙钟计时,**必须扣掉基线再解读**——汇总行会打印当次基线。

任一步骤超时都会**转储当时的完整状态**:灯箱开合 / 计数 / 是否在加载 / 缩放 / 幻灯片是否已进入倒计时 / 各图层 naturalWidth / 焦点元素 / 全屏 / inert 子树 / 失败请求 / JS 错误。定位问题不需要重跑。

被取代的图片请求会以 `net::ERR_ABORTED` 正常中止,套件单独统计(不计失败);真正的网络失败会作为一条断言判失败。

## 由日志与事件套件发现并修复的体验缺陷

| # | 现象 | 根因 |
|---|---|---|
| 1 | 灯箱内收藏按钮点了没反馈 | 便捷按钮改版时覆盖了 `els.lbFavBtn` 绑定,`syncFavChrome()` 从未触碰该按钮 |
| 2 | 跳转后屏幕上是**旧图**、徽标停在"加载中"、幻灯片再也起不来 | `finish()` 里的同步"缓存命中"判断在 `src` 刚切换时读到的是**上一层旧位图**,于是立刻换层;真正 `onload` 到达后又换回来(日志里同一 key 出现两次 `photo.loaded`) |
| 3 | 点某张照片后图片停在预览、不再前进 | 后台预取会劫持前台**正在加载**的缓冲层,打断该照片的加载 |
| 4 | 原图解码完成时,用户刚做的缩放被悄悄重置 | 缩放重置写在 `finish()` 里(解码完成时),而不是导航时 |
| 5 | 全屏后 `/` 快捷键失效、退出灯箱仍留在全屏 | 全屏只对 `#lightbox` 生效,全屏元素之外的顶栏(搜索框)无法获得焦点 |
| 6 | 拖拽平移整体失效 | `setPointerCapture()` 是处理函数的第一句,抛错会中断整个 `pointerdown`,后续手势全部作废 |
| 7 | 原图读取偶发失败后,灯箱卡在半死状态 | 无重试;失败路径也不唤醒幻灯片 |
| 8 | 日志里的 `photo.paint` 越看越离谱(11345ms) | 指标口径错误:累计"距首次打开灯箱"当成按图延迟 |
| 9 | 照片显示完成后仍出现 ~2s 主线程卡顿 | 后台同时解码 40–60MP 原图(每张约 240MB 位图);改为大图**只预热字节**、不保留位图 |
| 10 | 浏览中页面偶发自动刷新 | 热重载监听整个目录、只按扩展名排除,日志/`.gitignore`/杂物写入都会刷新所有标签页;改为**源文件白名单**(已实测验证:日志与其它写入 0 次刷新) |

同类问题(缩放重置时机、预取污染图层)在优化过程中还复现过两次,因此阶段二把它们固化为**回归用例**,而不是修完就算。

## 换行符与版本控制

仓库内所有文本文件一律存为 **LF**,只有 Windows 脚本(`*.cmd` / `*.bat` / `*.ps1`)检出为 **CRLF**——由 `.gitattributes` 强制,与本机 `core.autocrlf` 无关(仓库内已设 `core.autocrlf=false`,让属性文件说了算)。
图片显式标记为 `binary`,避免任何行尾过滤器碰到它们(**WebP 一旦被转换就会破坏 RIFF 头**)。

```
* text=auto eol=lf          # 默认:入库 LF,检出 LF
*.cmd *.bat *.ps1 → eol=crlf # Windows 脚本检出 CRLF
*.jpg *.png *.webp … → binary
```

`git add` 报 `warning: LF will be replaced by CRLF` 说明**工作区形式与属性约定不一致**(典型原因:`.gitattributes` 缺失,仅剩全局 `core.autocrlf=true` 生效)。修复方式:

```bat
git config --local core.autocrlf false
git add --renormalize .          :: 按属性重写索引
:: 之后把脚本文件的工作区形式刷成 CRLF(缺这一步,git add 仍会对它们报警告)
git checkout -- start-gallery.cmd stop-gallery.cmd test-gallery.cmd s.bat build\stop-server.ps1
git commit -m "normalize line endings"
```

## 掉线(闪断)后的文件复核

这块 USB 硬盘会**静默丢写**:UASPStor 反复重置设备、NTFS 报「无法将数据刷新到事务日志」。一次写入可以返回成功、从页缓存回读也正常,却从未落盘——`.gitattributes` 就是这样消失过一次(当时回读正常,直到提交时才发现文件不在)。因此每次掉线后按下面顺序复核:

```bat
:: 1) 先定位掉线窗口(存储错误事件的时间分布)
powershell -NoProfile -Command "Get-WinEvent -FilterHashtable @{LogName='System';StartTime=(Get-Date).AddDays(-1)} | Where-Object { $_.Id -in 129,140,50,98,153 -and $_.ProviderName -match 'UASPStor|Ntfs|disk' } | Group-Object { $_.TimeCreated.ToString('MM-dd HH:00') } | Select Name,Count"

:: 2) 校验窗口内写过的文件(--assets 连缩略图一起查;RIFF 自校验能发现截断)
node build\verify-files.js --since "2026-09-24 08:55" --until "2026-09-24 12:35" --assets

:: 3) 与基线清单比对:找出消失的或被改动的文件
node build\verify-files.js --check

:: 4) 资产全量体检(7376 个 WebP;耗时且吃 I/O,盘不稳时先别跑)
node build\verify-assets.js
```

`build\file-manifest.json` 是基线清单(源码文件的 SHA-256 + 大小)。**改动代码后重新录制**:`node build\verify-files.js --record`(清单本身不参与哈希,复录后 `--check` 立即干净)。

校验按文件类型区分,针对真实会发生的失效模式:

| 类型 | 检查 |
|---|---|
| `.js` | 语法编译(`vm.Script`,不执行) |
| `.html` | 结尾 `</html>` + 关键元素 `#statsModal`/`#statsBtn`/`#lightbox`/`#grid` |
| `.css` | 花括号配对 + 结尾换行 |
| `.json` | `JSON.parse` |
| `.cmd`/`.bat`/`.ps1` | 必须是 CRLF;`.ps1` 还要求 UTF-8 BOM |
| `.webp` | RIFF 声明长度与实际一致、VP8 块不越界 |
| `.jpg`/`.png` | SOI/EOI 与 PNG 签名 |
| 全部文本 | 无 NUL 字节(零填充特征)、UTF-8 可解 |

> 本次实际复核结果(2026-09-24,窗口 08:55–12:34,343 条存储错误):窗口内写入的是 `index.html`、`styles.css`、`build\diag-stats.js`,以及被 `diag-reload.js` 原样重写的 `assets\thumbs\cana00001.webp`——全部通过结构校验,面板与缩略图另经功能验证(面板 8 行会话数据 + 8 行服务器数据、缩略图 RIFF 长度一致且 sharp 完整解码 640×427)。

## 目录结构

```
H:\HDownload\
├── Flickr\                     (原图 — 132 GB,只读,3,688 张)
└── Flickr-Gallery\             (画廊本体 + 派生资产)
    ├── start-gallery.cmd            一键启动(服务器 + 热更新 + 自动开浏览器)
    ├── stop-gallery.cmd            一键关闭全部服务实例(含历史残留)
    ├── test-gallery.cmd            测试入口(回归套件 + 事件覆盖套件)
    ├── index.html              画廊入口
    ├── styles.css              设计系统(深/浅双主题 CSS 变量)
    ├── app.js                  全部前端逻辑(网格布局引擎 / 灯箱缩放引擎 / 状态管理)
    ├── data.js                 默认画廊的清单(标题、EXIF、GPS、LQIP 模糊占位)
    ├── README.md
    ├── .gitignore              版本控制排除:派生资产、data.js、日志、报告、依赖
    ├── .gitattributes          Windows 换行(.cmd/.ps1 用 CRLF)+ 图片按二进制处理
    ├── latency-report.md      事件延迟报告(log-stats.js 生成,已忽略)
    ├── logs\                   服务日志(按天分卷,含浏览器上报的交互埋点)
    ├── assets\                 默认画廊的派生资产
    │   ├── thumbs\             640px WebP × 3,688
    │   └── preview\            2560px WebP × 3,688
    ├── sets\                   其他文件夹的数据集(按需生成,互不干扰)
    │   └── <数据集名>\
    │       ├── data.js
    │       └── assets\thumbs|preview
    └── build\
        ├── launch.js           启动器(文件夹菜单 / 弹窗选择 / 数据集构建)
        ├── logger.js           分级日志(error/warn/info/debug)+ 落盘日志文件
        ├── server.js           静态服务器(SSE 热更新 / 防护路由 / Range / 多数据集 / 客户端埋点接收)
        ├── stop-server.ps1     关闭脚本的实际逻辑(由 stop-gallery.cmd 调用)
        ├── build.js            扫描 → EXIF 提取 → 缩略图/预览生成 → data.js 输出
        ├── exif.js             零依赖 EXIF(TIFF)解析器
        ├── verify-assets.js    资产完整性体检(RIFF/WEBP 头校验)
        ├── final-check.js      data.js 与磁盘资产的一致性核对
        ├── disk-check.js       磁盘写可靠性探针(写→fsync→读回→SHA-256 比对)
        ├── smoke.js            回归测试套件(32 项断言,真实鼠标 + file:// 与服务器双模式)
        ├── events-test.js      事件覆盖套件(83 项事件断言 + 延迟预算 + 失败状态转储)
        ├── latency.js          事件延迟聚合(均值/最小/最大,供 [stats] 与 /__stats)
        ├── log-stats.js        离线统计日志里的延迟并生成 latency-report.md
        ├── telemetry-test.js   行为埋点验证(驱动真实交互,便于在日志里核对事件)
        ├── perf-probe.js       切换延迟测量探针(页面内 performance 埋点)
        ├── open-latency.js     从点击到原图可见的延迟分解
        ├── transition-check.js 缩略图打底 / 预览升级 / 原图三段过渡核对
        ├── diag-longtask.js    长任务与布局计数探针(定位主线程卡顿)
        ├── diag-close.js       开合灯箱的往返延迟(含长任务,多滚动位置对比)
        ├── diag-keys.js        键盘快捷键 / 焦点 / inert / 全屏状态探针
        ├── diag-stripfix.js    缩略图条跳转后"可见层=目标照片"核验
        ├── diag-stats.js       统计面板渲染与 /__stats 核对(含真实交互样本)
        └── diag-reload.js      热重载白名单验证(日志/杂物写入不应刷新页面)
```

> 所有内部路径均由 `__dirname` 派生,`Flickr` 与 `Flickr-Gallery` 保持同级即可,
> 整个 `Flickr-Gallery` 文件夹可随意移动或改名。

## 重新构建

Flickr 目录新增照片后,在 `H:\HDownload\Flickr-Gallery\build\` 下执行:

```
node build.js            # 增量处理(已有资产的自动跳过,支持断点续跑)
node build.js --force    # 忽略缓存强制重做
node verify-assets.js    # 资产健康体检(加 --delete 清除损坏文件)
node final-check.js      # data.js 与磁盘一致性核对
node disk-check.js --size 256 --rounds 2   # 磁盘写可靠性探针
```

改动代码后按 `..\test-gallery.cmd` 跑完整测试(见"测试套件"一节),不要只跑单个用例。

依赖仅 `sharp` 与 `puppeteer-core`(`npm install` 一次即可)。

> `assets\preview\`(2560px 预览图)是早期三级画质策略的历史产物,当前策略不再使用,
> 如需回收约 2.3 GB 空间可整目录删除,画廊功能不受影响。

## 性能说明

- 3,688 张 LQIP 模糊占位内嵌于 `data.js`(约 2.2 MB),网格秒开、滚动零白块
- 全部图片懒加载(`loading="lazy"` + 异步解码),首屏仅请求视口内资源
- WebP 质量:缩略图 q80、预览 q82,全库派生资产约 2.6 GB(原片的 2%)
