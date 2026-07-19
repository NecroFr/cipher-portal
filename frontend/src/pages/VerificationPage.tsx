import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import axios from 'axios'
import { io, Socket } from 'socket.io-client'
import { saveSession } from '../utils/session'
import {
  QrCode,
  Bell,
  ShieldAlert,
  Shield,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Wifi,
  WifiOff,
  ChevronRight,
  ArrowLeft,
} from 'lucide-react'

// ─── Constants ────────────────────────────────────────────────────────────────
const TRUSTED_DEVICE_URL = 'http://localhost:3002'
const POLL_INTERVAL_MS   = 3000

const WORD_POOL = [
  'tiger', 'ocean', 'mountain', 'breeze', 'fire',
  'lantern', 'cipher', 'echo', 'nebula', 'storm',
  'prism', 'falcon', 'delta', 'anchor', 'nova',
  'quartz', 'ember', 'zenith', 'tundra', 'vortex',
]

type Tab    = 'qr' | 'notification'
type Phase  = 'idle' | 'pending' | 'success' | 'error'

interface LocationState {
  userId:    string
  safeScore: number
  flow:      'moderate' | 'low'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pickFive(pool: string[]): string[] {
  const shuffled = [...pool].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, 5)
}

// ─── Tab button ───────────────────────────────────────────────────────────────
function TabBtn({
  active, disabled, icon, label, sublabel, onClick,
}: {
  active:    boolean
  disabled?: boolean
  icon:      React.ReactNode
  label:     string
  sublabel:  string
  onClick:   () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl border text-center transition-all duration-200 ${
        active
          ? 'bg-teal-glow/10 border-teal-glow/45'
          : disabled
          ? 'bg-black/10 border-white/5 opacity-35 cursor-not-allowed'
          : 'bg-black/20 border-white/8 hover:border-white/20'
      }`}
    >
      <span className={active ? 'text-teal-glow' : disabled ? 'text-white/20' : 'text-white/40'}>
        {icon}
      </span>
      <span className={`text-xs font-semibold ${active ? 'text-white/90' : 'text-white/50'}`}>
        {label}
      </span>
      <span className="text-[10px] text-white/25 leading-tight">{sublabel}</span>
    </button>
  )
}

// ─── Word pill ────────────────────────────────────────────────────────────────
function WordPill({ index, word, isHighlighted }: { index: number; word: string; isHighlighted?: boolean }) {
  return (
    <div className={`flex items-center gap-2 glass-card !rounded-lg p-2.5 transition-all duration-300 ${isHighlighted ? 'border-teal-glow shadow-sm bg-teal-glow/10' : ''}`}>
      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${isHighlighted ? 'bg-teal-glow text-black' : 'bg-teal-glow/10 border border-teal-glow/25 text-teal-glow'}`}>
        {index}
      </span>
      <span className={`text-sm font-medium tracking-wide ${isHighlighted ? 'text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]' : 'text-white/85'}`}>{word}</span>
    </div>
  )
}

