
import subprocess
PROXY = "socks5h://saaaai:resin-proxy-sai-2026@198.51.100.7:2260"
ips = []
for i in range(8):
    r = subprocess.run(["curl","-s","--proxy",PROXY,"--max-time","20","https://api.ipify.org"],
                       capture_output=True, text=True)
    ips.append((r.stdout or r.stderr).strip()[:40])
print("sequential 8:", ips)
print("unique:", len(set(ips)))
