import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useFeatureFlag } from '../lib/featureFlags.js'
import { passkeyManager } from '../lib/passkey.js'
import { useWallet } from '../contexts/WalletContext.js'
import { useLocationSearch } from '../hooks/useLocationSearch.js'

export default function Help() {
  const passkeyAuthEnabled = useFeatureFlag('passkey_authentication')
  const { walletState, connectWallet } = useWallet()
  const [statusMessage, setStatusMessage] = useState<string>('')
  const [passkeyVerified, setPasskeyVerified] = useState<boolean>(false)

  const {
    location,
    searchQuery,
    setSearchQuery,
    searchLoading,
    searchError,
    searchSuggestions,
    searchSuggestLoading,
    selectSearchSuggestion,
    handleSearchKeyDown,
  } = useLocationSearch({ mapboxToken: '' })
  const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false
  const hasOfflineMatch = searchSuggestions.some(
    (s: any) => s?.properties?.offline === true,
  )

  const handlePasskeyAuth = async () => {
    try {
      setStatusMessage('Authenticating with WebAuthn Passkey...')
      const challenge = passkeyManager.generateChallenge()
      const credential = await passkeyManager.authenticatePasskey(challenge)

      if (credential) {
        const verification = await passkeyManager.verifyAssertion(credential, challenge)
        if (verification.verified) {
          setPasskeyVerified(true)
          setStatusMessage('✅ Passkey authenticated successfully! Emergency broadcast authorized.')
        } else {
          setStatusMessage(`❌ Passkey verification failed: ${verification.error}`)
        }
      }
    } catch (err: any) {
      setStatusMessage(`Passkey sign-in: ${err.message}`)
    }
  }

  return (
    <div style={{ background: '#1c2c24', color: '#ECE0CC', minHeight: '100vh', padding: '2rem' }}>
      <header style={{ marginBottom: '2rem' }}>
        <Link to="/" style={{ color: '#FF7A6B', textDecoration: 'none', fontWeight: 'bold' }}>
          ← Back to HelPhone Home
        </Link>
        <h1 style={{ fontSize: '2.5rem', marginTop: '1rem' }}>Emergency Dispatch Request</h1>
      </header>

      <div
        style={{
          background: '#234B4E',
          padding: '2rem',
          borderRadius: '1rem',
          maxWidth: '600px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        <h2>Submit Emergency Alert</h2>
        <p style={{ color: '#a2a586' }}>
          Broadcast encrypted location and incident report to nearby community responders.
        </p>

        {/* Location search — hybrid Mapbox → offline geocoder (#518). Works with
            no access token and while offline, using the bundled city dataset. */}
        <div style={{ marginBottom: '1.5rem', position: 'relative' }}>
          <label
            htmlFor="emergency-location-search"
            style={{ display: 'block', marginBottom: '0.4rem', fontWeight: 'bold' }}
          >
            Your location (city)
          </label>
          <input
            id="emergency-location-search"
            type="text"
            role="combobox"
            aria-expanded={searchSuggestions.length > 0}
            aria-controls="emergency-location-suggestions"
            aria-autocomplete="list"
            placeholder={isOffline ? 'Search offline city list…' : 'Search city…'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            style={{
              width: '100%',
              padding: '0.75rem',
              borderRadius: '0.5rem',
              border: '1px solid rgba(255,255,255,0.25)',
              background: '#1c2c24',
              color: '#ECE0CC',
            }}
          />
          {isOffline && (
            <p style={{ fontSize: '0.8rem', color: '#FF7A6B', margin: '0.3rem 0 0' }}>
              Offline — using bundled city search.
            </p>
          )}
          {hasOfflineMatch && (
            <p style={{ fontSize: '0.8rem', color: '#a2a586', margin: '0.3rem 0 0' }}>
              Matched offline from the bundled dataset.
            </p>
          )}
          {searchError && (
            <p role="alert" style={{ fontSize: '0.85rem', color: '#FF7A6B', margin: '0.3rem 0 0' }}>
              {searchError}
            </p>
          )}
          {location && (
            <p style={{ fontSize: '0.85rem', color: '#3F8487', margin: '0.3rem 0 0' }}>
              Selected location: {location[0].toFixed(4)}, {location[1].toFixed(4)}
            </p>
          )}
          {searchSuggestions.length > 0 && (
            <ul
              id="emergency-location-suggestions"
              role="listbox"
              style={{
                position: 'absolute',
                zIndex: 5,
                left: 0,
                right: 0,
                top: '100%',
                listStyle: 'none',
                margin: '0.3rem 0 0',
                padding: '0.25rem 0',
                background: '#234B4E',
                borderRadius: '0.5rem',
                border: '1px solid rgba(255,255,255,0.2)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
              }}
            >
              {searchSuggestions.map((suggestion: any, index: number) => (
                <li key={suggestion.id ?? index}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => selectSearchSuggestion(suggestion)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '0.5rem 0.75rem',
                      background: 'transparent',
                      color: '#ECE0CC',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                    }}
                  >
                    {suggestion.text}
                    <span style={{ color: '#a2a586', marginLeft: '0.5rem', fontSize: '0.8rem' }}>
                      {suggestion.place_name?.split(', ').slice(1).join(', ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {walletState.isConnected ? (
          <p style={{ color: '#7357FF' }}>Connected Wallet: {walletState.address}</p>
        ) : (
          <button
            onClick={() => connectWallet()}
            style={{
              background: '#7357FF',
              color: '#fff',
              border: 'none',
              padding: '0.75rem 1.5rem',
              borderRadius: '0.5rem',
              cursor: 'pointer',
              marginBottom: '1rem',
            }}
          >
            Connect Stellar Wallet
          </button>
        )}

        {passkeyAuthEnabled && (
          <div style={{ marginTop: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1.5rem' }}>
            <h3>Passkey Cryptographic Authorization</h3>
            <button
              onClick={handlePasskeyAuth}
              style={{
                background: '#FF7A6B',
                color: '#fff',
                border: 'none',
                padding: '0.75rem 1.5rem',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                fontWeight: 'bold',
              }}
            >
              🔑 Authenticate Passkey (P-256)
            </button>
          </div>
        )}

        {statusMessage && (
          <p style={{ marginTop: '1.5rem', padding: '1rem', background: '#1c2c24', borderRadius: '0.5rem' }}>
            {statusMessage}
          </p>
        )}
      </div>
    </div>
  )
}
