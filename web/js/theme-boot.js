// Runs before first paint: apply stored theme + language direction to avoid a flash.
try {
  const prefs = JSON.parse(localStorage.getItem("wheelhouse-prefs") || "{}");
  if (prefs.theme === "light" || prefs.theme === "dark") document.documentElement.dataset.theme = prefs.theme;
  if (prefs.fontSize) document.documentElement.style.setProperty("--font-size", `${prefs.fontSize}px`);
  const lang = localStorage.getItem("wheelhouse-lang") || "en";
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
} catch { /* storage unavailable */ }
