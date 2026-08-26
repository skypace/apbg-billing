import { LIFECYCLE_TABS, type LifecycleTab } from '@/lib/lifecycle';

// The shared Open / Posted / Paid & closed pill row — identical on every
// expense list so the tabs mean the same thing everywhere.
export function LifecycleTabs({
  tab,
  counts,
  onChange,
}: {
  tab: LifecycleTab;
  counts: Record<LifecycleTab, number>;
  onChange: (t: LifecycleTab) => void;
}) {
  return (
    <div className="flex gap-2">
      {LIFECYCLE_TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={`px-3 py-1.5 rounded-full text-sm font-medium transition border ${
            tab === t.key
              ? 'bg-primary text-primary-foreground border-primary'
              : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30'
          }`}
        >
          {t.label}
          <span className={`ml-1.5 tabular-nums ${tab === t.key ? 'opacity-80' : 'opacity-60'}`}>
            {counts[t.key]}
          </span>
        </button>
      ))}
    </div>
  );
}
