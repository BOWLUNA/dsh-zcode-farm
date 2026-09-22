# 参与贡献

[English](CONTRIBUTING.md) | **中文**

> 本仓库只做一件事：让 Agent 看见整个 ComfyUI 农场，而不是单个端点。

## 环境

- Node.js >= 20
- 无需构建步骤 —— 源码随包发布，安装过程永远不跑 build

## 每次提交前请跑

测试为 **1 个套件、15 项检查** —— 下面六条命令必须全绿。

```bash
node test/run.mjs                                    # 测试与检查数
node tools/verify-translation-pairing.mjs --write    # 改了任一侧就重录配对哈希
node tools/verify-doc-numbers.mjs                    # 文档里的数字 vs 真实运行
bash -n install.sh && bash -n uninstall.sh           # shell 语法
node tools/verify-version-consistency.mjs --dsh 0.1.6-alpha.2
node tools/boot-check.mjs --port 31841               # 真装一次、真启动一次
```

六条里只有 `tools/boot-check.mjs` 能抓住「**装得上但起不来**」的插件 ——
`--dump-config` 只合成配置、不 apply，因此装配行的 `name` 与包名脱节时它会**报成通过**。

## 规矩

- 改了双语配对里的一侧，就把另一侧也改掉 —— 然后重录配对哈希
- 每个用户可见的失败结果都要带 `code` 加 `params`；页面用自己的词典渲染
- 没有命令与原始输出的结论不算结论
- 一个拉取请求只做一件事
