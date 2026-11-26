"""Exercise the installed probe against a disposable, internally networked broker."""

from contextlib import ExitStack
import ipaddress
import json
from pathlib import Path
import subprocess
import sys
import time


def run(*args, data=None):
    return (
        subprocess.check_output(args, input=data, stderr=subprocess.PIPE)
        .decode()
        .strip()
    )


def main(probe):
    root = Path(__file__).resolve().parents[3]
    image = "bitnamilegacy/kafka@sha256:aa0b2aee8c5610dd1d18d48b4f1df0dbe3267b5d4c338d36c9af9cbf0529c0b0"
    with ExitStack() as cleanup:
        import uuid

        network = run(
            "docker",
            "network",
            "create",
            "--internal",
            "m013-kafka-" + uuid.uuid4().hex[:12],
        )
        cleanup.callback(run, "docker", "network", "rm", network)
        subnet = json.loads(run("docker", "network", "inspect", network))[0]["IPAM"][
            "Config"
        ][0]["Subnet"]
        address = str(ipaddress.ip_network(subnet)[2])
        env = dict(
            KAFKA_CFG_NODE_ID="1",
            KAFKA_CFG_PROCESS_ROLES="controller,broker",
            KAFKA_CFG_CONTROLLER_QUORUM_VOTERS="1@localhost:9093",
            KAFKA_CFG_LISTENERS="INTERNAL://:9092,CONTROLLER://:9093",
            KAFKA_CFG_ADVERTISED_LISTENERS=f"INTERNAL://{address}:9092",
            KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP="INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT",
            KAFKA_CFG_CONTROLLER_LISTENER_NAMES="CONTROLLER",
            KAFKA_CFG_INTER_BROKER_LISTENER_NAME="INTERNAL",
            KAFKA_CFG_OFFSETS_TOPIC_REPLICATION_FACTOR="1",
            KAFKA_CFG_AUTO_CREATE_TOPICS_ENABLE="false",
            KAFKA_HEAP_OPTS="-Xms256m -Xmx512m",
            KAFKA_KRAFT_CLUSTER_ID="abcdefghijklmnopqrstuv",
        )
        args = [x for k, v in env.items() for x in ("-e", k + "=" + v)]
        cid = run(
            "docker",
            "run",
            "-d",
            "--rm",
            "--network",
            network,
            "--ip",
            address,
            "--memory",
            "1g",
            "--cpus",
            "2",
            *args,
            image,
        )
        cleanup.callback(run, "docker", "stop", cid)
        command = ["docker", "exec", "-i", cid]
        endpoint = address + ":9092"
        run(
            *command,
            "env",
            "KAFKA_BOOTSTRAP_SERVER=" + endpoint,
            "bash",
            "-s",
            data=(root / "infra/kafka/kafka-init.sh").read_bytes(),
        )

        def check(group, success):
            result = subprocess.run(
                [probe, "kafka-empty", endpoint, group, "judge.submission.jobs"],
                capture_output=True,
                timeout=15,
            )
            if (result.returncode == 0) != success:
                raise AssertionError(
                    "unexpected Kafka group admission: " + result.stderr.decode()
                )

        check("fixture-unseen", True)
        baseline = subprocess.check_output(
            [probe, "retained-work", endpoint], timeout=20
        )
        assert json.loads(baseline) == dict(jobs=0, results=0, dlt=0)
        consumer = subprocess.Popen(
            [
                *command,
                "/opt/bitnami/kafka/bin/kafka-console-consumer.sh",
                "--bootstrap-server",
                endpoint,
                "--topic",
                "judge.submission.jobs",
                "--group",
                "judge-worker-v1",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        cleanup.callback(consumer.kill)
        for _ in range(30):
            description = run(
                *command,
                "/opt/bitnami/kafka/bin/kafka-consumer-groups.sh",
                "--bootstrap-server",
                endpoint,
                "--describe",
                "--group",
                "judge-worker-v1",
                "--state",
            )
            if "Stable" in description:
                break
            time.sleep(1)
        else:
            raise AssertionError("fixture consumer failed to join")
        check("judge-worker-v1", False)
        active = subprocess.run(
            [probe, "retained-work", endpoint], capture_output=True, timeout=20
        )
        assert active.returncode != 0
        consumer.terminate()
        consumer.wait(5)
        # The Docker exec process may stop before the broker's group session
        # expires. Use a separate group-free broker sample below.

        run(
            *command,
            "/opt/bitnami/kafka/bin/kafka-console-producer.sh",
            "--bootstrap-server",
            endpoint,
            "--topic",
            "judge.submission.jobs",
            data=b"synthetic-fixture-record\n",
        )
        check("fixture-unseen", False)
        print(
            "PASS actual Kafka: fresh empty topic accepted, active consumer and unverified retained work refused"
        )


if __name__ == "__main__":
    main(sys.argv[1])
