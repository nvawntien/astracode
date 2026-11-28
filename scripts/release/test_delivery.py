import json
import subprocess
import unittest
from unittest.mock import patch

from delivery import dispatch, operation, target
from policy import Refused
from promotion import check_run, review


class Delivery(unittest.TestCase):
    def setUp(self):
        self.bundle = "sha256:" + "1" * 64
        self.source = "a" * 40
        self.request = dict(
            slot="s3",
            action="deploy",
            source=self.source,
            digest=self.bundle,
            fallback_source=self.source,
            fallback=self.bundle,
        )
        self.sub = "00000000-0000-4000-8000-000000000003"
        self.receipt = dict(
            environment="s3",
            source=self.source,
            bundle=self.bundle,
            run="42",
            smoke="passed",
            operation="protected",
        )
        self.run = dict(
            repository={"full_name": "org/project"},
            path=".github/workflows/staging-deploy.yml",
            head_branch="main",
            event="workflow_dispatch",
            run_attempt=1,
            conclusion="success",
            actor={"id": 41},
        )

    def command_result(self):
        return json.dumps(
            {
                "value": [
                    {
                        "level": "Info",
                        "message": "Enable succeeded: \n[stdout]\nASTRA_DELIVERY="
                        + json.dumps(self.receipt),
                    }
                ]
            }
        )

    def test_exact_approved_request_runs_only_the_fixed_app_command(self):
        with patch.object(
            subprocess, "check_output", return_value=self.command_result()
        ) as execute:
            self.assertEqual(dispatch(self.request, "42", "1", self.sub), self.receipt)
        argv = execute.call_args.args[0]
        self.assertEqual(
            argv[:6],
            ["az", "vm", "run-command", "invoke", "--ids", target("s3", self.sub)],
        )
        self.assertNotIn("start", argv)
        self.assertIn(
            "/usr/local/libexec/astra/app/host_services.py delivery submit", argv[9]
        )

    def test_rerun_injected_fields_and_changed_result_refused(self):
        with self.assertRaises(Refused):
            dispatch(self.request, "42", "2", self.sub)
        with self.assertRaises(Refused):
            operation(dict(self.request, vm="judge"))
        with self.assertRaises(Refused):
            operation(dict(self.request, digest="$(echo changed)"))
        with (
            patch.object(
                subprocess, "check_output", return_value=self.command_result()
            ),
            self.assertRaises(Refused),
        ):
            dispatch(dict(self.request, slot="s2"), "42", "1", self.sub)

    def test_only_protected_successful_s2_receipt_with_native_review_can_promote(self):
        check_run(self.run, "org/project", "staging-deploy.yml", True)
        approved = dict(
            environments=[dict(name="s2-delivery")], state="approved", user=dict(id=21)
        )
        self.assertEqual(review(self.run, [approved], "s2-delivery", {"21"}), "21")
        for row in (
            dict(approved, user={"id": 41}),
            dict(approved, state="rejected"),
            dict(approved, environments=[dict(name="s3-delivery")]),
        ):
            with self.assertRaises(Refused):
                review(self.run, [row], "s2-delivery", {"21", "41"})
        for change in (
            {"head_branch": "develop"},
            {"run_attempt": 2},
            {"conclusion": "cancelled"},
        ):
            with self.assertRaises(Refused):
                check_run(
                    dict(self.run, **change), "org/project", "staging-deploy.yml", True
                )


if __name__ == "__main__":
    unittest.main()
