#!/usr/bin/env python3
"""由 data/common-portions.json 生成 portions.js（页面运行时的常见份量估算表）。

用法：
    python3 -I tools/build_portions.py [输入 JSON] [输出路径] [选项]

选项：
    --check               只校验现有 portions.js 是否与数据源一致（过期 exit 1，不写文件）
    --strict-report       成分表核对偏差 >25% 时判为失败
    --allow-kcal-drift    份量热量与公式不符时只警告（默认失败）
    --composition DIR     覆盖成分表目录（默认 data/food-composition）

份量热量一律按 JS 的 Math.round 语义（floor(x + 0.5)）核对——页面用 Math.round，
两者在恰好 .5 时必须一致（例：65 × 250 / 100 = 162.5 → 页面 163，Python round() 会给 162）。

绝不按名称从成分表推导热量：同名条目常是「生/干/脱水」形态（面条（生，代表值）301 而
熟面条只有 107、木耳（干）265 而水发 27、红薯叶 27 而红薯约 86），自动匹配会错得离谱。
每条食物的 kcal100 以入口形态为准、由数据源显式给出，成分表只用于打印人工核对报告。
"""
import json
import math
import re
import sys
from pathlib import Path

PORTION_MAX = 3          # 每种食物最多 3 个份量选项（页面另加一行「100 克」）
GRAMS_MAX = 5000
KCAL100_MAX = 2000
NAME_MAX = 100           # 与 index.html 的 maxlength 一致
DESC_MAX = 24
MIN_FOODS = 100          # 用户要求：至少 100 种
DESC_WEIGHT_RE = re.compile(r"\d+\s*(?:g|G|克|ml|mL|ML|毫升)")
# 形态词：带这些词的同名条目多半不是「入口形态」，不能用来核对
FORM_WORDS = ("干", "脱水", "生", "罐", "松", "脯", "酱", "粉", "腌", "腊", "熏", "冻", "汁", "熟")
UNITS = ("g", "ml")
# 硬抽查：写死自人工核算的常见份量，防止数据源被改坏
SANITY = [
    ("香蕉", 118, 100, 115),      # ≈ 110
    ("米饭", 200, 200, 250),      # ≈ 232
    ("可乐", 330, 130, 155),      # ≈ 142
    ("纯牛奶", 250, 150, 175),    # ≈ 163（162.5 的 JS 取整）
    ("鸡蛋", 50, 60, 80),         # ≈ 70
    ("苹果", 200, 90, 120),       # ≈ 106
]


def jsround(x):
    """JS Math.round 语义：.5 一律向上（Python 内置 round() 是银行家舍入，会差 1）。"""
    return math.floor(x + 0.5)


def normalize_key(s):
    """与 index.html 的 normalizeKey 一致：小写、去空白、半角括号并全角。"""
    return re.sub(r"\s+", "", str(s).lower()).replace("(", "（").replace(")", "）")


def base_name(n):
    """与 index.html 的 baseNameOf 一致：在首个括号处截断。"""
    cut = re.search(r"[（(［[]", n)
    return n[:cut.start()] if cut and cut.start() > 0 else n


