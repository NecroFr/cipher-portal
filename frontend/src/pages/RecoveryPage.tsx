import { useState, useId } from 'react'
import { useNavigate } from 'react-router-dom'
import { startRegistration } from '@simplewebauthn/browser'
import axios from 'axios'
import { saveSession } from '../utils/session'
import {
  User,
  ShieldOff,
  KeyRound,
  ChevronRight,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Fingerprint,
  RotateCcw,
  Hash,
  ArrowLeft,
  Lock,
} from 'lucide-react'

// ─── Constants ────────────────────────────────────────────────────────────────
const AUTH_URL = 'http://localhost:3001'

// ─── Types ────────────────────────────────────────────────────────────────────
interface ChallengeResponse {
  userId:    string
  positions: number[]   // word indices (1-based) to verify
}


type Phase =
  | 'input'       // user enters their ID
  | 'challenge'   // word-position inputs shown
  | 'enrolling'   // re-registering WebAuthn credential
  | 'success'     // fully recovered

// ─── Ordinal helper ───────────────────────────────────────────────────────────
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}

// ─── Step indicator ───────────────────────────────────────────────────────────
const STEPS = ['Identify', 'Verify Words', 'Re-enroll', 'Access Restored']

function StepBar({ current }: { current: 0 | 1 | 2 | 3 }) {
  return (
    <div className="flex items-center gap-0 w-full mb-2">
      {STEPS.map((label, i) => {
        const done    = i < current
        const active  = i === current
        const isLast  = i === STEPS.length - 1

        return (
          <div key={i} className="flex items-center flex-1 min-w-0">
            {/* Node */}
            <div className="flex flex-col items-center shrink-0">
              <div
                className={`w-6 h-6 rounded-full border flex items-center justify-center text-[10px] font-bold transition-all duration-300 ${
                  done
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                    : active
                    ? 'bg-teal-glow/15 border-teal-glow/60 text-teal-glow animate-pulse-glow'
                    : 'bg-white/5 border-white/10 text-white/20'
                }`}
              >
                {done ? <CheckCircle2 size={12} /> : i + 1}
              </div>
              <span
                className={`text-[9px] mt-1 font-medium tracking-wide whitespace-nowrap ${
                  done ? 'text-emerald-400/70' : active ? 'text-teal-glow/80' : 'text-white/20'
                }`}
              >
                {label}
              </span>
            </div>

            {/* Connector */}
            {!isLast && (
              <div
                className={`flex-1 h-px mx-1 mb-4 transition-all duration-500 ${
                  done ? 'bg-emerald-500/40' : 'bg-white/8'
                }`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Word position input ──────────────────────────────────────────────────────
function WordInput({
  position,
  value,
  onChange,
  error,
  inputId,
}: {
  position: number
  value:    string
  onChange: (v: string) => void
  error?:   string
  inputId:  string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={inputId}
        className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-white/40"
      >
        <Hash size={11} className="text-teal-glow/50" />
        Word at position&nbsp;
        <span className="text-teal-glow font-bold">{ordinal(position)}</span>
      </label>
      <div className="relative">
        <Lock
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20 pointer-events-none"
        />
        <input
          id={inputId}
          type="text"
          value={value}
          onChange={e => onChange(e.target.value.toLowerCase().trim())}
          placeholder={`Enter word #${position}…`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          className={`input-dark pl-9 font-mono tracking-wider ${
            error ? 'border-red-500/50 focus:border-red-400' : ''
          }`}
        />
      </div>
      {error && (
        <p className="text-xs text-red-400 flex items-center gap-1">
          <AlertTriangle size={11} />
          {error}
        </p>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function RecoveryPage() {
  const navigate  = useNavigate()
  const uid       = useId()   // stable ID prefix for labels

  // ── Phase & core state
  const [phase, setPhase]     = useState<Phase>('input')
  const [userId, setUserId]   = useState('')
  const [challenge, setChallenge] = useState<ChallengeResponse | null>(null)

  // ── Word answers keyed by position
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [fieldErrors, setFieldErrors] = useState<Record<number, string>>({})

  // ── Enroll state
  const [enrollDone, setEnrollDone]     = useState(false)
  const [enrollLoading, setEnrollLoading] = useState(false)

  // ── Generic loading / error
  const [loading, setLoading]         = useState(false)
  const [serverError, setServerError] = useState('')
  const [userIdError, setUserIdError] = useState('')


  // ── Step 1: request challenge ────────────────────────────────────────────
  async function requestChallenge(e: React.FormEvent) {
    e.preventDefault()
    if (!userId.trim()) { setUserIdError('User ID is required'); return }
    if (userId.length < 3) { setUserIdError('Must be at least 3 characters'); return }
    setUserIdError('')
    setServerError('')
    setLoading(true)

    try {
      // POST /api/recovery/challenge returns { success: true, data: { indices: number[] } }
      const res = await axios.post<{ success: boolean; data: { indices: number[] } }>(
        `${AUTH_URL}/api/recovery/challenge`,
        { userId }
      )
      const positions = res.data.data.indices
      setChallenge({ userId, positions })

      // Pre-fill empty answers
      const init: Record<number, string> = {}
      positions.forEach(p => { init[p] = '' })
      setAnswers(init)

      setPhase('challenge')
    } catch (err) {
      setServerError(
        axios.isAxiosError(err)
          ? err.response?.data?.message ?? 'Server error — is the auth backend running?'
          : 'Unexpected error. Please try again.'
      )
    } finally {
      setLoading(false)
    }
  }

  // ── Step 2: submit recovery words ────────────────────────────────────────
  async function submitWords(e: React.FormEvent) {
    e.preventDefault()
    if (!challenge) return

    // Validate — each field must be non-empty
    const fe: Record<number, string> = {}
    challenge.positions.forEach(p => {
      if (!answers[p]?.trim()) fe[p] = 'This word is required'
    })
    setFieldErrors(fe)
    if (Object.keys(fe).length) return

    setLoading(true)
    setServerError('')

    try {
      // POST /api/recovery/verify takes { userId, words: Record<number, string> }
      // Backend returns { success: true, data: { success: boolean, message: string } }
      const wordsMap: Record<number, string> = {}
      challenge.positions.forEach(p => { wordsMap[p] = answers[p] })
      const res = await axios.post<{ success: boolean; data: { success: boolean; message: string } }>(
        `${AUTH_URL}/api/recovery/verify`,
        { userId: challenge.userId, words: wordsMap }
      )

      if (res.data.data.success) {
        setPhase('enrolling')
      } else {
        setServerError('One or more recovery words did not match. Please try again.')
      }
    } catch (err) {
      setServerError(
        axios.isAxiosError(err)
          ? err.response?.data?.message ?? 'Verification failed. Please try again.'
          : 'Unexpected error.'
      )
    } finally {
      setLoading(false)
    }
  }

  // ── Step 3: re-enroll WebAuthn credential ────────────────────────────────
  async function reEnroll() {
    if (!challenge) return
    setEnrollLoading(true)
    setServerError('')

    try {
      // Re-enrollment: pass only userId + optional deviceLabel
      const optRes = await axios.post(
        `${AUTH_URL}/api/webauthn/register/options`,
        { userId: challenge.userId, deviceLabel: 'Recovered device' }
      )
      const attResp = await startRegistration({ optionsJSON: optRes.data })

      await axios.post(`${AUTH_URL}/api/webauthn/register/verify`, {
        userId: challenge.userId,
        response: attResp,
      })

      setEnrollDone(true)
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setServerError('Passkey prompt was dismissed. Please try again.')
      } else {
        setServerError(
          axios.isAxiosError(err)
            ? err.response?.data?.message ?? 'Re-enrollment failed. Is the server running?'
            : 'Unexpected error during credential enrollment.'
        )
      }
    } finally {
      setEnrollLoading(false)
    }
  }

  async function completeRecovery() {
    if (!challenge) return
    setLoading(true)
    try {
      // Recovery is complete — save a session and navigate to login
      // (user must do a fresh risk-assessed login with their new credential)
      saveSession({ userId: challenge.userId })
      setPhase('success')
    } catch (err) {
      setServerError(
        axios.isAxiosError(err)
          ? err.response?.data?.message ?? 'Could not complete recovery login.'
          : 'Unexpected error.'
      )
    } finally {
      setLoading(false)
    }
  }

  // ─── Render: success ──────────────────────────────────────────────────────
  if (phase === 'success') {
    return (
      <div className="glass-card w-full max-w-md p-10 flex flex-col items-center gap-5 animate-fade-up">
        <div className="w-16 h-16 rounded-full bg-emerald-500/15 border border-emerald-500/30
                        flex items-center justify-center animate-pulse-glow">
          <CheckCircle2 size={32} className="text-emerald-400" />
        </div>
        <div className="text-center">
          <h2 className="text-xl font-bold text-white mb-1">Account Recovered!</h2>
          <p className="text-sm text-white/40 leading-relaxed">
            Your identity has been verified and a new credential enrolled.
            You are now logged in as{' '}
            <span className="text-teal-glow">{challenge?.userId}</span>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/dashboard', { replace: true, state: { userId: challenge?.userId } })}
          className="btn-glow w-full flex items-center justify-center gap-2"
        >
          Go to Dashboard
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          onClick={() => navigate('/login')}
          className="text-xs text-white/25 hover:text-white/50 transition-colors"
        >
          Back to login
        </button>
      </div>
    )
  }

  // ─── Render: main card ────────────────────────────────────────────────────
  const stepIndex: 0 | 1 | 2 | 3 =
    phase === 'input'    ? 0 :
    phase === 'challenge' ? 1 :
    phase === 'enrolling' ? 2 : 3

  return (
    <div className="glass-card w-full max-w-md p-8 flex flex-col gap-6 animate-fade-up">

      {/* Header */}
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => navigate('/login')}
          className="mt-0.5 text-white/30 hover:text-white/70 transition-colors shrink-0"
          aria-label="Back to login"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Account Recovery</h1>
          <p className="text-xs text-white/35 mt-0.5">
            Verify your identity using your backup recovery words
          </p>
        </div>
        <div className="ml-auto shrink-0 w-9 h-9 rounded-full bg-amber-500/10 border border-amber-500/25
                        flex items-center justify-center">
          <ShieldOff size={16} className="text-amber-400" />
        </div>
      </div>

      {/* Step bar */}
      <StepBar current={stepIndex} />

      {/* ══ PHASE 1: Enter user ID ══════════════════════════════════════════ */}
      {phase === 'input' && (
        <form onSubmit={requestChallenge} noValidate className="flex flex-col gap-5">
          <div className="flex flex-col gap-2 p-3.5 rounded-xl bg-white/3 border border-white/6">
            <p className="text-xs text-white/50 leading-relaxed">
              Enter the <strong className="text-white/80">User ID</strong> (email or username) of
              the account you'd like to recover. We'll challenge you with random positions from
              your 15 backup recovery words.
            </p>
          </div>

          {/* User ID field */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`${uid}-userid`}
              className="text-xs font-semibold uppercase tracking-widest text-white/40 flex items-center gap-1.5"
            >
              <User size={12} className="text-teal-glow/50" />
              User ID / Email
            </label>
            <div className="relative">
              <User
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20 pointer-events-none"
              />
              <input
                id={`${uid}-userid`}
                type="text"
                value={userId}
                onChange={e => setUserId(e.target.value)}
                placeholder="e.g. alice@example.com"
                autoComplete="username"
                className={`input-dark pl-9 ${userIdError ? 'border-red-500/50' : ''}`}
              />
            </div>
            {userIdError && (
              <p className="text-xs text-red-400 flex items-center gap-1">
                <AlertTriangle size={11} />{userIdError}
              </p>
            )}
          </div>

          {serverError && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300/90 leading-relaxed">{serverError}</p>
            </div>
          )}

          <button
            id="btn-request-challenge"
            type="submit"
            disabled={loading}
            className={`btn-glow w-full flex items-center justify-center gap-2 ${loading ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            {loading
              ? <Loader2 size={16} className="animate-spin" />
              : <KeyRound size={16} />}
            {loading ? 'Requesting challenge…' : 'Request Recovery Options'}
          </button>

          <p className="text-center text-xs text-white/25">
            Remembered your credentials?{' '}
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="text-teal-glow hover:underline underline-offset-2"
            >
              Back to Login
            </button>
          </p>
        </form>
      )}

      {/* ══ PHASE 2: Enter recovery words ══════════════════════════════════ */}
      {phase === 'challenge' && challenge && (
        <form onSubmit={submitWords} noValidate className="flex flex-col gap-5">

          {/* Challenge explanation banner */}
          <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-teal-glow/5 border border-teal-glow/15">
            <KeyRound size={14} className="text-teal-glow shrink-0 mt-0.5" />
            <p className="text-xs text-white/55 leading-relaxed">
              Please enter the backup words at{' '}
              {challenge.positions.map((p, idx) => (
                <span key={p}>
                  {idx > 0 && idx < challenge.positions.length - 1 && ', '}
                  {idx > 0 && idx === challenge.positions.length - 1 && ' and '}
                  <strong className="text-teal-glow">position #{p}</strong>
                </span>
              ))}{' '}
              from your original 15-word backup list.
            </p>
          </div>

          {/* Word input fields */}
          <div className="flex flex-col gap-4">
            {challenge.positions.map((pos) => (
              <WordInput
                key={pos}
                position={pos}
                value={answers[pos] ?? ''}
                onChange={v => {
                  setAnswers(prev => ({ ...prev, [pos]: v }))
                  setFieldErrors(prev => {
                    const next = { ...prev }
                    delete next[pos]
                    return next
                  })
                }}
                error={fieldErrors[pos]}
                inputId={`${uid}-word-${pos}`}
              />
            ))}
          </div>

          {serverError && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300/90 leading-relaxed">{serverError}</p>
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setPhase('input'); setServerError('') }}
              className="btn-ghost !px-3 flex items-center gap-1.5"
            >
              <RotateCcw size={14} />
              Start Over
            </button>
            <button
              id="btn-submit-words"
              type="submit"
              disabled={loading}
              className={`btn-glow flex-1 flex items-center justify-center gap-2 ${
                loading ? 'opacity-60 cursor-not-allowed' : ''
              }`}
            >
              {loading
                ? <Loader2 size={16} className="animate-spin" />
                : <ChevronRight size={16} />}
              {loading ? 'Verifying…' : 'Submit Backup Words'}
            </button>
          </div>
        </form>
      )}

      {/* ══ PHASE 3: Re-enroll WebAuthn credential ══════════════════════════ */}
      {phase === 'enrolling' && (
        <div className="flex flex-col gap-5">

          {/* Success tick */}
          <div className="flex items-center gap-3 p-3.5 rounded-xl bg-emerald-500/8 border border-emerald-500/20">
            <CheckCircle2 size={18} className="text-emerald-400 shrink-0" />
            <p className="text-xs text-emerald-300/90 leading-relaxed">
              Recovery words verified!{' '}
              <strong>Re-enroll your biometric credential</strong> to secure your account.
            </p>
          </div>

          {/* Explanation */}
          <div className="flex flex-col gap-2 p-3.5 rounded-xl bg-white/3 border border-white/6">
            <p className="text-xs text-white/50 leading-relaxed">
              Your old passkey has been invalidated for security. Register a new one now —
              you'll use it for all future logins.
            </p>
          </div>

          {/* Enroll button */}
          <button
            id="btn-re-enroll"
            type="button"
            onClick={reEnroll}
            disabled={enrollLoading || enrollDone}
            className={`w-full flex items-center justify-center gap-2 transition-all duration-200 ${
              enrollDone
                ? 'btn-ghost !border-emerald-500/40 !text-emerald-400 cursor-default'
                : 'btn-ghost'
            } ${enrollLoading ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            {enrollLoading
              ? <Loader2 size={16} className="animate-spin" />
              : enrollDone
              ? <CheckCircle2 size={16} />
              : <Fingerprint size={16} />}
            {enrollLoading
              ? 'Waiting for authenticator…'
              : enrollDone
              ? 'New Passkey Enrolled ✓'
              : 'Enroll New Passkey / Biometrics'}
          </button>

          {serverError && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300/90 leading-relaxed">{serverError}</p>
            </div>
          )}

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-white/6" />
            <span className="text-xs text-white/20">then</span>
            <div className="flex-1 h-px bg-white/6" />
          </div>

          {/* Complete recovery */}
          <button
            id="btn-complete-recovery"
            type="button"
            disabled={!enrollDone || loading}
            onClick={completeRecovery}
            className={`btn-glow w-full flex items-center justify-center gap-2 ${
              !enrollDone || loading ? 'opacity-40 cursor-not-allowed' : ''
            }`}
          >
            {loading
              ? <Loader2 size={16} className="animate-spin" />
              : <ChevronRight size={16} />}
            {loading ? 'Finalising…' : 'Complete Account Recovery'}
          </button>

          <p className="text-xs text-white/20 text-center leading-relaxed">
            You can skip re-enrollment but will need to use recovery words on every login
            until a new passkey is registered.
          </p>
          {!enrollDone && (
            <button
              type="button"
              disabled={loading}
              onClick={completeRecovery}
              className="text-xs text-white/25 hover:text-white/50 transition-colors mx-auto"
            >
              Skip for now →
            </button>
          )}
        </div>
      )}
    </div>
  )
}
