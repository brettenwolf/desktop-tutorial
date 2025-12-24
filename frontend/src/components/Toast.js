import React, { useEffect } from 'react';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';

const Toast = ({ visible, message, type = 'info', onHide, duration = 4000 }) => {
  useEffect(() => {
    if (visible && duration > 0) {
      const timer = setTimeout(() => {
        onHide();
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [visible, duration, onHide]);

  if (!visible) return null;

  const icons = {
    success: <CheckCircle className="text-green-400" size={20} />,
    error: <XCircle className="text-red-400" size={20} />,
    info: <Info className="text-blue-400" size={20} />,
  };

  const bgColors = {
    success: 'bg-green-500/20 border-green-500/50',
    error: 'bg-red-500/20 border-red-500/50',
    info: 'bg-blue-500/20 border-blue-500/50',
  };

  return (
    <div className="fixed top-4 right-4 z-50 toast-enter" data-testid="toast-notification">
      <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border backdrop-blur-md shadow-lg max-w-md ${bgColors[type]}`}>
        {icons[type]}
        <span className="text-white flex-1">{message}</span>
        <button
          onClick={onHide}
          className="p-1 hover:bg-white/10 rounded transition-all flex-shrink-0"
          data-testid="toast-close-btn"
        >
          <X size={16} className="text-white/70" />
        </button>
      </div>
    </div>
  );
};

export default Toast;
