import { Component } from "react";
import { t, getLang } from "../i18n";

// Catches render errors in one role route so a single undefined variable
// can never blank the whole page — the fallback keeps other routes navigable.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Console-only beacon: no backend endpoint, keep minimal.
    console.error("[pressid-error-boundary]", error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const lang = getLang();
    const detail = String(error?.stack || error?.message || error);
    return (
      <div className="page" role="status">
        <h2>{t(lang, "error_crash")}</h2>
        <p className="error">{detail.slice(0, 300)}</p>
        <div className="row">
          <button type="button" className="small" onClick={() => window.location.reload()}>
            {t(lang, "error_reload")}
          </button>
          <button
            type="button"
            className="small ghost"
            onClick={() => {
              try {
                navigator.clipboard?.writeText(detail);
              } catch {
                /* ignore */
              }
            }}
          >
            {t(lang, "error_copy")}
          </button>
        </div>
      </div>
    );
  }
}
