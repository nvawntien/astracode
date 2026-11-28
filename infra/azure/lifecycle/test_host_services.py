import base64
import json
from pathlib import Path
import tempfile
import unittest

from authority import Authority
from configuration import FILES, content_digest, mounted_config
from kube_rollout import APP, EXECUTION, configured_volumes
from node_state import RecoveryRequired
from release_catalog import ARTIFACT, WORKLOADS, Catalog, digest
from runtime_secrets import KEYS, generate


class Host(unittest.TestCase):
    def test_mounted_public_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "pod" / "volumes" / "kubernetes.io~configmap" / "config"
            root.mkdir(parents=True)
            actual = root / "..epoch"
            actual.mkdir()
            (actual / "config.yaml").write_bytes(b"approved")
            (root / "config.yaml").symlink_to(actual / "config.yaml")
            mounts = [
                dict(hostPath=str(root), containerPath="/app/config", readonly=True)
            ]
            self.assertEqual(
                mounted_config("judge-worker", "pod", mounts),
                content_digest({"config.yaml": digest(b"approved")[7:]}),
            )
            with self.assertRaises(ValueError):
                mounted_config("judge-worker", "different", mounts)
            spec = {
                "volumes": [
                    {
                        "name": "config",
                        "configMap": {"name": "judge-worker-config-1111111111"},
                    }
                ]
            }
            selected = {"judge-worker": "judge-worker-config-2222222222"}
            self.assertEqual(
                configured_volumes("judge-worker", spec, selected)[0]["configMap"][
                    "name"
                ],
                selected["judge-worker"],
            )
            with self.assertRaises(RecoveryRequired):
                configured_volumes(
                    "judge-worker",
                    spec,
                    {"judge-worker": "another-service-config-2222222222"},
                )

    def test_release_envelope(self):
        image = digest(b"binary")
        config = dict.fromkeys([*APP, *EXECUTION, "migrate"], content_digest({}))
        payload = dict(
            kind="rehearsal",
            source="a" * 40,
            images={n: "test.invalid/astra/" + n + "@" + image for n in WORKLOADS},
            versions=dict(auth=1, problem=1, submission=1),
            environments={
                "s3": dict(
                    workloads=config,
                    digest=content_digest(config),
                    configmaps={n: n + "-config-1111111111" for n in FILES},
                )
            },
        )

        def package():
            raw = json.dumps(payload).encode()
            manifest = json.dumps(
                dict(
                    schemaVersion=2,
                    artifactType=ARTIFACT,
                    layers=[
                        {"size": len(raw), "digest": digest(raw), "mediaType": ARTIFACT}
                    ],
                )
            ).encode()
            return digest(manifest), dict(
                origin="rehearsal",
                manifest=base64.b64encode(manifest).decode(),
                payload=base64.b64encode(raw).decode(),
            )

        sha, record = package()

        class Controller:
            operation = "fixture"

            def call(self, *_, **kwargs):
                return record

        self.assertEqual(
            Catalog(Controller(), image).verified_bundle(sha, "s3")["source"],
            payload["source"],
        )
        for slot, pin in (("s2", image), ("s3", digest(b"another"))):
            with self.assertRaises(RecoveryRequired):
                Catalog(Controller(), pin).verified_bundle(sha, slot)
        payload["versions"]["auth"] = 2
        record["payload"] = package()[1]["payload"]
        with self.assertRaises(RecoveryRequired):
            Catalog(Controller(), image).verified_bundle(sha, "s3")

    def test_secret_destinations(self):
        values = {
            name: {key: digest((name + key).encode())[7:] for key in fields}
            for name, fields in KEYS.items()
        }
        delivered = generate(values)
        self.assertNotIn("JWT_ACCESS_SECRET", delivered["submission-service-runtime"])
        self.assertEqual(set(delivered["redis-runtime"]), {"users.acl"})
        self.assertNotIn(
            values["problem-service-runtime"]["REDIS_PASSWORD"],
            delivered["redis-runtime"]["users.acl"],
        )
        values["problem-service-runtime"]["DATABASE_PASSWORD"] = values[
            "auth-service-runtime"
        ]["DATABASE_PASSWORD"]
        with self.assertRaises(ValueError):
            generate(values)

    def test_exit_on_attested_node(self):
        row = dict(
            uid="pod", container="cid", workload="submission-service", image="current"
        )
        view = dict(epoch="a", containers=[row], exited=[])

        class App:
            def observation(self):
                return view

        a = object.__new__(Authority)
        a.clients = {"app": App()}
        prior = a.prior_submission("pod")
        self.assertFalse(a.submission_stopped(prior))
        view.update(containers=[], exited=[])
        self.assertFalse(a.submission_stopped(prior))
        view["exited"].append(dict(row, finished_at=123))
        self.assertTrue(a.submission_stopped(prior))
        view["epoch"] = "b"
        with self.assertRaises(RecoveryRequired):
            a.submission_stopped(prior)


if __name__ == "__main__":
    unittest.main()
