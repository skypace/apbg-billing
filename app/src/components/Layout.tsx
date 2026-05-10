import type { ReactNode } from 'react';
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
  type LucideIcon,
} from 'lucide-react';

interface NavItem { id: View; label: string; icon: LucideIcon }

// Fleet moved to apbg-ops.netlify.app — removed from Margin Minder nav.
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

export function Layout({ current, onNav, userEmail, onLogout, children }: LayoutProps) {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <div className="brand-mark">APBG</div>
          <div className="brand-sub">
            <span className="status-dot" aria-hidden="true" />
            Margin Minder
          </div>
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
              >
                <Icon size={16} strokeWidth={2} aria-hidden="true" />
                <span>{n.label}</span>
              </a>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          {userEmail && <div className="user-email" title={userEmail}>{userEmail}</div>}
          <button onClick={onLogout} className="sign-out" type="button">
            <LogOut size={13} strokeWidth={2} aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
