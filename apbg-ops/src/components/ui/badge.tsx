import { cn } from "@/lib/utils"

type Variant = "default" | "success" | "warning" | "danger" | "info" | "neutral"
const variants: Record<Variant, string> = {
  default: "bg-zinc-800 text-zinc-200",
  success: "bg-emerald-900/50 text-emerald-300 border border-emerald-800",
  warning: "bg-amber-900/50 text-amber-300 border border-amber-800",
  danger: "bg-red-900/50 text-red-300 border border-red-800",
  info: "bg-blue-900/50 text-blue-300 border border-blue-800",
  neutral: "bg-zinc-800 text-zinc-400",
}
interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> { variant?: Variant }
export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium", variants[variant], className)} {...props} />
}
