"""App-host PostgreSQL gate for a verified release. Each lock uses a dedicated session."""

import base64
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
from pathlib import Path
import re
import secrets
import subprocess
import uuid


OWNERS = ("auth", "problem", "submission")
CATALOG = Path(__file__).with_name("catalog.sql").read_text()


class GateError(RuntimeError):
    pass


def password_verifier(password):
    # Run-specific passwords are random ASCII. Send only the verifier to SQL.
    encode = lambda value: base64.b64encode(value).decode("ascii")
    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode("ascii"), salt, 4096)
    stored = hashlib.sha256(hmac.digest(salted, b"Client Key", "sha256")).digest()
    server = hmac.digest(salted, b"Server Key", "sha256")
    return f"SCRAM-SHA-256$4096:{encode(salt)}${encode(stored)}:{encode(server)}"


class Session:
    def __init__(self, owner):
        # libpq service definitions are installed by the protected secret loader.
        self.child = subprocess.Popen(
            ["psql", "-XqAt", "-v", "ON_ERROR_STOP=1", f"service=astra_fence_{owner}"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self.owner = owner

    def close(self):
        self.child.stdin.close()
        try:
            self.child.wait(3)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait()
        self.child.stdout.close()

    def query(self, query):
        terminator = secrets.token_hex(20)
        self.child.stdin.write(
            query.rstrip().rstrip(";") + ";\n\\echo " + terminator + "\n"
        )
        self.child.stdin.flush()
        rows = []
        for line in self.child.stdout:
            if line.rstrip() == terminator:
                return "\n".join(rows)
            rows.append(line.rstrip())
        raise GateError(f"{self.owner} control session failed")

    def preflight(self, cluster, prior=None):
        result = self.query(
            """SET statement_timeout='15s'; SET lock_timeout='3s';
            SELECT json_build_array(current_database(),astra_control.target_id(),
                pg_has_role(current_user,'astra_fencer','MEMBER'),
                pg_try_advisory_lock(17421,1),
                (SELECT operation::text FROM astra_control.migration_fence))"""
        )
        database, target, authorized, acquired, marker = json.loads(result)
        if [database, target, authorized, acquired] != [
            self.owner + "_db",
            cluster,
            True,
            True,
        ] or (marker is not None and marker != prior):
            raise GateError(
                f"{self.owner} target, authority, lock or operation marker mismatch"
            )
        return marker

    def verify_files(self, files, applied):
        rows = json.loads(
            self.query(
                "SELECT coalesce(json_object_agg(filename,sha256),'{}'::json) "
                "FROM astra_control.migration_files"
            )
        )
        if any(files.get(name) != value for name, value in rows.items()) or any(
            name not in rows for name in sorted(files)[:applied]
        ):
            raise GateError(
                f"{self.owner} release differs from recorded migration files"
            )

    def inspect(self, prefixes):
        ledger = json.loads(self.query("SELECT astra_control.history()"))
        version = len(ledger) - 1 if ledger else 0
        expected = [[i, True] for i in range(version + 1)] if ledger else []
        if (
            ledger != expected
            or (ledger and version == 0)
            or str(version) not in prefixes
        ):
            raise GateError(f"{self.owner} unexpected migration history")
        if self.query(CATALOG) != prefixes[str(version)]:
            raise GateError(f"{self.owner} schema drift at version {version}")
        expected_owner = self.owner + "_owner"
        if (
            self.query(
                f"""SELECT NOT EXISTS (SELECT FROM pg_class WHERE relnamespace='public'::regnamespace
                           AND pg_get_userbyid(relowner)<>'{expected_owner}')"""
            )
            != "t"
        ):
            raise GateError(f"{self.owner} has unexpected object owner")
        return version


def inspect_package(root, expected_files):
    """root is the verified immutable migration image's extracted /migrations."""
    result = {}
    for owner in OWNERS:
        target = int((root / (owner + ".version")).read_text())
        if target < 1:
            raise GateError("empty migration package")
        files = sorted((root / owner).glob("*.sql"))
        if len(files) != target:
            raise GateError("migration sequence differs from its target")
        for i, file in enumerate(files, 1):
            name = owner + "/" + file.name
            if not re.fullmatch(f"{i:05d}_[a-z0-9_]+[.]sql", file.name):
                raise GateError("unexpected migration name or sequence")
            if hashlib.sha256(file.read_bytes()).hexdigest() != expected_files.get(
                name
            ):
                raise GateError("migration file differs from approved bundle")
        prefixes = {
            str(i): (root / f"{owner}.{i}.catalog").read_text().strip()
            for i in range(target + 1)
        }
        if not all(re.fullmatch("[0-9a-f]{64}", value) for value in prefixes.values()):
            raise GateError("invalid packaged catalog fingerprint")
        result[owner] = prefixes
    if set(expected_files) != {
        str(path.relative_to(root))
        for owner in OWNERS
        for path in (root / owner).glob("*.sql")
    }:
        raise GateError("incomplete or extra migration hashes")
    return result


def reconcile(
    operation, package, run_job, assert_lease, *, session=Session, erase_attempt=None
):
    """run_job binds the one-use passwords to the guarded Job and waits for every child to exit.
    assert_lease revalidates the authorized operation, node epochs and deadline.
    Recovery of a retained marker is a separate protected action.
    """
    attempt = str(uuid.UUID(operation["id"]))
    deadline = datetime.fromisoformat(operation["deadline"])
    if deadline.tzinfo is None or not (
        0 < (deadline - datetime.now(timezone.utc)).total_seconds() <= 600
    ):
        raise GateError("missing or expired operation deadline")
    if not operation.get("recovery_point") or not re.fullmatch(
        "[0-9]+", operation["system_id"]
    ):
        raise GateError("missing target or reviewed recovery point")
    prefixes = inspect_package(Path(package), operation["migration_files"])
    targets = {owner: len(prefixes[owner]) - 1 for owner in OWNERS}
    if (
        operation["rollback_versions"] != targets
        or operation["target_versions"] != targets
    ):
        raise GateError("release or verified rollback schema mismatch")
    with ExitStack() as cleanup:
        sessions = {}
        before = {}
        markers = {}
        recovery = operation.get("reconcile_attempt")
        if recovery is not None:
            recovery = str(uuid.UUID(recovery))
            if (
                operation["action"] != "recover"
                or recovery == attempt
                or not operation.get("prior_job_exit_verified")
            ):
                raise GateError(
                    "separate recovery approval and confirmed old Job termination required"
                )
        by_owner = {
            owner: {
                name.split("/")[1]: value
                for name, value in operation["migration_files"].items()
                if name.startswith(owner + "/")
            }
            for owner in OWNERS
        }
        for owner in OWNERS:
            assert_lease()
            conn = session(owner)
            cleanup.callback(conn.close)
            markers[owner] = conn.preflight(operation["system_id"], recovery)
            sessions[owner] = conn
            before[owner] = conn.inspect(prefixes[owner])
            conn.verify_files(by_owner[owner], before[owner])
        if recovery:
            # A protected recovery names the interrupted operation and the
            # expected live prefixes. Check all owners before clearing any.
            if before != operation.get("observed_versions"):
                raise GateError("observed histories differ from the recovery approval")
            for owner, marker in markers.items():
                if marker:
                    assert_lease()
                    sessions[owner].query(f"SELECT astra_control.seal('{marker}')")
            for owner, marker in markers.items():
                if marker:
                    assert_lease()
                    sessions[owner].query(f"SELECT astra_control.finish('{marker}')")
            # Only clear retained credentials after every owner is fenced and
            # its marker reconciled. The loader conditionally clears this exact
            # attempt, so an old recovery cannot erase a newer Job's Secret.
            assert_lease()
            if erase_attempt is not None:
                erase_attempt(recovery)
            if before != targets:
                raise GateError(
                    "writers reconciled; separate forward deployment required"
                )
            for conn in sessions.values():
                assert_lease()
                conn.query("SELECT astra_control.allow_runtime()")
        if before == targets:
            return before
        if operation["action"] != "deploy":
            raise GateError("rollback or restart would require schema changes")
        passwords = {}
        prepared = []
        try:
            for owner, conn in sessions.items():
                assert_lease()
                passwords[owner] = secrets.token_hex(32)
                conn.query(
                    f"SELECT astra_control.prepare('{attempt}','{deadline.isoformat()}','{password_verifier(passwords[owner])}')"
                )
                prepared.append(conn)
                for name, value in by_owner[owner].items():
                    conn.query(
                        f"SELECT astra_control.record_file('{attempt}','{name}','{value}')"
                    )

            def renew():
                lease_expires = assert_lease()
                now = datetime.now(timezone.utc)
                if lease_expires is None or lease_expires <= now:
                    raise GateError("protected operation lease expired")
                until = min(lease_expires, deadline, now + timedelta(seconds=15))
                for conn in prepared:
                    conn.query(
                        f"SELECT astra_control.renew('{attempt}','{until.isoformat()}')"
                    )

            renew()
            run_job(attempt, passwords, renew)
            for conn in prepared:
                conn.query(f"SELECT astra_control.seal('{attempt}')")
            for owner, conn in sessions.items():
                assert_lease()
                if conn.inspect(prefixes[owner]) != targets[owner]:
                    raise GateError(f"{owner} failed the post-migration verification")
            for conn in prepared:
                assert_lease()
                conn.query(
                    f"BEGIN; SELECT astra_control.allow_runtime(); SELECT astra_control.finish('{attempt}'); COMMIT"
                )
        except BaseException:
            # Retain each durable marker on uncertainty. Sealing is idempotent.
            # The DB-side holder check and deadline also survive loss of this process.
            for conn in prepared:
                try:
                    conn.query(f"SELECT astra_control.seal('{attempt}')")
                except (GateError, OSError):
                    pass
            raise
        finally:
            passwords.clear()
        return targets
