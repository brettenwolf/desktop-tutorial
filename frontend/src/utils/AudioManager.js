/**
 * AudioManager - WebRTC-based audio streaming for group reading
 * Handles peer-to-peer audio connections within sub-groups
 * iOS Safari/Chrome compatible
 */
class AudioManager {
  constructor(sessionId, subGroup, apiUrl) {
    this.sessionId = sessionId;
    this.subGroup = subGroup;
    this.apiUrl = apiUrl;
    this.localStream = null;
    this.peerConnections = {};
    this.audioElements = {};
    this.isMuted = true;
    this.isInitialized = false;
    this.pollingInterval = null;
    this.audioContext = null;
    this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    this.onStatusChange = null; // Callback for status updates
    this.onWarning = null; // Callback for warnings
    this.connectedPeerCount = 0;
    this.connectionAttempts = 0;
    this.lastWarningTime = 0;
  }

  // Set callback for status changes
  setStatusCallback(callback) {
    this.onStatusChange = callback;
  }

  // Set callback for warnings (connection issues, etc.)
  setWarningCallback(callback) {
    this.onWarning = callback;
  }

  // Report status to UI
  reportStatus(status, peerCount = this.connectedPeerCount) {
    this.connectedPeerCount = peerCount;
    if (this.onStatusChange) {
      this.onStatusChange(status, peerCount);
    }
    console.log(`Audio Status: ${status}, Connected Peers: ${peerCount}`);
  }

  // Report warning to UI (throttled to avoid spam)
  reportWarning(message, type = 'connection') {
    const now = Date.now();
    // Only show warning once every 30 seconds to avoid spam
    if (now - this.lastWarningTime > 30000) {
      this.lastWarningTime = now;
      if (this.onWarning) {
        this.onWarning(message, type);
      }
      console.warn(`Audio Warning: ${message}`);
    }
  }

