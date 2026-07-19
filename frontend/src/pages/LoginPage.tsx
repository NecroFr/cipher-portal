import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { startAuthentication } from '@simplewebauthn/browser'
import axios from 'axios'
import { saveSession } from '../utils/session'
import {
  Mail, LogIn, Loader2, Fingerprint,
  AlertTriangle, ShieldCheck, Shield, ShieldAlert,
  Globe, Cpu,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type RiskFlow = 'HIGH' | 'MODERATE' | 'LOW'

interface AssessRiskResponse {
  success: boolean
  data: {
    userId: string
    safeScore: number
    flow: RiskFlow
    message: string
  }
}

interface GeoContext {
  ip: string
  lat: number
  lon: number
  country: string
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreBadge({ score, flow }: { score: number; flow: RiskFlow }) {
  const cfg = {
    HIGH:     { label: 'Trusted',   color: 'text-emerald-400', bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.22)', Icon: ShieldCheck },
    MODERATE: { label: 'Verify',    color: 'text-amber-400',   bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.22)', Icon: Shield },
    LOW:      { label: 'High Risk', color: 'text-red-400',     bg: 'rgba(239,68,68,0.08)',  border: 'rgba(239,68,68,0.22)',  Icon: ShieldAlert },
  }[flow]
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold"
      style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}>
      <cfg.Icon size={16} className={cfg.color} />
      <span className={cfg.color}>Safe Score <strong>{score}</strong>/100 — {cfg.label}</span>
    </div>
  )
}

