#!/usr/bin/env python3
"""Keep join credentials in root-only files and out of rendered bootstrap."""

import os
import re
import secrets
import stat
import sys
import tempfile
from pathlib import Path


SERVER_DIR = Path("/var/lib/rancher/k3s/server")
APP_AGENT_SECRET = Path("/etc/rancher/k3s/app-agent-secret")
JUDGE_TOKEN = Path("/etc/rancher/k3s/judge-agent-token")


def read_protected(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError("expected a root-owned regular credential file with mode 0600")
    return path.read_text(encoding="ascii").removesuffix("\n")


def write_protected(path, value):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, encoding="ascii", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(value + "\n")
            stream.close()
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def app_agent_secret():
    if not APP_AGENT_SECRET.exists():
        if (SERVER_DIR / "token").exists() or (SERVER_DIR / "db").exists():
            raise ValueError("existing cluster requires the approved agent credential")
        # The K3s server generates its own separate server credential.
        write_protected(APP_AGENT_SECRET, secrets.token_hex(32))
    if re.fullmatch(r"[0-9a-f]{64}", read_protected(APP_AGENT_SECRET)) is None:
        raise ValueError("invalid App agent credential file")


def validate_agent(value):
    # K3s writes the dedicated agent password under the basic-auth user "node".
    if re.fullmatch(r"K10[0-9a-f]{64}::node:[0-9a-f]{64}", value) is None:
        raise ValueError("expected a secure agent credential with the server CA hash")


def main():
    if len(sys.argv) != 2:
        return 2
    try:
        match sys.argv[1]:
            case "app":
                app_agent_secret()
            case "judge":
                validate_agent(read_protected(JUDGE_TOKEN))
            case "receive-judge":
                if Path("/etc/astracode/node-role").read_text().strip() != "judge":
                    raise ValueError("agent credential delivery requires a Judge node")
                token = sys.stdin.read(256).removesuffix("\n")
                validate_agent(token)
                write_protected(JUDGE_TOKEN, token)
            case _:
                return 2
    except (OSError, ValueError):
        print("K3s credential gate refused missing, invalid or unprotected credentials.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
