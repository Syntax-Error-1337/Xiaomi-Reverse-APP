"""Server-owned Cloudflare tunnel with shared fate.

The server spawns `cloudflared` as its child:
  * server stops (Ctrl-C, SIGTERM, crash) -> tunnel child is killed.
  * tunnel crashes on its own -> supervisor restarts it with backoff
    while the server keeps serving the LAN.

Named-tunnel mode (custom domain): the token comes from the Cloudflare
dashboard (Zero Trust -> Networks -> Tunnels) and the dashboard owns the
`home.himanshu.pro -> http://localhost:<port>` ingress + DNS. The server
just runs `cloudflared tunnel run` with `TUNNEL_TOKEN` in the child's
environment, so the secret never appears in `ps` output.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time

_BACKOFF = (1, 2, 5, 10)


class TunnelSupervisor:
    def __init__(
        self,
        port: int,
        *,
        token: str = "",
        enabled: bool = True,
        bin: str = "cloudflared",
        argv: list | None = None,
        logger=print,
    ) -> None:
        self._port = port
        self._token = token
        self._enabled = enabled
        self._bin = bin
        self._argv = list(argv) if argv is not None else ["tunnel", "run"]
        self._log = logger
        self._proc = None
        self._running = False
        self._watcher = None

    @property
    def running(self) -> bool:
        return self._running and self._proc is not None and self._proc.poll() is None

    def start(self) -> bool:
        """Spawn the tunnel (once). Returns True when a child is alive."""
        if not self._enabled or not self._token:
            return False
        exe = self._bin if os.path.sep in self._bin else (shutil.which(self._bin) or "")
        if not exe:
            self._log(
                "tunnel: %s not found, serving LAN-only "
                "(install cloudflared or set CLOUDFLARED_BIN)" % self._bin
            )
            return False
        try:
            self._proc = self._spawn(exe)
        except OSError as e:
            self._log("tunnel: failed to start (%s), serving LAN-only" % e)
            return False
        self._running = True
        self._watcher = threading.Thread(target=self._watch, daemon=True)
        self._watcher.start()
        self._log("tunnel: cloudflared started (pid %d)" % self._proc.pid)
        return True

    def _spawn(self, exe: str) -> subprocess.Popen:
        env = dict(os.environ)
        env["TUNNEL_TOKEN"] = self._token  # argv stays secret-free
        return subprocess.Popen(
            [exe] + self._argv,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,  # own process group: kill hits child only
        )

    def _watch(self) -> None:
        fails = 0
        while self._running:
            rc = self._proc.poll() if self._proc else 0
            if rc is None:
                time.sleep(1)
                fails = 0
                continue
            if not self._running:
                break
            wait = _BACKOFF[min(fails, len(_BACKOFF) - 1)]
            fails += 1
            self._log("tunnel: cloudflared exited (%s), restarting in %ds" % (rc, wait))
            time.sleep(wait)
            if not self._running:
                break
            try:
                exe = self._bin if os.path.sep in self._bin else (shutil.which(self._bin) or "")
                if exe:
                    self._proc = self._spawn(exe)
                    self._log("tunnel: cloudflared restarted (pid %d)" % self._proc.pid)
            except OSError as e:
                self._log("tunnel: restart failed (%s)" % e)

    def stop(self) -> None:
        """Kill the tunnel child. Idempotent; shared fate with the server."""
        self._running = False
        proc, self._proc = self._proc, None
        if proc is None:
            return
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        if self._watcher is not None:
            self._watcher.join(timeout=5)
        self._log("tunnel: stopped")
