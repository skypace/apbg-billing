import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(value: number | null | undefined, decimals = 0): string {
  if (value == null) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  }).format(value)
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null) return "—"
  return new Intl.NumberFormat("en-US").format(value)
}

export function formatPct(value: number | null | undefined): string {
  if (value == null) return "—"
  return `${(value * 100).toFixed(1)}%`
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—"
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function monthLabel(isoDate: string): string {
  return new Date(isoDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", year: "2-digit" })
}

export function daysSince(isoDate: string): number {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86_400_000)
}
