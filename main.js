// ============================================
// MEDIASOUP VANILLA JS CLIENT (main.js)
// ============================================
// Add this to your HTML: <script src="https://unpkg.com/mediasoup-client@3.7.6/dist/mediasoup-client.min.js"></script>
// Make sure socket.io.js is loaded before this script

class MediasoupClient {
    constructor(serverUrl) {
        this.socket = io(serverUrl);
        this.device = null;
        this.roomId = null;
        
        // Transports
        this.sendTransport = null;
        this.recvTransport = null;
        
        // Producers and Consumers
        this.producers = new Map(); // Your outgoing streams
        this.consumers = new Map(); // Incoming streams from others
        
        // Recording
        this.activeRecordings = new Map(); // Track recording IDs
        
        // Callbacks
        this.onNewConsumer = null;
        
        this.setupSocketListeners();
    }

    /**
     * Setup socket event listeners
     */
    setupSocketListeners() {
        // When a new producer is available from another peer
        this.socket.on('newProducer', async (data) => {
            console.log('🎥 New producer available:', data);
            // Automatically consume (receive) the new stream
            await this.consume(data.producerId, data.peerId);
        });

        this.socket.on('disconnect', () => {
            console.log('❌ Disconnected from server');
            this.cleanup();
        });

        this.socket.on('connect', () => {
            console.log('✅ Connected to server');
        });
    }

    /**
     * STEP 1: Join a room
     * Gets the router's RTP capabilities from the server
     */
    async joinRoom(roomId) {
        this.roomId = roomId;
        
        return new Promise((resolve, reject) => {
            this.socket.emit('joinRoom', { roomId }, async (response) => {
                try {
                    console.log('✅ Joined room:', roomId);
                    
                    // Create a new Device (represents your browser's media capabilities)
                    this.device = new mediasoupClient.Device();
                    
                    // Load the device with server's RTP capabilities
                    // This tells your browser what codecs the server supports
                    await this.device.load({ 
                        routerRtpCapabilities: response.rtpCapabilities 
                    });
                    
                    console.log('✅ Device loaded, RTP capabilities received');
                    resolve();
                } catch (error) {
                    console.error('❌ Failed to join room:', error);
                    reject(error);
                }
            });
        });
    }

    /**
     * STEP 2: Create WebRTC transports
     * One for sending (your media) and one for receiving (others' media)
     */
    async createTransports() {
        await this.createSendTransport();
        await this.createRecvTransport();
        console.log('✅ Both transports created');
    }

