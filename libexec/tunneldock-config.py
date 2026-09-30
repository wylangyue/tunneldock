#!/usr/bin/env python3
"""Configuration operations. Never resolve or display credential contents."""

import ipaddress
import json
import math
import os
from pathlib import Path
import sys
import tempfile


def read_object(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if not isinstance(data, dict):
        raise ValueError("configuration/state must contain a JSON object")
    return data


def write_object(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2, allow_nan=False)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def session_options(cwd, prefix, idle):
    cwd = Path(cwd).expanduser().resolve()
    if not cwd.is_dir():
        raise ValueError("session cwd must be an existing directory")
    if not prefix.strip():
        raise ValueError("name prefix must not be empty")
    idle = float(idle)
    if not math.isfinite(idle) or not 0 <= idle <= 1440:
        raise ValueError("idle minutes must be finite and between 0 and 1440")
    return {"cwd": str(cwd), "namePrefix": prefix, "idleMinutes": idle}


def health_address(value):
    host, port = value.rsplit(":", 1)
    ip = ipaddress.ip_address(host.strip("[]"))
    if not ip.is_loopback or not 1 <= int(port) <= 65535:
        raise ValueError("health address must use a loopback IP and port 1..65535")
    return f"[{ip}]:{int(port)}" if ip.version == 6 else f"{ip}:{int(port)}"


def migrate(directory, agent_directory):
    directory, agent_directory = Path(directory), Path(agent_directory)
    marker = directory / "tunneldock-migration.json"
    if marker.exists():
        return
    # The old files remain intact. Refuse conflicts instead of losing bindings.
    for old_name, new_name in [("chappie.json", "config.json"),
                               ("chappie.state.json", "state.json")]:
        old_path, new_path = agent_directory / old_name, directory / new_name
        if not old_path.exists():
            continue
        old, current = read_object(old_path), read_object(new_path)
        if old_name == "chappie.state.json":
            for delivery in old.get("deliveries", []):
                if "chatId" in delivery:
                    delivery["clientId"] = delivery.pop("chatId")
        result = dict(current)
        for key, value in old.items():
            if key not in result:
                result[key] = value
            elif key in ("bindings", "managedSessions"):
                merged = dict(value)
                for ident, item in result[key].items():
                    if ident in merged and merged[ident] != item:
                        raise ValueError("legacy and current session state conflict; migration stopped")
                    merged[ident] = item
                result[key] = merged
            elif key in ("deliveries", "questions"):
                records = {item["id"]: item for item in value}
                records.update({item["id"]: item for item in result[key]})
                result[key] = list(records.values())
        write_object(new_path, result)
    write_object(marker, {"from": str(agent_directory), "version": 1})


def profile_info(path):
    import yaml

    with open(path, encoding="utf-8") as f:
        profile = yaml.safe_load(f)
    if not isinstance(profile, dict):
        raise ValueError("profile must contain a YAML mapping")
    control = profile.get("control_plane", {})
    ref = control.get("api_key", "")
    if not isinstance(ref, str) or not ref.startswith("file:"):
        raise ValueError("TunnelDock requires a file: API key reference")
    key_path = Path(ref[5:]).expanduser()
    if not key_path.is_absolute():
        key_path = Path(path).parent / key_path
    # Only inspect metadata; never open the key file.
    if not key_path.is_file() or key_path.stat().st_size == 0:
        raise ValueError("referenced API key file is missing or empty")
    if key_path.stat().st_mode & 0o077:
        raise ValueError("referenced API key file permissions must be 0600 or stricter")
    addr = health_address(profile.get("health", {}).get("listen_addr", ""))
    print("http://" + addr)


def main():
    command, *args = sys.argv[1:]
    if command == "migrate":
        migrate(*args)
    elif command in ("sessions-config", "sessions-default"):
        path, cwd, prefix, idle = args
        data = read_object(path)
        if command == "sessions-default" and "autoCreate" in data:
            return
        existing = data.get("autoCreate")
        existing = existing if isinstance(existing, dict) else {}
        options = session_options(cwd or existing.get("cwd", str(Path.home())),
                                  prefix or existing.get("namePrefix", "chatgpt"),
                                  idle or existing.get("idleMinutes", 30))
        if data.get("connect"):
            raise ValueError("managed Pi sessions require a local broker; remove connect first")
        data["autoCreate"] = options
        write_object(path, data)
    elif command == "validate-sessions":
        data = read_object(args[0])
        auto = data.get("autoCreate")
        if not isinstance(auto, dict) or not auto.get("cwd") or data.get("connect"):
            raise ValueError("managed Pi session configuration is missing or incompatible")
        session_options(auto.get("cwd", ""), auto.get("namePrefix", "chatgpt"),
                        auto.get("idleMinutes", 30))
    elif command == "health-address":
        print(health_address(args[0]))
    elif command == "profile-info":
        profile_info(args[0])
    elif command == "profile-broker":
        import yaml

        path = Path(args[0])
        if not path.exists():
            return
        with path.open(encoding="utf-8") as f:
            data = yaml.safe_load(f)
        changed = False
        mcp = data.get("mcp", {})
        if mcp.get("command") == "pi --chappie":
            mcp["command"] = "chappie"
            changed = True
        for target in mcp.get("commands", []):
            if target.get("command") == "pi --chappie":
                target["command"] = "chappie"
                changed = True
        if changed:
            backup = path.with_suffix(path.suffix + ".pre-1.1.0")
            if not backup.exists():
                backup.write_bytes(path.read_bytes())
                backup.chmod(0o600)
            fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    yaml.safe_dump(data, f, sort_keys=False)
                os.replace(tmp, path)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
    elif command == "sessions":
        data = read_object(args[0])
        bindings, managed = data.get("bindings", {}), data.get("managedSessions", {})
        print(f"ChatGPT bindings: {len(bindings)}")
        print(f"Managed Pi sessions: {len(managed)}")
        if managed:
            print("\nSESSION ID                            BINDINGS  NAME                 CWD")
            for sid, meta in managed.items():
                count = list(bindings.values()).count(sid)
                print(f"{sid:36} {count:8}  {meta.get('name', ''):20} {meta.get('cwd', '')}")
    else:
        raise ValueError("unknown configuration operation")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Parser exceptions can include configuration values, including passwords.
        if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError):
            print(f"[tunneldock] {error}", file=sys.stderr)
        else:
            print("[tunneldock] configuration operation failed; check file format and permissions",
                  file=sys.stderr)
        sys.exit(1)
