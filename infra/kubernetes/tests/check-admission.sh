#!/usr/bin/env bash
set -euo pipefail
umask 077
render=$(realpath "${1:?path to rendered synthetic overlay}")
test_dir=$(cd "$(dirname "$0")" && pwd)
fixture=$(mktemp -d)
cd "$fixture"
export FIXTURE_KUBECONFIG="$fixture/client.yaml"
openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=fixture-ca -keyout ca.key -out ca.crt -days 1 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -subj /CN=fixture/O=system:masters -keyout client.key -out client.csr 2>/dev/null
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 -out client.crt 2>/dev/null
openssl genrsa -out signer.key 2048 2>/dev/null
read -r port client peer < <(python3 -c 'import socket; ss=[socket.socket() for _ in range(3)]; [s.bind(("127.0.0.1",0)) for s in ss]; print(*(s.getsockname()[1] for s in ss))')
etcd --listen-client-urls "http://127.0.0.1:$client" --advertise-client-urls "http://127.0.0.1:$client" --listen-peer-urls "http://127.0.0.1:$peer" --initial-advertise-peer-urls "http://127.0.0.1:$peer" --initial-cluster "default=http://127.0.0.1:$peer" --data-dir "$fixture/data" >etcd.log 2>&1 &
etcd_pid=$!
api_pid=''
cleanup() {
  if [[ -n "$api_pid" ]]; then
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
  kill "$etcd_pid" 2>/dev/null || true
  wait "$etcd_pid" 2>/dev/null || true
  cd /
  rm -rf -- "$fixture"
}
trap cleanup EXIT
kube-apiserver --bind-address=127.0.0.1 --advertise-address=127.0.0.1 --secure-port="$port" --etcd-servers="http://127.0.0.1:$client" --shutdown-delay-duration=0s --shutdown-send-retry-after=false --authorization-mode=RBAC --client-ca-file="$fixture/ca.crt" --service-account-key-file=signer.key --service-account-signing-key-file=signer.key --service-account-issuer=https://fixture.invalid --service-cluster-ip-range=10.43.0.0/16 --cert-dir="$fixture/certs" --allow-privileged --anonymous-auth=false >api.log 2>&1 &
api_pid=$!
kubectl --kubeconfig="$FIXTURE_KUBECONFIG" config set-cluster fixture --server="https://127.0.0.1:$port" --insecure-skip-tls-verify=true >/dev/null
kubectl --kubeconfig="$FIXTURE_KUBECONFIG" config set-credentials fixture --client-certificate="$fixture/client.crt" --client-key="$fixture/client.key" >/dev/null
kubectl --kubeconfig="$FIXTURE_KUBECONFIG" config set-context fixture --cluster=fixture --user=fixture >/dev/null
kubectl --kubeconfig="$FIXTURE_KUBECONFIG" config use-context fixture >/dev/null
for i in {1..45}; do
  kill -0 "$api_pid" || { tail -5 api.log; exit 1; }
  if kubectl --kubeconfig="$FIXTURE_KUBECONFIG" get --raw=/readyz >/dev/null 2>&1; then break; fi
  sleep 1
done
python3 -B "$test_dir/admission.py" "$render"
