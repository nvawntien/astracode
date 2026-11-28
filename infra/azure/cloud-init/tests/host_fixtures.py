"""Offline checks for App mount identity and agent credential handling."""

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch


def load_script(name):
    path = Path(__file__).resolve().parents[1] / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    return script


disk = load_script("app-disk")
credentials = load_script("k3s-credential")
DISK_UUID = "00000000-0000-4000-8000-000000000001"


class AppDiskFixtures(unittest.TestCase):
    def setUp(self):
        self.uuid_file = Mock()
        self.uuid_file.read_text.return_value = DISK_UUID + "\n"
        self.addCleanup(patch.stopall)
        patch.object(disk, "UUID_PATH", self.uuid_file).start()
        self.read_attribute = patch.object(disk, "read_attribute").start()
        self.read_attribute.side_effect = lambda device, name: {
            "TYPE": "ext4",
            "UUID": DISK_UUID,
        }[name]
        self.uuid_devices = MagicMock()
        patch.object(disk, "UUID_DEVICES", self.uuid_devices).start()

    def lun(self, *devices):
        links = []
        for device in devices:
            link = Mock()
            link.exists.return_value = device is not None
            link.resolve.return_value = device
            links.append(link)
        return patch.object(disk, "LUN_PATHS", links)

    def test_absent_lun(self):
        with self.lun(None, None), self.assertRaisesRegex(ValueError, "exactly one device"):
            disk.verify_device()

    def test_conflicting_lun_aliases(self):
        with self.lun(Mock(), Mock()), self.assertRaisesRegex(ValueError, "exactly one device"):
            disk.verify_device()

    def test_wrong_filesystem(self):
        self.read_attribute.side_effect = ["ext4", "wrong-uuid"]
        with self.lun(Mock()), self.assertRaisesRegex(ValueError, "approved ext4 filesystem"):
            disk.verify_device()

    def test_uuid_alias_must_point_to_lun_device(self):
        (self.uuid_devices / DISK_UUID).resolve.return_value = Mock()
        with self.lun(Mock()), self.assertRaisesRegex(ValueError, "UUID alias"):
            disk.verify_device()

    def test_wrong_mount_and_unmounted(self):
        device = Mock()
        with patch.object(disk.subprocess, "check_output", return_value="/dev/null\n"):
            with self.assertRaisesRegex(ValueError, "does not use"):
                disk.verify_mounted(device)
        error = subprocess.CalledProcessError(1, "findmnt")
        with patch.object(disk.subprocess, "check_output", side_effect=error):
            with self.assertRaises(subprocess.CalledProcessError):
                disk.verify_mounted(device)

    def test_reboot_and_reattachment_with_new_kernel_name(self):
        # Both stable Azure symlinks may exist and point to one device.
        original, reattached = Mock(), Mock()
        uuid_alias = self.uuid_devices / DISK_UUID
        uuid_alias.resolve.side_effect = [original, original, reattached]
        with self.lun(original, original):
            self.assertIs(disk.verify_device(), original)
            self.assertIs(disk.verify_device(), original)
        with self.lun(reattached, None):
            self.assertIs(disk.verify_device(), reattached)


class CredentialFixtures(unittest.TestCase):
    def test_judge_accepts_only_ca_pinned_agent_credential(self):
        hash_value, password = "a" * 64, "b" * 64
        credentials.validate_agent(f"K10{hash_value}::node:{password}")
        invalid = {
            "no-ca-pin": password,
            "server": f"K10{hash_value}::server:{password}",
            "wrong-user": f"K10{hash_value}::agent:{password}",
            "short-password": f"K10{hash_value}::node:short",
        }
        for form, token in invalid.items():
            with self.subTest(form=form), self.assertRaises(ValueError):
                credentials.validate_agent(token)

    def test_app_refuses_to_regenerate_agent_secret_for_existing_cluster(self):
        secret = Mock()
        secret.exists.return_value = False
        with tempfile.TemporaryDirectory() as path:
            cluster = Path(path)
            (cluster / "db").mkdir()
            with (
                patch.object(credentials, "APP_AGENT_SECRET", secret),
                patch.object(credentials, "SERVER_DIR", cluster),
                patch.object(credentials, "write_protected") as write_secret,
            ):
                with self.assertRaisesRegex(ValueError, "existing cluster"):
                    credentials.app_agent_secret()
                write_secret.assert_not_called()

    def test_app_keeps_agent_secret_across_restart(self):
        secret = Mock()
        secret.exists.return_value = True
        with patch.object(credentials, "APP_AGENT_SECRET", secret):
            with patch.object(credentials, "read_protected", return_value="a" * 64) as read_secret:
                with patch.object(credentials, "write_protected") as write_secret:
                    credentials.app_agent_secret()
                    credentials.app_agent_secret()
                    self.assertEqual(read_secret.call_count, 2)
                    write_secret.assert_not_called()


if __name__ == "__main__":
    unittest.main()