    /**
     * Create Send Transport (for your camera/microphone)
     */
    async createSendTransport() {
        return new Promise((resolve, reject) => {
            this.socket.emit(
                'createTransport',
                { roomId: this.roomId, direction: 'send' },
                async (response) => {
                    try {
                        // Create send transport with server parameters
                        this.sendTransport = this.device.createSendTransport({
                            id: response.id,
                            iceParameters: response.iceParameters,
                            iceCandidates: response.iceCandidates,
                            dtlsParameters: response.dtlsParameters,
                        });

                        // Event: When transport needs to connect to server
                        this.sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                            try {
                                // Send DTLS parameters to complete the connection
                                this.socket.emit(
                                    'connectTransport',
                                    {
                                        roomId: this.roomId,
                                        transportId: this.sendTransport.id,
                                        dtlsParameters,
                                    },
                                    () => callback()
                                );
                            } catch (error) {
                                errback(error);
                            }
                        });

                        // Event: When starting to send media
                        this.sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
                            try {
                                // Tell server we're producing media
                                this.socket.emit(
                                    'produce',
                                    {
                                        roomId: this.roomId,
                                        transportId: this.sendTransport.id,
                                        kind,
                                        rtpParameters,
                                    },
                                    (response) => {
                                        callback({ id: response.id });
                                    }
                                );
                            } catch (error) {
                                errback(error);
                            }
                        });

                        console.log('✅ Send transport created');
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                }
            );
        });
    }

    /**
     * Create Receive Transport (for receiving others' media)
     */
    async createRecvTransport() {
        return new Promise((resolve, reject) => {
            this.socket.emit(
                'createTransport',
                { roomId: this.roomId, direction: 'recv' },
                async (response) => {
                    try {
                        // Create receive transport
                        this.recvTransport = this.device.createRecvTransport({
                            id: response.id,
                            iceParameters: response.iceParameters,
                            iceCandidates: response.iceCandidates,
                            dtlsParameters: response.dtlsParameters,
                        });

                        // Event: When transport needs to connect
                        this.recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                            try {
                                this.socket.emit(
                                    'connectTransport',
                                    {
                                        roomId: this.roomId,
                                        transportId: this.recvTransport.id,
                                        dtlsParameters,
                                    },
                                    () => callback()
                                );
                            } catch (error) {
                                errback(error);
                            }
                        });

                        console.log('✅ Receive transport created');
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                }
            );
        });
    }

    /**
     * STEP 3: Produce media (send your camera/microphone)
     */
    async produce(track, kind) {
        if (!this.sendTransport) {
            throw new Error('Send transport not created');
        }

        try {
            // Create producer from your media track
            const producer = await this.sendTransport.produce({
                track,
                // For video, enable simulcast (multiple quality levels)
                encodings: kind === 'video' ? [
                    { maxBitrate: 100000, scaleResolutionDownBy: 4 },  // Low
                    { maxBitrate: 300000, scaleResolutionDownBy: 2 },  // Medium
                    { maxBitrate: 900000 }                              // High
                ] : undefined,
                codecOptions: kind === 'video' ? {
                    videoGoogleStartBitrate: 1000
                } : undefined,
            });

            this.producers.set(producer.id, producer);
            console.log(`✅ Producer created: ${kind} (${producer.id})`);

            // Handle events
            producer.on('trackended', () => {
                console.log('Track ended');
                this.closeProducer(producer.id);
            });

            producer.on('transportclose', () => {
                console.log('Transport closed');
                this.producers.delete(producer.id);
            });

            return producer.id;
        } catch (error) {
            console.error('❌ Failed to produce:', error);
            throw error;
        }
    }

    /**
     * STEP 4: Consume media (receive streams from others)
     */
    async consume(producerId, peerId) {
        if (!this.recvTransport) {
            throw new Error('Receive transport not created');
        }

        return new Promise((resolve, reject) => {
            this.socket.emit(
                'consume',
                {
                    roomId: this.roomId,
                    transportId: this.recvTransport.id,
                    producerId,
                    rtpCapabilities: this.device.rtpCapabilities,
                },
                async (response) => {
                    try {
                        // Create consumer to receive media
                        const consumer = await this.recvTransport.consume({
                            id: response.id,
                            producerId: response.producerId,
                            kind: response.kind,
                            rtpParameters: response.rtpParameters,
                        });

                        this.consumers.set(consumer.id, { consumer, peerId });
                        console.log(`✅ Consumer created: ${response.kind} from ${peerId}`);

                        // Resume consumer to start receiving
                        this.socket.emit('resumeConsumer', {
                            roomId: this.roomId,
                            consumerId: consumer.id,
                        });

                        // Notify callback with the consumer
                        if (this.onNewConsumer) {
                            this.onNewConsumer(consumer, peerId);
                        }

                        resolve(consumer);
                    } catch (error) {
                        console.error('❌ Failed to consume:', error);
                        reject(error);
                    }
                }
            );
        });
    }

    /**
     * Start recording a producer
     */
    async startRecording(producerId, kind) {
        return new Promise((resolve, reject) => {
            this.socket.emit(
                'startRecording',
                { roomId: this.roomId, producerId, kind },
                (response) => {
                    if (response.error) {
                        console.error('❌ Failed to start recording:', response.error);
                        reject(new Error(response.error));
                    } else {
                        console.log('🔴 Recording started:', response.recordingId);
                        this.activeRecordings.set(producerId, response.recordingId);
                        resolve(response.recordingId);
                    }
                }
            );
        });
    }

    /**
     * Stop recording
     */
    async stopRecording(recordingId) {
        return new Promise((resolve, reject) => {
            this.socket.emit(
                'stopRecording',
                { recordingId },
                (response) => {
                    if (response.error) {
                        console.error('❌ Failed to stop recording:', response.error);
                        reject(new Error(response.error));
                    } else {
                        console.log('⏹️ Recording stopped:', response.filePath);
                        // Remove from active recordings
                        for (const [producerId, recId] of this.activeRecordings) {
                            if (recId === recordingId) {
                                this.activeRecordings.delete(producerId);
                                break;
                            }
                        }
                        resolve(response.filePath);
                    }
                }
            );
        });
    }

    /**
     * Close a producer (stop sending)
     */
    closeProducer(producerId) {
        const producer = this.producers.get(producerId);
        if (producer) {
            producer.close();
            this.producers.delete(producerId);
            console.log('🛑 Producer closed:', producerId);
        }
    }

    /**
     * Cleanup all resources
     */
    cleanup() {
        // Close all producers
        this.producers.forEach(producer => producer.close());
        this.producers.clear();

        // Close all consumers
        this.consumers.forEach(({ consumer }) => consumer.close());
        this.consumers.clear();

        // Close transports
        if (this.sendTransport) {
            this.sendTransport.close();
            this.sendTransport = null;
        }
        if (this.recvTransport) {
            this.recvTransport.close();
            this.recvTransport = null;
        }

        console.log('🧹 Cleanup complete');
    }

    /**
     * Disconnect from server
     */
    disconnect() {
        this.cleanup();
        this.socket.disconnect();
        console.log('👋 Disconnected');
    }
}

