import { cn } from "@/lib/utils"
export function Table({ className, ...props }: React.HTMLAttributes<HTMLTableElement>) {
  return <div className="w-full overflow-x-auto"><table className={cn("w-full text-sm", className)} {...props} /></div>
}
export function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("", className)} {...props} />
}
export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-zinc-800", className)} {...props} />
}
export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("hover:bg-zinc-800/50 transition-colors", className)} {...props} />
}
export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn("px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800", className)} {...props} />
}
export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-3 text-zinc-300", className)} {...props} />
}
