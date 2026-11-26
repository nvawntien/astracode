"""Provision managed SQL permissions from operator-delivered, private credential files."""

import argparse
from pathlib import Path
import re
import subprocess

from coordinator import OWNERS, password_verifier


def bootstrap(system_id, secrets):
    if not re.fullmatch(r"[0-9]+", system_id):
        raise ValueError("expected PostgreSQL system identifier")
    root = Path(__file__).resolve().parent

    def psql(service, script, variables, credential=None):
        args = [
            "psql",
            "-Xq",
            "-v",
            "ON_ERROR_STOP=1",
            "service=" + service,
            "-v",
            "expected_system_id=" + system_id,
        ]
        for name, value in variables.items():
            args.extend(["-v", name + "=" + value])
        prefix = ""
        if credential is not None:
            private = secrets / credential
            if private.is_symlink() or private.stat().st_mode & 0o077:
                raise ValueError("private operator credential file required")
            raw = private.read_text().rstrip("\n")
            if not re.fullmatch("[a-f0-9]{64}", raw):
                raise ValueError("expected a distinct generated managed password")
            prefix = "\\set verifier '" + password_verifier(raw) + "'\n"
        subprocess.run(
            args,
            cwd=root,
            input=prefix + "\\i " + script + "\n",
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=180,
        )

    psql("astra_bootstrap", "bootstrap.sql", {})
    psql("astra_bootstrap", "fencer-login.sql", {}, "fencer")
    for owner in OWNERS:
        psql("astra_bootstrap_" + owner, "runtime-login.sql", {"owner": owner}, owner)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--system-id", required=True)
    parser.add_argument("--credential-directory", required=True, type=Path)
    args = parser.parse_args()
    bootstrap(args.system_id, args.credential_directory)
