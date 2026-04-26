import { cn } from "@/lib/utils"

type Variant = "primary" | "secondary" | "ghost" | "danger"
type Size = "sm" | "md" | "lg"
const variantStyles: Record<Variant, string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-500",
  secondary: "bg-zinc-800 text-zinc-200 hover:bg-zinc-700 border border-zinc-700",
  ghost: "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800",
  danger: "bg-red-900/50 text-red-300 hover:bg-red-900 border border-red-800",
}
const sizeStyles: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-5 py-2.5 text-base",
}
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; size?: Size }
export function Button({ className, variant = "primary", size = "md", ...props }: ButtonProps) {
  return <button className={cn("inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed", variantStyles[variant], sizeStyles[size], className)} {...props} />
}
