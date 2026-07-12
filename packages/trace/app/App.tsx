import { useEffect, useState } from "react";
import type { AppSection } from "./components/AppHeader";
import StickersExplorer from "./islands/StickersExplorer";
import TraceExplorer from "./islands/TraceExplorer";

export default function App() {
  const [section, setSection] = useState<AppSection>(() => sectionFromHash());

  useEffect(() => {
    const syncSection = () => setSection(sectionFromHash());
    window.addEventListener("hashchange", syncSection);
    if (!window.location.hash) {
      window.history.replaceState(null, "", "#/traces");
    }
    return () => window.removeEventListener("hashchange", syncSection);
  }, []);

  useEffect(() => {
    document.title = section === "stickers" ? "Stickers · Gestalt Live" : "Traces · Gestalt Live";
  }, [section]);

  return section === "stickers" ? <StickersExplorer /> : <TraceExplorer />;
}

function sectionFromHash(): AppSection {
  return window.location.hash.replace(/^#\/?/, "") === "stickers" ? "stickers" : "traces";
}
