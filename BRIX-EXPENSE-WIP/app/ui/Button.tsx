import { forwardRef, ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brix-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 touch-manipulation',
  {
    variants: {
      variant: {
        primary:   'bg-brix-500 text-white hover:bg-brix-600 active:bg-brix-700',
        cta:       'bg-amber text-brix-ink hover:bg-amber-dark hover:text-white',
        success:   'bg-emerald-600 text-white hover:bg-emerald-700',
        danger:    'bg-red-600 text-white hover:bg-red-700',
        ghost:     'bg-white text-slate-700 border border-slate-300 hover:bg-slate-100',
        secondary: 'bg-slate-100 text-slate-900 hover:bg-slate-200',
        link:      'text-brix-500 underline-offset-4 hover:underline',
      },
      size: {
        md: 'h-11 px-5 min-w-[44px]',
        lg: 'h-12 px-6 text-base min-w-[44px]',
        sm: 'h-9 px-4 text-xs min-w-[44px]',
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';
