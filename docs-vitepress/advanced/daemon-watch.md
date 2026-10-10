# 守护进程与 watch：长时运行的可靠性工程

前面各章的管线都假设"有人触发一次构建"。watch 模式去掉了这个假设：编辑器一保存，图就自己更新。这是唯一**常驻运行**的代码路径，也因此暴露出一类前几章不会遇到的问题——文件系统会骗你、进程会死、操作系统各不相同。v2.3.7→v2.3.8 周期对这条路径做了一次系统性加固（#811 系列，配套约 1400 行新测试），本章拆解它的每个防御层。

核心命题一句话：**假设 watcher 会瞎、会死、会被骗，然后为每一种失败设计可观测的降级，而不是静默继续。**

## 总体架构回顾

`crg-daemon`（daemon_cli.py）管理一个后台守护进程（`WatchDaemon`，daemon.py:743），后者为 `watch.toml` 里登记的每个仓库 fork 一个独立的 `code-review-graph watch --repo <path>` 子进程。约束刻意克制：子进程间无 IPC；状态全部落在 `~/.code-review-graph/` 下的状态文件（daemon.py:56）；存活探测用 `os.kill(pid, 0)`（daemon.py:487）；不用 tmux/systemd。daemon 是"看护进程列表的脚本"（第 1 章已述），本章的关注点是它看护的那个 watch 子进程内部。

## 防御层一：不给 OS 塞整个仓库（watch 规划）

最初的实现是对仓库根挂一个递归 watch。问题：递归 watch 意味着 OS 为树里**每个目录**注册一个内核监视条目——包括 `node_modules/`、`target/` 里构建工具疯狂 churn 的临时目录（incremental.py:1597-1600 的注释）。大仓库上这既是句柄浪费，也是事件风暴源。

现在的做法是**按目录规划**（`_plan_watch_paths`，incremental.py:1690）：

- 从规划深度 3（`CRG_WATCH_PLAN_DEPTH`）向下尝试，第一套能塞进预算（默认 24 个 watch 槽位，`CRG_MAX_WATCH_SCHEDULES`）的方案胜出；
- 规划时忽略规则照常生效：被忽略的子树**根本不交给 OS**；
- 对没被忽略的目录算一笔账：其下被忽略子树的目录总数（BFS 计数）低于阈值 4（`CRG_WATCH_SPLIT_MIN_DIRS`）就不值得为它拆分——一个孤零零的 `__pycache__` 不配拥有自己的 emitter 线程，但 `target/` 配得；
- 超预算时**降级而非失败**：回退为一个递归根 watch + 显式警告（提示调大环境变量），并置 `_degraded` 标记——这个标记一路传导到 `crg-daemon status` 的 Watcher 列，显示为 `partial`。

降级路径的存在说明设计者清楚：过滤是优化，覆盖是底线。宁可退回"多收事件再靠 ignore 规则丢弃"，也不能漏掉文件变化。

## 防御层二：目录发现靠轮询，不靠事件

新目录（分支切换拉下来的新模块、`mkdir src`）怎么进入 watch？直觉答案是监听目录创建事件。但 macOS 的 FSEvents 有个反直觉行为：**非递归 watch 的子目录创建事件永远不会送达**（incremental.py:1868-1874 注释点名了 watchdog emitter 的 `_is_recursive_event` 行为）。依赖事件的发现在 macOS 上天生失明。

解法朴素而有效：每个 tick，对每个非递归 watch 的父目录做一次 `scandir`（`sync_watches`，incremental.py:1862）——

- 磁盘上有、没在 watch 的 → **收养**（`_adopt_directory`，incremental.py:1914），且用与启动完全相同的规划算法（`_affordable_plan`）：新模块自己的 `node_modules` 和 `target` 同样不会被交给 OS；
- watch 里在、磁盘上没有 → 释放（"vanished"）;
- 身份变了 → 先释放再重新收养（见下一层）。

成本是每 tick 每浅 watch 一次 scandir，换来的是不依赖任何平台的目录事件语义。发现的新目录经合成 DirCreatedEvent 送进防抖器（incremental.py:2321），大目录的索引不会阻塞心跳循环。槽位耗尽时的最后手段是 `_promote_to_recursive`（incremental.py:1961）：把父目录升级成递归 watch，用放弃过滤换全覆盖，同样置 degraded。

