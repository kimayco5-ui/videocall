# WebRTC Group Call

A small-group video calling web app built with Flask, Flask-SocketIO, and browser WebRTC. Flask serves the interface and relays room events and WebRTC signaling; audio and video travel between participants' browsers, not through Flask or Render. Calls are not recorded.

The Socket.IO browser client is bundled at `static/js/vendor/socket.io.min.js` and served by Flask from the same origin as the app.

## Create rooms from another web project

Create a room with the public `POST /api/rooms` endpoint. The response includes the room code, a normal share link, an iframe-ready link, and the time (in seconds) an unjoined empty room remains available:

```javascript
const response = await fetch("https://your-call-service.onrender.com/api/rooms", {
  method: "POST",
});
if (!response.ok) {
  throw new Error(`Room creation failed: ${response.status}`);
}
const room = await response.json();
console.log(room.room_code, room.share_url, room.embed_url);
```

Example response:

```json
{
  "room_code": "aRandomRoomCode",
  "share_url": "https://your-call-service.onrender.com/?room=aRandomRoomCode",
  "embed_url": "https://your-call-service.onrender.com/embed?room=aRandomRoomCode",
  "expires_in_seconds": 1800
}
```

Add the returned `share_url` to an invite or render the embedded call page in your site:

```html
<iframe
  src="https://your-call-service.onrender.com/embed?room=aRandomRoomCode"
  title="Video call"
  allow="camera; microphone; autoplay"
  allowfullscreen
  style="width: 100%; min-height: 640px; border: 0"
></iframe>
```

The embed page fills in the room code and asks each guest for a display name before they join and grant camera/microphone access. Configure `WEB_ORIGINS` with both the call service's own origin and each parent website origin, comma-separated. The allowlist controls API CORS and the iframe's `frame-ancestors` policy; arbitrary origins are not allowed. For example:

```text
WEB_ORIGINS=https://your-call-service.onrender.com,https://your-web-app.example
```

Room creation is public and does not use an API key, as room codes are bearer links. Anyone with the returned link can join. Anonymous room creation can be abused; use deployment-level rate limiting or add API authentication before offering the endpoint to untrusted public clients.

## Features

- Create a room with a random, hard-to-guess code or join with a code.
- Display local and remote video, participant names, and connection state.
- Mute/unmute the microphone, turn the camera off/on, and leave the call.
- Clean up peer connections when someone leaves, retry failed ICE connections, and rejoin signaling rooms after a temporary Socket.IO interruption.
- Validate room membership and WebRTC signaling payloads on the server.

Anyone with a room code can join. There are no accounts or room passwords in this MVP; share codes only with the people you intend to invite.

## Requirements

- Python 3.10 or later.
- A current desktop or mobile browser with WebRTC support.
- Camera and microphone permission. Browsers generally require HTTPS, except for localhost development.

## Run locally

From the project directory in PowerShell:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:WEB_ORIGINS = "http://localhost:5000,http://127.0.0.1:5000"
python app.py
```

Open <http://localhost:5000> in two or more browser windows/devices. Allow camera and microphone access in each browser. A room is created in memory and is available for up to 30 minutes after all participants leave or disconnect.

Run the signaling tests with:

```powershell
python -m pytest
```

## Deploy to Render

1. Push this project to a Git repository and create a Render **Blueprint** using the included `render.yaml`, or create a Python web service with the same build and start commands.
2. After Render assigns the service URL, set `WEB_ORIGINS` in the service environment to that exact origin, for example `https://your-service.onrender.com` (no path or trailing slash). This setting is required: the server intentionally does not allow arbitrary browser origins.
3. Deploy the service and open its HTTPS URL. Keep one Gunicorn worker: room membership lives in process memory.

The Blueprint uses:

```text
Build: pip install -r requirements.txt
Start: gunicorn --worker-class gthread --workers 1 --threads 100 --timeout 120 app:app
```

If Render logs show `gunicorn your_application.wsgi`, the service has a stale Start Command saved in its dashboard. Open **Settings → Build & Deploy → Start Command** and replace it with the command above, then save and redeploy the latest commit. Pushing `render.yaml` does not necessarily override a command manually configured on an existing web service.

WebSocket support is enabled through Flask-SocketIO's threading mode and `simple-websocket`. Do not increase the worker count or run multiple app instances without moving room state to a shared Socket.IO message queue and coordinating the application state.

## Network connectivity and capacity

The browser client uses public Google STUN servers for direct connection discovery. STUN is not a relay and cannot connect every pair of networks. For users behind restrictive NATs or firewalls, configure a TURN service and pass its URL and credentials to the browser's `RTCPeerConnection` configuration. TURN is not provisioned by this project; keep credentials in deployment secrets and do not publish private TURN credentials in client source.

This is a peer-to-peer **mesh**, not an SFU. Each participant sends media separately to each other participant, so upload bandwidth and CPU load grow with room size. No maximum capacity is claimed. Test with real browsers and media at 2, then 4, 6, and 8 participants; measure join success, connection time, upload/download bandwidth, CPU, memory, and disconnect rate. Signaling-client simulations do not measure real media capacity. Evaluate a separately deployed SFU if larger rooms are needed.

## Operational and security limitations

- Room membership is stored in memory. Active rooms are lost on process restarts, and this configuration is intended for one application process/instance.
- Empty rooms expire after 30 minutes. There is no persistent room directory or user authentication.
- The default allowed browser origins are local development URLs. Set `WEB_ORIGINS` to a comma-separated list of exact `http://` or `https://` origins in other environments.
- The app validates signaling membership and message shape, but room codes are bearer secrets rather than identity verification.
- Use HTTPS in production. No audio or video recording/storage is implemented.
- A failed STUN-only connection may require TURN; a server-side media relay is not included.
