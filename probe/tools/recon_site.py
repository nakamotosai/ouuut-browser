"""probe/tools/recon_site.py —— 站点结构侦察(写/校准站点探针之前先用它)。

为什么需要:写站点探针最容易犯的错是**凭印象猜选择器**,然后拿到空结果还以为「站点没渲染」。
本工具把该站的真实结构一次性摊开,让选择器是**看出来的**而不是猜出来的。

用法:
    PY=probe/.venv/Scripts/python.exe
    $PY probe/tools/recon_site.py https://abrahamjuliot.github.io/creepjs/ --wait 20000
    $PY probe/tools/recon_site.py <url> --wait 30000 --grep trust,bot --egress direct

输出(JSON,落盘 + 打印摘要):
  - title / url / htmlBytes
  - 所有含关键词的元素:`tag.class` + 文本片段
  - 文本命中关键词的上下文片段(在 innerHTML 里找)
  - shadow root 数量(很多现代站点把内容放进 shadow DOM,`innerText` 取不到)
  - iframe 清单(跨域 iframe 的文本本进程取不到)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from probe.base import EGRESSES, LaunchSpec  # noqa: E402

RECON_JS = r"""
(keywords) => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const kws = keywords.length ? keywords : [];
  const hit = (s) => kws.some((k) => (s || '').toLowerCase().includes(k.toLowerCase()));

  const out = {
    title: document.title,
    url: location.href,
    htmlBytes: document.documentElement.outerHTML.length,
    innerTextLen: norm(document.body.innerText).length,
  };

  // 1) 含关键词的元素
  out.matchedElements = [];
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const cls = typeof el.className === 'string' ? el.className : '';
    const id = el.id || '';
    if (kws.length && (hit(cls) || hit(id))) {
      out.matchedElements.push({
        tag: el.tagName.toLowerCase(),
        id,
        cls: cls.slice(0, 120),
        text: norm(el.innerText || el.textContent).slice(0, 200),
      });
      if (out.matchedElements.length >= 80) break;
    }
  }

  // 2) 在 innerHTML 里找关键词上下文(能抓到「文本在内联脚本/属性里」的情况)
  out.htmlContexts = [];
  if (kws.length) {
    const html = document.documentElement.innerHTML;
    const low = html.toLowerCase();
    for (const k of kws) {
      let from = 0;
      let n = 0;
      while (n < 5) {
        const i = low.indexOf(k.toLowerCase(), from);
        if (i < 0) break;
        out.htmlContexts.push({ kw: k, ctx: html.slice(Math.max(0, i - 120), i + 160) });
        from = i + k.length;
        n += 1;
      }
    }
  }

  // 3) shadow root(innerText 取不到里面的文本)
  out.shadowHosts = [];
  for (const el of all) {
    if (el.shadowRoot) {
      out.shadowHosts.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
        text: norm(el.shadowRoot.textContent).slice(0, 300),
      });
      if (out.shadowHosts.length >= 20) break;
    }
  }

  // 4) iframe
  out.frames = [...document.querySelectorAll('iframe')].map((f) => ({
    src: (f.src || '').slice(0, 200),
    id: f.id || '',
    title: f.title || '',
    w: f.clientWidth, h: f.clientHeight,
  }));

  // 5) 顶层可见文本(供人眼扫)
  out.bodyTextHead = norm(document.body.innerText).slice(0, 3000);
  return out;
}
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--wait", type=int, default=15000, help="首屏后等多久(毫秒)")
    ap.add_argument("--grep", default="", help="逗号分隔的关键词")
    ap.add_argument("--egress", default="direct")
    ap.add_argument("--out", default="probe/out/_recon")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    kws = [k.strip() for k in args.grep.split(",") if k.strip()]
    egress = EGRESSES[args.egress]
    out_dir = Path(_REPO_ROOT) / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    spec = LaunchSpec(
        target="pw-naive",
        egress=egress,
        profile_dir=out_dir / "profile",
        out_dir=out_dir,
        headless=not args.headed,
    )

    from probe.targets.pw_naive import launch

    with launch(spec) as br:
        br.goto(args.url, wait_until="domcontentloaded", timeout_ms=90000)
        br.wait(args.wait)
        data = br.eval(f"({RECON_JS})({json.dumps(kws)})")
        try:
            data["screenshot"] = br.screenshot("recon")
        except Exception as exc:
            data["screenshot_error"] = repr(exc)

    slug = re.sub(r"[^A-Za-z0-9._-]", "_", args.url)[:80]
    path = out_dir / f"{slug}.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")

    print(f"title           : {data['title']}")
    print(f"innerText len   : {data['innerTextLen']}")
    print(f"htmlBytes       : {data['htmlBytes']}")
    print(f"matchedElements : {len(data['matchedElements'])}")
    print(f"htmlContexts    : {len(data['htmlContexts'])}")
    print(f"shadowHosts     : {len(data['shadowHosts'])}")
    print(f"frames          : {len(data['frames'])}")
    print("\n--- 前 15 个匹配元素 ---")
    for e in data["matchedElements"][:15]:
        print(f"  {e['tag']}#{e['id']}.{e['cls'][:50]} :: {e['text'][:90]}")
    print("\n--- 前 5 个 html 上下文 ---")
    for c in data["htmlContexts"][:5]:
        print(f"  [{c['kw']}] …{c['ctx'][:200]}…")
    print("\n--- shadow / frame ---")
    for s in data["shadowHosts"][:5]:
        print(f"  shadow {s['tag']}#{s['id']} :: {s['text'][:100]}")
    for f in data["frames"][:5]:
        print(f"  frame {f['id']} {f['w']}x{f['h']} {f['src'][:90]}")
    print(f"\n全量 JSON: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