## 防御层三：身份是 inode，不是名字

`rm -rf src && mkdir src`——或者连续切两次分支。路径拼写一模一样，但旧 watch 已死、新目录不在 watch 里，而且按名字对账的系统会把"旧路径的死亡"误读成"整个 watcher 失效"。修复前的行为正是如此：重建目录杀死 watcher 或让新目录永远缺席图。

修复后的做法是把 watch 的身份从路径改成 **inode 三元组**：`_watch_identity`（incremental.py:1753）返回 `(st_dev, st_ino, st_birthtime)`。birthtime 是点睛之笔——文件系统复用 inode 时（删了又建恰好拿到同一个编号），出生时间能分辨新旧。每个 tick，`sync_watches` 对比存储身份与磁盘身份，不一致就释放旧 watch、按规划算法重新收养新目录（日志："Directory %s was replaced; re-watching it"）。

### 存活判定的克制清单

`check_liveness`（incremental.py:2022）检查 observer 线程、每个 emitter 线程乃至 emitter 内部的 reader 线程（如 inotify 缓冲线程），但它有一份**刻意不算死亡**的清单：

- 从未活过的线程（启动竞态，不是死亡）；
- watch 已被释放或根目录消失的线程——`rm -rf lib/` 不该杀死整个 watcher，否则就是无限重启循环；
- 根目录 inode 已变化的线程（那是"待重新收养"，不是死）。

真正的死亡先**每根修复一次**（`_repaired_roots` 集合去重），重挂同一个 watch；同一根第二次死亡才抛 `RuntimeError("watch observer stopped: ...")` 让 watch 进程以非零码退出（incremental.py:2447-2462）。这个"崩溃路径保持响亮"的设计是刻意的：子进程退出后 daemon 会重启它（见防御层五），但日志里留下了真实的失败记录——静默自愈和静默失败一样危险。

修复时还有一个容易漏掉的细节：watch 批处理跑增量更新时带 `reconcile_stale=False`（避免与正在进行的批量写入竞争），这意味着**停机窗口内发生的删除不会被发现**。所以每次修复后会合成一对 DirDeleted+DirCreated 事件重新派发（incremental.py:2437-2446），强制重读间隙期发生的一切——否则中断期间删除的文件会在图里永生。

## 防御层四：嵌套构建产物的证据判定

`moduleA/target/` 该不该忽略？答案取决于三行之外的证据：旁边有没有 `pom.xml`。`NESTED_OUTPUT_DIR_MARKERS`（incremental.py:218-233）是一张"目录名 → 佐证清单"表：`target` 需要 `pom.xml`/`Cargo.toml`/`build.sbt` 兄弟文件，`build` 需要 gradle settings，`.next` 需要 next.config，`.nuxt` 需要 nuxt.config。有佐证才忽略，没有就当作源码目录入图。

扫描本身有界（深度 3、最多 2000 目录、200 条 pattern 上限），结果缓存 300 秒（TTL），长跑的 watch 周期性重扫而不重启。`.code-review-graphignore` 里的 `!path` 可以豁免某个具体路径的自动判定——注意语义的精确性：`!path` 只豁免自动检测，**不能**否定显式写的忽略规则（docstring，incremental.py:475-477）。自动排除会减少图里的文件，所以每次都以 info 级日志明示排除了什么。

## 防御层五：心跳协议与健康列

watch 子进程周期性写一份 JSON 心跳到 `~/.code-review-graph/watch-health/<sha256(realpath)[:16]>.json`（daemon.py:552）：

- 键是 **realpath 的哈希**而非用户拼写——符号链接、相对路径、尾斜杠拼出的同一路径共享一份健康记录；
- 内容含 pid、started_at、updated_at、observer_alive、last_event_at、events_seen、dead_threads、degraded、phase；
- 写入限速（默认 10 秒一次，`CRG_WATCH_HEALTH_INTERVAL`）、临时文件 + `os.replace` 原子落盘；
- 读取侧补算 `age` 与 `stalled`（心跳超过默认 90 秒未更新即 stalled，`CRG_WATCH_HEALTH_STALE`）。

