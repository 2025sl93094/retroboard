import json
import pytest
from app import app, BOARDS_DIR


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr("app.BOARDS_DIR", tmp_path)
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


# ── Board creation ────────────────────────────────────────────────────────────

def test_create_board_returns_id(client):
    res = client.post("/api/boards", json={"title": "Test Sprint"})
    assert res.status_code == 201
    data = res.get_json()
    assert "id" in data
    assert len(data["id"]) == 12


def test_create_board_default_title(client):
    res = client.post("/api/boards", json={})
    assert res.status_code == 201


def test_get_board(client):
    res  = client.post("/api/boards", json={"title": "My Retro"})
    bid  = res.get_json()["id"]
    res2 = client.get(f"/api/boards/{bid}")
    assert res2.status_code == 200
    data = res2.get_json()
    assert data["title"] == "My Retro"
    assert "went_well" in data["columns"]
    assert "didnt_go_well" in data["columns"]
    assert "action_items" in data["columns"]


def test_get_board_not_found(client):
    res = client.get("/api/boards/doesnotexist")
    assert res.status_code == 404


# ── Notes ─────────────────────────────────────────────────────────────────────

def _make_board(client, title="Retro"):
    res = client.post("/api/boards", json={"title": title})
    return res.get_json()["id"]


def test_add_note(client):
    bid = _make_board(client)
    res = client.post(f"/api/boards/{bid}/notes",
                      json={"column": "went_well", "text": "Great teamwork"})
    assert res.status_code == 201
    note = res.get_json()
    assert note["text"] == "Great teamwork"
    assert note["votes"] == 0


def test_add_note_invalid_column(client):
    bid = _make_board(client)
    res = client.post(f"/api/boards/{bid}/notes",
                      json={"column": "not_a_column", "text": "hi"})
    assert res.status_code == 400


def test_add_note_empty_text(client):
    bid = _make_board(client)
    res = client.post(f"/api/boards/{bid}/notes",
                      json={"column": "went_well", "text": "   "})
    assert res.status_code == 400


def test_add_note_too_long(client):
    bid = _make_board(client)
    res = client.post(f"/api/boards/{bid}/notes",
                      json={"column": "went_well", "text": "x" * 501})
    assert res.status_code == 400


def test_note_appears_in_board(client):
    bid, fac = _make_board_fac(client)
    client.post(f"/api/boards/{bid}/notes",
                json={"column": "action_items", "text": "Fix the CI"})
    board = client.get(f"/api/boards/{bid}?facilitator_token={fac}").get_json()
    texts = [n["text"] for n in board["columns"]["action_items"]]
    assert "Fix the CI" in texts


# ── Voting ────────────────────────────────────────────────────────────────────

def test_vote_note(client):
    bid = _make_board(client)
    nid = client.post(f"/api/boards/{bid}/notes",
                      json={"column": "went_well", "text": "Good demo"}).get_json()["id"]
    res = client.post(f"/api/boards/{bid}/notes/{nid}/vote", json={"user_token": "user1"})
    assert res.status_code == 200
    assert res.get_json()["votes"] == 1
    assert res.get_json()["action"] == "added"


def test_vote_increments(client):
    bid = _make_board(client)
    nids = [
        client.post(f"/api/boards/{bid}/notes",
                    json={"column": "went_well", "text": f"note {i}"}).get_json()["id"]
        for i in range(3)
    ]
    for nid in nids:
        client.post(f"/api/boards/{bid}/notes/{nid}/vote", json={"user_token": "user1"})
    board = client.get(f"/api/boards/{bid}").get_json()
    total_votes = sum(n["votes"] for n in board["columns"]["went_well"])
    assert total_votes == 3


def test_vote_note_not_found(client):
    bid = _make_board(client)
    res = client.post(f"/api/boards/{bid}/notes/fakeid/vote", json={"user_token": "user1"})
    assert res.status_code == 404


def test_toggle_vote_removes(client):
    bid = _make_board(client)
    nid = client.post(f"/api/boards/{bid}/notes",
                      json={"column": "went_well", "text": "x"}).get_json()["id"]
    client.post(f"/api/boards/{bid}/notes/{nid}/vote", json={"user_token": "user1"})
    res = client.post(f"/api/boards/{bid}/notes/{nid}/vote", json={"user_token": "user1"})
    assert res.status_code == 200
    assert res.get_json()["votes"] == 0
    assert res.get_json()["action"] == "removed"


def test_different_users_can_each_vote(client):
    bid = _make_board(client)
    nid = client.post(f"/api/boards/{bid}/notes",
                      json={"column": "went_well", "text": "x"}).get_json()["id"]
    client.post(f"/api/boards/{bid}/notes/{nid}/vote", json={"user_token": "user1"})
    client.post(f"/api/boards/{bid}/notes/{nid}/vote", json={"user_token": "user2"})
    board = client.get(f"/api/boards/{bid}").get_json()
    assert board["columns"]["went_well"][0]["votes"] == 2


