import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, BookOpen, Mic, MicOff, SkipForward, Play, Check, LogOut, Volume2, VolumeX } from 'lucide-react';
import Toast from '../components/Toast';
import PDFViewer from '../components/PDFViewer';
import AudioManager from '../utils/AudioManager';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

// Timer duration for Position 2 (in seconds)
const POSITION_2_TIMER_DURATION = 30;

const HomePage = () => {
  const navigate = useNavigate();
  
  // Role and session state
  const [userRole, setUserRole] = useState(null);
  const [name, setName] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [hasJoined, setHasJoined] = useState(false);
  const [loading, setLoading] = useState(false);
  
  // Queue state
  const [queueStatus, setQueueStatus] = useState(null);
  const [wasPosition2, setWasPosition2] = useState(false);
  const [hasStartedReading, setHasStartedReading] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null);
  
  // Position 2 timer state
  const [position2Timer, setPosition2Timer] = useState(POSITION_2_TIMER_DURATION);
  const [isPosition2TimerActive, setIsPosition2TimerActive] = useState(false);
  
  // Sub-group state
  const [availableSubGroups, setAvailableSubGroups] = useState([]);
  const [selectedSubGroup, setSelectedSubGroup] = useState(null);
  const [loadingSubGroups, setLoadingSubGroups] = useState(false);
  
  // Document state
  const [documentStatus, setDocumentStatus] = useState({ loaded: false, filename: null });
  const [documentData, setDocumentData] = useState(null);
  const [uploadingDocument, setUploadingDocument] = useState(false);
  const [autoLoadAttempted, setAutoLoadAttempted] = useState(false);
  
  // Audio state
  const [isMuted, setIsMuted] = useState(true);
  const [audioInitialized, setAudioInitialized] = useState(false);
  const audioManager = useRef(null);
  
  // Toast state
  const [toast, setToast] = useState({ visible: false, message: '', type: 'info' });
  
  // Refs for intervals
  const pollingInterval = useRef(null);
  const documentPollingInterval = useRef(null);
  const position2TimerInterval = useRef(null);
  const position2TimeoutRef = useRef(null);

  // Toast helper
  const showToast = (message, type = 'info') => {
    setToast({ visible: true, message, type });
  };

  const hideToast = () => {
    setToast({ visible: false, message: '', type: 'info' });
  };

  // Fetch sub-groups
  const fetchSubGroups = async () => {
    try {
      setLoadingSubGroups(true);
      const response = await fetch(`${API}/subgroups/list`);
      if (response.ok) {
        const data = await response.json();
        setAvailableSubGroups(data.subgroups || []);
        
        if (!selectedSubGroup && data.subgroups && data.subgroups.length > 0) {
          const generalGroup = data.subgroups.find(g => g.name === 'General');
          if (generalGroup) {
            setSelectedSubGroup('General');
          } else {
            setSelectedSubGroup(data.subgroups[0].name);
          }
        }
      }
    } catch (error) {
      console.error('Error fetching sub-groups:', error);
    } finally {
      setLoadingSubGroups(false);
    }
  };

  // Join queue
  const joinQueue = async () => {
    if (!name.trim()) {
      showToast('Please enter your name', 'error');
      return;
    }

    if (!selectedSubGroup) {
      showToast('Please select a sub-group first', 'error');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API}/queue/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), subGroup: selectedSubGroup }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to join queue');
      }

      const data = await response.json();
      setSessionId(data.sessionId);
      setHasJoined(true);
      
      localStorage.setItem('sessionId', data.sessionId);
      localStorage.setItem('userName', name.trim());
      
      const statusData = await fetchQueueStatus(data.sessionId);
      
      if (selectedSubGroup && statusData) {
        const shouldStartMuted = !statusData.isPosition1;
        await initializeAudio(data.sessionId, selectedSubGroup, shouldStartMuted);
      }
    } catch (error) {
      showToast(error.message || 'Failed to join queue', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Initialize audio
  const initializeAudio = async (sid, subGroup, startMuted = true) => {
    try {
      console.log(`Initializing audio for sub-group '${subGroup}' (startMuted: ${startMuted})...`);
      audioManager.current = new AudioManager(sid, subGroup, API);
      const success = await audioManager.current.initialize(startMuted);
      
      if (success) {
        setAudioInitialized(true);
        setIsMuted(startMuted);
        console.log(`Audio initialized successfully for sub-group '${subGroup}'`);
      } else {
        console.log('Audio not available - WebRTC not supported');
      }
    } catch (error) {
      console.error('Error initializing audio:', error);
    }
  };

  // Toggle mute
  const toggleMute = () => {
    if (!audioManager.current) return;
    
    const newMutedState = audioManager.current.toggleMute();
    setIsMuted(newMutedState);
    console.log(`User manually ${newMutedState ? 'muted' : 'unmuted'}`);
  };

  // Fetch queue status
  const fetchQueueStatus = async (sid) => {
    const currentSessionId = sid || sessionId;
    if (!currentSessionId) return null;

    try {
      const response = await fetch(`${API}/queue/status/${currentSessionId}`);

      if (!response.ok) {
        console.log('Session no longer valid - resetting app...');
        await handleSessionEnd();
        return null;
      }

      const data = await response.json();
      setQueueStatus(data);
      return data;
    } catch (error) {
      console.error('Error fetching queue status:', error);
      return null;
    }
  };

  // Handle session end
  const handleSessionEnd = async () => {
    if (pollingInterval.current) clearInterval(pollingInterval.current);
    if (documentPollingInterval.current) clearInterval(documentPollingInterval.current);
    clearPosition2Timer();
    
    if (audioManager.current) {
      await audioManager.current.cleanup();
      audioManager.current = null;
    }
    setAudioInitialized(false);
    setIsMuted(true);
    
    setHasJoined(false);
    setSessionId(null);
    setQueueStatus(null);
    setName('');
    setUserRole(null);
    setDocumentData(null);
    setDocumentStatus({ loaded: false, filename: null });
    setHasStartedReading(false);
    setAutoLoadAttempted(false);
    setStatusMessage(null);
    
    localStorage.removeItem('sessionId');
    localStorage.removeItem('userName');
    
    showToast('Session ended by Admin', 'info');
  };

  // Clear Position 2 timer
  const clearPosition2Timer = () => {
    if (position2TimerInterval.current) {
      clearInterval(position2TimerInterval.current);
      position2TimerInterval.current = null;
    }
    if (position2TimeoutRef.current) {
      clearTimeout(position2TimeoutRef.current);
      position2TimeoutRef.current = null;
    }
    setPosition2Timer(POSITION_2_TIMER_DURATION);
    setIsPosition2TimerActive(false);
  };

  // Start Position 2 timer
  const startPosition2Timer = useCallback(() => {
    // Clear any existing timer
    clearPosition2Timer();
    
    setIsPosition2TimerActive(true);
    setPosition2Timer(POSITION_2_TIMER_DURATION);
    
    // Countdown interval
    position2TimerInterval.current = setInterval(() => {
      setPosition2Timer(prev => {
        if (prev <= 1) {
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    
    // Auto-skip timeout
    position2TimeoutRef.current = setTimeout(async () => {
      if (!sessionId) return;
      
      try {
        const response = await fetch(`${API}/queue/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, action: 'skip' }),
        });

        if (response.ok) {
          setStatusMessage('Moved to end of queue due to inactivity.');
          showToast('Moved to end of queue due to inactivity', 'info');
          fetchQueueStatus();
        }
      } catch (error) {
        console.error('Position 2 auto-skip error:', error);
      }
      
      clearPosition2Timer();
    }, POSITION_2_TIMER_DURATION * 1000);
  }, [sessionId]);

  // Start polling
  const startPolling = () => {
    if (pollingInterval.current) clearInterval(pollingInterval.current);
    
    pollingInterval.current = setInterval(() => {
      fetchQueueStatus();
    }, 750);
  };

  // Handle queue action
  const handleAction = async (action) => {
    if (!sessionId) return;

    // Clear Position 2 timer when taking action
    clearPosition2Timer();

    // Mute audio when skipping or finishing
    if ((action === 'skip' || action === 'finish') && audioManager.current) {
      const currentMuteState = audioManager.current.getMuteState();
      if (!currentMuteState) {
        audioManager.current.toggleMute();
      }
      setIsMuted(true);
    }

    try {
      const response = await fetch(`${API}/queue/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, action }),
      });

      if (!response.ok) {
        throw new Error(`Failed to process action`);
      }

      if (action === 'start') {
        setHasStartedReading(true);
        setStatusMessage(null);
        
        // Unmute when starting to read
        if (audioManager.current) {
          const currentMuteState = audioManager.current.getMuteState();
          if (currentMuteState) {
            audioManager.current.toggleMute();
          }
          setIsMuted(false);
        }
        
        showToast('Started reading session', 'success');
      } else if (action === 'skip') {
        setStatusMessage('Moved to end of queue.');
        setHasStartedReading(false);
        showToast('Skipped turn - moved to end of queue', 'info');
      } else if (action === 'finish') {
        setHasStartedReading(false);
        setStatusMessage('Finished reading - moved to end of queue.');
        showToast('Finished reading - moved to end of queue', 'success');
      }
      
      await fetchQueueStatus();
    } catch (error) {
      showToast(error.message || 'Failed to process action', 'error');
    }
  };

  // Leave queue
  const leaveQueue = async () => {
    if (!sessionId) return;

    try {
      if (pollingInterval.current) clearInterval(pollingInterval.current);
      if (documentPollingInterval.current) clearInterval(documentPollingInterval.current);
      clearPosition2Timer();

      await fetch(`${API}/queue/leave/${sessionId}`, { method: 'DELETE' });

      if (audioManager.current) {
        await audioManager.current.cleanup();
        audioManager.current = null;
      }
      setAudioInitialized(false);
      setIsMuted(true);
      
      setSessionId(null);
      setHasJoined(false);
      setQueueStatus(null);
      setName('');
      setUserRole(null);
      setDocumentData(null);
      setDocumentStatus({ loaded: false, filename: null });
      setSelectedSubGroup(null);
      setAutoLoadAttempted(false);
      setStatusMessage(null);
      
      localStorage.removeItem('sessionId');
      localStorage.removeItem('userName');
    } catch (error) {
      console.error('Error leaving queue:', error);
    }
  };

  // Document polling
  const startDocumentPolling = () => {
    if (documentPollingInterval.current) clearInterval(documentPollingInterval.current);
    
    documentPollingInterval.current = setInterval(async () => {
      try {
        const response = await fetch(`${API}/document/status`);
        if (response.ok) {
          const status = await response.json();
          setDocumentStatus(status);
          
          if (status.loaded) {
            fetchDocument();
            if (documentPollingInterval.current) clearInterval(documentPollingInterval.current);
          }
        }
      } catch (error) {
        console.log('Error polling document status:', error);
      }
    }, 2000);
  };

  // Fetch document
  const fetchDocument = async () => {
    try {
      const response = await fetch(`${API}/document/current`);
      if (response.ok) {
        const doc = await response.json();
        setDocumentData(doc.data);
        setDocumentStatus({ loaded: true, filename: doc.filename });
      }
    } catch (error) {
      console.log('Error fetching document:', error);
    }
  };

  // Auto-load document
  const autoLoadDocument = async () => {
    if (!queueStatus?.isPosition1 || !hasJoined || documentStatus.loaded || uploadingDocument || autoLoadAttempted) {
      return;
    }

    try {
      setAutoLoadAttempted(true);
      setUploadingDocument(true);
      
      const response = await fetch(`${API}/document/auto-load?loaderSessionId=${sessionId}`);
      
      if (response.ok) {
        const docResponse = await fetch(`${API}/document/current`);
        if (docResponse.ok) {
          const doc = await docResponse.json();
          setDocumentData(doc.data);
          setDocumentStatus({ loaded: true, filename: doc.filename });
        }
      } else if (response.status === 404) {
        showToast('No PDF found for today. Please upload a PDF via Admin portal.', 'error');
      }
    } catch (error) {
      console.error('Auto-load error:', error);
      showToast('Auto-load failed. Please use Admin portal.', 'info');
    } finally {
      setUploadingDocument(false);
    }
  };

  // Clear status message when position changes
  useEffect(() => {
    if (queueStatus && !queueStatus.isPosition1 && !queueStatus.isPosition2 && statusMessage) {
      // Clear message after 3 seconds when not at position 1 or 2
      const timer = setTimeout(() => {
        setStatusMessage(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [queueStatus?.position, statusMessage]);

  // Effects
  useEffect(() => {
    if (userRole) {
      fetchSubGroups();
    }
    
    return () => {
      if (pollingInterval.current) clearInterval(pollingInterval.current);
      if (documentPollingInterval.current) clearInterval(documentPollingInterval.current);
      clearPosition2Timer();
    };
  }, [userRole]);

  useEffect(() => {
    if (sessionId && hasJoined) {
      startPolling();
    }
  }, [sessionId, hasJoined]);

  // Handle Position 2 timer
  useEffect(() => {
    if (queueStatus?.isPosition2 && !wasPosition2) {
      // Just became Position 2, start the timer
      startPosition2Timer();
      setWasPosition2(true);
    } else if (!queueStatus?.isPosition2 && wasPosition2) {
      // No longer Position 2, clear timer
      clearPosition2Timer();
      setWasPosition2(false);
    }
  }, [queueStatus?.isPosition2, wasPosition2, startPosition2Timer]);

  useEffect(() => {
    if (queueStatus?.isPosition1) {
      // Clear Position 2 timer if we become Position 1
      clearPosition2Timer();
      setWasPosition2(false);
      
      if (Notification.permission === 'granted') {
        new Notification("It's Your Turn!", { body: 'You are now at position 1. Please select an action.' });
      }
    } else {
      setHasStartedReading(false);
      
      // Mute when not position 1
      if (audioManager.current && queueStatus) {
        const currentMuteState = audioManager.current.getMuteState();
        if (!currentMuteState) {
          audioManager.current.toggleMute();
        }
        setIsMuted(true);
      }
    }
  }, [queueStatus?.isPosition1]);

  useEffect(() => {
    if (userRole === 'participant' && !documentStatus.loaded) {
      startDocumentPolling();
    }
    return () => {
      if (documentPollingInterval.current) clearInterval(documentPollingInterval.current);
    };
  }, [userRole, documentStatus.loaded]);

  useEffect(() => {
    autoLoadDocument();
  }, [queueStatus?.isPosition1, hasJoined, documentStatus.loaded]);

  // Request notification permission
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Render welcome screen
  if (!userRole) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="card max-w-md w-full text-center">
          <div className="text-6xl mb-6">📖</div>
          <h1 className="text-3xl font-bold mb-4">ReadQueue</h1>
          <p className="text-white/70 mb-8">Group Reading Queue Management</p>
          
          <button
            onClick={() => setUserRole('participant')}
            className="btn-primary w-full flex items-center justify-center gap-3 mb-4"
            data-testid="join-group-btn"
          >
            <Users size={24} />
            Join a Group
          </button>
          
          <button
            onClick={() => navigate('/admin')}
            className="btn-secondary w-full flex items-center justify-center gap-3"
            data-testid="admin-portal-btn"
          >
            <BookOpen size={24} />
            Admin Portal
          </button>
        </div>
        <Toast {...toast} onHide={hideToast} />
      </div>
    );
  }

  // Render join queue screen
  if (!hasJoined) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="card max-w-md w-full">
          <h2 className="text-2xl font-bold mb-6 text-center">Join Reading Queue</h2>
          
          {loadingSubGroups ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
            </div>
          ) : (
            <>
              <div className="mb-4">
                <label className="block text-sm text-white/70 mb-2">Your Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Enter your name"
                  className="input-field"
                  onKeyPress={(e) => e.key === 'Enter' && joinQueue()}
                  data-testid="name-input"
                />
              </div>
              
              <div className="mb-6">
                <label className="block text-sm text-white/70 mb-2">Select Group</label>
                <select
                  value={selectedSubGroup || ''}
                  onChange={(e) => setSelectedSubGroup(e.target.value)}
                  className="select-field"
                  data-testid="group-select"
                >
                  <option value="">-- Choose a group --</option>
                  {availableSubGroups.map((group) => (
                    <option key={group.id} value={group.name}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </div>
              
              <button
                onClick={joinQueue}
                disabled={loading || !selectedSubGroup || !name.trim()}
                className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="join-queue-btn"
              >
                {loading ? 'Joining...' : 'Join Queue'}
              </button>
              
              <button
                onClick={() => setUserRole(null)}
                className="btn-secondary w-full mt-4"
                data-testid="back-btn"
              >
                Back
              </button>
            </>
          )}
        </div>
        <Toast {...toast} onHide={hideToast} />
      </div>
    );
  }

  // Render main queue view
  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <div className="bg-white/10 backdrop-blur-md p-4 flex items-center justify-between border-b border-white/20">
        <div className="flex items-center gap-4">
          <div className="text-2xl">📖</div>
          <div>
            <h1 className="font-bold">ReadQueue</h1>
            <p className="text-sm text-white/70">{queueStatus?.subGroup || selectedSubGroup}</p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {audioInitialized && (
            <button
              onClick={toggleMute}
              className={`p-2 rounded-lg transition-all ${isMuted ? 'bg-red-500/20 text-red-400' : 'bg-green-500/20 text-green-400'}`}
              data-testid="mute-btn"
            >
              {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
          )}
          
          <button
            onClick={leaveQueue}
            className="p-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-all"
            data-testid="leave-queue-btn"
          >
            <LogOut size={20} />
          </button>
        </div>
      </div>

      {/* Queue Status Panel - Always at Top */}
      <div className="bg-white/5 border-b border-white/20 p-4">
        <div className="max-w-4xl mx-auto">
          {/* Status Message */}
          {statusMessage && (
            <div className="bg-yellow-500/20 border border-yellow-500/30 rounded-lg p-3 mb-4 text-center">
              <p className="text-yellow-400 font-medium">{statusMessage}</p>
            </div>
          )}
          
          <div className="flex flex-wrap items-center justify-between gap-4">
            {/* Position Info */}
            <div className="flex items-center gap-6">
              <div className={`text-center px-4 py-2 rounded-lg ${queueStatus?.isPosition1 ? 'bg-green-500/20 ring-2 ring-green-500' : queueStatus?.isPosition2 ? 'bg-yellow-500/20 ring-2 ring-yellow-500' : 'bg-white/10'}`}>
                <p className="text-xs text-white/70 uppercase">Your Position</p>
                <p className={`text-3xl font-bold ${queueStatus?.isPosition1 ? 'text-green-400' : queueStatus?.isPosition2 ? 'text-yellow-400' : ''}`}>
                  {queueStatus?.position || '-'}
                </p>
              </div>
              
              <div className="text-center px-4 py-2 rounded-lg bg-white/10">
                <p className="text-xs text-white/70 uppercase">Total in Queue</p>
                <p className="text-3xl font-bold">{queueStatus?.totalInQueue || 0}</p>
              </div>
              
              <div className="hidden sm:block">
                <p className="text-xs text-white/70">Current Reader</p>
                <p className={`font-medium ${queueStatus?.isPosition1 ? 'text-green-400' : ''}`}>
                  {queueStatus?.position1Name || 'None'}
                </p>
                <p className="text-xs text-white/70 mt-1">Next Up</p>
                <p className={`font-medium ${queueStatus?.isPosition2 ? 'text-yellow-400' : ''}`}>
                  {queueStatus?.position2Name || 'None'}
                </p>
              </div>
            </div>

            {/* Action Buttons - Position 1 */}
            {queueStatus?.isPosition1 && (
              <div className="flex items-center gap-3">
                {!hasStartedReading ? (
                  <>
                    <button
                      onClick={() => handleAction('start')}
                      className="btn-success flex items-center gap-2"
                      data-testid="start-reading-btn"
                    >
                      <Play size={20} />
                      Start Reading
                    </button>
                    <button
                      onClick={() => handleAction('skip')}
                      className="btn-secondary flex items-center gap-2"
                      data-testid="skip-btn"
                    >
                      <SkipForward size={20} />
                      Skip
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => handleAction('finish')}
                    className="btn-primary flex items-center gap-2"
                    data-testid="finish-btn"
                  >
                    <Check size={20} />
                    Finish Reading
                  </button>
                )}
              </div>
            )}

            {/* Position 2 Timer and Info */}
            {queueStatus?.isPosition2 && (
              <div className="flex items-center gap-4">
                {isPosition2TimerActive && (
                  <div className={`text-center px-4 py-2 rounded-lg ${position2Timer <= 10 ? 'bg-red-500/20' : 'bg-yellow-500/20'}`}>
                    <p className="text-xs text-white/70 uppercase">Get Ready In</p>
                    <p className={`text-2xl font-bold ${position2Timer <= 10 ? 'text-red-400' : 'text-yellow-400'}`}>
                      {position2Timer}s
                    </p>
                  </div>
                )}
                <div className="text-right">
                  <p className="text-yellow-400 font-semibold">You&apos;re next!</p>
                  <p className="text-sm text-white/70">Be ready to start reading</p>
                </div>
              </div>
            )}

            {/* Other positions */}
            {!queueStatus?.isPosition1 && !queueStatus?.isPosition2 && (
              <div className="text-right">
                <p className="text-sm text-white/70">Your name: <span className="text-white font-medium">{name}</span></p>
              </div>
            )}
          </div>

          {/* Audio Status */}
          {audioInitialized && (
            <div className="mt-3 flex items-center gap-2 text-sm">
              {isMuted ? (
                <VolumeX size={14} className="text-red-400" />
              ) : (
                <Volume2 size={14} className="text-green-400" />
              )}
              <span className="text-white/70">
                {isMuted ? 'Microphone muted' : 'Microphone active'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Main content - PDF Viewer */}
      <div className="flex-1">
        {documentStatus.loaded && documentData ? (
          <PDFViewer backendUrl={BACKEND_URL} />
        ) : (
          <div className="flex items-center justify-center h-full min-h-[400px]">
            <div className="text-center">
              {uploadingDocument ? (
                <>
                  <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
                  <p className="text-white/70">Loading document...</p>
                </>
              ) : (
                <>
                  <div className="text-6xl mb-4">📄</div>
                  <p className="text-white/70">Waiting for document...</p>
                  <p className="text-sm text-white/50 mt-2">The document will load automatically</p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      
      <Toast {...toast} onHide={hideToast} />
    </div>
  );
};

export default HomePage;
