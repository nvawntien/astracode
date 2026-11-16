#!/usr/bin/env python3
"""Independent route oracle: read original KrakenD declarations from Git, not routes.json."""
import json
from pathlib import Path
import re
import subprocess
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
# Reviewed pre-migration commit. CI fetch-depth:0 keeps the immutable oracle available.
BASE = 'ba946c92a897f6c8e04e0c5e9bac43c819d3e41c'


class LegacyRouteParity(unittest.TestCase):
    def test_original_krakend_routes_equal_generated_bootstraps(self):
        original = {}
        for service in ('auth', 'user', 'admin', 'problem', 'submission'):
            data = subprocess.check_output(['git', 'show', f'{BASE}:gateway/settings/{service}.json'], cwd=ROOT)
            for endpoint in json.loads(data)['endpoints']:
                original[endpoint['method'] + ' ' + endpoint['endpoint']] = endpoint
        self.assertEqual(len(original), 50)
        for name in ('envoy.yaml', 'envoy.prod.yaml'):
            config = yaml.safe_load((ROOT / 'envoy' / name).read_text())
            hcm = config['static_resources']['listeners'][0]['filter_chains'][0]['filters'][0]['typed_config']
            routes = hcm['route_config']['virtual_hosts'][0]['routes']
            actual = {route['name']: route for route in routes if 'name' in route}
            self.assertEqual(set(actual), set(original), name)
            self.assertEqual(len(actual), sum('name' in route for route in routes))
            for key, endpoint in original.items():
                with self.subTest(config=name, route=key):
                    route = actual[key]
                    self.assertEqual(route['match']['headers'][0]['string_match']['exact'], endpoint['method'])
                    pattern = endpoint['endpoint']
                    regex = ''.join('[^/]+' if part.startswith('{') else re.escape(part)
                                    for part in re.split(r'(\{[^}]+\})', pattern))
                    self.assertEqual(route['match'].get('path', route['match'].get('safe_regex', {}).get('regex')),
                                     regex if '{' in pattern else pattern)
                    backend = endpoint['backend'][0]
                    self.assertEqual(endpoint['endpoint'], backend['url_pattern'])
                    self.assertEqual(route['route']['cluster'], backend['host'][0].split('://')[1].split(':')[0])
                    self.assertEqual(route['route']['timeout'], endpoint.get('timeout', '3s'))
                    meta = route['metadata']['filter_metadata']['envoy.filters.http.lua']
                    self.assertEqual(meta['query'], endpoint.get('input_query_strings', []))
                    self.assertEqual(meta.get('input_headers', ['*']), endpoint.get('input_headers', ['*']))
                    protected = 'auth/validator' in endpoint.get('extra_config', {})
                    filters = route.get('typed_per_filter_config', {})
                    self.assertEqual('envoy.filters.http.jwt_authn' in filters, protected)
                    self.assertEqual('envoy.filters.http.rbac' in filters, protected)
                    self.assertEqual(meta.get('protected', False), protected)
                    if protected:
                        self.assertEqual(filters['envoy.filters.http.jwt_authn']['requirement_name'], 'access_token')
            # API-only CORS must not bleed onto prod catch-all, avatars, SSE or health.
            self.assertNotIn('typed_per_filter_config', hcm['route_config']['virtual_hosts'][0])


if __name__ == '__main__':
    unittest.main(verbosity=2)
