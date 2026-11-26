#!/usr/bin/env python3
"""
Lasagna's hooks stay out of the sessions an installed Pappardelle started.

Both tools' plugins run their hooks in every agent session on the machine.
Pappardelle marks its own sessions with PAPPARDELLE_REPO, Lasagna its own
with LASAGNA_REPO.

Run with: uv run pytest plugins/lasagna/hooks/test_pappardelle_session.py -v
"""

import importlib.util
import io
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

HOOKS = Path(__file__).parent


def load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, HOOKS / file)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


state_db = load("state_db_for_session_tests", "state_db.py")
zap = load("zap_for_session_tests", "zap-notification.py")
comment = load("comment_for_session_tests", "comment-question-answered.py")

PAPPARDELLE = {"PAPPARDELLE_REPO": "app", "PAPPARDELLE_SPACE": "STA-1"}
LASAGNA = {"LASAGNA_REPO": "app", "LASAGNA_SPACE": "STA-1"}


@pytest.mark.parametrize(
    ("environ", "expected"),
    [
        (PAPPARDELLE, True),
        ({"PAPPARDELLE_REPO": "app"}, True),
        ({}, False),
        (LASAGNA, False),
        # Lasagna started from one of Pappardelle's panes.
        ({**PAPPARDELLE, **LASAGNA}, False),
    ],
)
def test_a_session_is_pappardelles_when_it_carries_only_its_variables(environ, expected):
    assert state_db.in_pappardelle_session(environ) is expected


def run_update_status(tmp_path: Path, environ: dict[str, str]) -> Path:
    """Run the status hook as Claude Code does, and return its status directory."""
    home = tmp_path / "home"
    worktree = tmp_path / "repo" / "STA-1"
    worktree.mkdir(parents=True)
    result = subprocess.run(
        [sys.executable, str(HOOKS / "update-status.py")],
        input=json.dumps({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": str(worktree)}),
        text=True,
        capture_output=True,
        cwd=worktree,
        env={"HOME": str(home), "PATH": os.environ["PATH"], "LASAGNA_SQLITE_STATE": "0", **environ},
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    return home / ".lasagna" / "claude-status"


def test_the_status_hook_reports_nothing_for_a_session_of_pappardelles(tmp_path: Path):
    assert not run_update_status(tmp_path, PAPPARDELLE).exists()


def test_the_status_hook_reports_for_a_session_of_lasagnas(tmp_path: Path):
    assert [file.name for file in run_update_status(tmp_path, LASAGNA).iterdir()] == ["app-STA-1.json"]


def run_main(module, payload: dict, environ: dict[str, str]) -> None:
    with patch.dict(os.environ, environ, clear=False), patch("sys.stdin", io.StringIO(json.dumps(payload))):
        try:
            module.main()
        except SystemExit:
            pass


QUESTION_ANSWERED = {
    "hook_event_name": "PostToolUse",
    "tool_name": "AskUserQuestion",
    "tool_input": {"questions": [{"question": "Which one?", "options": []}]},
    "tool_response": {"answers": {"Which one?": "The first"}},
}


def test_the_comment_hook_posts_nothing_for_a_session_of_pappardelles(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LASAGNA_REPO", raising=False)
    with patch.object(comment, "get_issue_key", return_value="STA-1"), patch.object(comment, "post_comment") as post:
        run_main(comment, QUESTION_ANSWERED, PAPPARDELLE)
        post.assert_not_called()
        run_main(comment, QUESTION_ANSWERED, LASAGNA)
        post.assert_called_once()


def test_the_notification_hook_sends_nothing_for_a_session_of_pappardelles(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LASAGNA_REPO", raising=False)
    asked = {"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion"}
    with patch.object(zap, "LASAGNA_NTFY_TOPIC", "topic"), patch.object(zap, "send_zap") as send:
        run_main(zap, asked, PAPPARDELLE)
        send.assert_not_called()
        run_main(zap, asked, LASAGNA)
        send.assert_called_once()
