'use client';

import { Share2 } from 'lucide-react';

export function ShareButton() {
  const handleShare = () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url);
    alert('Dashboard URL copied to clipboard!');
  };

  return (
    <button
      onClick={handleShare}
      className="btn-cannon flex items-center gap-2 text-sm"
    >
      <Share2 className="w-4 h-4" />
      Share
    </button>
  );
}
