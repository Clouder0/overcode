#!/usr/bin/env python3
"""
Opencode Snapshot Restore Tool

Usage:
    python restore_snapshot.py                              # List main sessions
    python restore_snapshot.py <main_session_id>            # Interactive mode
    python restore_snapshot.py <main_session_id> --list     # Just list snapshots
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from datetime import datetime


def get_xdg_data_home():
    """Get XDG_DATA_HOME or default to ~/.local/share"""
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))


def get_project_id():
    """Get project ID from .git/opencode or git root commit"""
    git_opencode = Path(".git/opencode")
    if git_opencode.exists():
        return git_opencode.read_text().strip()

    result = subprocess.run(
        ["git", "rev-list", "--max-parents=0", "--all"], capture_output=True, text=True
    )
    if result.returncode == 0:
        commits = sorted(result.stdout.strip().split("\n"))
        if commits and commits[0]:
            return commits[0]

    return "global"


def get_opencode_paths(project_id):
    """Get opencode storage paths"""
    data_home = get_xdg_data_home()
    return {
        "sessions": data_home / "opencode" / "storage" / "session" / project_id,
        "messages": data_home / "opencode" / "storage" / "message",
        "parts": data_home / "opencode" / "storage" / "part",
        "snapshots": data_home / "opencode" / "snapshot" / project_id,
    }


def load_json(file_path):
    """Load a JSON file, return None if failed"""
    try:
        if file_path.exists():
            return json.loads(file_path.read_text())
    except (json.JSONDecodeError, IOError) as e:
        print(f"Warning: Failed to load {file_path}: {e}", file=sys.stderr)
    return None


def find_related_sessions(paths, main_session_id):
    """Find main session and all its child sessions"""
    sessions = []
    sessions_dir = paths["sessions"]

    if not sessions_dir.exists():
        print(f"Error: Sessions directory not found: {sessions_dir}")
        return sessions

    for session_file in sessions_dir.iterdir():
        if not session_file.name.endswith(".json"):
            continue
        session = load_json(session_file)
        if not session:
            continue

        session_id = session.get("id", session_file.stem)
        parent_id = session.get("parentID")

        # Include if it's the main session or a child of it
        if session_id == main_session_id or parent_id == main_session_id:
            sessions.append(
                {
                    "id": session_id,
                    "parent_id": parent_id,
                    "title": session.get("title", "Untitled"),
                    "created": session.get("time", {}).get("created", 0),
                    "updated": session.get("time", {}).get("updated", 0),
                }
            )

    sessions.sort(key=lambda x: x["created"])
    return sessions


def find_messages_for_session(paths, session_id):
    """Find all messages for a session"""
    messages_dir = paths["messages"] / session_id
    messages = []

    if not messages_dir.exists():
        return messages

    for msg_file in messages_dir.iterdir():
        if not msg_file.name.endswith(".json"):
            continue
        msg = load_json(msg_file)
        if msg:
            messages.append(
                {
                    "id": msg.get("id", msg_file.stem),
                    "role": msg.get("role"),
                    "session_id": session_id,
                }
            )

    return messages


def find_parts_for_message(paths, message_id):
    """Find all parts for a message"""
    parts_dir = paths["parts"] / message_id
    parts = []

    if not parts_dir.exists():
        return parts

    for part_file in sorted(parts_dir.iterdir()):
        if not part_file.name.endswith(".json"):
            continue
        part = load_json(part_file)
        if part:
            parts.append(part)

    return parts


def find_snapshots(paths, sessions):
    """Find all snapshots from the given sessions"""
    snapshots = []

    for session in sessions:
        session_id = session["id"]
        messages = find_messages_for_session(paths, session_id)

        for msg in messages:
            parts = find_parts_for_message(paths, msg["id"])

            for part in parts:
                if part.get("type") == "step-start" and part.get("snapshot"):
                    snapshots.append(
                        {
                            "hash": part["snapshot"],
                            "session_id": session_id,
                            "session_title": session["title"],
                            "message_id": msg["id"],
                            "part_id": part.get("id", "unknown"),
                            "is_main": session["parent_id"] is None,
                        }
                    )

    return snapshots


def list_snapshot_files(snapshot_dir, snapshot_hash):
    """List files in a snapshot"""
    result = subprocess.run(
        [
            "git",
            f"--git-dir={snapshot_dir}",
            "ls-tree",
            "-r",
            "--name-only",
            snapshot_hash,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return [f for f in result.stdout.strip().split("\n") if f]
    return []


def show_file_from_snapshot(snapshot_dir, snapshot_hash, filepath):
    """Show file content from a snapshot"""
    result = subprocess.run(
        ["git", f"--git-dir={snapshot_dir}", "show", f"{snapshot_hash}:{filepath}"],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return result.stdout
    return None


def restore_file_from_snapshot(snapshot_dir, worktree, snapshot_hash, filepath):
    """Restore a specific file from a snapshot"""
    result = subprocess.run(
        [
            "git",
            f"--git-dir={snapshot_dir}",
            f"--work-tree={worktree}",
            "checkout",
            snapshot_hash,
            "--",
            filepath,
        ],
        capture_output=True,
        text=True,
        cwd=worktree,
    )
    return result.returncode == 0, result.stderr


def restore_all_from_snapshot(snapshot_dir, worktree, snapshot_hash):
    """Restore all files from a snapshot"""
    result = subprocess.run(
        [
            "git",
            f"--git-dir={snapshot_dir}",
            f"--work-tree={worktree}",
            "read-tree",
            snapshot_hash,
        ],
        capture_output=True,
        text=True,
        cwd=worktree,
    )
    if result.returncode != 0:
        return False, result.stderr

    result = subprocess.run(
        [
            "git",
            f"--git-dir={snapshot_dir}",
            f"--work-tree={worktree}",
            "checkout-index",
            "-a",
            "-f",
        ],
        capture_output=True,
        text=True,
        cwd=worktree,
    )
    return result.returncode == 0, result.stderr


def interactive_mode(paths, snapshots, project_id):
    """Interactive mode to browse and restore snapshots"""
    if not snapshots:
        print("\nNo snapshots found!")
        print("\nDebug info:")
        print(f"  Sessions dir: {paths['sessions']}")
        print(f"  Messages dir: {paths['messages']}")
        print(f"  Parts dir: {paths['parts']}")
        print(f"  Snapshots dir: {paths['snapshots']}")
        return

    snapshot_dir = paths["snapshots"]
    worktree = os.getcwd()

    print(f"\nFound {len(snapshots)} snapshots:")
    print("-" * 80)

    for i, snap in enumerate(snapshots):
        session_type = "MAIN" if snap["is_main"] else "SUB "
        title = (
            snap["session_title"][:35]
            if len(snap["session_title"]) > 35
            else snap["session_title"]
        )
        print(f"  [{i:3d}] {session_type} | {snap['hash'][:12]} | {title}")

    print("-" * 80)
    print("\nCommands:")
    print("  <number>          - Select snapshot and show files")
    print("  r <number>        - Restore ALL files from snapshot (dangerous!)")
    print("  r <number> <file> - Restore specific file from snapshot")
    print("  d <number> <file> - Show diff between snapshot and current file")
    print("  s <number> <file> - Show file content from snapshot")
    print("  q                 - Quit")
    print()

    while True:
        try:
            cmd = input(">>> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye!")
            break

        if not cmd:
            continue

        if cmd == "q":
            break

        parts = cmd.split(maxsplit=2)

        # Select snapshot to show files
        if len(parts) == 1 and parts[0].isdigit():
            idx = int(parts[0])
            if 0 <= idx < len(snapshots):
                snap = snapshots[idx]
                print(f"\nFiles in snapshot {snap['hash'][:12]}:")
                files = list_snapshot_files(snapshot_dir, snap["hash"])
                for f in files[:50]:
                    print(f"  {f}")
                if len(files) > 50:
                    print(f"  ... and {len(files) - 50} more files")
                if not files:
                    print("  (no files or snapshot not found)")
            else:
                print(f"Invalid index. Use 0-{len(snapshots) - 1}")
            continue

        # Show file content: s <number> <file>
        if parts[0] == "s" and len(parts) >= 3:
            idx = int(parts[1])
            filepath = parts[2]
            if 0 <= idx < len(snapshots):
                snap = snapshots[idx]
                content = show_file_from_snapshot(snapshot_dir, snap["hash"], filepath)
                if content is not None:
                    print(f"\n--- {filepath} from {snap['hash'][:12]} ---")
                    print(content)
                else:
                    print(f"File not found in snapshot: {filepath}")
            continue

        # Show diff: d <number> <file>
        if parts[0] == "d" and len(parts) >= 3:
            idx = int(parts[1])
            filepath = parts[2]
            if 0 <= idx < len(snapshots):
                snap = snapshots[idx]
                old_content = show_file_from_snapshot(
                    snapshot_dir, snap["hash"], filepath
                )
                current_file = Path(worktree) / filepath
                if old_content is not None and current_file.exists():
                    new_content = current_file.read_text()
                    if old_content == new_content:
                        print("Files are identical.")
                    else:
                        import tempfile

                        with tempfile.NamedTemporaryFile(
                            mode="w", suffix=".old", delete=False
                        ) as f:
                            f.write(old_content)
                            old_path = f.name
                        result = subprocess.run(
                            ["diff", "-u", old_path, str(current_file)],
                            capture_output=True,
                            text=True,
                        )
                        print(result.stdout or result.stderr or "No diff output")
                        os.unlink(old_path)
                elif old_content is None:
                    print(f"File not found in snapshot: {filepath}")
                else:
                    print(f"File not found in current directory: {filepath}")
            continue

        # Restore: r <number> [file]
        if parts[0] == "r" and len(parts) >= 2:
            idx = int(parts[1])
            if 0 <= idx < len(snapshots):
                snap = snapshots[idx]

                if len(parts) == 3:
                    filepath = parts[2]
                    success, err = restore_file_from_snapshot(
                        snapshot_dir, worktree, snap["hash"], filepath
                    )
                    if success:
                        print(f"Restored: {filepath}")
                    else:
                        print(f"Failed to restore: {filepath}")
                        if err:
                            print(f"  Error: {err}")
                else:
                    confirm = input(
                        f"Restore ALL files from {snap['hash'][:12]}? This will overwrite current files! (yes/no): "
                    )
                    if confirm.lower() == "yes":
                        success, err = restore_all_from_snapshot(
                            snapshot_dir, worktree, snap["hash"]
                        )
                        if success:
                            print("All files restored successfully!")
                        else:
                            print(f"Failed to restore: {err}")
                    else:
                        print("Cancelled.")
            continue

        print("Unknown command. Type 'q' to quit.")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        print("\nFirst, let's find your project ID and list main sessions:\n")

        project_id = get_project_id()
        print(f"Project ID: {project_id}")

        paths = get_opencode_paths(project_id)
        sessions_dir = paths["sessions"]

        print(f"Sessions dir: {sessions_dir}")

        if not sessions_dir.exists():
            print(f"\nNo sessions found at: {sessions_dir}")
            return 1

        print(f"\nMain sessions (no parentID):")
        print("-" * 80)

        main_sessions = []
        for session_file in sorted(
            sessions_dir.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True
        ):
            if not session_file.name.endswith(".json"):
                continue
            session = load_json(session_file)
            if session and not session.get("parentID"):
                main_sessions.append((session.get("id", session_file.stem), session))

        if not main_sessions:
            print("  (no main sessions found)")
        else:
            for session_id, session in main_sessions[:20]:
                updated = datetime.fromtimestamp(
                    session.get("time", {}).get("updated", 0) / 1000
                )
                title = session.get("title", "Untitled")[:50]
                print(
                    f"  {session_id}  |  {updated.strftime('%Y-%m-%d %H:%M')}  |  {title}"
                )

        print("-" * 80)
        print(f"\nUsage: python {sys.argv[0]} <session_id>")
        return 0

    main_session_id = sys.argv[1]
    project_id = get_project_id()
    paths = get_opencode_paths(project_id)

    print(f"Project ID: {project_id}")
    print(f"Main Session: {main_session_id}")
    print(f"Snapshot Dir: {paths['snapshots']}")

    # Find all related sessions
    sessions = find_related_sessions(paths, main_session_id)
    print(f"\nFound {len(sessions)} related sessions (main + subagents)")

    if not sessions:
        print("\nNo sessions found! Check if the session ID is correct.")
        print(f"Looking in: {paths['sessions']}")
        return 1

    # Show which sessions we found
    for s in sessions:
        role = "main" if s["parent_id"] is None else "subagent"
        print(f"  - [{role}] {s['id'][:20]}... : {s['title'][:40]}")

    # Find all snapshots
    snapshots = find_snapshots(paths, sessions)
    print(f"\nFound {len(snapshots)} snapshots total")

    if "--list" in sys.argv:
        for snap in snapshots:
            print(f"  {snap['hash']} | {snap['session_title'][:40]}")
        return 0

    # Enter interactive mode
    interactive_mode(paths, snapshots, project_id)

    return 0


if __name__ == "__main__":
    sys.exit(main())
