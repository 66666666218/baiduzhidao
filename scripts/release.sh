#!/usr/bin/env bash
# 发版脚本：改版本 → 打包 → 创建 GitHub Release 并上传安装包+latest.yml
# 前置：gh CLI 已安装并登录（gh auth login）；用法：bash scripts/release.sh [版本号]
set -euo pipefail
cd "$(dirname "$0")/.."

# 版本号：不带参数就自动升 patch。
# 为什么不能沿用旧版本号重发：electron-updater 是按 latest.yml 里的 version 比对来判"有没有新版"的，
# 版本号不变 → 所有已安装的客户端永远显示"已是最新" → 新包推不出去，而且**没有任何报错**。
PKG_VERSION=$(node -p "require('./package.json').version")
REQUESTED="${1:-}"
if [ -z "$REQUESTED" ]; then
  VERSION=$(node -e "const a=process.argv[1].split('.').map(Number);a[2]+=1;console.log(a.join('.'))" "$PKG_VERSION")
  echo "未指定版本号，自动升 patch：$PKG_VERSION → $VERSION"
else
  VERSION="$REQUESTED"
fi
TAG="v$VERSION"

# 把 package.json 对齐到 VERSION：electron-builder 是按 package.json 的 version 命名安装包和
# latest.yml 的，两者不一致会产出对不上的文件名，后面 ls 报的错很难看懂。
if [ "$PKG_VERSION" != "$VERSION" ]; then
  node -e "
    const fs = require('fs');
    const raw = fs.readFileSync('package.json', 'utf8');
    // 保持原有行尾：仓库里是 CRLF，写回 LF 会让整份文件在 diff 里全部标红，
    // 真正改了哪一行反而看不出来。
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const pkg = JSON.parse(raw);
    pkg.version = process.argv[1];
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2).split('\n').join(eol) + eol);
  " "$VERSION"
  echo "package.json 版本已更新：$PKG_VERSION → $VERSION"
fi
echo "发版：$TAG"

# 0) gh 可用性检查
if ! command -v gh >/dev/null 2>&1; then
  echo "❌ 未安装 gh CLI。请先执行：winget install GitHub.cli && gh auth login"; exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "❌ gh 未登录。请先执行：gh auth login（选 GitHub.com → 浏览器授权）"; exit 1
fi

# 同 tag 已存在时明确拒绝：上传用的是 --clobber，会静默覆盖旧包，
# 而客户端看到的版本号没变，于是永远收不到更新（见上面版本号那段）。
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "❌ $TAG 已存在。覆盖同版本号的发布不会让客户端更新（版本号没变）。"
  echo "   换个版本号：bash scripts/release.sh <新版本号>；或不带参数运行让脚本自动升 patch。"
  exit 1
fi

# 1) 闸门：单测 + 冒烟全绿才允许打包
#
# 冒烟现在会点遍界面上所有按钮。加这一步是因为「处理器体内的错误」（典型是引用了
# 不存在的变量）加载期不报、单测也覆盖不到，只有点下去才炸——而发出去就是用户踩。
# 它会在点之前把所有 IPC 换成空实现，所以不会真提交/真上传。
echo "→ 单元测试"
npm test || { echo "❌ 单元测试未通过，终止发版"; exit 1; }
echo "→ 冒烟自检（渲染端加载 + 点遍所有按钮）"
npm run smoke || { echo "❌ 冒烟自检未通过，终止发版"; exit 1; }

# 2) 打包（electron-builder 依 package.json version 产出 exe + latest.yml）
npm run dist

# 3) 资产：安装包 + 更新清单 + 增量块图
EXE=$(ls dist/zhidao-answer-studio-$VERSION.exe)
YML=dist/latest.yml
BLOCKMAP=$(ls dist/zhidao-answer-studio-$VERSION.exe.blockmap 2>/dev/null || true)
[ -f "$EXE" ] || { echo "❌ 未找到 $EXE"; exit 1; }
[ -f "$YML" ] || { echo "❌ 未找到 $YML（electron-updater 需要）"; exit 1; }

# 4) 创建 release（已存在则追加资产）
ASSETS=("$EXE" "$YML")
[ -n "$BLOCKMAP" ] && ASSETS+=("$BLOCKMAP")
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "${ASSETS[@]}" --clobber
else
  gh release create "$TAG" "${ASSETS[@]}" --title "百度知道答题助手 v$VERSION" --notes "自动更新版本。安装后可在「使用教程 → 软件更新」一键检查更新。"
fi
echo "✅ 发布完成：https://github.com/66666666218/baiduzhidao/releases/tag/$TAG"
echo "已装旧版的用户：软件内「使用教程 → 软件更新 → 检查更新」即可升级。"
