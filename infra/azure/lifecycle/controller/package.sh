#!/usr/bin/env bash
set -euo pipefail
test "$#" -eq 1
here=$(cd -- "$(dirname -- "$0")" && pwd)
root=$(cd -- "$here/../../../.." && pwd)
python3 - "$1" "$here" "$root" <<'PY'
from pathlib import Path
import sys
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

target, here, root = map(Path, sys.argv[1:])
items = [here / name for name in ("auth.py", "azure_adapters.py", "function_app.py", "host.json", "requirements.txt", "service.py", "state.py")]
items += [here.parent / name for name in ("activation_record.py", "controller_client.py", "node_state.py")]
items += [root / "scripts/release" / name for name in ("policy.py", "transport.py")]
with ZipFile(target, "w") as package:
    for path in sorted(items, key=lambda p: p.name):
        info = ZipInfo(path.name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        package.writestr(info, path.read_bytes())
PY
