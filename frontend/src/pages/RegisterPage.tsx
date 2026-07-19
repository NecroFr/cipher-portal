import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { startRegistration } from '@simplewebauthn/browser'
import axios from 'axios'
import {
  User, Mail, Calendar, Fingerprint, KeyRound,
  ShieldCheck, Copy, Check, AlertTriangle,
  ChevronRight, Loader2, Eye, EyeOff,
} from 'lucide-react'

/* ─── Types ─────────────────────────────────────────────────────────────── */
type AuthMethod = 'passkey' | 'security-key'

interface RegistrationResponse {
  userId: string
  publicKey: string
  privateKey: string
  recoveryWords: string[]
}

/* ─── Sub-components ─────────────────────────────────────────────────────── */
function FormField({ label, icon, error, children }: {
  label: string; icon: React.ReactNode; error?: string; children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="field-label flex items-center gap-1.5">
        <span className="text-cyan-brand opacity-60">{icon}</span>{label}
      </label>
      {children}
      {error && (
        <p className="flex items-center gap-1.5 text-xs text-red-400 mt-0.5">
          <AlertTriangle size={11} />{error}
        </p>
      )}
    </div>
  )
}

function RecoveryGrid({ words }: { words: string[] }) {
  const [copied, setCopied] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(words.map((w, i) => `${i + 1}: ${w}`).join('\n'))
    setCopied(true); setTimeout(() => setCopied(false), 2500)
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-widest text-cyan-brand opacity-80">
          15 Recovery Words
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={() => setRevealed(v => !v)}
            className="btn-outline h-7 px-3 text-xs gap-1">
            {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
            {revealed ? 'Hide' : 'Reveal'}
          </button>
          <button type="button" onClick={handleCopy} className="btn-primary h-7 px-3 text-xs gap-1">
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied!' : 'Copy All'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {words.map((word, i) => (
          <div key={i} className="flex items-center gap-2 rounded-xl px-3 py-2.5"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <span className="text-cyan-brand text-xs font-mono opacity-50 w-5 shrink-0">{i + 1}.</span>
            <span className={`text-sm font-medium text-slate-200 select-all transition-all duration-300 ${revealed ? '' : 'blur-sm'}`}>
              {word}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-start gap-3 p-3.5 rounded-xl"
        style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.18)' }}>
        <AlertTriangle size={15} className="text-amber-400 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-300/80 leading-relaxed">
          <strong className="text-amber-300">Store these offline.</strong> These words are shown once
          only and are the only way to recover your account if you lose your device.
        </p>
      </div>
    </div>
  )
}

