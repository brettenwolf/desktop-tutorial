/**
 * AudioManager - WebRTC-based audio streaming for group reading
 * Handles peer-to-peer audio connections within sub-groups
 */
class AudioManager {
  constructor(sessionId, subGroup, apiUrl) {
    this.sessionId = sessionId;
    this.subGroup = subGroup;
    this.apiUrl = apiUrl;
    this.localStream = null;
    this.peerConnections = {};
    this.isMuted = true;
    this.isInitialized = false;
    this.pollingInterval = null;
  }

  async initialize(startMuted = true) {
    try {
      // Check if WebRTC is supported
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.log('WebRTC not supported in this browser');
        return false;
      }

      // Request microphone access
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      // Set initial mute state
      this.isMuted = startMuted;
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !startMuted;
      });

      this.isInitialized = true;

      // Start polling for signals and peers
      this.startSignalPolling();
      this.connectToPeers();

      console.log(`AudioManager initialized for sub-group: ${this.subGroup}`);
      return true;
    } catch (error) {
      console.error('Error initializing audio:', error);
      return false;
    }
  }

  async connectToPeers() {
    try {
      const response = await fetch(`${this.apiUrl}/webrtc/peers?subGroup=${encodeURIComponent(this.subGroup)}`);
      if (response.ok) {
        const data = await response.json();
        const peers = data.peers || [];

        for (const peer of peers) {
          if (peer.sessionId !== this.sessionId && !this.peerConnections[peer.sessionId]) {
            await this.createPeerConnection(peer.sessionId);
          }
        }
      }
    } catch (error) {
      console.error('Error connecting to peers:', error);
    }
  }

  async createPeerConnection(peerId) {
    try {
      const config = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      };

      const pc = new RTCPeerConnection(config);
      this.peerConnections[peerId] = pc;

      // Add local tracks
      if (this.localStream) {
        this.localStream.getTracks().forEach(track => {
          pc.addTrack(track, this.localStream);
        });
      }

      // Handle incoming tracks
      pc.ontrack = (event) => {
        console.log(`Received remote track from ${peerId}`);
        const audio = new Audio();
        audio.srcObject = event.streams[0];
        audio.autoplay = true;
        audio.id = `audio-${peerId}`;
        document.body.appendChild(audio);
      };

      // Handle ICE candidates
      pc.onicecandidate = async (event) => {
        if (event.candidate) {
          await this.sendSignal(peerId, 'ice-candidate', { candidate: event.candidate });
        }
      };

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.sendSignal(peerId, 'offer', { sdp: offer });

      console.log(`Created peer connection to ${peerId}`);
    } catch (error) {
      console.error(`Error creating peer connection to ${peerId}:`, error);
    }
  }

  async handleSignal(signal) {
    const { from, type, data } = signal;

    try {
      if (type === 'offer') {
        // Handle incoming offer
        let pc = this.peerConnections[from];
        if (!pc) {
          pc = new RTCPeerConnection({
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
            ],
          });
          this.peerConnections[from] = pc;

          if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
              pc.addTrack(track, this.localStream);
            });
          }

          pc.ontrack = (event) => {
            const audio = new Audio();
            audio.srcObject = event.streams[0];
            audio.autoplay = true;
            audio.id = `audio-${from}`;
            document.body.appendChild(audio);
          };

          pc.onicecandidate = async (event) => {
            if (event.candidate) {
              await this.sendSignal(from, 'ice-candidate', { candidate: event.candidate });
            }
          };
        }

        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.sendSignal(from, 'answer', { sdp: answer });

      } else if (type === 'answer') {
        const pc = this.peerConnections[from];
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        }

      } else if (type === 'ice-candidate') {
        const pc = this.peerConnections[from];
        if (pc && data.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      }
    } catch (error) {
      console.error(`Error handling signal from ${from}:`, error);
    }
  }

  async sendSignal(toSessionId, type, data) {
    try {
      await fetch(`${this.apiUrl}/webrtc/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromSessionId: this.sessionId,
          toSessionId,
          type,
          data,
        }),
      });
    } catch (error) {
      console.error('Error sending signal:', error);
    }
  }

  startSignalPolling() {
    this.pollingInterval = setInterval(async () => {
      try {
        const response = await fetch(`${this.apiUrl}/webrtc/signals/${this.sessionId}`);
        if (response.ok) {
          const data = await response.json();
          for (const signal of data.signals || []) {
            await this.handleSignal(signal);
          }
        }
      } catch (error) {
        console.error('Error polling signals:', error);
      }
    }, 1000);
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMuted;
      });
    }
    console.log(`Audio ${this.isMuted ? 'muted' : 'unmuted'}`);
    return this.isMuted;
  }

  getMuteState() {
    return this.isMuted;
  }

  async cleanup() {
    // Stop polling
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    // Close all peer connections
    for (const peerId of Object.keys(this.peerConnections)) {
      const pc = this.peerConnections[peerId];
      if (pc) {
        pc.close();
      }
      // Remove audio elements
      const audioElement = document.getElementById(`audio-${peerId}`);
      if (audioElement) {
        audioElement.remove();
      }
    }
    this.peerConnections = {};

    // Stop local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    this.isInitialized = false;
    console.log('AudioManager cleaned up');
  }
}

export default AudioManager;
