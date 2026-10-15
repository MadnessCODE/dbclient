import { useEffect } from "react";
import { useStore } from "./store";
import { TitleBar } from "./components/TitleBar";
import { IconRail } from "./components/IconRail";
import { LeftPanel } from "./components/LeftPanel";
import { EditorArea } from "./components/EditorArea";
import { ResultsPanel } from "./components/ResultsPanel";
import { CommandPalette, ConnectionDialog, PasswordDialog, SettingsDialog } from "./components/Dialogs";
import { Splitter, useResizable } from "./components/ui";
import { ActionDialogHost, ContextMenuHost } from "./components/ContextMenu";
import { AboutDialog } from "./components/About";
import { ProjectDialog } from "./components/ProjectDialog";
import { HomePage } from "./components/HomePage";
import { ProcessesView } from "./components/ProcessesView";
import { ExportWizard } from "./components/ExportWizard";
import { ImportWizard } from "./components/ImportWizard";
import { ImportJobDialog, ImportToasts } from "./components/ImportJobs";
import { UsersDialogHost } from "./components/UsersDialog";
import { ErDiagramHost } from "./components/ErDiagram";
import { ExportDatabaseHost } from "./components/ExportDatabase";
import { ImportConnectionsHost } from "./components/ImportConnections";
import { FavoriteDialogHost } from "./components/FavoritesView";
import { startUpdateChecks } from "./lib/updater";

export default function App() {
  const theme = useStore((s) => s.theme);
  const maximized = useStore((s) => s.resultsMaximized);
  const view = useStore((s) => s.view);

  const left = useResizable("left", 270, 200, 480, "x");
  const results = useResizable("results", 470, 160, 900, "y", true);

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
  }, [theme]);

  useEffect(() => {
    useStore.getState().loadConnections().catch((e) => console.error("loadConnections", e));
    const stopUpdates = import.meta.env.DEV ? undefined : startUpdateChecks();

    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        st.setUi({ paletteOpen: !st.paletteOpen });
      } else if (k === "t") {
        e.preventDefault();
        st.newTab();
      } else if (k === "w") {
        e.preventDefault();
        if (st.activeTabId) st.closeTab(st.activeTabId);
      }
    };
    window.addEventListener("keydown", onKey);
    // no browser context menu, except in text inputs
    const onContext = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("input, textarea, .monaco-editor")) e.preventDefault();
    };
    window.addEventListener("contextmenu", onContext);
    return () => {
      stopUpdates?.();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onContext);
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <IconRail />
        {view === "home" ? (
          <HomePage />
        ) : view === "processes" ? (
          <ProcessesView />
        ) : (
          <>
            <LeftPanel width={left.size} />
            <Splitter direction="x" onMouseDown={left.onMouseDown} />
            <main className="flex min-w-0 flex-1 flex-col bg-bg">
              {!maximized && <EditorArea />}
              {!maximized && <Splitter direction="y" onMouseDown={results.onMouseDown} />}
              <ResultsPanel height={results.size} />
            </main>
          </>
        )}
      </div>
      <ConnectionDialog />
      <PasswordDialog />
      <CommandPalette />
      <SettingsDialog />
      <ActionDialogHost />
      <AboutDialog />
      <ProjectDialog />
      <ExportWizard />
      <ImportWizard />
      <ImportJobDialog />
      <UsersDialogHost />
      <ErDiagramHost />
      <ExportDatabaseHost />
      <ImportConnectionsHost />
      <FavoriteDialogHost />
      <ImportToasts />
      <ContextMenuHost />
    </div>
  );
}
