import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'

import GridTrailBackground from './components/GridTrailBackground'
import LoginPage       from './pages/LoginPage'
import RegisterPage    from './pages/RegisterPage'
import VerificationPage from './pages/VerificationPage'
import RecoveryPage    from './pages/RecoveryPage'
import DashboardPage   from './pages/DashboardPage'

// ─── JWT guard ────────────────────────────────────────────────────────────────
/**
 * Wraps a route element: if no JWT is found in localStorage the user is
 * redirected to /login with the attempted path stored so they can be sent
 * back after authentication completes.
 */
function ProtectedRoute({ children }: { children: ReactNode }) {
  const jwt = localStorage.getItem('cipher_jwt')
  if (!jwt) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <BrowserRouter>
      {/* ── z-0: full-screen interactive canvas (global, behind every page) ── */}
      <GridTrailBackground />

      {/* ── z-10: page content ────────────────────────────────────────────── */}
      <div
        style={{ position: 'relative', zIndex: 10 }}
        className="min-h-screen flex items-center justify-center p-6"
      >
        <Routes>
          {/* Public routes */}
          <Route path="/"            element={<Navigate to="/login" replace />} />
          <Route path="/login"       element={<LoginPage />} />
          <Route path="/register"    element={<RegisterPage />} />
          <Route path="/verification" element={<VerificationPage />} />
          <Route path="/recovery"    element={<RecoveryPage />} />

          {/* Protected route — requires JWT in localStorage */}
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
