import os
import re
import secrets
import threading
import time
from urllib.parse import urlsplit

from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room


IDLE_ROOM_TTL_SECONDS = 30 * 60
ROOM_CODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{12,64}$")
MAX_DISPLAY_NAME_LENGTH = 40
MAX_SDP_LENGTH = 65_536
MAX_ICE_CANDIDATE_LENGTH = 4_096
DEFAULT_WEB_ORIGINS = "http://localhost:5000,http://127.0.0.1:5000"


def parse_web_origins(raw_origins):
    origins = [origin.strip() for origin in raw_origins.split(",") if origin.strip()]
    if not origins:
        raise ValueError("WEB_ORIGINS must contain at least one allowed origin.")

    for origin in origins:
        parsed = urlsplit(origin)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or origin == "*"
        ):
            raise ValueError(f"Invalid WEB_ORIGINS entry: {origin}")
    return origins


app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
socketio = SocketIO(
    app,
    async_mode="threading",
    cors_allowed_origins=parse_web_origins(
        os.environ.get("WEB_ORIGINS", DEFAULT_WEB_ORIGINS)
    ),
)

rooms = {}
sid_to_room = {}
rooms_lock = threading.RLock()


@app.get("/")
def index():
    return render_template("index.html")


def _error(message):
    return {"ok": False, "error": message}


def _valid_display_name(value):
    if not isinstance(value, str):
        return None
    name = value.strip()
    if not name or len(name) > MAX_DISPLAY_NAME_LENGTH:
        return None
    return name


def _valid_room_code(value):
    return isinstance(value, str) and ROOM_CODE_PATTERN.fullmatch(value) is not None


def _expire_empty_rooms(now=None):
    now = time.monotonic() if now is None else now
    expired = [
        code
        for code, room in rooms.items()
        if not room["participants"]
        and room["empty_since"] is not None
        and now - room["empty_since"] >= IDLE_ROOM_TTL_SECONDS
    ]
    for code in expired:
        del rooms[code]


def _remove_participant(sid):
    room_code = sid_to_room.pop(sid, None)
    if room_code is None:
        return None

    room = rooms.get(room_code)
    if room is None:
        return None

    participant = room["participants"].pop(sid, None)
    if not room["participants"]:
        room["empty_since"] = time.monotonic()
    if participant is None:
        return None
    return room_code


def _participants(room, exclude_sid=None):
    return [
        {"sid": sid, "name": participant["name"]}
        for sid, participant in room["participants"].items()
        if sid != exclude_sid
    ]


@socketio.on("create-room")
def create_room(data=None):
    if not isinstance(data, dict):
        return _error("A display name is required.")
    name = _valid_display_name(data.get("name"))
    if name is None:
        return _error(
            f"Enter a display name between 1 and {MAX_DISPLAY_NAME_LENGTH} characters."
        )

    sid = request.sid
    with rooms_lock:
        _expire_empty_rooms()
        room_code = secrets.token_urlsafe(12)
        while room_code in rooms:
            room_code = secrets.token_urlsafe(12)

        rooms[room_code] = {
            "participants": {sid: {"name": name}},
            "empty_since": None,
        }
        sid_to_room[sid] = room_code
        join_room(room_code)
    return {"ok": True, "roomCode": room_code, "participants": []}


@socketio.on("join-room")
def join_call_room(data=None):
    if not isinstance(data, dict):
        return _error("A room code and display name are required.")
    room_code = data.get("roomCode")
    name = _valid_display_name(data.get("name"))
    if not _valid_room_code(room_code):
        return _error("Enter a valid room code.")
    if name is None:
        return _error(
            f"Enter a display name between 1 and {MAX_DISPLAY_NAME_LENGTH} characters."
        )

    sid = request.sid
    with rooms_lock:
        _expire_empty_rooms()
        room = rooms.get(room_code)
        if room is None:
            return _error("That room does not exist or has expired.")

        current_room = sid_to_room.get(sid)
        if current_room == room_code:
            room["participants"][sid]["name"] = name
            return {
                "ok": True,
                "roomCode": room_code,
                "participants": _participants(room, sid),
            }

        old_room = _remove_participant(sid)
        if old_room is not None:
            leave_room(old_room)
            emit("participant-left", {"sid": sid}, room=old_room)

        participants = _participants(room)
        room["participants"][sid] = {"name": name}
        room["empty_since"] = None
        sid_to_room[sid] = room_code
        join_room(room_code)
        emit(
            "participant-joined",
            {"sid": sid, "name": name},
            room=room_code,
            skip_sid=sid,
        )
    return {"ok": True, "roomCode": room_code, "participants": participants}


