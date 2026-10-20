import { Component, type ReactNode } from "react";

/**
 * The failure mode that looks like an empty store.
 *
 * React unmounts the whole tree when a render throws, and a bundle that 404s because the
 * tab was open across a rebuild throws before anything is drawn. Both used to end as a
 * blank page with no message and no way back except the address bar; this puts the error
 * on screen and offers the one action that helps.
 */
export class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = /chunk|dynamically imported|importing a module/i.test(error.message);
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="hairline max-w-[560px] space-y-3 p-4">
          <div className={`micro ${stale ? "text-flow" : "text-danger"}`}>
            {stale ? "the build changed under this tab" : "this panel failed to render"}
          </div>
          <p className="text-[13px] leading-relaxed">
            {stale
              ? "A new bundle replaced the one this tab had loaded, so a part of the app could no longer be fetched. Reloading picks up the new code."
              : "The store answered, but something in the view threw while drawing it. The numbers below are untouched — a reload usually clears it."}
          </p>
          <pre className="tape max-h-40 overflow-auto whitespace-pre-wrap text-ink-faint">{error.message}</pre>
          <button type="button" className="btn" onClick={() => location.reload()}>
            reload
          </button>
        </div>
      </div>
    );
  }
}
