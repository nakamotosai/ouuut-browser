"""probe.base —— M0 探针契约。

**契约说明见 `probe/README.md`。** 本模块只放契约本身(数据类型 + 门面协议 + 注册表),
不放任何具体 target / site 的实现。

设计要点:
- 同步 API。Playwright 同步接口与 ego-browser CLI(阻塞式)都能自然表达。
- target 适配器唯一义务:给定 `LaunchSpec` 产出 `BrowserFacade`。
- site 探测器唯一义务:给定 `BrowserFacade` 产出 `(verdict, detail)`。
- `detail` 必须放**原始证据**,不许只放结论 —— 否则无法复算。
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Protocol, runtime_checkable

PROBE_VERSION = "0.1.0"
PROBE_DIR = Path(__file__).resolve().parent
OUT_DIR = PROBE_DIR / "out"

# ---- verdict:只允许这三个值 ------------------------------------------------
VERDICT_PASSED = "passed"
VERDICT_DETECTED = "detected"
VERDICT_ERROR = "error"
VERDICTS = (VERDICT_PASSED, VERDICT_DETECTED, VERDICT_ERROR)


class ProbeError(RuntimeError):
    """探针自身出错(不是被判定的结果)。"""


# ---- 出口 ------------------------------------------------------------------

@dataclass(frozen=True)
class Egress:
    """一个固定的出网条件。**必须固定** —— 轮换出口会让对照失效(见 probe/README.md §二)。"""

    name: str
    proxy: str | None          # None = 直连;否则 "socks5://host:port"
    kind: str                  # "direct" | "datacenter"
    note: str = ""


EGRESSES: dict[str, Egress] = {
    "direct": Egress(
        name="direct",
        proxy=None,
        kind="direct",
        note="本机直连(住宅/ISP 段),最接近真实用户",
    ),
    "pin-jp-41105": Egress(
        name="pin-jp-41105",
        proxy="socks5://198.51.100.7:41105",
        kind="datacenter",
        note="单个 bind-socks5 节点,出口 161.33.5.222(Oracle JP 机房)",
    ),
}


# ---- 被测对象 --------------------------------------------------------------

@dataclass
class LaunchSpec:
    """一次启动的全部输入。档案目录由 run.py 分配(每 target × 每 egress 一个干净档案)。"""

    target: str
    egress: Egress
    profile_dir: Path
    out_dir: Path
    headless: bool = True
    timeout_ms: int = 60000


@runtime_checkable
class BrowserFacade(Protocol):
    """被测对象的统一门面。

    实现者只需暴露这些方法。**不要**在这里假设 Playwright —— ego lite 不是 Playwright,
    它通过 CLI + JS 脚本驱动,由适配器把差异吸收掉。
    """

    name: str

    def goto(self, url: str, *, wait_until: str = "load", timeout_ms: int = 60000) -> None: ...
    def eval(self, js: str) -> Any: ...
    def wait(self, ms: int) -> None: ...
    def click(self, selector: str, *, timeout_ms: int = 30000) -> None: ...
    def has(self, selector: str, *, timeout_ms: int = 5000) -> bool: ...
    def screenshot(self, name: str) -> str: ...
    def close(self) -> None: ...


# ---- 检测站 ----------------------------------------------------------------

@dataclass
class Site:
    """一个检测站。`run` 返回 (verdict, detail)。

    `detail` 里必须能看出**为什么**是这个 verdict(原始字段/文本/计数),
    以便第三方用同一脚本复算出同一结论。
    """

    name: str
    url: str
    run: Callable[[BrowserFacade], "tuple[str, dict]"]
    note: str = ""


# ---- 结果 ------------------------------------------------------------------

@dataclass
class Result:
    target: str
    site: str
    egress: str
    verdict: str
    detail: dict = field(default_factory=dict)
    screenshots: list[str] = field(default_factory=list)
    error: str | None = None
    duration_s: float = 0.0
    ts: str = ""
    probe_version: str = PROBE_VERSION
    proxy_effective: str | None = None
    exit_ip: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


# ---- 注册表 ----------------------------------------------------------------

_TARGETS: dict[str, Callable[[LaunchSpec], Any]] = {}
_SITES: dict[str, "Site"] = {}


def register_target(name: str) -> Callable:
    """把一个 `launch(spec) -> context manager[BrowserFacade]` 注册为被测对象。"""

    def deco(fn: Callable[[LaunchSpec], Any]) -> Callable[[LaunchSpec], Any]:
        if name in _TARGETS:
            raise ProbeError(f"target 重复注册: {name}")
        _TARGETS[name] = fn
        return fn

    return deco


def register_site(site: Site) -> Site:
    if site.name in _SITES:
        raise ProbeError(f"site 重复注册: {site.name}")
    _SITES[site.name] = site
    return site


def get_target(name: str) -> Callable[[LaunchSpec], Any]:
    if name not in _TARGETS:
        raise ProbeError(f"未知 target: {name}(已注册: {sorted(_TARGETS)})")
    return _TARGETS[name]


def get_site(name: str) -> Site:
    if name not in _SITES:
        raise ProbeError(f"未知 site: {name}(已注册: {sorted(_SITES)})")
    return _SITES[name]


def target_names() -> list[str]:
    return sorted(_TARGETS)


def site_names() -> list[str]:
    return sorted(_SITES)


def load_all() -> None:
    """导入所有适配器,填充注册表。由 run.py 调用。"""
    import importlib
    import pkgutil

    import probe

    for pkg_name in ("probe.targets", "probe.sites"):
        pkg = importlib.import_module(pkg_name)
        for mod in pkgutil.iter_modules(pkg.__path__):
            if mod.name.startswith("_"):
                continue
            importlib.import_module(f"{pkg_name}.{mod.name}")


# ---- 公共小工具 ------------------------------------------------------------

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def json_dump(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(obj, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
        newline="\n",
    )


def run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