`crg-daemon status` 把这些折叠成一列五态 Watcher 状态（`watcher_status`，daemon.py:598）：

| 状态 | 含义 | 页脚提示 |
|---|---|---|
| `ok` | 一切正常 | — |
| `partial` | 槽位耗尽降级为递归 watch | 提示调大 CRG_MAX_WATCH_SCHEDULES |
| `stalled` | 进程活着但 observer 失效/心跳过期 | "process is up but its filesystem observer is not… crg-daemon restart" |
| `unknown` | 从未发布过心跳 | 查日志 |
| `dead` | 进程不存在 | 等 daemon 重启或手动 start |

外加 Event 列显示最后事件的时长（12s / 4m / 3h / 2d）。对比第 1 章"健康检查只有活/死二元状态"的旧描述——这套协议正是那次批评的答案：不引入 IPC，用共享文件系统上的心跳文件把"活着"细分成五种可操作的状态。

## 防御层六：指数退避与"stalled 不重启"

daemon 的健康检查循环（30 秒一 tick）只重启 dead 的子进程，且受退避闸门控制（daemon.py:101-108）：

- 重启延迟 = `min(base × 2^(n-1), max)`，base 默认 30 秒、上限 900 秒（`CRG_RESTART_BACKOFF` / `CRG_RESTART_BACKOFF_MAX`）；
- 子进程稳定运行超过 600 秒（`CRG_RESTART_HEALTHY_AFTER`）后计数清零——一次意外重启不应永久抬高后续重启的成本；
- **stalled 永远不被 daemon 自动重启**：只记日志（"running but stalled … the graph is not being updated"）。

后者初看反直觉，理由写在常量旁的注释里：每次重启的代价是一次全量初始更新；对一个 observer 已经坏掉、但进程还活着的 watcher，盲目重启既贵又掩盖了需要人看的日志。设计立场是：**自动恢复留给确定安全的场景（进程死了），不确定的场景交给人判断**。

## 干净退出的工程细节

两个容易被忽视的收尾问题：

- **SIGTERM → KeyboardInterrupt**：watch 循环把 SIGTERM 转换成 KeyboardInterrupt（`_install_sigterm_interrupt`，incremental.py:2339），让 `crg-daemon stop` 触发的是 Python 层的清理路径而非 exit 143——清理会删除心跳文件，不留一个永远显示 "stalled" 的尸体；
- **限时拆除**：watchdog 的 `unschedule()` 会无超时地 join emitter 线程，一个卡死的 emitter 就能让停止流程挂住。所有拆除操作都经 `_run_time_boxed`（10 秒盒，incremental.py:1719）扔进一次性 daemon 线程执行——超时就放弃等待，反正主进程马上要退出了。

## 已知局限

- **partial 模式放弃过滤**：槽位预算耗尽的仓库会重新收到全部事件（靠 ignore 规则事后丢弃），大 monorepo 若频繁 partial 应显式调大预算而不是忍受降级;
- **轮询发现的最小延迟是一个 tick**：新建目录里的文件最快也要下一个周期才被收养索引；
- **心跳文件是建议性的**：读不到心跳只意味着 unknown，不区分"刚启动"和"写心跳的代码坏了"；
- **Windows 上 daemon 不后台化**：double-fork + setsid 仅限 POSIX，Windows 保持前台运行；
- **单仓库单子进程**：同一仓库在两个终端各跑一个 `watch` 会互相竞争 SQLite 写锁——这是架构约束（WAL 单写者）的自然结果，registry 机制缓解但不禁止。

## 小结

这一章的项目没有一个"聪明"的算法，全是笨功夫：规划、轮询、对账、心跳、退避。但正是这类代码决定了一个工具在真实开发节奏下（切分支、rebase、rm -rf、合上盖子过夜）是"图总是新的"还是"图看起来是新的其实早就死了"。它与第 2 章的增量管线、第 6 章的可信度报告构成同一条逻辑链：更新机制保证图尽量新鲜，拒绝机制保证图不错配仓库，心跳机制保证"新鲜"这件事本身可观测。

