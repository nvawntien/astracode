#!/usr/bin/env python3
"""Render both pinned Envoy bootstraps from the explicit public route inventory."""
import argparse
import copy
import json
from pathlib import Path
import re

import yaml

ROOT = Path(__file__).resolve().parent
JWT = "envoy.filters.http.jwt_authn"
TYPE = "type.googleapis.com/envoy.extensions.filters.http."
PORTS = {"auth-service": 8081, "problem-service": 8082, "submission-service": 8083,
         "website": 3000, "minio": 9000}


def metadata_permission(namespace, path, value):
    return {"metadata": {"filter": namespace, "path": [{"key": key} for key in path], "value": value}}


def authorization(protected=False):
    permissions = [metadata_permission("astracode.edge", ["sanitized"], {"bool_match": True})]
    if protected:
        for claim in ("sub", "username"):
            permissions.append(metadata_permission("envoy.filters.http.jwt_authn", ["verified", claim],
                {"string_match": {"safe_regex": {"regex": r"[^\x00-\x1f\x7f]+"}}}))
        permissions.append(metadata_permission("envoy.filters.http.jwt_authn", ["verified", "role"],
            {"string_match": {"safe_regex": {"regex": "user|moderator|admin"}}}))
        permissions.append(metadata_permission("envoy.filters.http.jwt_authn", ["verified", "iat"],
            {"double_match": {"range": {"start": 0, "end": 9007199254740992}}}))
        # Metadata numbers are doubles. Require the native propagated timestamp
        # to be an integer too, matching backend strconv.ParseInt semantics.
        permissions.append({"header": {"name": "x-token-iat", "string_match": {
            "safe_regex": {"regex": "[0-9]+"}}}})
    return {"rules": {"action": "ALLOW", "policies": {"edge_contract": {
        "permissions": [{"and_rules": {"rules": permissions}}], "principals": [{"any": True}]}}}}


def match(method, path):
    parts = re.split(r"(\{[^}]+\})", path)
    regex = "".join("[^/]+" if p.startswith("{") else re.escape(p) for p in parts)
    selector = {"safe_regex": {"regex": regex}} if "{" in path else {"path": path}
    return {**selector, "headers": [{"name": ":method", "string_match": {"exact": method}}]}


def cluster(name):
    return {"name": name, "type": "STRICT_DNS", "connect_timeout": "2s",
            "lb_policy": "ROUND_ROBIN", "load_assignment": {"cluster_name": name,
            "endpoints": [{"lb_endpoints": [{"endpoint": {"address": {"socket_address": {
                "address": name, "port_value": PORTS[name]}}}}]}]}}


