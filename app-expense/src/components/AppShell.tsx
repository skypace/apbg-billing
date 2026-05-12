import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Receipt, Clock, Users, LogOut, ChevronLeft, ChevronRight } from 'lucide-react';
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
  const [userEmail, setUserEmail] = useState<string | null>(null);

  const currentPath = location.pathname.replace(/^\/expense\/?/, '');

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null);
    });
  }, []);

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate('/');
  }

  return (
    <div className="app-shell">
      {/* ── Sidebar ── */}
      <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
        {/* Brand */}
        <div className="brand" onClick={() => navigate('')} style={{ cursor: 'pointer' }}>
          <BrixMark size={32} />
          {!collapsed && (
            <div className="brand-text">
              <BrixWordmark />
              <span className="brand-sub">Expense</span>
            </div>
          )}
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
                onClick={() => navigate(item.path === '' ? '' : item.path)}
                className={`nav-item${isActive ? ' active' : ''}`}
                title={collapsed ? item.label : undefined}
              >
                <item.icon size={18} />
                {!collapsed && <span>{item.label}</span>}
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
          <button onClick={handleLogout} className="nav-item" title="Sign out">
            <LogOut size={18} />
            {!collapsed && <span>Sign Out</span>}
          </button>
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="nav-item collapse-toggle"
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
            {!collapsed && <span>Collapse</span>}
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
