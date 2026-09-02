import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Banknote, BookOpen, Building2, ChevronLeft, ChevronRight, Clock, FileSpreadsheet, FileText, Inbox, LogOut, Mail, Menu, Moon, Receipt, Settings as SettingsIcon, Sun, TrendingUp, Users, Wand2, Wrench, X } from 'lucide-react';
import { supabase, signOutLocal } from '@/lib/supabase';
import { useState, useEffect } from 'react';
import { BrixMark, BrixWordmark } from './BrixMark';
import { currentTheme, toggleTheme, type Theme } from '@/lib/theme';
import { useExpenseRole } from '@/lib/useExpenseRole';

const navGroups: {
  label?: string;
  items: { path: string; icon: typeof Receipt; label: string; staffOnly?: boolean; apOnly?: boolean }[];
  /** Only rendered for gateway superadmin/admin roles (the first role-aware
   *  nav group — role fetched once below; RLS is the real gate). */
  staffOnly?: boolean;
  /** Accounts-payable surfaces: the whole company's payables, not yours.
   *  Driven by ops.expense_people.ap_admin — NOT the gateway role, which every
   *  staff login here holds. */
  apOnly?: boolean;
}[] = [
  { items: [{ path: '', icon: Receipt, label: 'Dashboard' }] },
  {
    // Your own three surfaces, in the order you work them: what needs you,
    // what came off a job, what you've already filed.
    label: 'Expenses',
    items: [
      { path: 'inbox', icon: Inbox, label: 'My Inbox' },
      // Vendor bills off Service Fusion jobs — the company's payables, not
      // anybody's own expenses, so AP only.
      { path: 'sf-expenses', icon: Wrench, label: 'Service Fusion', apOnly: true },
      { path: 'pending', icon: Clock, label: 'Expense History' },
    ],
  },
  {
    label: 'Approvals',
    items: [
      { path: 'queue', icon: Users, label: 'Approvals' },
      { path: 'third-party', icon: FileText, label: '3rd Party Bills' },
    ],
  },
  {
    // The whole company's payables. This group used to be open to everyone in
    // Brixpense, which on a project where every staff login is a gateway
    // superadmin meant everyone saw every vendor bill. It now follows
    // ops.expense_people.ap_admin, the same row requireApAdmin() and the RLS
    // read — this list only decides what the sidebar shows.
    label: 'Accounts payable',
    apOnly: true,
    items: [
      { path: 'bills', icon: Mail, label: 'Vendor Inbox' },
      // Pay run: money out is superadmin-only server side — staff nav only
      // hides a button the API would 403 anyway.
      { path: 'pay-run', icon: Banknote, label: 'Pay Bills', staffOnly: true },
      // Spend trends off the QBO mirror — vendor amounts are staff data on
      // the shared project; the RPCs are staff-gated server side.
      { path: 'spending', icon: TrendingUp, label: 'Spending', staffOnly: true },
      { path: 'reports', icon: BookOpen, label: 'Expense Reports' },
    ],
  },
  {
    label: 'Vendors',
    staffOnly: true,
    items: [
      { path: 'vendors', icon: Building2, label: 'Vendors' },
      { path: 'rules', icon: Wand2, label: 'Bill Rules' },
      { path: 'tax-1099', icon: FileSpreadsheet, label: '1099s' },
    ],
  },
  {
    label: 'Account',
    items: [{ path: 'settings', icon: SettingsIcon, label: 'Settings' }],
  },
];
// Card Connection Services (route 'cards') deliberately has NO sidebar entry —
// it's superadmin-only and reachable from Settings → Card Connection Services.

// Primary destinations for the mobile bottom tab bar.
//
// Four slots, so they have to be the four things someone reaches for on a
// phone — not a miniature of the sidebar. My Inbox replaced Approvals here
// because it ALREADY CONTAINS the approvals waiting on you (its "Waiting on
// you" bucket) plus everything else that needs you, so the old Approvals tab
// was a strict subset of it. Vendor Inbox earns a slot because forwarding a
// bill and then checking it landed is a phone-shaped task.
const tabItems = [
  { path: '', icon: Receipt, label: 'Home' },
  { path: 'inbox', icon: Inbox, label: 'Inbox' },
  { path: 'bills', icon: Mail, label: 'Bills' },
  { path: 'pending', icon: Clock, label: 'History' },
];

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isStaff, setIsStaff] = useState(false);
  const role = useExpenseRole();
  const [theme, setTheme] = useState<Theme>(() => currentTheme());

  const currentPath = location.pathname.replace(/^\/expense\/?/, '');

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null);
      const role =
        (data.user?.app_metadata as { role?: string } | undefined)?.role ||
        (data.user?.user_metadata as { role?: string } | undefined)?.role ||
        '';
      setIsStaff(role === 'superadmin' || role === 'admin');
    });
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // The gateway waffle (appswitcher.js) and other tabs can change the theme
  // out from under us — the pre-paint script re-applies the classes, but this
  // component's Sun/Moon icon state must follow too or it renders inverted.
  useEffect(() => {
    const follow = () => setTheme(currentTheme());
    window.addEventListener('apbg:themechange', follow);
    window.addEventListener('storage', follow);
    return () => {
      window.removeEventListener('apbg:themechange', follow);
      window.removeEventListener('storage', follow);
    };
  }, []);

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
    // Local-only: a global signOut would revoke the SHARED gateway token
    // chain and kill the hub + every other APBG app/device (see supabase.ts).
    await signOutLocal();
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
        <div role="status" className="install-nudge">
          <span className="install-nudge-icon" aria-hidden>📲</span>
          <span className="install-nudge-copy">
            {isIOS
              ? <>Add Brixpense to your home screen: tap <b>Share</b> then <b>&ldquo;Add to Home Screen&rdquo;</b>.</>
              : <>Install Brixpense on your phone for one-tap expense capture.</>}
          </span>
          {!isIOS && installEvt && (
            <button
              type="button"
              onClick={triggerInstall}
              className="install-nudge-action"
            >
              Install
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismissInstallNudge}
            className="install-nudge-close"
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
          <img className="app-logo-icon app-logo-icon--mobile" src="https://alamedapointbg.com/app-icons/brixpense-light.png" alt="" />
          <div className="app-logo-copy">
            <BrixWordmark />
            <span>Expenses & approvals</span>
          </div>
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
          <img className="app-logo-icon" src="https://alamedapointbg.com/app-icons/brixpense-light.png" alt="" />
          {!collapsed && (
            <div className="brand-text app-logo-copy">
              <BrixWordmark />
              <span>Expenses & approvals</span>
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
          {navGroups
            .filter((g) => (!g.staffOnly || isStaff) && (!g.apOnly || role.apAdmin))
            .map((group, gi) => (
            <div key={group.label ?? `g${gi}`}>
              {group.label && !collapsed && (
                <div className="nav-section">{group.label}</div>
              )}
              {group.items
                .filter((item) => (!item.staffOnly || isStaff) && (!item.apOnly || role.apAdmin))
                .map((item) => {
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
          {!collapsed && (
            <div className="parent-brand" aria-label="Brix Beverage, an APBG company">
              <BrixMark size={20} />
              <span>Brix Beverage · APBG</span>
            </div>
          )}
          {!collapsed && userEmail && (
            <span className="sidebar-email" title={userEmail}>
              {userEmail}
            </span>
          )}
          <a
            href="https://alamedapointbg.com/margin/docs/handbook/#/07-brixpense"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-item"
            title="Brixpense chapter in the APBG Master Handbook (links to the full deep guide)"
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
