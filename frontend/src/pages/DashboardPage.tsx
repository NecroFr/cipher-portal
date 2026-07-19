import { useEffect, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import axios from 'axios'
import confetti from 'canvas-confetti'
import { clearSession, getSession } from '../utils/session'
import type { SessionData } from '../utils/session'
import {
  ShieldCheck,
  LogOut,
  User,
  Cpu,
  Activity,
  Fingerprint,
  QrCode,
  Bell,
  Star,
  AlertTriangle,
  Check,
} from 'lucide-react'

// ─── Helpers ──────────────────────────────────────────────────────────────────
function scoreLabel(score: number): { label: string; color: string; bg: string; border: string } {
  if (score >= 80) return { label: 'High Trust', color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25' }
  if (score >= 40) return { label: 'Moderate',   color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/25'   }
  return               { label: 'Low Trust',  color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/25'     }
}

const FLOW_ICON: Record<string, React.ReactNode> = {
  high:     <Fingerprint size={13} />,
  moderate: <QrCode      size={13} />,
  low:      <Bell        size={13} />,
}

const FLOW_LABEL: Record<string, string> = {
  high:     'Passkey / Biometric',
  moderate: 'QR or Trusted Device',
  low:      'Trusted Device only',
}



// ─── Score ring ───────────────────────────────────────────────────────────────
function ScoreRing({ score }: { score: number }) {
  const { label, color } = scoreLabel(score)
  const radius = 42
  const circ   = 2 * Math.PI * radius
  const offset = circ - (score / 100) * circ
  const stroke = score >= 80 ? '#10b981' : score >= 40 ? '#f59e0b' : '#ef4444'

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-[104px] h-[104px] flex items-center justify-center">
        <svg width="104" height="104" className="absolute inset-0 -rotate-90">
          <circle cx="52" cy="52" r={radius} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="7" />
          <circle
            cx="52" cy="52" r={radius}
            fill="none"
            stroke={stroke}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(.4,0,.2,1)', filter: `drop-shadow(0 0 6px ${stroke})` }}
          />
        </svg>
        <div className="flex flex-col items-center z-10">
          <span className={`text-2xl font-bold leading-none ${color}`}>{score}</span>
          <span className="text-[10px] text-white/30 mt-0.5">/ 100</span>
        </div>
      </div>
      <span className={`text-xs font-semibold ${color}`}>{label}</span>
    </div>
  )
}

// ─── Section heading ──────────────────────────────────────────────────────────
function SectionHeading({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-teal-glow/50">{icon}</span>
      <h2 className="text-xs font-bold uppercase tracking-widest text-white/35">{title}</h2>
      <div className="flex-1 h-px bg-white/5" />
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const navigate  = useNavigate()
  const { state } = useLocation() as { state: Partial<SessionData> | null }

  // Merge location state with localStorage session
  const [session, setSessionState] = useState<SessionData>(() => {
    const stored = getSession()
    const merged: SessionData = {
      userId:    state?.userId    ?? stored?.userId    ?? 'unknown',
      name:      state?.name      ?? stored?.name,
      age:       state?.age       ?? stored?.age,
      publicKey: state?.publicKey ?? stored?.publicKey,
      safeScore: state?.safeScore ?? stored?.safeScore ?? 72,
      flow:      (state?.flow     ?? stored?.flow) as SessionData['flow'],
      factors:   state?.factors   ?? stored?.factors   ?? [],
      loginAt:   stored?.loginAt  ?? new Date().toISOString(),
    }
    localStorage.setItem('cipher_session', JSON.stringify(merged))
    return merged
  })

  // ── Fetch User Details if Missing ──────────────────────────────────────────
  useEffect(() => {
    if (session.userId !== 'unknown' && (!session.name || !session.age)) {
      axios.get(`http://localhost:3001/api/user/${encodeURIComponent(session.userId)}`)
        .then(res => {
          if (res.data?.success) {
            const profile = res.data.data
            setSessionState(prev => {
              const updated = { ...prev, name: profile.name, age: profile.age }
              localStorage.setItem('cipher_session', JSON.stringify(updated))
              return updated
            })
          }
        })
        .catch(err => console.error('Failed to fetch user profile:', err))
    }
  }, [session.userId, session.name, session.age])

  const confettiFired = useRef(false)

  // ── Confetti burst on mount ────────────────────────────────────────────────
  useEffect(() => {
    if (confettiFired.current) return
    confettiFired.current = true

    const fire = (opts: confetti.Options) =>
      confetti({ particleCount: 60, spread: 70, ...opts })

    setTimeout(() => fire({ colors: ['#00d4ff', '#00ffaa', '#39ff14', '#ffffff'], angle: 60,  origin: { x: 0.1, y: 0.5 } }), 0)
    setTimeout(() => fire({ colors: ['#00d4ff', '#6c63ff', '#00c896', '#ffffff'], angle: 120, origin: { x: 0.9, y: 0.5 } }), 200)
    setTimeout(() => fire({ colors: ['#00d4ff', '#00ffaa', '#ffffff'],             angle: 90,  origin: { x: 0.5, y: 0.4 } }), 450)
  }, [])

  // ── Logout ─────────────────────────────────────────────────────────────────
  function handleLogout() {
    clearSession()
    navigate('/login', { replace: true })
  }

  const loginTime  = session.loginAt
    ? new Date(session.loginAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '—'

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="w-full max-w-4xl mx-auto flex flex-col gap-8 animate-fade-up py-10 px-4">

      {/* Header bar */}
      <div className="bg-[#0a0a0a] border border-white/10 rounded-2xl px-8 py-5 flex items-center gap-6 shadow-xl">
        <div className="w-12 h-12 rounded-full bg-cyan-500/10 border border-cyan-500/20
                        flex items-center justify-center shrink-0 animate-pulse-glow shadow-[0_0_15px_rgba(6,182,212,0.15)]">
          <ShieldCheck size={24} className="text-cyan-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-white tracking-tight mb-1">
            Authentication Portal
          </h1>
          <p className="text-sm text-slate-400 truncate">
            Signed in as <span className="text-white font-medium">{session.userId}</span>
            <span className="mx-2 text-white/20">|</span>
            {loginTime}
          </p>
        </div>
        <button
          id="btn-logout"
          type="button"
          onClick={handleLogout}
          className="btn-outline px-4 py-2 flex items-center gap-2 text-sm border-white/10 hover:border-white/20 hover:bg-white/5"
        >
          <LogOut size={16} />
          Logout
        </button>
      </div>

      {/* Success banner */}
      <div className="flex items-center gap-4 px-6 py-5 rounded-2xl bg-[#0a0a0a] border border-emerald-500/30 shadow-[0_0_30px_-5px_rgba(16,185,129,0.15)] relative overflow-hidden">
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-emerald-500" />
        <div className="w-10 h-10 rounded-full bg-emerald-500/10 flex items-center justify-center shrink-0">
          <Check size={20} className="text-emerald-400" />
        </div>
        <div>
          <p className="text-base font-bold text-emerald-400 mb-0.5">Successfully Logged In!</p>
          <p className="text-sm text-slate-400">
            Your identity has been verified. All systems operational.
          </p>
        </div>
        <Star size={24} className="text-emerald-500/20 ml-auto shrink-0" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Left Column: User details */}
        <div className="flex flex-col gap-6">
          <section className="bg-[#0a0a0a] border border-white/10 rounded-2xl p-6 shadow-xl flex-1 flex flex-col">
            <SectionHeading icon={<User size={16} className="text-cyan-400" />} title="User Identity" />
            <div className="flex flex-col gap-4 flex-1 justify-center mt-2">
              <div className="flex items-center gap-4 p-4 rounded-xl bg-white/5 border border-white/5">
                <div className="w-10 h-10 rounded-full bg-cyan-500/10 flex items-center justify-center">
                  <User size={18} className="text-cyan-400" />
                </div>
                <div>
                  <div className="text-xs uppercase tracking-widest font-semibold text-slate-500 mb-1">User ID</div>
                  <div className="text-base font-semibold text-white">{session.userId}</div>
                </div>
              </div>
              
              <div className="flex items-center gap-4 p-4 rounded-xl bg-white/5 border border-white/5">
                <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center">
                  <User size={18} className="text-slate-400" />
                </div>
                <div>
                  <div className="text-xs uppercase tracking-widest font-semibold text-slate-500 mb-1">Display Name</div>
                  <div className="text-base font-semibold text-white">{session.name ?? <span className="text-slate-500 italic text-sm">Not set</span>}</div>
                </div>
              </div>

              <div className="flex items-center gap-4 p-4 rounded-xl bg-white/5 border border-white/5">
                <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center">
                  <Cpu size={18} className="text-slate-400" />
                </div>
                <div>
                  <div className="text-xs uppercase tracking-widest font-semibold text-slate-500 mb-1">Age</div>
                  <div className="text-base font-semibold text-white">{session.age ?? <span className="text-slate-500 italic text-sm">—</span>}</div>
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* Right Column: Risk Evaluation */}
        <div className="flex flex-col gap-6">
          <section className="bg-[#0a0a0a] border border-white/10 rounded-2xl p-6 shadow-xl flex-1 flex flex-col">
            <SectionHeading icon={<Activity size={16} className="text-cyan-400" />} title="Risk Evaluation" />
            
            <div className="flex flex-col items-center gap-6 mt-4">
              <ScoreRing score={session.safeScore ?? 0} />

              <div className="w-full flex flex-col gap-4">
                <div className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5">
                  <span className="text-xs uppercase tracking-widest text-slate-500">Auth Flow</span>
                  <div className="flex items-center gap-2">
                    <span className="text-cyan-400">{FLOW_ICON[session.flow ?? 'moderate']}</span>
                    <span className="text-sm text-white font-medium">{FLOW_LABEL[session.flow ?? 'moderate']}</span>
                  </div>
                </div>

                {(session.factors?.length ?? 0) > 0 && (
                  <div className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5">
                    <span className="text-xs uppercase tracking-widest text-slate-500">Factors</span>
                    <div className="flex flex-wrap gap-1.5 justify-end">
                      {session.factors!.map(f => (
                        <span key={f} className="px-2 py-1 rounded-md bg-white/10 text-xs text-white">
                          {f}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-auto pt-6 border-t border-white/10 grid grid-cols-3 gap-2 text-center">
              {([
                { range: '≥ 80', color: 'text-emerald-400', label: 'High', desc: 'Passkey', active: (session.safeScore ?? 0) >= 80 },
                { range: '40–79', color: 'text-amber-400',  label: 'Mod', desc: 'QR/OTP', active: (session.safeScore ?? 0) >= 40 && (session.safeScore ?? 0) < 80 },
                { range: '< 40',  color: 'text-red-400',    label: 'Low', desc: 'Device', active: (session.safeScore ?? 0) < 40  },
              ] as const).map(({ range, color, label, active }) => (
                <div key={range} className={`flex flex-col gap-1 p-2 rounded-lg border transition-all ${active ? `${color.replace('text-', 'bg-').replace('400', '500/10')} ${color.replace('text-', 'border-').replace('400', '500/30')}` : 'bg-white/5 border-transparent'}`}>
                  <span className={`text-sm font-bold ${color}`}>{range}</span>
                  <span className="text-xs font-semibold text-slate-300">{label}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {/* Logout footer */}
      <div className="flex flex-col md:flex-row items-center justify-end gap-4 mt-4 text-center md:text-right">
        <button
          type="button"
          onClick={handleLogout}
          className="flex items-center gap-2 text-xs text-slate-500 hover:text-red-400 transition-colors bg-white/5 hover:bg-red-500/10 px-4 py-2 rounded-lg border border-transparent hover:border-red-500/20"
        >
          <AlertTriangle size={14} />
          Sign out & Clear
        </button>
      </div>

    </div>
  )
}
