const createUserBtn = document.getElementById("create-user");
const username = document.getElementById("username");
const allusersHtml = document.getElementById("allusers");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const endCallBtn = document.getElementById("end-call-btn");

// IMPORTANT: CONNECT TO REMOTE NESTJS SERVER
const socket = io("https://34.102.240.255", {
    transports: ["websocket", "polling"], // always include polling first
  });
  
  

let localStream;
let caller = [];

// Peer connection wrapper
const PeerConnection = (function(){
    let peerConnection;

    const createPeerConnection = () => {
        const config = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        };

        peerConnection = new RTCPeerConnection(config);

        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });

        peerConnection.ontrack = function(event) {
            remoteVideo.srcObject = event.streams[0];
        };

        peerConnection.onicecandidate = function(event) {
            if(event.candidate) {
                socket.emit("icecandidate", { candidate: event.candidate, by: username.value });
            }
        };

        return peerConnection;
    };

    return {
        getInstance: () => {
            if(!peerConnection) {
                peerConnection = createPeerConnection();
            }
            return peerConnection;
        }
    };
})();

// Join user
createUserBtn.addEventListener("click", () => {
    console.log("Emitting join-user for:", username.value, "  -> ", socket.id);
    if(username.value !== "") {
        const box = document.querySelector(".username-input");
        socket.emit("join-user", username.value);
        box.style.display = 'none';
    }
});

// User list
socket.on("joined", allusers => {
    allusersHtml.innerHTML = "";

    for(const user in allusers) {
        const li = document.createElement("li");
        li.textContent = `${user} ${user === username.value ? "(You)" : ""}`;

        if(user !== username.value) {
            const btn = document.createElement("button");
            btn.classList.add("call-btn");
            btn.addEventListener("click", () => startCall(user));

            const img = document.createElement("img");
            img.src = "./images/phone.png";
            img.width = 20;

            btn.appendChild(img);
            li.appendChild(btn);
        }

        allusersHtml.appendChild(li);
    }
});

// Offer received
socket.on("offer", async ({ from, to, offer }) => {
    const pc = PeerConnection.getInstance();
    await pc.setRemoteDescription(offer);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("answer", { from, to, answer: pc.localDescription });

    caller = [from, to];
});

// Answer received
socket.on("answer", async ({ from, to, answer }) => {
    const pc = PeerConnection.getInstance();
    await pc.setRemoteDescription(answer);

    endCallBtn.style.display = "block";
    caller = [from, to];
});

// ICE candidate
socket.on("icecandidate", async ({ candidate }) => {
    const pc = PeerConnection.getInstance();
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// End call
socket.on("call-ended", () => endCall());


socket.on("connect", () => {
    console.log("Socket connected with id:", socket.id);
});

socket.on("connect_error", (err) => {
    console.log("Socket connection error:", err);
});

// Initiate call
const startCall = async (user) => {
    const pc = PeerConnection.getInstance();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit("offer", {
        from: username.value,
        to: user,
        offer: pc.localDescription
    });
};

// End call
const endCall = () => {
    const pc = PeerConnection.getInstance();
    if(pc) {
        pc.close();
        endCallBtn.style.display = 'none';
    }
};

// Start local video
const startMyVideo = async () => {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        localVideo.srcObject = localStream;
    } catch (err) {
        console.error("Camera error: ", err);
    }
};

startMyVideo();
