import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface KpiCardProps {
  title: string
  value: string
  sub?: string
  trend?: "up" | "down" | "neutral"
  trendLabel?: string
  className?: string
  accent?: boolean
}

export function KpiCard({ title, value, sub, trend, trendLabel, className, accent }: KpiCardProps) {
  const trendColor =
    trend === "up" ? "text-emerald-400" : trend === "down" ? "text-red-400" : "text-zinc-500"

  return (
    <Card className={cn(accent && "border-blue-800 bg-blue-950/30", className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {trend && trendLabel && (
          <span className={cn("text-xs font-medium", trendColor)}>{trendLabel}</span>
        )}
      </CardHeader>
      <CardContent>
        <p className={cn("text-2xl font-bold text-zinc-100", accent && "text-blue-300")}>{value}</p>
        {sub && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}
      </CardContent>
    </Card>
  )
}
