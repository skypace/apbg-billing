import type { Metadata } from "next"
import { Geist } from "next/font/google"
import "./globals.css"
import { Sidebar } from "@/components/sidebar"
import { Providers } from "@/components/providers"

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" })

export const metadata: Metadata = {
  title: "PACER Ops Dashboard",
  description: "Operational KPIs — Brix Beverage + FreeFlow Beverage Solutions",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} h-full`}>
      <body className="flex h-full bg-zinc-950 text-zinc-100 antialiased">
        <Providers>
          <Sidebar />
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-7xl p-6">{children}</div>
          </main>
        </Providers>
      </body>
    </html>
  )
}
