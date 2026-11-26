"""Exercise the managed Redis ACL in a disposable, network-disabled Redis container."""

from pathlib import Path
import secrets
import subprocess
import tempfile
import time

from redis_acl import render


def run(*args, data=None):
    result = subprocess.run(
        args, input=data, check=True, text=True, capture_output=True
    )
    return result.stdout.strip()


def main():
    with tempfile.TemporaryDirectory() as directory:
        acl = Path(directory) / "users.acl"
        passwords = {
            name: secrets.token_hex(32) for name in ("auth", "problem", "submission")
        }
        acl.write_bytes(render(passwords))
        acl.chmod(0o644)
        image = "redis@sha256:dfa18828cbc07b3ae6a95ec7343f6c214fdee2d836197b4be8e9904420762cd8"
        fixture = run(
            "docker",
            "run",
            "--rm",
            "-d",
            "--network",
            "none",
            "-v",
            f"{acl}:/acl:ro",
            image,
            "redis-server",
            "--aclfile",
            "/acl",
        )
        try:

            def cli(user, *arguments):
                return run(
                    "docker",
                    "exec",
                    "-i",
                    fixture,
                    "sh",
                    "-ec",
                    'read -r REDISCLI_AUTH; export REDISCLI_AUTH; exec redis-cli --user "$@"',
                    "fixture",
                    user,
                    *arguments,
                    data=passwords[user] + "\n",
                )

            for _ in range(30):
                try:
                    if cli("auth", "ping") == "PONG":
                        break
                except subprocess.CalledProcessError:
                    time.sleep(0.1)
            assert cli("auth", "set", "auth:logout_all_iat:fixture", "1") == "OK"
            for user in passwords:
                assert cli(user, "get", "auth:logout_all_iat:fixture") == "1"
            assert cli("problem", "set", "problem:submission:v1:1", "value") == "OK"
            assert (
                cli(
                    "submission",
                    "set",
                    "submission:cooldown:x",
                    "1",
                    "NX",
                    "PX",
                    "1000",
                )
                == "OK"
            )
            for user in ("problem", "submission"):
                assert "NOPERM" in cli(user, "set", "auth:logout_all_iat:fixture", "2")
                assert "NOPERM" in cli(user, "get", "token:verify:x")
                assert "NOPERM" in cli(user, "config", "get", "requirepass")
        finally:
            run("docker", "stop", fixture)
    print("PASS isolated Redis credentials, scoped writes and shared revocation reads")


if __name__ == "__main__":
    main()
