
import subprocess, pathlib, json
EGO = r"<你的家目录>\.local\bin\ego-browser.cmd"
STEPS = {
    "1_goto": '\nconst t = await taskSpace("m0-probe");\nconst p = t.page("p1");\nawait p.goto("https://example.com");\nconsole.log(JSON.stringify({space: t.spaceId, label: p.label}));\n',
    "2_eval": '\nconst t = await taskSpace("m0-probe");\nconst p = t.page("p1");\nconst title = await p.evaluate("document.title");\nconsole.log(JSON.stringify({space: t.spaceId, label: p.label, title, url: location}));\n',
    "3_eval": '\nconst t = await taskSpace("m0-probe");\nconst p = t.page("p1");\nconsole.log(JSON.stringify({space: t.spaceId, href: await p.evaluate("location.href")}));\n',
}
for name, js in STEPS.items():
    f = pathlib.Path(r"F:/projects/ouuut-browser/probe/_ego_step.mjs")
    f.write_text(js, encoding="utf-8", newline="\n")
    r = subprocess.run([EGO, "nodejs"], stdin=open(f, "rb"), capture_output=True, timeout=180)
    out = (r.stdout or b"").decode("utf-8", "replace").strip()
    err = (r.stderr or b"").decode("utf-8", "replace").strip()
    print(f"--- {name} rc={r.returncode}")
    print("  out:", out[:400])
    if err: print("  err:", err[:300])
