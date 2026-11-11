import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveUpdates } from './live/LiveUpdates';
import { NoticeBanner, NoticesPage } from './notices/Notices';
import { RefusedCopies } from './editor/RefusedCopies';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { PARTS_SECTION } from './parts/CustomPartsSection';
import { TourProvider } from './tours/TourProvider';
import { App } from './App';
import { listenForInstall, reportDisplayMode } from './pwa/install';
import { watchKeyboard } from './pwa/keyboard';
import { LoginPage } from './auth/LoginPage';
import { ProfilePage } from './auth/ProfilePage';
import { LinkPage } from './auth/LinkPage';
import { InvitePage } from './auth/InvitePage';
import { ModuleInvitePage } from './auth/ModuleInvitePage';
import { PartInvitePage } from './auth/PartInvitePage';
import { VerifyEmailPage } from './auth/VerifyEmailPage';
import { ResetPasswordPage } from './auth/ResetPasswordPage';
import { DevicePage } from './auth/DevicePage';
import { OrgsPage } from './orgs/OrgsPage';
import { OrgDetailPage } from './orgs/OrgDetailPage';
// Not lazy: the layouts and club pages show collections, so the catalog is
// in the main bundle anyway (a lazy import of it would split nothing).
import { CatalogPage } from './catalog/CatalogPage';
import { CollectionPage } from './catalog/Collections';
import { OrgInvitePage } from './orgs/OrgInvitePage';
import { TransferPage } from './layouts/TransferPage';
import { AboutPage } from './AboutPage';
import { NotFoundPage } from './NotFoundPage';
import { PrivacyPage } from './privacy/PrivacyPage';
import { SiteVersionBar } from './SiteVersionBar';
import { DemoBanner } from './demo/DemoBanner';
import { DemoResetNotice } from './demo/DemoResetNotice';
import { NamePrompt } from './auth/NamePrompt';
import { CollectionToastHost } from './catalog/collectionToast';
import { ConfirmDialogHost, ToastHost } from './ui/ConfirmDialog';
import { ServerRestartNote } from './ui/ServerRestartNote';
import { HelpPage } from './help/HelpPage';
import { SettingsPage } from './settings/SettingsPage';
import { PrefsProvider } from './theme/PrefsProvider';
import { FileOpener } from './open/FileOpener';
import { installModalFocus } from './ui/modalFocus';
import './styles.css';

// Heavy routes are code-split so the landing / auth pages don't download
// the editor (Konva, Yjs, parts rendering) or the admin console.
const EditorPage = lazy(() => import('./editor/EditorPage').then((m) => ({ default: m.EditorPage })));
const ModuleEditorPage = lazy(() => import('./editor/EditorPage').then((m) => ({ default: m.ModuleEditorPage })));
const AdminPage = lazy(() => import('./admin/AdminPage').then((m) => ({ default: m.AdminPage })));
const OrgAdminPage = lazy(() => import('./orgs/OrgAdminPage').then((m) => ({ default: m.OrgAdminPage })));
const NewVenuePage = lazy(() => import('./venues/designer/VenueDesignerPage').then((m) => ({ default: m.NewVenuePage })));
const VenueDesignPage = lazy(() => import('./venues/designer/VenueDesignerPage').then((m) => ({ default: m.VenueDesignPage })));
const CatalogItemPage = lazy(() => import('./catalog/CatalogItemPage').then((m) => ({ default: m.CatalogItemPage })));
const PublicLayoutPage = lazy(() => import('./layouts/PublicLayoutPage').then((m) => ({ default: m.PublicLayoutPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
    // Run a change even when the browser says it's offline: by default a
    // mutation waits (paused) for the network, so a dialog that edits the
    // layout first and talks to the server second sat on "Saving…" forever.
    // The layout edit happens at once; a request that can't get through
    // fails with a plain "You're offline" (api.ts).
    mutations: { networkMode: 'always' },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

// Catch the browser's install offer early; Settings shows it.
listenForInstall();
// Keep dialogs and the focused field above the on-screen keyboard.
watchKeyboard();
// Installed app or browser tab, for the admin dashboard's counts.
reportDisplayMode();
// Dialogs take the focus, keep Tab inside, and hand it back when they close.
installModalFocus();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LiveUpdates />
      <PrefsProvider>
      <BrowserRouter>
        <FileOpener />
        <SiteVersionBar />
        <NoticeBanner />
        <RefusedCopies />
        <DemoBanner />
        <DemoResetNotice />
        <NamePrompt />
        <CollectionToastHost />
        <ConfirmDialogHost />
        <ToastHost />
        <ServerRestartNote />
        <TourProvider>
        <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/link" element={<LinkPage />} />
          <Route path="/device" element={<DevicePage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route path="/module-invite/:token" element={<ModuleInvitePage />} />
          <Route path="/part-invite/:token" element={<PartInvitePage />} />
          <Route path="/verify-email/:token" element={<VerifyEmailPage />} />
          <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
          <Route path="/transfer/:token" element={<TransferPage />} />
          <Route path="/org-invite/:token" element={<OrgInvitePage />} />
          <Route path="/orgs" element={<OrgsPage />} />
          <Route path="/orgs/:slug" element={<OrgDetailPage />} />
          <Route path="/orgs/:slug/admin" element={<OrgAdminPage />} />
          {/* The Library page's custom parts now live on the home page. */}
          <Route path="/library" element={<Navigate to={PARTS_SECTION} replace />} />
          <Route path="/editor/:id" element={<EditorPage />} />
          <Route path="/modules/:id" element={<ModuleEditorPage />} />
          <Route path="/catalog" element={<CatalogPage />} />
          <Route path="/catalog/collections/:id" element={<CollectionPage />} />
          <Route path="/catalog/items/:id" element={<CatalogItemPage />} />
          <Route path="/venues/new" element={<NewVenuePage />} />
          <Route path="/venues/:id/design" element={<VenueDesignPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/notices" element={<NoticesPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/p/:token" element={<PublicLayoutPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        </Suspense>
        </TourProvider>
      </BrowserRouter>
      </PrefsProvider>
    </QueryClientProvider>
  </StrictMode>,
);
