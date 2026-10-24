# Moon SnapVault 项目申报参考书

## 可验证快照恢复与保留计划

账号：yyqdbngt；主要语言：MoonBit；许可：Apache-2.0；更新日期：2026-10-18。  
GitHub：[https://github.com/yyqdbngt/moon-snapvault](https://github.com/yyqdbngt/moon-snapvault)  
仓库发行：0.3.0（main 中，未发布）；公共模块：[yyqdbngt/moon_snapvault@0.2.0](https://mooncakes.io/docs/yyqdbngt/moon_snapvault@0.2.0)

本文供个人参考，按本次实际代码及边界编写。公开提交、CI、发布和独立安装结果另附交付核对表，不以材料修订代替主办方重新审核。

## 一、项目职责与本次改进

新增 retention，对给定自包含快照及保留 ID 集合验证清单、引用对象和未引用对象，再计算共享对象可达性、可回收对象及字节数。默认保留所有给定快照；未知或重复保留 ID、损坏内容均拒绝。修复清单文件模式校验，避免重算校验和后夹带非法权限字段。

已有核心能力继续保留，具体入口及完整使用方式见仓库 README 与 API 清单。本次对旧仓库先做版本同步，保留公开历史，不将此前已完成的功能重写为本轮新成果。

## 二、可复现输入及预期结果

以下为新增固定夹具之一，输入与字段断言同时纳入测试。更多场景见 tests/cases.json 和 examples/；所有样本均为合成数据，不作为真实用户证据。

```json
{
  "operation": "retention",
  "snapshots": []
}
```

预期结果字段：

```json
{
  "plan_only": true,
  "collectible_objects": [],
  "live_bytes": 0
}
```

## 三、实现和验证结构

领域计算由 MoonBit 完成，宿主侧负责文件、HTTP、进程或独立参考算法。可复用接口保持 execute(Json)→Json 与语义值 run 入口；实际公开接口以 pkg.generated.mbti 为准。当前根目录包含 80 项手写 MoonBit 测试声明，CLI 固定夹具 64 组，两者均为手写、无生成测试代码；夹具由 `scripts/check.mjs` 通过编译后的 CLI 执行，白盒测试直接断言同一批输入。

复核路径为四后端核心测试、真实 CLI 夹具、独立参考检查、宿主场景（适用时）、公开 CI 和公共包独立安装。完整复查可用一条命令：

```sh
sh scripts/verify.sh
SKIP_NATIVE=1 sh scripts/verify.sh   # 无 C 编译器时
```

该脚本依次执行四后端 `moon test`、`node scripts/check.mjs`、`python -B scripts/reference.py`、`python -B scripts/followup_reference.py`、`node scripts/integration.mjs` 和 `moon fmt --check`。单个命令也可分别运行：

```sh
moon update
moon test --target js
moon test --target wasm
moon test --target wasm-gc
moon test --target native
moon build --target js
node scripts/check.mjs
python -B scripts/followup_reference.py
moon run cmd/main --target js -- examples/followup-20261018.json
```

native 需要 C 编译器；标为带变化/问题的有效报告可能使用退出码 2。实际通过记录和对应源码版本见交付核对表，命令列表本身不作为通过证明。

## 四、开发记录与来源

本次提交按错误修正、针对性测试、领域实现、独立参考和版本文档记录，均使用真实日期并保留原有历史。2026-09-01 后的数量与哈希由 GitHub API 核查；达到数量条件不意味着所有提交已获主办方认定。

共同 JSON/CLI 脚手架按基础设施说明，不当作各项目独有创新。实际依赖、参考与许可见 THIRD_PARTY.md；第三方代码、生成夹具和文档不计为独立生产实现。功能有重叠时，不以“纯 MoonBit”“带测试”或“无 I/O”主张唯一性，项目差异应落到可执行机制与案例。

## 五、2026-10-24 超过单请求上限的链也能读（未发布）

此前 `restore`/`squash` 需要把整条链放进一个请求，于是「备份成功但无法恢复」——最坏的一类失败。新增两个操作：`locate` 仅凭清单回答「每个载荷存在哪个链节」（请求只有几 KB，与链大小无关），`extract` 取单个链节的载荷并逐个重算摘要校验、按调用方要求的格式重编码；另加 `assemble` 由清单算规范校验和，并把文件规范化成四个清单字段，避免 `locate` 带出的 `link` 混入清单改变校验和。适配器在超限时自动走这条路：先 locate，再逐链节 extract（按上限切分摘要列表），全链验证通过后才创建目标目录。实测 19 MB 的三链节链（9.8+8.4+1.4 MB）单请求均拒绝，分段后 restore 与 squash 都成功，且分段 squash 的校验和与单请求结果一致。同时修复上一轮的缺陷：声明对象路径只剥离了父快照载荷，第三个链节仍整份发送导致超限。

## 六、2026-10-24 大基准的增量备份（未发布）

16 MiB 单请求上限此前使大基准无法做增量：请求同时携带新树与父快照的全部载荷。现在 `create` 接受「仅清单的父快照 + `known_objects` 摘要列表」，核心只需知道哪些摘要已存在，不必收到载荷。两种写法产出**完全相同**的快照（校验和只覆盖清单）。代价是核心无法再验证基准，因此统计里显式给出 `base_verified: false` 而不是声称验证过；虚假声明是 fail-closed 的——读取时报 `missing object`，`restore` 拒绝。适配器仅在超限时启用：先用一个请求审计链，再用第二个请求发送仅清单的父快照，两个请求都在上限内，且基准仍被验证。7 MiB 树改一个文件：基准快照 9.8 MB，增量 1267 字节，恢复验证通过；此前该增量根本无法创建。

## 七、2026-10-24 保留计划不再删除被依赖的链节（未发布）

修复一处会导致数据不可恢复的真实缺陷：原有保留计划只按请求中的 `keep` 求可达集，可以把「保留 delta、删除 base」列为建议，而 base 一旦删除，delta 的清单仍指向它的校验和，`restore` 立即失败——尽管所有对象都还在。现在计划会把被保留快照链所需的链节提升到 `required_snapshots`，无法命名的链节（只经 `parents` 提供）列入 `external_parents`；真正缩减链需要先 `squash`。同时 `restore` 在源与目标的载荷编码同为 base64 时直接透传，省去一次解码再编码：8 MiB 恢复 1660 → 1261 ms，4 MiB 912 → 696 ms。

## 八、2026-10-24 链压缩与选择性恢复（未发布）

`squash` 把整条链折叠为一个自包含快照（可选三种格式），每个可达对象只保留一份、无引用对象丢弃；不指定格式时保持原格式，折叠到格式 2 与直接创建同一棵树逐字节相同，重复折叠为幂等操作。`restore` 支持 `paths`，按路径分量选择（`docs` 覆盖 `docs/a.md`，`doc` 不覆盖），返回 `selected`/`total_files`；未命中的路径报错而非静默少还原。适配器新增 `squash` 与 `restore --path`。

## 九、2026-10-24 增量快照格式 3（未发布）

快照可声明 `parent`，只存链上没有的对象；清单仍完整，因此 `diff` 无需遍历链。`parent` 计入格式 3 的校验和，改指向会立刻校验失败。`audit`/`restore`/`retention` 通过 `parents` 列表按校验和解析链，`valid` 覆盖整条链，缺失链节报 `missing parent snapshot`，链深上限 64。

实测：3 MiB 树改动一个小文件，基准快照 4.1 MB / 611 ms，增量 752 B / 685 ms（磁盘 0.02%，耗时与全量备份相当，因为写入前会复核基准）。见 `docs/incremental.md`。

## 十、2026-10-24 快照格式 2（未发布）

对象载荷由十进制字节数组改为 base64 文本，版本号升至 2。1 MiB 不可压缩文件的快照由 3.57 MiB 降至 1.33 MiB，同一份备份耗时由 2396 ms 降至 649 ms，恢复由 2081 ms 降至 423 ms（参考机、debug 构建）。`create` 默认写格式 2，请求 `"format": 1` 仍逐字节复现旧布局；两种格式的 `audit`、`restore`、`diff`、`retention` 均可读，且由版本决定接受的载荷编码，格式 2 中出现十进制数组会报 `invalid object encoding`。请求新增 `content_base64` 输入，`restore` 返回 `format` 与 `encoding`。适配器改为发送 base64，单次备份源上限由 1 MiB 提升至 8 MiB（不可压缩数据约 10.7 MiB JSON，仍在 16 MiB 请求上限内）。详见 `docs/snapshot-format.md`。

## 十一、2026-10-24 审计契约修订（未发布）

`audit` 现在校验全部已存对象（含未被引用的对象），并报告 `objects_total`、`objects_checked`、`referenced_objects`、`unreferenced_objects`。此前 `audit` 会把"未被引用但内容与键不符"的快照判为合法，而 `retention` 拒绝同一份字节、`create(previous=…)` 还会低估 `new_object_bytes`；现在四者结论一致。

CLI 对宿主侧失败（文件不存在、非法 UTF-8、超过 16 MiB）也返回统一的 `{"error": …}` 信封并退出 1；`restore` 在写入后用 `chmod` 恢复权限位，报告 `modes_applied`；适配器在创建目标目录前拒绝仅在 Unicode 归一化/大小写折叠后冲突的路径。详细证据见 `docs/audit-contract-20261024.md`。这些改动尚未发布到 MoonCakes，`moon add` 仍解析 0.2.0。

## 十二、当前边界

只生成计划，不删除任何文件。可回收范围仅限输入中提供的对象，不包含未提供的外部仓库；自包含快照的逻辑对象统计不等同于实际磁盘节省量，宿主备份的 1 MiB 上限仍保留。

完整原方案的代码量、性能目标与用户效果不自动沿用为当前成果；统计以源码实际值及本机/CI 的测量记录为准。比赛准入、团队/项目数解释和最终审核仍由主办方决定，本轮不代提交报名。