def load_composition(comp_dir):
    """读成分表（只读，用于核对报告）；返回 [(条目名, 千卡)]，条目名保持原样。"""
    out = []
    for path in sorted(comp_dir.glob("merged_*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as err:
            print("警告：跳过 %s（%s）" % (path.name, err))
            continue
        if not isinstance(data, list):
            continue
        for row in data:
            if not isinstance(row, dict):
                continue
            name = str(row.get("foodName", "")).strip()
            raw = str(row.get("energyKCal", "")).strip().rstrip("*").strip()
            if not name or not re.fullmatch(r"\d+(?:\.\d+)?", raw):
                continue
            out.append((name, int(jsround(float(raw)))))
    return out


def compare(cand, kcal100):
    """与成分表某条比较，返回 (偏差百分比, 文案)。"""
    diff = abs(kcal100 - cand[1]) / cand[1] * 100 if cand[1] else 100.0
    return diff, "%s=%d" % (cand[0], cand[1])


def check_food(food, i, comp_by_name, comp_by_base, seen_name, seen_base, errors, warns):
    """单条食物的结构校验；错误写进 errors，警告写进 warns。"""
    where = "第 %d 条" % (i + 1)
    name = food.get("name")
    if not isinstance(name, str) or not name.strip():
        errors.append("%s：name 必须是非空字符串" % where)
        return None
    name = name.strip()
    if len(name) > NAME_MAX:
        errors.append("%s %s：名称超过 %d 字" % (where, name, NAME_MAX))
    nk, b = normalize_key(name), base_name(normalize_key(name))
    if nk in seen_name:
        errors.append("%s %s：名称与第 %d 条重复（规范化后同名）" % (where, name, seen_name[nk] + 1))
    elif b in seen_base:
        errors.append("%s %s：基础名与第 %d 条重复（下拉里会互相抢同一次命中）"
                      % (where, name, seen_base[b] + 1))
    else:
        seen_name[nk] = i
        seen_base[b] = i

    kcal100 = food.get("kcal100")
    if not isinstance(kcal100, int) or isinstance(kcal100, bool) or not 1 <= kcal100 <= KCAL100_MAX:
        errors.append("%s %s：kcal100 必须是 1~%d 的整数" % (where, name, KCAL100_MAX))
        return None
    unit = food.get("unit")
    if unit not in UNITS:
        errors.append("%s %s：unit 必须是 g 或 ml" % (where, name))

    portions = food.get("portions")
    if not isinstance(portions, list) or not 1 <= len(portions) <= PORTION_MAX:
        errors.append("%s %s：portions 必须是 1~%d 个" % (where, name, PORTION_MAX))
        return None
    seen_desc, seen_grams = set(), set()
    for j, p in enumerate(portions):
        tag = "%s %s 第 %d 个份量" % (where, name, j + 1)
        if not isinstance(p, dict):
            errors.append("%s：必须是对象" % tag)
            continue
        desc, grams, kcal = p.get("desc"), p.get("grams"), p.get("kcal")
        if not isinstance(desc, str) or not desc.strip():
            errors.append("%s：desc 必须是非空字符串" % tag)
        else:
            if len(desc) > DESC_MAX:
                errors.append("%s：desc 超过 %d 字：%s" % (tag, DESC_MAX, desc))
            if DESC_WEIGHT_RE.search(desc):
                errors.append("%s：desc 不能含重量（页面会自动拼「，约 118g」）：%s" % (tag, desc))
            if desc in seen_desc:
                errors.append("%s：desc 重复：%s" % (tag, desc))
            seen_desc.add(desc)
        if not isinstance(grams, int) or isinstance(grams, bool) or not 1 <= grams <= GRAMS_MAX:
            errors.append("%s：grams 必须是 1~%d 的整数" % (tag, GRAMS_MAX))
            continue
        if grams in seen_grams:
            errors.append("%s：grams 重复：%d" % (tag, grams))
        seen_grams.add(grams)
        expect = jsround(kcal100 * grams / 100)
        if not isinstance(kcal, int) or isinstance(kcal, bool) or kcal < 1:
            errors.append("%s：kcal 必须是正整数（%d 克应为 %d）" % (tag, grams, expect))
        elif kcal != expect:
            errors.append("%s：kcal=%d 与公式不符，按 %d 千卡/100 × %d 克应为 %d"
                          % (tag, kcal, kcal100, grams, expect))
    default = food.get("default")
    if default is not None:
        if not isinstance(default, int) or isinstance(default, bool) or not 0 <= default < len(portions):
            errors.append("%s %s：default 必须是 0~%d 的下标" % (where, name, len(portions) - 1))

    ref = food.get("ref")
    if ref is not None:
        if not isinstance(ref, str) or ref not in comp_by_name:
            errors.append("%s %s：ref「%s」在成分表里找不到" % (where, name, ref))
        else:
            diff, text = compare(comp_by_name[ref], kcal100)
            if diff > 25:
                warns.append("偏差 %s：JSON %d vs ref %s  差 %.0f%%" % (name, kcal100, text, diff))
            return (name, kcal100, "ref", text, diff)
    return (name, kcal100, None, None, None)


def report_for(food_name, kcal100, comp_by_name, comp_by_base):
    """无 ref 时按名称保守匹配：返回 (状态, 说明, 偏差)。"""
    nk = normalize_key(food_name)
    if nk in comp_by_name:
        diff, text = compare(comp_by_name[nk], kcal100)
        return ("核对", text, diff)
    cands = comp_by_base.get(base_name(nk), [])
    if not cands:
        return ("无匹配", "", None)
    trusted = [c for c in cands if not any(w in c[0] for w in FORM_WORDS)]
    suspects = [c for c in cands if c not in trusted]
    if len(trusted) == 1:
        diff, text = compare(trusted[0], kcal100)
        return ("核对", text, diff)
    if trusted:
        hits = [(compare(c, kcal100)[0], c) for c in trusted]
        near = [c for d, c in hits if d <= 25]
        if len(near) == 1:
            diff, text = compare(near[0], kcal100)
            return ("核对", text, diff)
        return ("存疑", "候选 %s" % " / ".join("%s=%d" % c for c in trusted), None)
    return ("存疑", "候选（均为非入口形态）%s" % " / ".join("%s=%d" % c for c in suspects[:4]), None)


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = {a for a in argv[1:] if a.startswith("--")}
    known = {"--check", "--strict-report", "--allow-kcal-drift"}
    unknown = flags - known
    if unknown:
        print("错误：未知选项 %s" % " ".join(sorted(unknown)))
        print(__doc__)
        return 2
    root = Path(__file__).resolve().parent.parent
    in_path = Path(args[0]) if len(args) > 0 else root / "data/common-portions.json"
    out_path = Path(args[1]) if len(args) > 1 else root / "portions.js"
    comp_dir = root / "data/food-composition"
    if "--composition" in argv:
        comp_dir = Path(argv[argv.index("--composition") + 1])
    if not in_path.is_file():
        print("错误：数据源不存在：%s" % in_path)
        return 2

    try:
        foods = json.loads(in_path.read_text(encoding="utf-8"))
    except ValueError as err:
        print("错误：%s 不是合法 JSON（%s）" % (in_path, err))
        return 1
    if not isinstance(foods, list):
        print("错误：%s 顶层必须是数组" % in_path)
        return 1

    comp = load_composition(comp_dir)
    comp_by_name = {normalize_key(n): (n, k) for n, k in comp}
    comp_by_base = {}
    for n, k in comp:
        comp_by_base.setdefault(base_name(normalize_key(n)), []).append((n, k))

    errors, warns, results = [], [], []
    seen_name, seen_base = {}, {}
    for i, food in enumerate(foods):
        if not isinstance(food, dict):
            errors.append("第 %d 条：必须是对象" % (i + 1))
            continue
        unknown_keys = set(food) - {"name", "kcal100", "unit", "portions", "default", "ref", "note"}
        if unknown_keys:
            warns.append("第 %d 条 %s：忽略未知字段 %s"
                         % (i + 1, food.get("name"), "、".join(sorted(unknown_keys))))
        got = check_food(food, i, comp_by_name, comp_by_base, seen_name, seen_base, errors, warns)
        if got:
            results.append(got)

    # 硬抽查
    by_name = {f.get("name"): f for f in foods if isinstance(f, dict)}
    sanity_lines, ok = [], True
    for name, grams, lo, hi in SANITY:
        food = by_name.get(name)
        if not food:
            ok = False
            sanity_lines.append("%s：数据源里没有这种食物 FAIL" % name)
            continue
        portion = next((p for p in food.get("portions", []) if p.get("grams") == grams), None)
        if not portion:
            ok = False
            sanity_lines.append("%s：没有 %d 克的份量 FAIL" % (name, grams))
            continue
        actual = jsround(food["kcal100"] * grams / 100)
        good = lo <= actual <= hi
        ok = ok and good
        sanity_lines.append("%s %d %s = %d 千卡（%d~%d）%s"
                            % (name, grams, food.get("unit", "g"), actual, lo, hi,
                               "OK" if good else "FAIL"))
    if len(foods) < MIN_FOODS:
        ok = False
        sanity_lines.append("食物数 %d < %d FAIL" % (len(foods), MIN_FOODS))

    # 成分表核对报告
    lines, agree, mismatch, nomatch, doubtful = [], 0, [], [], []
    for name, kcal100, kind, text, diff in results:
        if kind == "ref":
            if diff is not None and diff <= 25:
                agree += 1
                lines.append("  %-10s JSON %-4d vs ref %s  差 %.0f%%" % (name, kcal100, text, diff))
            continue
        status, note, diff = report_for(name, kcal100, comp_by_name, comp_by_base)
        if status == "核对":
            if diff <= 25:
                agree += 1
                lines.append("  %-10s JSON %-4d vs %s  差 %.0f%%" % (name, kcal100, note, diff))
            else:
                mismatch.append("  %-10s JSON %-4d vs %s  差 %.0f%%" % (name, kcal100, note, diff))
        elif status == "存疑":
            doubtful.append("  %-10s JSON %-4d %s" % (name, kcal100, note))
        else:
            nomatch.append("  %-10s JSON %-4d 成分表无同名/同基础名条目" % (name, kcal100))

    n_portion = sum(len(f.get("portions", [])) for f in foods if isinstance(f, dict))
    print("build_portions: 读取 %s" % in_path)
    print("  食物数 / 份量选项           %d / %d" % (len(foods), n_portion))
    print("  结构校验                    错误 %d，警告 %d" % (len(errors), len(warns)))
    for line in errors:
        print("    ✗ %s" % line)
    for line in warns:
        print("    ! %s" % line)
    print("  成分表核对（仅报告，不参与生成）")
    print("    可核对 %d 条：一致 %d，偏差 >25%% %d，无法核对（存疑/无匹配）%d"
          % (agree + len(mismatch), agree, len(mismatch), len(doubtful) + len(nomatch)))
    for line in mismatch:
        print("    ✗ %s" % line)
    for line in lines[:8]:
        print("    %s" % line)
    if len(lines) > 8:
        print("    …（其余 %d 条一致，省略）" % (len(lines) - 8))
    for line in doubtful + nomatch:
        print("    ? %s" % line)
    print("  硬抽查")
    for line in sanity_lines:
        print("    %s" % line)

    drift = [e for e in errors if "与公式不符" in e]
    bad = [e for e in errors if e not in drift]
    fatal = bool(bad) or not ok or (drift and "--allow-kcal-drift" not in flags)
    if "--strict-report" in flags and mismatch:
        fatal = True
    if fatal:
        print("错误：校验未通过，未写出 %s" % out_path)
        return 1

    body = "window.FOOD_PORTIONS=[\n" + ",\n".join(
        json.dumps({
            "name": f["name"], "kcal100": f["kcal100"], "unit": f["unit"],
            "def": f.get("default", -1),
            "portions": [{"desc": p["desc"], "grams": p["grams"]} for p in f["portions"]],
        }, ensure_ascii=False, separators=(",", ":"))
        for f in foods
    ) + "\n];\n"
    header = (
        "// portions.js — 由 tools/build_portions.py 生成，请勿手改\n"
        "// 数据源：%s（人工整理，kcal100 以入口形态为准：熟重/鲜重/水发）\n"
        "// 份量热量不落盘，页面按 Math.round(kcal100 × grams / 100) 现算，与保存记录同式\n"
        "// 食物数：%d，份量选项：%d\n"
        % (in_path.name, len(foods), n_portion)
    )
    text = header + body

    if "--check" in flags:
        if not out_path.is_file():
            print("错误：%s 不存在，请先运行一次构建" % out_path)
            return 1
        if out_path.read_text(encoding="utf-8") != text:
            print("错误：%s 已过期（与数据源不一致），请重新运行构建" % out_path)
            return 1
        print("校验通过：%s 与数据源一致" % out_path)
        return 0

    out_path.write_text(text, encoding="utf-8")
    print("输出: %s  %s 字节" % (out_path, out_path.stat().st_size))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
