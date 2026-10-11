(() => {
  const socket = io();
  const elements = {
    welcomePanel: document.getElementById("welcome-panel"),
    callPanel: document.getElementById("call-panel"),
    joinForm: document.getElementById("join-form"),
    displayName: document.getElementById("display-name"),
    roomCodeInput: document.getElementById("room-code"),
    joinButton: document.getElementById("join-button"),
    createButton: document.getElementById("create-button"),
    notice: document.getElementById("notice"),
    connectionIndicator: document.getElementById("connection-indicator"),
    connectionLabel: document.getElementById("connection-label"),
    roomCode: document.getElementById("active-room-code"),
    copyRoomCode: document.getElementById("copy-room-code"),
    videoGrid: document.getElementById("video-grid"),
    participantCount: document.getElementById("participant-count"),
    participantList: document.getElementById("participant-list"),
    microphoneButton: document.getElementById("microphone-button"),
    microphoneLabel: document.getElementById("microphone-label"),
    cameraButton: document.getElementById("camera-button"),
    cameraLabel: document.getElementById("camera-label"),
    leaveButton: document.getElementById("leave-button"),
  };

  const peerConnections = new Map();
  const participants = new Map();
  const peerConfiguration = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };

  let localStream = null;
  let roomCode = null;
  let localName = null;
  let inCall = false;
  let joining = false;
  let rejoinAfterConnect = false;
  let microphoneEnabled = true;
  let cameraEnabled = true;

  function showNotice(message, tone = "info") {
    elements.notice.textContent = message || "";
    elements.notice.classList.toggle("notice-error", tone === "error");
    elements.notice.classList.toggle("notice-success", tone === "success");
  }

  function setConnectionState(state, label) {
    elements.connectionIndicator.classList.remove("connected", "disconnected");
    if (state) {
      elements.connectionIndicator.classList.add(state);
    }
    elements.connectionLabel.textContent = label;
  }

  function request(eventName, payload) {
    return new Promise((resolve, reject) => {
      if (!socket.connected) {
        reject(new Error("The signaling server is not connected. Please try again."));
        return;
      }

      const timeout = window.setTimeout(() => {
        reject(new Error("The server did not respond. Please try again."));
      }, 12000);

      socket.emit(eventName, payload, (response) => {
        window.clearTimeout(timeout);
        if (!response || response.ok !== true) {
          reject(new Error(response?.error || "The server rejected the request."));
          return;
        }
        resolve(response);
      });
    });
  }

  function waitForSocket() {
    if (socket.connected) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let finished = false;
      const timeout = window.setTimeout(() => {
        finish(new Error("Could not connect to the call server. Check your connection and try again."));
      }, 15000);

      function cleanup() {
        window.clearTimeout(timeout);
        socket.off("connect", onConnect);
        socket.off("connect_error", onConnectError);
      }

      function finish(error) {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }

      function onConnect() {
        finish();
      }

      function onConnectError() {
        if (socket.active === false) {
          finish(new Error("Could not connect to the call server. Check your connection and try again."));
        }
      }

      socket.on("connect", onConnect);
      socket.on("connect_error", onConnectError);
    });
  }

  function createVideoTile(id, name, local = false) {
    const tile = document.createElement("article");
    tile.className = "video-tile";
    tile.dataset.participantId = id;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = local;
    if (local) {
      video.classList.add("hidden-video");
    }

    const status = document.createElement("span");
    status.className = "video-tile-status";
    status.textContent = local ? "You" : "Connecting";

    const label = document.createElement("span");
    label.className = "video-tile-name";
    label.textContent = local ? `${name} (you)` : name;

    tile.append(video, status, label);
    elements.videoGrid.append(tile);
    return { tile, video, status, label };
  }

  function addParticipant(id, name, status = "Connecting") {
    const existing = participants.get(id);
    if (existing) {
      existing.name = name;
      existing.status = status;
      if (existing.tile) {
        existing.tile.label.textContent = name;
        existing.tile.statusElement.textContent = status;
      }
    } else {
      participants.set(id, { name, status, tile: null });
    }
    renderParticipants();
  }

  function renderParticipants() {
    elements.participantList.replaceChildren();
    const entries = [];
    if (inCall) {
      entries.push({ id: "local", name: localName, status: "You" });
    }
    for (const [id, participant] of participants) {
      entries.push({ id, name: participant.name, status: participant.status });
    }

    elements.participantCount.textContent = String(entries.length);
    for (const participant of entries) {
      const item = document.createElement("li");
      const avatar = document.createElement("span");
      avatar.className = "participant-avatar";
      avatar.textContent = (participant.name || "?").slice(0, 1).toUpperCase();

      const name = document.createElement("span");
      name.className = "participant-name";
      name.textContent = participant.id === "local"
        ? `${participant.name} (you)`
        : participant.name;

      const status = document.createElement("span");
      status.className = "participant-status";
      status.textContent = participant.status;
      item.append(avatar, name, status);
      elements.participantList.append(item);
    }
  }

  function setParticipantStatus(id, status) {
    const participant = participants.get(id);
    if (!participant) {
      return;
    }
    participant.status = status;
    if (participant.tile) {
      participant.tile.statusElement.textContent = status;
    }
    renderParticipants();
  }

  function ensurePeer(peerId, peerName) {
    const existing = peerConnections.get(peerId);
    if (existing) {
      const name = peerName || existing.name;
      existing.name = name;
      addParticipant(peerId, name, existing.status);
      return existing;
    }

    addParticipant(peerId, peerName || "Participant");
    const participant = participants.get(peerId);
    const tile = createVideoTile(peerId, participant.name);
    participant.tile = {
      element: tile.tile,
      video: tile.video,
      statusElement: tile.status,
      label: tile.label,
    };

    const pc = new RTCPeerConnection(peerConfiguration);
    const peer = {
      pc,
      name: participant.name,
      status: "Connecting",
      pendingCandidates: [],
      restartTimer: null,
      restarting: false,
    };
    peerConnections.set(peerId, peer);

    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }

    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      tile.video.srcObject = stream;
      tile.video.classList.remove("hidden-video");
      tile.status.textContent = "Live";
      setParticipantStatus(peerId, "Connected");
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && socket.connected && peerConnections.has(peerId)) {
        socket.emit("webrtc-ice-candidate", {
          targetSid: peerId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "connected") {
        peer.status = "Connected";
        setParticipantStatus(peerId, "Connected");
      } else if (state === "failed") {
        peer.status = "Reconnecting";
        setParticipantStatus(peerId, "Reconnecting");
        restartPeer(peerId, peer);
      } else if (state === "disconnected") {
        peer.status = "Reconnecting";
        setParticipantStatus(peerId, "Reconnecting");
        window.clearTimeout(peer.restartTimer);
        peer.restartTimer = window.setTimeout(() => {
          if (
            peerConnections.get(peerId) === peer
            && peer.pc.connectionState === "disconnected"
          ) {
            restartPeer(peerId, peer);
          }
        }, 4000);
      } else if (state === "connecting") {
        setParticipantStatus(peerId, "Connecting");
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        restartPeer(peerId, peer);
      }
    };
    return peer;
  }

  async function flushCandidates(peer) {
    while (peer.pendingCandidates.length > 0) {
      await peer.pc.addIceCandidate(peer.pendingCandidates.shift());
    }
  }

  async function sendOffer(peerId, peer, options = {}) {
    const offer = await peer.pc.createOffer(options);
    await peer.pc.setLocalDescription(offer);
    socket.emit("webrtc-offer", {
      targetSid: peerId,
      description: peer.pc.localDescription.toJSON(),
    });
  }

  async function initiatePeerOffer(participant) {
    const peer = ensurePeer(participant.sid, participant.name);
    try {
      await sendOffer(participant.sid, peer);
    } catch (error) {
      setParticipantStatus(participant.sid, "Connection failed");
      showNotice(`Could not start a connection to ${participant.name}: ${error.message}`, "error");
    }
  }

  async function restartPeer(peerId, peer) {
    if (
      peerConnections.get(peerId) !== peer
      || !socket.connected
      || peer.pc.signalingState !== "stable"
      || peer.restarting
      || !socket.id
      || socket.id.localeCompare(peerId) >= 0
    ) {
      return;
    }
    peer.restarting = true;
    try {
      await sendOffer(peerId, peer, { iceRestart: true });
    } catch (error) {
      if (peerConnections.get(peerId) === peer) {
        showNotice(`Could not reconnect to ${peer.name}: ${error.message}`, "error");
      }
    } finally {
      peer.restarting = false;
    }
  }

  async function handleOffer(data) {
    if (!data || !data.fromSid || !data.description) {
      return;
    }
    const peer = ensurePeer(data.fromSid, data.fromName);
    try {
      await peer.pc.setRemoteDescription(data.description);
      await flushCandidates(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit("webrtc-answer", {
        targetSid: data.fromSid,
        description: peer.pc.localDescription.toJSON(),
      });
    } catch (error) {
      showNotice(`Could not connect to ${peer.name}: ${error.message}`, "error");
    }
  }

  async function handleAnswer(data) {
    const peer = data && peerConnections.get(data.fromSid);
    if (!peer || !data.description) {
      return;
    }
    try {
      await peer.pc.setRemoteDescription(data.description);
      await flushCandidates(peer);
    } catch (error) {
      showNotice(`Could not finish connecting to ${peer.name}: ${error.message}`, "error");
    }
  }

  async function handleIceCandidate(data) {
    if (!data || !data.fromSid || !data.candidate) {
      return;
    }
    const peer = ensurePeer(data.fromSid, data.fromName);
    try {
      if (peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(data.candidate);
      } else {
        peer.pendingCandidates.push(data.candidate);
      }
    } catch (error) {
      showNotice(`Could not establish a network path to ${peer.name}: ${error.message}`, "error");
    }
  }

  async function startCall(createNewRoom) {
    if (joining) {
      return;
    }
    joining = true;
    elements.joinButton.disabled = true;
    elements.createButton.disabled = true;
    showNotice("");

    const name = elements.displayName.value.trim();
    const requestedRoomCode = elements.roomCodeInput.value.trim();
    try {
      if (!name || name.length > 40) {
        throw new Error("Enter a name between 1 and 40 characters.");
      }
      if (!createNewRoom && !requestedRoomCode) {
        throw new Error("Enter a room code to join, or create a new room.");
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("This browser cannot access camera and microphone. Use a current browser over HTTPS or localhost.");
      }

      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      await waitForSocket();
      const response = await request(
        createNewRoom ? "create-room" : "join-room",
        createNewRoom
          ? { name }
          : { name, roomCode: requestedRoomCode },
      );

      roomCode = response.roomCode;
      localName = name;
      inCall = true;
      elements.welcomePanel.hidden = true;
      elements.callPanel.hidden = false;
      elements.roomCode.textContent = roomCode;
      const localTile = createVideoTile("local", localName, true);
      localTile.video.srcObject = localStream;
      localTile.video.classList.remove("hidden-video");
      localTile.status.textContent = "You";

      for (const participant of response.participants) {
        addParticipant(participant.sid, participant.name);
      }
      renderParticipants();

      await Promise.all(response.participants.map(initiatePeerOffer));
      showNotice("Share the room code with the people you want to invite.");
    } catch (error) {
      stopLocalStream();
      showNotice(error.message || "Could not start the call.", "error");
    } finally {
      joining = false;
      elements.joinButton.disabled = false;
      elements.createButton.disabled = false;
    }
  }

  function stopLocalStream() {
    if (localStream) {
      for (const track of localStream.getTracks()) {
        track.stop();
      }
      localStream = null;
    }
  }

  function closePeer(peerId) {
    const peer = peerConnections.get(peerId);
    if (peer) {
      window.clearTimeout(peer.restartTimer);
      peer.pc.ontrack = null;
      peer.pc.onicecandidate = null;
      peer.pc.close();
      peerConnections.delete(peerId);
    }
    const participant = participants.get(peerId);
    if (participant?.tile) {
      participant.tile.element.remove();
    }
    participants.delete(peerId);
    renderParticipants();
  }

  function closeAllPeers() {
    for (const peerId of peerConnections.keys()) {
      closePeer(peerId);
    }
    participants.clear();
    renderParticipants();
  }

  function resetToLobby() {
    closeAllPeers();
    stopLocalStream();
    inCall = false;
    roomCode = null;
    localName = null;
    rejoinAfterConnect = false;
    elements.callPanel.hidden = true;
    elements.welcomePanel.hidden = false;
    elements.videoGrid.replaceChildren();
    microphoneEnabled = true;
    cameraEnabled = true;
    updateMediaButtons();
  }

  async function rejoinRoom() {
    if (!inCall || !roomCode) {
      return;
    }
    const reconnectRoomCode = roomCode;
    closeAllPeers();
    try {
      const response = await request("join-room", {
        roomCode: reconnectRoomCode,
        name: localName,
      });
      for (const participant of response.participants) {
        addParticipant(participant.sid, participant.name);
      }
      await Promise.all(response.participants.map(initiatePeerOffer));
      showNotice("Reconnected to the call.", "success");
    } catch (error) {
      resetToLobby();
      showNotice(`Could not rejoin the call: ${error.message}`, "error");
    }
  }

  function updateMediaButtons() {
    elements.microphoneButton.setAttribute("aria-pressed", String(microphoneEnabled));
    elements.microphoneLabel.textContent = microphoneEnabled ? "Mute mic" : "Unmute mic";
    elements.cameraButton.setAttribute("aria-pressed", String(cameraEnabled));
    elements.cameraLabel.textContent = cameraEnabled ? "Turn camera off" : "Turn camera on";
  }

  elements.joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    startCall(false);
  });

  elements.createButton.addEventListener("click", () => startCall(true));

  elements.microphoneButton.addEventListener("click", () => {
    if (!localStream) {
      return;
    }
    microphoneEnabled = !microphoneEnabled;
    for (const track of localStream.getAudioTracks()) {
      track.enabled = microphoneEnabled;
    }
    updateMediaButtons();
  });

  elements.cameraButton.addEventListener("click", () => {
    if (!localStream) {
      return;
    }
    cameraEnabled = !cameraEnabled;
    for (const track of localStream.getVideoTracks()) {
      track.enabled = cameraEnabled;
    }
    updateMediaButtons();
  });

  elements.copyRoomCode.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(roomCode);
      elements.copyRoomCode.textContent = "Copied";
      window.setTimeout(() => {
        elements.copyRoomCode.textContent = "Copy";
      }, 1500);
    } catch (error) {
      showNotice("Clipboard access failed. Select and copy the room code manually.", "error");
    }
  });

  elements.leaveButton.addEventListener("click", () => {
    if (socket.connected) {
      socket.emit("leave-room");
    }
    resetToLobby();
    showNotice("You left the call.", "success");
  });

  socket.on("connect", () => {
    setConnectionState("connected", "Connected");
    if (rejoinAfterConnect && inCall) {
      rejoinAfterConnect = false;
      rejoinRoom();
    }
  });

  socket.on("disconnect", () => {
    setConnectionState("disconnected", "Reconnecting");
    if (inCall) {
      rejoinAfterConnect = true;
      showNotice("Signaling connection lost. Trying to reconnect…", "info");
    }
  });

  socket.on("connect_error", () => {
    setConnectionState("disconnected", "Connection issue");
  });

  socket.on("participant-joined", (participant) => {
    if (inCall && participant && participant.sid) {
      addParticipant(participant.sid, participant.name);
    }
  });

  socket.on("participant-left", (participant) => {
    if (participant && participant.sid) {
      closePeer(participant.sid);
    }
  });

  socket.on("webrtc-offer", handleOffer);
  socket.on("webrtc-answer", handleAnswer);
  socket.on("webrtc-ice-candidate", handleIceCandidate);

  socket.on("server-error", (error) => {
    if (error && typeof error.message === "string") {
      showNotice(error.message, "error");
    }
  });
})();
