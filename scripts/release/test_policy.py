import base64
import copy
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import threading
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from policy import (
    APPLICATIONS,
    CHECKS,
    WORKLOADS,
    Refused,
    canonical,
    digest,
    eligible,
    envelope,
    evidence,
    provenance,
    publication_context,
    publish_once,
    verify_record,
    rehearsal_evidence,
    REQUIRED,
    mapped_release,
)
from transport import Blob
import catalog


def fixture():
    source = "a" * 40
    files = {
        o + "/00001_initial.sql": base64.b64encode(b"SELECT 1;").decode()
        for o in ("auth", "problem", "submission")
    }
    hashes = {n: digest(b"SELECT 1;")[7:] for n in files}
    for owner in ("auth", "problem", "submission"):
        files[owner + ".version"] = base64.b64encode(b"1\n").decode()
        for i in (0, 1):
            files[f"{owner}.{i}.catalog"] = base64.b64encode(
                ("a" * 64 + "\n").encode()
            ).decode()
    configured = {
        "auth-service",
        "problem-service",
        "submission-service",
        "judge-worker",
        "envoy",
    }
    config = {n: {"config.yaml": "fixture"} for n in configured}
    work = {
        n: digest(
            canonical({k: digest(v.encode())[7:] for k, v in config.get(n, {}).items()})
        )
        for n in APPLICATIONS | {"envoy", "migrate"}
    }
    env = dict(
        workloads=work,
        files=config,
        configmaps={n: n + "-config-1111111111" for n in configured},
        digest=digest(canonical(work)),
    )
    return dict(
        kind="canonical",
        source=source,
        ci=dict(
            source=source,
            run="42",
            attempt="1",
            checks=dict.fromkeys(CHECKS, "success"),
            repository="fixture/repo",
            run_url="https://github.com/fixture/repo/actions/runs/42/attempts/1",
        ),
        merge=dict(source=source, pull_request=12, base="develop"),
        configuration_revision=source,
        versions=dict(auth=1, problem=1, submission=1),
        migration_files=hashes,
        migration_package=files,
        environments=dict(s2=env, s3=env),
        images={
            n: "ghcr.io/fixture/" + n + "@" + digest(n.encode()) for n in WORKLOADS
        },
    )


class Store:
    def __init__(self):
        self.rows, self.lock = {}, threading.Lock()

    def create(self, key, value):
        with self.lock:
            if key in self.rows:
                return False
            self.rows[key] = value
            return True

    def read(self, key):
        return self.rows[key]


