import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ZoomIn, ZoomOut, RotateCw, Loader2, Maximize2, Minimize2 } from 'lucide-react';

const PDFViewer = ({ backendUrl, onFirstPageLoaded, onScroll }) => {
  const [pageCount, setPageCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scale, setScale] = useState(1);
  const [fitMode, setFitMode] = useState('width'); // 'width', 'page', or 'custom'
  const [loadedPages, setLoadedPages] = useState([]);
  const [loadingPages, setLoadingPages] = useState(new Set());
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 3 }); // Only load visible + buffer
  const containerRef = useRef(null);
  const pageRefs = useRef([]);
  const firstPageLoadedRef = useRef(false);
  const lastScrollY = useRef(0);

  const API = `${backendUrl}/api`;
  
  // Handle scroll events for header show/hide
  const handleScroll = (e) => {
    if (onScroll) {
      const currentScrollY = e.target.scrollTop;
      const scrollDelta = currentScrollY - lastScrollY.current;
      
      // Only trigger if scrolled more than 15px (debounce small movements)
      if (Math.abs(scrollDelta) > 15) {
        const direction = scrollDelta > 0 ? 'down' : 'up';
        onScroll(direction, currentScrollY);
        lastScrollY.current = currentScrollY;
      }
    }
  };

  // Fetch page count on mount - with retry logic
  useEffect(() => {
    let retryCount = 0;
    const maxRetries = 8; // Increased retries for slower connections
    let cancelled = false;
    
    const fetchPages = async () => {
      if (cancelled) return;
      try {
        setLoading(true);
        setError(null);
        console.log(`PDFViewer: Fetching pages from ${API}/document/pages (attempt ${retryCount + 1})`);
        const response = await fetch(`${API}/document/pages`);
        console.log(`PDFViewer: Response status: ${response.status}`);
        
        if (response.ok) {
          const data = await response.json();
          console.log(`PDFViewer: Got ${data.pageCount} pages`);
          setPageCount(data.pageCount);
          // Initialize loaded pages array
          setLoadedPages(new Array(data.pageCount).fill(null));
          setLoading(false);
        } else if (response.status === 404 && retryCount < maxRetries) {
          // Document not loaded yet, retry after delay
          retryCount++;
          console.log(`PDFViewer: Document not ready, retry ${retryCount}/${maxRetries}...`);
          setTimeout(fetchPages, 1500); // Increased delay between retries
        } else {
          const errorText = await response.text().catch(() => 'Unknown error');
          console.error(`PDFViewer: Failed with status ${response.status}: ${errorText}`);
          setError(`Failed to load document (${response.status})`);
          setLoading(false);
        }
      } catch (err) {
        console.error('PDFViewer: Network error fetching pages:', err.message);
        if (retryCount < maxRetries) {
          retryCount++;
          console.log(`PDFViewer: Network error, retry ${retryCount}/${maxRetries}...`);
          setTimeout(fetchPages, 2000); // Longer delay on network errors
        } else {
          setError('Failed to load document - please check your connection');
          setLoading(false);
        }
      }
    };

    fetchPages();
    return () => { cancelled = true; };
  }, [API]);

  // Load visible pages progressively (first few pages immediately, rest on scroll)
  useEffect(() => {
    if (pageCount > 0) {
      // Prioritize first 2 pages for immediate display
      loadPage(0, true); // High priority - first page
      if (pageCount > 1) loadPage(1, true);
      
      // Load remaining visible range pages with slight delay
      const loadRemainingVisible = () => {
        for (let i = 2; i < Math.min(pageCount, visibleRange.end + 2); i++) {
          loadPage(i, false);
        }
      };
      const timer = setTimeout(loadRemainingVisible, 100);
      return () => clearTimeout(timer);
    }
  }, [pageCount]);

  // Intersection observer for lazy loading pages as user scrolls
  useEffect(() => {
    if (pageCount === 0 || !containerRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const pageIndex = parseInt(entry.target.dataset.pageIndex, 10);
            if (!isNaN(pageIndex)) {
              // Load this page and adjacent pages
              loadPage(pageIndex, false);
              if (pageIndex > 0) loadPage(pageIndex - 1, false);
              if (pageIndex < pageCount - 1) loadPage(pageIndex + 1, false);
            }
          }
        });
      },
      { root: containerRef.current, rootMargin: '200px', threshold: 0.1 }
    );

    // Observe all page placeholders
    pageRefs.current.forEach((ref) => {
      if (ref) observer.observe(ref);
    });

    return () => observer.disconnect();
  }, [pageCount, loadedPages]);

  // Load a single page with priority support
  const loadPage = useCallback(async (pageIndex, highPriority = false) => {
    if (loadingPages.has(pageIndex) || loadedPages[pageIndex]) return;

    setLoadingPages(prev => new Set([...prev, pageIndex]));

    try {
      const timestamp = Date.now();
      // Use lower quality for faster initial load, can upgrade later
      const quality = highPriority ? 85 : 80;
      const imageUrl = `${API}/document/page/${pageIndex}?scale=2.0&quality=${quality}&t=${timestamp}`;
      
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
        
        // Signal when first page is loaded
        if (pageIndex === 0 && !firstPageLoadedRef.current) {
          firstPageLoadedRef.current = true;
          if (onFirstPageLoaded) onFirstPageLoaded();
        }
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
  }, [API, loadingPages, loadedPages, onFirstPageLoaded]);

  const zoomIn = () => {
    setFitMode('custom');
    setScale(Math.min(scale + 0.25, 3));
  };

  const zoomOut = () => {
    setFitMode('custom');
    setScale(Math.max(scale - 0.25, 0.25));
  };

  const resetZoom = () => {
    setScale(1);
    setFitMode('width');
  };

  const toggleFitMode = () => {
    if (fitMode === 'width') {
      setFitMode('page');
      setScale(0.5);
    } else {
      setFitMode('width');
      setScale(1);
    }
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
      <div className="bg-white/10 backdrop-blur-md p-2 sm:p-3 flex items-center justify-between border-b border-white/20">
        {/* Page Info */}
        <div className="flex items-center gap-2 sm:gap-4">
          <span className="text-xs sm:text-sm">
            {loadedCount < pageCount ? (
              <span className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                <span className="hidden sm:inline">Loading pages...</span> ({loadedCount}/{pageCount})
              </span>
            ) : (
              <span>
                <span className="hidden sm:inline">{pageCount} pages • Scroll to view</span>
                <span className="sm:hidden">{pageCount} pg</span>
              </span>
            )}
          </span>
        </div>

        {/* Zoom Controls */}
        <div className="flex items-center gap-1 sm:gap-2">
          <button
            onClick={zoomOut}
            disabled={scale <= 0.25}
            className="p-1.5 sm:p-2 rounded-lg hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            data-testid="zoom-out-btn"
            title="Zoom out"
          >
            <ZoomOut size={18} />
          </button>
          <span className="text-xs sm:text-sm w-12 sm:w-16 text-center">{Math.round(scale * 100)}%</span>
          <button
            onClick={zoomIn}
            disabled={scale >= 3}
            className="p-1.5 sm:p-2 rounded-lg hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            data-testid="zoom-in-btn"
            title="Zoom in"
          >
            <ZoomIn size={18} />
          </button>
          <button
            onClick={toggleFitMode}
            className="p-1.5 sm:p-2 rounded-lg hover:bg-white/10 transition-all"
            title={fitMode === 'width' ? 'Fit page' : 'Fit width'}
            data-testid="fit-mode-btn"
          >
            {fitMode === 'width' ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          <button
            onClick={resetZoom}
            className="p-1.5 sm:p-2 rounded-lg hover:bg-white/10 transition-all"
            title="Reset zoom"
            data-testid="reset-zoom-btn"
          >
            <RotateCw size={18} />
          </button>
        </div>
      </div>

      {/* Scrollable PDF Content */}
      <div 
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto bg-gray-900 p-2 sm:p-4"
      >
        <div 
          className="flex flex-col items-center gap-4 mx-auto"
          style={{ 
            maxWidth: fitMode === 'width' ? '100%' : `${scale * 800}px`,
          }}
        >
          {loadedPages.map((pageUrl, index) => (
            <div 
              key={index} 
              ref={el => pageRefs.current[index] = el}
              data-page-index={index}
              className="relative w-full" 
              style={{ marginBottom: '16px' }}
            >
              {/* Page number label */}
              <div className="absolute -top-2 left-1/2 transform -translate-x-1/2 -translate-y-full bg-white/20 px-2 sm:px-3 py-0.5 sm:py-1 rounded-t-lg text-xs text-white/70 z-10">
                Page {index + 1}
              </div>
              
              {pageUrl ? (
                <img
                  src={pageUrl}
                  alt={`Page ${index + 1}`}
                  className="shadow-2xl mx-auto"
                  style={{
                    width: fitMode === 'width' ? '100%' : 'auto',
                    maxWidth: fitMode === 'width' ? '800px' : `${scale * 800}px`,
                    height: 'auto',
                    display: 'block',
                    transform: fitMode === 'custom' ? `scale(${scale})` : 'none',
                    transformOrigin: 'top center',
                  }}
                  draggable={false}
                  loading="lazy"
                  data-testid={`pdf-page-${index}`}
                />
              ) : (
                <div className="w-full max-w-[800px] bg-white/5 flex items-center justify-center mx-auto" style={{ aspectRatio: '612/792' }}>
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
