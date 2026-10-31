"use client";
// The signed-in app frame (DESIGN.md "App shell"). From 900px: the rail on the left, content on the
// right. Below: a 56px top bar (menu, wordmark, New request) and the rail in a slide-in <Drawer>.
// The layout passes the rail (server-rendered, deals streamed) and the demo bar in as props.
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Icon } from "@/components/ui/Icon";
import "./shell.css";

const WIDE = "(min-width: 900px)";

export function AppShell({ rail, banner, children }: { rail: ReactNode; banner?: ReactNode; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);

  // The drawer is only for narrow screens: close it if the window grows past the breakpoint.
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const onChange = () => mq.matches && setMenuOpen(false);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <aside className="app-rail" aria-label="Haggle">
        {rail}
      </aside>
      <div className="app-col">
        {banner}
        <header className="app-topbar">
          <Button variant="quiet" icon aria-label="Open menu" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
            <Icon name="menu" size={20} />
          </Button>
          <Link className="brand" href="/deals">
            Haggle
          </Link>
          <Link className={buttonClass("primary", { size: "s", className: "app-topbar-new" })} href="/chat">
            <Icon name="plus" />
            New request
          </Link>
        </header>
        <div className="app-main" id="content" tabIndex={-1}>
          {children}
        </div>
      </div>
      <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} label="Menu" className="app-drawer">
        {/* Following a link closes the drawer (the page changes behind it). */}
        <div
          className="app-drawer-rail"
          onClickCapture={(e) => {
            if ((e.target as HTMLElement).closest("a[href]")) setMenuOpen(false);
          }}
        >
          {rail}
        </div>
      </Drawer>
    </div>
  );
}
