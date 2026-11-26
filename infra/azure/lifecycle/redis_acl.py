"""Render the Redis server's per-service ACL from the designated loader credentials."""

import hashlib


def render(passwords):
    if (
        set(passwords) != {"auth", "problem", "submission"}
        or len(set(passwords.values())) != 3
        or any(len(p) < 32 for p in passwords.values())
    ):
        raise ValueError("three distinct strong Redis credentials required")
    rules = {
        "auth": "~token:* ~auth:abuse:* ~auth:logout_all_iat:* +get +set +del +watch +unwatch +multi +exec "
        "+discard +incr +pexpire +pttl +exists +evalsha +eval",
        "problem": "(~problem:submission:v1:* +get +set +del) (~auth:logout_all_iat:* +get)",
        "submission": "(~submission:cooldown:* +set +pttl) (~auth:logout_all_iat:* +get)",
    }
    lines = ["user default off resetpass -@all"]
    for name, rule in rules.items():
        verifier = hashlib.sha256(passwords[name].encode()).hexdigest()
        lines.append(f"user {name} on #{verifier} -@all +ping +hello {rule}")
    return ("\n".join(lines) + "\n").encode()