// ─── Connection indicator ─────────────────────────────────────────────────────
function ConnIndicator({ connected }: { connected: boolean | null }) {
  if (connected === null) return null
  return (
    <div className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest ${
      connected ? 'text-emerald-400' : 'text-amber-400'
    }`}>
      {connected
        ? <><Wifi size={10} /> Socket.IO live</>
        : <><WifiOff size={10} /> Polling mode</>}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function VerificationPage() {
  const navigate  = useNavigate()
  const { state } = useLocation() as { state: LocationState | null }

  // Guard: redirect if no session state
  useEffect(() => {
    if (!state?.userId) navigate('/login', { replace: true })
  }, [state, navigate])

  const isModerate = state?.flow === 'moderate'
  const userId     = state?.userId ?? ''
  const safeScore  = state?.safeScore ?? 0

  // ── Tab & phase
  const [tab,   setTab]   = useState<Tab>(isModerate ? 'qr' : 'notification')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')

  // ── QR state
  const [sessionId,     setSessionId]     = useState(() => crypto.randomUUID())
  const [qrDataUrl,     setQrDataUrl]     = useState<string | null>(null)  // FIX 1: real QR image
  const [qrRefreshing,  setQrRefreshing]  = useState(false)

  // ── Notification state
  const [words,   setWords]   = useState<string[]>(() => pickFive(WORD_POOL))
  const [answerIndices, setAnswerIndices] = useState<number[]>([])
  const [wsConn,  setWsConn]  = useState<boolean | null>(null)

  // Cleanup refs
  const socketRef  = useRef<Socket | null>(null)   // FIX 2: Socket.IO ref
  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      socketRef.current?.disconnect()
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  // ── Reset when tab changes ────────────────────────────────────────────────
  useEffect(() => {
    setPhase('idle')
    setError('')
    setQrDataUrl(null)
    socketRef.current?.disconnect()
    socketRef.current = null
    if (pollRef.current) clearInterval(pollRef.current)
  }, [tab])

  // ─── Success handler (shared) ─────────────────────────────────────────────
  // IMPORTANT: must call /api/login/record-success so the pending LoginEvent
  // (created during assess-risk) is marked successful=true.
  // Without this, every verification-flow login accumulates as a failed attempt
  // in the DB, degrading the safe score and locking users into more restrictive
  // login flows over time.
  async function handleSuccess() {
    if (!mountedRef.current) return
    setPhase('success')

    // Mark the login as successful in backend-auth so safe-score history is accurate
    try {
      await axios.post('http://localhost:3001/api/login/record-success', { userId })
    } catch {
      // Non-fatal — proceed to dashboard even if this call fails
    }

    saveSession({ userId, safeScore, flow: state?.flow ?? 'moderate' })
    setTimeout(() => {
      if (mountedRef.current)
        navigate('/dashboard', { replace: true, state: { userId, safeScore, flow: state?.flow } })
    }, 1800)
  }

  // ─── QR: refresh session ──────────────────────────────────────────────────
  async function refreshQR() {
    setQrRefreshing(true)
    await new Promise(r => setTimeout(r, 400))
    setSessionId(crypto.randomUUID())
    setQrDataUrl(null)
    setPhase('idle')
    setError('')
    setQrRefreshing(false)
  }

  // ─── QR: start polling for approval ──────────────────────────────────────
  const pollQRStatus = useCallback((sid: string) => {
    if (pollRef.current) clearInterval(pollRef.current)
    const intervalId = setInterval(async () => {
      try {
        const res = await axios.get(`${TRUSTED_DEVICE_URL}/api/qr/status`, {
          params: { session: sid },
        })
        // FIX 3: backend returns uppercase 'APPROVED'
        if (res.data?.status === 'APPROVED' && mountedRef.current) {
          clearInterval(intervalId)
          pollRef.current = null
          handleSuccess()
        }
      } catch (_e) {
        /* swallow poll errors silently */
      }
    }, POLL_INTERVAL_MS)
    pollRef.current = intervalId
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── QR: start flow ──────────────────────────────────────────────────────
  // FIX 1: reads dataUrl from backend response and displays a real QR image
  async function startQRFlow() {
    setPhase('pending')
    setError('')
    setQrDataUrl(null)
    try {
      const res = await axios.post(`${TRUSTED_DEVICE_URL}/api/verification/initiate`, {
        sessionId,
        userId,
        verificationType: 'qr',
      })
      // The backend returns a real QR PNG as a base64 data URL
      if (res.data?.dataUrl) {
        setQrDataUrl(res.data.dataUrl)
      }
      pollQRStatus(sessionId)
    } catch (_e) {
      setPhase('error')
      setError('Could not reach the trusted-device service. Is it running on port 3002?')
    }
  }

  // ─── Notification: connect via Socket.IO ─────────────────────────────────
  // FIX 2: use socket.io-client instead of raw WebSocket
  function connectSocketIO(sid: string) {
    // Disconnect any existing socket
    socketRef.current?.disconnect()

    const socket = io(TRUSTED_DEVICE_URL, {
      transports: ['websocket', 'polling'],
    })
    socketRef.current = socket

    socket.on('connect', () => {
      if (!mountedRef.current) return
      setWsConn(true)
      // Join the session room so we receive verification events
      socket.emit('join_session', { sessionId: sid, userId })
    })

    socket.on('connect_error', () => {
      if (!mountedRef.current) return
      setWsConn(false)
      // Graceful fallback to HTTP polling
      startPolling(sid)
    })

    // Server emits 'verification_approved' when trusted device approves
    socket.on('verification_approved', () => {
      handleSuccess()
    })

    // Server emits 'verification_rejected' when trusted device denies
    socket.on('verification_rejected', () => {
      if (!mountedRef.current) return
      setPhase('error')
      setError('Verification was rejected by the trusted device.')
    })

    // Server emits 'verification_expired' on timeout
    socket.on('verification_expired', () => {
      if (!mountedRef.current) return
      setPhase('error')
      setError('Verification session expired. Please try again.')
    })
  }

  // ─── Notification: HTTP polling fallback ──────────────────────────────────
  function startPolling(sid: string) {
    if (pollRef.current) clearInterval(pollRef.current)
    const intervalId = setInterval(async () => {
      try {
        const res = await axios.get(`${TRUSTED_DEVICE_URL}/api/session/status`, {
          params: { session: sid },
        })
        if (!mountedRef.current) return
        
        if (res.data?.status === 'APPROVED') {
          clearInterval(intervalId)
          pollRef.current = null
          handleSuccess()
        } else if (res.data?.status === 'REJECTED') {
          clearInterval(intervalId)
          pollRef.current = null
          setPhase('error')
          setError('Verification was rejected by the trusted device.')
        } else if (res.data?.status === 'EXPIRED' || res.data?.status === 'EXPIRED_OR_NOT_FOUND') {
          clearInterval(intervalId)
          pollRef.current = null
          setPhase('error')
          setError('Verification session expired. Please try again.')
        }
      } catch (_e) { /* swallow */ }
    }, POLL_INTERVAL_MS)
    pollRef.current = intervalId
  }

  // ─── Notification: send challenge ─────────────────────────────────────────
  async function sendNotification() {
    setPhase('pending')
    setError('')
    setWsConn(null)
    try {
      const res = await axios.post(`${TRUSTED_DEVICE_URL}/api/verification/initiate`, {
        sessionId,
        userId,
        verificationType: 'word_game',
      })
      // Update the displayed words from the server response
      if (res.data?.words && Array.isArray(res.data.words)) {
        setWords(res.data.words)
      }
      if (res.data?.answerIndices && Array.isArray(res.data.answerIndices)) {
        setAnswerIndices(res.data.answerIndices)
      }
      // FIX 2: connect with proper Socket.IO client
      connectSocketIO(sessionId)
      // ALWAYS start polling as a fallback in case websocket events are dropped
      startPolling(sessionId)
    } catch (_e) {
      setPhase('error')
      setError('Could not reach the trusted-device service. Is it running on port 3002?')
    }
  }

  // ─── Re-roll words ────────────────────────────────────────────────────────
  function rerollWords() {
    setWords(pickFive(WORD_POOL))
    setAnswerIndices([])
    setPhase('idle')
    setError('')
    socketRef.current?.disconnect()
    socketRef.current = null
    if (pollRef.current) clearInterval(pollRef.current)
    setWsConn(null)
  }

  // ─── Render: success overlay ──────────────────────────────────────────────
  if (phase === 'success') {
    return (
      <div className="glass-card w-full max-w-md p-10 flex flex-col items-center gap-4 animate-fade-up">
        <div className="w-16 h-16 rounded-full bg-emerald-500/15 border border-emerald-500/30
                        flex items-center justify-center animate-pulse-glow">
          <CheckCircle2 size={32} className="text-emerald-400" />
        </div>
        <h2 className="text-xl font-bold text-white">Verified!</h2>
        <p className="text-sm text-white/40">Redirecting to your dashboard…</p>
        <Loader2 size={20} className="animate-spin text-teal-glow mt-2" />
      </div>
    )
  }

  // ─── Render: main ─────────────────────────────────────────────────────────
  return (
    <div className="glass-card w-full max-w-md p-8 flex flex-col gap-6 animate-fade-up">

      {/* Header */}
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => navigate('/login')}
          className="mt-0.5 text-white/30 hover:text-white/70 transition-colors"
          aria-label="Back to login"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">
            Verification Required
          </h1>
          <p className="text-xs text-white/35 mt-0.5">
            {isModerate
              ? 'Choose a verification method to continue'
              : 'An extra identity check is needed for your security'}
          </p>
        </div>
        <div className={`ml-auto shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-semibold uppercase tracking-widest ${
          isModerate
            ? 'bg-amber-500/10 border-amber-500/25 text-amber-400'
            : 'bg-red-500/10   border-red-500/25   text-red-400'
        }`}>
          {isModerate ? <Shield size={10} /> : <ShieldAlert size={10} />}
          {safeScore}/100
        </div>
      </div>

      {/* Tab selector */}
      <div className="flex gap-2">
        <TabBtn
          active={tab === 'qr'}
          disabled={!isModerate}
          icon={<QrCode size={20} />}
          label="Scan QR Code"
          sublabel="Use your trusted device camera"
          onClick={() => setTab('qr')}
        />
        <TabBtn
          active={tab === 'notification'}
          icon={<Bell size={20} />}
          label="Trusted Device"
          sublabel="2-of-5 word challenge"
          onClick={() => setTab('notification')}
        />
      </div>

      {/* ── QR Code panel ── */}
      {tab === 'qr' && (
        <div className="flex flex-col items-center gap-5">

          {/* QR image — real PNG from backend, or placeholder before activation */}
          <div className="relative">
            <div className={`transition-opacity duration-300 ${qrRefreshing ? 'opacity-20' : 'opacity-100'}`}>
              {qrDataUrl ? (
                /* FIX 1: show real QR image returned by the backend */
                <img
                  src={qrDataUrl}
                  alt="QR Code — scan with your trusted device"
                  width={200}
                  height={200}
                  style={{
                    borderRadius: '8px',
                    boxShadow: '0 0 40px -8px rgba(0,212,255,0.4)',
                    imageRendering: 'pixelated',
                  }}
                />
              ) : (
                /* Placeholder before activation */
                <div
                  style={{
                    width: 200,
                    height: 200,
                    borderRadius: '8px',
                    background: 'rgba(0,212,255,0.04)',
                    border: '1px dashed rgba(0,212,255,0.2)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                  }}
                >
                  <QrCode size={40} className="text-teal-glow/20" />
                  <span className="text-xs text-white/20 text-center px-4 leading-relaxed">
                    Click "Activate QR Session" to generate
                  </span>
                </div>
              )}
            </div>
            {qrRefreshing && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 size={28} className="animate-spin text-teal-glow" />
              </div>
            )}

            {/* Corner accents */}
            {(['tl','tr','bl','br'] as const).map(pos => (
              <div
                key={pos}
                className={`absolute w-5 h-5 border-teal-glow/60 ${
                  pos === 'tl' ? 'top-0 left-0 border-t-2 border-l-2 rounded-tl' :
                  pos === 'tr' ? 'top-0 right-0 border-t-2 border-r-2 rounded-tr' :
                  pos === 'bl' ? 'bottom-0 left-0 border-b-2 border-l-2 rounded-bl' :
                                 'bottom-0 right-0 border-b-2 border-r-2 rounded-br'
                }`}
                style={{ margin: '-4px' }}
              />
            ))}
          </div>

          {/* Session ID */}
          <code className="text-[10px] text-white/20 font-mono tracking-widest">
            Session: {sessionId.slice(0, 16)}…
          </code>

          {/* Status message */}
          {phase === 'pending' && (
            <div className="flex items-center gap-2 text-sm text-teal-glow/80">
              <Loader2 size={15} className="animate-spin" />
              Waiting for QR scan confirmation…
            </div>
          )}
          {phase === 'error' && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 w-full">
              <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300/90">{error}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 w-full">
            <button
              type="button"
              onClick={refreshQR}
              disabled={qrRefreshing || phase === 'pending'}
              className="btn-ghost flex items-center gap-1.5 !px-3"
              aria-label="Refresh QR code"
            >
              <RefreshCw size={14} className={qrRefreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
            <button
              type="button"
              id="btn-start-qr"
              onClick={startQRFlow}
              disabled={phase === 'pending' || qrRefreshing}
              className={`btn-glow flex-1 flex items-center justify-center gap-2 ${
                phase === 'pending' ? 'opacity-60 cursor-not-allowed' : ''
              }`}
            >
              {phase === 'pending'
                ? <Loader2 size={15} className="animate-spin" />
                : <QrCode size={15} />}
              {phase === 'pending' ? 'Waiting…' : 'Activate QR Session'}
            </button>
          </div>

          <p className="text-xs text-white/25 text-center leading-relaxed">
            Open the simulator at{' '}
            <a
              href="http://localhost:3002/simulator.html"
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal-glow/50 hover:text-teal-glow underline underline-offset-2"
            >
              localhost:3002/simulator.html
            </a>{' '}
            and click "Scan QR" to approve.
          </p>
        </div>
      )}

      {/* ── Trusted Device notification panel ── */}
      {tab === 'notification' && (
        <div className="flex flex-col gap-5">

          {/* Explanation */}
          <div className="flex items-start gap-2.5 p-3 rounded-lg bg-teal-glow/5 border border-teal-glow/15">
            <Bell size={14} className="text-teal-glow shrink-0 mt-0.5" />
            <p className="text-xs text-white/50 leading-relaxed">
              A notification will be sent to your trusted device showing these 5 words.
              Select the <strong className="text-white/80">2 highlighted words in order</strong> to verify.
            </p>
          </div>

          {/* 5-word grid */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold uppercase tracking-widest text-white/35">
                Challenge Words
              </span>
              <button
                type="button"
                onClick={rerollWords}
                disabled={phase === 'pending'}
                className="text-[10px] text-white/25 hover:text-teal-glow/70 flex items-center gap-1 transition-colors disabled:opacity-30"
              >
                <RefreshCw size={10} />
                Re-roll
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {words.map((w, i) => <WordPill key={i} index={i + 1} word={w} isHighlighted={answerIndices.includes(i)} />)}
            </div>
          </div>

          {/* Connection indicator */}
          <ConnIndicator connected={wsConn} />

          {/* Status */}
          {phase === 'pending' && (
            <div className="flex flex-col gap-2 items-center py-2">
              <div className="flex items-center gap-2 text-sm text-teal-glow/80">
                <Loader2 size={15} className="animate-spin" />
                Waiting for device confirmation…
              </div>
              <p className="text-xs text-white/25">
                Select the correct words on your trusted device
              </p>
            </div>
          )}
          {phase === 'error' && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300/90">{error}</p>
            </div>
          )}

          {/* Send button */}
          <button
            id="btn-send-notification"
            type="button"
            onClick={sendNotification}
            disabled={phase === 'pending'}
            className={`btn-glow w-full flex items-center justify-center gap-2 ${
              phase === 'pending' ? 'opacity-60 cursor-not-allowed' : ''
            }`}
          >
            {phase === 'pending'
              ? <Loader2 size={16} className="animate-spin" />
              : <Bell size={16} />}
            {phase === 'pending' ? 'Notification Sent…' : 'Send Verification Notification'}
          </button>

          {!isModerate && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-500/8 border border-red-500/15">
              <ShieldAlert size={13} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-[11px] text-red-300/70 leading-relaxed">
                QR login is disabled for your risk level. Only trusted-device challenge is available.
              </p>
            </div>
          )}

          {/* Continue to next step hint */}
          <div className="flex items-center gap-2 justify-center mt-1">
            <div className="flex-1 h-px bg-white/5" />
            <ChevronRight size={12} className="text-white/15" />
            <div className="flex-1 h-px bg-white/5" />
          </div>
          <p className="text-xs text-white/20 text-center">
            Verified sessions auto-redirect to your dashboard
          </p>
        </div>
      )}
    </div>
  )
}