  async initialize(startMuted = true) {
    try {
      this.reportStatus('initializing');
      
      // Check if WebRTC is supported
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.log('WebRTC not supported in this browser');
        this.reportStatus('unsupported');
        return false;
      }

      // Create AudioContext for iOS compatibility
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioContext = new AudioContextClass();
        // iOS requires AudioContext to be resumed after user interaction
        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }
      }

      // Request microphone access with iOS-compatible constraints
      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      };

      // iOS Safari/Chrome sometimes needs simpler constraints
      if (this.isIOS) {
        constraints.audio = true;
      }

      this.reportStatus('requesting_mic');
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Set initial mute state
      this.isMuted = startMuted;
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !startMuted;
      });

      this.isInitialized = true;
      this.reportStatus('ready');

      // Start polling for signals and peers
      this.startSignalPolling();
      this.connectToPeers();

      console.log(`AudioManager initialized for sub-group: ${this.subGroup} (iOS: ${this.isIOS})`);
      return true;
    } catch (error) {
      console.error('Error initializing audio:', error);
      this.reportStatus('mic_denied');
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
            // Only initiate connection if our sessionId is "lower" to avoid glare
            // The peer with the higher sessionId will wait for an offer
            if (this.sessionId < peer.sessionId) {
              console.log(`Initiating connection to ${peer.sessionId} (we are initiator)`);
              await this.createPeerConnection(peer.sessionId, true);
            } else {
              console.log(`Waiting for connection from ${peer.sessionId} (they are initiator)`);
              // Create a placeholder so we don't try again
              this.peerConnections[peer.sessionId] = 'waiting';
            }
          }
        }
      }
    } catch (error) {
      console.error('Error connecting to peers:', error);
    }
  }

  createAudioElement(peerId, stream) {
    // Remove existing audio element if any
    const existingAudio = document.getElementById(`audio-${peerId}`);
    if (existingAudio) {
      existingAudio.srcObject = null;
      existingAudio.remove();
    }

    const audio = document.createElement('audio');
    audio.id = `audio-${peerId}`;
    audio.srcObject = stream;
    audio.setAttribute('playsinline', 'true'); // Required for iOS
    audio.setAttribute('autoplay', 'true');
    audio.volume = 1.0; // Max volume
    
    // For iOS, we need to handle autoplay differently
    // Don't mute initially on iOS - let the play() handle it
    
    // Add to DOM (hidden but present)
    audio.style.cssText = 'position: absolute; left: -9999px;';
    document.body.appendChild(audio);
    
    // Store reference
    this.audioElements[peerId] = audio;

    console.log(`Creating audio element for peer ${peerId}, stream tracks:`, stream.getTracks().map(t => `${t.kind}:${t.enabled}`));

    // Play with better error handling
    const playAudio = async () => {
      try {
        await audio.play();
        console.log(`✓ Audio playing for peer ${peerId}`);
      } catch (error) {
        console.log(`Audio play blocked for ${peerId}:`, error.message);
        // Mark as needing user interaction
        audio.dataset.needsPlay = 'true';
      }
    };
    
    playAudio();

    return audio;
  }

  // Call this on user interaction (like clicking Unmute) to enable audio on iOS
  async enableAudioPlayback() {
    console.log('enableAudioPlayback called - attempting to play all audio elements');
    
    // Resume AudioContext if suspended
    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
      console.log('AudioContext resumed');
    }

    // Try to play any pending audio
    for (const peerId of Object.keys(this.audioElements)) {
      const audio = this.audioElements[peerId];
      if (audio) {
        try {
          audio.muted = false;
          audio.volume = 1.0;
          if (audio.paused || audio.dataset.needsPlay === 'true') {
            await audio.play();
            audio.dataset.needsPlay = 'false';
            console.log(`✓ Enabled audio playback for ${peerId}`);
          }
        } catch (e) {
          console.log(`Cannot play audio for ${peerId}:`, e.message);
        }
      }
    }
  }

  // Count currently connected peers
  updateConnectedPeerCount() {
    let count = 0;
    for (const peerId of Object.keys(this.peerConnections)) {
      const pc = this.peerConnections[peerId];
      if (pc && pc !== 'waiting' && pc.connectionState === 'connected') {
        count++;
      }
    }
    this.connectedPeerCount = count;
    return count;
  }

  async createPeerConnection(peerId, isInitiator = false) {
    try {
      // Use multiple STUN/TURN servers for better connectivity
      const config = {
        iceServers: [
          // Google STUN servers
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          // Open Relay STUN
          { urls: 'stun:staticauth.openrelay.metered.ca:80' },
          // Open Relay TURN servers (free, working as of 2025)
          {
            urls: 'turn:staticauth.openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayprojectsecret',
          },
          {
            urls: 'turn:staticauth.openrelay.metered.ca:80?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayprojectsecret',
          },
          {
            urls: 'turn:staticauth.openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayprojectsecret',
          },
          {
            urls: 'turn:staticauth.openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayprojectsecret',
          },
          {
            urls: 'turns:staticauth.openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayprojectsecret',
          },
        ],
        iceCandidatePoolSize: 10,
      };

      const pc = new RTCPeerConnection(config);
      this.peerConnections[peerId] = pc;

      // Add local tracks
      if (this.localStream) {
        this.localStream.getTracks().forEach(track => {
          console.log(`Adding local track to peer ${peerId}: ${track.kind}, enabled: ${track.enabled}`);
          pc.addTrack(track, this.localStream);
        });
      }

      // Handle incoming tracks
      pc.ontrack = (event) => {
        console.log(`✓ Received remote track from ${peerId}:`, event.track.kind);
        if (event.streams && event.streams[0]) {
          this.createAudioElement(peerId, event.streams[0]);
        }
      };

      // Handle ICE candidates
      pc.onicecandidate = async (event) => {
        if (event.candidate) {
          await this.sendSignal(peerId, 'ice-candidate', { candidate: event.candidate });
        }
      };

      // Connection state logging and status reporting
      pc.onconnectionstatechange = () => {
        console.log(`Peer ${peerId} connection state: ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
          console.log(`✓✓✓ Successfully connected to peer ${peerId}!`);
          this.connectionAttempts = 0; // Reset on success
          this.updateConnectedPeerCount();
          this.reportStatus('connected', this.connectedPeerCount);
        } else if (pc.connectionState === 'failed') {
          this.connectionAttempts++;
          this.updateConnectedPeerCount();
          if (this.connectedPeerCount === 0) {
            this.reportStatus('connection_failed', 0);
          }
          // Warn user after multiple failures
          if (this.connectionAttempts >= 2) {
            this.reportWarning('Audio connection failed. This may be a network issue or the TURN relay service may be temporarily unavailable.', 'connection');
          }
        } else if (pc.connectionState === 'disconnected') {
          this.updateConnectedPeerCount();
          if (this.connectedPeerCount === 0) {
            this.reportStatus('ready', 0);
          }
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log(`Peer ${peerId} ICE state: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
          console.log(`✗ ICE connection failed for peer ${peerId}`);
          this.reportStatus('ice_failed');
          this.connectionAttempts++;
          // Warn on ICE failure
          if (this.connectionAttempts >= 2) {
            this.reportWarning('Unable to establish peer connection. Check your network or try rejoining the queue.', 'ice');
          }
        } else if (pc.iceConnectionState === 'disconnected') {
          // Brief disconnections can recover, only warn if it persists
          setTimeout(() => {
            if (pc.iceConnectionState === 'disconnected') {
              this.reportWarning('Audio connection interrupted. Attempting to reconnect...', 'disconnect');
            }
          }, 5000);
        }
      };

      // Only create offer if we are the initiator
      if (isInitiator) {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: false,
        });
        await pc.setLocalDescription(offer);
        await this.sendSignal(peerId, 'offer', { sdp: offer });
        console.log(`Sent offer to ${peerId}`);
      }

      console.log(`Created peer connection to ${peerId} (initiator: ${isInitiator})`);
    } catch (error) {
      console.error(`Error creating peer connection to ${peerId}:`, error);
    }
  }

  async handleSignal(signal) {
    const { from, type, data } = signal;

    try {
      if (type === 'offer') {
        console.log(`Received offer from ${from}`);
        // Handle incoming offer - create peer connection if needed
        let pc = this.peerConnections[from];
        
        // If we have a 'waiting' placeholder or no connection, create one
        if (!pc || pc === 'waiting') {
          const config = {
            iceServers: [
              // Google STUN servers
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
              // Open Relay STUN
              { urls: 'stun:staticauth.openrelay.metered.ca:80' },
              // Open Relay TURN servers (free, working as of 2025)
              {
                urls: 'turn:staticauth.openrelay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayprojectsecret',
              },
              {
                urls: 'turn:staticauth.openrelay.metered.ca:80?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayprojectsecret',
              },
              {
                urls: 'turn:staticauth.openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayprojectsecret',
              },
              {
                urls: 'turn:staticauth.openrelay.metered.ca:443?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayprojectsecret',
              },
              {
                urls: 'turns:staticauth.openrelay.metered.ca:443?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayprojectsecret',
              },
            ],
            iceCandidatePoolSize: 10,
          };
          
          pc = new RTCPeerConnection(config);
          this.peerConnections[from] = pc;

          if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
              console.log(`Adding local track for answer to ${from}: ${track.kind}`);
              pc.addTrack(track, this.localStream);
            });
          }

          pc.ontrack = (event) => {
            console.log(`✓ Received remote track from ${from} (via offer):`, event.track.kind);
            if (event.streams && event.streams[0]) {
              this.createAudioElement(from, event.streams[0]);
            }
          };

          pc.onicecandidate = async (event) => {
            if (event.candidate) {
              await this.sendSignal(from, 'ice-candidate', { candidate: event.candidate });
            }
          };

          pc.onconnectionstatechange = () => {
            console.log(`Peer ${from} connection state: ${pc.connectionState}`);
            if (pc.connectionState === 'connected') {
              console.log(`✓✓✓ Successfully connected to peer ${from}!`);
              this.updateConnectedPeerCount();
              this.reportStatus('connected', this.connectedPeerCount);
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
              this.updateConnectedPeerCount();
              if (this.connectedPeerCount === 0) {
                this.reportStatus('ready', 0);
              }
            }
          };
          
          pc.oniceconnectionstatechange = () => {
            console.log(`Peer ${from} ICE state: ${pc.iceConnectionState}`);
            if (pc.iceConnectionState === 'failed') {
              this.reportStatus('ice_failed');
            }
          };
        }

        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.sendSignal(from, 'answer', { sdp: answer });
        console.log(`Sent answer to ${from}`);

      } else if (type === 'answer') {
        console.log(`Received answer from ${from}`);
        const pc = this.peerConnections[from];
        if (pc && pc !== 'waiting' && pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          console.log(`Set remote description from answer by ${from}`);
        }

      } else if (type === 'ice-candidate') {
        const pc = this.peerConnections[from];
        if (pc && pc !== 'waiting' && data.candidate) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (e) {
            // Ignore ICE candidate errors if connection is already established
            if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
              console.error(`Error adding ICE candidate from ${from}:`, e);
            }
          }
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
    // Poll more frequently for better responsiveness
    this.pollingInterval = setInterval(async () => {
      try {
        const response = await fetch(`${this.apiUrl}/webrtc/signals/${this.sessionId}`);
        if (response.ok) {
          const data = await response.json();
          for (const signal of data.signals || []) {
            await this.handleSignal(signal);
          }
        }
        
        // Also check for new peers periodically
        await this.connectToPeers();
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
    
    // On unmute, try to enable audio playback (for iOS)
    if (!this.isMuted) {
      this.enableAudioPlayback();
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
    }
    this.peerConnections = {};

    // Remove all audio elements
    for (const peerId of Object.keys(this.audioElements)) {
      const audio = this.audioElements[peerId];
      if (audio) {
        audio.pause();
        audio.srcObject = null;
        audio.remove();
      }
    }
    this.audioElements = {};

    // Stop local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    // Close AudioContext
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.isInitialized = false;
    console.log('AudioManager cleaned up');
  }
}

export default AudioManager;
