import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Receipt, ClipboardList, Clock, Users, LogOut } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

const navItems = [
  { path: '', icon: Receipt, label: 'Home' },
  { path: 'pending', icon: Clock, label: 'My Pending' },
  { path: 'queue', icon: Users, label: 'Approvals' },
];

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();

  const currentPath = location.pathname.replace(/^\/expense\/?/, '');

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate('/');
  }

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-primary text-primary-foreground shadow-md">
        <div className="flex items-center justify-between px-4 h-14 max-w-lg mx-auto">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5" />
            <span className="font-semibold text-base tracking-tight">
              Brix Expense
            </span>
          </div>
          <button
            onClick={handleLogout}
            className="p-2 rounded-md hover:bg-white/10 transition-colors"
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 w-full max-w-lg mx-auto px-4 py-4">
        <Outlet />
      </main>

      {/* Bottom nav — mobile */}
      <nav className="sticky bottom-0 bg-white border-t border-border shadow-[0_-2px_10px_rgba(0,0,0,0.05)]">
        <div className="flex justify-around max-w-lg mx-auto">
          {navItems.map((item) => {
            const isActive =
              item.path === ''
                ? currentPath === '' || currentPath === '/'
                : currentPath.startsWith(item.path);
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path === '' ? '' : item.path)}
                className={cn(
                  'flex flex-col items-center gap-1 py-2 px-4 text-xs font-medium transition-colors',
                  isActive
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <item.icon className={cn('h-5 w-5', isActive && 'stroke-[2.5]')} />
                {item.label}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
