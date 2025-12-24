import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Upload, Trash2, RefreshCw, Users, FileText, FolderOpen, Plus, X, AlertTriangle } from 'lucide-react';
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

  const fetchAllData = () => {
    fetchLibrary();
    fetchRandomLibrary();
    fetchQueue();
    fetchSubGroups();
    fetchDocumentStatus();
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
        fetchLibrary();
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

    // Validate all files are PDFs
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
    fetchRandomLibrary();

    if (failCount === 0) {
      showToast(`${successCount} PDF(s) uploaded to Random folder`, 'success');
    } else {
      showToast(`${successCount} uploaded, ${failCount} failed`, 'error');
    }
  };

  // Delete PDF from library
  const handleDeleteFile = async (filename, isRandom = false) => {
    if (!window.confirm(`Delete ${filename}?`)) return;

    try {
      const endpoint = isRandom 
        ? `${API}/document/library/random/${encodeURIComponent(filename)}`
        : `${API}/document/library/${encodeURIComponent(filename)}`;
      
      const response = await fetch(endpoint, { method: 'DELETE' });

      if (response.ok) {
        showToast('File deleted', 'success');
        if (isRandom) {
          fetchRandomLibrary();
        } else {
          fetchLibrary();
        }
      } else {
        const error = await response.json();
        showToast(error.detail || 'Delete failed', 'error');
      }
    } catch (error) {
      console.error('Error deleting:', error);
      showToast('Delete failed', 'error');
    }
  };

  // Create sub-group
  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) {
      showToast('Please enter a group name', 'error');
      return;
    }

    try {
      const response = await fetch(`${API}/subgroups/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newGroupName.trim() }),
      });

      if (response.ok) {
        showToast('Group created', 'success');
        setNewGroupName('');
        fetchSubGroups();
      } else {
        const error = await response.json();
        showToast(error.detail || 'Create failed', 'error');
      }
    } catch (error) {
      console.error('Error creating group:', error);
      showToast('Create failed', 'error');
    }
  };

  // Delete sub-group
  const handleDeleteGroup = async (name) => {
    if (!window.confirm(`Delete group "${name}"? This will remove all participants.`)) return;

    try {
      const response = await fetch(`${API}/subgroups/delete/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        showToast('Group deleted', 'success');
        fetchSubGroups();
        fetchQueue();
      } else {
        const error = await response.json();
        showToast(error.detail || 'Delete failed', 'error');
      }
    } catch (error) {
      console.error('Error deleting group:', error);
      showToast('Delete failed', 'error');
    }
  };

  // Clear document and reset everything
  const handleClearAllAndReset = async () => {
    if (!window.confirm('This will clear the current document and remove ALL participants from ALL queues. Are you sure?')) return;

    try {
      // Clear document (this also clears all queues on the backend)
      const response = await fetch(`${API}/document/clear`, { method: 'DELETE' });

      if (response.ok) {
        showToast('Document cleared and all queues reset', 'success');
        fetchDocumentStatus();
        fetchQueue();
        fetchSubGroups();
      } else {
        showToast('Reset failed', 'error');
      }
    } catch (error) {
      console.error('Error resetting:', error);
      showToast('Reset failed', 'error');
    }
  };

  // Force reload document
  const handleForceReload = async () => {
    try {
      const response = await fetch(`${API}/document/auto-load?force=true`);
      if (response.ok) {
        showToast('Document reloaded', 'success');
        fetchDocumentStatus();
      } else {
        const error = await response.json();
        showToast(error.detail || 'Reload failed', 'error');
      }
    } catch (error) {
      console.error('Error reloading:', error);
      showToast('Reload failed', 'error');
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
                className="btn-secondary text-sm py-2 px-3 flex items-center gap-1"
              >
                <RefreshCw size={16} />
                Reload
              </button>
            </div>
          ) : (
            <p className="text-white/70">No document loaded</p>
          )}
        </div>

        {/* PDF Library */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold flex items-center gap-2">
              <FolderOpen size={20} />
              PDF Library (Date-based)
            </h3>
            <label className="btn-primary text-sm py-2 px-4 cursor-pointer flex items-center gap-2">
              <Upload size={16} />
              Upload PDF
              <input
                type="file"
                accept=".pdf"
                onChange={(e) => handleLibraryUpload(e, false)}
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
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
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
                    className="p-2 text-red-400 hover:bg-red-500/20 rounded-lg transition-all"
                  >
                    <Trash2 size={18} />
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
            <label className="btn-secondary text-sm py-2 px-4 cursor-pointer flex items-center gap-2">
              <Upload size={16} />
              Upload to Random
              <input
                type="file"
                accept=".pdf"
                onChange={(e) => handleLibraryUpload(e, true)}
                className="hidden"
                disabled={uploading}
              />
            </label>
          </div>
          <p className="text-sm text-white/70 mb-4">
            PDFs here are used randomly when no date-specific PDF is found
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
                    className="p-2 text-red-400 hover:bg-red-500/20 rounded-lg transition-all"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Queue Management */}
        <div className="card">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <Users size={20} />
            Queue Management
          </h3>
          
          {/* Create Group */}
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="New group name"
              className="input-field flex-1"
              onKeyPress={(e) => e.key === 'Enter' && handleCreateGroup()}
              data-testid="new-group-name-input"
            />
            <button
              onClick={handleCreateGroup}
              className="btn-primary flex items-center gap-2"
              data-testid="create-group-admin-btn"
            >
              <Plus size={18} />
              Create Group
            </button>
          </div>

          {/* Groups List */}
          <div className="mb-4">
            <p className="text-sm text-white/70 mb-2">
              Groups ({subGroups.length}) • Total Participants: {getTotalParticipants()}
            </p>
            {subGroups.length === 0 ? (
              <p className="text-white/50 text-center py-4">No groups created</p>
            ) : (
              <div className="space-y-3 max-h-64 overflow-y-auto">
                {subGroups.map((group) => {
                  const groupQueue = queueData.filter(p => p.subGroup === group.name);
                  return (
                    <div key={group.id} className="p-4 bg-white/5 rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <p className="font-semibold">{group.name}</p>
                          <p className="text-sm text-white/70">{groupQueue.length} participants</p>
                        </div>
                        <div className="flex gap-2">
                          {group.name !== 'General' && (
                            <button
                              onClick={() => handleDeleteGroup(group.name)}
                              className="p-2 text-red-400 hover:bg-red-500/20 rounded-lg transition-all"
                              title="Delete group"
                            >
                              <X size={18} />
                            </button>
                          )}
                        </div>
                      </div>
                      {groupQueue.length > 0 && (
                        <div className="mt-3 space-y-1">
                          {groupQueue.map((p, idx) => (
                            <div key={p.sessionId} className="flex items-center gap-2 text-sm">
                              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
                                idx === 0 ? 'bg-green-500' : idx === 1 ? 'bg-yellow-500' : 'bg-white/20'
                              }`}>
                                {idx + 1}
                              </span>
                              <span>{p.name}</span>
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

        {/* Reset Everything Button */}
        <div className="card bg-red-500/10 border-red-500/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertTriangle size={24} className="text-red-400" />
              <div>
                <p className="font-semibold text-red-400">Reset Session</p>
                <p className="text-sm text-white/70">Clear document and remove all participants from all queues</p>
              </div>
            </div>
            <button
              onClick={handleClearAllAndReset}
              className="btn-danger flex items-center gap-2"
              data-testid="reset-all-btn"
            >
              <Trash2 size={18} />
              Clear All & Reset
            </button>
          </div>
        </div>
      </div>

      <Toast {...toast} onHide={hideToast} />
    </div>
  );
};

export default AdminPage;
