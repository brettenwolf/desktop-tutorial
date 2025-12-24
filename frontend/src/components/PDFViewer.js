import React, { useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCw } from 'lucide-react';

const PDFViewer = ({ backendUrl }) => {
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scale, setScale] = useState(1);
  const [imageUrl, setImageUrl] = useState(null);
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
          setCurrentPage(0);
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

  // Fetch current page image
  useEffect(() => {
    if (pageCount > 0) {
      const timestamp = Date.now();
      setImageUrl(`${API}/document/page/${currentPage}?scale=2.0&quality=90&t=${timestamp}`);
    }
  }, [currentPage, pageCount, API]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowLeft') {
        goToPrevPage();
      } else if (e.key === 'ArrowRight') {
        goToNextPage();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPage, pageCount]);

  const goToPrevPage = () => {
    if (currentPage > 0) {
      setCurrentPage(currentPage - 1);
    }
  };

  const goToNextPage = () => {
    if (currentPage < pageCount - 1) {
      setCurrentPage(currentPage + 1);
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
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
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

  return (
    <div className="flex flex-col h-full">
      {/* Controls */}
      <div className="bg-white/10 backdrop-blur-md p-3 flex items-center justify-between border-b border-white/20">
        {/* Page Navigation */}
        <div className="flex items-center gap-2">
          <button
            onClick={goToPrevPage}
            disabled={currentPage === 0}
            className="p-2 rounded-lg hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            data-testid="prev-page-btn"
          >
            <ChevronLeft size={20} />
          </button>
          <span className="text-sm">
            Page {currentPage + 1} of {pageCount}
          </span>
          <button
            onClick={goToNextPage}
            disabled={currentPage === pageCount - 1}
            className="p-2 rounded-lg hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            data-testid="next-page-btn"
          >
            <ChevronRight size={20} />
          </button>
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

      {/* PDF Content */}
      <div 
        ref={containerRef}
        className="flex-1 overflow-auto bg-gray-900 p-4"
      >
        <div 
          className="flex justify-center items-start min-h-full"
          style={{ transform: `scale(${scale})`, transformOrigin: 'top center' }}
        >
          {imageUrl && (
            <img
              src={imageUrl}
              alt={`Page ${currentPage + 1}`}
              className="max-w-full shadow-2xl rounded-lg"
              onLoad={() => setLoading(false)}
              onError={() => setError('Failed to load page')}
              draggable={false}
              data-testid="pdf-page-image"
            />
          )}
        </div>
      </div>

      {/* Page Thumbnails / Quick Nav */}
      <div className="bg-white/10 backdrop-blur-md p-2 border-t border-white/20">
        <div className="flex gap-2 overflow-x-auto pb-2">
          {Array.from({ length: pageCount }, (_, i) => (
            <button
              key={i}
              onClick={() => setCurrentPage(i)}
              className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-sm font-medium transition-all ${
                i === currentPage
                  ? 'bg-blue-500 text-white'
                  : 'bg-white/10 hover:bg-white/20 text-white/70'
              }`}
              data-testid={`page-thumb-${i}`}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default PDFViewer;
