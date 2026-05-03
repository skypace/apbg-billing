import type { ReactNode } from 'react';
import type { View } from '../lib/router';

interface NavItem { id: View; label: string }

const NAV: NavItem[] = [
  { id: 'margin',    label: 'MARGIN'    },
  { id: 'customers', label: 'CUSTOMERS' },
  { id: 'reports',   label: 'REPORTS'   },
  { id: 'plans',     label: 'PLANS'     },
  { id: 'reps',      label: 'REPS'      },
  { id: 'compare',   label: 'COMPARE'   },
  { id: 'inventory', label: 'INVENTORY' },
  { id: 'settings',  label: 'SETTINGS'  },
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
    <>
      <div className="tb">
        <div className="lg">
          PACER · MARGIN ANALYTICS
          <small>Sales · Customers · Items · Margin</small>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {NAV.map((n) => {
            const on = current === n.id;
            return (
              <a
                key={n.id}
                href={'#' + n.id}
                onClick={(e) => { e.preventDefault(); onNav(n.id); }}
                style={{
                  textDecoration: 'none',
                  background: on ? 'var(--ac)' : 'transparent',
                  color: on ? 'var(--bg)' : 'var(--tx)',
                  border: '1px solid ' + (on ? 'var(--ac)' : 'var(--bd)'),
                  padding: '5px 12px',
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: on ? 700 : 500,
                  letterSpacing: 0.5,
                  marginRight: 6,
                }}
              >
                {n.label}
              </a>
            );
          })}
          {userEmail && (
            <span style={{ fontSize: 10, color: 'var(--mt)', marginLeft: 6 }}>
              {userEmail}
            </span>
          )}
          <button
            onClick={onLogout}
            style={{
              background: 'transparent',
              color: 'var(--mt)',
              border: '1px solid var(--bd)',
              padding: '4px 9px',
              borderRadius: 4,
              fontSize: 10,
              cursor: 'pointer',
              letterSpacing: 0.5,
            }}
          >
            SIGN OUT
          </button>
        </div>
      </div>
      <div className="ma">{children}</div>
    </>
  );
}
