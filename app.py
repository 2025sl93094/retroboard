import json
import secrets
import string
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, jsonify, render_template, request, abort
from flask_socketio import SocketIO, join_room, emit as socket_emit

app = Flask(__name__)
app.config["SECRET_KEY"] = secrets.token_hex(16)
socketio = SocketIO(app, cors_allowed_origins="*")

# board_id -> set of connected session IDs
_board_rooms: dict[str, set] = {}
BOARDS_DIR = Path("boards")
BOARDS_DIR.mkdir(exist_ok=True)

COLUMNS = ["went_well", "didnt_go_well", "action_items"]
COLUMN_LABELS = {
    "went_well": "What Went Well",
    "didnt_go_well": "What Didn't Go Well",
    "action_items": "Action Items",
}


def _board_path(board_id: str) -> Path:
    return BOARDS_DIR / f"{board_id}.json"


def _load_board(board_id: str) -> dict:
    path = _board_path(board_id)
    if not path.exists():
        abort(404)
    return json.loads(path.read_text())


def _save_board(board_id: str, data: dict) -> None:
    _board_path(board_id).write_text(json.dumps(data, indent=2))


def _new_id(length: int = 12) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/board/<board_id>")
def board(board_id):
    data = _load_board(board_id)   # 404 if missing
    fac_token = request.args.get("facilitator", "")
    is_facilitator = bool(fac_token and fac_token == data.get("facilitator_token", ""))
    return render_template(
        "board.html",
        board_id=board_id,
        is_facilitator=is_facilitator,
        facilitator_token=fac_token if is_facilitator else "",
    )


# ── API ───────────────────────────────────────────────────────────────────────

@app.route("/api/boards", methods=["POST"])
def create_board():
    body = request.get_json(silent=True) or {}
    board_id = _new_id()
    facilitator_token = _new_id(16)
    data = {
        "id": board_id,
        "title": body.get("title", "Sprint Retrospective"),
        "created_at": datetime.utcnow().isoformat() + "Z",
        "columns": {col: [] for col in COLUMNS},
        "votes_by_user": {},
        "facilitator_token": facilitator_token,
        "phase": "collecting",
        "notes_revealed": False,
        "columns_locked": False,
        "voting_ends_at": None,
    }
    _save_board(board_id, data)
    return jsonify({"id": board_id, "facilitator_token": facilitator_token}), 201


@app.route("/api/boards/<board_id>", methods=["GET"])
def get_board(board_id):
    data = _load_board(board_id)
    fac_token = request.args.get("facilitator_token", "")
    is_facilitator = bool(fac_token and fac_token == data.get("facilitator_token", ""))

    # Never expose the facilitator token in the response
    out = {k: v for k, v in data.items() if k != "facilitator_token"}

    # Redact note text if notes are not yet revealed (and requester is not facilitator)
    if not data.get("notes_revealed", False) and not is_facilitator:
        for col in COLUMNS:
            redacted = []
            for note in out["columns"][col]:
                redacted.append({**note, "text": "", "hidden": True})
            out["columns"][col] = redacted

    return jsonify(out)


@app.route("/api/boards/<board_id>/notes", methods=["POST"])
def add_note(board_id):
    data = _load_board(board_id)
    body = request.get_json(silent=True) or {}

    if data.get("columns_locked", False):
        return jsonify({"error": "Columns are locked by the facilitator"}), 403

    column = body.get("column")
    text = (body.get("text") or "").strip()

    if column not in COLUMNS:
        return jsonify({"error": "Invalid column"}), 400
    if not text:
        return jsonify({"error": "Note text is required"}), 400
    if len(text) > 500:
        return jsonify({"error": "Note too long (max 500 characters)"}), 400

    note = {
        "id": _new_id(8),
        "text": text,
        "votes": 0,
        "created_at": datetime.utcnow().isoformat() + "Z",
    }
    data["columns"][column].append(note)
    _save_board(board_id, data)
    socketio.emit("board_updated", {}, to=board_id)
    return jsonify(note), 201


@app.route("/api/boards/<board_id>/my_votes", methods=["GET"])
def my_votes(board_id):
    data = _load_board(board_id)
    token = request.args.get("user_token", "")
    voted_notes = data.get("votes_by_user", {}).get(token, [])
    return jsonify({"voted_notes": voted_notes})


@app.route("/api/boards/<board_id>/notes/<note_id>/vote", methods=["POST"])
def vote_note(board_id, note_id):
    data = _load_board(board_id)
    body = request.get_json(silent=True) or {}
    token = (body.get("user_token") or "").strip()
    if not token:
        return jsonify({"error": "user_token is required"}), 400

    votes_by_user = data.setdefault("votes_by_user", {})
    user_votes = votes_by_user.setdefault(token, [])

    for column in COLUMNS:
        for note in data["columns"][column]:
            if note["id"] == note_id:
                if note_id in user_votes:
                    user_votes.remove(note_id)
                    note["votes"] = max(0, note["votes"] - 1)
                    _save_board(board_id, data)
                    socketio.emit("board_updated", {}, to=board_id)
                    return jsonify({"votes": note["votes"], "action": "removed"})
                else:
                    user_votes.append(note_id)
                    note["votes"] += 1
                    _save_board(board_id, data)
                    socketio.emit("board_updated", {}, to=board_id)
                    return jsonify({"votes": note["votes"], "action": "added"})
    return jsonify({"error": "Note not found"}), 404