def build(production=False):
    inventory = json.loads((ROOT / "routes.json").read_text())
    routes = [{"match": match("GET", "/envoy-health"),
               "direct_response": {"status": 200, "body": {"inline_string": "ok\n"}}}]
    routes.append({"match": match("GET", "/events/submissions/{submission_id}"),
                   "route": {"cluster": "submission-service", "timeout": "0s", "idle_timeout": "75s"}})
    for item in inventory:
        assert item["path"] == item["upstream"], "Add an explicit rewrite before changing paths"
        route = {"name": item["method"] + " " + item["path"],
                 "match": match(item["method"], item["path"]),
                 "route": {"cluster": item["service"], "timeout": item["timeout"]},
                 "metadata": {"filter_metadata": {"envoy.filters.http.lua": {"query": item["query"]}}}}
        if item["headers"] != ["*"]:
            route["metadata"]["filter_metadata"]["envoy.filters.http.lua"]["input_headers"] = item["headers"]
        if item["auth"]:
            route["typed_per_filter_config"] = {JWT: {"@type": TYPE + "jwt_authn.v3.PerRouteConfig",
                                                       "requirement_name": "access_token"}}
            route["metadata"]["filter_metadata"]["envoy.filters.http.lua"]["protected"] = True
            route["typed_per_filter_config"]["envoy.filters.http.rbac"] = {
                "@type": TYPE + "rbac.v3.RBACPerRoute", "rbac": authorization(True)}
        routes.append(route)
    # CORS requires a route action. These matches are handled by the CORS
    # filter; a following guard rejects non-preflight OPTIONS before upstream.
    for path in dict.fromkeys(item["path"] for item in inventory):
        item = next(item for item in inventory if item["path"] == path)
        routes.append({"match": match("OPTIONS", path),
                       "route": {"cluster": item["service"], "timeout": "3s"}})
    # API/event misses must never fall through to a service prefix or Next.js.
    for prefix in ("/api/", "/events/"):
        routes.append({"match": {"prefix": prefix}, "direct_response": {"status": 404}})
    if production:
        routes += [{"match": {"prefix": "/avatars/"}, "route": {"cluster": "minio", "timeout": "30s"}},
                   {"match": {"prefix": "/"}, "route": {"cluster": "website", "timeout": "45s"}}]
    cors = {"@type": TYPE + "cors.v3.CorsPolicy",
            "allow_origin_string_match": [{"exact": "http://localhost:3000"}],
            "allow_methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
            "allow_headers": "Origin,Authorization,Content-Type,Accept,X-Requested-With,Cookie",
            "expose_headers": "Content-Length", "allow_credentials": True, "max_age": "43200",
            "forward_not_matching_preflights": False}
    for route in routes:
        selector = route["match"]
        path = selector.get("path", selector.get("safe_regex", {}).get("regex", ""))
        if path.startswith("/api/") and "route" in route:
            route.setdefault("typed_per_filter_config", {})["envoy.filters.http.cors"] = cors
    provider = {"local_jwks": {"filename": "/etc/envoy/secrets/symmetric.json"},
                "from_cookies": ["access_token"],
                # Retain the existing non-browser integration clients too.
                "from_headers": [{"name": "Authorization", "value_prefix": "Bearer "}],
                "forward": True, "clock_skew_seconds": 60, "payload_in_metadata": "verified",
                "claim_to_headers": [{"claim_name": claim, "header_name": header} for claim, header in
                    [("sub", "x-user-id"), ("role", "x-role"), ("username", "x-username"), ("iat", "x-token-iat")]]}
    hcm = {"@type": "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager",
           "stat_prefix": "edge_http", "codec_type": "AUTO", "use_remote_address": True,
           "xff_num_trusted_hops": 0, "normalize_path": True, "merge_slashes": False,
           "path_with_escaped_slashes_action": "REJECT_REQUEST",
           "common_http_protocol_options": {"idle_timeout": "75s"},
           # The previous no-op gateway returned empty 500 on its 3s deadline.
           # Only local replies are mapped; backend 4xx/5xx bodies stay intact.
           "local_reply_config": {"mappers": [
               {"filter": {"response_flag_filter": {"flags": ["UT"]}},
                "status_code": 500, "body": {"inline_string": ""}},
               {"filter": {"status_code_filter": {"comparison": {"op": "EQ", "value": {"default_value": 401, "runtime_key": "edge.local_unauthorized_status"}}}},
                "body": {"inline_string": ""}}]},
           "access_log": [{"name": "envoy.access_loggers.stdout", "typed_config": {
               "@type": "type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog",
               "log_format": {"json_format": {"timestamp": "%START_TIME%", "method": "%REQ(:METHOD)%",
                   "path": "%PATH(NQ:PATH)%", "response_code": "%RESPONSE_CODE%",
                   "response_flags": "%RESPONSE_FLAGS%", "duration_ms": "%DURATION%",
                   "upstream_cluster": "%UPSTREAM_CLUSTER%", "request_id": "%REQ(X-REQUEST-ID)%"}}}}],
           "route_config": {"name": "edge_routes", "virtual_hosts": [{"name": "edge", "domains": ["*"],
               "routes": routes}]},
           "http_filters": [
               {"name": "envoy.filters.http.header_mutation", "typed_config": {
                   "@type": TYPE + "header_mutation.v3.HeaderMutation", "mutations": {
                       "request_mutations": [{"remove": header} for header in (
                           "x-user-id", "x-role", "x-username", "x-token-iat", "x-client-ip",
                           "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded")]}}},
               {"name": "envoy.filters.http.lua", "typed_config": {
                   "@type": TYPE + "lua.v3.Lua", "clear_route_cache": False, "default_source_code": {"filename": "/etc/envoy/edge.lua"}}},
               {"name": "envoy.filters.http.cors", "typed_config": {"@type": TYPE + "cors.v3.Cors"}},
               {"name": JWT, "typed_config": {"@type": TYPE + "jwt_authn.v3.JwtAuthentication",
                   "providers": {"access_token": provider},
                   "requirement_map": {"access_token": {"provider_name": "access_token"}}}},
               {"name": "envoy.filters.http.rbac", "typed_config": {
                   "@type": TYPE + "rbac.v3.RBAC", **authorization()}},
               {"name": "envoy.filters.http.lua", "typed_config": {
                   "@type": TYPE + "lua.v3.Lua", "clear_route_cache": False,
                   "default_source_code": {"inline_string": '''function envoy_on_request(handle)
  if handle:headers():get(":method") == "OPTIONS" and handle:headers():get(":path"):sub(1, 5) == "/api/" then
    handle:respond({[":status"] = "404"}, "")
    return
  end

end
'''}}},
               {"name": "envoy.filters.http.router", "typed_config": {"@type": TYPE + "router.v3.Router"}}]}
    names = list(PORTS) if production else list(PORTS)[:3]
    return {"admin": {"address": {"socket_address": {"address": "127.0.0.1", "port_value": 9901}}},
            "static_resources": {"listeners": [{"name": "edge_listener",
                "address": {"socket_address": {"address": "0.0.0.0", "port_value": 8080}},
                "filter_chains": [{"filters": [{"name": "envoy.filters.network.http_connection_manager",
                                                "typed_config": hcm}]}]}],
                "clusters": [cluster(name) for name in names]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for production in (False, True):
        path = ROOT / ("envoy.prod.yaml" if production else "envoy.yaml")
        output = "# Generated by envoy/generate.py; edit routes.json, edge.lua or generate.py.\n" + yaml.safe_dump(
            copy.deepcopy(build(production)), sort_keys=False, width=110)
        if args.check:
            if not path.exists() or path.read_text() != output:
                raise SystemExit(f"Stale generated configuration: {path}")
        else:
            path.write_text(output)
    inventory = json.loads((ROOT / "routes.json").read_text())
    table = """# Public API route inventory

Generated by `generate.py`. All upstream paths equal external paths, with no prefix rewrite.
All protected routes accept exactly one access-token credential (cookie OR Bearer),
verify HS256 and require nonempty string `sub`/`username`, a known `role` and numeric
nonnegative integer `iat`. They propagate `sub`, `role`, `username`, `iat` into
`X-User-ID`, `X-Role`, `X-Username`, `X-Token-Iat`. Backend Redis revocation, RBAC
and ownership checks remain authoritative. Public routes receive no identity headers.
Bodies and backend responses (including multiple Set-Cookie headers) pass through.
Request headers pass through after edge sanitization except the refresh allowlist
in routes.json. Query allowlists below retain repeated values and original encoding.

| Method | External / upstream path | Backend | JWT | Backend authorization | Query keys | Timeout | Special |
|---|---|---|---|---|---|---|---|
"""
    for item in inventory:
        table += "| " + " | ".join([item["method"], "`" + item["path"] + "`", item["service"],
            "Required" if item["auth"] else "Public", item["authorization"],
            ", ".join(item["query"]) or "None", item["timeout"],
            item.get("note", "Multipart streaming" if item["upload"] or item["path"].endswith("/avatar") else "")]) + " |\n"
    table += """
Additional edge routes: GET `/envoy-health` returns 200; GET
`/events/submissions/{submission_id}` goes to Submission with timeout 0 and idle
timeout 75s, preserving the ticket query. Ticket verification and ownership are
performed by Submission. Valid localhost:3000 CORS preflights are handled at the
edge for API routes only; API OPTIONS never reaches a backend. Unknown API/event routes or methods return
404. Production additionally routes `/avatars/` to MinIO (30s) and the remaining
website paths to Next.js (45s). No service health or internal gRPC endpoint is exposed.
"""
    path = ROOT / "ROUTES.md"
    if args.check:
        if not path.exists() or path.read_text() != table:
            raise SystemExit(f"Stale route inventory: {path}")
    else:
        path.write_text(table)


if __name__ == "__main__":
    main()
