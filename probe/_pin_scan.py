
import subprocess, concurrent.futures as cf

JP = "198.51.100.7"
def probe(port):
    px = f"socks5h://{JP}:{port}"
    ips = []
    for _ in range(2):
        r = subprocess.run(["curl","-s","--proxy",px,"--max-time","12","https://api.ipify.org"],
                           capture_output=True, text=True)
        v = (r.stdout or "").strip()
        ips.append(v if v and "<" not in v else f"ERR{r.returncode}")
    return port, ips

ports = list(range(41105, 41140))
live = []
with cf.ThreadPoolExecutor(max_workers=12) as ex:
    for port, ips in ex.map(probe, ports):
        ok = ips[0].startswith(tuple("0123456789"))
        if ok:
            live.append((port, ips))
print("LIVE JP bind-socks5 nodes:")
for p, ips in live:
    sticky = "STICKY" if ips[0] == ips[1] else "ROTATE"
    print(f"  {JP}:{p}  {ips[0]:18} {sticky}")
print("total live:", len(live), "/", len(ports))