// ============================================
// APP LOGIC - Integrated with your HTML
// ============================================

// Global variables
let mediasoupClient = null;
let localStream = null;
let currentUsername = null;
let currentCallPeerId = null;
let isInCall = false;

// DOM Elements
const usernameInput = document.getElementById('username');
const createUserBtn = document.getElementById('create-user');
const allUsersElement = document.getElementById('allusers');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const endCallBtn = document.getElementById('end-call-btn');

// Initialize MediaSoup client
const SERVER_URL = 'https://webrtc-test-sfu.knot.dating'; // Change to your server URL
mediasoupClient = new MediasoupClient(SERVER_URL);

/**
 * Create/Register user
 */
createUserBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim();
    
    if (!username) {
        alert('Please enter a username');
        return;
    }

    currentUsername = username;
    
    // Hide username input, show call interface
    document.querySelector('.username-input').style.display = 'none';
    
    // Emit user creation to server (you can add this to your gateway)
    mediasoupClient.socket.emit('registerUser', { username });
    
    console.log('✅ User registered:', username);
    
    // Listen for user list updates
    mediasoupClient.socket.on('userList', (users) => {
        updateUserList(users);
    });
});

/**
 * Update user list in sidebar
 */
function updateUserList(users) {
    allUsersElement.innerHTML = '';
    
    users.forEach(user => {
        const li = document.createElement('li');
        
        const span = document.createElement('span');
        span.textContent = user.username + (user.id === mediasoupClient.socket.id ? ' (You)' : '');
        
        const button = document.createElement('button');
        button.className = 'call-btn';
        button.innerHTML = '<img width="20" src="./images/phone.png" alt="Call">';
        
        // Disable call button for yourself
        if (user.id === mediasoupClient.socket.id) {
            button.disabled = true;
            button.style.opacity = '0.5';
        } else {
            button.addEventListener('click', () => startCall(user.id, user.username));
        }
        
        li.appendChild(span);
        li.appendChild(button);
        allUsersElement.appendChild(li);
    });
}

/**
 * Start a call with another user
 */
async function startCall(peerId, peerUsername) {
    if (isInCall) {
        alert('Already in a call');
        return;
    }

    try {
        console.log(`📞 Starting call with ${peerUsername}...`);
        
        currentCallPeerId = peerId;
        isInCall = true;
        
        // Join room (use peerId as room ID or create a unique room)
        const roomId = `room_${Date.now()}`;
        await mediasoupClient.joinRoom(roomId);
        
        // Create transports
        await mediasoupClient.createTransports();
        
        // Get local media (camera + microphone)
        localStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
            },
            audio: true,
        });
        
        // Display local video
        localVideo.srcObject = localStream;
        
        // Produce (send) video and audio
        const videoTrack = localStream.getVideoTracks()[0];
        const audioTrack = localStream.getAudioTracks()[0];
        
        const videoProducerId = await mediasoupClient.produce(videoTrack, 'video');
        const audioProducerId = await mediasoupClient.produce(audioTrack, 'audio');
        
        console.log('✅ Producing video and audio');
        
        // Setup consumer callback (when remote stream arrives)
        mediasoupClient.onNewConsumer = (consumer, peerId) => {
            console.log(`📺 Received ${consumer.kind} from ${peerId}`);
            
            // Create MediaStream from consumer track
            const stream = new MediaStream([consumer.track]);
            
            // Display remote video
            if (consumer.kind === 'video') {
                remoteVideo.srcObject = stream;
            } else {
                // For audio, add track to existing stream or create new one
                if (!remoteVideo.srcObject) {
                    remoteVideo.srcObject = stream;
                } else {
                    remoteVideo.srcObject.addTrack(consumer.track);
                }
            }
        };
        
        // Show end call button
        endCallBtn.classList.remove('d-none');
        
        // Notify peer about the call (add this to your gateway)
        mediasoupClient.socket.emit('callUser', { 
            targetUserId: peerId, 
            roomId 
        });
        
    } catch (error) {
        console.error('❌ Failed to start call:', error);
        alert('Failed to start call: ' + error.message);
        endCall();
    }
}

