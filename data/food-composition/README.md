# 中国食物成分数据（构建输入）

本目录是**构建输入**，页面运行时并不直接读取这里的文件——运行时产物是仓库根目录的 `foods.js`（由 `tools/build_foods_db.py` 生成，页面用 `<script src="foods.js">` 引入）。

## 来源

- 仓库：https://github.com/Sanotsu/china-food-composition-data
- 目录：`json_data_v3_20260825_qwen38max_kimi_k3_fixed/`（该仓库 README 推荐使用的手动矫正版；
  原始识别版曾把「野生蔬菜类」的能量 kcal/kJ 标反，本版已修正）
- Commit：`d15675c27582748307023b7ee7aca2a63fc52756`（2026-10-08 下载）
- 内容：61 个类别文件（`merged_<大类>-<子类>.json`），共 1677 条食物，字段含
  `foodCode / foodName / edible / energyKCal / energyKJ / protein / fat / CHO / ... / remark`，
  数值均为字符串，缺失值为 `—`、痕量为 `Tr`。热量为**每 100 克可食部**的数值。
- 原书：《中国食物成分表标准版（第 6 版）》「能量和食物一般营养成分」部分。

## 重新获取

```sh
SCRATCH=$(mktemp -d /tmp/fooddb.XXXXXX)
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/Sanotsu/china-food-composition-data.git "$SCRATCH/repo"
git -C "$SCRATCH/repo" sparse-checkout set json_data_v3_20260825_qwen38max_kimi_k3_fixed
cp "$SCRATCH/repo/json_data_v3_20260825_qwen38max_kimi_k3_fixed"/merged_*.json .
rm -rf "$SCRATCH"
```

注意：整仓打包约 135 MB（含大量截图），**不要**去掉 `--filter=blob:none --sparse`，否则会拉下全部截图。
目录里的 `apply_log.json`、`energy_swap_fix_log.json` 是校对日志，构建时按 `merged_*.json` 模式自然排除。

## 说明

- 上游仓库**未声明 License**，此处仅作本地个人使用的数据留档。
- 同一目录下两个文件同名不同热量时属正常现象（如不同品种/产地的代表值），构建脚本会统计并保留。
