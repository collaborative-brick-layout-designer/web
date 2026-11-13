// Settings: light or dark, color, bigger text, help icons and how
// strongly parts snap together. Signed in, they're stored on the account on this server (named
// by window.location.host, since every club runs its own); signed out,
// in this browser only. Used as a page (/settings) and as a dialog over
// the editor, so changing the look doesn't mean leaving a layout.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { SignInLink } from '../auth/signIn';
import { usePreferences } from '../theme/PrefsProvider';
import { ACCENTS, ACCENT_IDS, NEUTRALS } from '../theme/tokens';
import { effectiveColorStyle, type ColorStyle, type ThemeChoice } from '../theme/theme';
import { legoColor } from '@cld/model';
import { LegoColorPicker } from './LegoColorPicker';
import { HelpButton } from '../help/HelpButton';
import type { HelpKey } from '../help/helpTexts';
import { isMobileDevice, useInstallState } from '../pwa/install';
import { useHashScroll } from '../ui/useHashScroll';
import { isPhoneScreen, useTours } from '../tours/TourProvider';
import { toursFor } from '../tours/tours';
import { DEFAULT_SNAP_STRENGTH, type SnapStrength } from '../editor/snapFeel';
import { ROTATION_STEPS, SNAP_STEPS, useEditorStore } from '../editor/editorStore';
import { lastSnapTrace, setSnapTraceEnabled, snapTraceEnabled, snapTraceText } from '../editor/snapTrace';

const SNAP_CHOICES: { id: SnapStrength; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Parts never pull onto each other; the grid still lines them up.' },
  { id: 'gentle', label: 'Gentle', hint: 'Pulls only when the ends are close. Recommended.' },
  { id: 'strong', label: 'Strong', hint: 'Reaches further, for quick rough placing.' },
];

const COLOR_STYLE_CARDS: { id: ColorStyle; label: string; hint: string }[] = [
  { id: 'full', label: 'The whole app', hint: 'The header, toolbars, panel tops and the page behind them, as well as the buttons.' },
  { id: 'original', label: 'Just the highlights', hint: 'Buttons, the selected item and focus rings. The original look.' },
];

const THEME_CARDS: { id: ThemeChoice; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'Match my computer' },
];

function ThemePreview({ id }: { id: ThemeChoice }) {
  if (id === 'system') {
    return (
      <div className="flex h-14 sm:h-[90px] overflow-hidden rounded-control border border-line" aria-hidden>
        <div className="grow" style={{ background: NEUTRALS.light.bg }} />
        <div className="grow" style={{ background: NEUTRALS.dark.bg }} />
      </div>
    );
  }
  const n = NEUTRALS[id];
  return (
    <div className="flex h-14 sm:h-[90px] gap-1.5 rounded-control border border-line p-2" style={{ background: n.bg }} aria-hidden>
      <div className="w-[22%] rounded-md" style={{ background: n.panel }} />
      <div className="grow rounded-md" style={{ background: n.gridLine }} />
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  // The button is the tap target (44 px tall on touch screens); the track
  // inside keeps its pill shape at any button height.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="group inline-flex shrink-0 items-center justify-center rounded-full"
    >
      <span
        aria-hidden
        data-testid="switch-track"
        className={`relative block h-8 w-14 rounded-full transition-colors group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent ${checked ? 'bg-accent' : 'bg-border'}`}
      >
        <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-[left] ${checked ? 'left-7' : 'left-1'}`} />
      </span>
    </button>
  );
}

function Section({ id, title, help, children }: { id: string; title: string; help?: HelpKey; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-6 flex-col gap-4 rounded-section border border-line bg-panel p-6">
      <div className="flex items-center gap-2">
        <h2 id={`${id}-title`} className="font-display text-xl font-bold">
          {title}
        </h2>
        {help && <HelpButton helpKey={help} target={`#${id}`} />}
      </div>
      {children}
    </section>
  );
}

