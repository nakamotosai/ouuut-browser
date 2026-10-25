#!/usr/bin/env python3
"""creepjs 判据的自查用例 —— 直接跑:`python probe/tools/check_creepjs_classify.py`

## 为什么要有这个文件

2026-10-25 的两次只读核验,各抓到一版 `_classify` 守卫的毛病:

* 第一版把守卫写在**等级分支之前** —— 于是「段在、没 tell、但 grade=88」由 `detected` 变 `error`,
  即**用"防假绿"的名义造出了假红**;
* 改过之后条件写成「有没有 tell」,盖不住「只有 `hasKnownBgColor` 这类**名单外键**」的形状,守卫形同虚设。

当时那些"12 条合成用例"只存在于对话里 —— **说话不能当证据**。落成文件,谁都能复跑。

## 口径(判据本体见 `probe/sites/creepjs.py` 的 `_classify`)

**等级优先**:拿得到 `Headless` 段的等级就用它(≥ `GRADE_DETECTED` = 50 判 `detected`)。
**等级缺席时**才退回看 tell,并且**fail-closed**:连一个在 `HEADLESS_TELLS` 里的名字都没出现 ⇒ `error`
—— 分不清「真干净」与「解析退化 / 该站措辞变了」时,不许说"干净"。

⚠️ **已知口径后果(不是 bug,但要知道)**:等级在场时会**盖掉**为 true 的 tell ——
所以 `20261024-034257` 的 `patchright-hardened` 虽然 `hasHeadlessWorkerUa = true`、`hasHeadlessUa = true`,
因为 grade = 38 < 50 仍判 `passed`(见 `docs/M0-结论.md` §1.3 的补注)。
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from probe.base import VERDICT_DETECTED, VERDICT_ERROR, VERDICT_PASSED  # noqa: E402
from probe.sites.creepjs import _classify  # noqa: E402

HEAD = "Headlesse02c2159 chromium: true 88% like headless: d31f1ac1 × Like HeadlessnoChrome: true"
OTHER = "Headlesse02c2159 chromium: true 25% 别的东西"


def d(tells=None, grade=None, head=None):
    return {"tells": tells or {}, "headlessGrade": grade, "headSection": head or ""}


CASES = [
    # ---- 等级在场:等级说了算(不许被守卫打成 error) ----
    ("段在 + 没解出 tell + grade 88", d(grade=88, head=HEAD), VERDICT_DETECTED),
    ("段在 + 没解出 tell + grade 38", d(grade=38, head=HEAD), VERDICT_PASSED),
    ("段在 + 没解出 tell + grade 30", d(grade=30, head=HEAD), VERDICT_PASSED),
    ("没段 + 没 tell + grade 88", d(grade=88), VERDICT_DETECTED),
    ("033825 形状(粘连错键)+ grade 88", d({"truenodownlinkmax": True, "truehasheadlessworkerua": True}, 88, HEAD), VERDICT_DETECTED),
    ("名单内真为 true + grade 25 ⇒ 等级盖掉 tell", d({"noChrome": True}, 25), VERDICT_PASSED),
    # ---- 等级缺席:退回看 tell,fail-closed ----
    ("名单内 true + 无 grade", d({"noChrome": True}), VERDICT_DETECTED),
    ("名单内全 false + 无 grade", d({"noChrome": False, "noPlugins": False}), VERDICT_PASSED),
    ("只有名单外键 + 无 grade", d({"hasKnownBgColor": False, "prefersLightColor": True}, head=HEAD), VERDICT_ERROR),
    ("033825 形状(粘连错键)+ 无 grade", d({"truenodownlinkmax": True}, head=HEAD), VERDICT_ERROR),
    ("名单外 true + 无 grade + 段在", d({"device": True}, head=HEAD), VERDICT_ERROR),
    ("全空(没段、没 tell、没 grade)", d(), VERDICT_ERROR),
    ("文案改了 + 没 tell + 无 grade", d(head="Headless Detected"), VERDICT_ERROR),
]


def main() -> int:
    bad = 0
    for name, detail, want in CASES:
        got = _classify(detail)
        ok = got == want
        bad += 0 if ok else 1
        print(f"{'  OK  ' if ok else ' FAIL '} {got:<9} 期望 {want:<9} {name}")
    total = len(CASES)
    print(f"\n{total - bad}/{total} 通过")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
