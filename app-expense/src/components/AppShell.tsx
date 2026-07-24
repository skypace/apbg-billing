import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Receipt, Clock, Users, LogOut, Inbox, Settings as SettingsIcon,
  ChevronLeft, ChevronRight,
  Menu, X, BookOpen, Sun, Moon, Wrench,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useState, useEffect } from 'react';
import { BrixMark, BrixWordmark } from './BrixMark';
import { currentTheme, toggleTheme, type Theme } from '@/lib/theme';

const navGroups: {
  label?: string;
  items: { path: string; icon: typeof Receipt; label: string }[];
}[] = [
  { items: [{ path: '', icon: Receipt, label: 'Dashboard' }] },
  {
    label: 'Expenses',
    items: [
      { path: 'pending', icon: Clock, label: 'Previous Expenses' },
      { path: 'sf-expenses', icon: Wrench, label: 'SF Expenses' },
    ],
  },
  {
    label: 'Approvals',
    items: [
      { path: 'queue', icon: Users, label: 'Approvals' },
      { path: 'third-party', icon: Inbox, label: '3rd Party Bills' },
    ],
  },
  {
    label: 'Account',
    items: [{ path: 'settings', icon: SettingsIcon, label: 'Settings' }],
  },
];

// Primary destinations for the mobile bottom tab bar.
const tabItems = [
  { path: '', icon: Receipt, label: 'Home' },
  { path: 'pending', icon: Clock, label: 'Expenses' },
  { path: 'queue', icon: Users, label: 'Approvals' },
  { path: 'settings', icon: SettingsIcon, label: 'Settings' },
];

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => currentTheme());

  const currentPath = location.pathname.replace(/^\/expense\/?/, '');

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null);
    });
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // One-time "Add to Home Screen" nudge (mobile only). Android/Chrome fires
  // beforeinstallprompt — we stash it and show a real Install button. iOS has
  // no install API, so Safari gets the Share → Add to Home Screen hint.
  // Dismiss (or install) sets a localStorage flag and it never shows again.
  // Never shows when already running installed (standalone display mode).
  const [installEvt, setInstallEvt] = useState<Event | null>(null);
  const [showInstallNudge, setShowInstallNudge] = useState(false);
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  useEffect(() => {
    const dismissed = localStorage.getItem('brixpense_install_nudge_v1');
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || (navigator as unknown as { standalone?: boolean }).standalone === true;
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (dismissed || standalone || !isMobile) return;
    const onPrompt = (e: Event) => { e.preventDefault(); setInstallEvt(e); setShowInstallNudge(true); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    // iOS never fires the event — show the manual hint after a short delay.
    const iosTimer = isIOS ? window.setTimeout(() => setShowInstallNudge(true), 2500) : 0;
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); if (iosTimer) clearTimeout(iosTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function dismissInstallNudge() {
    localStorage.setItem('brixpense_install_nudge_v1', 'dismissed');
    setShowInstallNudge(false);
  }
  async function triggerInstall() {
    const evt = installEvt as unknown as { prompt?: () => Promise<void> } | null;
    if (evt?.prompt) { try { await evt.prompt(); } catch { /* user dismissed */ } }
    dismissInstallNudge();
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate('/');
  }

  function goTo(path: string) {
    navigate(path === '' ? '' : path);
    setDrawerOpen(false);
  }

  return (
    <div className="app-shell">
      {/* One-time Add-to-Home-Screen nudge (mobile only) */}
      {showInstallNudge && (
        <div
          role="status"
          style={{
            position: 'fixed', left: 12, right: 12, bottom: 76, zIndex: 60,
            background: 'var(--card, #0F172A)', border: '1px solid rgba(59,130,246,.4)',
            borderRadius: 12, padding: '12px 14px', display: 'flex', alignItems: 'center',
            gap: 10, boxShadow: '0 8px 24px rgba(0,0,0,.35)',
          }}
        >
          <span style={{ fontSize: 20 }} aria-hidden>📲</span>
          <span style={{ flex: 1, fontSize: 13, lineHeight: 1.4 }}>
            {isIOS
              ? <>Add Brixpense to your home screen: tap <b>Share</b> then <b>&ldquo;Add to Home Screen&rdquo;</b>.</>
              : <>Install Brixpense on your phone for one-tap expense capture.</>}
          </span>
          {!isIOS && installEvt && (
            <button
              type="button"
              onClick={triggerInstall}
              style={{ background: '#3B82F6', color: '#fff', border: 0, borderRadius: 8, padding: '7px 12px', fontSize: 13, fontWeight: 600 }}
            >
              Install
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismissInstallNudge}
            style={{ background: 'transparent', border: 0, color: 'inherit', opacity: .6, padding: 4 }}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Mobile top bar */}
      <header className="topbar">
        <button
          type="button"
          className="topbar-icon-btn"
          aria-label="Open menu"
          onClick={() => setDrawerOpen(true)}
        >
          <Menu size={22} />
        </button>
        <div
          className="topbar-brand"
          onClick={() => goTo('')}
          style={{ cursor: 'pointer' }}
        >
          <BrixMark size={56} />
          <BrixWordmark />
        </div>
        <span style={{ width: 40 }} aria-hidden />
      </header>

      {/* Drawer backdrop */}
      <div
        className={`drawer-backdrop${drawerOpen ? ' open' : ''}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden
      />

      {/* Sidebar */}
      <aside
        className={[
          'sidebar',
          collapsed ? 'collapsed' : '',
          drawerOpen ? 'drawer-open' : '',
        ].filter(Boolean).join(' ')}
      >
        <div
          className="brand"
          onClick={() => goTo('')}
          style={{ cursor: 'pointer' }}
        >
          <BrixMark size={72} />
          {!collapsed && (
            <div className="brand-text">
              <BrixWordmark />
            </div>
          )}
          {/* Mobile-only close button — only shown when drawer is open on small screens */}
          {drawerOpen && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDrawerOpen(false);
              }}
              className="topbar-icon-btn drawer-close-btn"
              aria-label="Close menu"
              style={{ marginLeft: 'auto' }}
            >
              <X size={20} />
            </button>
          )}
        </div>

        <nav className="nav">
          {navGroups.map((group, gi) => (
            <div key={group.label ?? `g${gi}`}>
              {group.label && !collapsed && (
                <div className="nav-section">{group.label}</div>
              )}
              {group.items.map((item) => {
                const isActive =
                  item.path === ''
                    ? currentPath === '' || currentPath === '/'
                    : currentPath.startsWith(item.path);
                return (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => goTo(item.path)}
                    className={`nav-item${isActive ? ' active' : ''}`}
                    title={collapsed ? item.label : undefined}
                  >
                    <item.icon size={18} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          {!collapsed && userEmail && (
            <span className="sidebar-email" title={userEmail}>
              {userEmail}
            </span>
          )}
          <a
            href="/expense/docs/brixpense/"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-item"
            title="User guide"
            style={{ textDecoration: 'none' }}
          >
            <BookOpen size={18} />
            <span>User Guide</span>
          </a>
          <button
            type="button"
            onClick={() => setTheme(toggleTheme())}
            className="nav-item"
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="nav-item"
            title="Sign out"
          >
            <LogOut size={18} />
            <span>Sign Out</span>
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="nav-item collapse-toggle"
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
            <span>Collapse</span>
          </button>
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>

      {/* iOS-style bottom tab bar (mobile only). Hidden on full-screen
          form/review flows so it doesn't compete with the submit bar. */}
      {!['new', 'new-pr', 'edit', 'review'].some((p) => currentPath.startsWith(p)) && (
        <nav className="mobile-tabbar">
          {tabItems.map((item) => {
            const isActive =
              item.path === ''
                ? currentPath === '' || currentPath === '/'
                : currentPath.startsWith(item.path);
            return (
              <button
                key={item.path}
                type="button"
                onClick={() => goTo(item.path)}
                className={`mobile-tab${isActive ? ' active' : ''}`}
              >
                <item.icon size={22} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
