import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Truck, ClipboardList, PackageMinus, FileSignature,
  ReceiptText, LogOut, ChevronLeft, ChevronRight, Menu, X, Sun, Moon,
} from 'lucide-react';
import { supabase, signOutLocal } from '@/lib/supabase';
import { useState, useEffect } from 'react';
import { BrixWordmark } from './BrixMark';
import { currentTheme, toggleTheme, type Theme } from '@/lib/theme';
import { useDistributor } from '@/lib/distributor';
import { AmberCallout } from './ui';

const navGroups: {
  label?: string;
  items: { path: string; icon: typeof Truck; label: string }[];
}[] = [
  { items: [{ path: '', icon: LayoutDashboard, label: 'Dashboard' }] },
  {
    label: 'Inventory',
    items: [
      { path: 'shipments', icon: Truck, label: 'Shipments' },
      { path: 'orders', icon: ClipboardList, label: 'Orders' },
      { path: 'depletions', icon: PackageMinus, label: 'Depletions' },
    ],
  },
  {
    label: 'Account',
    items: [
      { path: 'agreements', icon: FileSignature, label: 'Agreements' },
      { path: 'billing', icon: ReceiptText, label: 'Billing' },
    ],
  },
];

const tabItems = [
  { path: '', icon: LayoutDashboard, label: 'Home' },
  { path: 'shipments', icon: Truck, label: 'Shipments' },
  { path: 'orders', icon: ClipboardList, label: 'Orders' },
  { path: 'billing', icon: ReceiptText, label: 'Billing' },
];

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const { distributor, distributors, setActiveId } = useDistributor();

  const currentPath = location.pathname.replace(/^\/distributor\/?|^\//, '').replace(/^\//, '');

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null);
    });
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Follow the gateway waffle / other tabs' theme changes.
  useEffect(() => {
    const follow = () => setTheme(currentTheme());
    window.addEventListener('apbg:themechange', follow);
    window.addEventListener('storage', follow);
    return () => {
      window.removeEventListener('apbg:themechange', follow);
      window.removeEventListener('storage', follow);
    };
  }, []);

  async function handleLogout() {
    // Local-only: a global signOut would revoke the SHARED gateway token
    // chain (see supabase.ts).
    await signOutLocal();
    navigate('/');
  }

  function goTo(path: string) {
    navigate(path === '' ? '' : path);
    setDrawerOpen(false);
  }

  return (
    <div className="app-shell">
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
        <div className="topbar-brand" onClick={() => goTo('')} style={{ cursor: 'pointer' }}>
          <img className="app-logo-icon app-logo-icon--mobile" src="https://alamedapointbg.com/app-icons/distributor-light.png" alt="" />
          <div className="app-logo-copy">
            <strong>Bri<span className="app-logo-x">X</span> Vendor Portal</strong>
            <span>Inventory & orders</span>
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
        <div className="brand" onClick={() => goTo('')} style={{ cursor: 'pointer' }}>
          <img className="app-logo-icon" src="https://alamedapointbg.com/app-icons/distributor-light.png" alt="" />
          {!collapsed && (
            <div className="brand-text app-logo-copy">
              <strong>Bri<span className="app-logo-x">X</span> Vendor Portal</strong>
              <span>Inventory & orders</span>
            </div>
          )}
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

        {/* Who you're acting as. Switcher only shows for multi-membership logins. */}
        {distributor && (
          <div className="dist-chip">
            <div className="dist-chip-label">Distributor</div>
            {distributors.length > 1 ? (
              <select
                value={distributor.id}
                onChange={(e) => setActiveId(e.target.value)}
                aria-label="Switch distributor"
              >
                {distributors.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            ) : (
              <div className="dist-chip-name">{distributor.name}</div>
            )}
          </div>
        )}

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
          {!collapsed && (
            <div className="parent-brand" aria-label="Brix Beverage, an APBG company">
              <BrixWordmark style={{ fontSize: 14 }} />
              <span>an APBG company</span>
            </div>
          )}
          {!collapsed && userEmail && (
            <span className="sidebar-email" title={userEmail}>{userEmail}</span>
          )}
          <button
            type="button"
            onClick={() => setTheme(toggleTheme())}
            className="nav-item"
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
          </button>
          <button type="button" onClick={handleLogout} className="nav-item" title="Sign out">
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
        {distributor?.status === 'pending' && (
          <AmberCallout>
            <strong>Account pending activation.</strong> Your Brix Beverage rep is
            finishing setup — you can browse, but some data may not be live yet.
          </AmberCallout>
        )}
        <Outlet />
      </main>

      {/* Mobile bottom tab bar */}
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
    </div>
  );
}
