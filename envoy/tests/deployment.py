#!/usr/bin/env python3
"""Disposable real-Envoy test of bundle rollback, forced reload and key ownership.

Application containers are echo fixtures tagged as two releases, not real Go/DB
services. The bundle controller and Envoy runtime helper are production code.
"""
import base64
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tarfile
import tempfile
import time
import unittest
import uuid
import yaml

ROOT = Path(__file__).resolve().parents[2]
IMAGE = 'envoyproxy/envoy:v1.34.2'


def run(args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, **kwargs)


class Deployment(unittest.TestCase):
    def test_config_image_rollback_and_key_reload(self):
        with tempfile.TemporaryDirectory(prefix='edge-deploy-') as temporary:
            directory = Path(temporary)
            app = directory / 'app'; app.mkdir()
            project = 'edge-deploy-' + uuid.uuid4().hex[:10]
            image_root = 'local/' + project
            state = directory / 'state'; state.mkdir()
            stack = directory / 'stack.env'; override = directory / 'override.yml'
            key = directory / 'canonical.json'
            secret = secrets.token_bytes(32)
            def set_key(value):
                key.write_text(json.dumps({'keys': [{'kty': 'oct', 'alg': 'HS256', 'use': 'sig', 'k': base64.urlsafe_b64encode(value).decode().rstrip('=')}]}))
                key.chmod(0o600)
            set_key(secret)
            stack.write_text(f'ASTRACODE_IMAGE_ROOT={image_root}\nASTRACODE_IMAGE_TAG=v1.0.0\nGATEWAY_JWK_FILE={key}\n')
            override.write_text('services: {}\n')
            env = dict(os.environ, ASTRACODE_APP_DIR=str(app), ASTRACODE_APP_STATE_DIR=str(state),
                ASTRACODE_STACK_ENV=str(stack), ASTRACODE_APP_OVERRIDE=str(override), ASTRACODE_APP_COMPOSE_PROJECT=project)
            env['ASTRACODE_RELEASE_CONTAINER_NAMES'] = ' '.join(project + '-' + name for name in ('website', 'auth-service', 'problem-service', 'submission-service'))
            def compose(*args):
                return run(['docker','compose','--project-name',project,'--env-file',str(stack),'-f',str(app/'docker-compose.yml'),'-f',str(app/'docker-compose.prod.yml'),'-f',str(override),*args],env=env)
            def checked(result):
                self.assertEqual(result.returncode,0,result.stderr[-3000:]); return result.stdout.strip()
            def bundle(tag, marker, invalid=False, fail_after_update=False):
                source = directory / ('source-' + uuid.uuid4().hex); (source/'envoy').mkdir(parents=True); (source/'scripts').mkdir()
                config = yaml.safe_load((ROOT/'envoy/envoy.prod.yaml').read_text())
                hcm = config['static_resources']['listeners'][0]['filter_chains'][0]['filters'][0]['typed_config']
                hcm['route_config']['virtual_hosts'][0]['routes'][0]['direct_response']['body']['inline_string'] = marker
                if invalid: config = {'invalid_fixture_field': True}
                (source/'envoy/envoy.prod.yaml').write_text(yaml.safe_dump(config))
                lua = (ROOT/'envoy/edge.lua').read_text() + f'\nlocal original_response = envoy_on_response\nfunction envoy_on_response(h) original_response(h); h:headers():add("x-fixture-lua", "{marker}") end\n'
                (source/'envoy/edge.lua').write_text(lua)
                base = yaml.safe_load((ROOT/'docker-compose.yml').read_text())
                services = {'envoy': base['services']['envoy'], 'envoy-jwk': base['services']['envoy-jwk']}
                services['envoy']['ports']=['127.0.0.1::8080']; services['envoy']['container_name']=project+'-envoy'
                services['envoy']['volumes'][0]='./envoy/envoy.prod.yaml:/etc/envoy/envoy.yaml:ro'
                services['envoy']['command'] += ['--concurrency','1']
                services['envoy']['depends_on']={'envoy-jwk':{'condition':'service_completed_successfully'}}
                for name in ('website','auth-service','problem-service','submission-service','minio'):
                    services[name]={'image':'${ASTRACODE_IMAGE_ROOT}/fixture:${ASTRACODE_IMAGE_TAG}',
                        'container_name':project+'-'+name,'command':['python','/upstreams.py'],
                        'volumes':[str(ROOT/'envoy/tests/upstreams.py')+':/upstreams.py:ro'],'networks':['judge_internal']}
                (source/'docker-compose.yml').write_text(yaml.safe_dump({'services':services,'networks':{'judge_internal':{}},'volumes':{'envoy_jwk':{}}}))
                (source/'docker-compose.prod.yml').write_text('services: {}\n')
                shutil.copy(ROOT/'scripts/envoy-runtime.sh', source/'scripts/envoy-runtime.sh')
                # Fixture image fleet; production helper owns the actual Envoy commands.
                script = '''#!/bin/bash
set -euo pipefail
set -a; source "$ASTRACODE_STACK_ENV"; set +a
export ASTRACODE_IMAGE_TAG="$1"
compose() { docker compose --project-name "$ASTRACODE_APP_COMPOSE_PROJECT" --env-file "$ASTRACODE_STACK_ENV" -f "$ASTRACODE_APP_DIR/docker-compose.yml" -f "$ASTRACODE_APP_DIR/docker-compose.prod.yml" -f "$ASTRACODE_APP_OVERRIDE" "$@"; }
source "$ASTRACODE_APP_DIR/scripts/envoy-runtime.sh"
validate_envoy_runtime
compose up -d --pull never website auth-service problem-service submission-service minio
activate_envoy_runtime
FIXTURE_FAILURE
printf '%s\\n' "$1" > "$ASTRACODE_APP_STATE_DIR/current-image-tag"
'''
                (source/'scripts/deploy-app-node.sh').write_text(script.replace('FIXTURE_FAILURE', 'exit 1' if fail_after_update else 'true'))
                path = directory / (tag + '-' + marker + '.tgz')
                with tarfile.open(path,'w:gz') as archive:
                    for name in ('docker-compose.yml','docker-compose.prod.yml','envoy/envoy.prod.yaml','envoy/edge.lua','scripts/deploy-app-node.sh','scripts/envoy-runtime.sh'):
                        archive.add(source/name,arcname=name)
                return path,source
            def activate(*args):
                return run(['python3',str(ROOT/'scripts/deploy-app-bundle.py'),*map(str,args)],env=env)
            def request(token=None):
                port=int(checked(compose('port','envoy','8080')).rsplit(':',1)[1])
                c=http.client.HTTPConnection('127.0.0.1',port,timeout=5)
                c.request('GET','/api/v1/me' if token else '/envoy-health',headers={'Authorization':'Bearer '+token} if token else {})
                r=c.getresponse(); result=(r.status,dict(r.getheaders()),r.read());c.close();return result
            def ready(marker):
                for _ in range(60):
                    try:
                        status,headers,body=request()
                        if (status,body)==(200,marker.encode()) and headers.get('x-fixture-lua')==marker:return
                    except (OSError,http.client.HTTPException):pass
                    time.sleep(.2)
                self.fail('Envoy config/Lua activation not observed: '+marker)
            def token(value):
                b64=lambda v:base64.urlsafe_b64encode(v).decode().rstrip('=')
                payload={'sub':'fixture','username':'fixture','role':'user','iat':int(time.time()),'exp':int(time.time())+600}
                data=b64(b'{"alg":"HS256"}')+'.'+b64(json.dumps(payload).encode())
                return data+'.'+b64(hmac.new(value,data.encode(),hashlib.sha256).digest())
            try:
                for image in ('python:3.12.12-slim', IMAGE):
                    if run(['docker','image','inspect',image]).returncode:
                        checked(run(['docker','pull',image]))
                for tag in ('v1.0.0','v1.0.1'):
                    checked(run(['docker','tag','python:3.12.12-slim',image_root+'/fixture:'+tag]))
                b1,s1=bundle('v1.0.0','one')
                shutil.copytree(s1,app,dirs_exist_ok=True)
                checked(run(['bash',str(app/'scripts/deploy-app-node.sh'),'v1.0.0'],env=env));ready('one')
                b2,_=bundle('v1.0.1','two')
                checked(activate('v1.0.1',b2));ready('two')
                self.assertEqual(json.loads((state/'current-bundle.json').read_text())['tag'],'v1.0.1')
                checked(activate('--rollback'));ready('one')
                for name in ('website','auth-service','problem-service','submission-service'):
                    self.assertTrue(checked(run(['docker','inspect','--format','{{.Config.Image}}',project+'-'+name])).endswith(':v1.0.0'))
                checked(activate('--rollback'));ready('two')
                failed,_=bundle('v1.0.0','failed-after-update',fail_after_update=True)
                self.assertNotEqual(activate('v1.0.0',failed).returncode,0)
                ready('two')  # restore a fleet that already changed image tags
                old_id=checked(compose('ps','-q','envoy'))
                b2lua,_=bundle('v1.0.1','lua-only')
                checked(activate('v1.0.1',b2lua));ready('lua-only')
                self.assertNotEqual(old_id,checked(compose('ps','-q','envoy')))
                bad,_=bundle('v1.0.1','invalid',True)
                self.assertNotEqual(activate('v1.0.1',bad).returncode,0)
                ready('lua-only')
                # Restore previous image/config pair, not just image tag.
                checked(activate('--rollback'));ready('two')
                checked(activate('--rollback'));ready('lua-only')
                self.assertEqual(request(token(secret))[0],200)
                new_secret=secrets.token_bytes(32);set_key(new_secret)
                # JWK-only update: image tag AND YAML/Lua bundle unchanged.
                old_id=checked(compose('ps','-q','envoy'))
                checked(activate('v1.0.1',b2lua));ready('lua-only')
                self.assertNotEqual(old_id,checked(compose('ps','-q','envoy')))
                self.assertEqual(request(token(new_secret))[0],200)
                self.assertEqual(request(token(secret))[0],401)
                self.assertNotEqual(activate('--rollback').returncode,0)
                ready('lua-only')  # refusal did not mutate the serving config
                set_key(secret)
                checked(activate('--rollback'));ready('lua-only')
                self.assertEqual(request(token(secret))[0],200)
                self.assertEqual(key.stat().st_mode & 0o777,0o600)
                for name in ('website','auth-service','problem-service','submission-service'):
                    image=checked(run(['docker','inspect','--format','{{.Config.Image}}',project+'-'+name]))
                    self.assertTrue(image.endswith(':v1.0.1'))
            finally:
                compose('down','--volumes','--remove-orphans')
                run(['docker','image','rm',image_root+'/fixture:v1.0.0',image_root+'/fixture:v1.0.1'])


if __name__=='__main__': unittest.main(verbosity=2)
