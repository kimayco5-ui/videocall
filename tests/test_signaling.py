import re

import pytest

from app import app, rooms, socketio


@pytest.fixture
def clients():
    clients = []
    yield clients
    for client in clients:
        client.disconnect()
    rooms.clear()


def connect(clients):
    client = socketio.test_client(app)
    clients.append(client)
    return client


def participant_sid(room_code, name):
    return next(
        sid
        for sid, participant in rooms[room_code]["participants"].items()
        if participant["name"] == name
    )


def test_home_page_is_served():
    response = app.test_client().get("/")
    assert response.status_code == 200
    assert b"WebRTC Group Call" in response.data


def test_create_and_join_room_notifies_existing_participant(clients):
    creator = connect(clients)
    created = creator.emit("create-room", {"name": "  Alice  "}, callback=True)

    assert created["ok"] is True
    assert re.fullmatch(r"[A-Za-z0-9_-]{12,64}", created["roomCode"])

    joiner = connect(clients)
    joined = joiner.emit(
        "join-room",
        {"roomCode": created["roomCode"], "name": "Bob"},
        callback=True,
    )

    assert joined["ok"] is True
    assert joined["participants"] == [
        {"sid": participant_sid(created["roomCode"], "Alice"), "name": "Alice"}
    ]
    joiner_sid = participant_sid(created["roomCode"], "Bob")
    creator_events = creator.get_received()
    assert any(
        event["name"] == "participant-joined"
        and event["args"][0]["sid"] == joiner_sid
        for event in creator_events
    )


def test_invalid_names_and_unknown_rooms_are_rejected(clients):
    client = connect(clients)
    assert client.emit("create-room", {"name": " "}, callback=True)["ok"] is False
    assert client.emit(
        "join-room",
        {"roomCode": "not-a-valid-room", "name": "Alice"},
        callback=True,
    )["ok"] is False
    assert client.emit(
        "join-room",
        {"roomCode": "A" * 16, "name": "Alice"},
        callback=True,
    )["error"] == "That room does not exist or has expired."


def test_creating_another_room_leaves_the_previous_room(clients):
    client = connect(clients)
    first_room = client.emit("create-room", {"name": "Alice"}, callback=True)
    first_sid = participant_sid(first_room["roomCode"], "Alice")
    client.get_received()

    second_room = client.emit("create-room", {"name": "Alice"}, callback=True)

    assert second_room["ok"] is True
    assert second_room["roomCode"] != first_room["roomCode"]
    assert rooms[first_room["roomCode"]]["participants"] == {}
    assert participant_sid(second_room["roomCode"], "Alice") == first_sid
    assert client.get_received() == []


def test_signaling_is_forwarded_only_to_a_room_participant(clients):
    creator = connect(clients)
    created = creator.emit("create-room", {"name": "Alice"}, callback=True)
    joiner = connect(clients)
    joiner.emit(
        "join-room",
        {"roomCode": created["roomCode"], "name": "Bob"},
        callback=True,
    )
    joiner_sid = participant_sid(created["roomCode"], "Bob")
    creator.get_received()
    joiner.get_received()

    description = {"type": "offer", "sdp": "test sdp"}
    creator.emit(
        "webrtc-offer",
        {"targetSid": joiner_sid, "description": description},
    )
    forwarded = joiner.get_received()
    assert len(forwarded) == 1
    assert forwarded[0]["name"] == "webrtc-offer"
    assert forwarded[0]["args"][0]["description"] == description

    creator.emit(
        "webrtc-offer",
        {"targetSid": "not-a-room-participant", "description": description},
    )
    errors = creator.get_received()
    assert any(event["name"] == "server-error" for event in errors)
    assert joiner.get_received() == []


def test_invalid_signal_description_is_rejected(clients):
    client = connect(clients)
    created = client.emit("create-room", {"name": "Alice"}, callback=True)
    peer = connect(clients)
    peer.emit(
        "join-room",
        {"roomCode": created["roomCode"], "name": "Bob"},
        callback=True,
    )
    peer_sid = participant_sid(created["roomCode"], "Bob")
    client.get_received()
    peer.get_received()

    client.emit(
        "webrtc-offer",
        {
            "targetSid": peer_sid,
            "description": {"type": "answer", "sdp": "not an offer"},
        },
    )
    errors = client.get_received()
    assert any(
        event["name"] == "server-error"
        and event["args"][0]["message"] == "Invalid WebRTC description."
        for event in errors
    )


def test_leave_removes_participant_and_room_membership(clients):
    creator = connect(clients)
    created = creator.emit("create-room", {"name": "Alice"}, callback=True)
    joiner = connect(clients)
    joiner.emit(
        "join-room",
        {"roomCode": created["roomCode"], "name": "Bob"},
        callback=True,
    )
    joiner_sid = participant_sid(created["roomCode"], "Bob")
    creator.get_received()

    assert joiner.emit("leave-room", callback=True) == {"ok": True}
    assert creator.get_received() == [
        {"name": "participant-left", "args": [{"sid": joiner_sid}], "namespace": "/"}
    ]
    assert joiner_sid not in rooms[created["roomCode"]]["participants"]