class Publication(unittest.TestCase):
    def test_premerge_rehearsal_requires_every_exact_head_check(self):
        run = dict(
            head_sha="a" * 40,
            event="pull_request",
            path=".github/workflows/rehearsal-checks.yml",
            conclusion="success",
            repository=dict(full_name="fixture/repo"),
            id=42,
            run_attempt=1,
            html_url="https://github.com/fixture/repo/actions/runs/42",
        )
        jobs = [
            dict(name="verify / " + name, conclusion="success") for name in REQUIRED
        ]
        ci = rehearsal_evidence(run, jobs, "a" * 40, "fixture/repo")
        evidence(ci, "a" * 40, "42", "1")
        for altered in (
            dict(run, head_sha="b" * 40),
            dict(run, conclusion="failure"),
            dict(run, path=".github/workflows/ci.yml"),
        ):
            with self.assertRaises(Refused):
                rehearsal_evidence(altered, jobs, "a" * 40, "fixture/repo")
        with self.assertRaises(Refused):
            rehearsal_evidence(run, jobs[:-1], "a" * 40, "fixture/repo")

    def test_distinct_passing_merges_and_same_revision_retry(self):
        store = Store()
        records = []
        for sha in ("a" * 40, "b" * 40):
            value = fixture()
            value["source"] = value["ci"]["source"] = value["merge"]["source"] = sha
            value["configuration_revision"] = sha
            records.append(envelope(value))
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda r: publish_once(store, r), records * 3))
        self.assertEqual(len(store.rows), 2)
        changed = fixture()
        changed["images"]["website"] = "ghcr.io/fixture/website@" + digest(b"different")
        with self.assertRaises(Refused):
            publish_once(store, envelope(changed))
        self.assertEqual(json.loads(store.read("a" * 40 + ".json")), records[0])

    def test_failed_checks_unapproved_revision_and_legacy_ref(self):
        f = fixture()
        for field, wrong in (("source", "b" * 40), ("run", "other"), ("attempt", "2")):
            bad = copy.deepcopy(f["ci"])
            bad[field] = wrong
            with self.assertRaises(Refused):
                evidence(bad, "a" * 40, "42", "1")
        for outcome in ("failure", "skipped", "cancelled"):
            bad = copy.deepcopy(f["ci"])
            bad["checks"]["images"] = outcome
            with self.assertRaises(Refused):
                evidence(bad, "a" * 40, "42", "1")
        for event, ref in (
            ("push", "refs/tags/v1.0.0"),
            ("pull_request", "refs/heads/develop"),
            ("workflow_dispatch", "refs/heads/feature"),
        ):
            with self.assertRaises(Refused):
                publication_context(event, ref, "canonical")
        prs = [
            dict(
                merged_at="date",
                merge_commit_sha="a" * 40,
                base=dict(ref="develop"),
                number=1,
            )
        ]
        self.assertEqual(provenance("a" * 40, prs, ["a" * 40])["pull_request"], 1)
        for sha, history in (("b" * 40, ["a" * 40]), ("a" * 40, [])):
            with self.assertRaises(Refused):
                provenance(sha, prs, history)

    def test_incomplete_or_mismatched_bundle_has_no_receipt(self):
        for target in (
            "images",
            "migration_package",
            "migration_files",
            "environments",
        ):
            value = fixture()
            value[target].pop(next(iter(value[target])))
            with self.assertRaises((Refused, KeyError)):
                envelope(value)
        record = envelope(fixture())
        record["bundle"] = digest(b"mismatch")
        with self.assertRaises(Refused):
            publish_once(Store(), record)
        value = fixture()
        value["environments"]["s2"]["files"]["auth-service"]["config.yaml"] = "changed"
        with self.assertRaises(Refused):
            envelope(value)

    def test_rehearsal_and_promotion(self):
        value = fixture()
        record = envelope(value)
        staged = dict(
            environment="s2",
            bundle=record["bundle"],
            images=value["images"],
            versions=value["versions"],
            configuration=value["environments"]["s2"]["digest"],
            smoke="passed",
            operation="deployment",
        )
        approval = dict(approved=True, reviewer="reviewer", bundle=record["bundle"])
        mapping = dict(schemaVersion=1, tags={"v1.0.0": record["bundle"]})
        self.assertEqual(mapped_release("v1.0.0", mapping, "a" * 40), record["bundle"])
        for tag in ("develop", "a" * 40, "v2.0.0"):
            with self.assertRaises(Refused):
                mapped_release(tag, mapping, "a" * 40)
        self.assertFalse(eligible(record, staged, approval, False)["deploy"])
        for bad, auth, freeze in (
            (dict(staged, environment="s3"), approval, False),
            (dict(staged, smoke="failed"), approval, False),
            (dict(staged, bundle=digest(b"other")), approval, False),
            (staged, {}, False),
            (staged, approval, True),
        ):
            with self.assertRaises(Refused):
                eligible(record, bad, auth, freeze)
        value["kind"] = "rehearsal"
        rehearsal = envelope(value)
        with self.assertRaises(Refused):
            publish_once(Store(), rehearsal)
        with self.assertRaises(Refused):
            eligible(rehearsal, staged, approval, False)

    def test_conditional_storage_adapter_and_interruption(self):
        blob = Blob("syntheticcatalog", "canonical-releases", lambda: "synthetic")
        with patch("transport.request", return_value=(412, {}, b"")) as http:
            self.assertFalse(blob.create("a" * 40 + ".json", b"{}"))
            self.assertEqual(http.call_args.args[3]["If-None-Match"], "*")
            self.assertEqual(http.call_args.args[3]["x-ms-blob-type"], "BlockBlob")
        store = Store()
        record = envelope(fixture())
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "record.json"
            path.write_bytes(canonical(record))
            args = SimpleNamespace(
                command="publish",
                kind="canonical",
                sha="a" * 40,
                root=Path(tmp),
                file=path,
            )
            with patch.dict(
                "os.environ", GITHUB_EVENT_NAME="push", GITHUB_REF="refs/heads/develop"
            ), patch("catalog.merge", return_value=fixture()["merge"]), patch(
                "catalog.registry"
            ) as registry, patch(
                "catalog.store", return_value=store
            ):
                registry.return_value.publish.side_effect = OSError(
                    "interrupted OCI upload"
                )
                with self.assertRaises(OSError):
                    catalog.main(args)
                self.assertFalse(store.rows)
                registry.return_value.publish.side_effect = None
                catalog.main(args)
                catalog.main(args)
        self.assertEqual(
            verify_record(json.loads(store.read("a" * 40 + ".json")))["source"],
            "a" * 40,
        )

    def test_workflow_credentials_and_entry_points(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / ".github/workflows/publish-canonical.yml").read_text()
        self.assertNotIn("workflow_dispatch", workflow)
        self.assertNotIn("tags:", workflow)
        self.assertIn("publish-canonical-${{ github.sha }}", workflow)
        legacy_publish = (root / ".github/workflows/release-images.yml").read_text()
        self.assertNotIn("workflow_dispatch:", legacy_publish)
        self.assertNotIn("push:", legacy_publish)
        self.assertNotIn("packages: write", legacy_publish)
        legacy = (root / ".github/workflows/deploy-production.yml").read_text()
        self.assertNotIn("workflow_dispatch", legacy)
        self.assertNotIn("secrets.", legacy)
        publish = (root / ".github/workflows/release-candidate.yml").read_text()
        self.assertIn("needs: [context, verify, strict]", publish)
        self.assertIn("if: inputs.kind == 'canonical'", publish)
        self.assertNotIn("STAGING_CLIENT_ID", publish)
        discovery = (root / ".github/workflows/reconcile-releases.yml").read_text()
        self.assertNotIn("inputs:", discovery)
        promotion = (root / ".github/workflows/promotion-eligibility.yml").read_text()
        self.assertNotIn("packages: write", promotion)
        self.assertNotIn("docker", promotion)
        self.assertNotIn("RECEIPT_PUBLISHER", promotion)


if __name__ == "__main__":
    unittest.main()
