"""Native Job lifecycle fixture; run only on the disposable m013-fixture K3s VM."""

import copy
import json
from pathlib import Path
import subprocess
import time

from kube_rollout import Cluster
from migration_job import MigrationJob


def main():
    nodes = json.loads(
        subprocess.check_output(["k3s", "kubectl", "get", "nodes", "-o", "json"])
    )["items"]
    assert [n["metadata"]["name"] for n in nodes] == ["m013-fixture"]
    client = Cluster("app", Path("/etc/rancher/k3s/k3s.yaml"))
    assert client.call("get", "job/migrate", "--ignore-not-found") is None
    reference = client.call("get", "podtemplate/approved-migrate")
    pins = {c["name"]: c["image"] for c in reference["template"]["spec"]["containers"]}
    client.prepare_template("migrate", pins, True)
    adapter = MigrationJob(
        client,
        None,
        None,
        None,
        lambda: client.call("get", "podtemplate/approved-migrate")["template"],
        lambda _: False,
        None,
    )
    try:
        first = adapter.prepare(lambda: None)
        assert first["spec"]["suspend"] is True
        second = adapter.prepare(lambda: None)
        assert second["metadata"]["uid"] != first["metadata"]["uid"]
        stale = copy.deepcopy(second)
        stale["metadata"]["uid"] = first["metadata"]["uid"]
        try:
            client.retire_migration(stale)
        except subprocess.CalledProcessError:
            pass
        else:
            raise AssertionError("stale delete UID accepted")
        assert (
            client.call("get", "job/migrate")["metadata"]["uid"]
            == second["metadata"]["uid"]
        )
        assert not client.call("get", "pods", "-l", "job-name=migrate")["items"]
        print(
            "PASS native suspended Job recreation, immutable identity and stale UID deletion denial"
        )
    finally:
        current = client.call("get", "job/migrate", "--ignore-not-found")
        if current:
            client.retire_migration(current)
        for _ in range(30):
            if client.call("get", "job/migrate", "--ignore-not-found") is None:
                break
            time.sleep(0.25)
        client.prepare_template("migrate", pins, False)


if __name__ == "__main__":
    main()
