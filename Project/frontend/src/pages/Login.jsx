import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth, homeForRole } from "../AuthContext";
import { useLang } from "../i18n";
import LangToggle from "../components/LangToggle";

export default function Login() {
  const { login, token, user } = useAuth();
  const nav = useNavigate();
  const { t } = useLang();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (token && user) nav(homeForRole(user.role), { replace: true });
  }, [token, user, nav]);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const u = await login(username.trim(), password);
      nav(homeForRole(u.role), { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-wrap">
      <div className="login-card">
        <div className="brand-row">
          <span className="emblem" aria-hidden="true">◈</span>
          <div>
            <h1 className="brand-title">PressID</h1>
            <p className="brand-sub">{t("brand_sub")}</p>
          </div>
          <span className="login-lang"><LangToggle /></span>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="login-username">{t("username")}</label>
            <input id="login-username" name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} required />
          <label htmlFor="login-password">{t("password")}</label>
            <input id="login-password" name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? t("signing_in") : t("signin")}</button>
        </form>
        {["localhost", "127.0.0.1"].includes(window.location.hostname) && (
          <p className="demo-creds" role="note"><code>{t("demo_creds")}</code></p>
        )}
        <p className="hint">
          Backend: <code>{import.meta.env.VITE_API_URL || "http://localhost:4000/api"}</code><br />
          {t("login_hint")} <span>{t("login_contact")}</span><br />
          <Link to="/offline">Verify offline</Link> — no login, works in airplane mode with a cached bundle.
        </p>
      </div>
    </div>
  );
}
