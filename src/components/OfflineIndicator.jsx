import { useEffect, useState } from 'react';
import { swChannel, subscribeToServiceWorkerMessages } from '../lib/swChannel';

export default function OfflineIndicator() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [lastSyncAt, setLastSyncAt] = useState(null);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Issue #516: surface multi-tab synchronisation activity while offline —
    // a request state change saved in another tab propagates to this one.
    const handleMessage = (message) => {
      if (
        message?.type === 'CONTRACT_EVENT' ||
        message?.type === 'CRDT_SYNC' ||
        message?.type === 'STATE_SYNC'
      ) {
        setLastSyncAt(message.timestamp || Date.now());
      }
    };
    const unsubChannel = swChannel.subscribe(handleMessage);
    const unsubSw = subscribeToServiceWorkerMessages(handleMessage);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      unsubChannel();
      unsubSw();
    };
  }, []);

  if (isOnline) return null;

  const syncedRecently =
    lastSyncAt != null && Date.now() - lastSyncAt < 60_000;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        background: '#FF7A6B',
        color: '#fff',
        padding: '12px 16px',
        textAlign: 'center',
        fontSize: '13.5px',
        fontWeight: '500',
        zIndex: 9999,
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      }}
      role="alert"
      aria-live="polite"
    >
      ⚠️ You are offline. Some features may not be available. Cached data will be
      used where possible.
      {syncedRecently && (
        <span style={{ opacity: 0.85, marginLeft: 8 }}>
          Multi-tab sync active — updates received just now.
        </span>
      )}
    </div>
  );
}