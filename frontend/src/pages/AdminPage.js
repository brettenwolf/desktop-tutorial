import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Upload, Trash2, RefreshCw, Users, FileText, FolderOpen, Plus, AlertTriangle, Loader2, UserMinus } from 'lucide-react';
import Toast from '../components/Toast';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;
const ADMIN_PIN = '2525';

const AdminPage = () => {
  const navigate = useNavigate();
  
  // Auth state
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [pinInput, setPinInput] = useState('');
  
  // Library state
  const [libraryFiles, setLibraryFiles] = useState([]);
  const [randomFiles, setRandomFiles] = useState([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [uploading, setUploading] = useState(false);
  
  // Queue state
  const [queueData, setQueueData] = useState([]);
  const [subGroups, setSubGroups] = useState([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [loadingQueue, setLoadingQueue] = useState(false);
  
  // Document state
  const [documentStatus, setDocumentStatus] = useState({ loaded: false, filename: null });
  
  // Action states for loading indicators
  const [deletingFile, setDeletingFile] = useState(null);
  const [resettingAll, setResettingAll] = useState(false);
  const [clearingGroup, setClearingGroup] = useState(null);
  const [reloading, setReloading] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [removingParticipant, setRemovingParticipant] = useState(null);
  
  // Toast state
  const [toast, setToast] = useState({ visible: false, message: '', type: 'info' });

  const showToast = (message, type = 'info') => {
    setToast({ visible: true, message, type });
  };

  const hideToast = () => {
    setToast({ visible: false, message: '', type: 'info' });
  };

  // PIN Authentication
  const handlePinSubmit = (e) => {
    e.preventDefault();
    if (pinInput === ADMIN_PIN) {
      setIsAuthenticated(true);
      localStorage.setItem('adminAuth', 'true');
    } else {
      showToast('Invalid PIN', 'error');
      setPinInput('');
    }
  };

  // Check auth on mount
  useEffect(() => {
    const auth = localStorage.getItem('adminAuth');
    if (auth === 'true') {
      setIsAuthenticated(true);
    }
  }, []);

  // Fetch all data when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      fetchAllData();
    }
  }, [isAuthenticated]);

  const fetchAllData = async () => {
    await Promise.all([
      fetchLibrary(),
      fetchRandomLibrary(),
      fetchQueue(),
      fetchSubGroups(),
      fetchDocumentStatus()
    ]);
  };

  // Fetch library files
  const fetchLibrary = async () => {
    try {
      setLoadingLibrary(true);
      const response = await fetch(`${API}/document/library`);
      if (response.ok) {
        const data = await response.json();
        setLibraryFiles(data.files || []);
      }
    } catch (error) {
      console.error('Error fetching library:', error);
    } finally {
      setLoadingLibrary(false);
    }
  };

  // Fetch random library files
  const fetchRandomLibrary = async () => {
    try {
      const response = await fetch(`${API}/document/library/random`);
      if (response.ok) {
        const data = await response.json();
        setRandomFiles(data.files || []);
      }
    } catch (error) {
      console.error('Error fetching random library:', error);
    }
  };

  // Fetch queue
  const fetchQueue = async () => {
    try {
      setLoadingQueue(true);
      const response = await fetch(`${API}/queue/all`);
      if (response.ok) {
        const data = await response.json();
        setQueueData(data.queue || []);
      }
    } catch (error) {
      console.error('Error fetching queue:', error);
    } finally {
      setLoadingQueue(false);
    }
  };

  // Fetch sub-groups
  const fetchSubGroups = async () => {
    try {
      const response = await fetch(`${API}/subgroups/list`);
      if (response.ok) {
        const data = await response.json();
        setSubGroups(data.subgroups || []);
      }
    } catch (error) {
      console.error('Error fetching sub-groups:', error);
    }
  };

  // Fetch document status
  const fetchDocumentStatus = async () => {
    try {
      const response = await fetch(`${API}/document/status`);
      if (response.ok) {
        const data = await response.json();
        setDocumentStatus(data);
      }
    } catch (error) {
      console.error('Error fetching document status:', error);
    }
  };

  // Upload PDF to library (single file)
  const handleLibraryUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.name.endsWith('.pdf')) {
      showToast('Only PDF files are allowed', 'error');
      return;
    }

    try {
      setUploading(true);
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`${API}/document/library/upload`, {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        showToast('PDF uploaded successfully', 'success');
        await fetchLibrary();
      } else {
        const error = await response.json();
        showToast(error.detail || 'Upload failed', 'error');
      }
    } catch (error) {
      console.error('Error uploading:', error);
      showToast('Upload failed', 'error');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  // Upload multiple PDFs to Random folder
  const handleRandomUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    const invalidFiles = files.filter(f => !f.name.endsWith('.pdf'));
    if (invalidFiles.length > 0) {
      showToast(`${invalidFiles.length} file(s) skipped - only PDFs allowed`, 'error');
    }

    const validFiles = files.filter(f => f.name.endsWith('.pdf'));
    if (!validFiles.length) {
      e.target.value = '';
      return;
    }

    setUploading(true);
    showToast(`Uploading ${validFiles.length} file(s)...`, 'info');
    
    let successCount = 0;
    let failCount = 0;

    for (const file of validFiles) {
      try {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(`${API}/document/library/random/upload`, {
          method: 'POST',
          body: formData,
        });

        if (response.ok) {
          successCount++;
        } else {
          failCount++;
        }
      } catch (error) {
        console.error(`Error uploading ${file.name}:`, error);
        failCount++;
      }
    }

    setUploading(false);
    e.target.value = '';
    await fetchRandomLibrary();

    if (failCount === 0) {
      showToast(`${successCount} PDF(s) uploaded to Random folder`, 'success');
    } else {
      showToast(`${successCount} uploaded, ${failCount} failed`, 'error');
    }
  };

  // Delete PDF from library
  const handleDeleteFile = async (filename, isRandom = false) => {
    if (!window.confirm(`Delete "${filename}"?`)) return;

    const fileKey = `${isRandom ? 'random-' : ''}${filename}`;
    setDeletingFile(fileKey);

    try {
      const endpoint = isRandom 
        ? `${API}/document/library/random/${encodeURIComponent(filename)}`
        : `${API}/document/library/${encodeURIComponent(filename)}`;
      
      const response = await fetch(endpoint, { method: 'DELETE' });

      if (response.ok) {
        showToast(`"${filename}" deleted successfully`, 'success');
        if (isRandom) {
          await fetchRandomLibrary();
        } else {
          await fetchLibrary();
        }
      } else {
        const error = await response.json();
        showToast(error.detail || 'Delete failed', 'error');
      }
    } catch (error) {
      console.error('Error deleting:', error);
      showToast('Delete failed', 'error');
    } finally {
      setDeletingFile(null);
    }
  };

  // Create sub-group
  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) {
      showToast('Please enter a group name', 'error');
      return;
    }

    setCreatingGroup(true);

    try {
      const response = await fetch(`${API}/subgroups/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newGroupName.trim() }),
      });

      if (response.ok) {
        showToast(`Group "${newGroupName}" created successfully`, 'success');
        setNewGroupName('');
        await fetchSubGroups();
      } else {
        const error = await response.json();
        showToast(error.detail || 'Create failed', 'error');
      }
    } catch (error) {
      console.error('Error creating group:', error);
      showToast('Create failed', 'error');
    } finally {
      setCreatingGroup(false);
    }
  };

  // Clear queue for specific group (clears participants only, keeps the group)
  const handleClearGroupQueue = async (groupName) => {
    if (!window.confirm(`Clear all participants from "${groupName}"?`)) return;

    setClearingGroup(groupName);

    try {
      const response = await fetch(`${API}/queue/clear/${encodeURIComponent(groupName)}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        const data = await response.json();
        // Immediately update local state
        setQueueData(prev => prev.filter(p => p.subGroup !== groupName));
        showToast(`Cleared ${data.count} participant(s) from "${groupName}"`, 'success');
        // Then refresh from server to ensure sync
        await fetchQueue();
      } else {
        const error = await response.json();
        showToast(error.detail || 'Clear failed', 'error');
      }
    } catch (error) {
      console.error('Error clearing group queue:', error);
      showToast('Clear failed', 'error');
    } finally {
      setClearingGroup(null);
    }
  };

  // Remove individual participant
  const handleRemoveParticipant = async (sessionId, name) => {
    if (!window.confirm(`Remove "${name}" from the queue?`)) return;

    setRemovingParticipant(sessionId);

    try {
      const response = await fetch(`${API}/queue/remove/${sessionId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        // Immediately update local state
        setQueueData(prev => prev.filter(p => p.sessionId !== sessionId));
        showToast(`Removed "${name}" from queue`, 'success');
        // Then refresh from server
        await fetchQueue();
      } else {
        const error = await response.json();
        showToast(error.detail || 'Remove failed', 'error');
      }
    } catch (error) {
      console.error('Error removing participant:', error);
      showToast('Remove failed', 'error');
    } finally {
      setRemovingParticipant(null);
    }
  };

  // Clear ALL queues (all groups) - keeps document loaded
  const handleClearAllQueues = async () => {
    if (!window.confirm('Clear ALL participants from ALL groups? (Document will remain loaded)')) return;

    setResettingAll(true);

    try {
      const response = await fetch(`${API}/queue/clear-all`, { method: 'DELETE' });

      if (response.ok) {
        const data = await response.json();
        setQueueData([]);
        showToast(`Cleared all queues (${data.count} participants removed)`, 'success');
      } else {
        showToast('Clear failed', 'error');
      }
    } catch (error) {
      console.error('Error clearing all queues:', error);
      showToast('Clear failed', 'error');
    } finally {
      setResettingAll(false);
    }
  };

  // Full system reset - clears document AND all queues
  const handleClearAllAndReset = async () => {
    if (!window.confirm('FULL RESET: This will:\n\n1. Clear the current PDF document\n2. Remove ALL participants from ALL groups\n3. Preserve the random PDF selection for today\n\nAre you sure?')) return;

    setResettingAll(true);

    try {
      const response = await fetch(`${API}/document/clear`, { method: 'DELETE' });

      if (response.ok) {
        const data = await response.json();
        setQueueData([]);
        setDocumentStatus({ loaded: false, filename: null });
        
        await Promise.all([
          fetchDocumentStatus(),
          fetchQueue(),
          fetchSubGroups()
        ]);
        
        showToast('Full reset complete: Document cleared, all queues emptied', 'success');
      } else {
        showToast('Reset failed', 'error');
      }
    } catch (error) {
      console.error('Error resetting:', error);
      showToast('Reset failed - please try again', 'error');
    } finally {
      setResettingAll(false);
    }
  };

  // Force reload document
  const handleForceReload = async () => {
    setReloading(true);

    try {
      const response = await fetch(`${API}/document/auto-load?force=true`);
      if (response.ok) {
        const data = await response.json();
        showToast(`Document "${data.filename}" loaded`, 'success');
        await fetchDocumentStatus();
      } else {
        const error = await response.json();
        showToast(error.detail || 'Reload failed', 'error');
      }
    } catch (error) {
      console.error('Error reloading:', error);
      showToast('Reload failed', 'error');
    } finally {
      setReloading(false);
    }
  };

  // Logout
  const handleLogout = () => {
    localStorage.removeItem('adminAuth');
    setIsAuthenticated(false);
    navigate('/');
  };

  // Format file size
  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  // Get total participants count
  const getTotalParticipants = () => {
    return queueData.length;
  };

  // PIN Entry Screen
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="card max-w-sm w-full">
          <h2 className="text-2xl font-bold text-center mb-6">Admin Portal</h2>
          <form onSubmit={handlePinSubmit}>
            <input
              type="password"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              placeholder="Enter PIN"
              className="input-field text-center text-2xl tracking-widest mb-4"
              maxLength={4}
              autoFocus
              data-testid="pin-input"
            />
            <button
              type="submit"
              className="btn-primary w-full"
              data-testid="pin-submit-btn"
            >
              Enter
            </button>
          </form>
          <button
            onClick={() => navigate('/')}
            className="btn-secondary w-full mt-4"
          >
            Back to Home
          </button>
        </div>
        <Toast {...toast} onHide={hideToast} />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <div className="bg-white/10 backdrop-blur-md p-4 flex items-center justify-between border-b border-white/20">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/')}
            className="p-2 rounded-lg hover:bg-white/10 transition-all"
          >
            <ArrowLeft size={24} />
          </button>
          <h1 className="text-xl font-bold">Admin Portal</h1>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={fetchAllData}
            className="p-2 rounded-lg hover:bg-white/10 transition-all"
            title="Refresh all data"
          >
            <RefreshCw size={20} />
          </button>
          <button
            onClick={handleLogout}
            className="btn-secondary text-sm py-2 px-4"
          >
            Logout
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-4 max-w-6xl mx-auto space-y-6">
        
        {/* Current Document Status */}
        <div className="card">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <FileText size={20} />
            Current Document
          </h3>
          {documentStatus.loaded ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{documentStatus.filename}</p>
                <p className="text-sm text-white/70">Currently loaded</p>
              </div>
              <button
                onClick={handleForceReload}
                disabled={reloading}
                className="btn-secondary text-sm py-2 px-3 flex items-center gap-2 disabled:opacity-50"
              >
                {reloading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <RefreshCw size={16} />
                )}
                {reloading ? 'Reloading...' : 'Reload'}
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-white/70">No document loaded</p>
              <button
                onClick={handleForceReload}
                disabled={reloading}
                className="btn-primary text-sm py-2 px-3 flex items-center gap-2 disabled:opacity-50"
              >
                {reloading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <RefreshCw size={16} />
                )}
                {reloading ? 'Loading...' : 'Load Document'}
              </button>
            </div>
          )}
        </div>

        {/* PDF Library */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold flex items-center gap-2">
              <FolderOpen size={20} />
              PDF Library (Date-based)
            </h3>
            <label className={`btn-primary text-sm py-2 px-4 cursor-pointer flex items-center gap-2 ${uploading ? 'opacity-50 cursor-not-allowed' : ''}`}>
              {uploading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Upload size={16} />
              )}
              {uploading ? 'Uploading...' : 'Upload PDF'}
              <input
                type="file"
                accept=".pdf"
                onChange={handleLibraryUpload}
                className="hidden"
                disabled={uploading}
              />
            </label>
          </div>
          <p className="text-sm text-white/70 mb-4">
            Upload PDFs with format: MMDDYYYY_name.pdf (e.g., 08152025_reading.pdf)
          </p>
          {loadingLibrary ? (
            <div className="flex justify-center py-8">
              <Loader2 size={32} className="animate-spin text-blue-500" />
            </div>
          ) : libraryFiles.length === 0 ? (
            <p className="text-white/50 text-center py-4">No PDFs in library</p>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {libraryFiles.map((file) => (
                <div key={file.filename} className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                  <div>
                    <p className="font-medium">{file.filename}</p>
                    <p className="text-sm text-white/70">{formatSize(file.size)}</p>
                  </div>
                  <button
                    onClick={() => handleDeleteFile(file.filename, false)}
                    disabled={deletingFile === file.filename}
                    className="p-2 text-red-400 hover:bg-red-500/20 rounded-lg transition-all disabled:opacity-50"
                  >
                    {deletingFile === file.filename ? (
                      <Loader2 size={18} className="animate-spin" />
                    ) : (
                      <Trash2 size={18} />
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Random Library */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold flex items-center gap-2">
              <FolderOpen size={20} />
              Random Folder (Fallback)
            </h3>
            <label className={`btn-secondary text-sm py-2 px-4 cursor-pointer flex items-center gap-2 ${uploading ? 'opacity-50 cursor-not-allowed' : ''}`}>
              {uploading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Upload size={16} />
              )}
              {uploading ? 'Uploading...' : 'Upload to Random'}
              <input
                type="file"
                accept=".pdf"
                multiple
                onChange={handleRandomUpload}
                className="hidden"
                disabled={uploading}
              />
            </label>
          </div>
          <p className="text-sm text-white/70 mb-4">
            PDFs here are used randomly when no date-specific PDF is found. You can select multiple files.
          </p>
          {randomFiles.length === 0 ? (
            <p className="text-white/50 text-center py-4">No PDFs in Random folder</p>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {randomFiles.map((file) => (
                <div key={file.filename} className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                  <div>
                    <p className="font-medium">{file.filename}</p>
                    <p className="text-sm text-white/70">{formatSize(file.size)}</p>
                  </div>
                  <button
                    onClick={() => handleDeleteFile(file.filename, true)}
                    disabled={deletingFile === `random-${file.filename}`}
                    className="p-2 text-red-400 hover:bg-red-500/20 rounded-lg transition-all disabled:opacity-50"
                  >
                    {deletingFile === `random-${file.filename}` ? (
                      <Loader2 size={18} className="animate-spin" />
                    ) : (
                      <Trash2 size={18} />
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Queue Management */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold flex items-center gap-2">
              <Users size={20} />
              Queue Management
            </h3>
            <button
              onClick={handleClearAllQueues}
              disabled={resettingAll || getTotalParticipants() === 0}
              className="btn-secondary text-sm py-2 px-3 flex items-center gap-2 disabled:opacity-50"
              title="Clear all participants from all groups (keeps document)"
            >
              {resettingAll ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Trash2 size={16} />
              )}
              Clear All Queues
            </button>
          </div>
          
          {/* Create Group */}
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="New group name"
              className="input-field flex-1"
              onKeyPress={(e) => e.key === 'Enter' && handleCreateGroup()}
              disabled={creatingGroup}
              data-testid="new-group-name-input"
            />
            <button
              onClick={handleCreateGroup}
              disabled={creatingGroup || !newGroupName.trim()}
              className="btn-primary flex items-center gap-2 disabled:opacity-50"
              data-testid="create-group-admin-btn"
            >
              {creatingGroup ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <Plus size={18} />
              )}
              {creatingGroup ? 'Creating...' : 'Create Group'}
            </button>
          </div>

          {/* Groups List */}
          <div className="mb-4">
            <p className="text-sm text-white/70 mb-2">
              Groups ({subGroups.length}) • Total Participants: {getTotalParticipants()}
            </p>
            {loadingQueue ? (
              <div className="flex justify-center py-8">
                <Loader2 size={32} className="animate-spin text-blue-500" />
              </div>
            ) : subGroups.length === 0 ? (
              <p className="text-white/50 text-center py-4">No groups created</p>
            ) : (
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {subGroups.map((group) => {
                  const groupQueue = queueData.filter(p => p.subGroup === group.name);
                  return (
                    <div key={group.id} className="p-4 bg-white/5 rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <p className="font-semibold">{group.name}</p>
                          <p className="text-sm text-white/70">{groupQueue.length} participant{groupQueue.length !== 1 ? 's' : ''}</p>
                        </div>
                        {groupQueue.length > 0 && (
                          <button
                            onClick={() => handleClearGroupQueue(group.name)}
                            disabled={clearingGroup === group.name}
                            className="btn-danger text-xs py-1 px-3 flex items-center gap-1 disabled:opacity-50"
                            title={`Clear all participants from ${group.name}`}
                          >
                            {clearingGroup === group.name ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Trash2 size={14} />
                            )}
                            Clear Group
                          </button>
                        )}
                      </div>
                      {groupQueue.length > 0 && (
                        <div className="mt-3 space-y-1">
                          {groupQueue.map((p, idx) => (
                            <div key={p.sessionId} className="flex items-center justify-between text-sm bg-white/5 rounded px-2 py-1">
                              <div className="flex items-center gap-2">
                                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
                                  idx === 0 ? 'bg-green-500' : idx === 1 ? 'bg-yellow-500' : 'bg-white/20'
                                }`}>
                                  {idx + 1}
                                </span>
                                <span>{p.name}</span>
                              </div>
                              <button
                                onClick={() => handleRemoveParticipant(p.sessionId, p.name)}
                                disabled={removingParticipant === p.sessionId}
                                className="p-1 text-red-400 hover:bg-red-500/20 rounded transition-all disabled:opacity-50"
                                title={`Remove ${p.name}`}
                              >
                                {removingParticipant === p.sessionId ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <UserMinus size={14} />
                                )}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Full System Reset Button */}
        <div className="card bg-red-500/10 border-red-500/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertTriangle size={24} className="text-red-400" />
              <div>
                <p className="font-semibold text-red-400">Full System Reset</p>
                <p className="text-sm text-white/70">Clears the PDF document AND removes all participants from all groups</p>
              </div>
            </div>
            <button
              onClick={handleClearAllAndReset}
              disabled={resettingAll}
              className="btn-danger flex items-center gap-2 disabled:opacity-50"
              data-testid="reset-all-btn"
            >
              {resettingAll ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <Trash2 size={18} />
              )}
              {resettingAll ? 'Resetting...' : 'Clear All & Reset'}
            </button>
          </div>
        </div>

        {/* Info about daily reset */}
        <div className="card bg-blue-500/10 border-blue-500/30">
          <div className="flex items-center gap-3">
            <RefreshCw size={20} className="text-blue-400" />
            <div>
              <p className="font-semibold text-blue-400">Automatic Daily Reset</p>
              <p className="text-sm text-white/70">
                All queues are automatically cleared at the start of each new day (CST timezone). 
                The random PDF selection for the day is preserved.
              </p>
            </div>
          </div>
        </div>
      </div>

      <Toast {...toast} onHide={hideToast} />
    </div>
  );
};

export default AdminPage;