@app.route("/api/boards/<board_id>/notes/<note_id>", methods=["DELETE"])
def delete_note(board_id, note_id):
    data = _load_board(board_id)
    for column in COLUMNS:
        notes = data["columns"][column]
        for i, note in enumerate(notes):
            if note["id"] == note_id:
                notes.pop(i)
                _save_board(board_id, data)
                socketio.emit("board_updated", {}, to=board_id)
                return jsonify({"ok": True})
    return jsonify({"error": "Note not found"}), 404


# ── Facilitator helpers ───────────────────────────────────────────────────────

def _board_state(data: dict) -> dict:
    return {
        "phase": data.get("phase", "collecting"),
        "notes_revealed": data.get("notes_revealed", False),
        "columns_locked": data.get("columns_locked", False),
        "voting_ends_at": data.get("voting_ends_at"),
    }


def _check_facilitator(board_id: str, body: dict):
    data = _load_board(board_id)
    token = (body.get("facilitator_token") or "").strip()
    if not token or token != data.get("facilitator_token", ""):
        return None, (jsonify({"error": "Invalid or missing facilitator token"}), 403)
    return data, None


# ── Facilitator endpoints ─────────────────────────────────────────────────────

@app.route("/api/boards/<board_id>/facilitator/reveal", methods=["POST"])
def fac_reveal(board_id):
    body = request.get_json(silent=True) or {}
    data, err = _check_facilitator(board_id, body)
    if err:
        return err
    data["notes_revealed"] = not data.get("notes_revealed", False)
    _save_board(board_id, data)
    state = _board_state(data)
    socketio.emit("board_state", state, to=board_id)
    socketio.emit("board_updated", {}, to=board_id)
    return jsonify(state)


@app.route("/api/boards/<board_id>/facilitator/lock", methods=["POST"])
def fac_lock(board_id):
    body = request.get_json(silent=True) or {}
    data, err = _check_facilitator(board_id, body)
    if err:
        return err
    data["columns_locked"] = not data.get("columns_locked", False)
    _save_board(board_id, data)
    state = _board_state(data)
    socketio.emit("board_state", state, to=board_id)
    return jsonify(state)


@app.route("/api/boards/<board_id>/facilitator/phase", methods=["POST"])
def fac_phase(board_id):
    body = request.get_json(silent=True) or {}
    data, err = _check_facilitator(board_id, body)
    if err:
        return err
    phase = body.get("phase", "")
    if phase not in ("collecting", "voting", "discussing"):
        return jsonify({"error": "phase must be collecting, voting, or discussing"}), 400
    data["phase"] = phase
    _save_board(board_id, data)
    state = _board_state(data)
    socketio.emit("board_state", state, to=board_id)
    return jsonify(state)


@app.route("/api/boards/<board_id>/facilitator/timer", methods=["POST"])
def fac_timer(board_id):
    body = request.get_json(silent=True) or {}
    data, err = _check_facilitator(board_id, body)
    if err:
        return err
    minutes = body.get("minutes", 0)
    if minutes and minutes > 0:
        ends_at = (datetime.utcnow() + timedelta(minutes=minutes)).isoformat() + "Z"
        data["voting_ends_at"] = ends_at
    else:
        data["voting_ends_at"] = None
    _save_board(board_id, data)
    state = _board_state(data)
    socketio.emit("board_state", state, to=board_id)
    return jsonify(state)


@app.route("/api/boards/<board_id>/export", methods=["GET"])
def export_board(board_id):
    data = _load_board(board_id)
    today = datetime.utcnow().strftime("%Y-%m-%d")
    counts = {col: len(data["columns"][col]) for col in COLUMNS}
    total = sum(counts.values())
    summary = " · ".join(f"{COLUMN_LABELS[col]}: {counts[col]}" for col in COLUMNS)
    lines = [
        f"# {data['title']}",
        f"> Exported on {today} · Board ID: `{board_id}` · **{total} notes total**",
        f"> {summary}",
        "",
    ]
    for col in COLUMNS:
        notes = data["columns"][col]
        lines.append(f"## {COLUMN_LABELS[col]} ({len(notes)})")
        if notes:
            sorted_notes = sorted(notes, key=lambda n: n["votes"], reverse=True)
            for note in sorted_notes:
                votes = f" _(+{note['votes']} votes)_" if note["votes"] else ""
                lines.append(f"- {note['text']}{votes}")
        else:
            lines.append("_No notes_")
        lines.append("")
    return "\n".join(lines), 200, {
        "Content-Type": "text/markdown",
        "Content-Disposition": f"attachment; filename=retroboard-{today}.md",
    }


# ── Socket.IO events ──────────────────────────────────────────────────────────

@socketio.on("join_board")
def on_join(data):
    board_id = data.get("board_id")
    if not board_id:
        return
    join_room(board_id)
    _board_rooms.setdefault(board_id, set()).add(request.sid)
    count = len(_board_rooms[board_id])
    socket_emit("presence", {"count": count}, to=board_id)


@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    for board_id, sids in _board_rooms.items():
        if sid in sids:
            sids.discard(sid)
            count = len(sids)
            socket_emit("presence", {"count": count}, to=board_id)
            break


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5000)
    args = parser.parse_args()
    socketio.run(app, debug=True, port=args.port)
