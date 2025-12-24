import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, BookOpen, Mic, MicOff, SkipForward, Play, Check, LogOut, ChevronDown, ChevronUp, Volume2, VolumeX } from 'lucide-react';
import Toast from '../components/Toast';
import PDFViewer from '../components/PDFViewer';
import AudioManager from '../utils/AudioManager';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

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
  const [autoSkipTimer, setAutoSkipTimer] = useState(10);
  const [wasPosition2, setWasPosition2] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasStartedReading, setHasStartedReading] = useState(false);
  
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
  const autoSkipTimeout = useRef(null);
  const timerInterval = useRef(null);
  const documentPollingInterval = useRef(null);

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
    if (autoSkipTimeout.current) clearTimeout(autoSkipTimeout.current);
    if (timerInterval.current) clearInterval(timerInterval.current);
    if (documentPollingInterval.current) clearInterval(documentPollingInterval.current);
    
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
    setIsExpanded(false);
    setHasStartedReading(false);
    setAutoLoadAttempted(false);
    
    localStorage.removeItem('sessionId');
    localStorage.removeItem('userName');
    
    showToast('Session ended by Admin', 'info');
  };

  // Start polling
  const startPolling = () => {
    if (pollingInterval.current) clearInterval(pollingInterval.current);
    
    pollingInterval.current = setInterval(() => {
      fetchQueueStatus();
    }, 750);
  };

  // Start auto-skip timer
  const startAutoSkipTimer = useCallback(() => {
    if (autoSkipTimeout.current) clearTimeout(autoSkipTimeout.current);
    if (timerInterval.current) clearInterval(timerInterval.current);
    
    setAutoSkipTimer(10);
    
    let secondsLeft = 10;
    timerInterval.current = setInterval(() => {
      secondsLeft--;
      setAutoSkipTimer(secondsLeft);
      
      if (secondsLeft <= 0) {
        if (timerInterval.current) clearInterval(timerInterval.current);
      }
    }, 1000);
    
    autoSkipTimeout.current = setTimeout(async () => {
      if (hasStartedReading || !sessionId) return;

      try {
        const response = await fetch(`${API}/queue/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, action: 'skip' }),
        });

        if (response.ok) {
          setIsExpanded(false);
          showToast('Moved to back of queue due to inactivity', 'info');
          fetchQueueStatus();
        }
      } catch (error) {
        console.error('Auto-skip error:', error);
      }
    }, 10000);
  }, [sessionId, hasStartedReading]);

  // Handle queue action
  const handleAction = async (action) => {
    if (!sessionId) return;

    setIsExpanded(false);

    if (autoSkipTimeout.current) {
      clearTimeout(autoSkipTimeout.current);
      autoSkipTimeout.current = null;
    }
    if (timerInterval.current) {
      clearInterval(timerInterval.current);
      timerInterval.current = null;
    }
    setAutoSkipTimer(10);

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
        
        if (audioManager.current) {
          const currentMuteState = audioManager.current.getMuteState();
          if (currentMuteState) {
            audioManager.current.toggleMute();
          }
          setIsMuted(false);
        }
        
        showToast('Started reading session', 'success');
      } else if (action === 'skip') {
        showToast('Skipped turn - moved to back of queue', 'info');
      } else if (action === 'finish') {
        showToast('Finished reading - moved to back of queue', 'success');
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
      if (autoSkipTimeout.current) clearTimeout(autoSkipTimeout.current);
      if (timerInterval.current) clearInterval(timerInterval.current);
      if (documentPollingInterval.current) clearInterval(documentPollingInterval.current);

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
        const result = await response.json();
        
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

  // Effects
  useEffect(() => {
    if (userRole) {
      fetchSubGroups();
    }
    
    return () => {
      if (pollingInterval.current) clearInterval(pollingInterval.current);
      if (autoSkipTimeout.current) clearTimeout(autoSkipTimeout.current);
      if (timerInterval.current) clearInterval(timerInterval.current);
      if (documentPollingInterval.current) clearInterval(documentPollingInterval.current);
    };
  }, [userRole]);

  useEffect(() => {
    if (sessionId && hasJoined) {
      startPolling();
    }
  }, [sessionId, hasJoined]);

  useEffect(() => {
    if (queueStatus?.isPosition1) {
      if (!hasStartedReading) {
        setIsExpanded(true);
      }
      
      if (wasPosition2) {
        if (Notification.permission === 'granted') {
          new Notification("It's Your Turn!", { body: 'You are now at position 1. Please select an action.' });
        }
        setWasPosition2(false);
      }
      
      if (!hasStartedReading && !autoSkipTimeout.current) {
        startAutoSkipTimer();
      } else if (hasStartedReading) {
        if (autoSkipTimeout.current) {
          clearTimeout(autoSkipTimeout.current);
          autoSkipTimeout.current = null;
        }
        if (timerInterval.current) {
          clearInterval(timerInterval.current);
          timerInterval.current = null;
        }
      }
    } else {
      if (autoSkipTimeout.current) clearTimeout(autoSkipTimeout.current);
      if (timerInterval.current) clearInterval(timerInterval.current);
      setAutoSkipTimer(10);
      setHasStartedReading(false);
      
      if (audioManager.current && queueStatus) {
        const currentMuteState = audioManager.current.getMuteState();
        if (!currentMuteState) {
          audioManager.current.toggleMute();
        }
        setIsMuted(true);
      }
    }

    if (queueStatus?.isPosition2) {
      setWasPosition2(true);
    }
  }, [queueStatus?.isPosition1, queueStatus?.isPosition2, wasPosition2, hasStartedReading, startAutoSkipTimer]);

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

      {/* Main content */}
      <div className="flex-1 flex flex-col lg:flex-row">
        {/* PDF Viewer */}
        <div className="flex-1 relative">
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

        {/* Queue Panel */}
        <div className="w-full lg:w-80 bg-white/5 border-t lg:border-t-0 lg:border-l border-white/20 p-4">
          {/* Position Card */}
          <div 
            className={`card mb-4 cursor-pointer transition-all ${queueStatus?.isPosition1 ? 'ring-2 ring-green-500 pulse-animation' : ''}`}
            onClick={() => queueStatus?.isPosition1 && setIsExpanded(!isExpanded)}
            data-testid="position-card"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-white/70">Your Position</p>
                <p className="text-4xl font-bold">{queueStatus?.position || '-'}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-white/70">In Queue</p>
                <p className="text-2xl font-semibold">{queueStatus?.totalInQueue || 0}</p>
              </div>
              {queueStatus?.isPosition1 && (
                <div className="ml-2">
                  {isExpanded ? <ChevronUp size={24} /> : <ChevronDown size={24} />}
                </div>
              )}
            </div>
            
            {queueStatus?.isPosition1 && (
              <div className="mt-4 pt-4 border-t border-white/20">
                <p className="text-green-400 font-semibold text-center">🎉 It&apos;s Your Turn!</p>
              </div>
            )}
          </div>

          {/* Action Panel (Expanded) */}
          {isExpanded && queueStatus?.isPosition1 && (
            <div className="card mb-4" data-testid="action-panel">
              {!hasStartedReading && (
                <div className="text-center mb-4">
                  <p className="text-sm text-white/70">Auto-skip in</p>
                  <p className="text-3xl font-bold text-yellow-400">{autoSkipTimer}s</p>
                </div>
              )}
              
              <div className="space-y-3">
                {!hasStartedReading ? (
                  <>
                    <button
                      onClick={() => handleAction('start')}
                      className="btn-success w-full flex items-center justify-center gap-2"
                      data-testid="start-reading-btn"
                    >
                      <Play size={20} />
                      Start Reading
                    </button>
                    <button
                      onClick={() => handleAction('skip')}
                      className="btn-secondary w-full flex items-center justify-center gap-2"
                      data-testid="skip-btn"
                    >
                      <SkipForward size={20} />
                      Skip Turn
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => handleAction('finish')}
                    className="btn-primary w-full flex items-center justify-center gap-2"
                    data-testid="finish-btn"
                  >
                    <Check size={20} />
                    Finish Reading
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Queue Info */}
          <div className="card">
            <h3 className="font-semibold mb-3">Queue Status</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-white/70">Current Reader:</span>
                <span className={queueStatus?.isPosition1 ? 'text-green-400 font-semibold' : ''}>
                  {queueStatus?.position1Name || 'None'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/70">Next Up:</span>
                <span className={queueStatus?.isPosition2 ? 'text-yellow-400 font-semibold' : ''}>
                  {queueStatus?.position2Name || 'None'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/70">Your Name:</span>
                <span>{name}</span>
              </div>
            </div>
          </div>

          {/* Audio Status */}
          {audioInitialized && (
            <div className="card mt-4">
              <h3 className="font-semibold mb-2 flex items-center gap-2">
                {isMuted ? <VolumeX size={16} className="text-red-400" /> : <Volume2 size={16} className="text-green-400" />}
                Audio Status
              </h3>
              <p className="text-sm text-white/70">
                {isMuted ? 'Microphone muted' : 'Microphone active'}
              </p>
              {queueStatus?.isPosition1 && !hasStartedReading && (
                <p className="text-xs text-yellow-400 mt-1">Click &quot;Start Reading&quot; to unmute</p>
              )}
            </div>
          )}
        </div>
      </div>
      
      <Toast {...toast} onHide={hideToast} />
    </div>
  );
};

export default HomePage;