function ColorChoices() {
  const { prefs, setPrefs } = usePreferences();
  const lego = legoColor(prefs.legoColor);
  const [pickerOpen, setPickerOpen] = useState(() => !!lego);
  const style = effectiveColorStyle(prefs);
  return (
    <>
      <div className="flex flex-wrap gap-5" role="radiogroup" aria-label="Color">
        {ACCENT_IDS.map((id) => {
          const a = ACCENTS[id];
          const on = !lego && prefs.accent === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={a.label}
              onClick={() => setPrefs({ accent: id, legoColor: null })}
              className={`flex w-20 flex-col items-center gap-2 text-[13px] ${on ? 'font-bold text-ink' : 'font-semibold text-muted'}`}
            >
              <span
                className="h-11 w-11 rounded-full"
                style={{
                  background: a.main,
                  boxShadow: on ? `0 0 0 3px var(--panel), 0 0 0 5px ${a.main}` : undefined,
                }}
              />
              {a.label}
            </button>
          );
        })}
        <button
          type="button"
          aria-expanded={pickerOpen}
          aria-controls="lego-color-area"
          onClick={() => setPickerOpen((o) => !o)}
          data-testid="lego-color-toggle"
          className={`flex w-20 flex-col items-center gap-2 text-[13px] ${lego ? 'font-bold text-ink' : 'font-semibold text-muted'}`}
        >
          <span
            aria-hidden
            className="h-11 w-11 rounded-full"
            style={{
              background: lego ? lego.hex : 'conic-gradient(#B40000, #FAC80A, #00852B, #1E5AA8, #A06EB9, #B40000)',
              boxShadow: lego ? `0 0 0 3px var(--panel), 0 0 0 5px var(--accent)` : undefined,
            }}
          />
          {lego ? lego.lego : 'Any LEGO color'}
        </button>
      </div>
      {pickerOpen && (
        <div id="lego-color-area">
          <LegoColorPicker value={prefs.legoColor} onPick={(id) => setPrefs({ legoColor: id })} />
        </div>
      )}
      <div>
        <div id="color-style-label" className="flex items-center gap-2 text-[15px] font-semibold">
          How much color
          <HelpButton helpKey="settings.colorStyle" target='[role="radiogroup"][aria-labelledby="color-style-label"]' />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-labelledby="color-style-label">
        {COLOR_STYLE_CARDS.map((c) => {
          const on = style === c.id;
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`color-style-${c.id}`}
              onClick={() => setPrefs({ colorStyle: c.id, colorStyleChosen: true })}
              className={`flex min-h-11 flex-col gap-1 rounded-bubble bg-panel p-3 text-left ${on ? 'border-2 border-accent' : 'border border-border hover:border-muted'}`}
            >
              <span className="text-sm font-bold text-ink">{c.label}</span>
              <span className="text-[13px] leading-snug text-muted">{c.hint}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export function SettingsContent({ onClose }: { onClose?: () => void }) {
  const { startTour } = useTours();
  const { prefs, setPrefs, syncedToAccount } = usePreferences();
  const host = window.location.host;
  // Installing is for phones and tablets; computers use the site as it is.
  const mobile = useMemo(() => isMobileDevice(), []);

  return (
    <div className="flex flex-col gap-8 md:flex-row">
      <nav aria-label="Settings sections" className="flex shrink-0 flex-col gap-1 md:w-56">
        <h1 className="mb-4 font-display text-3xl font-bold">Settings</h1>
        <a href="#look" className="rounded-control border border-line bg-panel px-3 py-2.5 font-bold text-ink">
          Look and feel
        </a>
        <a href="#editing" className="rounded-control px-3 py-2.5 font-semibold text-muted hover:bg-soft">
          Editing
        </a>
        <a href="#help" className="rounded-control px-3 py-2.5 font-semibold text-muted hover:bg-soft">
          Help and tours
        </a>
        {mobile && (
          <a href="#install" className="rounded-control px-3 py-2.5 font-semibold text-muted hover:bg-soft">
            Install the app
          </a>
        )}
        {syncedToAccount && (
          <a href="#privacy" className="rounded-control px-3 py-2.5 font-semibold text-muted hover:bg-soft">
            Privacy
          </a>
        )}
        <a href="#account" className="rounded-control px-3 py-2.5 font-semibold text-muted hover:bg-soft">
          Account
        </a>
        <div
          className={`mt-6 flex flex-col gap-2 rounded-card p-3 text-[13px] leading-snug ${syncedToAccount ? 'bg-ok-soft text-ok' : 'bg-soft text-muted'}`}
          data-testid="settings-sync-note"
        >
          {syncedToAccount ? (
            <>
              <div className="flex items-center gap-1.5 font-bold">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                  <path d="M4 12a8 8 0 0114-5M20 12a8 8 0 01-14 5" />
                  <path d="M18 3v4h-4M6 21v-4h4" />
                </svg>
                Synced with {host}
                <HelpButton helpKey="settings.sync" target='[data-testid="settings-sync-note"]' />
              </div>
              <div>These settings follow your account, so they're the same wherever you sign in to {host}.</div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 font-bold">
                Saved in this browser
                <HelpButton helpKey="settings.sync" target='[data-testid="settings-sync-note"]' />
              </div>
              <div>Sign in to keep these settings with your account.</div>
            </>
          )}
        </div>
      </nav>

      <div className="flex min-w-0 grow flex-col gap-5">
        <Section id="look" title="Light or dark">
          <div className="grid grid-cols-3 gap-2 sm:gap-3.5" role="radiogroup" aria-label="Light or dark">
            {THEME_CARDS.map((t) => {
              const on = prefs.theme === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setPrefs({ theme: t.id })}
                  className={`flex flex-col gap-2.5 rounded-bubble bg-panel p-2.5 text-left ${on ? 'border-2 border-accent' : 'border border-border hover:border-muted'}`}
                >
                  <ThemePreview id={t.id} />
                  <span className="text-sm font-bold text-ink">{t.label}</span>
                </button>
              );
            })}
          </div>
        </Section>

        <Section id="color" title="Color" help="settings.color">
          <ColorChoices />
          <div className="flex items-center gap-2">
            <label className="flex min-h-11 items-center gap-3 text-[15px] font-semibold">
              <input
                type="checkbox"
                className="h-5 w-5 accent-accent"
                checked={prefs.largeText}
                onChange={(e) => setPrefs({ largeText: e.target.checked })}
              />
              Bigger text and buttons
            </label>
            <HelpButton helpKey="settings.largeText" />
          </div>
        </Section>

        <Section id="editing" title="Editing">
          <div className="flex flex-col gap-3">
            <StepPickers />
            <div>
              <div id="snap-strength-label" className="flex items-center gap-2 text-[15px] font-semibold">
                Snap strength
                <HelpButton helpKey="settings.connectionSnap" target='[role="radiogroup"][aria-labelledby="snap-strength-label"]' />
              </div>
              <div className="text-sm text-muted">How strongly a part you drag pulls onto a matching connection nearby.</div>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-labelledby="snap-strength-label">
              {SNAP_CHOICES.map((c) => {
                const on = (prefs.connectionSnap ?? DEFAULT_SNAP_STRENGTH) === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    data-testid={`snap-strength-${c.id}`}
                    onClick={() => setPrefs({ connectionSnap: c.id })}
                    className={`flex min-h-11 flex-col gap-1 rounded-bubble bg-panel p-3 text-left ${on ? 'border-2 border-accent' : 'border border-border hover:border-muted'}`}
                  >
                    <span className="text-sm font-bold text-ink">{c.label}</span>
                    <span className="text-[13px] leading-snug text-muted">{c.hint}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-sm text-muted">
              Tip: hold <kbd className="rounded border border-border px-1 font-sans text-xs">Alt</kbd> (
              <kbd className="rounded border border-border px-1 font-sans text-xs">⌥ Option</kbd> on a Mac) while dragging to
              place one part without snapping.
            </p>
            <SnapTraceRow />
          </div>
        </Section>

        <Section id="help" title="Help and tours">
          <div className="flex items-center justify-between gap-6">
            <div>
              <div className="flex items-center gap-2 text-[15px] font-semibold">
                Show help buttons
                <HelpButton helpKey="settings.helpIcons" target='[role="switch"][aria-label="Show help buttons"]' />
              </div>
              <div className="text-sm text-muted">The small round question marks next to panel titles and settings.</div>
            </div>
            <Switch label="Show help buttons" checked={prefs.helpIcons} onChange={(v) => setPrefs({ helpIcons: v })} />
          </div>
          <div className="flex items-center justify-between gap-6">
            <div>
              <div className="flex items-center gap-2 text-[15px] font-semibold">
                Tours
                <HelpButton helpKey="settings.tours" />
              </div>
              <div className="text-sm text-muted">
                {prefs.toursSeen.length === 0 ? "You haven't finished any tours yet." : `You've seen ${prefs.toursSeen.length === 1 ? 'one tour' : `${prefs.toursSeen.length} tours`}.`}
              </div>
            </div>
            <button
              type="button"
              disabled={prefs.toursSeen.length === 0}
              onClick={() => setPrefs({ toursSeen: [] })}
              className="h-10 shrink-0 rounded-control border border-border px-4 text-sm font-semibold hover:bg-soft disabled:opacity-50"
            >
              Show tours again
            </button>
          </div>
          <div role="group" aria-label="Take a tour" className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">Take a tour:</span>
            {toursFor(isPhoneScreen()).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  onClose?.();
                  startTour(t.id);
                }}
                className="h-10 rounded-control border border-border px-4 text-sm font-semibold hover:bg-soft"
              >
                {t.title}
                {prefs.toursSeen.includes(t.id) && <span className="sr-only"> (seen)</span>}
              </button>
            ))}
          </div>
        </Section>

        {mobile && (
          <Section id="install" title="Install the app">
            <InstallApp />
          </Section>
        )}

        {syncedToAccount && (
          <Section id="privacy" title="Privacy">
            <div className="flex items-center justify-between gap-6">
              <div>
                <div className="text-[15px] font-semibold">Show club admins when I was last active</div>
                <div className="text-sm text-muted">
                  The people who run your clubs see roughly when you last used the site (today, this week or this month) in the club’s
                  members list, never the exact time.
                </div>
              </div>
              <Switch
                label="Show club admins when I was last active"
                checked={prefs.shareLastActive !== false}
                onChange={(v) => setPrefs({ shareLastActive: v })}
              />
            </div>
          </Section>
        )}

        {syncedToAccount && (
          <Section id="email" title="Email">
            <div className="flex items-center justify-between gap-6">
              <div>
                <div className="text-[15px] font-semibold">Email me about requests to join</div>
                <div className="text-sm text-muted">
                  When someone asks to join a club where your roles let people in. The request also waits on the club’s People page.
                </div>
              </div>
              <Switch
                label="Email me about requests to join"
                checked={prefs.emailJoinRequests !== false}
                onChange={(v) => setPrefs({ emailJoinRequests: v })}
              />
            </div>
          </Section>
        )}

        <Section id="account" title="Account">
          {syncedToAccount ? (
            <p className="text-[15px] text-muted">
              Your name, sign-in methods and connected desktop apps are on your{' '}
              <Link to="/profile" onClick={onClose} className="font-semibold text-accent-text underline">
                profile page
              </Link>
              .
            </p>
          ) : (
            <p className="text-[15px] text-muted">
              <SignInLink onClick={onClose} className="font-semibold text-accent-text underline">
                Sign in
              </SignInLink>{' '}
              to keep your settings with your account.
            </p>
          )}
        </Section>
      </div>
    </div>
  );
}

