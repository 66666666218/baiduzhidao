#!/usr/bin/env bash
# 发版脚本：改版本 → 打包 → 创建 GitHub Release 并上传安装包+latest.yml
# 前置：gh CLI 已安装并登录（gh auth login）；用法：bash scripts/release.sh [版本号]
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION=$(node -p "require('./package.json').version")
fi
TAG="v$VERSION"
echo "发版：$TAG"

# 0) gh 可用性检查
if ! command -v gh >/dev/null 2>&1; then
  echo "❌ 未安装 gh CLI。请先执行：winget install GitHub.cli && gh auth login"; exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "❌ gh 未登录。请先执行：gh auth login（选 GitHub.com → 浏览器授权）"; exit 1
fi

# 1) 打包（electron-builder 依 package.json version 产出 exe + latest.yml）
npm run dist

# 2) 资产：安装包 + 更新清单 + 增量块图
EXE=$(ls dist/zhidao-answer-studio-$VERSION.exe)
YML=dist/latest.yml
BLOCKMAP=$(ls dist/zhidao-answer-studio-$VERSION.exe.blockmap 2>/dev/null || true)
[ -f "$EXE" ] || { echo "❌ 未找到 $EXE"; exit 1; }
[ -f "$YML" ] || { echo "❌ 未找到 $YML（electron-updater 需要）"; exit 1; }

# 3) 创建 release（已存在则追加资产）
ASSETS=("$EXE" "$YML")
[ -n "$BLOCKMAP" ] && ASSETS+=("$BLOCKMAP")
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "${ASSETS[@]}" --clobber
else
  gh release create "$TAG" "${ASSETS[@]}" --title "百度知道答题助手 v$VERSION" --notes "自动更新版本。安装后可在「使用教程 → 软件更新」一键检查更新。"
fi
echo "✅ 发布完成：https://github.com/66666666218/baiduzhidao/releases/tag/$TAG"
echo "已装旧版的用户：软件内「使用教程 → 软件更新 → 检查更新」即可升级。"
