import { useEffect, useState, type ReactNode } from 'react';
import type { View } from '../lib/router';
import {
  LayoutDashboard, TrendingUp, Activity, Users, FileText, CalendarRange,
  GitCompareArrows, Package, Warehouse, Factory, Settings as SettingsIcon, LogOut,
  BookOpen, Tags, Sun, Moon, Presentation, Handshake,
  PanelLeftClose, PanelLeftOpen,
  type LucideIcon,
} from 'lucide-react';
import { REFRACTOR_MENUS } from '../lib/appMenus';
import { AlamedaMark, BrixMark } from './BrixMark';
import { useThemeMode } from '../lib/themeMode';

interface NavItem { id: View; label: string; icon: LucideIcon }

// Fleet moved to apbg-ops.netlify.app — removed from BRIX nav.
//
// Inventory naming (per operator request 2026-05):
//   - "Inventory" (route #stock) = operational view: on-hand, locations,
//     purchase orders, transfers, adjustments, movements. The view that
//     answers "where is it and what's coming in."
//   - "Inventory Planning" (route #inventory) = analytics view: reorder,
//     velocity, velocity excludes. The view that answers "what to buy
//     and when."
// Route hashes are unchanged so deep links keep working — only labels
// were swapped.
//
// ⚠ The ids and labels moved to lib/appMenus.ts, because the gateway's
// per-user visibility picker must offer exactly this list. One source of
// truth, pinned by tests/refractor-menus.test.mjs. Only icons live here.
const ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  margin: TrendingUp,
  customers: Users,
  reports: FileText,
  plans: CalendarRange,
  compare: GitCompareArrows,
  stock: Warehouse,
  inventory: Package,
  production: Factory,
  distributors: Handshake,
  pricing: Tags,
  'proposal-builder': Presentation,
  settings: SettingsIcon,
};

const NAV: NavItem[] = REFRACTOR_MENUS.map((m) => ({
  id: m.id as View,
  label: m.label,
  icon: ICONS[m.id] ?? LayoutDashboard,
}));

// Interactive user guide — markdown source at docs/margin-control/user-guide.md,
// viewer at public/docs/margin-control/index.html, surfaced through the gateway
// at /margin/docs/margin-control/. Absolute URL so the link is correct from
// any deploy context (prod gateway / staging subdomain / local dev).
const USER_GUIDE_URL = 'https://alamedapointbg.com/margin/docs/margin-control/';

interface LayoutProps {
  current: View;
  onNav: (v: View) => void;
  userEmail?: string | null;
  onLogout: () => void;
  /**
   * Menu ids this user may NOT see, from the gateway's per-user grant
   * (lib/appMenus.ts). Undefined while the grant is still loading and empty
   * for a superadmin — both render the full sidebar, which is the right
   * default: a brief flash of a link someone cannot open is a far smaller
   * problem than hiding the whole app from everyone if the lookup is slow.
   * App.tsx guards the ROUTE, so a link is never the only control.
   */
  hiddenMenus?: Set<string>;
  children: ReactNode;
}

const COLLAPSE_KEY = 'brix.sidebar.collapsed';

export function Layout({ current, onNav, userEmail, onLogout, hiddenMenus, children }: LayoutProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { mode, toggleMode } = useThemeMode();

  useEffect(() => {
    try { setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1'); } catch { /* no-op */ }
  }, []);

  function toggleCollapse() {
    const next = !collapsed;
    setCollapsed(next);
    try { window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* no-op */ }
  }

  return (
    <div className="app-shell">
      <aside
        className={'sidebar' + (collapsed ? ' sidebar--collapsed' : '')}
        aria-label="Primary navigation"
      >
        <button
          type="button"
          className="sidebar-toggle"
          onClick={toggleCollapse}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed
            ? <PanelLeftOpen size={13} strokeWidth={2.2} aria-hidden="true" />
            : <PanelLeftClose size={13} strokeWidth={2.2} aria-hidden="true" />}
        </button>

        <div className="brand">
          <img
            className="brand-mark-svg brand-app-icon"
            src="https://alamedapointbg.com/app-icons/refractor-light.png"
            alt=""
          />
          <div className="brand-app-copy">
            <div className="brand-mark">Brix Refractor</div>
            <div className="brand-sub">Margin intelligence</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.filter((n) => !hiddenMenus?.has(n.id)).map((n) => {
            const Icon = n.icon;
            const on = current === n.id;
            return (
              <a
                key={n.id}
                href={n.id === 'proposal-builder' ? '#/proposal-builder' : '#' + n.id}
                onClick={(e) => { e.preventDefault(); onNav(n.id); }}
                className={'nav-item' + (on ? ' nav-item--active' : '')}
                aria-current={on ? 'page' : undefined}
                title={collapsed ? n.label : undefined}
              >
                <Icon size={16} strokeWidth={2} aria-hidden="true" />
                <span>{n.label}</span>
              </a>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          {!collapsed && (
            <div className="sidebar-group" title="Alameda Beverage Group LLC">
              <BrixMark size={14} />
              <AlamedaMark size={16} variant="seal" />
              <span>by Alameda Beverage Group</span>
            </div>
          )}
          {userEmail && <div className="user-email" title={userEmail}>{userEmail}</div>}
          <button
            type="button"
            onClick={toggleMode}
            className="sign-out theme-toggle"
            title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {mode === 'dark'
              ? <Sun size={13} strokeWidth={2} aria-hidden="true" />
              : <Moon size={13} strokeWidth={2} aria-hidden="true" />}
            <span>{mode === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>
          <a
            href={USER_GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="sign-out help-link"
            title="Open the BRIX Refractor user guide in a new tab"
          >
            <BookOpen size={13} strokeWidth={2} aria-hidden="true" />
            <span>User Guide</span>
          </a>
          <button onClick={onLogout} className="sign-out" type="button" title="Sign out">
            <LogOut size={13} strokeWidth={2} aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
