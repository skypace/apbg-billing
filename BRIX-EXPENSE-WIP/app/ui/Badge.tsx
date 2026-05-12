import { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
  {
    variants: {
      tone: {
        neutral: 'bg-slate-100 text-slate-600 border border-slate-200',
        info:    'bg-brix-50 text-brix-700 border border-brix-200',
        warn:    'bg-amber-tint text-amber-dark border border-amber',
        success: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
        danger:  'bg-red-50 text-red-700 border border-red-200',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
