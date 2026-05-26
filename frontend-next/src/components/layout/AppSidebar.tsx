"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  Sidebar,
  SidebarBody,
  SidebarLink,
} from "@/components/aceternity/sidebar";
import { useTheme } from "@/context/ThemeContext";
import { useAuth } from "@/context/AuthContext";
import {
  Home,
  LayoutDashboard,
  Gamepad2,
  Info,
  BookOpen,
  Mic,
  PenTool,
  FileText,
  BarChart3,
  ClipboardCheck,
  Camera,
  Moon,
  Sun,
  LogOut,
  LogIn,
} from "lucide-react";

const mainLinks = [
  { label: "Home", href: "/", icon: <Home size={20} /> },
  { label: "Dashboard", href: "/dashboard", icon: <LayoutDashboard size={20} /> },
];

const featureLinks = [
  { label: "Reading", href: "/reading", icon: <BookOpen size={20} /> },
  { label: "Lecture", href: "/lecture", icon: <Mic size={20} /> },
  { label: "Handwriting", href: "/handwriting", icon: <PenTool size={20} /> },
  { label: "Generator", href: "/generator", icon: <FileText size={20} /> },
  { label: "Progress Analytics", href: "/analytics", icon: <BarChart3 size={20} /> },
  { label: "Games", href: "/games", icon: <Gamepad2 size={20} /> },
  { label: "OPENCV", href: "/opencv", icon: <Camera size={20} /> },
  { label: "Screening Assessment", href: "/onboarding", icon: <ClipboardCheck size={20} /> },
];

const bottomLinks = [
  { label: "About", href: "/#features", icon: <Info size={20} /> },
];

export default function AppSidebar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { isDark, toggleTheme } = useTheme();
  const { currentUser, logout } = useAuth();

  return (
    <Sidebar open={open} setOpen={setOpen} animate={true}>
      <SidebarBody className="justify-between gap-10">
        <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 py-1 mb-4">
            <div className="h-7 w-7 shrink-0 rounded-lg bg-gradient-to-br from-violet-600 to-amber-500 flex items-center justify-center">
              <span className="text-white text-xs font-bold">S</span>
            </div>
            <motion.span
              animate={{
                display: open ? "inline-block" : "none",
                opacity: open ? 1 : 0,
              }}
              transition={{ duration: 0.2 }}
              className="font-black text-lg whitespace-pre gradient-text"
            >
              NeuroLex
            </motion.span>
          </Link>

          {/* Main links */}
          <div className="flex flex-col gap-0.5">
            {mainLinks.map((link) => (
              <SidebarLink
                key={link.href}
                link={link}
                active={pathname === link.href}
              />
            ))}
          </div>

          {/* Features section */}
          <motion.div
            animate={{
              display: open ? "block" : "none",
              opacity: open ? 1 : 0,
            }}
            transition={{ duration: 0.2 }}
            className="mt-4 mb-1"
          >
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold px-2">
              Tools
            </span>
          </motion.div>
          <div className="flex flex-col gap-0.5">
            {featureLinks.map((link) => (
              <SidebarLink
                key={link.href}
                link={link}
                active={pathname === link.href || pathname.startsWith(link.href + "/")}
              />
            ))}
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Bottom links */}
          <div className="flex flex-col gap-0.5 mt-4 border-t border-border pt-4">
            {bottomLinks.map((link) => (
              <SidebarLink
                key={link.href}
                link={link}
                active={pathname === link.href}
              />
            ))}

            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              className="flex items-center justify-start gap-2 group/sidebar py-2 px-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-200"
            >
              <span className="shrink-0">
                {isDark ? <Sun size={20} /> : <Moon size={20} />}
              </span>
              <motion.span
                animate={{
                  display: open ? "inline-block" : "none",
                  opacity: open ? 1 : 0,
                }}
                transition={{ duration: 0.2 }}
                className="text-sm font-semibold whitespace-pre"
              >
                {isDark ? "Light Mode" : "Dark Mode"}
              </motion.span>
            </button>

            {/* Auth */}
            {currentUser ? (
              <button
                onClick={logout}
                className="flex items-center justify-start gap-2 group/sidebar py-2 px-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors duration-200"
              >
                <span className="shrink-0"><LogOut size={20} /></span>
                <motion.span
                  animate={{
                    display: open ? "inline-block" : "none",
                    opacity: open ? 1 : 0,
                  }}
                  transition={{ duration: 0.2 }}
                  className="text-sm font-semibold whitespace-pre"
                >
                  Sign Out
                </motion.span>
              </button>
            ) : (
              <SidebarLink
                link={{ label: "Sign In", href: "/login", icon: <LogIn size={20} /> }}
                active={pathname === "/login"}
              />
            )}

            {/* User avatar */}
            {currentUser && (
              <div className="flex items-center gap-2 py-2 px-2 mt-2">
                <div className="h-7 w-7 shrink-0 rounded-full bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center text-white text-xs font-bold">
                  {currentUser.email?.[0]?.toUpperCase() || "U"}
                </div>
                <motion.span
                  animate={{
                    display: open ? "inline-block" : "none",
                    opacity: open ? 1 : 0,
                  }}
                  transition={{ duration: 0.2 }}
                  className="text-sm text-foreground truncate whitespace-pre"
                >
                  {currentUser.displayName || currentUser.email?.split("@")[0]}
                </motion.span>
              </div>
            )}
          </div>
        </div>
      </SidebarBody>
    </Sidebar>
  );
}