/* ─── Step indicator ─────────────────────────────────────────────────────── */
function StepDot({ n, active, done }: { n: number; active: boolean; done: boolean }) {
  return (
    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold border transition-all duration-300 ${
      done  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
            : active ? 'bg-cyan-500/20 border-cyan-500/60 text-cyan-400 animate-pulse'
            : 'bg-white/5 border-white/10 text-white/20'
    }`}>
      {done ? <Check size={11} /> : n}
    </div>
  )
}

/* ─── Main Page ──────────────────────────────────────────────────────────── */
export default function RegisterPage() {
  const navigate = useNavigate()

  // Form fields
  const [userId, setUserId]     = useState('')
  const [name, setName]         = useState('')
  const [age, setAge]           = useState('')
  const [authMethod, setAuthMethod] = useState<AuthMethod>('passkey')

  // Multi-step state
  // step 1 = fill form
  // step 2 = enrolling passkey (user created, passkey being enrolled)
  // step 3 = success (show keys + recovery words)
  const [step, setStep]         = useState<1 | 2 | 3>(1)
  const [enrollLoading, setEnrollLoading] = useState(false)
  const [errors, setErrors]     = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState('')
  const [result, setResult]     = useState<RegistrationResponse | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [showKeys, setShowKeys] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  function validate() {
    const e: Record<string, string> = {}
    if (!userId.trim()) e.userId = 'User ID is required'
    else if (userId.length < 3) e.userId = 'Minimum 3 characters'
    if (!name.trim()) e.name = 'Full name is required'
    const n = Number(age)
    if (!age) e.age = 'Age is required'
    else if (!Number.isInteger(n) || n < 13 || n > 120) e.age = 'Enter a valid age (13–120)'
    setErrors(e); return Object.keys(e).length === 0
  }

  /**
   * Combined registration + WebAuthn enrollment in the correct order:
   *
   * 1. POST /api/register           → create user row in DB, get keys + recovery words
   * 2. POST /api/webauthn/register/options → generate challenge (user now exists in DB ✓)
   * 3. Browser WebAuthn gesture
   * 4. POST /api/webauthn/register/verify  → persist credential
   * 5. Show success screen
   */
  async function handleRegisterAndEnroll(e: React.FormEvent) {
    e.preventDefault()
    if (!validate()) return
    setEnrollLoading(true)
    setServerError('')

    try {
      // ── Step 1: Create the user account ─────────────────────────────────
      const regRes = await axios.post<{ success: boolean; data: RegistrationResponse }>(
        'http://localhost:3001/api/register',
        { userId, name, age: Number(age) },
      )
      const registrationData = regRes.data.data

      // ── Step 2: Generate WebAuthn challenge (user now exists in DB) ──────
      const deviceLabel = authMethod === 'passkey' ? 'Platform authenticator' : 'Security key'
      const optRes = await axios.post(
        'http://localhost:3001/api/webauthn/register/options',
        { userId, deviceLabel },
      )

      // ── Step 3: Browser prompts the user for their biometric / PIN ───────
      setStep(2) // show "waiting for authenticator" state
      const attResp = await startRegistration({ optionsJSON: optRes.data })

      // ── Step 4: Verify + persist the credential ──────────────────────────
      await axios.post('http://localhost:3001/api/webauthn/register/verify', {
        userId,
        response: attResp,
      })

      // ── Step 5: Show success screen with keys + recovery words ───────────
      setResult(registrationData)
      setStep(3)

    } catch (err: unknown) {
      setStep(1) // revert so user can retry
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setServerError('Passkey prompt dismissed or timed out. Please try again.')
      } else if (axios.isAxiosError(err)) {
        const msg = err.response?.data?.message
        if (err.response?.status === 409) {
          setServerError(`User ID "${userId}" is already registered. Please choose a different ID or sign in.`)
        } else {
          setServerError(
            Array.isArray(msg) ? msg.join(' · ')
              : msg ?? `Server error (${err.response?.status ?? 'network'}) — is the auth server running on port 3001?`,
          )
        }
      } else {
        setServerError('Unexpected error. Please try again.')
      }
    } finally {
      setEnrollLoading(false)
    }
  }

  /* ─── Render ─────────────────────────────────────────────────────────────── */
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
        <div className="absolute inset-0 bg-gradient-to-r from-black/40 via-transparent to-[#0a0a0a] pointer-events-none" />
        <div className="relative z-10 w-full mb-4">
          <h2 className="text-3xl font-bold text-white mb-2 drop-shadow-lg">CIPHER-PORTAL</h2>
          <p className="text-slate-300 text-sm max-w-[300px] leading-relaxed drop-shadow-md">
            Next-generation biometric authentication. Your identity is your key.
          </p>
        </div>
      </div>

      {/* Right side: Registration/Success Form */}
      <div className="flex-1 p-8 md:p-14 flex flex-col justify-center bg-[#0a0a0a] relative z-10">
        
        {step === 3 && result ? (
          /* ── Success screen ── */
          <div className="w-full max-w-md mx-auto flex flex-col gap-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full flex items-center justify-center bg-white/5 border border-white/10">
                <ShieldCheck size={24} className="text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">Registration Complete</h2>
                <p className="text-sm text-slate-400">Account created for <span className="text-white font-medium">{result.userId}</span></p>
              </div>
            </div>

            {/* Key pair */}
            <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
              <button type="button" onClick={() => setShowKeys(v => !v)}
                className="w-full flex items-center justify-between px-4 py-4 text-sm font-medium text-slate-300 hover:text-white transition-colors bg-white/5">
                <span className="flex items-center gap-2"><KeyRound size={16} className="text-white" />Key Pair Preview</span>
                <ChevronRight size={16} className={`transition-transform duration-200 ${showKeys ? 'rotate-90' : ''}`} />
              </button>
              {showKeys && (
                <div className="p-5 flex flex-col gap-4 border-t border-white/10 bg-black/40">
                  {[['Public Key', result.publicKey], ['Private Key', result.privateKey]].map(([lbl, val]) => (
                    <div key={lbl} className="flex flex-col gap-2">
                      <span className="text-xs uppercase tracking-widest text-slate-500">{lbl}</span>
                      <code className="text-xs text-slate-300 font-mono break-all leading-relaxed p-3 rounded-lg bg-black/50 border border-white/5">
                        {val}
                      </code>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <RecoveryGrid words={result.recoveryWords} />

            {/* Confirmation */}
            <label className="flex items-start gap-4 cursor-pointer group mt-2">
              <div className="relative shrink-0 mt-0.5">
                <input type="checkbox" id="backup-confirm" className="sr-only peer"
                  checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
                <div className="w-6 h-6 rounded-md flex items-center justify-center transition-all duration-200"
                  style={{
                    background: confirmed ? '#ffffff' : 'rgba(255,255,255,0.05)',
                    border: `1px solid ${confirmed ? '#ffffff' : 'rgba(255,255,255,0.15)'}`,
                  }}>
                  {confirmed && <Check size={14} className="text-black font-bold" />}
                </div>
              </div>
              <span className="text-sm text-slate-400 group-hover:text-slate-300 transition-colors leading-relaxed">
                I have <strong className="text-white">securely backed up</strong> my 15 recovery words
                and understand they cannot be shown again.
              </span>
            </label>

            <button type="button" disabled={!confirmed} onClick={() => navigate('/login')}
              className="btn-primary w-full gap-2 mt-2">
              Continue to Login <ChevronRight size={16} />
            </button>
          </div>
        ) : (
          /* ── Registration form ── */
          <div className="w-full max-w-sm mx-auto flex flex-col gap-7">
            {/* Header */}
            <div className="text-left">
              <h1 className="text-3xl font-bold text-white mb-2">Create Account</h1>
              <p className="text-base text-slate-400">Register your identity with biometric credentials</p>
            </div>

            {/* Progress dots */}
            <div className="flex items-center gap-3 justify-start mb-2">
              <StepDot n={1} active={step === 1} done={step > 1} />
              <div className="w-8 h-px bg-white/10" />
              <StepDot n={2} active={step === 2} done={step > 2} />
              <div className="w-8 h-px bg-white/10" />
              <StepDot n={3} active={step === 3} done={step > 3} />
            </div>

            <form ref={formRef} onSubmit={handleRegisterAndEnroll} noValidate className="flex flex-col gap-5">
              <FormField label="User ID" icon={<Mail size={15} />} error={errors.userId}>
                <input id="reg-userid" type="text" value={userId}
                  onChange={e => setUserId(e.target.value)}
                  placeholder="e.g. alice123" autoComplete="username"
                  disabled={enrollLoading}
                  className={`field-input pl-4 bg-white/5 border-white/10 ${errors.userId ? '!border-red-500/50 !bg-red-500/5' : ''}`} />
              </FormField>

              <FormField label="Full Name" icon={<User size={15} />} error={errors.name}>
                <input id="reg-name" type="text" value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Alice Nakamoto" autoComplete="name"
                  disabled={enrollLoading}
                  className={`field-input pl-4 bg-white/5 border-white/10 ${errors.name ? '!border-red-500/50 !bg-red-500/5' : ''}`} />
              </FormField>

              <FormField label="Age" icon={<Calendar size={15} />} error={errors.age}>
                <input id="reg-age" type="number" min={13} max={120} value={age}
                  onChange={e => setAge(e.target.value)} placeholder="e.g. 28"
                  disabled={enrollLoading}
                  className={`field-input pl-4 bg-white/5 border-white/10 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${errors.age ? '!border-red-500/50 !bg-red-500/5' : ''}`} />
              </FormField>

              {/* Auth method */}
              <div className="flex flex-col gap-2 mt-2">
                <span className="field-label">Authentication Method</span>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    { value: 'passkey',      label: 'Passkey', icon: <Fingerprint size={18} />, desc: 'Face ID, fingerprint or PIN' },
                    { value: 'security-key', label: 'Security Key', icon: <KeyRound size={18} />,   desc: 'Physical hardware key' },
                  ] as const).map(m => (
                    <button key={m.value} type="button" id={`auth-method-${m.value}`}
                      onClick={() => setAuthMethod(m.value)}
                      disabled={enrollLoading}
                      className="flex flex-col items-start gap-2 p-4 rounded-xl border text-left transition-all duration-200"
                      style={{
                        background: authMethod === m.value ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.02)',
                        borderColor: authMethod === m.value ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.08)',
                      }}>
                      <span className={authMethod === m.value ? 'text-white' : 'text-slate-500'}>{m.icon}</span>
                      <span className="text-sm font-semibold text-slate-200">{m.label}</span>
                      <span className="text-xs text-slate-500 leading-tight">{m.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Step 2 waiting indicator */}
              {step === 2 && (
                <div className="flex items-center gap-3 p-4 rounded-xl bg-white/5 border border-white/10 mt-2">
                  <Loader2 size={16} className="animate-spin text-white shrink-0" />
                  <p className="text-sm text-slate-300 leading-relaxed">
                    Waiting for authenticator… use Face ID, fingerprint, or PIN when prompted.
                  </p>
                </div>
              )}

              {serverError && (
                <div className="flex items-start gap-2.5 p-3.5 rounded-xl text-xs text-red-300/90 leading-relaxed"
                  style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.18)' }}>
                  <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />{serverError}
                </div>
              )}

              <button id="btn-register" type="submit" disabled={enrollLoading} className="btn-primary w-full gap-2 mt-4">
                {enrollLoading
                  ? <><Loader2 size={16} className="animate-spin" />{step === 2 ? 'Waiting for authenticator…' : 'Creating account…'}</>
                  : <><Fingerprint size={16} />Create Account &amp; Enroll Passkey</>}
              </button>

              <div className="divider text-sm">or</div>

              <p className="text-center text-base text-slate-500">
                Already have an account?{' '}
                <button type="button" onClick={() => navigate('/login')} className="text-white hover:text-slate-300 transition-colors font-medium">
                  Sign in
                </button>
              </p>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
