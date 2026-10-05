import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "libexec/tunneldock-config.py"
spec = importlib.util.spec_from_file_location("config", HELPER)
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def invoke(self, *args):
        return subprocess.run(["python3", str(HELPER), *map(str, args)],
                              capture_output=True, text=True)

    def test_session_validation(self):
        for idle in ["NaN", "inf", "-1", "1441"]:
            with self.subTest(idle=idle), self.assertRaises(ValueError):
                config.session_options(self.root, "chat", idle)
        with self.assertRaises(ValueError):
            config.session_options(self.root / "missing", "chat", "30")

    def test_partial_update_and_install_preserve_settings(self):
        path = self.root / "config.json"
        config.write_object(path, {"ask": False, "autoCreate": {
            "cwd": str(self.root), "namePrefix": "project", "idleMinutes": 9}})
        self.assertEqual(self.invoke("sessions-config", path, "", "", "0").returncode, 0)
        d = config.read_object(path)
        self.assertFalse(d["ask"])
        self.assertEqual(d["autoCreate"]["cwd"], str(self.root))
        self.assertEqual(d["autoCreate"]["namePrefix"], "project")
        self.assertEqual(d["autoCreate"]["idleMinutes"], 0)
        self.assertEqual(self.invoke("sessions-default", path, self.root, "chatgpt", "30").returncode, 0)
        self.assertEqual(config.read_object(path), d)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_remote_auto_create_rejected_without_writing(self):
        path = self.root / "config.json"
        config.write_object(path, {"connect": "broker.local"})
        result = self.invoke("sessions-config", path, self.root, "chat", "30")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(config.read_object(path), {"connect": "broker.local"})

    def test_project_selection_survives_partial_updates_and_can_be_disabled(self):
        path = self.root / "config.json"
        sid = "12345678-1234-4234-8234-123456789abc"
        self.assertEqual(self.invoke("sessions-config", path, self.root, "main", "30", sid).returncode, 0)
        self.assertEqual(self.invoke("validate-sessions", path).returncode, 0)
        self.assertEqual(self.invoke("sessions-config", path, "", "", "0", "").returncode, 0)
        self.assertEqual(config.read_object(path)["autoCreate"]["sessionId"], sid)
        before = config.read_object(path)
        self.assertNotEqual(self.invoke("sessions-config", path, "", "", "", "not-a-uuid").returncode, 0)
        self.assertEqual(config.read_object(path), before)
        self.assertEqual(self.invoke("sessions-config", path, "", "", "", "per-chat").returncode, 0)
        self.assertNotIn("sessionId", config.read_object(path)["autoCreate"])

    def test_migration_is_idempotent_and_preserves_legacy(self):
        agent, broker = self.root / "agent", self.root / "broker"
        old = {"bindings": {"chat": "sid"}, "managedSessions": {
            "sid": {"cwd": str(self.root), "name": "old"}},
            "deliveries": [{"id": "delivery", "chatId": "chat"}], "questions": []}
        config.write_object(agent / "chappie.state.json", old)
        config.write_object(agent / "chappie.json", {"ask": False})
        config.write_object(broker / "config.json", {"ask": True, "cooldown": 0})
        config.migrate(broker, agent)
        state = config.read_object(broker / "state.json")
        self.assertEqual(state["bindings"], old["bindings"])
        self.assertEqual(state["deliveries"][0]["clientId"], "chat")
        self.assertEqual(config.read_object(agent / "chappie.state.json"), old)
        self.assertTrue(config.read_object(broker / "config.json")["ask"])
        config.write_object(broker / "state.json", {"bindings": {"new": "new"}})
        config.migrate(broker, agent)
        self.assertEqual(config.read_object(broker / "state.json")["bindings"], {"new": "new"})

    def test_conflicting_migration_keeps_current_state(self):
        agent, broker = self.root / "agent", self.root / "broker"
        config.write_object(agent / "chappie.state.json", {"bindings": {"chat": "old"}})
        config.write_object(broker / "state.json", {"bindings": {"chat": "new"}})
        with self.assertRaises(ValueError):
            config.migrate(broker, agent)
        self.assertEqual(config.read_object(broker / "state.json")["bindings"]["chat"], "new")
        self.assertFalse((broker / "tunneldock-migration.json").exists())

    def test_profile_migration_preserves_options_and_backup(self):
        import yaml
        path = self.root / "profile.yaml"
        data = {"mcp": {"commands": [{"channel": "main", "command": "pi --chappie"},
                                    {"channel": "extra", "command": "other"}]},
                "health": {"listen_addr": "127.0.0.1:18081"}, "unknown": "retain"}
        original = yaml.safe_dump(data)
        path.write_text(original)
        self.assertEqual(self.invoke("profile-broker", path).returncode, 0)
        migrated = yaml.safe_load(path.read_text())
        self.assertEqual(migrated["mcp"]["commands"][0]["command"], "chappie")
        self.assertEqual(migrated["mcp"]["commands"][1]["command"], "other")
        self.assertEqual(migrated["unknown"], "retain")
        self.assertEqual(path.with_suffix(".yaml.pre-1.1.0").read_text(), original)
        self.assertEqual(self.invoke("profile-broker", path).returncode, 0)

    def test_custom_credential_metadata_never_reads_key(self):
        path, key = self.root / "profile.yaml", self.root / "custom.key"
        key.write_text("synthetic-test-credential")
        key.chmod(0o600)
        path.write_text(f'control_plane:\n  api_key: "file:{key}"\nhealth:\n  listen_addr: "[::1]:18081"\n')
        # Forbid opening credentials even when diagnosing the profile.
        builtin_open = open
        def guarded_open(name, *args, **kwargs):
            self.assertNotEqual(Path(name), key)
            return builtin_open(name, *args, **kwargs)
        with patch("builtins.open", guarded_open), patch("builtins.print") as output:
            config.profile_info(path)
        output.assert_called_once_with("http://[::1]:18081")
        key.chmod(0o644)
        with self.assertRaises(ValueError):
            config.profile_info(path)

    def test_parser_errors_do_not_echo_values(self):
        path = self.root / "profile.yaml"
        path.write_text("control_plane: [synthetic-test-secret\n")
        result = self.invoke("profile-info", path)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("synthetic-test-secret", result.stderr)

    def test_public_health_listener_rejected(self):
        for address in ["0.0.0.0:18080", "127.0.0.1:0", "127.0.0.1:65536", "example.com:80"]:
            with self.subTest(address=address), self.assertRaises(ValueError):
                config.health_address(address)

    def test_historical_runtime_snapshot_only_displays_validated_fields(self):
        path = self.root / "runtime.json"
        record = {"sessionId": "00000000-0000-4000-8000-000000000001",
                  "status": "failed", "code": "handshake_mismatch",
                  "stderrCode": "extension_load_failed",
                  "stderr": "synthetic-secret-must-not-display", "nonce": "synthetic-nonce"}
        config.write_object(path, {"revision": 1, "sessions": [record]})
        result = self.invoke("runtime-snapshot", path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("not live", result.stdout)
        self.assertIn("handshake_mismatch", result.stdout)
        self.assertNotIn("synthetic-secret", result.stdout + result.stderr)
        self.assertNotIn("synthetic-nonce", result.stdout + result.stderr)
        record["code"] = "synthetic-secret-must-not-display"
        config.write_object(path, {"revision": 1, "sessions": [record]})
        result = self.invoke("runtime-snapshot", path)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("synthetic-secret", result.stdout + result.stderr)


class CliTests(unittest.TestCase):
    def invoke(self, *args):
        return subprocess.run([str(ROOT / "bin/tunneldock"), *args],
                              capture_output=True, text=True, timeout=10)

    def test_missing_option_values_fail_before_runtime_work(self):
        for command, flag in [("configure", "--tunnel-id"), ("configure", "--api-key-file"),
                              ("sessions-config", "--cwd"), ("sessions-config", "--idle-minutes")]:
            with self.subTest(flag=flag):
                result = self.invoke(command, flag)
                self.assertEqual(result.returncode, 1)
                self.assertIn("需要一个值", result.stderr)

    def test_symlink_resolves_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            link = Path(directory) / "tunneldock"
            link.symlink_to(ROOT / "bin/tunneldock")
            result = subprocess.run([str(link), "configure", "--help"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            wrapper = Path(directory) / "configure-chappie-tunnel"
            wrapper.symlink_to(ROOT / "bin/configure-chappie-tunnel")
            result = subprocess.run([str(wrapper), "--help"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)

    def test_release_download_failure_falls_back_and_force_is_honored(self):
        script = '''source "$1"
have() { [[ "$1" != otunnel ]]; }
curl() { return 22; }
install_otunnel_from_source() { echo SOURCE_FALLBACK; }
install_otunnel
TUNNELDOCK_FORCE_OTUNNEL_SOURCE=1 install_otunnel
'''
        result = subprocess.run(["bash", "-c", script, "test", str(ROOT / "bin/tunneldock")],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count("SOURCE_FALLBACK"), 2)

    def test_doctor_uses_custom_key_and_live_health(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key = root / "custom.key"
            key.write_text("synthetic-test-credential")
            key.chmod(0o600)
            profile = root / "profile.yaml"
            profile.write_text(f'control_plane:\n  api_key: "file:{key}"\nhealth:\n  listen_addr: "127.0.0.1:18081"\n')
            config.write_object(root / "config.json", {"autoCreate": {"cwd": directory}})
            config.write_object(root / "package.json", {
                "version": "1.1.0-tunneldock.6", "tunneldock": {"chatScopedSessions": 1,
                "runtimeHandshake": 1, "runtimeDiagnostics": 1, "ipcCapacity": 1}})
            script = '''source "$1"
PROFILE_FILE="$2/profile.yaml"
CHAPPIE_CONFIG="$2/config.json"
CHAPPIE_DIR="$2"
pi() { [[ "$1" == list ]] && echo "$CHAPPIE_DIR"; return 0; }
chappie() { if [[ "$1" == diagnostics ]]; then echo LIVE_RUNTIME_DIAGNOSTICS; fi; return 0; }
systemctl() { return 0; }
loginctl() { echo yes; }
otunnel() {
  if [[ "$1" == doctor ]]; then echo UNEXPECTED_DEEP_DOCTOR; return 1; fi
  if [[ "$1" == health ]]; then printf '%s\\n' "$@"; fi
}
doctor_cmd
'''
            result = subprocess.run(["bash", "-c", script, "test", str(ROOT / "bin/tunneldock"), directory],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("http://127.0.0.1:18081", result.stdout)
            self.assertIn("LIVE_RUNTIME_DIAGNOSTICS", result.stdout)
            self.assertNotIn("UNEXPECTED_DEEP_DOCTOR", result.stdout)
            self.assertNotIn("synthetic-test-credential", result.stdout + result.stderr)
            failed_runtime = script.replace("echo LIVE_RUNTIME_DIAGNOSTICS; fi;", "echo LIVE_RUNTIME_DIAGNOSTICS; return 1; fi;")
            result = subprocess.run(["bash", "-c", failed_runtime, "test", str(ROOT / "bin/tunneldock"), directory],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("http://127.0.0.1:18081", result.stdout)
            config.write_object(root / "package.json", {
                "version": "1.1.0-tunneldock.1", "tunneldock": {"chatScopedSessions": 1}})
            result = subprocess.run(["bash", "-c", script, "test", str(ROOT / "bin/tunneldock"), directory],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("FAIL  Managed runtime build", result.stdout)

    def test_install_restarts_previous_service_on_failure(self):
        script = '''source "$1"
validate_versions() { return 0; }
require_linux() { return 0; }
require_systemd_user() { return 0; }
install_prereqs() { return 0; }
systemctl() { echo "SYSTEMCTL $*"; }
install_node() { return 7; }
install_all
'''
        result = subprocess.run(["bash", "-c", script, "test", str(ROOT / "bin/tunneldock")],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 7)
        self.assertIn("--user stop chappie-tunnel.service", result.stdout)
        self.assertIn("--user start chappie-tunnel.service", result.stdout)

    def test_unknown_chappie_version_fails_before_installation(self):
        script = '''source "$1"
CHAPPIE_VERSION=0.5.0
validate_versions
'''
        result = subprocess.run(["bash", "-c", script, "test", str(ROOT / "bin/tunneldock")],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("1.1.0", result.stderr)

    def test_install_help_and_unexpected_arguments_do_not_install(self):
        self.assertEqual(self.invoke("install", "--help").returncode, 0)
        self.assertEqual(self.invoke("install", "--unexpected").returncode, 1)

    def test_diagnostics_offline_fallback_remains_an_explicit_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config.write_object(root / "runtime.json", {"revision": 1, "sessions": [{
                "sessionId": "00000000-0000-4000-8000-000000000001", "status": "failed",
                "code": "startup_timeout", "stderrCode": "no_diagnostic"}]})
            script = '''source "$1"
KEY_DIR="$2"
chappie() { return 1; }
diagnostics_cmd
'''
            result = subprocess.run(["bash", "-c", script, "test", str(ROOT / "bin/tunneldock"), directory],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("not live", result.stdout)
            self.assertIn("startup_timeout", result.stdout)
            result = subprocess.run(["bash", "-c", script.replace("diagnostics_cmd\n", "diagnostics_cmd --json\n"),
                                     "test", str(ROOT / "bin/tunneldock"), directory], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")

    def test_diagnostics_rejects_unknown_options_without_runtime_work(self):
        self.assertEqual(self.invoke("diagnostics", "--help").returncode, 0)
        result = self.invoke("diagnostics", "--unexpected")
        self.assertEqual(result.returncode, 1)
        self.assertIn("仅接受 --json", result.stderr)


if __name__ == "__main__":
    unittest.main()
