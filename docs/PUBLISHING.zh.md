# 发布

[English](PUBLISHING.md) | **中文**

> 由 tag 驱动。`v*` tag 是唯一触发器；`main` 上不会发出任何东西。

## 打一个 tag 会发生什么

`.github/workflows/release.yml` 先跑与 CI 相同的守卫，然后交给 `tools/publish-if-new.mjs`。

那个脚本存在，是因为真正有意思的失败不是「发布失败了」，而是「发布**悄悄地什么都没做**」。
它有三种形态：

- 某个步骤偶发失败后重跑同一个 tag，会因冲突而失败，看着像一次坏掉的发布
- `publishConfig.tag` 并不被可靠地遵守，于是一次运行可以全绿而 `latest` 仍指向上一个版本
- 一个绿色的 job 并不能证明版本已经可用

所以脚本先问 npm **这个确切版本**是否已存在，存在就退出 0；否则用显式的 `--tag latest` 发布，
然后轮询 npm 最多六分钟以确认传播。

## 鉴权

用 Trusted Publishing（OIDC）—— 本仓库里**不存** `NODE_AUTH_TOKEN`。需要在 npmjs.com 上做一次性配置：
该包的 Trusted Publisher 必须指名这个仓库与这个 workflow 文件。在它存在之前，发布步骤会停在鉴权，
那是配置问题，不是代码问题。

**不要用会话 token。** 它会走 staged publishing，症状是「发布成功但 `latest` 没动」。

## 发布之后：把 tarball 拆开

绿色 workflow 加 registry 上的版本号，只证明**有个**包上去了。拆开 tarball 才证明**这次改动**上去了。

```bash
cd /tmp && rm -rf tgz && mkdir tgz && cd tgz
curl -sL "$(npm view dsh-zcode-farm dist.tarball)" -o p.tgz && tar xzf p.tgz
node -p "require('./package/package.json').version"
grep -rl 'comfyui_farm_status' package/
```

## 升版本

- 版本号出现在 `package.json`、两份 README、两份 SECURITY 支持表与两份 CHANGELOG 里
- `engines.dsh` 与 `@deepseek-ai/dsh` peer 范围是**宿主兼容性声明** —— 它们不是插件版本，
  不能跟着一起升
- 改过任何文档里的数字之后，重录配对哈希并重跑数字守卫
