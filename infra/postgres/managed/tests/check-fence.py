"""Destructive only inside a fresh, network-isolated PostgreSQL 15.6 fixture."""

import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
import sys
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import uuid


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coordinator import GateError, Session, password_verifier, reconcile


def run(*args, data=None, success=True):
    result = subprocess.run(args, input=data, capture_output=True, text=True)
    if (result.returncode == 0) != success:
        # No input or DSNs in exception messages.
        raise RuntimeError(result.stderr[-1000:])
    return result.stdout.strip()


def main(partial=False):
    root = Path(__file__).resolve().parents[4]
    pg = "postgres:15.6-alpine@sha256:8a8d55343d6fc456cb183453e3094ff140b984157b36b48f817dd581654f2aec"
    owners = ["auth", "problem", "submission"]
    with tempfile.TemporaryDirectory() as temp, contextlib.ExitStack() as stack:
        credentials = Path(temp) / "attempt"
        credentials.mkdir()
        attempt = str(uuid.uuid4())
        (credentials / "operation").write_text(attempt)
        for owner in owners:
            (credentials / owner).write_text(secrets.token_hex(32))
        bootstrap_secret = Path(temp) / "bootstrap-only"
        bootstrap_secret.write_text(secrets.token_hex(32))
        bootstrap_secret.chmod(
            0o644
        )  # private temporary fixture permits the PostgreSQL container UID to read it
        container = run(
            "docker",
            "run",
            "-d",
            "--rm",
            "--network=none",
            "--tmpfs",
            "/var/lib/postgresql/data",
            "--add-host",
            "postgres.astracode-app.svc:127.0.0.1",
            "-e",
            "POSTGRES_PASSWORD_FILE=/fixture-bootstrap-only",
            "-v",
            f"{bootstrap_secret}:/fixture-bootstrap-only:ro",
            "-v",
            f"{root}/infra/postgres/managed:/managed:ro",
            "-v",
            f"{credentials}:/run/astra/db:ro",
            pg,
        )
        stack.callback(run, "docker", "stop", container)
        base = ["docker", "exec", "-i", container]
        for _ in range(100):
            if (
                subprocess.run(
                    [*base, "pg_isready", "-h", "127.0.0.1"], capture_output=True
                ).returncode
                == 0
            ):
                break
            time.sleep(0.15)
        donor = run("docker", "create", "astra-m013-migrator:offline")
        try:
            for path in [
                "/usr/local/bin/goose",
                "/usr/local/bin/astra-migrate",
                "/migrations",
            ]:
                run("docker", "cp", donor + ":" + path, temp)
                run(
                    "docker",
                    "cp",
                    str(Path(temp) / Path(path).name),
                    container + ":" + path,
                )
        finally:
            run("docker", "rm", donor)

        def sql(db, statement, *, who="postgres", success=True):
            return run(
                *base,
                "psql",
                "-XqAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                who,
                "-d",
                db,
                data=statement,
                success=success,
            )

        instance = sql("postgres", "SELECT system_identifier FROM pg_control_system()")
        bootstrap = [
            *base,
            "psql",
            "-XqAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-f",
            "/managed/bootstrap.sql",
        ]
        run(*bootstrap, "-v", "expected_system_id=0", success=False)
        for _ in range(2):
            run(*bootstrap, "-v", "expected_system_id=" + instance)
        fence_password = secrets.token_hex(32)
        fence_script = (
            "\\set verifier '" + password_verifier(fence_password)
            + "'\n\\i /managed/fencer-login.sql\n"
        )
        for target, success in (("0", False), (instance, True), (instance, True)):
            run(*base, "psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres",
                "-v", "expected_system_id=" + target, data=fence_script, success=success)

        def check_empty(owner):
            db = owner + "_db"
            assert sql(db, "SELECT count(*) FROM astra_control.migration_fence") == "0"
            assert (
                sql(db, "SELECT to_regclass('public.goose_db_version') IS NULL") == "t"
            )

        for owner in owners:
            check_empty(owner)

        def hold(owner, attempt):
            db = owner + "_db"
            password = password_verifier((credentials / owner).read_text())
            process = subprocess.Popen(
                [
                    *base,
                    "psql",
                    "-XqAt",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-U",
                    "postgres",
                    "-d",
                    db,
                ],
                text=True,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
            )
            stack.callback(process.wait, 10)
            stack.callback(process.stdin.close)
            process.stdin.write(
                "SELECT pg_advisory_lock(17421,1);\n"
                f"SELECT astra_control.prepare('{attempt}',now()+interval '5 min','{password}');\n"
            )
            process.stdin.flush()
            process.stdout.readline()
            writer = process.stdout.readline().strip()
            assert writer == f"{owner}_m_{attempt.replace('-', '')}"
            assert sql(db, "SELECT pg_try_advisory_lock(17421,1)") == "f"
            return process, writer

        def seal(owner, attempt, *, finish):
            db = owner + "_db"
            sql(db, f"SELECT astra_control.seal('{attempt}')")
            if finish:
                sql(db, f"SELECT astra_control.finish('{attempt}')")

        # Lose the preflight/backend session in the interval after DDL but before commit.
        op = str(uuid.uuid4())
        proc, writer = hold("auth", op)
        sql("auth_db", f"SELECT astra_control.claim('{op}')", who=writer)
        ddl = subprocess.Popen(
            [
                *base,
                "psql",
                "-XqAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                writer,
                "-d",
                "auth_db",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        ddl.stdin.write(
            "SET ROLE auth_owner; BEGIN; CREATE TABLE public.fence_fixture(i int); SELECT 'opened';\n"
        )
        ddl.stdin.flush()
        assert ddl.stdout.readline().strip() == "opened"
        proc.stdin.write("\\q\n")
        proc.stdin.flush()
        assert proc.wait(10) == 0
        ddl.stdin.write("COMMIT;\n")
        ddl.stdin.flush()
        assert ddl.wait(10) != 0 and "writer fence lost" in ddl.stderr.read()
        assert (
            sql("auth_db", "SELECT to_regclass('public.fence_fixture') IS NULL") == "t"
        )
        sql(
            "auth_db",
            "SET ROLE auth_owner; CREATE TABLE public.blocked(i int)",
            who=writer,
            success=False,
        )
        assert (
            sql("auth_db", "SELECT count(*) FROM astra_control.migration_fence") == "1"
        )
        seal("auth", op, finish=True)

        class FixtureSession(Session):
            def __init__(self, owner):
                self.owner = owner
                self.child = subprocess.Popen(
                    [
                        *base,
                        "psql",
                        "-XqAt",
                        "-v",
                        "ON_ERROR_STOP=1",
                        "-U",
                        "astra_fence_service",
                        "-d",
                        owner + "_db",
                    ],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    text=True,
                )

        package = Path(temp) / "migrations"
        versions = dict.fromkeys(owners, 1)
        op = dict(
            id=str(uuid.uuid4()),
            deadline=(datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
            recovery_point="disposable-fixture",
            system_id=instance,
            migration_files={
                str(p.relative_to(package)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in package.glob("*/*.sql")
            },
            rollback_versions=versions,
            target_versions=versions,
            action="rollback",
        )
        if partial:

            def interrupt(attempt, passwords, renew):
                renew()
                writer = "auth_m_" + attempt.replace("-", "")
                sql("auth_db", f"SELECT astra_control.claim('{attempt}')", who=writer)
                run(
                    *base,
                    "env",
                    "PGUSER=" + writer,
                    "PGOPTIONS=-c role=auth_owner",
                    "goose",
                    "-dir",
                    "/migrations/auth",
                    "postgres",
                    "dbname=auth_db",
                    "up-to",
                    "1",
                )
                raise GateError("fixture interrupted after first owner")

            live_lease = lambda: datetime.now(timezone.utc) + timedelta(seconds=20)
            live = dict(op, action="deploy")
            try:
                reconcile(live, package, interrupt, live_lease, session=FixtureSession)
            except GateError as e:
                assert "interrupted after first owner" in str(e)
            else:
                raise AssertionError("interrupted rollout succeeded")
            for owner in owners:
                assert (
                    sql(
                        owner + "_db",
                        "SELECT count(*) FROM astra_control.migration_fence",
                    )
                    == "1"
                )
            assert (
                sql("auth_db", "SELECT max(version_id) FROM public.goose_db_version")
                == "1"
            )
            assert (
                sql(
                    "problem_db",
                    "SELECT to_regclass('public.goose_db_version') IS NULL",
                )
                == "t"
            )
            try:
                reconcile(live, package, interrupt, live_lease, session=FixtureSession)
            except GateError as e:
                assert "marker" in str(e)
            else:
                raise AssertionError("stale marker admitted another writer")
            recovery = dict(
                live,
                id=str(uuid.uuid4()),
                action="recover",
                reconcile_attempt=live["id"],
                observed_versions={"auth": 1, "problem": 0, "submission": 0},
            )
            erased = []
            for candidate in (
                recovery,
                dict(
                    recovery, prior_job_exit_verified=True, observed_versions=versions
                ),
            ):
                try:
                    reconcile(
                        candidate,
                        package,
                        interrupt,
                        live_lease,
                        session=FixtureSession,
                        erase_attempt=erased.append,
                    )
                except GateError:
                    pass
                else:
                    raise AssertionError("unverified recovery was accepted")
                assert erased == []
                for owner in owners:
                    assert (
                        sql(
                            owner + "_db",
                            "SELECT count(*) FROM astra_control.migration_fence",
                        )
                        == "1"
                    )
            try:
                reconcile(
                    dict(recovery, prior_job_exit_verified=True),
                    package,
                    interrupt,
                    live_lease,
                    session=FixtureSession,
                    erase_attempt=erased.append,
                )
            except GateError as e:
                assert "separate forward deployment" in str(e)
            else:
                raise AssertionError("partial database state admitted activation")
            assert erased == [live["id"]]
            for owner in owners:
                assert (
                    sql(
                        owner + "_db",
                        "SELECT count(*) FROM astra_control.migration_fence",
                    )
                    == "0"
                )
            print(
                "PASS partial histories, retained fences, stale takeover denial and approved writer reconciliation"
            )
            return
        holds = [hold(owner, attempt) for owner in owners]
        for owner, (conn, _) in zip(owners, holds):
            for path in (package / owner).glob("*.sql"):
                value = hashlib.sha256(path.read_bytes()).hexdigest()
                conn.stdin.write(
                    f"SELECT astra_control.record_file('{attempt}','{path.name}','{value}');\n"
                )
                conn.stdin.flush()
                assert conn.stdout.readline().strip() == ""
        run(*base, "/usr/local/bin/astra-migrate")
        run(*base, "/usr/local/bin/astra-migrate", success=False)
        tables = ["users", "problems", "submissions"]
        for owner, table in zip(owners, tables):
            db = owner + "_db"
            history = (
                "SELECT version_id,is_applied FROM public.goose_db_version ORDER BY id"
            )
            assert sql(db, history) == "0|t\n1|t"
            seal(owner, attempt, finish=True)
            sql(db, "SELECT astra_control.allow_runtime()")
            proc = holds[owners.index(owner)][0]
            proc.stdin.write("\\q\n")
            proc.stdin.flush()
            assert proc.wait(10) == 0
            user = owner + "_service"
            runtime_password = secrets.token_hex(32)
            for _ in range(2):
                run(
                    *base,
                    "psql",
                    "-XqAt",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-U",
                    "postgres",
                    "-d",
                    db,
                    "-v",
                    "owner=" + owner,
                    "-v",
                    "expected_system_id=" + instance,
                    data="\\set verifier '"
                    + password_verifier(runtime_password)
                    + "'\n\\i /managed/runtime-login.sql\n",
                )
            assert (
                run(
                    *base,
                    "sh",
                    "-ec",
                    'read -r PGPASSWORD; export PGPASSWORD; exec psql -XqAt -h 127.0.0.1 -U "$1" -d "$2" -c "SELECT current_user"',
                    "fixture",
                    user,
                    db,
                    data=runtime_password + "\n",
                )
                == user
            )
            sql(db, f"SELECT 1 FROM public.{table} LIMIT 1", who=user)
            assert sql(db, history, who=user) == "0|t\n1|t"
            sql(
                db,
                "UPDATE public.goose_db_version SET is_applied=false",
                who=user,
                success=False,
            )
            sql(db, "CREATE TABLE public.denied(i int)", who=user, success=False)
            sql(
                owners[(owners.index(owner) + 1) % 3] + "_db",
                "SELECT 1",
                who=user,
                success=False,
            )

        # Use a least-privilege fencer for the host coordinator and the exact
        # prefix fingerprints built into the managed image.
        def forbidden(*args):
            raise AssertionError("Compatible rollback tried to run Goose")

        assert (
            reconcile(op, package, forbidden, lambda: None, session=FixtureSession)
            == versions
        )

        def denied(candidate):
            try:
                reconcile(
                    candidate, package, forbidden, lambda: None, session=FixtureSession
                )
            except GateError:
                return
            raise AssertionError("invalid schema case accepted")

        denied(dict(op, rollback_versions=dict(versions, auth=0)))
        sql("auth_db", "ALTER TABLE public.users ADD COLUMN unexpected text")
        denied(op)
        sql("auth_db", "ALTER TABLE public.users DROP COLUMN unexpected")
        print(
            "PASS target binding, repeat bootstrap, lock contention, deferred commit refusal, durable marker, "
            "three Goose histories, consumed-attempt refusal, runtime isolation, compatible rollback, drift and version mismatch"
        )


if __name__ == "__main__":
    main()
    main(partial=True)
