import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Receipt, Clock, Users, LogOut,
  ChevronLeft, ChevronRight,
  Menu, X,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useState, useEffect } from 'react';
import { BrixMark, BrixWordmark } from './BrixMark';

const navItems = [
  { path: '',        icon: Receipt, label: 'Dashboard' },
  { path: 'pending', icon: Clock,   label: 'My Pending' },
  { path: 'queue',   icon: Users,   label: 'Approvals' },
];

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  const currentPath = location.pathname.replace(/^\/expense\/?/, '');

  // Load user email
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null);
    });
  }, []);

  // Close drawer on route change (mobile)
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

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
      {/* ── Mobile top bar ── */}
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
          <BrixMark size={28} />
          <span>Brixpense</span>
        </div>
        <span style={{ width: 40 }} aria-hidden /> {/* spacer to center brand */}
      </header>

      {/* ── Drawer backdrop (mobile only when open) ── */}
      <div
        className={`drawer-backdrop${drawerOpen ? ' open' : ''}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden
      />

      {/* ── Sidebar ── */}
      <aside
        className={[
          'sidebar',
          collapsed ? 'collapsed' : '',
          drawerOpen ? 'drawer-open' : '',
        ].filter(Boolean).join(' ')}
      >
        {/* Brand */}
        <div
          className="brand"
          onClick={() => goTo('')}
          style={{ cursor: 'pointer' }}
        >
          <BrixMark size={32} />
          {!collapsed && (
            <div className="brand-text">
              <BrixWordmark />
              <span className="brand-sub">Expense</span>
            </div>
          )}
          {/* Mobile-only close button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setDrawerOpen(false);
            }}
            className="topbar-icon-btn"
            aria-label="Close menu"
            style={{ marginLeft: 'auto' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Nav */}
        <nav className="nav">
          {navItems.map((item) => {
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
        </nav>

        {/* Footer */}
        <div className="sidebar-footer">
          {!collapsed && userEmail && (
            <span className="sidebar-email" title={userEmail}>
              {userEmail}
            </span>
          )}
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

      {/* ── Main content ── */}
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
