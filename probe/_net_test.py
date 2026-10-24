
import subprocess
PROXY = "socks5h://saaaai:resin-proxy-sai-2026@198.51.100.7:2260"
targets = [
  "https://api.ipify.org",
  "https://bot-detector.rebrowser.net/",
  "https://abrahamjuliot.github.io/creepjs/",
  "https://browserleaks.com/",
]
for u in targets:
    r = subprocess.run(["curl","-s","--proxy",PROXY,"-o","NUL","-w","%{http_code} %{time_total}s",
                        "--max-time","25", u], capture_output=True, text=True)
    print(f"{u:46} rc={r.returncode} {(r.stdout or r.stderr).strip()[:80]}")
r = subprocess.run(["curl","-s","--proxy",PROXY,"--max-time","25","https://api.ipify.org"],
                   capture_output=True, text=True)
print("exit IP via resin:", (r.stdout or r.stderr).strip()[:40])
