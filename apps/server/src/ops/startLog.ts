// Lines written while the server starts, before its logger exists (the
// migrations, the one-time data fixes). They used to go to console.log;
// now they are kept and handed to the server's own logger at info level as
// soon as there is one, so they sit in the same log, in the same shape, as
// everything else (`docker logs` shows them with the rest). If the server
// never gets that far, `flushTo` writes what is kept somewhere else.

export interface StartLog {
  /** Keep a line, or log it at once when the logger is there. */
  line: (text: string) => void;
  /** The server's logger is ready: what was kept goes to it, in order, and so does every later line. */
  attach: (info: (text: string) => void) => void;
  /** Write what is still kept (the start failed before `attach`). */
  flushTo: (write: (text: string) => void) => void;
}

export function startLog(): StartLog {
  let kept: string[] = [];
  let info: ((text: string) => void) | null = null;
  return {
    line(text) {
      if (info) info(text);
      else kept.push(text);
    },
    attach(to) {
      info = to;
      for (const text of kept.splice(0)) to(text);
    },
    flushTo(write) {
      for (const text of kept.splice(0)) write(text);
      kept = [];
    },
  };
}
