import json
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from approval_client import proof
from policy import Refused, canonical, digest


class Proof(unittest.TestCase):
    def test_review_and_digest_binding(self):
        env = dict(
            GITHUB_REF="refs/heads/main",
            GITHUB_EVENT_NAME="workflow_dispatch",
            GITHUB_RUN_ATTEMPT="1",
            GITHUB_RUN_ID="42",
            GITHUB_REPOSITORY="fixture/repo",
            GITHUB_ACTOR_ID="1",
            GH_TOKEN="synthetic",
            APPROVER_IDS="[2]",
            ACTIONS_ID_TOKEN_REQUEST_URL="https://vstoken.actions.githubusercontent.com/token?api-version=1",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN="synthetic",
        )
        review = dict(
            state="approved",
            environments=[dict(name="promotion-eligibility")],
            user=dict(id=2),
        )
        payload = dict(
            operation="promotion-eligibility", releaseDigest=digest(b"fixture")
        )
        with patch.dict("os.environ", env), patch("approval_client.request") as http:
            http.side_effect = [
                (200, {}, json.dumps([review]).encode()),
                (200, {}, b'{"value":"synthetic-proof"}'),
            ]
            self.assertEqual(proof(payload, "promotion-eligibility"), "synthetic-proof")
            audience = parse_qs(urlsplit(http.call_args.args[0]).query)["audience"][0]
            self.assertEqual(
                audience, "api://astracode/request/" + digest(canonical(payload))[7:]
            )
        for key, value in (
            ("GITHUB_REF", "refs/tags/v1.0.0"),
            ("GITHUB_RUN_ATTEMPT", "2"),
            ("GITHUB_EVENT_NAME", "push"),
        ):
            with patch.dict("os.environ", dict(env, **{key: value})), patch(
                "approval_client.request"
            ) as http:
                with self.assertRaises(Refused):
                    proof(payload, "promotion-eligibility")
                http.assert_not_called()
        for bad in (
            dict(review, user=dict(id=1)),
            dict(review, state="rejected"),
            dict(review, environments=[dict(name="staging-lifecycle")]),
        ):
            with patch.dict("os.environ", env), patch(
                "approval_client.request",
                return_value=(200, {}, json.dumps([bad]).encode()),
            ) as http:
                with self.assertRaises(Refused):
                    proof(payload, "promotion-eligibility")
                self.assertEqual(http.call_count, 1)


if __name__ == "__main__":
    unittest.main()
