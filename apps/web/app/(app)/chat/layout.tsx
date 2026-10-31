// /chat and /chat/<id> share this layout: it holds the live conversation (components/chat/session.tsx),
// so a turn keeps streaming when the page under it changes (a new thread getting its URL, or the rail
// refreshing after a deal starts).
import type { ReactNode } from "react";
import { ChatSessionProvider } from "@/components/chat/session";
import "./chat.css";

export default function ChatLayout({ children }: { children: ReactNode }) {
  return <ChatSessionProvider>{children}</ChatSessionProvider>;
}