function ContextPill({ ready }: { ready: boolean }) {
  return (
    <div className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-widest transition-colors ${
      ready ? 'text-white/50' : 'text-slate-700'
    }`}>
      <Globe size={12} />
      <span>{ready ? 'Context collected' : 'Collecting context…'}</span>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const navigate = useNavigate()
  const [userId, setUserId]   = useState('')
  const [loading, setLoading] = useState(false)
  const [errors, setErrors]   = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState('')
  const [riskData, setRiskData]       = useState<AssessRiskResponse['data'] | null>(null)
  const [phase, setPhase] = useState<'idle' | 'assessing' | 'passkey' | 'done'>('idle')
  const [geoCtx, setGeoCtx] = useState<GeoContext | null>(null)

  // ── Collect geo/IP context silently on mount ──────────────────────────────
  const geoFetched = useRef(false)
  useEffect(() => {
    if (geoFetched.current) return
    geoFetched.current = true
    ;(async () => {
      try {
        const res = await axios.get<{
          ip: string; loc: string; country: string
        }>('https://ipinfo.io/json', { timeout: 4000 })
        const [latStr, lonStr] = (res.data.loc || '0,0').split(',')
        setGeoCtx({
          ip: res.data.ip,
          lat: parseFloat(latStr) || 0,
          lon: parseFloat(lonStr) || 0,
          country: res.data.country,
        })
      } catch {
        // Fallback — backend will still score but without geo signals
        setGeoCtx({ ip: '0.0.0.0', lat: 0, lon: 0, country: 'XX' })
      }
    })()
  }, [])

  // ── Collect detected browser extensions (best-effort) ────────────────────
  function detectExtensions(): string[] {
    const ua = navigator.userAgent.toLowerCase()
    const found: string[] = []
    if (ua.includes('chrome') && !ua.includes('edge') && !ua.includes('opr')) {
      // Heuristic: attempt to detect common extension fingerprints
      try {
        if ((window as unknown as Record<string, unknown>)['__REACT_DEVTOOLS_GLOBAL_HOOK__']) found.push('react devtools')
        if ((window as unknown as Record<string, unknown>)['ethereum']) found.push('metamask')
        if (document.querySelector('#grammarly-cloud-modal-host')) found.push('grammarly')
      } catch { /* ignore */ }
    }
    return found
  }

  // ── Validation ───────────────────────────────────────────────────────────
  function validate() {
    const e: Record<string, string> = {}
    if (!userId.trim()) e.userId = 'User ID is required'
    else if (userId.length < 3) e.userId = 'Minimum 3 characters'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  // ── Main login handler ────────────────────────────────────────────────────
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    if (!validate()) return
    setLoading(true)
    setServerError('')
    setRiskData(null)
    setPhase('assessing')

    const geo = geoCtx ?? { ip: '0.0.0.0', lat: 0, lon: 0, country: 'XX' }
    const extensions = detectExtensions()

    try {
      // ── Step 1: Risk assessment (no password) ──────────────────────────────
      const riskRes = await axios.post<AssessRiskResponse>(
        'http://localhost:3001/api/login/assess-risk',
        {
          userId,
          currentIp: geo.ip,
          currentGeo: { lat: geo.lat, lon: geo.lon, country: geo.country },
          browserExtensions: extensions,
          userAgent: navigator.userAgent,
        },
      )

      const risk = riskRes.data.data
      setRiskData(risk)

      if (risk.flow === 'HIGH') {
        // ── Step 2a: HIGH trust — trigger passkey directly ─────────────────
        setPhase('passkey')

        const optRes = await axios.post(
          'http://localhost:3001/api/webauthn/login/options',
          { userId },
        )

        const authResp = await startAuthentication({ optionsJSON: optRes.data })

        await axios.post(
          'http://localhost:3001/api/webauthn/login/verify',
          { userId, response: authResp },
        )

        // Fetch the user's public key + profile to display on dashboard
        const profileRes = await axios.get<{
          success: boolean
          data: { userId: string; name: string; age: number; publicKey: string }
        }>(`http://localhost:3001/api/user/${encodeURIComponent(userId)}`)
        const profile = profileRes.data.data

        setPhase('done')
        saveSession({
          userId,
          name: profile.name,
          age: profile.age,
          publicKey: profile.publicKey,
          safeScore: risk.safeScore,
          flow: 'high',
        })
        navigate('/dashboard', {
          replace: true,
          state: {
            userId,
            name: profile.name,
            age: profile.age,
            publicKey: profile.publicKey,
            safeScore: risk.safeScore,
            flow: 'high',
          },
        })

      } else {
        // ── Step 2b: MODERATE or LOW — secondary verification ─────────────
        const flowLower = risk.flow.toLowerCase() as 'moderate' | 'low'
        navigate('/verification', {
          replace: true,
          state: { userId, safeScore: risk.safeScore, flow: flowLower },
        })
      }

    } catch (err: unknown) {
      setPhase('idle')
      if (axios.isAxiosError(err)) {
        const msg = err.response?.data?.message
        if (Array.isArray(msg)) {
          setServerError(msg.join(' · '))
        } else {
          setServerError(
            msg ??
            (err.response?.status === 401
              ? 'User not found or not registered.'
              : 'Server error — is the auth backend running on port 3001?'),
          )
        }
      } else if (err instanceof Error) {
        setServerError(
          err.name === 'NotAllowedError'
            ? 'Passkey prompt was dismissed. Please try again.'
            : err.message,
        )
      } else {
        setServerError('Unexpected error. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="card w-full max-w-5xl mx-auto flex flex-col md:flex-row min-h-[600px] animate-fade-up !p-0 border border-white/10 shadow-[0_20px_60px_-15px_rgba(0,0,0,1)] bg-[#0a0a0a] overflow-hidden">

      {/* Left side: Illustration */}
      <div 
        className="hidden md:flex flex-1 flex-col items-start justify-end p-12 text-left relative overflow-hidden"
        style={{ 
          backgroundImage: 'url(/bg_abstract.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat'
        }}
      >
        {/* Gradient overlay to seamlessly blend into the right panel */}
        <div className="absolute inset-0 bg-gradient-to-r from-black/40 via-transparent to-[#0a0a0a] pointer-events-none" />
        
        <div className="relative z-10 w-full mb-4">
          <h2 className="text-3xl font-bold text-white mb-2 drop-shadow-lg">CIPHER-PORTAL</h2>
          <p className="text-slate-300 text-sm max-w-[300px] leading-relaxed drop-shadow-md">
            Next-generation biometric authentication. Your identity is your key.
          </p>
        </div>
      </div>

      {/* Right side: Login Form */}
      <div className="flex-1 p-8 md:p-14 flex flex-col justify-center bg-[#0a0a0a] relative z-10">
        <div className="w-full max-w-sm mx-auto flex flex-col gap-8">
          
          <div className="text-left">
            <h1 className="text-3xl font-bold text-white mb-2">Welcome back</h1>
            <p className="text-base text-slate-400">Sign in Passwordlessly with just your passkey</p>
          </div>

          <form onSubmit={handleLogin} noValidate className="flex flex-col gap-5">

            {/* User ID */}
            <div className="flex flex-col gap-2">
              <label htmlFor="login-userid" className="field-label">User ID</label>
              <div className="relative">
                <Mail size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-600 pointer-events-none" />
                <input
                  id="login-userid"
                  type="text"
                  value={userId}
                  onChange={e => setUserId(e.target.value)}
                  placeholder="Enter your registered user ID"
                  autoComplete="username webauthn"
                  className="field-input pl-11 bg-white/5 border-white/10"
                  style={errors.userId ? { borderColor: 'rgba(239,68,68,0.45)', background: 'rgba(239,68,68,0.03)' } : {}}
                />
              </div>
              {errors.userId && (
                <p className="flex items-center gap-1.5 text-xs text-red-400">
                  <AlertTriangle size={11} />{errors.userId}
                </p>
              )}
            </div>

            {/* Passkey indicator */}
            <div className="flex items-center gap-4 px-5 py-4 rounded-xl bg-white/5 border border-white/10 mt-2">
              <Fingerprint size={22} className="text-white shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-300">Passwordless Authentication</p>
                <p className="text-xs text-slate-500 mt-1">Your passkey (Face ID, fingerprint, or PIN) will be used</p>
              </div>
              <Cpu size={16} className="text-slate-600 shrink-0" />
            </div>

            {/* Context collection status */}
            <ContextPill ready={geoCtx !== null} />

            {/* Phase indicators */}
            {riskData && phase === 'passkey' && <ScoreBadge score={riskData.safeScore} flow={riskData.flow} />}
            {phase === 'assessing' && (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 size={15} className="animate-spin text-white" />Assessing risk profile…
              </div>
            )}
            {phase === 'passkey' && (
              <div className="flex items-center gap-2 text-sm text-white/80">
                <Loader2 size={15} className="animate-spin" />Waiting for passkey authenticator…
              </div>
            )}

            {serverError && (
              <div className="flex items-start gap-2.5 p-3.5 rounded-xl text-xs text-red-300/90 leading-relaxed"
                style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.16)' }}>
                <AlertTriangle size={13} className="text-red-400 shrink-0 mt-0.5" />{serverError}
              </div>
            )}

            <button id="btn-login" type="submit" disabled={loading} className="btn-glow w-full gap-2 mt-3">
              {loading ? <Loader2 size={15} className="animate-spin" /> : <LogIn size={15} />}
              {loading ? 'Authenticating…' : 'Sign In with Passkey'}
            </button>

            <button
              id="btn-recovery"
              type="button"
              onClick={() => navigate('/recovery')}
              className="w-full text-sm text-slate-500 hover:text-white transition-colors py-2 flex items-center justify-center gap-2 mt-1"
            >
              <ShieldAlert size={14} /> Lost your device or passkey? Recover account
            </button>
          </form>


          <div className="divider text-sm">or</div>

          <p className="text-center text-base text-slate-500">
            Don't have an account?{' '}
            <button type="button" onClick={() => navigate('/register')} className="text-white hover:text-slate-300 transition-colors font-medium">
              Create account
            </button>
          </p>
        </div>
      </div>
    </div>
  )
}
