# eval-runner

deep-swe / Harbor 格式评测 runner —— pier 的等价物，但被评对象是 **pi-web**：
agent 会话跑在 pi-web 批量测试 API（sandbox 模式）里，七个编码工具经沙盒桥扩展
在任务容器内执行；判分链（collect / verify）由本 runner 驱动，纯平台 API，零
docker 依赖（生产路径）。

```
┌──────────────────────────── eval-runner ────────────────────────────┐
│ plan    解析 tasks/*/task.toml（Harbor 格式）+ 子集采样(n,seed 确定性) │
│ prep    镜像就绪（platform: SIF 已注册；docker: pull）                │
│ run     建容器(fresh) → POST /api/batch/tasks (mode:sandbox)         │
│         → 轮询/SSE 至终态（interrupted 自动 resume）                  │
│ collect 容器内跑 [[verifier.collect]] → 取 /logs/artifacts/model.patch│
│ verify  新建干净容器 → 注入 /tests + 补丁 → bash /tests/test.sh      │
│         → 解析 /logs/verifier/reward.json (f2p/p2p)                  │
│ report  jobs/<run-id>/{report.md, runs.jsonl, 每任务 patch/reward}   │
│ resume  state.json 记录每任务阶段，崩溃/中断后跳过已完成阶段          │
└──────────────────────────────────────────────────────────────────────┘
```

## 使用

```bash
# 列出任务 / 查看子集选择
node bin/deepswe.js list --tasks /path/to/deep-swe/tasks --n-tasks 10 --sample-seed 0

# 端到端跑（平台驱动，生产路径）
node bin/deepswe.js run --tasks /path/to/deep-swe/tasks \
  --driver platform \
  --platform-url http://10.99.9.7:PORT --platform-key sk-... \
  --piweb-url  http://10.99.9.7:30141 --piweb-key sk-... \
  --model zai/glm-4.7 --n-tasks 3 --sample-seed 0 --concurrency 2

# docker 驱动（VM 基础功能测试，绕过平台路径）
node bin/deepswe.js run --tasks ... --driver docker --piweb-url ... --piweb-key ...

# 镜像转换：生成 apptainer 脚本（在 Linux 主机上执行）
node bin/deepswe.js convert-sif --tasks ... --out-dir /srv/sif [--only id,id] > convert.sh
bash convert.sh

# 重新渲染报告
node bin/deepswe.js report --job jobs/<run-id>
```

环境变量替代：`PLATFORM_URL` / `PLATFORM_KEY` / `PIWEB_URL` / `PIWEB_KEY`。

## 前置条件

1. **pi-web ≥ 批量 API v1.3**（sandbox 模式已接线：`PI_WEB_PLATFORM_URL` +
   `PI_WEB_SANDBOX_EXTENSION_PATH` 已配置，`containerId` 直传）。
2. **任务镜像已注册到平台**（SIF）：用 `convert-sif` 生成转换脚本，在 Linux
   主机执行后，把 SIF 注册进平台并命名 = task.toml 的 `docker_image` 原文
   （或 `--image-map dockerRef=platformName` 提供映射）。
3. **管理员 API key**（平台 + pi-web 批量 API 均需管理员角色）。

## 容器驱动

| 驱动 | 用途 | 通道 |
|---|---|---|
| `platform`（默认） | 生产评测、专用服务器 | 平台 REST：containers/images + tools/bash·read·write（SIF 镜像，未来多设备调度对 runner 透明） |
| `docker` | VM 基础功能测试 | docker CLI（`--network none` 默认，保持 deep-swe 断网保真） |

## 保真度注意（与官方 pier 榜对比时）

- LLM 流量在 pi-web 宿主机侧发出（等价于 pier 的网络白名单）；任务容器无外网。
- agent 默认工具白名单 `bash,read,write,edit,glob,grep`（关闭一切宿主侧有网
  工具，可用 `--tool-names` 覆盖）。
- 轨迹格式为 pi 会话文件（非 ATIF）；系统提示词栈 = pi-web 产品栈。
  官方榜成绩不可直接换算，报告需注明评测配置。

## 目录

```
bin/deepswe.js      CLI 入口（run / list / convert-sif / report）
src/toml.js         TOML 子集解析器（已对 113 个真实 task.toml 全量验证）
src/tasks.js        任务发现/解析/确定性子集采样
src/platform.js     平台驱动（生产）
src/docker.js       docker 驱动（VM 功能测试）
src/piweb.js        pi-web 批量 API v1.3 客户端（含 interrupted 自动 resume）
src/run.js          编排器（阶段状态机 + jobs 落盘 + 并发池）
src/report.js       report.md / runs.jsonl 渲染
test/               解析器/任务加载/采样/报告 单测 + 真实任务 fixture
```

设计文档：`../pi-web/docs/deepswe-eval.md`（评估结论 + pi-web 侧修改方案）。
