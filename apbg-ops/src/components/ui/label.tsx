import { cn } from "@/lib/utils"
export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("block text-xs font-medium text-zinc-400 mb-1.5", className)} {...props} />
}