/**
 * The hidden snap trace (editor/snapTrace.ts): /settings?snaptrace=1 turns
 * it on (=0 off). On, the editor records the last drag's frames and this
 * row copies them, to send in when snapping misbehaves.
 */
/**
 * The grid snap and rotation steps. The editor's toolbar has them too, but a
 * phone has no toolbar row, so this is where a phone sets them.
 */
function StepPickers() {
  const snap = useEditorStore((s) => s.snapStepStuds);
  const setSnap = useEditorStore((s) => s.setSnapStep);
  const rot = useEditorStore((s) => s.rotationStepDegrees);
  const setRot = useEditorStore((s) => s.setRotationStep);
  const select = 'min-h-11 rounded-control border border-border bg-panel px-3 text-[15px] text-ink';
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1">
        <span className="text-[15px] font-semibold">Grid snap</span>
        <span className="text-sm text-muted">Parts, rulers and labels land on a grid this many studs apart.</span>
        <select data-testid="settings-snap-step" value={snap} onChange={(e) => setSnap(parseFloat(e.target.value))} className={select}>
          {SNAP_STEPS.map((v) => (
            <option key={v} value={v}>
              {v === 0 ? 'Off' : v === 1 ? '1 stud' : `${v} studs`}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[15px] font-semibold">Turn step</span>
        <span className="text-sm text-muted">How far a part turns each time.</span>
        <select data-testid="settings-rotation-step" value={rot} onChange={(e) => setRot(parseFloat(e.target.value))} className={select}>
          {ROTATION_STEPS.map((v) => (
            <option key={v} value={v}>
              {v}°
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function SnapTraceRow() {
  const [on, setOn] = useState(() => {
    try {
      const want = new URLSearchParams(window.location.search).get('snaptrace');
      if (want === '1' || want === '0') setSnapTraceEnabled(want === '1');
    } catch {
      // No URL to read: keep what was set.
    }
    return snapTraceEnabled();
  });
  const [copied, setCopied] = useState(false);
  if (!on) return null;
  const frames = lastSnapTrace().length;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-control border border-dashed border-border p-3 text-sm" data-testid="snap-trace">
      <span className="text-muted">Snap trace is on: {frames === 0 ? 'drag a part to record one.' : `the last drag has ${frames} frames.`}</span>
      <button
        type="button"
        disabled={frames === 0}
        onClick={() => {
          void navigator.clipboard?.writeText(snapTraceText()).then(() => setCopied(true));
        }}
        className="h-9 rounded-control border border-border px-3 font-semibold hover:bg-soft disabled:opacity-50"
      >
        {copied ? 'Copied' : 'Copy snap trace'}
      </button>
      <button
        type="button"
        onClick={() => {
          setSnapTraceEnabled(false);
          setOn(false);
        }}
        className="h-9 rounded-control px-3 font-semibold text-muted hover:bg-soft"
      >
        Turn off
      </button>
    </div>
  );
}

/** Is there a page of this site to go back to? React Router numbers its own entries (`idx`). */
export function backWithinSite(state: unknown = window.history.state): boolean {
  const idx = (state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' && idx > 0;
}

/** /settings as its own page. */
export function SettingsPage() {
  const navigate = useNavigate();
  // /settings#look etc. (the header's Settings menu) opens at that section.
  useHashScroll();
  return (
    <div className="theme-page h-full overflow-y-auto bg-bg px-4 py-8 text-ink sm:px-16 sm:py-12">
      <div className="mx-auto max-w-5xl">
        <button
          type="button"
          // Back within this site; opened straight from a link (or after
          // another site in the same tab), Home instead of leaving.
          onClick={() => (backWithinSite() ? navigate(-1) : navigate('/'))}
          className="mb-6 text-sm font-semibold text-muted hover:text-ink"
        >
          ← Back
        </button>
        <SettingsContent />
      </div>
    </div>
  );
}

/** Settings over the editor, closed with Escape or the Close button. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Settings" className="relative max-h-full w-full max-w-5xl overflow-y-auto rounded-section bg-bg p-6 text-ink shadow-pop sm:p-10">
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 h-10 rounded-control border border-border bg-panel px-4 text-sm font-semibold hover:bg-soft"
        >
          Close
        </button>
        <SettingsContent onClose={onClose} />
      </div>
    </div>
  );
}

/** Install as an app on this phone, tablet or computer (pwa/install.ts). */
function InstallApp() {
  const state = useInstallState();
  const [declined, setDeclined] = useState(false);
  const lead = 'Open it from your home screen like any other app, full screen, without the browser bars.';
  if (state.kind === 'installed') {
    return (
      <p className="text-[15px] font-semibold text-ok" data-testid="install-state">
        ✓ Installed on this device.
      </p>
    );
  }
  if (state.kind === 'prompt') {
    return (
      <div className="flex items-center justify-between gap-6" data-testid="install-state">
        <div className="text-sm text-muted">{declined ? 'Not now. You can install it any time from here.' : lead}</div>
        <button
          type="button"
          onClick={() => void state.install().then((ok) => setDeclined(!ok))}
          className="h-10 shrink-0 rounded-control bg-accent px-4 text-sm font-bold text-accent-ink hover:bg-accent-hover"
        >
          Install app
        </button>
      </div>
    );
  }
  if (state.kind === 'ios') {
    return (
      <div className="flex flex-col gap-2 text-[15px]" data-testid="install-state">
        <p className="text-sm text-muted">{lead}</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            In Safari, tap <b>Share</b> (the square with an arrow).
          </li>
          <li>
            Choose <b>Add to Home Screen</b>, then <b>Add</b>.
          </li>
        </ol>
      </div>
    );
  }
  if (state.kind === 'firefox-android') {
    return (
      <div className="flex flex-col gap-2 text-[15px]" data-testid="install-state">
        <p className="text-sm text-muted">{lead}</p>
        <p>
          In Firefox, tap the <b>⋮</b> menu, then <b>Add app to Home screen</b> (on some versions, <b>Install</b>).
        </p>
      </div>
    );
  }
  if (state.kind === 'firefox-desktop') {
    return (
      <div className="flex flex-col gap-2 text-[15px]" data-testid="install-state">
        <p className="text-sm text-muted">
          Firefox on a computer doesn't install web apps. Keep it as a bookmark, or open this page in Chrome or Edge to install
          it. On a phone, Firefox can add it to the home screen.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 text-[15px]" data-testid="install-state">
      <p className="text-sm text-muted">{lead}</p>
      <p>
        Open your browser's menu and choose <b>Install app</b> or <b>Add to Home screen</b>. On a computer, Chrome and Edge show an
        install button at the end of the address bar.
      </p>
    </div>
  );
}
