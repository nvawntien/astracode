#!/usr/bin/env python3
"""Verify the designated Azure device before mounting or starting K3s."""

import subprocess
import sys
import uuid
from pathlib import Path


LUN_PATHS = (
    Path("/dev/disk/azure/data/by-lun/0"),
    Path("/dev/disk/azure/scsi1/lun0"),
)
UUID_PATH = Path("/etc/astracode/app-data-uuid")
UUID_DEVICES = Path("/dev/disk/by-uuid")
MOUNT_PATH = Path("/srv/astracode/data")


def read_attribute(device, name):
    return subprocess.check_output(
        ["blkid", "-p", "-s", name, "-o", "value", str(device)],
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()


def verify_device():
    if MOUNT_PATH.resolve() != MOUNT_PATH:
        raise ValueError("App mount path must not contain a symlink")
    expected_uuid = str(uuid.UUID(UUID_PATH.read_text().strip()))
    devices = {link.resolve(strict=True) for link in LUN_PATHS if link.exists()}
    if len(devices) != 1:
        raise ValueError("Azure data LUN 0 must resolve to exactly one device")
    device = devices.pop()
    if not device.is_block_device():
        raise ValueError("Azure data LUN 0 is not a block device")
    if read_attribute(device, "TYPE") != "ext4" or read_attribute(device, "UUID") != expected_uuid:
        raise ValueError("Azure data LUN 0 does not match the approved ext4 filesystem")
    if (UUID_DEVICES / expected_uuid).resolve(strict=True) != device:
        raise ValueError("Filesystem UUID alias does not point to the verified Azure LUN")
    return device


def verify_mounted(device):
    source = subprocess.check_output(
        ["findmnt", "--noheadings", "--output", "SOURCE", "--mountpoint", str(MOUNT_PATH)],
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()
    if Path(source).resolve(strict=True) != device:
        raise ValueError("App mount does not use the verified Azure data disk")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"before-mount", "before-k3s"}:
        return 2
    try:
        device = verify_device()
        if sys.argv[1] == "before-k3s":
            verify_mounted(device)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"App data disk gate: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
