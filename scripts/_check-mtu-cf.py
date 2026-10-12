#!/usr/bin/env python3
import pathlib, paramiko, sys
key=next(x for x in (pathlib.Path.home()/".ssh"/"id_ed25519_taranom", pathlib.Path(r"D:\proje\.ssh\id_ed25519_taranom")) if x.exists())
c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy()); c.connect("94.249.244.208", username="taranom", key_filename=str(key), timeout=30)
_,o,e=c.exec_command("ip link show eth0; ip route; sysctl net.ipv4.tcp_mtu_probing 2>/dev/null; ping -c 2 -M do -s 1400 1.1.1.1 2>&1 | tail -5", timeout=40)
sys.stdout.write((o.read()+e.read()).decode("ascii","replace")); c.close()