# ── Delete ────────────────────────────────────────────────────────────────────

def test_delete_note(client):
    bid = _make_board(client)
    nid = client.post(f"/api/boards/{bid}/notes",
                      json={"column": "didnt_go_well", "text": "Bad deploy"}).get_json()["id"]
    res = client.delete(f"/api/boards/{bid}/notes/{nid}")
    assert res.status_code == 200
    board = client.get(f"/api/boards/{bid}").get_json()
    ids = [n["id"] for n in board["columns"]["didnt_go_well"]]
    assert nid not in ids


def test_delete_note_not_found(client):
    bid = _make_board(client)
    res = client.delete(f"/api/boards/{bid}/notes/fakeid")
    assert res.status_code == 404


# ── Export ────────────────────────────────────────────────────────────────────

def test_export_returns_markdown(client):
    bid = _make_board(client, "Export Test")
    client.post(f"/api/boards/{bid}/notes",
                json={"column": "went_well", "text": "Good sprint"})
    res = client.get(f"/api/boards/{bid}/export")
    assert res.status_code == 200
    assert b"Export Test" in res.data
    assert b"Good sprint" in res.data
    assert b"What Went Well" in res.data


def test_export_includes_all_columns(client):
    bid = _make_board(client)
    res = client.get(f"/api/boards/{bid}/export")
    text = res.data.decode()
    assert "What Went Well" in text
    assert "What Didn't Go Well" in text
    assert "Action Items" in text


# ── Facilitator Mode ──────────────────────────────────────────────────────────

def _make_board_fac(client, title="Retro"):
    res = client.post("/api/boards", json={"title": title})
    data = res.get_json()
    return data["id"], data["facilitator_token"]


def test_facilitator_token_in_create_response(client):
    res = client.post("/api/boards", json={"title": "Fac Test"})
    assert res.status_code == 201
    data = res.get_json()
    assert "facilitator_token" in data
    assert len(data["facilitator_token"]) == 16


def test_notes_hidden_by_default(client):
    bid, fac = _make_board_fac(client)
    client.post(f"/api/boards/{bid}/notes",
                json={"column": "went_well", "text": "Secret note"})
    # Regular participant — no token
    board = client.get(f"/api/boards/{bid}").get_json()
    notes = board["columns"]["went_well"]
    assert len(notes) == 1
    assert notes[0]["hidden"] is True
    assert notes[0]["text"] == ""


def test_notes_visible_to_facilitator(client):
    bid, fac = _make_board_fac(client)
    client.post(f"/api/boards/{bid}/notes",
                json={"column": "went_well", "text": "Secret note"})
    board = client.get(f"/api/boards/{bid}?facilitator_token={fac}").get_json()
    notes = board["columns"]["went_well"]
    assert notes[0]["text"] == "Secret note"
    assert "hidden" not in notes[0]


def test_reveal_requires_token(client):
    bid, _ = _make_board_fac(client)
    res = client.post(f"/api/boards/{bid}/facilitator/reveal",
                      json={"facilitator_token": "wrong"})
    assert res.status_code == 403


def test_reveal_toggles_visibility(client):
    bid, fac = _make_board_fac(client)
    client.post(f"/api/boards/{bid}/notes",
                json={"column": "went_well", "text": "Hello"})

    # Reveal
    client.post(f"/api/boards/{bid}/facilitator/reveal",
                json={"facilitator_token": fac})
    board = client.get(f"/api/boards/{bid}").get_json()
    assert board["columns"]["went_well"][0]["text"] == "Hello"

    # Hide again
    client.post(f"/api/boards/{bid}/facilitator/reveal",
                json={"facilitator_token": fac})
    board = client.get(f"/api/boards/{bid}").get_json()
    assert board["columns"]["went_well"][0]["hidden"] is True


def test_lock_blocks_add_note(client):
    bid, fac = _make_board_fac(client)
    client.post(f"/api/boards/{bid}/facilitator/lock",
                json={"facilitator_token": fac})
    res = client.post(f"/api/boards/{bid}/notes",
                      json={"column": "went_well", "text": "Blocked"})
    assert res.status_code == 403


def test_phase_change(client):
    bid, fac = _make_board_fac(client)
    res = client.post(f"/api/boards/{bid}/facilitator/phase",
                      json={"facilitator_token": fac, "phase": "voting"})
    assert res.status_code == 200
    assert res.get_json()["phase"] == "voting"


def test_timer_set_and_clear(client):
    bid, fac = _make_board_fac(client)

    # Set 5-minute timer
    res = client.post(f"/api/boards/{bid}/facilitator/timer",
                      json={"facilitator_token": fac, "minutes": 5})
    assert res.status_code == 200
    assert res.get_json()["voting_ends_at"] is not None

    # Clear timer
    res = client.post(f"/api/boards/{bid}/facilitator/timer",
                      json={"facilitator_token": fac, "minutes": 0})
    assert res.status_code == 200
    assert res.get_json()["voting_ends_at"] is None

