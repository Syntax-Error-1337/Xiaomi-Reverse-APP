import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth, RequireAuth, homeForRole } from "./AuthContext";
import Login from "./pages/Login";
import AdminDashboard from "./pages/AdminDashboard";
import IssuerDashboard from "./pages/IssuerDashboard";
import PoliceDashboard from "./pages/PoliceDashboard";
import PressDashboard from "./pages/PressDashboard";
import OfflineVerify from "./pages/OfflineVerify";
import { LangProvider, useLang, t as tr } from "./i18n";
import LangToggle from "./components/LangToggle";
import ErrorBoundary from "./components/ErrorBoundary";

function roleLabel(role, lang) {
  const r = String(role || "").toLowerCase();
  if (["admin", "issuer", "police", "press"].includes(r)) return tr(lang, `role_${r}`);
  return role;
}

function Topbar() {
  const { user, token, logout } = useAuth();
  const nav = useNavigate();
  const { lang, t } = useLang();
  if (!token) return null;

  return (
    <header className="topbar">
      <Link className="topbar-brand" to={homeForRole(user?.role)}><span className="emblem" aria-hidden="true">◈</span> PressID</Link>
      <span className="role-badge">{roleLabel(user?.role, lang)}</span>
      <span className="topbar-user">{user?.username}{user?.orgName ? ` · ${user.orgName}` : ""}</span>
      <LangToggle />
      <button className="small ghost" onClick={() => { logout(); nav("/login"); }}>{t("logout")}</button>
    </header>
  );
}


function Home() {
  const { token, user } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <Navigate to={homeForRole(user?.role)} replace />;
}

function SkipLink() {
  const { t } = useLang();
  return <a className="skip-link" href="#main">{t("skip_to_content")}</a>;
}

function UpdateBanner() {
  const { t } = useLang();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onUpdate = () => setShow(true);
    window.addEventListener("pressid-sw-update", onUpdate);
    return () => window.removeEventListener("pressid-sw-update", onUpdate);
  }, []);
  if (!show) return null;
  return (
    <div className="no-print update-banner" role="status">
      <span>{t("sw_update_available")} — {t("refresh")}</span>
      <button type="button" className="small" onClick={() => window.location.reload()}>{t("refresh")}</button>
    </div>
  );
}

export default function App() {
  return (
    <LangProvider>
      <AuthProvider>
        <BrowserRouter>
          <Topbar />
          <UpdateBanner />
          <SkipLink />
        <main id="main" className="shell">
          <ErrorBoundary>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/offline" element={<OfflineVerify />} />
            <Route path="/admin" element={<ErrorBoundary><RequireAuth roles={["admin"]}><AdminDashboard /></RequireAuth></ErrorBoundary>} />
            <Route path="/issuer" element={<ErrorBoundary><RequireAuth roles={["issuer"]}><IssuerDashboard /></RequireAuth></ErrorBoundary>} />
            <Route path="/police" element={<ErrorBoundary><RequireAuth roles={["police"]}><PoliceDashboard /></RequireAuth></ErrorBoundary>} />
            <Route path="/press" element={<ErrorBoundary><RequireAuth roles={["press"]}><PressDashboard /></RequireAuth></ErrorBoundary>} />
            <Route path="/" element={<Home />} />
            <Route path="*" element={<Home />} />
          </Routes>
          </ErrorBoundary>
        </main>
        <footer className="foot">PressID Credential Registry — official use only</footer>
        </BrowserRouter>
      </AuthProvider>
    </LangProvider>
  );
}
