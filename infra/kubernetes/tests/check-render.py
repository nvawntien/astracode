"""Check synthetic overlays against the pinned upstream Kubernetes and Traefik schemas."""

import json
import re
import sys
from pathlib import Path

import yaml
from jsonschema import Draft4Validator


def strict(schema):
    if isinstance(schema, dict):
        # OpenAPI v2 encodes the Kubernetes scalar union using its format.
        if schema.get("format") == "int-or-string":
            schema["type"] = ["integer", "string"]
        if "properties" in schema and not schema.get("x-kubernetes-preserve-unknown-fields"):
            schema.setdefault("additionalProperties", False)
        for value in schema.values():
            strict(value)
    elif isinstance(schema, list):
        for value in schema:
            strict(value)


def schemas(kubernetes, traefik):
    definitions = json.loads(kubernetes.read_text())["definitions"]
    strict(definitions)
    result = {}
    for key, definition in definitions.items():
        for gvk in definition.get("x-kubernetes-group-version-kind", []):
            group = gvk["group"] + "/" if gvk["group"] else ""
            result[group + gvk["version"], gvk["kind"]] = {
                "$ref": "#/definitions/" + key, "definitions": definitions,
            }
    for crd in yaml.safe_load_all(traefik.read_text()):
        if not crd or crd.get("kind") != "CustomResourceDefinition":
            continue
        spec = crd["spec"]
        for version in spec["versions"]:
            schema = version["schema"]["openAPIV3Schema"]
            strict(schema)
            result[spec["group"] + "/" + version["name"], spec["names"]["kind"]] = schema
    return result


def verify(path, validators, slot):
    resources = list(yaml.safe_load_all(path.read_text()))
    images = {}
    for obj in resources:
        kind = obj["kind"]
        validators[obj["apiVersion"], kind].validate(obj)
        assert obj["metadata"]["labels"]["astracode.io/environment"] == slot
        if kind in ("Deployment", "Job"):
            pod = obj["spec"]["template"]["spec"]
            for c in pod["containers"]:
                image = c["image"]
                assert re.fullmatch(r".+@sha256:[0-9a-f]{64}", image)
                assert c["name"] not in images
                images[c["name"]] = image
        if kind == "Deployment" and obj["metadata"]["name"] == "judge-worker":
            worker, daemon = pod["containers"]
            assert worker["securityContext"]["allowPrivilegeEscalation"] is False
            assert daemon["securityContext"] == {"privileged": True}
            assert not pod["automountServiceAccountToken"]
            assert {v["name"]: v["readOnly"] for v in daemon["volumeMounts"]}["testcases"]
            assert not {v["name"]: v["readOnly"] for v in worker["volumeMounts"]}["testcases"]
            assert {e["name"]: e["value"] for e in daemon["env"]}["ES_GRPC_ADDR"] == "127.0.0.1:5051"
        if kind == "Service":
            assert obj["spec"].get("type", "ClusterIP") == "ClusterIP"
            assert not {5050, 5051, 5052}.intersection(p["port"] for p in obj["spec"]["ports"])
        if kind == "IngressRoute":
            expected = "testing" if slot == "s3" else "staging"
            assert obj["spec"]["routes"][0]["match"] == f"Host(`{expected}.invalid`)"
    assert len(images) == 13
    print(f"{slot}: {len(resources)} resources passed strict schemas, {len(images)} pinned containers")
    return images


if __name__ == "__main__":
    k8s, crds, testing, staging = map(Path, sys.argv[1:])
    validators = {key: Draft4Validator(schema) for key, schema in schemas(k8s, crds).items()}
    assert verify(testing, validators, "s3") == verify(staging, validators, "s2")
