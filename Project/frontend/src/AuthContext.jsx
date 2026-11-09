import { createContext, useContext, useState } from "react";
import { Navigate } from "react-router-dom";
import { api } from "./api";

const AuthCtx = createContext(null);

function loadSession() {
  try {
    const token = localStorage.getItem("pressid_token");
    const user = JSON.parse(localStorage.getItem("pressid_user") || "null");
    if (token && user) return { token, user };
  } catch { /* ignore */ }
  return { token: null, user: null };
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(loadSession);

  const login = async (username, password) => {
    const data = await api("/auth/login", {
      method: "POST",
      body: { username, password },
      auth: false,
    });
    const user = data.user || {};
    // Backend may signal forced rotation as mustChange / must_change / forcePasswordChange
    if (data.mustChange === undefined) {
      if (data.must_change !== undefined) user.mustChange = data.must_change;
      else if (data.forcePasswordChange !== undefined) user.mustChange = data.forcePasswordChange;
    } else {
      user.mustChange = data.mustChange;
    }
    localStorage.setItem("pressid_token", data.token);
    localStorage.setItem("pressid_user", JSON.stringify(user));
    setSession({ token: data.token, user });
    return user;
  };

  const setMustChange = (v) => {
    setSession((s) => {
      if (!s?.user) return s;
      const user = { ...s.user, mustChange: !!v };
      try { localStorage.setItem("pressid_user", JSON.stringify(user)); } catch { /* ignore */ }
      return { ...s, user };
    });
  };

  const logout = () => {
    localStorage.removeItem("pressid_token");
    localStorage.removeItem("pressid_user");
    setSession({ token: null, user: null });
  };

  return (
    <AuthCtx.Provider value={{ ...session, login, logout, setMustChange }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  return useContext(AuthCtx);
}

export function homeForRole(role) {
  switch (role) {
    case "admin": return "/admin";
    case "issuer": return "/issuer";
    case "police": return "/police";
    case "press": return "/press";
    default: return "/login";
  }
}

export function RequireAuth({ roles, children }) {
  const auth = useAuth();
  if (!auth || !auth.token) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(auth.user?.role)) {
    return <Navigate to={homeForRole(auth.user?.role)} replace />;
  }
  return children;
}
