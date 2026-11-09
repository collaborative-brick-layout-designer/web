// When drawing the editor throws, a card in its place instead of a blank
// page. It sits below the hook that holds the layout (useLayoutDoc), so the
// layout stays open and connected behind the card: changes already made
// keep reaching the server, and "Try again" draws the editor afresh.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { LayoutDocState } from './useLayoutDoc';
import { downloadLocalLayout } from './localLayoutFile';

interface Props {
  what: 'layout' | 'module';
  layoutId: string;
  docState: LayoutDocState;
  children: ReactNode;
}

interface State {
  error: Error | null;
  downloaded: boolean;
}

export class EditorErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, downloaded: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('The editor stopped drawing:', error, info.componentStack);
  }

  private readonly tryAgain = (): void => this.setState({ error: null, downloaded: false });

  private readonly download = async (): Promise<void> => {
    const { doc } = this.props.docState;
    if (doc && (await downloadLocalLayout(doc, this.props.layoutId, `${this.props.what} (my copy)`, undefined))) this.setState({ downloaded: true });
  };

  override render(): ReactNode {
    const { error, downloaded } = this.state;
    if (!error) return this.props.children;
    const { what, docState } = this.props;
    // Every change has reached the server only while connected and synced.
    const allSent = docState.status.kind === 'synced';
    const btn = 'rounded-lg px-3 py-1.5 text-sm';
    return (
      <div className="grid h-screen place-items-center bg-bg p-4">
        <div role="alert" aria-labelledby="editor-crashed-title" className="max-w-md rounded-lg border border-border bg-panel p-5 text-sm shadow-lg">
          <p id="editor-crashed-title" className="text-base font-semibold">
            Something went wrong showing this {what}
          </p>
          <p className="mt-2 text-muted">
            {allSent
              ? `Nothing is lost: your changes are saved on the server. Try again, or reload the page.`
              : `Nothing is lost: your changes are kept on this page and are sent once it's connected again. Download a copy before you reload, to be safe.`}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" onClick={this.tryAgain} className={`${btn} bg-accent text-accent-ink hover:bg-accent-hover`}>
              Try again
            </button>
            {docState.doc && !allSent && (
              <button type="button" onClick={() => void this.download()} className={`${btn} border border-border hover:bg-soft`}>
                Download a copy (.bld-layout)
              </button>
            )}
            <button type="button" onClick={() => window.location.reload()} className={`${btn} border border-border hover:bg-soft`}>
              Reload the page
            </button>
          </div>
          {downloaded && <p className="mt-2 text-muted">Downloaded. Open the file from the Layouts list any time.</p>}
          <details className="mt-3 text-xs text-muted">
            <summary className="cursor-pointer">What went wrong</summary>
            <p className="mt-1 break-words font-mono">{error.message}</p>
          </details>
        </div>
      </div>
    );
  }
}
