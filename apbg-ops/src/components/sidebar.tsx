"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { LayoutDashboard, Truck, Wrench, RefreshCw, TrendingUp, Users, Activity } from "lucide-react"

const nav = [
  { href: "/executive", label: "Executive", icon: LayoutDashboard },
  { href: "/delivery", label: "Delivery", icon: Truck },
  { href: "/service", label: "Service", icon: Wrench },
  { href: "/reman", label: "Reman", icon: RefreshCw },
  { href: "/sales-ar", label: "Sales & AR", icon: TrendingUp },
  { href: "/roster", label: "Roster", icon: Users },
]

export function Sidebar() {
  const pathname = usePathname()
  return (
    <aside className="flex h-screen w-56 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="flex items-center gap-3 px-5 py-5 border-b border-zinc-800">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600">
          <Activity size={16} className="text-white" />
        </div>
        <div>
          <p className="text-sm font-bold text-zinc-100 leading-none">PACER Ops</p>
          <p className="text-[10px] text-zinc-500 mt-0.5">APBG Dashboard</p>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 p-3">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/")
          return (
            <Link key={href} href={href} className={cn("flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors", active ? "bg-blue-600/20 text-blue-300" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100")}>
              <Icon size={16} className={active ? "text-blue-400" : "text-zinc-500"} />
              {label}
            </Link>
          )
        })}
      </nav>
      <div className="border-t border-zinc-800 p-4">
        <p className="text-[10px] text-zinc-600 leading-relaxed">Brix Beverage + FreeFlow<br />Supabase · QBO · Service Fusion</p>
      </div>
    </aside>
  )
}
