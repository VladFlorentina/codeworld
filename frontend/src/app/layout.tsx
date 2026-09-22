import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";
import Navbar from "@/components/nav/Navbar";

export const metadata: Metadata = {
  title: "CodeWorld — 3D Repository Visualizer",
  description: "Interactive 3D software cities generated from GitHub repositories.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased bg-[#0a0a0c] text-white min-h-screen flex flex-col">
        <AuthProvider>
          <Navbar />
          <div className="flex-1 flex flex-col relative">
            {children}
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
