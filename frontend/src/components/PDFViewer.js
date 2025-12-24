import React, { useState, useEffect, useRef } from 'react';
import { ZoomIn, ZoomOut, RotateCw, Loader2 } from 'lucide-react';

const PDFViewer = ({ backendUrl }) => {
  const [pageCount, setPageCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scale, setScale] = useState(1);
  const [loadedPages, setLoadedPages] = useState([]);
  const [loadingPages, setLoadingPages] = useState(new Set());
  const containerRef = useRef(null);

  const API = `${backendUrl}/api`;

  // Fetch page count on mount
  useEffect(() => {
    const fetchPages = async () => {
      try {
        setLoading(true);
        const response = await fetch(`${API}/document/pages`);
        if (response.ok) {
          const data = await response.json();
          setPageCount(data.pageCount);
          // Initialize loaded pages array
          setLoadedPages(new Array(data.pageCount).fill(null));
        } else {
          setError('Failed to load document');
        }
      } catch (err) {
        console.error('Error fetching pages:', err);
        setError('Failed to load document');
      } finally {
        setLoading(false);
      }
    };

    fetchPages();
  }, [API]);

  // Load all pages when page count is known
  useEffect(() => {
    if (pageCount > 0) {
      // Load all pages
      for (let i = 0; i < pageCount; i++) {
        loadPage(i);
      }
    }
  }, [pageCount]);

  // Load a single page
  const loadPage = async (pageIndex) => {
    if (loadingPages.has(pageIndex) || loadedPages[pageIndex]) return;

    setLoadingPages(prev => new Set([...prev, pageIndex]));

    try {
      const timestamp = Date.now();
      const imageUrl = `${API}/document/page/${pageIndex}?scale=2.0&quality=90&t=${timestamp}`;
      
      // Preload the image
      const img = new Image();
      img.onload = () => {
        setLoadedPages(prev => {
          const newPages = [...prev];
          newPages[pageIndex] = imageUrl;
          return newPages;
        });
        setLoadingPages(prev => {
          const newSet = new Set(prev);
          newSet.delete(pageIndex);
          return newSet;
        });
      };
      img.onerror = () => {
        console.error(`Failed to load page ${pageIndex}`);
        setLoadingPages(prev => {
          const newSet = new Set(prev);
          newSet.delete(pageIndex);
          return newSet;
        });
      };
      img.src = imageUrl;
    } catch (err) {
      console.error(`Error loading page ${pageIndex}:`, err);
      setLoadingPages(prev => {
        const newSet = new Set(prev);
        newSet.delete(pageIndex);
        return newSet;
      });
    }
  };

  const zoomIn = () => {
    setScale(Math.min(scale + 0.25, 3));
  };

  const zoomOut = () => {
    setScale(Math.max(scale - 0.25, 0.5));
  };

  const resetZoom = () => {
    setScale(1);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-center">
          <Loader2 size={48} className="animate-spin text-blue-500 mx-auto mb-4" />
          <p className="text-white/70">Loading document...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-center">
          <div className="text-6xl mb-4">⚠️</div>
          <p className="text-red-400">{error}</p>
        </div>
      </div>
    );
  }

  const loadedCount = loadedPages.filter(p => p !== null).length;

  return (
    <div className="flex flex-col h-full">
      {/* Controls */}
      <div className="bg-white/10 backdrop-blur-md p-3 flex items-center justify-between border-b border-white/20">
        {/* Page Info */}
        <div className="flex items-center gap-4">
          <span className="text-sm">
            {loadedCount < pageCount ? (
              <span className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                Loading pages... ({loadedCount}/{pageCount})
              </span>
            ) : (
              `${pageCount} pages • Scroll to view`
            )}
          </span>
        </div>

        {/* Zoom Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={zoomOut}
            disabled={scale <= 0.5}
            className="p-2 rounded-lg hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            data-testid="zoom-out-btn"
          >
            <ZoomOut size={20} />
          </button>
          <span className="text-sm w-16 text-center">{Math.round(scale * 100)}%</span>
          <button
            onClick={zoomIn}
            disabled={scale >= 3}
            className="p-2 rounded-lg hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            data-testid="zoom-in-btn"
          >
            <ZoomIn size={20} />
          </button>
          <button
            onClick={resetZoom}
            className="p-2 rounded-lg hover:bg-white/10 transition-all"
            title="Reset zoom"
            data-testid="reset-zoom-btn"
          >
            <RotateCw size={20} />
          </button>
        </div>
      </div>

      {/* Scrollable PDF Content */}
      <div 
        ref={containerRef}
        className="flex-1 overflow-auto bg-gray-900 p-4"
      >
        <div 
          className="flex flex-col items-center gap-4"
          style={{ transform: `scale(${scale})`, transformOrigin: 'top center' }}
        >
          {loadedPages.map((pageUrl, index) => (
            <div key={index} className="relative">
              {/* Page number label */}
              <div className="absolute -top-2 left-1/2 transform -translate-x-1/2 -translate-y-full bg-white/20 px-3 py-1 rounded-t-lg text-xs text-white/70">
                Page {index + 1}
              </div>
              
              {pageUrl ? (
                <img
                  src={pageUrl}
                  alt={`Page ${index + 1}`}
                  className="max-w-full shadow-2xl rounded-lg"
                  draggable={false}
                  data-testid={`pdf-page-${index}`}
                />
              ) : (
                <div className="w-[600px] h-[800px] bg-white/5 rounded-lg flex items-center justify-center">
                  <Loader2 size={32} className="animate-spin text-blue-500" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default PDFViewer;
