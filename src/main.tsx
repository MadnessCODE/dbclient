import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "./lib/monaco";
import App from "./App";

/** Shows the error instead of a blank page. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-lg font-semibold text-err">Something went wrong</h1>
        <pre className="selectable max-w-[800px] overflow-auto rounded-md bg-panel p-4 text-left font-mono text-[12px] whitespace-pre-wrap text-fg-2">
          {this.state.error.message}
          {"\n\n"}
          {this.state.error.stack}
        </pre>
        <button className="rounded-md bg-accent px-4 py-2 text-white" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
// Tells the boot check in index.html that the bundle loaded.
(window as unknown as { __dbcBooted: boolean }).__dbcBooted = true;
// a slow first load (e.g. Vite optimizing deps in dev) may have shown it already
document.getElementById("boot-error")?.remove();
