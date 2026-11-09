import { useLang } from "../i18n";

export default function LangToggle() {
  const { lang, toggle } = useLang();
  return (
    <button type="button" className="lang-toggle no-print" onClick={toggle} aria-label="Toggle language / भाषा बदलें">
      {lang === "hi" ? "EN" : "हिं"}
    </button>
  );
}
