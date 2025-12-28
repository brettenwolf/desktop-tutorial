import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, BookOpen, Mic, MicOff, SkipForward, Play, Check, LogOut, Volume2, VolumeX, Info, X } from 'lucide-react';
import Toast from '../components/Toast';
import PDFViewer from '../components/PDFViewer';
import AudioManager from '../utils/AudioManager';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

// Timer duration for Position 2 (in seconds)
const POSITION_2_TIMER_DURATION = 10;

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
  // Track if we just became Position 1 (for timer)
  const [justBecamePosition1, setJustBecamePosition1] = useState(false);
  const [wasPosition1, setWasPosition1] = useState(false);
  const [hasStartedReading, setHasStartedReading] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null);
  
  // Position 2 timer state
  const [position2Timer, setPosition2Timer] = useState(POSITION_2_TIMER_DURATION);
  const [isPosition2TimerActive, setIsPosition2TimerActive] = useState(false);
  
  // Audio connection status
  const [audioConnectionStatus, setAudioConnectionStatus] = useState('initializing');
  const [connectedPeers, setConnectedPeers] = useState(0);
  
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
  
  // Info modal state
  const [showInfoModal, setShowInfoModal] = useState(false);
  
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
    setStatusMessage(null); // Clear any previous status message
    
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
      setStatusMessage(null); // Ensure status is clear for new session
      
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
      
      // Set up status callback
      audioManager.current.setStatusCallback((status, peerCount) => {
        setAudioConnectionStatus(status);
        setConnectedPeers(peerCount);
      });
      
      const success = await audioManager.current.initialize(startMuted);
      
      if (success) {
        setAudioInitialized(true);
        setIsMuted(startMuted);
        console.log(`Audio initialized successfully for sub-group '${subGroup}'`);
      } else {
        // Even if audio init fails, show the controls (they'll be disabled)
        setAudioInitialized(true);
        setIsMuted(true);
        console.log('Audio not available - showing disabled controls');
      }
    } catch (error) {
      console.error('Error initializing audio:', error);
      // Show controls even on error
      setAudioInitialized(true);
      setIsMuted(true);
      setAudioConnectionStatus('error');
    }
  };

  // Toggle mute - also enables audio playback on iOS when unmuting
  const toggleMute = async () => {
    if (audioManager.current) {
      const newMutedState = audioManager.current.toggleMute();
      setIsMuted(newMutedState);
      
      // On iOS, clicking Unmute is a user gesture that allows audio playback
      if (!newMutedState && audioManager.current.enableAudioPlayback) {
        await audioManager.current.enableAudioPlayback();
      }
      
      console.log(`User manually ${newMutedState ? 'muted' : 'unmuted'}`);
    } else {
      // Toggle visual state even if audio not available
      setIsMuted(prev => !prev);
      console.log('Audio not available - toggling visual state only');
    }
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
    
    // Session ended - user will see they're back at welcome screen
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
          // Removed toast - only show status message inline
          fetchQueueStatus();
        }
      } catch (error) {
        console.error('Auto-skip error:', error);
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
    setJustBecamePosition1(false); // Clear the "just became" state when action is taken

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
        setJustBecamePosition1(false); // Clear timer display when started reading
        
        // Unmute when starting to read
        if (audioManager.current) {
          const currentMuteState = audioManager.current.getMuteState();
          if (currentMuteState) {
            audioManager.current.toggleMute();
          }
          setIsMuted(false);
        }
        
        // Removed toast - action is visually obvious
        setStatusMessage(null); // Clear any previous status
      } else if (action === 'skip') {
        setStatusMessage('Moved to end of queue.');
        setHasStartedReading(false);
        // Removed duplicate toast - status message is enough
      } else if (action === 'finish') {
        setHasStartedReading(false);
        setStatusMessage('Finished reading - moved to end of queue.');
        // Removed duplicate toast - status message is enough
      }
      
      await fetchQueueStatus();
    } catch (error) {
      // Keep error toasts for critical failures
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
      }
      // Removed toast for no PDF - the "Waiting for document" UI is clear enough
    } catch (error) {
      console.error('Auto-load error:', error);
      // Removed toast - UI already shows "Waiting for document"
    } finally {
      setUploadingDocument(false);
    }
  };

  // Clear status message when position changes significantly
  useEffect(() => {
    // Clear status message immediately when becoming Position 1 or Position 2
    // Clear ALL status messages when at position 1 (fresh start)
    if (queueStatus?.isPosition1 && statusMessage) {
      setStatusMessage(null);
    }
    
    // Clear status messages when at position 2 (except inactivity messages which should show briefly)
    if (queueStatus?.isPosition2 && statusMessage && !statusMessage.includes('inactivity')) {
      setStatusMessage(null);
    }
    
    // Clear any status message after 3 seconds when in lower positions
    if (queueStatus && !queueStatus.isPosition1 && !queueStatus.isPosition2 && statusMessage) {
      const timer = setTimeout(() => {
        setStatusMessage(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [queueStatus?.position, queueStatus?.isPosition1, queueStatus?.isPosition2, statusMessage]);

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

  // Handle Position 2 tracking
  useEffect(() => {
    if (queueStatus?.isPosition2) {
      setWasPosition2(true);
    }
    // Note: We don't reset wasPosition2 to false here - it stays true
    // so we know they were Position 2 at some point before becoming Position 1
  }, [queueStatus?.isPosition2]);

  // Start timer when user advances TO Position 1
  useEffect(() => {
    if (queueStatus?.isPosition1 && !wasPosition1) {
      // Just became Position 1
      setWasPosition1(true);
      setStatusMessage(null); // Clear any old status messages when becoming Position 1
      
      // Start timer if we were previously Position 2 (meaning we advanced)
      // and haven't started reading yet
      if (wasPosition2 && !hasStartedReading) {
        setJustBecamePosition1(true);
        startPosition2Timer();
      }
      
      // Reset wasPosition2 now that we've used it
      setWasPosition2(false);
      
      // Browser notification (not supported on iOS)
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification("It's Your Turn!", { body: 'You are now at position 1. Please select an action.' });
      }
    } else if (!queueStatus?.isPosition1 && wasPosition1) {
      // No longer Position 1 (moved to back of queue or left)
      setWasPosition1(false);
      setJustBecamePosition1(false);
      clearPosition2Timer();
      setHasStartedReading(false);
      // Don't reset wasPosition2 here - they might come back to Position 2
    }
  }, [queueStatus?.isPosition1, wasPosition1, wasPosition2, hasStartedReading, startPosition2Timer]);

  // Mute audio when not position 1
  useEffect(() => {
    if (!queueStatus?.isPosition1) {
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

  // Request notification permission (not supported on iOS)
  useEffect(() => {
    if (typeof Notification !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Render welcome screen
  if (!userRole) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="card max-w-md w-full text-center relative">
          {/* Info Icon */}
          <button
            onClick={() => setShowInfoModal(true)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-all"
            title="How to use ReadQueue"
          >
            <Info size={20} className="text-blue-400" />
          </button>
          
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
        
        {/* Info Modal */}
        {showInfoModal && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
            <div className="bg-slate-800 rounded-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto">
              {/* Modal Header */}
              <div className="sticky top-0 bg-slate-800 p-4 border-b border-white/10 flex items-center justify-between">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <Info size={24} className="text-blue-400" />
                  About ReadQueue
                </h2>
                <button
                  onClick={() => setShowInfoModal(false)}
                  className="p-2 rounded-lg hover:bg-white/10 transition-all"
                >
                  <X size={20} />
                </button>
              </div>
              
              {/* Modal Content */}
              <div className="p-6 space-y-6">
                {/* What is ReadQueue */}
                <section>
                  <h3 className="text-lg font-semibold text-blue-400 mb-3">What is ReadQueue?</h3>
                  <p className="text-white/80 leading-relaxed">
                    ReadQueue is a group reading queue management application designed to help organize 
                    and coordinate group reading sessions. Participants join a queue, and when it's their 
                    turn, they can read aloud from the shared PDF document displayed on screen.
                  </p>
                </section>
                
                {/* How to Use - Participants */}
                <section>
                  <h3 className="text-lg font-semibold text-green-400 mb-3">For Participants</h3>
                  <ol className="text-white/80 space-y-2 list-decimal list-inside">
                    <li><strong>Join a Group:</strong> Click "Join a Group" and enter your name, then select which reading group you want to join.</li>
                    <li><strong>Wait Your Turn:</strong> Your position in the queue is displayed. When you're next (Position 2), a countdown timer will appear.</li>
                    <li><strong>Start Reading:</strong> When you reach Position 1, click "Start Reading" to begin your turn.</li>
                    <li><strong>Skip Turn:</strong> If you need to pass, click "Skip" to move to the back of the queue.</li>
                    <li><strong>Finish Reading:</strong> When done, click "Finish Reading" to let the next person go.</li>
                    <li><strong>Leave Queue:</strong> Click "Leave Queue" in the header to exit the queue entirely.</li>
                  </ol>
                </section>
                
                {/* Position 1 Timer */}
                <section>
                  <h3 className="text-lg font-semibold text-yellow-400 mb-3">Action Timer</h3>
                  <p className="text-white/80 leading-relaxed">
                    When you advance to Position 1 (it&apos;s your turn), a 10-second timer starts. This gives you time 
                    to click "Start Reading", "Skip", or "Leave Queue". If the timer runs out without action, 
                    you&apos;ll automatically be moved to the back of the queue to keep the session flowing smoothly.
                  </p>
                </section>
                
                {/* Daily Reset */}
                <section>
                  <h3 className="text-lg font-semibold text-purple-400 mb-3">Daily Reset</h3>
                  <p className="text-white/80 leading-relaxed">
                    All queues are automatically cleared at the start of each new day (CST timezone). 
                    The PDF document for the day is selected based on the date, or a random PDF is chosen 
                    if no date-specific file exists.
                  </p>
                </section>
                
                {/* Divider */}
                <hr className="border-white/20" />
                
                {/* Admin Section */}
                <section>
                  <h3 className="text-lg font-semibold text-red-400 mb-3">For Administrators</h3>
                  <p className="text-white/80 mb-3">
                    The Admin Portal provides tools to manage the reading session. Access requires a PIN.
                  </p>
                  <ul className="text-white/80 space-y-2 list-disc list-inside">
                    <li><strong>PDF Library:</strong> Upload, view, and delete PDF documents. Date-based PDFs use the format MMDDYYYY_name.pdf.</li>
                    <li><strong>Random Folder:</strong> Upload fallback PDFs used when no date-specific file exists.</li>
                    <li><strong>Queue Management:</strong> View all groups and participants. Clear individual queues or all queues at once.</li>
                    <li><strong>Create Groups:</strong> Add new reading groups for different sessions or topics.</li>
                    <li><strong>Delete Groups:</strong> Remove groups that are no longer needed (except the default "General" group).</li>
                    <li><strong>Remove Participants:</strong> Remove individual users from the queue if needed.</li>
                  </ul>
                </section>
                
                {/* Tips */}
                <section className="bg-blue-500/10 rounded-lg p-4 border border-blue-500/30">
                  <h3 className="text-lg font-semibold text-blue-400 mb-2">Tips</h3>
                  <ul className="text-white/80 space-y-1 text-sm">
                    <li>• The currently loaded PDF is highlighted in green in the Admin library.</li>
                    <li>• Groups persist until an admin deletes them - they won't disappear automatically.</li>
                    <li>• Use the refresh button in the Admin header to reload all data.</li>
                  </ul>
                </section>
              </div>
              
              {/* Modal Footer */}
              <div className="sticky bottom-0 bg-slate-800 p-4 border-t border-white/10">
                <button
                  onClick={() => setShowInfoModal(false)}
                  className="btn-primary w-full"
                >
                  Got it!
                </button>
              </div>
            </div>
          </div>
        )}
        
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

  // Helper to get connection status display
  const getConnectionStatusDisplay = () => {
    switch (audioConnectionStatus) {
      case 'connected':
        return { text: `${connectedPeers} peer${connectedPeers !== 1 ? 's' : ''}`, color: 'text-green-400', bg: 'bg-green-500/20' };
      case 'ready':
        return { text: 'Ready', color: 'text-yellow-400', bg: 'bg-yellow-500/20' };
      case 'initializing':
        return { text: 'Starting...', color: 'text-blue-400', bg: 'bg-blue-500/20' };
      case 'requesting_mic':
        return { text: 'Mic access...', color: 'text-blue-400', bg: 'bg-blue-500/20' };
      case 'mic_denied':
        return { text: 'Mic denied', color: 'text-red-400', bg: 'bg-red-500/20' };
      case 'ice_failed':
        return { text: 'Connection failed', color: 'text-red-400', bg: 'bg-red-500/20' };
      default:
        return { text: 'Offline', color: 'text-gray-400', bg: 'bg-gray-500/20' };
    }
  };

  const connectionStatus = getConnectionStatusDisplay();

  // Render main queue view
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Fixed Header - Mobile Responsive */}
      <div className="flex-shrink-0 bg-white/10 backdrop-blur-md p-2 sm:p-4 border-b border-white/20 z-10">
        {/* Top row: Logo and Audio Controls */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-4">
            <div className="text-xl sm:text-2xl">📖</div>
            <div>
              <h1 className="font-bold text-sm sm:text-base">ReadQueue</h1>
              <p className="text-xs sm:text-sm text-white/70">{queueStatus?.subGroup || selectedSubGroup}</p>
            </div>
          </div>
          
          {/* Audio Controls - Compact for Mobile */}
          {audioInitialized && (
            <div className="flex items-center gap-1 sm:gap-2">
              {/* Connection Status - Hidden on very small screens */}
              <div className={`hidden sm:block px-2 py-1 rounded text-xs ${connectionStatus.bg} ${connectionStatus.color}`}>
                {connectionStatus.text}
              </div>
              
              {/* Mute Button */}
              <button
                onClick={() => { if (!isMuted) toggleMute(); }}
                className={`px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg text-xs sm:text-sm font-medium transition-all flex items-center gap-1 ${
                  isMuted 
                    ? 'bg-red-500 text-white ring-2 ring-red-400' 
                    : 'bg-white/10 text-white/70 hover:bg-white/20'
                }`}
              >
                <MicOff size={14} />
                <span className="hidden sm:inline">Muted</span>
              </button>
              
              {/* Mic Icon - Smaller on mobile */}
              <div className={`p-1.5 sm:p-2 rounded-full ${isMuted ? 'bg-red-500/20' : 'bg-green-500/20'}`}>
                {isMuted ? (
                  <MicOff size={18} className="text-red-400 sm:w-6 sm:h-6" />
                ) : (
                  <Mic size={18} className="text-green-400 sm:w-6 sm:h-6" />
                )}
              </div>
              
              {/* Unmute Button */}
              <button
                onClick={() => { if (isMuted) toggleMute(); }}
                className={`px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg text-xs sm:text-sm font-medium transition-all flex items-center gap-1 ${
                  !isMuted 
                    ? 'bg-green-500 text-white ring-2 ring-green-400' 
                    : 'bg-white/10 text-white/70 hover:bg-white/20'
                }`}
              >
                <Mic size={14} />
                <span className="hidden sm:inline">Unmuted</span>
              </button>
              
              {/* Mobile-only status indicator */}
              <div className={`sm:hidden px-1.5 py-1 rounded text-xs ${connectionStatus.bg} ${connectionStatus.color}`}>
                {connectedPeers > 0 ? `${connectedPeers}` : '•'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Fixed Queue Status Panel - Mobile Responsive */}
      <div className="flex-shrink-0 bg-white/5 border-b border-white/20 p-2 sm:p-4 z-10">
        <div className="max-w-4xl mx-auto">
          {/* Status Message */}
          {statusMessage && (
            <div className="bg-yellow-500/20 border border-yellow-500/30 rounded-lg p-2 sm:p-3 mb-2 sm:mb-4 text-center">
              <p className="text-yellow-400 font-medium text-sm sm:text-base">{statusMessage}</p>
            </div>
          )}
          
          <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4">
            {/* Position Info */}
            <div className="flex items-center gap-2 sm:gap-6">
              <div className={`text-center px-2 sm:px-4 py-1 sm:py-2 rounded-lg ${queueStatus?.isPosition1 ? 'bg-green-500/20 ring-2 ring-green-500' : queueStatus?.isPosition2 ? 'bg-yellow-500/20 ring-2 ring-yellow-500' : 'bg-white/10'}`}>
                <p className="text-xs text-white/70 uppercase">Your Position</p>
                <p className={`text-3xl font-bold ${queueStatus?.isPosition1 ? 'text-green-400' : queueStatus?.isPosition2 ? 'text-yellow-400' : ''}`}>
                  {queueStatus?.position || '-'}
                </p>
              </div>
              
              <div className="text-center px-2 sm:px-4 py-1 sm:py-2 rounded-lg bg-white/10">
                <p className="text-xs text-white/70 uppercase">Total</p>
                <p className="text-xl sm:text-3xl font-bold">{queueStatus?.totalInQueue || 0}</p>
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
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                {/* Timer for newly advanced Position 1 */}
                {justBecamePosition1 && isPosition2TimerActive && !hasStartedReading && (
                  <div className={`text-center px-2 sm:px-4 py-1 sm:py-2 rounded-lg ${position2Timer <= 5 ? 'bg-red-500/20' : 'bg-green-500/20'}`}>
                    <p className="text-xs text-white/70 uppercase">Act</p>
                    <p className={`text-lg sm:text-2xl font-bold ${position2Timer <= 5 ? 'text-red-400' : 'text-green-400'}`}>
                      {position2Timer}s
                    </p>
                  </div>
                )}
                
                {!hasStartedReading ? (
                  <>
                    <button
                      onClick={() => handleAction('start')}
                      className="btn-success flex items-center gap-1 sm:gap-2 text-sm sm:text-base px-2 sm:px-4 py-1.5 sm:py-2"
                      data-testid="start-reading-btn"
                    >
                      <Play size={16} className="sm:w-5 sm:h-5" />
                      <span className="hidden sm:inline">Start Reading</span>
                      <span className="sm:hidden">Start</span>
                    </button>
                    <button
                      onClick={() => handleAction('skip')}
                      className="btn-secondary flex items-center gap-1 sm:gap-2 text-sm sm:text-base px-2 sm:px-4 py-1.5 sm:py-2"
                      data-testid="skip-btn"
                    >
                      <SkipForward size={16} className="sm:w-5 sm:h-5" />
                      Skip
                    </button>
                    <button
                      onClick={leaveQueue}
                      className="btn-danger flex items-center gap-1 sm:gap-2 text-sm sm:text-base px-2 sm:px-4 py-1.5 sm:py-2"
                      data-testid="leave-queue-btn"
                    >
                      <LogOut size={14} className="sm:w-[18px] sm:h-[18px]" />
                      <span className="hidden sm:inline">Leave</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => handleAction('finish')}
                      className="btn-primary flex items-center gap-1 sm:gap-2 text-sm sm:text-base px-2 sm:px-4 py-1.5 sm:py-2"
                      data-testid="finish-btn"
                    >
                      <Check size={16} className="sm:w-5 sm:h-5" />
                      <span className="hidden sm:inline">Finish Reading</span>
                      <span className="sm:hidden">Finish</span>
                    </button>
                    <button
                      onClick={leaveQueue}
                      className="btn-danger flex items-center gap-1 sm:gap-2 text-sm sm:text-base px-2 sm:px-4 py-1.5 sm:py-2"
                      data-testid="leave-queue-btn"
                    >
                      <LogOut size={14} className="sm:w-[18px] sm:h-[18px]" />
                      <span className="hidden sm:inline">Leave</span>
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Position 2 Info (no timer - timer only shows when advancing to Position 1) */}
            {queueStatus?.isPosition2 && (
              <div className="flex items-center gap-2 sm:gap-4">
                <div className="text-right">
                  <p className="text-yellow-400 font-semibold text-sm sm:text-base">You&apos;re next!</p>
                  <p className="text-xs sm:text-sm text-white/70">Be ready</p>
                </div>
                <button
                  onClick={leaveQueue}
                  className="btn-danger flex items-center gap-1 sm:gap-2 text-sm sm:text-base px-2 sm:px-4 py-1.5 sm:py-2"
                  data-testid="leave-queue-btn"
                >
                  <LogOut size={14} className="sm:w-[18px] sm:h-[18px]" />
                  <span className="hidden sm:inline">Leave</span>
                </button>
              </div>
            )}

            {/* Other positions - show Leave Queue button */}
            {!queueStatus?.isPosition1 && !queueStatus?.isPosition2 && (
              <div className="flex items-center gap-2 sm:gap-4">
                <p className="text-xs sm:text-sm text-white/70">
                  <span className="hidden sm:inline">Your name: </span>
                  <span className="text-white font-medium">{name}</span>
                </p>
                <button
                  onClick={leaveQueue}
                  className="btn-danger flex items-center gap-1 sm:gap-2 text-sm sm:text-base px-2 sm:px-4 py-1.5 sm:py-2"
                  data-testid="leave-queue-btn"
                >
                  <LogOut size={14} className="sm:w-[18px] sm:h-[18px]" />
                  <span className="hidden sm:inline">Leave</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Scrollable PDF Viewer Area */}
      <div className="flex-1 overflow-y-auto">
        {documentStatus.loaded && documentData ? (
          <PDFViewer backendUrl={BACKEND_URL} />
        ) : (
          <div className="flex items-center justify-center h-full min-h-[200px] sm:min-h-[400px]">
            <div className="text-center">
              {uploadingDocument ? (
                <>
                  <div className="animate-spin rounded-full h-8 w-8 sm:h-12 sm:w-12 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
                  <p className="text-white/70 text-sm sm:text-base">Loading document...</p>
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
