#!/usr/bin/env python3
"""由 data/food-composition/ 下的原始 JSON 生成 foods.js（页面运行时用的精简热量表）。

用法：
    python3 -I tools/build_foods_db.py data/food-composition [输出路径]

输出默认写到脚本上一级目录的 foods.js。只读输入目录里的 merged_*.json
（apply_log.json / energy_swap_fix_log.json 等日志文件按模式排除）。
"""
import json
import re
import sys
from pathlib import Path

# 仅用于生成文件头注释（数据更新时同步修改）
DATA_SOURCE = "Sanotsu/china-food-composition-data"
DATA_DIR_NAME = "json_data_v3_20260825_qwen38max_kimi_k3_fixed"
COMMIT = "d15675c27582748307023b7ee7aca2a63fc52756"

KCAL_RE = re.compile(r"-?\d+(?:\.\d+)?")   # 先剥掉尾部脚注星号再匹配（油类形如 899*）
KCAL_MAX = 20000
NAME_MAX = 100                              # 与 index.html 的 maxlength 一致
SANITY = {                                  # 硬校验：这些值写死自实测数据，防止数据源被换坏
    "米饭（蒸，代表值）": 116,
    "粳米饭（蒸）": 118,
    "鸡胸脯肉": 118,
    "鸡腿": 146,
    "豆油": 899,
}


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    data_dir = Path(argv[1])
    if not data_dir.is_dir():
        print("错误：数据目录不存在：%s" % data_dir)
        return 2
    out_path = (Path(argv[2]) if len(argv) > 2
                else Path(__file__).resolve().parent.parent / "foods.js")

    files = sorted(data_dir.glob("merged_*.json"))
    if not files:
        print("错误：%s 下没有 merged_*.json" % data_dir)
        return 1
    skipped = sorted(p.name for p in data_dir.glob("*.json")
                     if p not in files)

    rows = []                 # [名称, 整千卡]
    seen = set()              # (名称, 千卡) 去重
    raw_count = 0
    dropped_nonnum = []       # 热量非数字的示例
    dropped_nonnum_n = 0
    dropped_range = []        # 热量超范围的示例
    dropped_range_n = 0
    rounded_n = 0
    dup_removed = 0
    footnote_n = 0            # 形如 899* 的脚注星号

    for path in files:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            print("错误：%s 顶层不是数组" % path.name)
            return 1
        for row in data:
            raw_count += 1
            name = str(row.get("foodName", "")).strip()
            if not name:
                continue
            raw_kcal = str(row.get("energyKCal", "")).strip()
            if raw_kcal.endswith("*"):
                footnote_n += 1
                raw_kcal = raw_kcal.rstrip("*").strip()
            m = KCAL_RE.fullmatch(raw_kcal)
            if not m:
                dropped_nonnum_n += 1
                if len(dropped_nonnum) < 5:
                    dropped_nonnum.append("%s=%r" % (name, raw_kcal))
                continue
            value = float(raw_kcal)
            if value != int(value):
                rounded_n += 1
            kcal = int(round(value))
            if kcal < 0 or kcal > KCAL_MAX:
                dropped_range_n += 1
                if len(dropped_range) < 5:
                    dropped_range.append("%s=%s" % (name, raw_kcal))
                continue
            key = (name, kcal)
            if key in seen:
                dup_removed += 1
                continue
            seen.add(key)
            rows.append([name, kcal])

    # 同名不同热量（面板里可能出现重名，属正常）
    by_name = {}
    for name, kcal in rows:
        by_name.setdefault(name, set()).add(kcal)
    same_name_diff = sum(1 for kcals in by_name.values() if len(kcals) > 1)

    # 硬校验
    ok = True
    kcal_of = {name: kcal for name, kcal in rows}
    sanity_lines = []
    for name, expected in SANITY.items():
        actual = kcal_of.get(name)
        good = actual == expected
        ok = ok and good
        sanity_lines.append("%s=%s %s" % (name, actual, "OK" if good else "FAIL(期望 %s)" % expected))
    longest = max((len(name) for name, _ in rows), default=0)
    if longest >= NAME_MAX:
        ok = False
        sanity_lines.append("存在超长名称：%d 字 FAIL" % longest)

    print("build_foods_db: 读取 %d 个文件（按模式跳过 %d 个：%s）"
          % (len(files), len(skipped), ", ".join(skipped) or "无"))
    print("  原始条数                    %d" % raw_count)
    print("  剥除脚注星号（899* → 899）  %d" % footnote_n)
    print("  剔除（热量 —/Tr/空）        %d   %s" % (dropped_nonnum_n, "; ".join(dropped_nonnum)))
    print("  剔除（热量超范围 0~%d）    %d   %s" % (KCAL_MAX, dropped_range_n, "; ".join(dropped_range)))
    print("  四舍五入（非整数热量）      %d" % rounded_n)
    print("  去重（同名同热量）          %d" % dup_removed)
    print("  同名不同热量                %d（面板可能出现重名）" % same_name_diff)
    print("  保留                        %d" % len(rows))
    print("  名称最长 %d 字（上限 %d）" % (longest, NAME_MAX))
    for line in sanity_lines:
        print("  校验: %s" % line)

    if not ok:
        print("错误：硬校验未通过，未写出 %s" % out_path)
        return 1

    body = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    header = (
        "// foods.js — 由 tools/build_foods_db.py 生成，请勿手改\n"
        "// 数据源：%s @ %s / %s\n"
        "// 《中国食物成分表标准版（第6版）》每 100 克可食部热量（千卡）；条目数：%d\n"
        % (DATA_SOURCE, COMMIT, DATA_DIR_NAME, len(rows))
    )
    out_path.write_text(header + "window.FOOD_DB=" + body + ";\n", encoding="utf-8")
    print("输出: %s  %s 字节" % (out_path, out_path.stat().st_size))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