/**
 * End the current call
 */
function endCall() {
    // Stop all local tracks
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    // Clear video elements
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    
    // Cleanup MediaSoup
    mediasoupClient.cleanup();
    
    // Reset state
    currentCallPeerId = null;
    isInCall = false;
    
    // Hide end call button
    endCallBtn.classList.add('d-none');
    
    console.log('📞 Call ended');
}

// End call button handler
endCallBtn.addEventListener('click', endCall);

/**
 * Handle incoming call
 */
mediasoupClient.socket.on('incomingCall', async ({ callerId, callerUsername, roomId }) => {
    if (isInCall) {
        // Send busy signal
        mediasoupClient.socket.emit('callRejected', { callerId, reason: 'busy' });
        return;
    }
    
    const accept = confirm(`Incoming call from ${callerUsername}. Accept?`);
    
    if (accept) {
        try {
            currentCallPeerId = callerId;
            isInCall = true;
            
            // Join the same room
            await mediasoupClient.joinRoom(roomId);
            await mediasoupClient.createTransports();
            
            // Get local media
            localStream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: true,
            });
            
            localVideo.srcObject = localStream;
            
            // Produce video and audio
            const videoTrack = localStream.getVideoTracks()[0];
            const audioTrack = localStream.getAudioTracks()[0];
            
            await mediasoupClient.produce(videoTrack, 'video');
            await mediasoupClient.produce(audioTrack, 'audio');
            
            // Setup consumer callback
            mediasoupClient.onNewConsumer = (consumer, peerId) => {
                const stream = new MediaStream([consumer.track]);
                if (consumer.kind === 'video') {
                    remoteVideo.srcObject = stream;
                } else {
                    if (!remoteVideo.srcObject) {
                        remoteVideo.srcObject = stream;
                    } else {
                        remoteVideo.srcObject.addTrack(consumer.track);
                    }
                }
            };
            
            endCallBtn.classList.remove('d-none');
            
            // Notify caller that call was accepted
            mediasoupClient.socket.emit('callAccepted', { callerId });
            
        } catch (error) {
            console.error('❌ Failed to accept call:', error);
            alert('Failed to accept call');
            endCall();
        }
    } else {
        mediasoupClient.socket.emit('callRejected', { callerId, reason: 'declined' });
    }
});

/**
 * Handle call ended by other user
 */
mediasoupClient.socket.on('callEnded', () => {
    alert('Call ended by the other user');
    endCall();
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (isInCall) {
        endCall();
    }
    mediasoupClient.disconnect();
});

// ============================================
// OPTIONAL: RECORDING CONTROLS
// ============================================
// You can add recording buttons to your HTML and use these functions:

/**
 * Start recording your video
 */
async function startRecording() {
    const producers = Array.from(mediasoupClient.producers.values());
    const videoProducer = producers.find(p => p.kind === 'video');
    
    if (!videoProducer) {
        alert('No video to record');
        return;
    }
    
    try {
        const recordingId = await mediasoupClient.startRecording(videoProducer.id, 'video');
        console.log('🔴 Recording started:', recordingId);
        // Update UI to show recording is active
    } catch (error) {
        console.error('❌ Failed to start recording:', error);
        alert('Failed to start recording');
    }
}

/**
 * Stop recording
 */
async function stopRecording() {
    const recordingIds = Array.from(mediasoupClient.activeRecordings.values());
    
    if (recordingIds.length === 0) {
        alert('No active recording');
        return;
    }
    
    try {
        const filePath = await mediasoupClient.stopRecording(recordingIds[0]);
        alert('Recording saved to: ' + filePath);
    } catch (error) {
        console.error('❌ Failed to stop recording:', error);
        alert('Failed to stop recording');
    }
}

// Expose functions to window for testing in console
window.mediasoupDebug = {
    startRecording,
    stopRecording,
    endCall,
};