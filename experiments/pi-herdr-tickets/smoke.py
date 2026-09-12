#!/usr/bin/env python3
"""Bounded Herdr/Pi smoke test. No GitHub writes or ticket implementation.

Starts two normal TUI Pi processes, sequentially or concurrently. Keeps failed
panes for inspection. Passing panes close; Pi's saved sessions remain.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent


def save(path, data):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def wait_json(path, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists():
            return json.loads(path.read_text())
        time.sleep(0.05)
    raise RuntimeError(f"Missing evidence: {path}. Inspect extension startup errors.")


def validate(startup, settled, context, resources, expected, session_file):
    """Smoke-only acceptance. Never use this as an implementation gate."""
    checks = {
        "normal_tui": startup["mode"] == "tui",
        "empty_history": startup["historyEntries"] == 0,
        "same_session": startup["sessionId"] == settled["sessionId"],
        "session_matches_herdr": startup["sessionFile"] == session_file,
        "single_user_context": context["roles"] == ["user"],
        "one_user_prompt": settled["userMessages"] == 1,
        "settled": settled["idle"] and not settled["pending"],
        "normal_stop": settled["stopReason"] == "stop",
        "answer": settled["answer"].strip().rstrip(".") == expected,
        "template_expanded": not resources["expandedPrompt"].startswith("/ticket-smoke"),
        "default_tools_present": {"read", "bash", "edit", "write"}.issubset(startup["tools"]),
    }
    failed = [name for name, passed in checks.items() if not passed]
    if failed:
        raise RuntimeError("Smoke checks failed: " + ", ".join(failed))
    return checks


class Trial:
    def __init__(self, root, index, cwd, keep):
        self.directory = root / f"worker-{index}"
        self.directory.mkdir(mode=0o700)
        self.name = f"smoke-{root.name[-8:]}-{index}"
        self.cwd = cwd
        self.keep = keep
        self.number = 0
        self.state = {"name": self.name, "status": "planned", "cwd": str(cwd)}
        self.checkpoint()

    def checkpoint(self):
        save(self.directory / "state.json", self.state)

    def herdr(self, *args, timeout=75):
        self.number += 1
        result = subprocess.run(["herdr", *args], capture_output=True, text=True, timeout=timeout)
        save(self.directory / f"command-{self.number}.json", {
            "argv": ["herdr", *args], "code": result.returncode,
            "stdout": result.stdout, "stderr": result.stderr,
        })
        if result.returncode:
            raise RuntimeError(f"herdr {args[0:2]} failed: {result.stderr.strip()}")
        response = json.loads(result.stdout)
        if "error" in response:
            raise RuntimeError(str(response["error"]))
        return response["result"]

    def run(self, expected):
        try:
            created = self.herdr("tab", "create", "--workspace", os.environ["HERDR_WORKSPACE_ID"],
                                 "--cwd", str(self.cwd), "--label", self.name, "--no-focus")
            self.state.update(tab=created["tab"]["tab_id"], pane=created["root_pane"]["pane_id"], status="created")
            self.checkpoint()  # Save ownership before any subsequent operation.
            # Creation does not imply a ready shell. Wait for startup output,
            # then for the shell to own the foreground process group. Herdr's
            # agent start remains the authoritative interactive readiness check.
            self.herdr("pane", "wait-output", self.state["pane"], "--regex", r"\S",
                       "--source", "recent-unwrapped", "--timeout", "30000", timeout=35)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                info = self.herdr("pane", "process-info", "--pane", self.state["pane"])["process_info"]
                shell_pid = info.get("shell_pid")
                foreground = info.get("foreground_processes", [])
                if shell_pid and foreground and all(p["pid"] == shell_pid for p in foreground):
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError("Shell did not become available; preserving tab")
            started = self.herdr("agent", "start", self.name, "--kind", "pi", "--pane", self.state["pane"],
                                 "--timeout", "60000", "--", "--name", self.name,
                                 "-e", str(HERE / "observe.ts"),
                                 "--ticket-observe-dir", str(self.directory),
                                 "--prompt-template", str(HERE / "ticket-smoke.md"))
            agent = started["agent"]
            if agent["agent_session"]["kind"] != "path":
                raise RuntimeError("Herdr did not report a saved Pi session path")
            self.state.update(sessionFile=agent["agent_session"]["value"], status="started")
            self.checkpoint()
            startup = wait_json(self.directory / "startup.json")
            if startup["mode"] != "tui" or startup["historyEntries"] != 0:
                raise RuntimeError("Worker is not a fresh interactive session")
            self.state.update(sessionId=startup["sessionId"], pid=startup["pid"], status="running")
            self.checkpoint()
            prompt = f"/ticket-smoke Reply exactly {expected}."
            response = self.herdr("agent", "prompt", self.name, prompt, "--wait", "--timeout", "120000", timeout=130)
            if response["agent"]["agent_status"] not in ("idle", "done"):
                raise RuntimeError("Worker blocked or unknown. Human inspection required.")
            settled = wait_json(self.directory / "settled-1.json")
            context = wait_json(self.directory / "first-context.json")
            resources = wait_json(self.directory / "resources-1.json")
            checks = validate(startup, settled, context, resources, expected, self.state["sessionFile"])
            events = [json.loads(line) for line in (self.directory / "events.jsonl").read_text().splitlines()]
            if any(e["event"] in ("tool", "compaction") for e in events):
                raise RuntimeError("Unexpected tool use or compaction in smoke test")
            # Check exact occupant before sending control input or closing the tab.
            current = self.herdr("agent", "get", self.name)["agent"]
            if (current["pane_id"] != self.state["pane"] or
                current["agent_session"]["value"] != self.state["sessionFile"] or
                current["agent_status"] not in ("idle", "done")):
                raise RuntimeError("Pane ownership/session/state changed before cleanup")
            self.state.update(status="passed", checks=checks, contextTokens=settled["contextUsage"]["tokens"])
            self.checkpoint()
            if not self.keep:
                self.herdr("agent", "prompt", self.name, "/quit")
                # Wait for shutdown evidence, not a guessed sleep or idle UI.
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    events = [json.loads(line) for line in (self.directory / "events.jsonl").read_text().splitlines()]
                    if any(e["event"] == "session_shutdown" for e in events):
                        break
                    time.sleep(0.05)
                else:
                    raise RuntimeError("Pi did not report shutdown; preserving tab")
                self.herdr("tab", "close", self.state["tab"])
                self.state["tabClosed"] = True
                self.checkpoint()
            return self.state
        except Exception as error:
            self.state.update(status="needs_attention", error=str(error))
            self.checkpoint()
            # No retry, no automatic permission answers, no cleanup of failed panes.
            return self.state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=int, choices=(1, 2), default=1)
    parser.add_argument("--keep", action="store_true", help="Keep passing test tabs open")
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    args = parser.parse_args()
    if os.environ.get("HERDR_ENV") != "1" or not os.environ.get("HERDR_WORKSPACE_ID"):
        parser.error("Run this from a Herdr-managed terminal")
    cwd = args.cwd.resolve(strict=True)
    root = Path(tempfile.mkdtemp(prefix="pi-herdr-smoke-"))
    print(f"Evidence: {root}", flush=True)
    trials = [Trial(root, index, cwd, args.keep) for index in (1, 2)]
    expected = ["SMOKE_" + uuid.uuid4().hex[:12] for _ in trials]
    if args.jobs == 1:
        results = []
        for trial, token in zip(trials, expected):
            results.append(trial.run(token))
            if results[-1]["status"] != "passed":
                break
    else:
        # These tasks are no-tool smoke prompts. Never share a cwd for parallel coding.
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(trial.run, token) for trial, token in zip(trials, expected)]
            results = [future.result() for future in futures]
    success = len(results) == 2 and all(r["status"] == "passed" for r in results)
    if success:
        success = results[0]["sessionId"] != results[1]["sessionId"] and results[0]["pid"] != results[1]["pid"]
    report = {"passed": success, "jobs": args.jobs, "results": results}
    save(root / "report.json", report)
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if success else 1)


if __name__ == "__main__":
    main()