@socketio.on("leave-room")
def leave_call_room():
    sid = request.sid
    with rooms_lock:
        room_code = _remove_participant(sid)
        if room_code is None:
            return {"ok": True}
        leave_room(room_code)
        emit("participant-left", {"sid": sid}, room=room_code)
    return {"ok": True}


def _relay_signal(event, data=None, expected_type=None):
    sid = request.sid
    if not isinstance(data, dict):
        emit("server-error", {"message": "Invalid signaling message."}, to=sid)
        return

    target_sid = data.get("targetSid")
    with rooms_lock:
        room_code = sid_to_room.get(sid)
        room = rooms.get(room_code) if room_code else None
        if (
            room is None
            or not isinstance(target_sid, str)
            or target_sid == sid
            or target_sid not in room["participants"]
        ):
            emit(
                "server-error",
                {"message": "Signaling is only allowed between participants in your room."},
                to=sid,
            )
            return

        if event in {"webrtc-offer", "webrtc-answer"}:
            description = data.get("description")
            if (
                not isinstance(description, dict)
                or description.get("type") != expected_type
                or not isinstance(description.get("sdp"), str)
                or not description["sdp"]
                or len(description["sdp"]) > MAX_SDP_LENGTH
            ):
                emit("server-error", {"message": "Invalid WebRTC description."}, to=sid)
                return
            forwarded = {
                "fromSid": sid,
                "fromName": room["participants"][sid]["name"],
                "description": {
                    "type": expected_type,
                    "sdp": description["sdp"],
                },
            }
        else:
            candidate = data.get("candidate")
            sdp_mid = candidate.get("sdpMid") if isinstance(candidate, dict) else None
            sdp_mline_index = (
                candidate.get("sdpMLineIndex") if isinstance(candidate, dict) else None
            )
            username_fragment = (
                candidate.get("usernameFragment") if isinstance(candidate, dict) else None
            )
            if (
                not isinstance(candidate, dict)
                or not isinstance(candidate.get("candidate"), str)
                or len(candidate["candidate"]) > MAX_ICE_CANDIDATE_LENGTH
                or (sdp_mid is not None and (
                    not isinstance(sdp_mid, str) or len(sdp_mid) > 256
                ))
                or (
                    sdp_mline_index is not None
                    and (
                        isinstance(sdp_mline_index, bool)
                        or not isinstance(sdp_mline_index, int)
                        or not 0 <= sdp_mline_index <= 65_535
                    )
                )
                or (
                    username_fragment is not None
                    and (
                        not isinstance(username_fragment, str)
                        or len(username_fragment) > 256
                    )
                )
            ):
                emit("server-error", {"message": "Invalid ICE candidate."}, to=sid)
                return
            forwarded = {
                "fromSid": sid,
                "fromName": room["participants"][sid]["name"],
                "candidate": {
                    "candidate": candidate["candidate"],
                    "sdpMid": sdp_mid,
                    "sdpMLineIndex": sdp_mline_index,
                    "usernameFragment": username_fragment,
                },
            }

    emit(event, forwarded, to=target_sid)


@socketio.on("webrtc-offer")
def relay_offer(data=None):
    _relay_signal("webrtc-offer", data, expected_type="offer")


@socketio.on("webrtc-answer")
def relay_answer(data=None):
    _relay_signal("webrtc-answer", data, expected_type="answer")


@socketio.on("webrtc-ice-candidate")
def relay_ice_candidate(data=None):
    _relay_signal("webrtc-ice-candidate", data)


@socketio.on("disconnect")
def handle_disconnect(reason=None):
    sid = request.sid
    with rooms_lock:
        room_code = _remove_participant(sid)
        if room_code is not None:
            emit("participant-left", {"sid": sid}, room=room_code)


if __name__ == "__main__":
    socketio.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "5000")),
        debug=False,
    )
