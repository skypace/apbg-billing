import { useEffect, useState, type ReactNode } from 'react';
import type { View } from '../lib/router';
import {
  LayoutDashboard,
  TrendingUp,
  Activity,
  Users,
  FileText,
  CalendarRange,
  GitCompareArrows,
  Package,
  Settings as SettingsIcon,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from 'lucide-react';
import { BrixMark } from './BrixMark';

interface NavItem { id: View; label: string; icon: LucideIcon }

const NAV: NavItem[] = [
  { id: 'overview',   label: 'Overview',   icon: LayoutDashboard   },
  { id: 'margin',     label: 'Margin',     icon: TrendingUp        },
  { id: 'operations', label: 'Operations', icon: Activity          },
  { id: 'customers',  label: 'Customers',  icon: Users             },
  { id: 'reports',    label: 'Reports',    icon: FileText          },
  { id: 'plans',      label: 'Plans',      icon: CalendarRange     },
  { id: 'compare',    label: 'Compare',    icon: GitCompareArrows  },
  { id: 'inventory',  label: 'Inventory',  icon: Package           },
  { id: 'settings',   label: 'Settings',   icon: SettingsIcon      },
];

interface LayoutProps {
  current: View;
  onNav: (v: View) => void;
  userEmail?: string | null;
  onLogout: () => void;
  children: ReactNode;
}

const COLLAPSE_KEY = 'brix.sidebar.collapsed';

export function Layout({ current, onNav, userEmail, onLogout, children }: LayoutProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  return (
    <div className="app-shell">
      <aside
        className={'sidebar' + (collapsed ? ' sidebar--collapsed' : '')}
        aria-label="Primary navigation"
      >
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed
            ? <PanelLeftOpen  size={12} strokeWidth={2.4} />
            : <PanelLeftClose size={12} strokeWidth={2.4} />}
        </button>

        <div className="brand">
          <BrixMark size={collapsed ? 32 : 38} className="brand-mark-svg" title="Brix Beverage" />
          {!collapsed && (
            <div>
              <div className="brand-mark">BRI<span className="brand-bx">X</span></div>
              <div className="brand-sub">
                <span className="status-dot" aria-hidden="true" />
                Margin Control
              </div>
            </div>
          )}
        </div>
        <nav className="nav">
          {NAV.map((n) => {
            const Icon = n.icon;
            const on = current === n.id;
            return (
              <a
                key={n.id}
                href={'#' + n.id}
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
          {userEmail && !collapsed && <div className="user-email" title={userEmail}>{userEmail}</div>}
          <button onClick={onLogout} className="sign-out" type="button" title={collapsed ? 'Sign out' : undefined}>
            <LogOut size={13} strokeWidth={2} aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
